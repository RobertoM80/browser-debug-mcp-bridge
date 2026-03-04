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
  | { ok: true; state?: SessionState; result?: unknown }
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

    await targetPage.evaluate(() => {
      document.body.innerHTML = '<button id="login-btn">Login</button>';
      console.info('[auth] logged in success');
      console.error('[auth] error while login');
    });
    await targetPage.click('#login-btn');

    await targetPage.evaluate(async () => {
      try {
        await fetch('http://127.0.0.1:9/e2e-network-failure', { method: 'GET' });
      } catch {
        // expected
      }
    });

    const otherPage = await extension.context.newPage();
    await otherPage.goto('http://127.0.0.1:8065/?e2e-other=1');
    await otherPage.evaluate(() => {
      console.warn('[cross-tab] should be dropped');
    });

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
