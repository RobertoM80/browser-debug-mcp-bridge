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
    wait?: {
      matched?: boolean;
      waitKind?: string;
    };
  }>;
};

type WaitToolResponse = {
  matched: boolean;
  waitKind: string;
  evidence?: Record<string, unknown>;
  error?: {
    code?: string;
    message?: string;
  };
};

type AutomationRunsResponse = {
  runs: Array<{
    runId?: string;
    traceId?: string;
    action?: string;
    status?: string;
  }>;
};

type AutomationRunDetailResponse = {
  run?: {
    runId?: string;
    status?: string;
    diagnostics?: Record<string, unknown>;
  };
  steps: Array<{
    stepId?: string;
    status?: string;
    diagnostics?: Record<string, unknown>;
    failure?: Record<string, unknown>;
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

function buildAutomationFixtureHtml(crossOriginFrameUrl: string): string {
  return `
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
          #scroll-content { min-height: 280px; display: flex; flex-direction: column; gap: 12px; padding: 8px 0; }
          .scroll-spacer { flex: 0 0 160px; }
          #shadow-host { display: block; margin-top: 12px; }
          #covered-wrapper { display: inline-block; position: relative; }
          #covered-action { margin: 0; }
          #zero-size-action {
            width: 0;
            height: 0;
            padding: 0;
            border: 0;
            overflow: hidden;
          }
          #cover-layer {
            position: absolute;
            inset: 0;
            background: rgba(200, 0, 0, 0.2);
            z-index: 10;
          }
          #hidden-action { display: none; }
          #no-pointer-action { pointer-events: none; }
          #layout-target {
            background: #dbeafe;
            height: 24px;
            margin: 12px 0;
            transition: transform 600ms linear;
            width: 120px;
          }
          #layout-target.moving { transform: translateX(96px); }
          iframe {
            display: block;
            width: 320px;
            height: 120px;
            margin-top: 12px;
          }
        </style>
      </head>
      <body>
        <main>
          <h1>Live automation fixture</h1>
          <button id="increment" data-testid="increment">Increment</button>
          <section id="profile-panel" data-testid="profile-panel">
            <h2>Profile</h2>
            <button id="profile-apply">Apply</button>
          </section>
          <section id="billing-panel" data-testid="billing-panel">
            <h2>Billing</h2>
            <button id="billing-apply">Apply</button>
          </section>
          <output id="panel-output"></output>
          <button id="disabled-action" disabled>Disabled action</button>
          <button id="hidden-action">Hidden action</button>
          <button id="no-pointer-action">No pointer action</button>
          <div id="covered-wrapper">
            <button id="covered-action">Covered action</button>
            <div id="cover-layer" aria-hidden="true"></div>
          </div>
          <button id="zero-size-action">Zero size action</button>
          <output id="count" aria-live="polite">0</output>
          <label for="displayName">Display name</label>
          <input id="displayName" required />
          <label for="secondary-input">Secondary input</label>
          <input id="secondary-input" />
          <label for="readonly-input">Readonly input</label>
          <input id="readonly-input" readonly value="Locked" />
          <output id="name-output" aria-live="polite"></output>
          <div id="rich-editor" contenteditable="true" role="textbox" aria-label="Rich editor"></div>
          <output id="editor-output" aria-live="polite"></output>
          <form id="native-form">
            <button id="submit-form" type="submit">Submit form</button>
          </form>
          <output id="submit-output"></output>
          <button id="push-route" data-testid="push-route">Push route</button>
          <button id="navigate-hard" data-testid="navigate-hard">Navigate hard</button>
          <output id="navigation-output"></output>
          <button id="open-popup" data-testid="open-popup">Open popup</button>
          <output id="popup-output"></output>
          <button id="download-report" data-testid="download-report">Download report</button>
          <output id="download-output"></output>
          <button id="fetch-health" data-testid="fetch-health">Fetch health</button>
          <output id="network-output"></output>
          <button id="fetch-health-workflow" data-testid="fetch-health-workflow">Fetch health workflow</button>
          <output id="workflow-network-output"></output>
          <button id="emit-console-error" data-testid="emit-console-error">Emit console error</button>
          <output id="console-output"></output>
          <button id="open-native-dialog" data-testid="open-native-dialog">Open native dialog</button>
          <button id="start-layout-shift" data-testid="start-layout-shift">Start layout shift</button>
          <div id="layout-target"></div>
          <div id="scroll-box">
            <div id="scroll-content">
              <div class="scroll-spacer">Scrollable content</div>
              <button id="scroll-target" data-testid="scroll-target">Scroll target</button>
              <div id="detach-host"></div>
            </div>
          </div>
          <output id="scroll-output"></output>
          <output id="scroll-click-output"></output>
          <output id="detached-output"></output>
          <button id="open-dialog" data-testid="open-dialog">Open dialog</button>
          <a id="docs-primary" href="#docs-primary" aria-label="Docs">Docs</a>
          <a id="docs-secondary" href="#docs-secondary" aria-label="Docs">Docs</a>
          <output id="hover-output"></output>
          <div id="shadow-host"></div>
          <output id="shadow-output"></output>
          <div id="closed-shadow-host"></div>
          <output id="closed-shadow-output"></output>
          <section id="dialog" role="dialog" aria-modal="true" hidden>
            <h2>Automation dialog</h2>
            <button id="confirm-dialog" data-testid="confirm-dialog">Confirm dialog</button>
          </section>
          <div id="dialog-result"></div>
          <button id="reload-child-frame" data-testid="reload-child-frame">Reload child frame</button>
          <output id="frame-reload-output"></output>
          <iframe id="child-frame"></iframe>
          <iframe id="cross-origin-frame" src="${crossOriginFrameUrl}"></iframe>
          <iframe id="sandbox-frame" sandbox="allow-scripts" srcdoc="
            <!doctype html>
            <html>
              <body>
                <button id='sandbox-action' data-testid='sandbox-action'>Sandbox action</button>
                <output id='sandbox-count'>0</output>
                <script>
                  document.querySelector('#sandbox-action').addEventListener('click', () => {
                    const count = document.querySelector('#sandbox-count');
                    count.textContent = String(Number(count.textContent || '0') + 1);
                  });
                </script>
              </body>
            </html>
          "></iframe>
          <iframe id="ambiguous-frame-a" srcdoc="
            <!doctype html>
            <html>
              <head><title>Ambiguous Frame</title></head>
              <body>
                <button id='ambiguous-frame-action' data-testid='ambiguous-frame-action'>Ambiguous frame action</button>
              </body>
            </html>
          "></iframe>
          <iframe id="ambiguous-frame-b" srcdoc="
            <!doctype html>
            <html>
              <head><title>Ambiguous Frame</title></head>
              <body>
                <button id='ambiguous-frame-action' data-testid='ambiguous-frame-action'>Ambiguous frame action</button>
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
          document.querySelector('#profile-apply').addEventListener('click', () => {
            document.querySelector('#panel-output').textContent = 'profile';
          });
          document.querySelector('#billing-apply').addEventListener('click', () => {
            document.querySelector('#panel-output').textContent = 'billing';
          });
          document.querySelector('#displayName').addEventListener('input', (event) => {
            document.querySelector('#name-output').textContent = event.target.value;
          });
          document.querySelector('#rich-editor').addEventListener('input', (event) => {
            document.querySelector('#editor-output').textContent = event.target.textContent || '';
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
          document.querySelector('#push-route').addEventListener('click', () => {
            history.pushState({ automation: true }, '', '/automation-fixture/next?step=nav');
            document.querySelector('#navigation-output').textContent = location.href;
          });
          document.querySelector('#navigate-hard').addEventListener('click', () => {
            setTimeout(() => {
              window.location.href = '/automation-fixture/hard?step=lifecycle';
            }, 250);
          });
          document.querySelector('#open-popup').addEventListener('click', () => {
            const popup = window.open('about:blank', '_blank');
            document.querySelector('#popup-output').textContent = popup ? 'popup opened' : 'popup blocked';
            if (popup) {
              setTimeout(() => {
                popup.location.href = '/automation-popup-target?step=popup';
              }, 250);
            }
          });
          document.querySelector('#download-report').addEventListener('click', () => {
            document.querySelector('#download-output').textContent = 'download scheduled';
            setTimeout(() => {
              const frame = document.createElement('iframe');
              frame.hidden = true;
              frame.src = '/automation-download?file=report';
              document.body.appendChild(frame);
              setTimeout(() => frame.remove(), 1000);
            }, 250);
          });
          document.querySelector('#fetch-health').addEventListener('click', async () => {
            const response = await fetch('/health?automation=standalone', { cache: 'no-store' });
            document.querySelector('#network-output').textContent = '/health?automation=standalone:' + response.status;
          });
          document.querySelector('#fetch-health-workflow').addEventListener('click', async () => {
            const response = await fetch('/health?automation=workflow', { cache: 'no-store' });
            document.querySelector('#workflow-network-output').textContent = '/health?automation=workflow:' + response.status;
          });
          document.querySelector('#emit-console-error').addEventListener('click', () => {
            console.error('automation wait console signal');
            document.querySelector('#console-output').textContent = 'console error emitted';
          });
          document.querySelector('#open-native-dialog').addEventListener('click', () => {
            setTimeout(() => {
              alert('Automation native dialog');
            }, 1500);
          });
          document.querySelector('#start-layout-shift').addEventListener('click', () => {
            const target = document.querySelector('#layout-target');
            target.classList.remove('moving');
            void target.getBoundingClientRect().width;
            target.classList.add('moving');
          });
          document.querySelector('#scroll-box').addEventListener('scroll', (event) => {
            document.querySelector('#scroll-output').textContent = String(event.target.scrollTop);
          });
          document.querySelector('#scroll-target').addEventListener('click', () => {
            document.querySelector('#scroll-click-output').textContent = 'clicked';
          });
          const detachHost = document.querySelector('#detach-host');
          let detachedReplacementDone = false;
          const mountDetachedButton = (generation) => {
            const button = document.createElement('button');
            button.id = 'detach-on-scroll';
            button.dataset.generation = String(generation);
            button.textContent = 'Detach on scroll';
            button.addEventListener('click', () => {
              document.querySelector('#detached-output').textContent = 'clicked:' + generation;
            });
            detachHost.replaceChildren(button);
            if (detachedReplacementDone) {
              return;
            }
            const observer = new IntersectionObserver((entries) => {
              if (!entries.some((entry) => entry.isIntersecting)) {
                return;
              }
              observer.disconnect();
              detachedReplacementDone = true;
              document.querySelector('#detached-output').textContent = 'replaced';
              mountDetachedButton(generation + 1);
            }, {
              root: document.querySelector('#scroll-box'),
              threshold: 0.6,
            });
            observer.observe(button);
          };
          mountDetachedButton(1);
          const shadowRoot = document.querySelector('#shadow-host').attachShadow({ mode: 'open' });
          shadowRoot.innerHTML = '<button id="shadow-action" aria-label="Shadow action">Run shadow</button>';
          shadowRoot.querySelector('#shadow-action').addEventListener('click', () => {
            document.querySelector('#shadow-output').textContent = 'shadow clicked';
          });
          const closedShadowHost = document.querySelector('#closed-shadow-host');
          const closedShadowRoot = closedShadowHost.attachShadow({ mode: 'closed' });
          const closedShadowButton = document.createElement('button');
          closedShadowButton.id = 'closed-shadow-action';
          closedShadowButton.textContent = 'Run closed shadow';
          closedShadowButton.addEventListener('click', () => {
            document.querySelector('#closed-shadow-output').textContent = 'closed shadow clicked';
          });
          closedShadowRoot.appendChild(closedShadowButton);
          const childFrameSrcdoc = [
            '<!doctype html>',
            '<html>',
            '<body>',
            '<button id="inside-frame" data-testid="inside-frame">Inside frame</button>',
            '<output id="frame-count">0</output>',
            '<input id="frame-input" data-testid="frame-input" />',
            '<output id="frame-input-output"></output>',
            '<script>',
            'document.querySelector("#inside-frame").addEventListener("click", () => {',
            'const count = document.querySelector("#frame-count");',
            'count.textContent = String(Number(count.textContent || "0") + 1);',
            '});',
            'document.querySelector("#frame-input").addEventListener("input", (event) => {',
            'document.querySelector("#frame-input-output").textContent = event.target.value;',
            '});',
            '<' + '/script>',
            '</body>',
            '</html>',
          ].join('');
          const mountChildFrame = () => {
            const frame = document.createElement('iframe');
            frame.id = 'child-frame';
            frame.srcdoc = childFrameSrcdoc;
            return frame;
          };
          document.querySelector('#child-frame').srcdoc = childFrameSrcdoc;
          document.querySelector('#reload-child-frame').addEventListener('click', () => {
            const frame = document.querySelector('#child-frame');
            const replacement = mountChildFrame();
            frame.replaceWith(replacement);
            document.querySelector('#frame-reload-output').textContent = 'reloaded';
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
  `;
}

function buildPopupTargetHtml(): string {
  return `
    <!doctype html>
    <html lang="en">
      <head>
        <title>Automation popup target</title>
      </head>
      <body>
        <main>
          <h1>Automation popup target</h1>
          <p id="popup-target-status">ready</p>
        </main>
      </body>
    </html>
  `;
}

function buildCrossOriginFrameHtml(): string {
  return `
    <!doctype html>
    <html lang="en">
      <head>
        <title>Automation cross origin frame</title>
      </head>
      <body>
        <button id="cross-origin-action" data-testid="cross-origin-action">Cross origin action</button>
        <output id="cross-origin-count">0</output>
        <script>
          document.querySelector('#cross-origin-action').addEventListener('click', () => {
            const count = document.querySelector('#cross-origin-count');
            count.textContent = String(Number(count.textContent || '0') + 1);
          });
        </script>
      </body>
    </html>
  `;
}

async function installAutomationFixture(page: Page, fixtureUrl: string): Promise<void> {
  const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fixture = new URL(fixtureUrl);
  const crossOriginUrl = new URL(fixtureUrl);
  crossOriginUrl.hostname = fixture.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
  crossOriginUrl.pathname = '/automation-cross-origin-frame';
  crossOriginUrl.search = '';
  crossOriginUrl.hash = '';
  const origin = escapeRegex(fixture.origin);
  const crossOrigin = escapeRegex(crossOriginUrl.origin);
  await page.context().route(new RegExp(`^${origin}/automation-fixture(?:[/?#].*)?$`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: buildAutomationFixtureHtml(crossOriginUrl.toString()),
    });
  });
  await page.context().route(new RegExp(`^${origin}/automation-popup-target(?:[/?#].*)?$`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: buildPopupTargetHtml(),
    });
  });
  await page.context().route(new RegExp(`^${origin}/automation-download(?:[/?#].*)?$`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      headers: {
        'content-disposition': 'attachment; filename=\"automation-report.txt\"',
      },
      body: 'automation download payload',
    });
  });
  await page.context().route(new RegExp(`^${crossOrigin}/automation-cross-origin-frame(?:[/?#].*)?$`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: buildCrossOriginFrameHtml(),
    });
  });
  await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
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
    targetPage.on('dialog', async (dialog) => {
      await dialog.dismiss().catch(() => undefined);
    });
    await installAutomationFixture(targetPage, `http://127.0.0.1:${port}/automation-fixture`);

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
      const hasCrossOriginFrameButtonRef = refs.refs.some((ref) => ref.selector === '#cross-origin-action' && typeof ref.frameId === 'number');
      const hasSandboxFrameButtonRef = refs.refs.some((ref) => ref.selector === '#sandbox-action' && typeof ref.frameId === 'number');
      return hasFrameButtonRef
        && hasFrameInputRef
        && hasDocsLink
        && hasShadowButtonRef
        && hasNestedFrameButtonRef
        && hasCrossOriginFrameButtonRef
        && hasSandboxFrameButtonRef;
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
    const crossOriginFrameButtonRef = refs.refs.find((ref) => ref.selector === '#cross-origin-action' && typeof ref.frameId === 'number');
    const sandboxFrameButtonRef = refs.refs.find((ref) => ref.selector === '#sandbox-action' && typeof ref.frameId === 'number');
    expect(frameButtonRef?.elementRef).toEqual(expect.any(String));
    expect(frameInputRef?.elementRef).toEqual(expect.any(String));
    expect(nestedFrameButtonRef?.elementRef).toEqual(expect.any(String));
    expect(crossOriginFrameButtonRef?.elementRef).toEqual(expect.any(String));
    expect(sandboxFrameButtonRef?.elementRef).toEqual(expect.any(String));

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

    const descendantLocatorClick = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        tabId,
        locator: {
          steps: [
            {
              kind: 'testId',
              value: 'billing-panel',
            },
            {
              kind: 'role',
              role: 'button',
              name: 'Apply',
              exact: true,
              relation: 'descendant',
            },
          ],
        },
      },
    });
    expect(descendantLocatorClick.status).toBe('succeeded');
    expect(descendantLocatorClick.actionResult?.result?.backend).toBe('cdp-native-v2');
    expect(descendantLocatorClick.targetResolution).toMatchObject({
      strategy: 'native_locator',
      matched: {
        selector: '#billing-apply',
      },
    });
    await expect(targetPage.locator('#panel-output')).toHaveText('billing');

    const ancestorLocatorClick = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        tabId,
        locator: {
          steps: [
            {
              kind: 'role',
              role: 'button',
              name: 'Apply',
              exact: true,
            },
            {
              kind: 'testId',
              value: 'profile-panel',
              relation: 'ancestor',
            },
          ],
        },
      },
    });
    expect(ancestorLocatorClick.status).toBe('succeeded');
    expect(ancestorLocatorClick.actionResult?.result?.backend).toBe('cdp-native-v2');
    expect(ancestorLocatorClick.targetResolution).toMatchObject({
      strategy: 'native_locator',
      matched: {
        selector: '#profile-apply',
      },
    });
    await expect(targetPage.locator('#panel-output')).toHaveText('profile');

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

    const contenteditableInput = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'input',
      target: { selector: '#rich-editor', tabId },
      input: { value: 'Rich editor value' },
    });
    expect(contenteditableInput.status).toBe('succeeded');
    expect(contenteditableInput.actionResult?.result).toMatchObject({
      backend: 'cdp-native-v2',
      fieldType: 'contenteditable',
      valueLength: 'Rich editor value'.length,
    });
    await expect(targetPage.locator('#editor-output')).toHaveText('Rich editor value');

    await targetPage.evaluate(() => {
      window.scrollTo(0, 0);
    });
    const incrementPoint = await targetPage.evaluate(() => {
      const target = document.querySelector('#increment');
      if (!(target instanceof HTMLElement)) {
        return null;
      }
      const rect = target.getBoundingClientRect();
      return {
        x: Math.round(rect.left + (rect.width / 2)),
        y: Math.round(rect.top + (rect.height / 2)),
      };
    });
    if (!incrementPoint) {
      throw new Error('increment point was not available');
    }
    const coordinateClick = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        tabId,
        coordinates: {
          x: incrementPoint.x,
          y: incrementPoint.y,
        },
      },
    });
    expect(coordinateClick.status).toBe('succeeded');
    expect(coordinateClick.actionResult?.result).toMatchObject({
      backend: 'cdp-native-v2',
      coordinateTarget: true,
      pointCoordinateSpace: 'top-document',
    });
    await expect(targetPage.locator('#count')).toHaveText('4');

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

    const docsPoint = await targetPage.evaluate(() => {
      const target = document.querySelector('#docs-secondary');
      if (!(target instanceof HTMLElement)) {
        return null;
      }
      const rect = target.getBoundingClientRect();
      return {
        x: Math.round(rect.left + (rect.width / 2)),
        y: Math.round(rect.top + (rect.height / 2)),
      };
    });
    if (!docsPoint) {
      throw new Error('docs-secondary point was not available');
    }
    const coordinateHover = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'hover',
      target: {
        tabId,
        coordinates: {
          x: docsPoint.x,
          y: docsPoint.y,
        },
      },
    });
    expect(coordinateHover.status).toBe('succeeded');
    expect(coordinateHover.actionResult?.result).toMatchObject({
      backend: 'cdp-native-v2',
      coordinateTarget: true,
      pointCoordinateSpace: 'top-document',
    });

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

    const tabForward = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'press_key',
      target: {
        selector: '#displayName',
        tabId,
      },
      input: {
        key: 'Tab',
      },
    });
    expect(tabForward.status).toBe('succeeded');
    expect(tabForward.actionResult?.result).toMatchObject({
      backend: 'cdp-native-v2',
      key: 'Tab',
      modifiers: {
        shiftKey: false,
      },
    });
    await expect(targetPage.locator('#secondary-input')).toBeFocused();

    const tabBackward = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'press_key',
      target: {
        selector: '#secondary-input',
        tabId,
      },
      input: {
        key: 'Tab',
        shiftKey: true,
      },
    });
    expect(tabBackward.status).toBe('succeeded');
    expect(tabBackward.actionResult?.result).toMatchObject({
      backend: 'cdp-native-v2',
      key: 'Tab',
      modifiers: {
        shiftKey: true,
      },
    });
    await expect(targetPage.locator('#displayName')).toBeFocused();

    const focus = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'focus',
      target: { selector: '#displayName', tabId },
    });
    expect(focus.status).toBe('succeeded');
    expect(focus.actionResult?.result?.backend).toBe('cdp-native-v2');
    await expect(targetPage.locator('#displayName')).toBeFocused();

    const requiredLocatorFocus = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'focus',
      target: {
        tabId,
        locator: {
          steps: [
            {
              kind: 'role',
              role: 'textbox',
            },
          ],
        },
        requiredField: true,
      },
    });
    expect(requiredLocatorFocus.status).toBe('succeeded');
    expect(requiredLocatorFocus.targetResolution).toMatchObject({
      strategy: 'native_locator',
      matched: {
        selector: '#displayName',
      },
    });
    await expect(targetPage.locator('#displayName')).toBeFocused();

    const readOnlyLocatorFocus = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'focus',
      target: {
        tabId,
        locator: {
          steps: [
            {
              kind: 'role',
              role: 'textbox',
            },
          ],
        },
        readOnly: true,
      },
    });
    expect(readOnlyLocatorFocus.status).toBe('succeeded');
    expect(readOnlyLocatorFocus.targetResolution).toMatchObject({
      strategy: 'native_locator',
      matched: {
        selector: '#readonly-input',
      },
    });
    await expect(targetPage.locator('#readonly-input')).toBeFocused();

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

    const offscreenScrollClick = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: { selector: '#scroll-target', tabId },
    });
    expect(offscreenScrollClick.status).toBe('succeeded');
    expect(offscreenScrollClick.actionResult?.result?.backend).toBe('cdp-native-v2');
    expect(offscreenScrollClick.actionResult?.result?.actionability).toMatchObject({
      scrolledIntoView: true,
    });
    await expect(targetPage.locator('#scroll-click-output')).toHaveText('clicked');

    await targetPage.locator('#scroll-box').evaluate((node) => {
      node.scrollTop = 0;
    });
    await expect(targetPage.locator('#detached-output')).toHaveText('');

    const detachedRetryClick = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: { selector: '#detach-on-scroll', tabId },
    });
    expect(detachedRetryClick.status).toBe('succeeded');
    expect(detachedRetryClick.actionResult?.result?.backend).toBe('cdp-native-v2');
    expect(detachedRetryClick.actionResult?.result?.actionability).toMatchObject({
      attempts: 2,
      retryCount: 1,
      retriedAfterDetach: true,
      previousFailureCode: 'target_detached',
    });
    await expect(targetPage.locator('#detached-output')).toHaveText('clicked:2');

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

    const staleChildFrameElementRef = frameButtonRef?.elementRef as string;
    const staleChildFrameId = frameButtonRef?.frameId as number;
    await targetPage.locator('#reload-child-frame').click();
    await expect(targetPage.locator('#frame-reload-output')).toHaveText('reloaded');
    await expect(targetPage.frameLocator('#child-frame').locator('#inside-frame')).toBeVisible();
    await expect(targetPage.frameLocator('#child-frame').locator('#frame-count')).toHaveText('0');

    const reloadedFrameClick = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        elementRef: staleChildFrameElementRef,
        frameId: staleChildFrameId + 10_000,
        tabId,
      },
    });
    expect(reloadedFrameClick.status).toBe('succeeded');
    expect(reloadedFrameClick.actionResult?.result?.backend).toBe('cdp-native-v2');
    expect(reloadedFrameClick.target?.frameId).toEqual(expect.any(Number));
    expect(reloadedFrameClick.actionResult?.result?.actionability).toMatchObject({
      frameRefreshed: true,
      previousFrameId: staleChildFrameId + 10_000,
      frameCoordinateResolved: true,
    });
    expect(reloadedFrameClick.actionResult?.result?.frameResolution).toMatchObject({
      selectedBy: 'target_selector',
      frameContextCandidateCount: expect.any(Number),
      selectorMatchedCandidateCount: 1,
      matched: {
        frameUrl: 'about:srcdoc',
      },
    });
    await expect(targetPage.frameLocator('#child-frame').locator('#frame-count')).toHaveText('1');

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

    const nestedFrameLocatorClick = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        tabId,
        locator: {
          frame: {
            selector: '#outer-frame => #inner-frame',
          },
          steps: [
            {
              kind: 'testId',
              value: 'nested-frame-action',
            },
          ],
        },
      },
    });
    expect(nestedFrameLocatorClick.status).toBe('succeeded');
    expect(nestedFrameLocatorClick.actionResult?.result?.backend).toBe('cdp-native-v2');
    expect(nestedFrameLocatorClick.target?.frameId).toBe(nestedFrameButtonRef?.frameId);
    expect(nestedFrameLocatorClick.targetResolution).toMatchObject({
      strategy: 'native_locator',
      matched: {
        selector: '#nested-frame-action',
        frameSelector: '#outer-frame => #inner-frame',
      },
    });
    await expect(targetPage.frameLocator('#outer-frame').frameLocator('#inner-frame').locator('#nested-count')).toHaveText('2');

    const ambiguousFrameAttempt = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        selector: '#ambiguous-frame-action',
        frameTitleContains: 'Ambiguous Frame',
        tabId,
      },
    });
    expect(ambiguousFrameAttempt.status).toBe('rejected');
    expect(ambiguousFrameAttempt.failureDetails?.code).toBe('frame_target_ambiguous');
    expect(ambiguousFrameAttempt.actionResult?.result?.frameResolution).toMatchObject({
      strategy: 'frame_context',
      frameContextCandidateCount: 2,
      selectorMatchedCandidateCount: 2,
      matchedCandidateCount: 2,
      selectedBy: 'target_selector',
    });
    const ambiguousFrameResolution = ambiguousFrameAttempt.actionResult?.result?.frameResolution as {
      sampledCandidates?: Array<{ frameId?: number; frameUrl?: string; frameTitle?: string }>;
    } | undefined;
    expect(ambiguousFrameResolution?.sampledCandidates).toHaveLength(2);
    expect(ambiguousFrameResolution?.sampledCandidates?.every((candidate) => {
      return typeof candidate.frameId === 'number'
        && candidate.frameUrl === 'about:srcdoc'
        && candidate.frameTitle === 'Ambiguous Frame';
    })).toBe(true);

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

    const selectorWait = await callToolJson<WaitToolResponse>(mcp.client, 'wait_for_selector_state', {
      sessionId,
      selector: '#increment',
      state: 'visible',
      timeoutMs: 5_000,
    });
    expect(selectorWait.matched).toBe(true);
    expect(selectorWait.waitKind).toBe('selector_state');

    const navigationSince = Date.now();
    const routeClick = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        selector: '#push-route',
        tabId,
      },
    });
    expect(routeClick.status).toBe('succeeded');
    await expect(targetPage.locator('#navigation-output')).toContainText('/automation-fixture/next?step=nav');

    const navigationWait = await callToolJson<WaitToolResponse>(mcp.client, 'wait_for_navigation', {
      sessionId,
      urlContains: '/automation-fixture/next',
      fromUrlContains: '/automation-fixture',
      trigger: 'pushState',
      tabId,
      sinceTs: navigationSince,
      timeoutMs: 5_000,
    });
    expect(navigationWait.matched).toBe(true);
    expect(navigationWait.waitKind).toBe('navigation');

    const urlWait = await callToolJson<WaitToolResponse>(mcp.client, 'wait_for_url', {
      sessionId,
      urlContains: '/automation-fixture/next?step=nav',
      timeoutMs: 5_000,
    });
    expect(urlWait.matched).toBe(true);
    expect(urlWait.waitKind).toBe('url');

    const loadStateWait = await callToolJson<WaitToolResponse>(mcp.client, 'wait_for_load_state', {
      sessionId,
      state: 'load',
      urlContains: '/automation-fixture/next?step=nav',
      timeoutMs: 5_000,
    });
    expect(loadStateWait.matched).toBe(true);
    expect(loadStateWait.waitKind).toBe('load_state');
    expect(loadStateWait.evidence?.page).toMatchObject({
      readyState: 'complete',
    });

    const hardNavigationClick = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        selector: '#navigate-hard',
        tabId,
      },
    });
    expect(hardNavigationClick.status).toBe('succeeded');

    const lifecycleWait = await callToolJson<WaitToolResponse>(mcp.client, 'wait_for_navigation_lifecycle', {
      sessionId,
      state: 'load',
      urlContains: '/automation-fixture/hard?step=lifecycle',
      tabId,
      timeoutMs: 5_000,
    });
    expect(lifecycleWait.matched).toBe(true);
    expect(lifecycleWait.waitKind).toBe('navigation_lifecycle');
    expect(lifecycleWait.evidence?.lifecycle).toMatchObject({
      state: 'load',
      eventMethod: 'Page.loadEventFired',
    });
    await expect(targetPage.locator('h1')).toHaveText('Live automation fixture');

    const popupClick = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        selector: '#open-popup',
        tabId,
      },
    });
    expect(popupClick.status).toBe('succeeded');

    const popupWait = await callToolJson<WaitToolResponse>(mcp.client, 'wait_for_popup', {
      sessionId,
      urlContains: '/automation-popup-target?step=popup',
      openerTabId: tabId,
      timeoutMs: 5_000,
    });
    expect(popupWait.matched).toBe(true);
    expect(popupWait.waitKind).toBe('popup');
    expect(popupWait.evidence?.popup).toMatchObject({
      openerTabId: tabId,
    });
    await expect.poll(async () => {
      return extension?.context.pages().some((page) => page.url().includes('/automation-popup-target?step=popup')) ?? false;
    }, { timeout: 5_000 }).toBe(true);

    const popupTimeoutClick = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        selector: '#open-popup',
        tabId,
      },
    });
    expect(popupTimeoutClick.status).toBe('succeeded');

    const popupTimeoutWait = await callToolJson<WaitToolResponse>(mcp.client, 'wait_for_popup', {
      sessionId,
      urlContains: '/automation-popup-target?step=missing',
      openerTabId: tabId,
      timeoutMs: 2_000,
    });
    expect(popupTimeoutWait.matched).toBe(false);
    expect(popupTimeoutWait.error?.code).toBe('popup_wait_timeout');
    expect(popupTimeoutWait.evidence?.timeoutDiagnostics).toMatchObject({
      matcherSummary: {
        urlContains: '/automation-popup-target?step=missing',
        openerTabId: tabId,
      },
    });

    const downloadClick = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        selector: '#download-report',
        tabId,
      },
    });
    expect(downloadClick.status).toBe('succeeded');

    const downloadWait = await callToolJson<WaitToolResponse>(mcp.client, 'wait_for_download', {
      sessionId,
      filenameContains: 'automation-report',
      state: 'completed',
      tabId,
      timeoutMs: 10_000,
    });
    expect(downloadWait.matched).toBe(true);
    expect(downloadWait.waitKind).toBe('download');
    expect(downloadWait.evidence?.download).toMatchObject({
      state: 'completed',
      suggestedFilename: 'automation-report.txt',
    });

    const consoleSince = Date.now();
    const consoleClick = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        selector: '#emit-console-error',
        tabId,
      },
    });
    expect(consoleClick.status).toBe('succeeded');
    await expect(targetPage.locator('#console-output')).toHaveText('console error emitted');

    const consoleWait = await callToolJson<WaitToolResponse>(mcp.client, 'wait_for_console', {
      sessionId,
      levels: ['error'],
      contains: 'automation wait console signal',
      sinceTs: consoleSince,
      timeoutMs: 5_000,
    });
    expect(consoleWait.matched).toBe(true);
    expect(consoleWait.waitKind).toBe('console');

    const dialogClick = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        selector: '#open-native-dialog',
        tabId,
      },
    });
    expect(dialogClick.status).toBe('succeeded');

    const dialogWait = await callToolJson<WaitToolResponse>(mcp.client, 'wait_for_dialog', {
      sessionId,
      type: 'alert',
      messageContains: 'Automation native dialog',
      action: 'accept',
      tabId,
      timeoutMs: 5_000,
    });
    expect(dialogWait.matched).toBe(true);
    expect(dialogWait.waitKind).toBe('dialog');
    expect(dialogWait.evidence?.dialog).toMatchObject({
      type: 'alert',
      message: 'Automation native dialog',
      action: 'accept',
    });

    const layoutShiftClick = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        selector: '#start-layout-shift',
        tabId,
      },
    });
    expect(layoutShiftClick.status).toBe('succeeded');

    const stableLayoutWait = await callToolJson<WaitToolResponse>(mcp.client, 'wait_for_stable_layout', {
      sessionId,
      selector: '#layout-target',
      stableMs: 300,
      tabId,
      timeoutMs: 5_000,
      pollIntervalMs: 50,
    });
    expect(stableLayoutWait.matched).toBe(true);
    expect(stableLayoutWait.waitKind).toBe('stable_layout');
    expect(stableLayoutWait.evidence?.layout).toMatchObject({
      selector: '#layout-target',
      matched: true,
    });

    const networkSince = Date.now();
    const fetchClick = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        selector: '#fetch-health',
        tabId,
      },
    });
    expect(fetchClick.status).toBe('succeeded');
    await expect(targetPage.locator('#network-output')).toHaveText('/health?automation=standalone:200');

    const requestWait = await callToolJson<WaitToolResponse>(mcp.client, 'wait_for_request', {
      sessionId,
      urlContains: '/health?automation=standalone',
      method: 'GET',
      initiator: 'fetch',
      tabId,
      sinceTs: networkSince,
      timeoutMs: 5_000,
    });
    expect(requestWait.matched).toBe(true);
    expect(requestWait.waitKind).toBe('request');

    const responseWait = await callToolJson<WaitToolResponse>(mcp.client, 'wait_for_response', {
      sessionId,
      urlContains: '/health?automation=standalone',
      method: 'GET',
      statusIn: [200],
      tabId,
      sinceTs: networkSince,
      timeoutMs: 5_000,
    });
    expect(responseWait.matched).toBe(true);
    expect(responseWait.waitKind).toBe('response');

    const quietWait = await callToolJson<WaitToolResponse>(mcp.client, 'wait_for_network_quiet', {
      sessionId,
      urlContains: '/health?automation=standalone',
      method: 'GET',
      tabId,
      quietMs: 150,
      timeoutMs: 5_000,
    });
    expect(quietWait.matched).toBe(true);
    expect(quietWait.waitKind).toBe('network_quiet');

    const workflowNetworkSince = Date.now();
    const waitWorkflow = await callToolJson<WorkflowResponse>(mcp.client, 'run_ui_steps', {
      sessionId,
      mode: 'safe',
      steps: [
        {
          kind: 'action',
          id: 'fetch-health-workflow',
          action: 'click',
          target: {
            selector: '#fetch-health-workflow',
            tabId,
          },
        },
        {
          kind: 'wait',
          id: 'wait-workflow-request',
          wait: {
            waitKind: 'request',
            urlContains: '/health?automation=workflow',
            method: 'GET',
            initiator: 'fetch',
            tabId,
            sinceTs: workflowNetworkSince,
            timeoutMs: 5_000,
          },
        },
        {
          kind: 'wait',
          id: 'wait-workflow-response',
          wait: {
            waitKind: 'response',
            urlContains: '/health?automation=workflow',
            method: 'GET',
            statusGte: 200,
            statusLt: 300,
            tabId,
            sinceTs: workflowNetworkSince,
            timeoutMs: 5_000,
          },
        },
      ],
    });
    expect(waitWorkflow.status).toBe('succeeded');
    expect(waitWorkflow.completedStepCount).toBe(3);
    expect(waitWorkflow.steps.map((step) => step.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(waitWorkflow.steps[1]?.wait?.matched).toBe(true);
    expect(waitWorkflow.steps[1]?.wait?.waitKind).toBe('request');
    expect(waitWorkflow.steps[2]?.wait?.matched).toBe(true);
    await expect(targetPage.locator('#workflow-network-output')).toHaveText('/health?automation=workflow:200');

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
    expect(coveredAttempt.actionResult?.result?.actionability).toMatchObject({
      isCovered: true,
      hitTargetMatches: false,
    });

    const zeroSizeAttempt = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        selector: '#zero-size-action',
        tabId,
      },
    });
    expect(zeroSizeAttempt.status).toBe('rejected');
    expect(zeroSizeAttempt.failureDetails?.code).toBe('zero_size_target');
    expect(zeroSizeAttempt.actionResult?.result?.actionability).toMatchObject({
      failureCode: 'zero_size_target',
      boundingRect: {
        width: 0,
        height: 0,
      },
    });

    const closedShadowAttempt = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        selector: '#closed-shadow-host >> #closed-shadow-action',
        tabId,
      },
    });
    expect(closedShadowAttempt.status).toBe('rejected');
    expect(closedShadowAttempt.failureDetails?.code).toBe('closed_shadow_root_unsupported');

    const crossOriginAttempt = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        elementRef: crossOriginFrameButtonRef?.elementRef,
        tabId,
      },
    });
    expect(crossOriginAttempt.status).toBe('succeeded');
    expect(crossOriginAttempt.actionResult?.result?.backend).toBe('cdp-native-v2');
    expect(crossOriginAttempt.actionResult?.result?.framePolicy).toMatchObject({
      pointerActionsSupported: true,
      sameOriginWithTop: false,
    });
    expect(crossOriginAttempt.actionResult?.result).toMatchObject({
      pointCoordinateSpace: 'translated-frame',
      frameCoordinateTranslation: {
        resolved: true,
        frameSelector: '#cross-origin-frame',
      },
    });
    await expect(targetPage.frameLocator('#cross-origin-frame').locator('#cross-origin-count')).toHaveText('1');
    const crossOriginCoordinatePoint = await targetPage.frameLocator('#cross-origin-frame').locator('#cross-origin-action').evaluate((element) => {
      if (!(element instanceof HTMLElement)) {
        return null;
      }
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.left + (rect.width / 2)),
        y: Math.round(rect.top + (rect.height / 2)),
      };
    });
    if (!crossOriginCoordinatePoint || typeof crossOriginAttempt.target?.frameId !== 'number') {
      throw new Error('Cross-origin frame coordinate point was not available');
    }
    const crossOriginCoordinateAttempt = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        tabId,
        coordinates: {
          x: crossOriginCoordinatePoint.x,
          y: crossOriginCoordinatePoint.y,
          frameId: crossOriginAttempt.target.frameId,
        },
      },
    });
    expect(crossOriginCoordinateAttempt.status).toBe('succeeded');
    expect(crossOriginCoordinateAttempt.actionResult?.result).toMatchObject({
      backend: 'cdp-native-v2',
      coordinateTarget: true,
      pointCoordinateSpace: 'translated-frame',
      frameCoordinateTranslation: {
        resolved: true,
        frameSelector: '#cross-origin-frame',
      },
    });
    await expect(targetPage.frameLocator('#cross-origin-frame').locator('#cross-origin-count')).toHaveText('2');

    const sandboxAttempt = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        elementRef: sandboxFrameButtonRef?.elementRef,
        tabId,
      },
    });
    expect(sandboxAttempt.status).toBe('succeeded');
    expect(sandboxAttempt.actionResult?.result?.backend).toBe('cdp-native-v2');
    expect(sandboxAttempt.actionResult?.result?.framePolicy).toMatchObject({
      pointerActionsSupported: true,
      isOpaqueOrigin: true,
    });
    expect(sandboxAttempt.actionResult?.result).toMatchObject({
      pointCoordinateSpace: 'translated-frame',
      frameCoordinateTranslation: {
        resolved: true,
        frameSelector: '#sandbox-frame',
      },
    });
    await expect(targetPage.frameLocator('#sandbox-frame').locator('#sandbox-count')).toHaveText('1');
    const sandboxCoordinatePoint = await targetPage.frameLocator('#sandbox-frame').locator('#sandbox-action').evaluate((element) => {
      if (!(element instanceof HTMLElement)) {
        return null;
      }
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.left + (rect.width / 2)),
        y: Math.round(rect.top + (rect.height / 2)),
      };
    });
    if (!sandboxCoordinatePoint || typeof sandboxAttempt.target?.frameId !== 'number') {
      throw new Error('Sandbox frame coordinate point was not available');
    }
    const sandboxCoordinateAttempt = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        tabId,
        coordinates: {
          x: sandboxCoordinatePoint.x,
          y: sandboxCoordinatePoint.y,
          frameId: sandboxAttempt.target.frameId,
        },
      },
    });
    expect(sandboxCoordinateAttempt.status).toBe('succeeded');
    expect(sandboxCoordinateAttempt.actionResult?.result).toMatchObject({
      backend: 'cdp-native-v2',
      coordinateTarget: true,
      pointCoordinateSpace: 'translated-frame',
      frameCoordinateTranslation: {
        resolved: true,
        frameSelector: '#sandbox-frame',
      },
    });
    await expect(targetPage.frameLocator('#sandbox-frame').locator('#sandbox-count')).toHaveText('2');

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

    const coveredWithEvidenceAttempt = await callToolJson<LiveActionResponse>(mcp.client, 'execute_ui_action', {
      sessionId,
      action: 'click',
      target: {
        selector: '#covered-action',
        tabId,
      },
      captureOnFailure: {
        enabled: true,
        mode: 'dom',
        styleMode: 'computed-lite',
      },
    });
    expect(coveredWithEvidenceAttempt.status).toBe('rejected');
    expect(coveredWithEvidenceAttempt.failureDetails?.code).toBe('hit_target_mismatch');

    await expect.poll(async () => {
      const runs = await callToolJson<AutomationRunsResponse>(mcp!.client, 'list_automation_runs', {
        sessionId,
        traceId: click.traceId,
        limit: 5,
      });
      return runs.runs[0]?.status ?? 'missing';
    }, { timeout: 10_000 }).toBe('succeeded');

    let coveredRunId: string | undefined;
    await expect.poll(async () => {
      const runs = await callToolJson<AutomationRunsResponse>(mcp!.client, 'list_automation_runs', {
        sessionId,
        traceId: coveredWithEvidenceAttempt.traceId,
        limit: 5,
      });
      coveredRunId = runs.runs[0]?.runId;
      return coveredRunId ?? 'missing';
    }, { timeout: 10_000 }).not.toBe('missing');
    if (!coveredRunId) {
      throw new Error('expected covered failure automation run id');
    }

    const coveredRun = await callToolJson<AutomationRunDetailResponse>(mcp.client, 'get_automation_run', {
      sessionId,
      runId: coveredRunId,
    });
    expect(['failed', 'rejected']).toContain(coveredRun.run?.status);
    expect(coveredRun.run?.diagnostics).toMatchObject({
      failureEvidence: {
        captured: expect.any(Boolean),
      },
    });
    expect(coveredRun.steps[0]?.diagnostics).toMatchObject({
      actionability: {
        hitTargetMatches: false,
        isCovered: true,
      },
      failureEvidence: {
        captured: expect.any(Boolean),
      },
    });
  });
});
