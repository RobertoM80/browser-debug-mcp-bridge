import { expect, test, type Page } from '@playwright/test';
import { callToolJson, connectMcpClient, type MCPClientHandle } from './utils/mcp-client';
import {
  assertExtensionInstalled,
  createTempDataDir,
  getFreePort,
  launchExtensionContext,
  openExtensionPage,
  sendRuntimeMessage,
  type ExtensionContextHandle,
} from './utils/runtime';

type RuntimeResponse =
  | { ok: true; state?: SessionState; result?: unknown; config?: unknown }
  | { ok: false; error: string };

type SessionState = {
  isActive: boolean;
  isPaused?: boolean;
  sessionId: string | null;
};

type TabScope = {
  allowedTabIds: number[];
  tabs?: Array<{
    tabId: number;
    url: string;
    bound: boolean;
  }>;
};

type McpSessionList = {
  sessions: Array<{
    sessionId: string;
    liveConnection?: {
      connected?: boolean;
    };
  }>;
};

type LiveSessionHealth = {
  liveConnection?: {
    connected?: boolean;
  };
};

type LiveActionResponse = {
  status: 'succeeded' | 'rejected' | 'failed';
  action: string;
  traceId: string;
  failureDetails?: {
    code?: string;
    message?: string;
  };
  actionResult?: {
    result?: Record<string, unknown>;
  };
  postActionState?: {
    matched?: boolean;
  };
  target?: {
    frameId?: number;
  };
  supportedScopes?: {
    topDocumentOnly?: boolean;
    opensNewBrowserSession?: boolean;
  };
  targetResolution?: Record<string, unknown>;
};

type WorkflowResponse = {
  status: 'succeeded' | 'failed';
  requestedStepCount: number;
  completedStepCount: number;
  failedStepId?: string;
  steps: Array<{
    id: string;
    status: 'succeeded' | 'failed' | 'skipped';
    action?: string;
  }>;
};

type AutomationRunsResponse = {
  runs: Array<{
    traceId?: string;
    action?: string;
    status?: string;
  }>;
};

async function configureAutomation(popupPage: Page): Promise<void> {
  await popupPage.fill('#allowlist-domains', '127.0.0.1');
  await popupPage.check('#automation-enabled');
  await popupPage.uncheck('#automation-sensitive-fields');
  await popupPage.click('#save-config');
  await expect(popupPage.locator('#config-status')).toContainText(/Settings saved/i);
  await expect(popupPage.locator('#automation-status')).toContainText(/Live automation armed/i);
}

async function getSessionState(popupPage: Page): Promise<SessionState> {
  const stateResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_GET_STATE' });
  expect(stateResponse.ok).toBe(true);
  if (!stateResponse.ok || !stateResponse.state) {
    throw new Error('Session state was not available');
  }

  return stateResponse.state;
}

async function getSessionTabScope(popupPage: Page): Promise<TabScope> {
  const scopeResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_GET_TAB_SCOPE' });
  expect(scopeResponse.ok).toBe(true);
  if (!scopeResponse.ok || !scopeResponse.result) {
    throw new Error('Tab scope was not available');
  }

  return scopeResponse.result as TabScope;
}

async function startSessionFromTargetTab(popupPage: Page, targetPage: Page): Promise<{ sessionId: string; tabId: number }> {
  await targetPage.bringToFront();
  const startResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_START' });
  expect(startResponse.ok).toBe(true);
  if (!startResponse.ok) {
    throw new Error(startResponse.error);
  }

  await expect(popupPage.locator('#status')).toContainText(/Session active/i);

  const state = await getSessionState(popupPage);
  if (!state.sessionId) {
    throw new Error('Session id was not created');
  }

  const scope = await getSessionTabScope(popupPage);
  const [tabId] = scope.allowedTabIds;
  if (typeof tabId !== 'number') {
    throw new Error('No bound tab was returned for the active session');
  }

  return { sessionId: state.sessionId, tabId };
}

async function expectMcpSeesLiveSession(mcp: MCPClientHandle, sessionId: string): Promise<void> {
  await expect.poll(async () => {
    const sessions = await callToolJson<McpSessionList>(mcp.client, 'list_sessions', { limit: 25 });
    return sessions.sessions.find((session) => session.sessionId === sessionId)?.liveConnection?.connected === true;
  }, { timeout: 10_000 }).toBe(true);

  const health = await callToolJson<LiveSessionHealth>(mcp.client, 'get_live_session_health', { sessionId });
  expect(health.liveConnection?.connected).toBe(true);
}

