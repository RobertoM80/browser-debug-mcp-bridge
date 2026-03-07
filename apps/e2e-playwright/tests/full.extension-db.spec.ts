import { expect, test, type Page } from '@playwright/test';
import {
  createTempDataDir,
  launchExtensionContext,
  openExtensionPage,
  sendRuntimeMessage,
  startHttpServer,
  type ExtensionContextHandle,
  type ManagedServerProcess,
} from './utils/runtime';

type SessionState = {
  isActive: boolean;
  sessionId: string | null;
};

type TabScope = {
  isActive: boolean;
  sessionId: string | null;
  allowedTabIds: number[];
  tabs: Array<{ tabId: number; bound: boolean }>;
};

type DbEntriesResult = {
  rows: Array<{
    source: 'event' | 'network';
    kind: string;
    summary: string;
    raw: Record<string, unknown>;
  }>;
  hasMore: boolean;
  nextOffset: number | null;
};

type DiagnosticsResult = {
  rejectedTabScope?: number;
};

type RuntimeResponse =
  | { ok: true; state?: SessionState; result?: unknown; accepted?: boolean }
  | { ok: false; error: string };

async function waitForEntries(
  popupPage: Page,
  sessionId: string,
  matcher: (rows: DbEntriesResult['rows']) => boolean,
): Promise<DbEntriesResult['rows']> {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    const response = await sendRuntimeMessage<RuntimeResponse>(popupPage, {
      type: 'SESSION_GET_DB_ENTRIES',
      sessionId,
      limit: 200,
      offset: 0,
    });

    if (response.ok && response.result && typeof response.result === 'object') {
      const parsed = response.result as DbEntriesResult;
      if (Array.isArray(parsed.rows) && matcher(parsed.rows)) {
        return parsed.rows;
      }
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
  }

  throw new Error('Timed out waiting for expected DB entries');
}

async function bindTargetTab(popupPage: Page, matcher: string): Promise<void> {
  await popupPage.click('#refresh-session-tabs');

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const matched = await popupPage.evaluate((expected) => {
      const items = Array.from(document.querySelectorAll<HTMLLabelElement>('.session-tab-item'));
      const item = items.find((candidate) => (candidate.textContent ?? '').includes(expected));
      const checkbox = item?.querySelector<HTMLInputElement>('input.session-tab-checkbox');
      if (!checkbox) {
        return false;
      }
      if (!checkbox.checked) {
        checkbox.click();
      }
      return true;
    }, matcher);

    if (matched) {
      return;
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    await popupPage.click('#refresh-session-tabs');
  }

  throw new Error(`Timed out binding target tab matching ${matcher}`);
}

async function queueEventFromTab(
  popupPage: Page,
  urlFragment: string,
  eventType: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  return await popupPage.evaluate(
    async ({ expectedUrlFragment, expectedEventType, expectedData }) => {
      const chromeApi = (globalThis as { chrome?: any }).chrome;
      const tabs = await chromeApi.tabs.query({});
      const target = tabs.find((tab: { id?: number; url?: string }) => typeof tab.id === 'number' && (tab.url ?? '').includes(expectedUrlFragment));
      if (!target?.id) {
        throw new Error(`Unable to find tab containing ${expectedUrlFragment}`);
      }

      const results = await chromeApi.scripting.executeScript({
        target: { tabId: target.id },
        func: async (messageEventType: string, messageData: Record<string, unknown>) => {
          const runtime = (globalThis as { chrome?: any }).chrome?.runtime;
          return await new Promise<boolean>((resolve) => {
            runtime.sendMessage(
              {
                type: 'SESSION_QUEUE_EVENT',
                eventType: messageEventType,
                data: messageData,
              },
              (response: { accepted?: boolean } | undefined) => {
                resolve(response?.accepted === true);
              },
            );
          });
        },
        args: [expectedEventType, expectedData],
      });

      return results[0]?.result === true;
    },
    {
      expectedUrlFragment: urlFragment,
      expectedEventType: eventType,
      expectedData: data,
    },
  );
}