async function installAutomationFixture(page: Page): Promise<void> {
  await page.setContent(`
    <!doctype html>
    <html lang="en">
      <head>
        <title>Live automation fixture</title>
        <style>
          body { font-family: sans-serif; margin: 32px; }
          button, input { display: block; margin: 12px 0; }
          #dialog { border: 1px solid #555; padding: 12px; width: 240px; }
          #frame-wrap { margin-top: 16px; }
          #scroll-box { border: 1px solid #555; height: 80px; overflow: auto; width: 240px; }
          #scroll-content { height: 240px; }
          #shadow-host { display: block; margin-top: 12px; }
          #covered-wrapper { display: inline-block; position: relative; }
          #covered-action { margin: 0; }
          #cover-layer {
            position: absolute;
            inset: 0;
            background: rgba(200, 0, 0, 0.2);
            z-index: 10;
          }
          #hidden-action { display: none; }
          #no-pointer-action { pointer-events: none; }
        </style>
      </head>
      <body>
        <main>
          <h1>Live automation fixture</h1>
          <button id="increment" data-testid="increment">Increment</button>
          <button id="disabled-action" disabled>Disabled action</button>
          <button id="hidden-action">Hidden action</button>
          <button id="no-pointer-action">No pointer action</button>
          <div id="covered-wrapper">
            <button id="covered-action">Covered action</button>
            <div id="cover-layer" aria-hidden="true"></div>
          </div>
          <output id="count" aria-live="polite">0</output>
          <label for="displayName">Display name</label>
          <input id="displayName" />
          <label for="readonly-input">Readonly input</label>
          <input id="readonly-input" readonly value="Locked" />
          <output id="name-output" aria-live="polite"></output>
          <form id="native-form">
            <button id="submit-form" type="submit">Submit form</button>
          </form>
          <output id="submit-output"></output>
          <div id="scroll-box">
            <div id="scroll-content">Scrollable content</div>
          </div>
          <output id="scroll-output"></output>
          <button id="open-dialog" data-testid="open-dialog">Open dialog</button>
          <a id="docs-primary" href="#docs-primary" aria-label="Docs">Docs</a>
          <a id="docs-secondary" href="#docs-secondary" aria-label="Docs">Docs</a>
          <output id="hover-output"></output>
          <div id="shadow-host"></div>
          <output id="shadow-output"></output>
          <section id="dialog" role="dialog" aria-modal="true" hidden>
            <h2>Automation dialog</h2>
            <button id="confirm-dialog" data-testid="confirm-dialog">Confirm dialog</button>
          </section>
          <div id="dialog-result"></div>
          <iframe id="child-frame" srcdoc="
            <!doctype html>
            <html>
              <body>
                <button id='inside-frame' data-testid='inside-frame'>Inside frame</button>
                <output id='frame-count'>0</output>
                <input id='frame-input' data-testid='frame-input' />
                <output id='frame-input-output'></output>
                <script>
                  document.querySelector('#inside-frame').addEventListener('click', () => {
                    const count = document.querySelector('#frame-count');
                    count.textContent = String(Number(count.textContent || '0') + 1);
                  });
                  document.querySelector('#frame-input').addEventListener('input', (event) => {
                    document.querySelector('#frame-input-output').textContent = event.target.value;
                  });
                </script>
              </body>
            </html>
          "></iframe>
          <iframe id="outer-frame"></iframe>
        </main>
        <script>
          document.querySelector('#increment').addEventListener('click', () => {
            const count = document.querySelector('#count');
            count.textContent = String(Number(count.textContent || '0') + 1);
          });
          document.querySelector('#displayName').addEventListener('input', (event) => {
            document.querySelector('#name-output').textContent = event.target.value;
          });
          document.querySelector('#open-dialog').addEventListener('click', () => {
            document.querySelector('#dialog').hidden = false;
          });
          document.querySelector('#docs-secondary').addEventListener('mouseenter', () => {
            document.querySelector('#hover-output').textContent = 'hovered docs';
          });
          document.querySelector('#confirm-dialog').addEventListener('click', () => {
            document.querySelector('#dialog-result').textContent = 'confirmed';
          });
          document.querySelector('#native-form').addEventListener('submit', (event) => {
            event.preventDefault();
            document.querySelector('#submit-output').textContent = 'submitted';
          });
          document.querySelector('#scroll-box').addEventListener('scroll', (event) => {
            document.querySelector('#scroll-output').textContent = String(event.target.scrollTop);
          });
          const shadowRoot = document.querySelector('#shadow-host').attachShadow({ mode: 'open' });
          shadowRoot.innerHTML = '<button id="shadow-action" aria-label="Shadow action">Run shadow</button>';
          shadowRoot.querySelector('#shadow-action').addEventListener('click', () => {
            document.querySelector('#shadow-output').textContent = 'shadow clicked';
          });
          document.querySelector('#outer-frame').srcdoc = [
            '<!doctype html>',
            '<html>',
            '<body>',
            '<iframe id="inner-frame" srcdoc="',
            '&lt;!doctype html&gt;',
            '&lt;html&gt;',
            '&lt;body&gt;',
            '&lt;button id=\\'nested-frame-action\\' data-testid=\\'nested-frame-action\\'&gt;Nested frame action&lt;/button&gt;',
            '&lt;output id=\\'nested-count\\'&gt;0&lt;/output&gt;',
            '&lt;script&gt;',
            'document.querySelector(\\'#nested-frame-action\\').addEventListener(\\'click\\', () =&gt; {',
            'const count = document.querySelector(\\'#nested-count\\');',
            'count.textContent = String(Number(count.textContent || \\'0\\') + 1);',
            '});',
            '&lt;/script&gt;',
            '&lt;/body&gt;',
            '&lt;/html&gt;',
            '"></iframe>',
            '</body>',
            '</html>',
          ].join('');
        </script>
      </body>
    </html>
  `, { waitUntil: 'domcontentloaded' });
}