test.describe('@full extension to db integration', () => {
  let server: ManagedServerProcess | undefined;
  let extension: ExtensionContextHandle | undefined;
  let popupPage: Page | undefined;
  let targetPage: Page | undefined;

  test.beforeAll(async () => {
    server = await startHttpServer(createTempDataDir('bdmcp-e2e-full-ext-data-'));
    extension = await launchExtensionContext();
    targetPage = await extension.context.newPage();
    await targetPage.goto('http://127.0.0.1:8065/?e2e-target=1');
    popupPage = await openExtensionPage(extension.context, extension.extensionId, 'popup.html');
  });

  test.afterAll(async () => {
    try {
      if (extension) {
        await extension.close();
      }
    } finally {
      if (server) {
        await server.stop();
      }
    }
  });

  test('captures bound-tab events, persists to DB, and drops unbound-tab events', async () => {
    if (!popupPage || !targetPage || !extension) {
      throw new Error('Test setup did not complete');
    }

    await popupPage.fill('#allowlist-domains', '127.0.0.1');
    await popupPage.uncheck('#safe-mode');
    await popupPage.click('#save-config');
    await expect(popupPage.locator('#config-status')).toContainText(/Settings saved/i);

    await targetPage.bringToFront();
    await popupPage.click('#start-session');
    await expect(popupPage.locator('#status')).toContainText(/Session active/i);
    await expect(popupPage.locator('#status')).toContainText(/connected/i);
    await bindTargetTab(popupPage, '?e2e-target=1');

    const stateResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_GET_STATE' });
    expect(stateResponse.ok).toBe(true);
    const sessionId = stateResponse.ok ? stateResponse.state?.sessionId ?? null : null;
    expect(sessionId).toBeTruthy();
    if (!sessionId) {
      throw new Error('Session ID was not created');
    }

    const scopeResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_GET_TAB_SCOPE' });
    expect(scopeResponse.ok).toBe(true);
    if (scopeResponse.ok && scopeResponse.result) {
      const scope = scopeResponse.result as TabScope;
      expect(scope.isActive).toBe(true);
      expect(scope.allowedTabIds.length).toBe(1);
      expect(scope.tabs.some((tab) => tab.bound)).toBe(true);
    }

    const boundEventAccepted = await queueEventFromTab(popupPage, '?e2e-target=1', 'custom', {
      marker: 'auth_log',
      message: '[auth] logged in success',
    });
    expect(boundEventAccepted).toBe(true);

    const boundNetworkAccepted = await queueEventFromTab(popupPage, '?e2e-target=1', 'network', {
      url: 'http://127.0.0.1:8065/e2e-network-failure',
      method: 'GET',
      status: 503,
      initiator: 'fetch',
      errorType: 'http_error',
      responseSize: 0,
      timestamp: Date.now(),
    });
    expect(boundNetworkAccepted).toBe(true);

    const otherPage = await extension.context.newPage();
    await otherPage.goto('http://127.0.0.1:8065/?e2e-other=1');
    const droppedEventAccepted = await queueEventFromTab(popupPage, '?e2e-other=1', 'custom', {
      marker: 'cross_tab',
      message: '[cross-tab] should be dropped',
    });
    expect(droppedEventAccepted).toBe(false);

    const rows = await waitForEntries(popupPage, sessionId, (entries) => {
      const hasAuthLog = entries.some((row) => row.source === 'event' && row.summary.includes('[auth]'));
      const hasNetwork = entries.some((row) => row.source === 'network');
      return hasAuthLog && hasNetwork;
    });

    const combinedSummary = rows.map((row) => row.summary).join('\n');
    expect(combinedSummary).toContain('[auth]');
    expect(combinedSummary).not.toContain('[cross-tab] should be dropped');

    const diagnostics = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_CAPTURE_DIAGNOSTICS' });
    expect(diagnostics.ok).toBe(true);
    if (diagnostics.ok && diagnostics.result) {
      const result = diagnostics.result as DiagnosticsResult;
      expect(result.rejectedTabScope ?? 0).toBeGreaterThan(0);
    }

    const dbViewer = await extension.context.newPage();
    await dbViewer.goto(`chrome-extension://${extension.extensionId}/db-viewer.html?sessionId=${encodeURIComponent(sessionId)}`);
    await expect(dbViewer.locator('#entries-status')).toContainText(/Showing|No DB entries yet/i);
    await expect(dbViewer.locator('#entries-body tr').first()).toBeVisible();

    await popupPage.click('#stop-session');
    await expect(popupPage.locator('#status')).toContainText(/No active session/i);

    await otherPage.close();
    await dbViewer.close();
  });
});