test.describe('@full live automation through MCP and extension session', () => {
  let mcp: MCPClientHandle | undefined;
  let extension: ExtensionContextHandle | undefined;

  test.afterEach(async () => {
    try {
      if (extension) {
        await extension.close();
      }
    } finally {
      extension = undefined;
      if (mcp) {
        await mcp.close();
        mcp = undefined;
      }
    }
  });

  test('executes native top-document and same-origin iframe actions through the bound browser tab', async () => {
    const port = await getFreePort();
    mcp = await connectMcpClient(createTempDataDir('bdmcp-e2e-live-automation-'), { port });

    extension = await launchExtensionContext();
    await assertExtensionInstalled(extension.context, extension.extensionId);
    await extension.setServerBaseUrl(`http://127.0.0.1:${port}`);

    const targetPage = await extension.context.newPage();
    await targetPage.goto(`http://127.0.0.1:${port}/automation-fixture`, { waitUntil: 'domcontentloaded' });
    await installAutomationFixture(targetPage);

    const popupPage = await openExtensionPage(extension.context, extension.extensionId, 'popup.html');
    await configureAutomation(popupPage);
    const { sessionId, tabId } = await startSessionFromTargetTab(popupPage, targetPage);
    await expectMcpSeesLiveSession(mcp, sessionId);

    let refs: { refs: Array<Record<string, unknown>>; pageSummary?: { frames?: number } } | undefined;
    await expect.poll(async () => {
      refs = await callToolJson<{ refs: Array<Record<string, unknown>>; pageSummary?: { frames?: number } }>(
        mcp.client,
        'get_interactive_elements',
        {
          sessionId,
          kinds: ['buttons', 'links', 'inputs'],
          maxItems: 40,
        },
      );
      const hasFrameButtonRef = refs.refs.some((ref) => ref.selector === '#inside-frame' && typeof ref.frameId === 'number');
      const hasFrameInputRef = refs.refs.some((ref) => ref.selector === '#frame-input' && typeof ref.frameId === 'number');
      const hasDocsLink = refs.refs.some((ref) => ref.selector === '#docs-secondary' && ref.kind === 'links');
      const hasShadowButtonRef = refs.refs.some((ref) => ref.selector === '#shadow-host >> #shadow-action' && ref.kind === 'buttons');
      const hasNestedFrameButtonRef = refs.refs.some((ref) => ref.selector === '#nested-frame-action' && typeof ref.frameId === 'number');
      return hasFrameButtonRef && hasFrameInputRef && hasDocsLink && hasShadowButtonRef && hasNestedFrameButtonRef;
    }, { timeout: 10_000 }).toBe(true);
    if (!refs) {
      throw new Error('expected interactive element refs');
    }
    expect(refs.refs.some((ref) => ref.selector === '#increment')).toBe(true);
    expect(refs.refs.some((ref) => ref.selector === '#docs-primary' && ref.role === 'link')).toBe(true);
    expect(refs.refs.some((ref) => ref.selector === '#displayName')).toBe(true);
    expect(refs.pageSummary?.frames).toBeGreaterThanOrEqual(2);
    const frameButtonRef = refs.refs.find((ref) => ref.selector === '#inside-frame' && typeof ref.frameId === 'number');
    const frameInputRef = refs.refs.find((ref) => ref.selector === '#frame-input' && typeof ref.frameId === 'number');
    const nestedFrameButtonRef = refs.refs.find((ref) => ref.selector === '#nested-frame-action' && typeof ref.frameId === 'number');
    expect(frameButtonRef?.elementRef).toEqual(expect.any(String));
    expect(frameInputRef?.elementRef).toEqual(expect.any(String));
    expect(nestedFrameButtonRef?.elementRef).toEqual(expect.any(String));

    const click = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: { selector: '#increment', tabId },
      waitForPageState: {
        scope: 'page',
        urlContains: '/automation-fixture',
        timeoutMs: 5_000,
      },
    });
    expect(click.status).toBe('succeeded');
    expect(click.actionResult?.result?.backend).toBe('cdp-native-v2');
    expect(click.supportedScopes?.opensNewBrowserSession).toBe(false);
    expect(click.supportedScopes?.topDocumentOnly).toBe(false);
    await expect(targetPage.locator('#count')).toHaveText('1');

    const semanticClick = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        scope: 'buttons',
        textContains: 'Increment',
        tabId,
      },
    });
    expect(semanticClick.status).toBe('succeeded');
    expect(semanticClick.actionResult?.result?.backend).toBe('cdp-native-v2');
    await expect(targetPage.locator('#count')).toHaveText('2');

    const locatorClick = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        tabId,
        locator: {
          scope: 'buttons',
          steps: [
            {
              kind: 'role',
              role: 'button',
              name: {
                pattern: '^Increment$',
                flags: 'i',
              },
            },
            {
              kind: 'css',
              value: '#increment',
            },
          ],
        },
      },
    });
    expect(locatorClick.status).toBe('succeeded');
    expect(locatorClick.actionResult?.result?.backend).toBe('cdp-native-v2');
    expect(locatorClick.targetResolution).toMatchObject({
      strategy: 'native_locator',
      matcher: {
        locator: {
          scope: 'buttons',
        },
      },
      matched: {
        selector: '#increment',
      },
    });
    await expect(targetPage.locator('#count')).toHaveText('3');

    const input = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'input',
      target: { selector: '#displayName', tabId },
      input: { value: 'Ada Lovelace' },
    });
    expect(input.status).toBe('succeeded');
    expect(input.actionResult?.result?.backend).toBe('cdp-native-v2');
    expect(input.actionResult?.result?.valueLength).toBe('Ada Lovelace'.length);
    await expect(targetPage.locator('#name-output')).toHaveText('Ada Lovelace');

    const semanticHover = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'hover',
      target: {
        scope: 'links',
        role: 'link',
        name: 'Docs',
        exact: true,
        nth: 1,
        tabId,
      },
    });
    expect(semanticHover.status).toBe('succeeded');
    expect(semanticHover.actionResult?.result?.backend).toBe('cdp-native-v2');
    expect(semanticHover.targetResolution).toMatchObject({
      matchedCandidateCount: 2,
      selectedIndex: 1,
    });
    await expect(targetPage.locator('#hover-output')).toHaveText('hovered docs');

    const shadowClick = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        scope: 'buttons',
        name: 'Shadow action',
        exact: true,
        first: true,
        tabId,
      },
    });
    expect(shadowClick.status).toBe('succeeded');
    expect(shadowClick.actionResult?.result?.backend).toBe('cdp-native-v2');
    expect(shadowClick.targetResolution).toMatchObject({
      selectionStrategy: 'first',
      matched: {
        selector: '#shadow-host >> #shadow-action',
      },
    });
    await expect(targetPage.locator('#shadow-output')).toHaveText('shadow clicked');

    const key = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'press_key',
      target: {
        selector: '#displayName',
        tabId,
      },
      input: { key: '!' },
    });
    expect(key.status).toBe('succeeded');
    expect(key.actionResult?.result?.backend).toBe('cdp-native-v2');
    await expect(targetPage.locator('#name-output')).toHaveText('Ada Lovelace!');

    const focus = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'focus',
      target: { selector: '#displayName', tabId },
    });
    expect(focus.status).toBe('succeeded');
    expect(focus.actionResult?.result?.backend).toBe('cdp-native-v2');
    await expect(targetPage.locator('#displayName')).toBeFocused();

    const blur = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'blur',
      target: { selector: '#displayName', tabId },
    });
    expect(blur.status).toBe('succeeded');
    expect(blur.actionResult?.result?.backend).toBe('cdp-native-v2');
    await expect(targetPage.locator('#displayName')).not.toBeFocused();

    const scroll = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'scroll',
      target: { selector: '#scroll-box', tabId },
      input: { y: 120 },
    });
    expect(scroll.status).toBe('succeeded');
    expect(scroll.actionResult?.result?.backend).toBe('cdp-native-v2');
    await expect.poll(async () => targetPage.locator('#scroll-box').evaluate((node) => node.scrollTop)).toBe(120);

    const submit = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'submit',
      target: { selector: '#submit-form', tabId },
    });
    expect(submit.status).toBe('succeeded');
    expect(submit.actionResult?.result?.backend).toBe('cdp-native-v2');
    await expect(targetPage.locator('#submit-output')).toHaveText('submitted');

    const childFrameId = frameButtonRef?.frameId as number;
    const frameClick = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        elementRef: frameButtonRef?.elementRef,
        tabId,
      },
    });
    expect(frameClick.status).toBe('succeeded');
    expect(frameClick.actionResult?.result?.backend).toBe('cdp-native-v2');
    expect(frameClick.target?.frameId).toBe(childFrameId);
    await expect(targetPage.frameLocator('#child-frame').locator('#frame-count')).toHaveText('1');

    const semanticFrameClick = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        scope: 'buttons',
        testId: 'inside-frame',
        tabId,
      },
    });
    expect(semanticFrameClick.status).toBe('succeeded');
    expect(semanticFrameClick.actionResult?.result?.backend).toBe('cdp-native-v2');
    expect(semanticFrameClick.target?.frameId).toBe(childFrameId);
    await expect(targetPage.frameLocator('#child-frame').locator('#frame-count')).toHaveText('2');

    const recoveredStaleFrameClick = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        elementRef: frameButtonRef?.elementRef,
        frameId: 999_998,
        tabId,
      },
    });
    expect(recoveredStaleFrameClick.status).toBe('succeeded');
    expect(recoveredStaleFrameClick.actionResult?.result?.backend).toBe('cdp-native-v2');
    expect(recoveredStaleFrameClick.target?.frameId).toBe(childFrameId);
    expect(recoveredStaleFrameClick.actionResult?.result?.actionability).toMatchObject({
      frameRefreshed: true,
      previousFrameId: 999_998,
      frameCoordinateResolved: true,
    });
    await expect(targetPage.frameLocator('#child-frame').locator('#frame-count')).toHaveText('3');

    const frameInput = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'input',
      target: {
        elementRef: frameInputRef?.elementRef,
        tabId,
      },
      input: {
        value: 'Frame Ada',
      },
    });
    expect(frameInput.status).toBe('succeeded');
    expect(frameInput.actionResult?.result?.backend).toBe('cdp-native-v2');
    expect(frameInput.target?.frameId).toBe(childFrameId);
    await expect(targetPage.frameLocator('#child-frame').locator('#frame-input-output')).toHaveText('Frame Ada');

    const nestedFrameClick = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        elementRef: nestedFrameButtonRef?.elementRef,
        tabId,
      },
    });
    expect(nestedFrameClick.status).toBe('succeeded');
    expect(nestedFrameClick.actionResult?.result?.backend).toBe('cdp-native-v2');
    expect(nestedFrameClick.target?.frameId).toBe(nestedFrameButtonRef?.frameId);
    await expect(targetPage.frameLocator('#outer-frame').frameLocator('#inner-frame').locator('#nested-count')).toHaveText('1');

    const semanticFrameInput = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'input',
      target: {
        scope: 'inputs',
        testId: 'frame-input',
        tabId,
      },
      input: { value: 'Frame Grace' },
    });
    expect(semanticFrameInput.status).toBe('succeeded');
    expect(semanticFrameInput.actionResult?.result?.backend).toBe('cdp-native-v2');
    expect(semanticFrameInput.target?.frameId).toBe(childFrameId);
    await expect(targetPage.frameLocator('#child-frame').locator('#frame-input-output')).toHaveText('Frame Grace');

    const workflow = await callToolJson<WorkflowResponse>(mcp.client, 'run_ui_steps', {
      sessionId,
      mode: 'safe',
      steps: [
        {
          kind: 'action',
          id: 'open-dialog',
          action: 'click',
          target: {
            scope: 'buttons',
            textContains: 'Open dialog',
          },
        },
        {
          kind: 'waitFor',
          id: 'wait-dialog',
          matcher: {
            scope: 'modals',
            titleContains: 'Automation dialog',
            timeoutMs: 5_000,
          },
        },
        {
          kind: 'action',
          id: 'confirm-dialog',
          action: 'click',
          target: {
            scope: 'buttons',
            textContains: 'Confirm dialog',
          },
        },
      ],
    });
    expect(workflow.status).toBe('succeeded');
    expect(workflow.requestedStepCount).toBe(3);
    expect(workflow.completedStepCount).toBe(3);
    expect(workflow.steps.every((step) => step.status === 'succeeded')).toBe(true);
    await expect(targetPage.locator('#dialog-result')).toHaveText('confirmed');

    const visibleAssertion = await callToolJson<{ matched: boolean; matchCount: number }>(mcp.client, 'assert_page_state', {
      sessionId,
      scope: 'buttons',
      selector: '#increment',
      visible: true,
    });
    expect(visibleAssertion.matched).toBe(true);

    const linkAssertion = await callToolJson<{ matched: boolean; matchCount: number }>(mcp.client, 'assert_page_state', {
      sessionId,
      scope: 'links',
      role: 'link',
      name: 'Docs',
      exact: true,
      countExactly: 2,
    });
    expect(linkAssertion.matched).toBe(true);

    const hiddenAssertion = await callToolJson<{ matched: boolean; matchCount: number }>(mcp.client, 'assert_page_state', {
      sessionId,
      scope: 'buttons',
      selector: '#hidden-action',
      visible: false,
    });
    expect(hiddenAssertion.matched).toBe(true);

    const disabledAttempt = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        selector: '#disabled-action',
        tabId,
      },
    });
    expect(disabledAttempt.status).toBe('rejected');
    expect(disabledAttempt.failureDetails?.code).toBe('target_disabled');
    expect(disabledAttempt.actionResult?.result?.backend).toBe('cdp-native-v2');

    const readonlyAttempt = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'input',
      target: {
        selector: '#readonly-input',
        tabId,
      },
      input: { value: 'Unlocked' },
    });
    expect(readonlyAttempt.status).toBe('rejected');
    expect(readonlyAttempt.failureDetails?.code).toBe('target_readonly');
    expect(readonlyAttempt.actionResult?.result?.backend).toBe('cdp-native-v2');
    await expect(targetPage.locator('#readonly-input')).toHaveValue('Locked');

    const hiddenAttempt = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        selector: '#hidden-action',
        tabId,
      },
    });
    expect(hiddenAttempt.status).toBe('rejected');
    expect(hiddenAttempt.failureDetails?.code).toBe('target_not_visible');

    const pointerAttempt = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        selector: '#no-pointer-action',
        tabId,
      },
    });
    expect(pointerAttempt.status).toBe('rejected');
    expect(pointerAttempt.failureDetails?.code).toBe('target_pointer_events_none');

    const coveredAttempt = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        selector: '#covered-action',
        tabId,
      },
    });
    expect(coveredAttempt.status).toBe('rejected');
    expect(coveredAttempt.failureDetails?.code).toBe('hit_target_mismatch');

    const iframeAttempt = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        selector: '#inside-frame',
        tabId,
        frameId: 999_999,
      },
    });
    expect(iframeAttempt.status).toBe('rejected');
    expect(iframeAttempt.failureDetails?.code).toBe('target_frame_not_found');

    await expect.poll(async () => {
      const runs = await callToolJson<AutomationRunsResponse>(mcp!.client, 'list_automation_runs', {
        sessionId,
        traceId: click.traceId,
        limit: 5,
      });
      return runs.runs[0]?.status ?? 'missing';
    }, { timeout: 10_000 }).toBe('succeeded');
  });
});
