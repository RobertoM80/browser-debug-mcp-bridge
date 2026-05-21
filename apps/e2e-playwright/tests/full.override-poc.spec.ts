import { expect, test, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { callToolJson, callToolText, connectMcpClient, type MCPClientHandle } from './utils/mcp-client';
import {
  assertExtensionInstalled,
  createTempDataDir,
  getFreePort,
  launchExtensionContext,
  NEXT_FIXTURE_ROOT,
  openExtensionPage,
  sendRuntimeMessage,
  startHttpServer,
  startNextFixtureApp,
  type ExtensionContextHandle,
  type ManagedServerProcess,
} from './utils/runtime';

type RuntimeResponse =
  | { ok: true; state?: { isActive: boolean; isPaused?: boolean; sessionId: string | null }; result?: unknown; config?: unknown }
  | { ok: false; error: string };

type TabScope = {
  allowedTabIds: number[];
  tabs?: Array<{
    tabId: number;
    url: string;
    bound: boolean;
  }>;
};

type SessionState = {
  isActive: boolean;
  isPaused?: boolean;
  sessionId: string | null;
};

type OverrideStatus = {
  active: boolean;
  configuredEnabled: boolean;
  runId?: string;
  runStatus?: string;
  selectedTabId?: number;
  tabId?: number;
  matchedRequests: number;
  fulfilledRequests: number;
  lastErrorCode?: string;
  lastError?: string;
};

type OverrideRun = {
  runId: string;
  runStatus: string;
  endedAt?: number | null;
  matchedRequests: number;
  fulfilledRequests: number;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
};

type GeneratedOverrideProfile = {
  ruleCount: number;
  suggestedConfigPath: string;
  write?: {
    written?: boolean;
  };
};

type OverrideConfigFile = {
  enabled: boolean;
  activeProfileId?: string;
  profiles: Array<{
    profileId?: string;
    enabled?: boolean;
    rules: Array<{
      localFilePath: string;
      contentType: string;
      enabled?: boolean;
    }>;
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

type OverrideRequestLog = {
  requests?: Array<{
    requestUrl?: string;
    status?: string;
  }>;
};

type OverridePlanLog = {
  plans?: Array<{
    planId?: string;
    plannerKind?: string;
    ruleType?: string;
    targetAssetUrl?: string;
    patchedSha256?: string;
    patchSummary?: {
      jsonPatches?: unknown[];
      textPatches?: unknown[];
      documentPatches?: unknown[];
    };
    rollback?: {
      disableTool?: string;
      configPath?: string;
      generatedFiles?: string[];
    };
  }>;
};

type ObservedOverrideAssets = {
  persisted?: {
    persistedCount?: number;
  };
  assets?: Array<{
    url?: string;
  }>;
};

type NextAssetMapping = {
  driftSummary?: {
    checked?: number;
    matched?: number;
    different?: number;
  };
  candidates?: Array<{
    targetAssetUrl?: string;
    confidence?: string;
    score?: number;
    matchedSourcePaths?: string[];
    drift?: {
      status?: string;
    };
  }>;
};

type NextSourceOverridePlan = {
  configWritten?: boolean;
  configPath?: string;
  overlayProjectRoot?: string;
  changedAssetCount?: number;
  dependencyRuleCount?: number;
  blockers?: string[];
  rules?: Array<{
    targetAssetUrl?: string;
    localFilePath?: string;
    reason?: string;
    matchedSourcePaths?: string[];
  }>;
};

type OverrideResponsePatchPlan = {
  ruleType?: string;
  requestMethod?: string;
  matchMode?: string;
  localFilePath?: string;
  configWritten?: boolean;
  patchedSha256?: string;
  blockers?: string[];
  warnings?: string[];
  audit?: {
    persisted?: boolean;
    plans?: Array<{
      planId?: string;
      plannerKind?: string;
    }>;
  };
  capturedFromLiveSession?: {
    captureMode?: string;
    matchMode?: string;
    source?: string;
    tabId?: number;
  };
  rule?: {
    ruleType?: string;
    requestMethod?: string;
    matchMode?: string;
    targetAssetUrl?: string;
    localFilePath?: string;
    rscFlight?: {
      productionMode?: string;
      source?: string;
      patchKind?: string;
    };
  };
};

type OverrideResponseCaptureResult = {
  targetUrl?: string;
  finalUrl?: string;
  captureMode?: string;
  matchMode?: string;
  source?: string;
  tabId?: number;
  requestMethod?: string;
  contentType?: string;
  ruleType?: string;
  bodyCaptured?: boolean;
  bodyText?: string;
  bodyPreview?: string;
  truncated?: boolean;
};

type NextDataJsonPayload = {
  pageProps?: {
    signal?: {
      mode?: string;
      message?: string;
      badge?: string;
    };
  };
};

type NextPageOverrideScenario = {
  page: 'home' | 'about' | 'products';
  path: string;
  originalActionText: string;
  originalSelector: string;
  originalText: string;
  overrideActionText: string;
  overrideSelector: string;
  overrideText: string;
  textUpdates: Array<[selector: string, text: string]>;
};

interface OverrideFixture {
  cleanup(): void;
  configPath: string;
}

interface ManagedTargetApp {
  baseUrl: string;
  stop(): Promise<void>;
}

const NEXT_FIXTURE_SOURCE_FILES = [
  'src/app/layout.tsx',
  'src/app/page.tsx',
  'src/app/api-signal-panel.tsx',
  'src/app/api/override-signal/route.ts',
  'src/app/about/page.tsx',
  'src/app/products/page.tsx',
  'src/app/rsc-lab/layout.tsx',
  'src/app/rsc-lab/loading.tsx',
  'src/app/rsc-lab/error.tsx',
  'src/app/rsc-lab/client-prop-card.tsx',
  'src/app/rsc-lab/[id]/page.tsx',
  'src/app/rsc-lab/search/page.tsx',
  'src/app/scenario-boot.tsx',
  'src/pages/legacy-data.tsx',
  'src/pages/legacy-other.tsx',
].map((relativePath) => join(NEXT_FIXTURE_ROOT, relativePath));

const TARGET_APP_DOCUMENT_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Override E2E</title>
  </head>
  <body data-script-mode="boot">
    <main>
      <h1>Override Target</h1>
      <p id="mode">boot</p>
      <p id="extra-mode">boot-extra</p>
      <button id="post-rsc-trigger" type="button">Load POST RSC proof</button>
      <p id="post-rsc-result">post-rsc-idle</p>
    </main>
    <script src="/app.js"></script>
    <script src="/extra.js"></script>
    <script>
      document.getElementById('post-rsc-trigger')?.addEventListener('click', async () => {
        const response = await fetch('/rsc-post', {
          method: 'POST',
          headers: { RSC: '1' },
          cache: 'no-store',
        });
        const text = await response.text();
        const result = document.getElementById('post-rsc-result');
        if (!result) return;
        if (text.includes('Override POST RSC proof')) {
          result.textContent = 'Override POST RSC proof';
        } else if (text.includes('Original POST RSC proof')) {
          result.textContent = 'Original POST RSC proof';
        } else {
          result.textContent = text.slice(0, 80);
        }
      });
    </script>
  </body>
</html>`;

const POST_RSC_RESPONSE_BODY = '1:["$","p",null,{"children":"Original POST RSC proof"}]';

const NEXT_PAGE_OVERRIDE_SCENARIOS: NextPageOverrideScenario[] = [
  {
    page: 'home',
    path: '/',
    originalSelector: '#home-headline',
    originalText: 'Original launch desk for field teams',
    overrideSelector: '#home-headline',
    overrideText: 'Override launch desk controlled by MCP',
    originalActionText: 'Original demo queued from Home.',
    overrideActionText: 'Override demo routed through MCP.',
    textUpdates: [
      ['#home-headline', 'Override launch desk controlled by MCP'],
      ['#home-story', 'This copy was changed by a browser-only override served from a Playwright temp file.'],
      ['#home-action', 'Run override demo'],
    ],
  },
  {
    page: 'about',
    path: '/about',
    originalSelector: '#about-proof',
    originalText: 'Original proof: 42 inspection notes reviewed by humans.',
    overrideSelector: '#about-proof',
    overrideText: 'Override proof: live MCP command replaced this trust panel in Chromium.',
    originalActionText: 'Original proof pack opened.',
    overrideActionText: 'Override proof pack injected by browser.',
    textUpdates: [
      ['#about-headline', 'Override quality promise'],
      ['#about-proof', 'Override proof: live MCP command replaced this trust panel in Chromium.'],
      ['#about-action', 'Open override proof pack'],
    ],
  },
  {
    page: 'products',
    path: '/products',
    originalSelector: '#products-price',
    originalText: '$129',
    overrideSelector: '#products-price',
    overrideText: '$79 override deal',
    originalActionText: 'Original catalog sorted by stability.',
    overrideActionText: 'Override catalog sorted by savings.',
    textUpdates: [
      ['#products-headline', 'Override debugging kits'],
      ['#products-price', '$79 override deal'],
      ['#products-action', 'Sort override catalog'],
    ],
  },
];

function createOverrideFixture(targetAssetUrl: string): OverrideFixture {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'bdmcp-override-fixture-'));
  const localOverridePath = join(fixtureRoot, 'override-app.js');
  const configPath = join(fixtureRoot, 'override-poc.config.json');

  writeFileSync(
    localOverridePath,
    [
      'window.__bdmcpOverrideMode = "override";',
      'document.body.dataset.scriptMode = "override";',
      'const marker = document.getElementById("mode");',
      'if (marker) marker.textContent = "override";',
    ].join('\n'),
    'utf8',
  );

  writeFileSync(
    configPath,
    JSON.stringify({
      enabled: true,
      targetAssetUrl,
      localFilePath: './override-app.js',
      contentType: 'application/javascript; charset=utf-8',
      autoReload: true,
    }, null, 2),
    'utf8',
  );

  return {
    configPath,
    cleanup: () => {
      rmSync(fixtureRoot, { recursive: true, force: true });
    },
  };
}

function createMultiRuleOverrideFixture(baseUrl: string): OverrideFixture {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'bdmcp-override-fixture-'));
  const localOverridePath = join(fixtureRoot, 'override-app.js');
  const localExtraPath = join(fixtureRoot, 'override-extra.js');
  const configPath = join(fixtureRoot, 'override-poc.config.json');

  writeFileSync(
    localOverridePath,
    [
      'window.__bdmcpOverrideMode = "override";',
      'document.body.dataset.scriptMode = "override";',
      'const marker = document.getElementById("mode");',
      'if (marker) marker.textContent = "override";',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    localExtraPath,
    [
      'window.__bdmcpExtraOverrideMode = "override-extra";',
      'document.body.dataset.extraScriptMode = "override-extra";',
      'const extra = document.getElementById("extra-mode");',
      'if (extra) extra.textContent = "override-extra";',
    ].join('\n'),
    'utf8',
  );

  writeFileSync(
    configPath,
    JSON.stringify({
      enabled: true,
      activeProfileId: 'local-dev',
      profiles: [{
        profileId: 'local-dev',
        name: 'Local development overrides',
        enabled: true,
        autoReload: true,
        rules: [
          {
            ruleId: 'app',
            targetAssetUrl: `${baseUrl}/app.js`,
            localFilePath: './override-app.js',
            contentType: 'application/javascript; charset=utf-8',
          },
          {
            ruleId: 'extra',
            targetAssetUrl: `${baseUrl}/extra.js`,
            localFilePath: './override-extra.js',
            contentType: 'application/javascript; charset=utf-8',
          },
        ],
      }],
    }, null, 2),
    'utf8',
  );

  return {
    configPath,
    cleanup: () => {
      rmSync(fixtureRoot, { recursive: true, force: true });
    },
  };
}

function writeNextPageOverrideMarker(markerPath: string, scenario: NextPageOverrideScenario): void {
  writeFileSync(
    markerPath,
    [
      '(function bdmcpNextPageOverrideMarker() {',
      `  const page = ${JSON.stringify(scenario.page)};`,
      `  const textUpdates = ${JSON.stringify(scenario.textUpdates)};`,
      `  const actionText = ${JSON.stringify(scenario.overrideActionText)};`,
      '  function setText(selector, value) {',
      '    const element = document.querySelector(selector);',
      '    if (element) element.textContent = value;',
      '  }',
      '  function mark() {',
      '    const root = document.querySelector("[data-fixture-page=\\\"" + page + "\\\"]");',
      '    if (!root) return;',
      '    window.__bdmcpNextOverrideMode = page + ":override";',
      '    document.documentElement.dataset.nextOverrideMode = page + ":override";',
      '    if (document.body) document.body.dataset[page + "OverrideMode"] = "override";',
      '    setText("#" + page + "-override-marker", "override");',
      '    textUpdates.forEach(function applyTextUpdate(entry) { setText(entry[0], entry[1]); });',
      '    const oldAction = document.getElementById(page + "-action");',
      '    if (oldAction && oldAction.dataset.overrideBound !== "true") {',
      '      const action = oldAction.cloneNode(true);',
      '      action.dataset.overrideBound = "true";',
      '      oldAction.replaceWith(action);',
      '      action.addEventListener("click", function onOverrideAction(event) {',
      '        event.preventDefault();',
      '        setText("#" + page + "-action-status", actionText);',
      '      });',
      '    }',
      '  }',
      '  mark();',
      '  document.addEventListener("DOMContentLoaded", mark);',
      '  setTimeout(mark, 50);',
      '  setTimeout(mark, 250);',
      '}());',
    ].join('\n'),
    'utf8',
  );
}

function pointGeneratedRulesAtMarker(configPath: string, markerFileName: string): void {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as OverrideConfigFile;
  config.enabled = true;
  for (const profile of config.profiles) {
    profile.enabled = true;
    for (const rule of profile.rules) {
      rule.enabled = true;
      rule.localFilePath = `./${markerFileName}`;
      rule.contentType = 'application/javascript; charset=utf-8';
    }
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function snapshotNextFixtureSources(): Map<string, string> {
  return new Map(NEXT_FIXTURE_SOURCE_FILES.map((filePath) => [filePath, readFileSync(filePath, 'utf8')]));
}

function expectNextFixtureSourcesUnchanged(snapshot: Map<string, string>): void {
  for (const [filePath, expectedContent] of snapshot) {
    expect(readFileSync(filePath, 'utf8')).toBe(expectedContent);
  }
}

function listNextFixtureObservedChunkAssets(options: { integrity?: string } = {}): Array<Record<string, unknown>> {
  const chunksDir = join(NEXT_FIXTURE_ROOT, '.next', 'static', 'chunks');
  return readdirSync(chunksDir)
    .filter((entry) => entry.endsWith('.js'))
    .map((entry) => ({
      url: `https://example.test/_next/static/chunks/${entry}`,
      kind: 'script',
      fromDom: true,
      integrity: options.integrity,
    }));
}

async function startTargetApp(): Promise<ManagedTargetApp> {
  const port = await getFreePort();
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);

    if (requestUrl.pathname === '/app.js') {
      response.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      });
      response.end([
        'window.__bdmcpOverrideMode = "original";',
        'document.body.dataset.scriptMode = "original";',
        'const marker = document.getElementById("mode");',
        'if (marker) marker.textContent = "original";',
      ].join('\n'));
      return;
    }

    if (requestUrl.pathname === '/extra.js') {
      response.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      });
      response.end([
        'window.__bdmcpExtraOverrideMode = "original-extra";',
        'document.body.dataset.extraScriptMode = "original-extra";',
        'const extra = document.getElementById("extra-mode");',
        'if (extra) extra.textContent = "original-extra";',
      ].join('\n'));
      return;
    }

    if (requestUrl.pathname === '/rsc-post') {
      if (request.method !== 'POST') {
        response.writeHead(405, {
          'Allow': 'POST',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        });
        response.end();
        return;
      }

      response.writeHead(200, {
        'Content-Type': 'text/x-component; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      });
      response.end(POST_RSC_RESPONSE_BODY);
      return;
    }

    if (requestUrl.pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }

    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
    response.end(TARGET_APP_DOCUMENT_HTML);
  });

  await new Promise<void>((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(port, '127.0.0.1', () => resolveStart());
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: async () => {
      await new Promise<void>((resolveStop, rejectStop) => {
        server.close((error) => {
          if (error) {
            rejectStop(error);
            return;
          }
          resolveStop();
        });
      });
    },
  };
}

async function getBoundTabId(popupPage: Page): Promise<number> {
  const scope = await getSessionTabScope(popupPage);
  const [boundTabId] = scope.allowedTabIds;
  if (typeof boundTabId !== 'number') {
    throw new Error('No bound tab was returned for the active session');
  }

  return boundTabId;
}

async function getSessionTabScope(popupPage: Page): Promise<TabScope> {
  const scopeResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_GET_TAB_SCOPE' });
  expect(scopeResponse.ok).toBe(true);
  if (!scopeResponse.ok || !scopeResponse.result) {
    throw new Error('Tab scope was not available');
  }

  return scopeResponse.result as TabScope;
}

async function waitForTabIdByUrl(popupPage: Page, urlPart: string): Promise<number> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const scope = await getSessionTabScope(popupPage);
    const tab = scope.tabs?.find((candidate) => candidate.url.includes(urlPart));
    if (typeof tab?.tabId === 'number') {
      return tab.tabId;
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }

  throw new Error(`Timed out waiting for tab URL containing ${urlPart}`);
}

async function getOverrideStatus(popupPage: Page): Promise<OverrideStatus> {
  const statusResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'OVERRIDE_POC_GET_STATUS' });
  expect(statusResponse.ok).toBe(true);
  if (!statusResponse.ok || !statusResponse.result) {
    throw new Error('Override status was not available');
  }

  return statusResponse.result as OverrideStatus;
}

async function getSessionState(popupPage: Page): Promise<SessionState> {
  const stateResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_GET_STATE' });
  expect(stateResponse.ok).toBe(true);
  if (!stateResponse.ok || !stateResponse.state) {
    throw new Error('Session state was not available');
  }

  return stateResponse.state;
}

async function getActiveSessionId(popupPage: Page): Promise<string> {
  const state = await getSessionState(popupPage);
  if (typeof state.sessionId !== 'string' || state.sessionId.length === 0) {
    throw new Error('Session id was not available');
  }

  return state.sessionId;
}

async function fetchOverrideRuns(serverPort: number, sessionId: string): Promise<OverrideRun[]> {
  const response = await fetch(
    `http://127.0.0.1:${serverPort}/sessions/${encodeURIComponent(sessionId)}/overrides/runs?limit=20&offset=0`,
  );
  expect(response.ok).toBe(true);
  const payload = await response.json() as { ok?: boolean; runs?: OverrideRun[] };
  expect(payload.ok).toBe(true);
  return Array.isArray(payload.runs) ? payload.runs : [];
}

async function waitForLatestOverrideRun(
  serverPort: number,
  sessionId: string,
  matcher: (run: OverrideRun) => boolean,
): Promise<OverrideRun> {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    const runs = await fetchOverrideRuns(serverPort, sessionId);
    const [latestRun] = runs;
    if (latestRun && matcher(latestRun)) {
      return latestRun;
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }

  throw new Error(`Timed out waiting for a matching override run for session ${sessionId}`);
}

async function expectMcpSeesLiveSession(mcp: MCPClientHandle, sessionId: string): Promise<void> {
  await expect.poll(async () => {
    const sessions = await callToolJson<McpSessionList>(mcp.client, 'list_sessions', { limit: 25 });
    return sessions.sessions.find((session) => session.sessionId === sessionId)?.liveConnection?.connected === true;
  }, { timeout: 10_000 }).toBe(true);

  const health = await callToolJson<LiveSessionHealth>(mcp.client, 'get_live_session_health', { sessionId });
  expect(health.liveConnection?.connected).toBe(true);
}

async function enableOverrideForTabViaMcp(
  mcp: MCPClientHandle,
  sessionId: string,
  targetPage: Page,
  tabId: number,
): Promise<void> {
  if (targetPage.isClosed()) {
    throw new Error('Cannot enable override: target page is already closed');
  }

  const reloadPromise = waitForMainFrameNavigation(targetPage);
  const enableResponse = await callToolJson<OverrideStatus>(mcp.client, 'enable_overrides', { sessionId, tabId });
  expect(enableResponse.active).toBe(true);

  const reloadResult = await reloadPromise;
  if (!reloadResult.navigated) {
    throw new Error(`Target page did not reload after enabling override through MCP: ${reloadResult.error}`);
  }
  await targetPage.waitForLoadState('domcontentloaded');
}

async function expectMcpOverrideRequestLogForUrlStatus(
  mcp: MCPClientHandle,
  sessionId: string,
  urlPart: string,
  status: string,
): Promise<void> {
  await expect.poll(async () => {
    const log = await callToolJson<OverrideRequestLog>(mcp.client, 'get_override_request_log', {
      sessionId,
      limit: 50,
    });
    return log.requests?.some((request) => {
      return request.requestUrl?.includes(urlPart) === true && request.status === status;
    }) === true;
  }, { timeout: 20_000 }).toBe(true);
}

async function expectMcpOverrideRequestLogForUrl(mcp: MCPClientHandle, sessionId: string, urlPart: string): Promise<void> {
  await expectMcpOverrideRequestLogForUrlStatus(mcp, sessionId, urlPart, 'fulfilled');
}

async function expectMcpOverrideRequestLog(mcp: MCPClientHandle, sessionId: string): Promise<void> {
  await expectMcpOverrideRequestLogForUrl(mcp, sessionId, '/_next/static/');
}

async function waitForCaptureSetup(): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
}

function getNextFixtureBuildId(): string {
  return readFileSync(join(NEXT_FIXTURE_ROOT, '.next', 'BUILD_ID'), 'utf8').trim();
}

function getNextDataUrl(baseUrl: string, routePath: string): string {
  const buildId = getNextFixtureBuildId();
  const dataPath = routePath.replace(/^\/+|\/+$/g, '') || 'index';
  return `${baseUrl}/_next/data/${encodeURIComponent(buildId)}/${dataPath}.json`;
}

async function gotoNextDataJson(page: Page, dataUrl: string): Promise<NextDataJsonPayload> {
  const response = await page.goto(dataUrl, { waitUntil: 'domcontentloaded' });
  expect(response?.ok()).toBe(true);
  return await response?.json() as NextDataJsonPayload;
}

function expectNextDataSignal(
  payload: NextDataJsonPayload,
  expected: { mode: string; message: string; badge: string },
): void {
  expect(payload.pageProps?.signal).toMatchObject(expected);
}

async function saveAllowlist(popupPage: Page): Promise<void> {
  await popupPage.fill('#allowlist-domains', '127.0.0.1');
  await popupPage.click('#save-config');
  await expect(popupPage.locator('#config-status')).toContainText(/Settings saved/i);
}

async function startSessionFromTargetTab(popupPage: Page, targetPage: Page): Promise<number> {
  await targetPage.bringToFront();
  const startResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_START' });
  expect(startResponse.ok).toBe(true);
  if (!startResponse.ok) {
    throw new Error(startResponse.error);
  }

  await expect(popupPage.locator('#status')).toContainText(/Session active/i);
  return await getBoundTabId(popupPage);
}

function waitForMainFrameNavigation(targetPage: Page): Promise<{ navigated: true } | { navigated: false; error: string }> {
  return targetPage.waitForEvent('framenavigated', {
    predicate: (frame) => frame === targetPage.mainFrame(),
    timeout: 10_000,
  }).then(
    () => ({ navigated: true }),
    (error: unknown) => ({
      navigated: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

async function enableOverrideForTab(popupPage: Page, targetPage: Page, tabId: number): Promise<void> {
  if (targetPage.isClosed()) {
    throw new Error('Cannot enable override: target page is already closed');
  }

  const reloadPromise = waitForMainFrameNavigation(targetPage);

  const selectResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, {
    type: 'OVERRIDE_POC_SET_TARGET_TAB',
    tabId,
  });
  expect(selectResponse.ok).toBe(true);

  const enableResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, {
    type: 'OVERRIDE_POC_ENABLE',
    tabId,
  });
  expect(enableResponse.ok).toBe(true);

  const reloadResult = await reloadPromise;
  if (!reloadResult.navigated) {
    throw new Error(`Target page did not reload after enabling override: ${reloadResult.error}`);
  }
  await targetPage.waitForLoadState('domcontentloaded');
}

async function stopHarness(
  extension: ExtensionContextHandle | undefined,
  server: ManagedServerProcess | undefined,
  targetApp: ManagedTargetApp | undefined,
  fixture: OverrideFixture | undefined,
): Promise<void> {
  try {
    if (extension) {
      await extension.close();
    }
  } finally {
    try {
      if (server) {
        await server.stop();
      }
    } finally {
      try {
        if (targetApp) {
          await targetApp.stop();
        }
      } finally {
        fixture?.cleanup();
      }
    }
  }
}

async function runNextPageOverrideScenario(scenario: NextPageOverrideScenario): Promise<void> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), `bdmcp-next-${scenario.page}-override-`));
  const configPath = join(fixtureRoot, 'override-poc.local.json');
  const markerPath = join(fixtureRoot, `${scenario.page}-override-marker.js`);
  const sourceSnapshot = snapshotNextFixtureSources();
  let nextApp: ManagedServerProcess | undefined;
  let mcp: MCPClientHandle | undefined;
  let extension: ExtensionContextHandle | undefined;

  try {
    nextApp = await startNextFixtureApp();
    const nextBaseUrl = `http://127.0.0.1:${nextApp.port}`;
    writeNextPageOverrideMarker(markerPath, scenario);

    const mcpPort = await getFreePort();
    mcp = await connectMcpClient(createTempDataDir(`bdmcp-e2e-next-${scenario.page}-data-`), {
      port: mcpPort,
      env: {
        OVERRIDE_POC_CONFIG_PATH: configPath,
      },
    });

    const generated = await callToolJson<GeneratedOverrideProfile>(mcp.client, 'create_override_profile', {
      adapter: 'nextjs',
      projectRoot: NEXT_FIXTURE_ROOT,
      targetBaseUrl: `${nextBaseUrl}/_next/`,
      configPath,
      writeConfig: true,
      overwrite: true,
      enabled: true,
      extensions: ['js'],
    });
    expect(generated.write?.written).toBe(true);
    expect(generated.ruleCount).toBeGreaterThan(0);
    expect(generated.suggestedConfigPath).toBe(configPath);
    pointGeneratedRulesAtMarker(configPath, basename(markerPath));

    const profiles = await callToolJson<{ profiles: Array<{ profileId?: string }> }>(mcp.client, 'list_override_profiles', {});
    const profileId = profiles.profiles[0]?.profileId;
    expect(profileId).toBeTruthy();
    const validation = await callToolJson<{ valid: boolean }>(mcp.client, 'validate_override_profile', { profileId });
    expect(validation.valid).toBe(true);

    extension = await launchExtensionContext();
    await assertExtensionInstalled(extension.context, extension.extensionId);
    await extension.setServerBaseUrl(`http://127.0.0.1:${mcpPort}`);

    const targetPage = await extension.context.newPage();
    await targetPage.goto(`${nextBaseUrl}${scenario.path}`, { waitUntil: 'domcontentloaded' });
    await expect(targetPage.locator(scenario.originalSelector)).toHaveText(scenario.originalText);
    await expect(targetPage.locator(`#${scenario.page}-override-marker`)).toHaveText('original');
    await targetPage.locator(`#${scenario.page}-action`).click();
    await expect(targetPage.locator(`#${scenario.page}-action-status`)).toHaveText(scenario.originalActionText);

    const popupPage = await openExtensionPage(extension.context, extension.extensionId, 'popup.html');
    await saveAllowlist(popupPage);
    const boundTabId = await startSessionFromTargetTab(popupPage, targetPage);
    const sessionId = await getActiveSessionId(popupPage);
    await expectMcpSeesLiveSession(mcp, sessionId);

    const observedAssets = await callToolJson<ObservedOverrideAssets>(mcp.client, 'observe_override_assets', {
      sessionId,
      tabId: boundTabId,
    });
    expect(observedAssets.assets?.some((asset) => asset.url?.includes('/_next/static/') === true)).toBe(true);
    expect(observedAssets.persisted?.persistedCount ?? 0).toBeGreaterThan(0);

    const persistedAssets = await callToolJson<ObservedOverrideAssets>(mcp.client, 'list_observed_override_assets', {
      sessionId,
    });
    expect(persistedAssets.assets?.some((asset) => asset.url?.includes('/_next/static/') === true)).toBe(true);

    const mappedAssets = await callToolJson<NextAssetMapping>(mcp.client, 'map_next_override_assets', {
      sessionId,
      tabId: boundTabId,
      projectRoot: NEXT_FIXTURE_ROOT,
      route: scenario.path,
      sourcePaths: ['src/app/scenario-boot.tsx'],
      fetchProductionAssets: true,
    });
    expect(mappedAssets.candidates?.some((candidate) => {
      return candidate.confidence === 'high'
        && candidate.targetAssetUrl?.includes('/_next/static/') === true
        && candidate.matchedSourcePaths?.includes('src/app/scenario-boot.tsx') === true;
    })).toBe(true);
    expect(mappedAssets.driftSummary?.checked ?? 0).toBeGreaterThan(0);
    expect(mappedAssets.driftSummary?.different ?? 0).toBe(0);

    await enableOverrideForTabViaMcp(mcp, sessionId, targetPage, boundTabId);

    await expect.poll(async () => {
      return await targetPage.evaluate((page) => document.body.dataset[`${page}OverrideMode`] ?? 'missing', scenario.page);
    }).toBe('override');
    await expect(targetPage.locator(`#${scenario.page}-override-marker`)).toHaveText('override');
    await expect(targetPage.locator(scenario.overrideSelector)).toHaveText(scenario.overrideText);
    await targetPage.locator(`#${scenario.page}-action`).click();
    await expect(targetPage.locator(`#${scenario.page}-action-status`)).toHaveText(scenario.overrideActionText);

    await expect.poll(async () => {
      const currentStatus = await callToolJson<OverrideStatus>(mcp.client, 'get_override_status', { sessionId });
      return currentStatus.fulfilledRequests;
    }, { timeout: 10_000 }).toBeGreaterThan(0);

    const status = await callToolJson<OverrideStatus>(mcp.client, 'get_override_status', { sessionId });
    expect(status.active).toBe(true);
    expect(status.configuredEnabled).toBe(true);
    expect(status.matchedRequests).toBeGreaterThan(0);
    expect(status.fulfilledRequests).toBeGreaterThan(0);
    expect(status.lastError).toBeFalsy();
    await expectMcpOverrideRequestLog(mcp, sessionId);

    const diagnosis = await callToolJson<{ diagnosis?: unknown }>(mcp.client, 'diagnose_overrides', { sessionId });
    expect(diagnosis.diagnosis).toBeDefined();

    await callToolJson(mcp.client, 'disable_overrides', { sessionId });
    const stopResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_STOP' });
    expect(stopResponse.ok).toBe(true);
    expectNextFixtureSourcesUnchanged(sourceSnapshot);
  } finally {
    try {
      if (extension) {
        await extension.close();
      }
    } finally {
      try {
        if (mcp) {
          await mcp.close();
        }
      } finally {
        try {
          if (nextApp) {
            await nextApp.stop();
          }
        } finally {
          rmSync(fixtureRoot, { recursive: true, force: true });
        }
      }
    }
  }
}

async function runNextSourcePlannerScenario(): Promise<void> {
  const scenario = NEXT_PAGE_OVERRIDE_SCENARIOS[0];
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'bdmcp-next-source-plan-'));
  const configPath = join(fixtureRoot, 'override-poc.local.json');
  const sourceSnapshot = snapshotNextFixtureSources();
  let nextApp: ManagedServerProcess | undefined;
  let mcp: MCPClientHandle | undefined;
  let extension: ExtensionContextHandle | undefined;

  try {
    nextApp = await startNextFixtureApp();
    const nextBaseUrl = `http://127.0.0.1:${nextApp.port}`;
    const mcpPort = await getFreePort();
    mcp = await connectMcpClient(createTempDataDir('bdmcp-e2e-next-source-plan-data-'), {
      port: mcpPort,
      env: {
        OVERRIDE_POC_CONFIG_PATH: configPath,
      },
    });

    extension = await launchExtensionContext();
    await assertExtensionInstalled(extension.context, extension.extensionId);
    await extension.setServerBaseUrl(`http://127.0.0.1:${mcpPort}`);

    const targetPage = await extension.context.newPage();
    await targetPage.goto(`${nextBaseUrl}${scenario.path}`, { waitUntil: 'domcontentloaded' });
    await expect(targetPage.locator(`#${scenario.page}-override-marker`)).toHaveText('original');
    await targetPage.locator(`#${scenario.page}-action`).click();
    await expect(targetPage.locator(`#${scenario.page}-action-status`)).toHaveText(scenario.originalActionText);

    const popupPage = await openExtensionPage(extension.context, extension.extensionId, 'popup.html');
    await saveAllowlist(popupPage);
    const boundTabId = await startSessionFromTargetTab(popupPage, targetPage);
    const sessionId = await getActiveSessionId(popupPage);
    await expectMcpSeesLiveSession(mcp, sessionId);

    const plannedActionText = 'Planner demo routed from temp source overlay.';
    const plan = await callToolJson<NextSourceOverridePlan>(mcp.client, 'plan_next_source_override', {
      sessionId,
      tabId: boundTabId,
      projectRoot: NEXT_FIXTURE_ROOT,
      route: scenario.path,
      configPath,
      writeConfig: true,
      overwrite: true,
      enabled: true,
      fetchProductionAssets: true,
      profileId: 'next-source-plan-e2e',
      profileName: 'Next source planner e2e',
      sourceEdits: [
        {
          filePath: 'src/app/scenario-boot.tsx',
          search: "document.body.dataset[`${page}OverrideMode`] = 'original';",
          replacement: "document.body.dataset[`${page}OverrideMode`] = 'planned';",
        },
        {
          filePath: 'src/app/scenario-boot.tsx',
          search: "marker.textContent = 'original';",
          replacement: "marker.textContent = 'planned';",
        },
        {
          filePath: 'src/app/scenario-boot.tsx',
          search: "home: 'Original demo queued from Home.',",
          replacement: `home: ${JSON.stringify(plannedActionText)},`,
        },
      ],
    });

    expect(plan.configWritten).toBe(true);
    expect(plan.configPath).toBe(configPath);
    expect(plan.overlayProjectRoot).toBeTruthy();
    expect(plan.blockers ?? []).toHaveLength(0);
    expect(plan.changedAssetCount ?? 0).toBeGreaterThan(0);
    expect(plan.rules?.some((rule) => rule.reason === 'observed_asset_patched_from_source_edit')).toBe(true);

    const validation = await callToolJson<{ valid: boolean }>(mcp.client, 'validate_override_profile', { profileId: 'next-source-plan-e2e' });
    expect(validation.valid).toBe(true);

    await enableOverrideForTabViaMcp(mcp, sessionId, targetPage, boundTabId);

    await expect.poll(async () => {
      return await targetPage.evaluate((page) => document.body.dataset[`${page}OverrideMode`] ?? 'missing', scenario.page);
    }, { timeout: 20_000 }).toBe('planned');
    await expect(targetPage.locator(`#${scenario.page}-override-marker`)).toHaveText('planned');
    await targetPage.locator(`#${scenario.page}-action`).click();
    await expect(targetPage.locator(`#${scenario.page}-action-status`)).toHaveText(plannedActionText);

    const status = await callToolJson<OverrideStatus>(mcp.client, 'get_override_status', { sessionId });
    expect(status.active).toBe(true);
    expect(status.fulfilledRequests).toBeGreaterThanOrEqual(1);
    await expectMcpOverrideRequestLog(mcp, sessionId);

    await callToolJson(mcp.client, 'disable_overrides', { sessionId });
    expectNextFixtureSourcesUnchanged(sourceSnapshot);
  } finally {
    try {
      if (extension) {
        await extension.close();
      }
    } finally {
      try {
        if (mcp) {
          await mcp.close();
        }
      } finally {
        try {
          if (nextApp) {
            await nextApp.stop();
          }
        } finally {
          rmSync(fixtureRoot, { recursive: true, force: true });
        }
      }
    }
  }
}

async function runNextSourcePlannerSriBlockerScenario(): Promise<void> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'bdmcp-next-source-plan-blocker-'));
  const sourceSnapshot = snapshotNextFixtureSources();
  let mcp: MCPClientHandle | undefined;

  try {
    const mcpPort = await getFreePort();
    mcp = await connectMcpClient(createTempDataDir('bdmcp-e2e-next-source-plan-blocker-data-'), {
      port: mcpPort,
      env: {
        OVERRIDE_POC_CONFIG_PATH: join(fixtureRoot, 'override-poc.local.json'),
      },
    });

    const mapped = await callToolJson<NextAssetMapping>(mcp.client, 'map_next_override_assets', {
      projectRoot: NEXT_FIXTURE_ROOT,
      observedAssets: listNextFixtureObservedChunkAssets(),
      sourcePaths: ['src/app/scenario-boot.tsx'],
    });

    const sriCandidate = mapped.candidates?.find((candidate) => candidate.targetAssetUrl?.includes('/_next/static/') === true);
    expect(sriCandidate?.targetAssetUrl).toBeTruthy();

    const plan = await callToolJson<NextSourceOverridePlan>(mcp.client, 'plan_next_source_override', {
      projectRoot: NEXT_FIXTURE_ROOT,
      observedAssets: [{
        url: sriCandidate?.targetAssetUrl,
        kind: 'script',
        integrity: 'sha384-placeholder',
        fromDom: true,
      }],
      sourceEdits: [{
        filePath: 'src/app/scenario-boot.tsx',
        search: "marker.textContent = 'original';",
        replacement: "marker.textContent = 'planned';",
      }],
    });

    expect(plan.blockers?.some((blocker) => blocker.includes('SRI_PRESENT'))).toBe(true);
    expect(plan.rules ?? []).toHaveLength(0);
    expectNextFixtureSourcesUnchanged(sourceSnapshot);
  } finally {
    try {
      if (mcp) {
        await mcp.close();
      }
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }
}

async function runNextApiResponseOverrideScenario(): Promise<void> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'bdmcp-next-api-response-'));
  const configPath = join(fixtureRoot, 'override-poc.local.json');
  const sourceSnapshot = snapshotNextFixtureSources();
  let nextApp: ManagedServerProcess | undefined;
  let mcp: MCPClientHandle | undefined;
  let extension: ExtensionContextHandle | undefined;

  try {
    nextApp = await startNextFixtureApp();
    const nextBaseUrl = `http://127.0.0.1:${nextApp.port}`;
    const apiUrl = `${nextBaseUrl}/api/override-signal`;
    const mcpPort = await getFreePort();
    mcp = await connectMcpClient(createTempDataDir('bdmcp-e2e-next-api-response-data-'), {
      port: mcpPort,
      env: {
        OVERRIDE_POC_CONFIG_PATH: configPath,
      },
    });

    extension = await launchExtensionContext();
    await assertExtensionInstalled(extension.context, extension.extensionId);
    await extension.setServerBaseUrl(`http://127.0.0.1:${mcpPort}`);

    const targetPage = await extension.context.newPage();
    await targetPage.goto(`${nextBaseUrl}/`, { waitUntil: 'domcontentloaded' });
    await expect(targetPage.locator('#next-api-mode')).toHaveText('original-api');
    await expect(targetPage.locator('#next-api-message')).toHaveText('Original API response from Next route.');
    await expect(targetPage.locator('#next-api-badge')).toHaveText('stable');

    const popupPage = await openExtensionPage(extension.context, extension.extensionId, 'popup.html');
    await saveAllowlist(popupPage);
    const boundTabId = await startSessionFromTargetTab(popupPage, targetPage);
    const sessionId = await getActiveSessionId(popupPage);
    await expectMcpSeesLiveSession(mcp, sessionId);

    const observedAssets = await callToolJson<ObservedOverrideAssets>(mcp.client, 'observe_override_assets', {
      sessionId,
      tabId: boundTabId,
    });
    expect(observedAssets.assets?.some((asset) => asset.url?.includes('/api/override-signal') === true)).toBe(true);

    const capture = await callToolJson<OverrideResponseCaptureResult>(mcp.client, 'capture_override_response_body', {
      sessionId,
      tabId: boundTabId,
      targetUrl: apiUrl,
      captureMode: 'cdp-response',
      triggerReload: true,
      includeBody: true,
      timeoutMs: 15_000,
    });
    expect(capture).toMatchObject({
      captureMode: 'cdp-response',
      source: 'cdp-response',
      tabId: boundTabId,
      ruleType: 'api-response',
      bodyCaptured: true,
      truncated: false,
    });
    expect(capture.bodyText).toContain('"mode":"original-api"');
    await targetPage.waitForLoadState('domcontentloaded');
    await expect(targetPage.locator('#next-api-mode')).toHaveText('original-api');

    const plan = await callToolJson<OverrideResponsePatchPlan>(mcp.client, 'plan_override_response_patch', {
      sessionId,
      tabId: boundTabId,
      targetUrl: apiUrl,
      captureMode: 'cdp-response',
      triggerReload: true,
      timeoutMs: 15_000,
      jsonPatches: [
        { path: '/mode', value: 'override-api', expectedValue: 'original-api' },
        { path: '/message', value: 'Override API response from browser override.' },
        { path: '/badge', value: 'override', expectedValue: 'stable' },
      ],
      configPath,
      writeConfig: true,
      overwrite: true,
      profileId: 'next-api-response-e2e',
      profileName: 'Next API response override e2e',
    });
    expect(plan.configWritten).toBe(true);
    expect(plan.capturedFromLiveSession).toMatchObject({
      captureMode: 'cdp-response',
      source: 'cdp-response',
      tabId: boundTabId,
    });
    expect(plan.rule).toMatchObject({
      ruleType: 'api-response',
      targetAssetUrl: apiUrl,
    });

    const validation = await callToolJson<{ valid: boolean }>(mcp.client, 'validate_override_profile', {
      profileId: 'next-api-response-e2e',
    });
    expect(validation.valid).toBe(true);

    await enableOverrideForTabViaMcp(mcp, sessionId, targetPage, boundTabId);
    await expect(targetPage.locator('#next-api-mode')).toHaveText('override-api');
    await expect(targetPage.locator('#next-api-message')).toHaveText('Override API response from browser override.');
    await expect(targetPage.locator('#next-api-badge')).toHaveText('override');

    const status = await callToolJson<OverrideStatus>(mcp.client, 'get_override_status', { sessionId });
    expect(status.active).toBe(true);
    expect(status.fulfilledRequests).toBeGreaterThanOrEqual(1);
    expect(status.lastError).toBeFalsy();
    await expectMcpOverrideRequestLogForUrl(mcp, sessionId, '/api/override-signal');

    await callToolJson(mcp.client, 'disable_overrides', { sessionId });
    const stopResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_STOP' });
    expect(stopResponse.ok).toBe(true);
    expectNextFixtureSourcesUnchanged(sourceSnapshot);
  } finally {
    try {
      if (extension) {
        await extension.close();
      }
    } finally {
      try {
        if (mcp) {
          await mcp.close();
        }
      } finally {
        try {
          if (nextApp) {
            await nextApp.stop();
          }
        } finally {
          rmSync(fixtureRoot, { recursive: true, force: true });
        }
      }
    }
  }
}

async function runNextDataResponseOverrideScenario(): Promise<void> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'bdmcp-next-data-response-'));
  const configPath = join(fixtureRoot, 'override-poc.local.json');
  const sourceSnapshot = snapshotNextFixtureSources();
  let nextApp: ManagedServerProcess | undefined;
  let mcp: MCPClientHandle | undefined;
  let extension: ExtensionContextHandle | undefined;

  try {
    nextApp = await startNextFixtureApp();
    const nextBaseUrl = `http://127.0.0.1:${nextApp.port}`;
    const dataUrl = getNextDataUrl(nextBaseUrl, '/legacy-data');
    const siblingDataUrl = getNextDataUrl(nextBaseUrl, '/legacy-other');
    const mcpPort = await getFreePort();
    mcp = await connectMcpClient(createTempDataDir('bdmcp-e2e-next-data-response-data-'), {
      port: mcpPort,
      env: {
        OVERRIDE_POC_CONFIG_PATH: configPath,
      },
    });

    extension = await launchExtensionContext();
    await assertExtensionInstalled(extension.context, extension.extensionId);
    await extension.setServerBaseUrl(`http://127.0.0.1:${mcpPort}`);

    const targetPage = await extension.context.newPage();
    await targetPage.goto(`${nextBaseUrl}/legacy-data`, { waitUntil: 'domcontentloaded' });
    await expect(targetPage.locator('#legacy-data-mode')).toHaveText('original-next-data');
    await expect(targetPage.locator('#legacy-data-message')).toHaveText('Original Next data response from Pages Router.');
    await expect(targetPage.locator('#legacy-data-badge')).toHaveText('pages-stable');

    const popupPage = await openExtensionPage(extension.context, extension.extensionId, 'popup.html');
    await saveAllowlist(popupPage);
    const boundTabId = await startSessionFromTargetTab(popupPage, targetPage);
    const sessionId = await getActiveSessionId(popupPage);
    await expectMcpSeesLiveSession(mcp, sessionId);

    const originalData = await gotoNextDataJson(targetPage, dataUrl);
    expectNextDataSignal(originalData, {
      mode: 'original-next-data',
      message: 'Original Next data response from Pages Router.',
      badge: 'pages-stable',
    });

    const capture = await callToolJson<OverrideResponseCaptureResult>(mcp.client, 'capture_override_response_body', {
      sessionId,
      tabId: boundTabId,
      targetUrl: dataUrl,
      captureMode: 'cdp-response',
      triggerReload: true,
      includeBody: true,
      timeoutMs: 15_000,
    });
    expect(capture).toMatchObject({
      captureMode: 'cdp-response',
      source: 'cdp-response',
      tabId: boundTabId,
      ruleType: 'next-data',
      bodyCaptured: true,
      truncated: false,
    });
    expect(capture.bodyText).toContain('"mode":"original-next-data"');

    const plan = await callToolJson<OverrideResponsePatchPlan>(mcp.client, 'plan_override_response_patch', {
      sessionId,
      tabId: boundTabId,
      targetUrl: dataUrl,
      captureMode: 'cdp-response',
      triggerReload: true,
      timeoutMs: 15_000,
      jsonPatches: [
        { path: '/pageProps/signal/mode', value: 'override-next-data', expectedValue: 'original-next-data' },
        { path: '/pageProps/signal/message', value: 'Override Next data response from browser override.' },
        { path: '/pageProps/signal/badge', value: 'data-override', expectedValue: 'pages-stable' },
      ],
      configPath,
      writeConfig: true,
      overwrite: true,
      profileId: 'next-data-response-e2e',
      profileName: 'Next data response override e2e',
    });
    expect(plan.configWritten).toBe(true);
    expect(plan.capturedFromLiveSession).toMatchObject({
      captureMode: 'cdp-response',
      source: 'cdp-response',
      tabId: boundTabId,
    });
    expect(plan.rule).toMatchObject({
      ruleType: 'next-data',
      targetAssetUrl: dataUrl,
    });
    expect(plan.audit?.persisted).toBe(true);
    const planAuditId = plan.audit?.plans?.[0]?.planId;
    expect(planAuditId).toBeTruthy();

    const planLog = await callToolJson<OverridePlanLog>(mcp.client, 'get_override_plan_log', {
      sessionId,
      planId: planAuditId,
    });
    expect(planLog.plans).toHaveLength(1);
    expect(planLog.plans?.[0]).toMatchObject({
      planId: planAuditId,
      plannerKind: 'response-patch',
      ruleType: 'next-data',
      targetAssetUrl: dataUrl,
      patchedSha256: plan.patchedSha256,
      patchSummary: {
        jsonPatches: expect.any(Array),
      },
      rollback: {
        disableTool: 'disable_overrides',
        configPath,
        generatedFiles: [plan.rule?.localFilePath],
      },
    });

    const validation = await callToolJson<{ valid: boolean }>(mcp.client, 'validate_override_profile', {
      profileId: 'next-data-response-e2e',
    });
    expect(validation.valid).toBe(true);

    await enableOverrideForTabViaMcp(mcp, sessionId, targetPage, boundTabId);
    const patchedData = JSON.parse(await targetPage.locator('body').innerText()) as NextDataJsonPayload;
    expectNextDataSignal(patchedData, {
      mode: 'override-next-data',
      message: 'Override Next data response from browser override.',
      badge: 'data-override',
    });

    const siblingData = await gotoNextDataJson(targetPage, siblingDataUrl);
    expectNextDataSignal(siblingData, {
      mode: 'original-next-data-sibling',
      message: 'Original sibling Next data response.',
      badge: 'sibling-stable',
    });

    const status = await callToolJson<OverrideStatus>(mcp.client, 'get_override_status', { sessionId });
    expect(status.active).toBe(true);
    expect(status.fulfilledRequests).toBeGreaterThanOrEqual(1);
    expect(status.lastError).toBeFalsy();
    await expectMcpOverrideRequestLogForUrl(mcp, sessionId, '/_next/data/');

    await callToolJson(mcp.client, 'disable_overrides', { sessionId });
    const stopResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_STOP' });
    expect(stopResponse.ok).toBe(true);
    expectNextFixtureSourcesUnchanged(sourceSnapshot);
  } finally {
    try {
      if (extension) {
        await extension.close();
      }
    } finally {
      try {
        if (mcp) {
          await mcp.close();
        }
      } finally {
        if (nextApp) {
          await nextApp.stop();
        }
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    }
  }
}

async function runNextLegacyDocumentRewriteScenario(): Promise<void> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'bdmcp-next-legacy-document-'));
  const configPath = join(fixtureRoot, 'override-poc.local.json');
  const sourceSnapshot = snapshotNextFixtureSources();
  let nextApp: ManagedServerProcess | undefined;
  let mcp: MCPClientHandle | undefined;
  let extension: ExtensionContextHandle | undefined;

  try {
    nextApp = await startNextFixtureApp();
    const nextBaseUrl = `http://127.0.0.1:${nextApp.port}`;
    const targetUrl = `${nextBaseUrl}/legacy-data`;
    const siblingUrl = `${nextBaseUrl}/legacy-other`;
    const mcpPort = await getFreePort();
    mcp = await connectMcpClient(createTempDataDir('bdmcp-e2e-next-legacy-document-data-'), {
      port: mcpPort,
      env: {
        OVERRIDE_POC_CONFIG_PATH: configPath,
      },
    });

    extension = await launchExtensionContext();
    await assertExtensionInstalled(extension.context, extension.extensionId);
    await extension.setServerBaseUrl(`http://127.0.0.1:${mcpPort}`);

    const targetPage = await extension.context.newPage();
    await targetPage.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await expect(targetPage.locator('#legacy-data-mode')).toHaveText('original-next-data');
    await expect(targetPage.locator('#legacy-data-message')).toHaveText('Original Next data response from Pages Router.');
    await expect(targetPage.locator('#legacy-data-badge')).toHaveText('pages-stable');

    const popupPage = await openExtensionPage(extension.context, extension.extensionId, 'popup.html');
    await saveAllowlist(popupPage);
    const boundTabId = await startSessionFromTargetTab(popupPage, targetPage);
    const sessionId = await getActiveSessionId(popupPage);
    await expectMcpSeesLiveSession(mcp, sessionId);

    const capture = await callToolJson<OverrideResponseCaptureResult>(mcp.client, 'capture_override_response_body', {
      sessionId,
      tabId: boundTabId,
      targetUrl,
      captureMode: 'cdp-response',
      triggerReload: true,
      includeBody: true,
      timeoutMs: 15_000,
    });
    expect(capture).toMatchObject({
      captureMode: 'cdp-response',
      source: 'cdp-response',
      tabId: boundTabId,
      ruleType: 'document',
      bodyCaptured: true,
      truncated: false,
    });
    expect(capture.bodyText).toContain('__NEXT_DATA__');

    const plan = await callToolJson<OverrideResponsePatchPlan>(mcp.client, 'plan_override_response_patch', {
      sessionId,
      tabId: boundTabId,
      targetUrl,
      captureMode: 'cdp-response',
      triggerReload: true,
      timeoutMs: 15_000,
      documentPatches: [
        {
          operation: 'replaceJsonValue',
          selector: '#__NEXT_DATA__',
          path: '/props/pageProps/signal/mode',
          value: 'override-next-document',
          expectedValue: 'original-next-data',
        },
        {
          operation: 'replaceJsonValue',
          selector: '#__NEXT_DATA__',
          path: '/props/pageProps/signal/message',
          value: 'Document override from __NEXT_DATA__ patch.',
          expectedValue: 'Original Next data response from Pages Router.',
        },
        {
          operation: 'replaceJsonValue',
          selector: '#__NEXT_DATA__',
          path: '/props/pageProps/signal/badge',
          value: 'document-bootstrap',
          expectedValue: 'pages-stable',
        },
      ],
      configPath,
      writeConfig: true,
      overwrite: true,
      profileId: 'next-legacy-document-e2e',
      profileName: 'Next legacy document rewrite e2e',
    });
    expect(plan.configWritten).toBe(true);
    expect(plan.rule).toMatchObject({
      ruleType: 'document',
      targetAssetUrl: targetUrl,
    });
    expect(plan.audit?.persisted).toBe(true);

    const planLog = await callToolJson<OverridePlanLog>(mcp.client, 'get_override_plan_log', {
      sessionId,
      planId: plan.audit?.plans?.[0]?.planId,
    });
    expect(planLog.plans?.[0]).toMatchObject({
      ruleType: 'document',
      targetAssetUrl: targetUrl,
      patchSummary: {
        documentPatches: expect.any(Array),
      },
    });

    const validation = await callToolJson<{ valid: boolean }>(mcp.client, 'validate_override_profile', {
      profileId: 'next-legacy-document-e2e',
    });
    expect(validation.valid).toBe(true);

    await enableOverrideForTabViaMcp(mcp, sessionId, targetPage, boundTabId);
    await expect(targetPage.locator('#legacy-data-mode')).toHaveText('override-next-document');
    await expect(targetPage.locator('#legacy-data-message')).toHaveText('Document override from __NEXT_DATA__ patch.');
    await expect(targetPage.locator('#legacy-data-badge')).toHaveText('document-bootstrap');

    await targetPage.goto(siblingUrl, { waitUntil: 'domcontentloaded' });
    await expect(targetPage.locator('#legacy-other-mode')).toHaveText('original-next-data-sibling');
    await expect(targetPage.locator('#legacy-other-message')).toHaveText('Original sibling Next data response.');
    await expect(targetPage.locator('#legacy-other-badge')).toHaveText('sibling-stable');

    const status = await callToolJson<OverrideStatus>(mcp.client, 'get_override_status', { sessionId });
    expect(status.active).toBe(true);
    expect(status.fulfilledRequests).toBeGreaterThanOrEqual(1);
    expect(status.lastError).toBeFalsy();
    await expectMcpOverrideRequestLogForUrl(mcp, sessionId, '/legacy-data');

    await callToolJson(mcp.client, 'disable_overrides', { sessionId });
    const stopResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_STOP' });
    expect(stopResponse.ok).toBe(true);
    expectNextFixtureSourcesUnchanged(sourceSnapshot);
  } finally {
    try {
      if (extension) {
        await extension.close();
      }
    } finally {
      try {
        if (mcp) {
          await mcp.close();
        }
      } finally {
        if (nextApp) {
          await nextApp.stop();
        }
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    }
  }
}

async function runNextRscFlightOverrideScenario(): Promise<void> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'bdmcp-next-rsc-response-'));
  const configPath = join(fixtureRoot, 'override-poc.local.json');
  const sourceSnapshot = snapshotNextFixtureSources();
  let nextApp: ManagedServerProcess | undefined;
  let mcp: MCPClientHandle | undefined;
  let extension: ExtensionContextHandle | undefined;

  try {
    nextApp = await startNextFixtureApp();
    const nextBaseUrl = `http://127.0.0.1:${nextApp.port}`;
    const aboutRscPrefix = `${nextBaseUrl}/about?_rsc=`;
    const productsRscPrefix = `${nextBaseUrl}/products?_rsc=`;
    const mcpPort = await getFreePort();
    mcp = await connectMcpClient(createTempDataDir('bdmcp-e2e-next-rsc-response-data-'), {
      port: mcpPort,
      env: {
        OVERRIDE_POC_CONFIG_PATH: configPath,
      },
    });

    extension = await launchExtensionContext();
    await assertExtensionInstalled(extension.context, extension.extensionId);
    await extension.setServerBaseUrl(`http://127.0.0.1:${mcpPort}`);

    const targetPage = await extension.context.newPage();
    await targetPage.goto(`${nextBaseUrl}/`, { waitUntil: 'networkidle' });
    await expect(targetPage.locator('#home-headline')).toHaveText('Original launch desk for field teams');

    const popupPage = await openExtensionPage(extension.context, extension.extensionId, 'popup.html');
    await saveAllowlist(popupPage);
    const boundTabId = await startSessionFromTargetTab(popupPage, targetPage);
    const sessionId = await getActiveSessionId(popupPage);
    await expectMcpSeesLiveSession(mcp, sessionId);

    const capturePromise = callToolJson<OverrideResponseCaptureResult>(mcp.client, 'capture_override_response_body', {
      sessionId,
      tabId: boundTabId,
      targetUrl: aboutRscPrefix,
      matchMode: 'prefix',
      captureMode: 'cdp-response',
      includeBody: true,
      timeoutMs: 15_000,
    });
    await waitForCaptureSetup();
    await targetPage.click('nav a[href="/about"]');
    const capture = await capturePromise;
    await expect(targetPage.locator('#about-proof')).toHaveText('Original proof: 42 inspection notes reviewed by humans.');
    expect(capture).toMatchObject({
      captureMode: 'cdp-response',
      matchMode: 'prefix',
      source: 'cdp-response',
      tabId: boundTabId,
      ruleType: 'rsc-flight',
      bodyCaptured: true,
      truncated: false,
    });
    expect(capture.finalUrl).toContain('/about?_rsc=');
    expect(capture.bodyText).toContain('Original proof: 42 inspection notes reviewed by humans.');

    const observedAssets = await callToolJson<ObservedOverrideAssets>(mcp.client, 'observe_override_assets', {
      sessionId,
      tabId: boundTabId,
    });
    expect(observedAssets.assets?.some((asset) => asset.url?.includes('/about?_rsc=') === true)).toBe(true);

    await targetPage.goto(`${nextBaseUrl}/`, { waitUntil: 'networkidle' });
    const planPromise = callToolJson<OverrideResponsePatchPlan>(mcp.client, 'plan_override_response_patch', {
      sessionId,
      tabId: boundTabId,
      targetUrl: productsRscPrefix,
      matchMode: 'prefix',
      captureMode: 'cdp-response',
      timeoutMs: 15_000,
      textPatches: [
        { search: 'Original debugging kits', replacement: 'Override debugging kits', expectedCount: 1 },
        { search: '$129', replacement: '$049', expectedCount: 1 },
      ],
      configPath,
      writeConfig: true,
      overwrite: true,
      profileId: 'next-rsc-response-e2e',
      profileName: 'Next RSC response override e2e',
    });
    await waitForCaptureSetup();
    await targetPage.click('nav a[href="/products"]');
    const plan = await planPromise;
    expect(plan.ruleType).toBe('rsc-flight');
    expect(plan.matchMode).toBe('prefix');
    expect(plan.configWritten).toBe(true);
    expect(plan.localFilePath).toBeTruthy();
    expect(plan.rule).toMatchObject({
      ruleType: 'rsc-flight',
      matchMode: 'prefix',
      rscFlight: {
        productionMode: 'structured-flight-v1',
        source: 'cdp-response',
        patchKind: 'string-value-text',
      },
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.capturedFromLiveSession).toMatchObject({
      captureMode: 'cdp-response',
      matchMode: 'prefix',
      source: 'cdp-response',
      tabId: boundTabId,
    });

    const validation = await callToolJson<{ valid: boolean; issues?: Array<{ code?: string; severity?: string }> }>(mcp.client, 'validate_override_profile', {
      profileId: 'next-rsc-response-e2e',
    });
    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([]);

    const stopCaptureSessionResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_STOP' });
    expect(stopCaptureSessionResponse.ok).toBe(true);
    await targetPage.close();

    const overridePage = await extension.context.newPage();
    await overridePage.goto(`${nextBaseUrl}/`, { waitUntil: 'networkidle' });
    await expect(overridePage.locator('#home-headline')).toHaveText('Original launch desk for field teams');
    const overrideTabId = await startSessionFromTargetTab(popupPage, overridePage);
    const overrideSessionId = await getActiveSessionId(popupPage);
    await expectMcpSeesLiveSession(mcp, overrideSessionId);

    await enableOverrideForTabViaMcp(mcp, overrideSessionId, overridePage, overrideTabId);
    await expect(overridePage.locator('#home-headline')).toHaveText('Original launch desk for field teams');
    await overridePage.click('nav a[href="/products"]');
    await expect.poll(async () => {
      const status = await callToolJson<OverrideStatus>(mcp.client, 'get_override_status', { sessionId: overrideSessionId });
      if (status.lastError) {
        return status.lastError;
      }
      return status.fulfilledRequests >= 1 ? 'fulfilled' : `fulfilled:${status.fulfilledRequests}`;
    }, { timeout: 10_000 }).toBe('fulfilled');
    await expect(overridePage.locator('#products-headline')).toHaveText('Override debugging kits');
    await expect(overridePage.locator('#products-price')).toHaveText('$049');

    const status = await callToolJson<OverrideStatus>(mcp.client, 'get_override_status', { sessionId: overrideSessionId });
    expect(status.active).toBe(true);
    expect(status.matchedRequests).toBeGreaterThanOrEqual(1);
    expect(status.fulfilledRequests).toBeGreaterThanOrEqual(1);
    expect(status.lastError).toBeFalsy();
    await expectMcpOverrideRequestLogForUrl(mcp, overrideSessionId, '/products?_rsc=');

    await callToolJson(mcp.client, 'disable_overrides', { sessionId: overrideSessionId });
    const stopResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_STOP' });
    expect(stopResponse.ok).toBe(true);
    expectNextFixtureSourcesUnchanged(sourceSnapshot);
  } finally {
    try {
      if (extension) {
        await extension.close();
      }
    } finally {
      try {
        if (mcp) {
          await mcp.close();
        }
      } finally {
        try {
          if (nextApp) {
            await nextApp.stop();
          }
        } finally {
          rmSync(fixtureRoot, { recursive: true, force: true });
        }
      }
    }
  }
}

async function runNextRscDynamicRouteMatrixScenario(): Promise<void> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'bdmcp-next-rsc-dynamic-'));
  const configPath = join(fixtureRoot, 'override-poc.local.json');
  const sourceSnapshot = snapshotNextFixtureSources();
  let nextApp: ManagedServerProcess | undefined;
  let mcp: MCPClientHandle | undefined;
  let extension: ExtensionContextHandle | undefined;

  try {
    nextApp = await startNextFixtureApp();
    const nextBaseUrl = `http://127.0.0.1:${nextApp.port}`;
    const alphaRscPrefix = `${nextBaseUrl}/rsc-lab/alpha?_rsc=`;
    const mcpPort = await getFreePort();
    mcp = await connectMcpClient(createTempDataDir('bdmcp-e2e-next-rsc-dynamic-data-'), {
      port: mcpPort,
      env: {
        OVERRIDE_POC_CONFIG_PATH: configPath,
      },
    });

    extension = await launchExtensionContext();
    await assertExtensionInstalled(extension.context, extension.extensionId);
    await extension.setServerBaseUrl(`http://127.0.0.1:${mcpPort}`);

    const targetPage = await extension.context.newPage();
    await targetPage.goto(`${nextBaseUrl}/`, { waitUntil: 'networkidle' });
    await expect(targetPage.locator('#home-headline')).toHaveText('Original launch desk for field teams');

    const popupPage = await openExtensionPage(extension.context, extension.extensionId, 'popup.html');
    await saveAllowlist(popupPage);
    const boundTabId = await startSessionFromTargetTab(popupPage, targetPage);
    const sessionId = await getActiveSessionId(popupPage);
    await expectMcpSeesLiveSession(mcp, sessionId);

    const planPromise = callToolJson<OverrideResponsePatchPlan>(mcp.client, 'plan_override_response_patch', {
      sessionId,
      tabId: boundTabId,
      targetUrl: alphaRscPrefix,
      matchMode: 'prefix',
      captureMode: 'cdp-response',
      timeoutMs: 15_000,
      textPatches: [
        { search: 'Original alpha deployment', replacement: 'Override alpha deployment', expectedCount: 1 },
        {
          search: 'Original alpha route detail: nested layout context stayed stable.',
          replacement: 'Override alpha route detail: nested layout context stayed stable.',
          expectedCount: 1,
        },
        {
          search: 'Original client prop from alpha server data.',
          replacement: 'Override client prop from alpha server data.',
          expectedCount: 1,
        },
        { search: 'Original alpha suspense payload', replacement: 'Override alpha suspense payload', expectedCount: 1 },
      ],
      configPath,
      writeConfig: true,
      overwrite: true,
      profileId: 'next-rsc-dynamic-e2e',
      profileName: 'Next RSC dynamic route override e2e',
    });
    await waitForCaptureSetup();
    await targetPage.click('#nav-rsc-lab');
    await expect(targetPage.locator('#rsc-dynamic-title')).toHaveText('Original alpha deployment');
    await expect(targetPage.locator('#rsc-lab-shell')).toHaveText('Original nested RSC shell');
    const plan = await planPromise;
    expect(plan.ruleType).toBe('rsc-flight');
    expect(plan.configWritten).toBe(true);
    expect(plan.blockers).toEqual([]);

    const validation = await callToolJson<{ valid: boolean; issues?: Array<{ code?: string; severity?: string }> }>(mcp.client, 'validate_override_profile', {
      profileId: 'next-rsc-dynamic-e2e',
    });
    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([]);

    await targetPage.goto(`${nextBaseUrl}/`, { waitUntil: 'networkidle' });
    await enableOverrideForTabViaMcp(mcp, sessionId, targetPage, boundTabId);
    await expect(targetPage.locator('#home-headline')).toHaveText('Original launch desk for field teams');

    await targetPage.click('#nav-rsc-lab');
    await expect.poll(async () => {
      const status = await callToolJson<OverrideStatus>(mcp.client, 'get_override_status', { sessionId });
      if (status.lastError) {
        return status.lastError;
      }
      return status.fulfilledRequests >= 1 ? 'fulfilled' : `fulfilled:${status.fulfilledRequests}`;
    }, { timeout: 10_000 }).toBe('fulfilled');
    await expect(targetPage.locator('#rsc-dynamic-title')).toHaveText('Override alpha deployment');
    await expect(targetPage.locator('#rsc-dynamic-detail')).toHaveText('Override alpha route detail: nested layout context stayed stable.');
    await expect(targetPage.locator('#rsc-client-prop')).toHaveText('Override client prop from alpha server data.');
    await expect(targetPage.locator('#rsc-suspense-value')).toHaveText('Override alpha suspense payload');

    await targetPage.goBack();
    await expect(targetPage.locator('#home-headline')).toHaveText('Original launch desk for field teams');
    await targetPage.goForward();
    await expect(targetPage.locator('#rsc-dynamic-title')).toHaveText('Override alpha deployment');

    await targetPage.click('#rsc-bravo-link');
    await expect(targetPage.locator('#rsc-dynamic-title')).toHaveText('Original bravo deployment');
    await expect(targetPage.locator('#rsc-client-prop')).toHaveText('Original client prop from bravo server data.');
    await expect(targetPage.locator('#rsc-suspense-value')).toHaveText('Original bravo suspense payload');

    const status = await callToolJson<OverrideStatus>(mcp.client, 'get_override_status', { sessionId });
    expect(status.active).toBe(true);
    expect(status.fulfilledRequests).toBeGreaterThanOrEqual(1);
    expect(status.lastError).toBeFalsy();
    await expectMcpOverrideRequestLogForUrl(mcp, sessionId, '/rsc-lab/alpha?_rsc=');

    await callToolJson(mcp.client, 'disable_overrides', { sessionId });
    const stopResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_STOP' });
    expect(stopResponse.ok).toBe(true);
    expectNextFixtureSourcesUnchanged(sourceSnapshot);
  } finally {
    try {
      if (extension) {
        await extension.close();
      }
    } finally {
      try {
        if (mcp) {
          await mcp.close();
        }
      } finally {
        try {
          if (nextApp) {
            await nextApp.stop();
          }
        } finally {
          rmSync(fixtureRoot, { recursive: true, force: true });
        }
      }
    }
  }
}

async function runNextRscSearchParamScenario(): Promise<void> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'bdmcp-next-rsc-search-'));
  const configPath = join(fixtureRoot, 'override-poc.local.json');
  const sourceSnapshot = snapshotNextFixtureSources();
  let nextApp: ManagedServerProcess | undefined;
  let mcp: MCPClientHandle | undefined;
  let extension: ExtensionContextHandle | undefined;

  try {
    nextApp = await startNextFixtureApp();
    const nextBaseUrl = `http://127.0.0.1:${nextApp.port}`;
    const searchRscPrefix = `${nextBaseUrl}/rsc-lab/search?mode=calm&_rsc=`;
    const mcpPort = await getFreePort();
    mcp = await connectMcpClient(createTempDataDir('bdmcp-e2e-next-rsc-search-data-'), {
      port: mcpPort,
      env: {
        OVERRIDE_POC_CONFIG_PATH: configPath,
      },
    });

    extension = await launchExtensionContext();
    await assertExtensionInstalled(extension.context, extension.extensionId);
    await extension.setServerBaseUrl(`http://127.0.0.1:${mcpPort}`);

    const targetPage = await extension.context.newPage();
    await targetPage.goto(`${nextBaseUrl}/rsc-lab/alpha`, { waitUntil: 'networkidle' });
    await expect(targetPage.locator('#rsc-dynamic-title')).toHaveText('Original alpha deployment');

    const popupPage = await openExtensionPage(extension.context, extension.extensionId, 'popup.html');
    await saveAllowlist(popupPage);
    const boundTabId = await startSessionFromTargetTab(popupPage, targetPage);
    const sessionId = await getActiveSessionId(popupPage);
    await expectMcpSeesLiveSession(mcp, sessionId);

    const planPromise = callToolJson<OverrideResponsePatchPlan>(mcp.client, 'plan_override_response_patch', {
      sessionId,
      tabId: boundTabId,
      targetUrl: searchRscPrefix,
      matchMode: 'prefix',
      captureMode: 'cdp-response',
      timeoutMs: 15_000,
      textPatches: [
        { search: 'Original search-param RSC panel', replacement: 'Override search-param RSC panel', expectedCount: 1 },
        { search: 'Original filter: calm', replacement: 'Override filter: calm', expectedCount: 1 },
        { search: 'Original search client prop: calm', replacement: 'Override search client prop: calm', expectedCount: 1 },
      ],
      configPath,
      writeConfig: true,
      overwrite: true,
      profileId: 'next-rsc-search-e2e',
      profileName: 'Next RSC search param override e2e',
    });
    await waitForCaptureSetup();
    await targetPage.click('#rsc-search-link');
    await expect(targetPage.locator('#rsc-search-summary')).toHaveText('Original filter: calm');
    const plan = await planPromise;
    expect(plan.ruleType).toBe('rsc-flight');
    expect(plan.configWritten).toBe(true);
    expect(plan.blockers).toEqual([]);

    const validation = await callToolJson<{ valid: boolean; issues?: Array<{ code?: string; severity?: string }> }>(mcp.client, 'validate_override_profile', {
      profileId: 'next-rsc-search-e2e',
    });
    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([]);

    await targetPage.goto(`${nextBaseUrl}/rsc-lab/alpha`, { waitUntil: 'networkidle' });
    await enableOverrideForTabViaMcp(mcp, sessionId, targetPage, boundTabId);
    await expect(targetPage.locator('#rsc-dynamic-title')).toHaveText('Original alpha deployment');

    await targetPage.click('#rsc-search-link');
    await expect.poll(async () => {
      const status = await callToolJson<OverrideStatus>(mcp.client, 'get_override_status', { sessionId });
      if (status.lastError) {
        return status.lastError;
      }
      return status.fulfilledRequests >= 1 ? 'fulfilled' : `fulfilled:${status.fulfilledRequests}`;
    }, { timeout: 10_000 }).toBe('fulfilled');
    await expect(targetPage.locator('#rsc-search-title')).toHaveText('Override search-param RSC panel');
    await expect(targetPage.locator('#rsc-search-summary')).toHaveText('Override filter: calm');
    await expect(targetPage.locator('#rsc-client-prop')).toHaveText('Override search client prop: calm');

    await targetPage.click('#rsc-search-loud-link');
    await expect(targetPage.locator('#rsc-search-title')).toHaveText('Original search-param RSC panel');
    await expect(targetPage.locator('#rsc-search-summary')).toHaveText('Original filter: loud');
    await expect(targetPage.locator('#rsc-client-prop')).toHaveText('Original search client prop: loud');
    await expectMcpOverrideRequestLogForUrl(mcp, sessionId, '/rsc-lab/search?mode=calm&_rsc=');

    await callToolJson(mcp.client, 'disable_overrides', { sessionId });
    const stopResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_STOP' });
    expect(stopResponse.ok).toBe(true);
    expectNextFixtureSourcesUnchanged(sourceSnapshot);
  } finally {
    try {
      if (extension) {
        await extension.close();
      }
    } finally {
      try {
        if (mcp) {
          await mcp.close();
        }
      } finally {
        try {
          if (nextApp) {
            await nextApp.stop();
          }
        } finally {
          rmSync(fixtureRoot, { recursive: true, force: true });
        }
      }
    }
  }
}

async function runNextExperimentalRscFlightFulfillmentScenario(): Promise<void> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'bdmcp-next-rsc-experimental-'));
  const configPath = join(fixtureRoot, 'override-poc.local.json');
  const localRscPath = join(fixtureRoot, 'products.rsc.txt');
  const sourceSnapshot = snapshotNextFixtureSources();
  let nextApp: ManagedServerProcess | undefined;
  let mcp: MCPClientHandle | undefined;
  let extension: ExtensionContextHandle | undefined;

  try {
    nextApp = await startNextFixtureApp();
    const nextBaseUrl = `http://127.0.0.1:${nextApp.port}`;
    const productsRscPrefix = `${nextBaseUrl}/products?_rsc=`;
    const mcpPort = await getFreePort();
    mcp = await connectMcpClient(createTempDataDir('bdmcp-e2e-next-rsc-experimental-data-'), {
      port: mcpPort,
      env: {
        OVERRIDE_POC_CONFIG_PATH: configPath,
      },
    });

    extension = await launchExtensionContext();
    await assertExtensionInstalled(extension.context, extension.extensionId);
    await extension.setServerBaseUrl(`http://127.0.0.1:${mcpPort}`);

    const targetPage = await extension.context.newPage();
    await targetPage.goto(`${nextBaseUrl}/`, { waitUntil: 'networkidle' });
    await expect(targetPage.locator('#home-headline')).toHaveText('Original launch desk for field teams');

    const popupPage = await openExtensionPage(extension.context, extension.extensionId, 'popup.html');
    await saveAllowlist(popupPage);
    const boundTabId = await startSessionFromTargetTab(popupPage, targetPage);
    const sessionId = await getActiveSessionId(popupPage);
    await expectMcpSeesLiveSession(mcp, sessionId);

    const capturePromise = callToolJson<OverrideResponseCaptureResult>(mcp.client, 'capture_override_response_body', {
      sessionId,
      tabId: boundTabId,
      targetUrl: productsRscPrefix,
      matchMode: 'prefix',
      captureMode: 'cdp-response',
      includeBody: true,
      timeoutMs: 15_000,
    });
    await waitForCaptureSetup();
    await targetPage.click('nav a[href="/products"]');
    const capture = await capturePromise;
    await expect(targetPage.locator('#products-headline')).toHaveText('Original debugging kits');
    expect(capture).toMatchObject({
      captureMode: 'cdp-response',
      matchMode: 'prefix',
      source: 'cdp-response',
      tabId: boundTabId,
      ruleType: 'rsc-flight',
      bodyCaptured: true,
      truncated: false,
    });
    expect(capture.bodyText).toContain('Original debugging kits');

    const patchedBody = (capture.bodyText ?? '')
      .split('Original debugging kits').join('Override debugging kits')
      .split('$129').join('$049');
    expect(patchedBody).toContain('Override debugging kits');
    expect(patchedBody).toContain('$049');
    writeFileSync(localRscPath, patchedBody, 'utf8');
    writeFileSync(
      configPath,
      JSON.stringify({
        enabled: true,
        activeProfileId: 'experimental-rsc-response-e2e',
        profiles: [{
          profileId: 'experimental-rsc-response-e2e',
          name: 'Experimental RSC response override e2e',
          enabled: true,
          autoReload: true,
          rules: [{
            ruleId: 'experimental-rsc-response',
            enabled: true,
            ruleType: 'rsc-flight',
            requestMethod: 'GET',
            matchMode: 'prefix',
            allowExperimentalRscFlightFulfillment: true,
            targetAssetUrl: productsRscPrefix,
            localFilePath: localRscPath,
            contentType: capture.contentType ?? 'text/x-component; charset=utf-8',
          }],
        }],
      }, null, 2),
      'utf8',
    );

    const validation = await callToolJson<{ valid: boolean; issues?: Array<{ code?: string; severity?: string }> }>(mcp.client, 'validate_override_profile', {
      profileId: 'experimental-rsc-response-e2e',
    });
    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'UNSUPPORTED_RSC_FLIGHT_RULE',
        severity: 'error',
      }),
    ]));

    const stopCaptureSessionResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_STOP' });
    expect(stopCaptureSessionResponse.ok).toBe(true);
    await targetPage.close();

    const overridePage = await extension.context.newPage();
    await overridePage.goto(`${nextBaseUrl}/`, { waitUntil: 'networkidle' });
    await expect(overridePage.locator('#home-headline')).toHaveText('Original launch desk for field teams');
    const overrideTabId = await startSessionFromTargetTab(popupPage, overridePage);
    const overrideSessionId = await getActiveSessionId(popupPage);
    await expectMcpSeesLiveSession(mcp, overrideSessionId);

    await enableOverrideForTabViaMcp(mcp, overrideSessionId, overridePage, overrideTabId);
    await expect(overridePage.locator('#home-headline')).toHaveText('Original launch desk for field teams');
    await overridePage.click('nav a[href="/products"]');
    await expect(overridePage.locator('#products-headline')).toHaveText('Override debugging kits');
    await expect(overridePage.locator('#products-price')).toHaveText('$049');

    const status = await callToolJson<OverrideStatus>(mcp.client, 'get_override_status', { sessionId: overrideSessionId });
    expect(status.active).toBe(true);
    expect(status.fulfilledRequests).toBeGreaterThanOrEqual(1);
    expect(status.lastError).toBeFalsy();
    await expectMcpOverrideRequestLogForUrl(mcp, overrideSessionId, '/products?_rsc=');

    await callToolJson(mcp.client, 'disable_overrides', { sessionId: overrideSessionId });
    const stopResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_STOP' });
    expect(stopResponse.ok).toBe(true);
    expectNextFixtureSourcesUnchanged(sourceSnapshot);
  } finally {
    try {
      if (extension) {
        await extension.close();
      }
    } finally {
      try {
        if (mcp) {
          await mcp.close();
        }
      } finally {
        try {
          if (nextApp) {
            await nextApp.stop();
          }
        } finally {
          rmSync(fixtureRoot, { recursive: true, force: true });
        }
      }
    }
  }
}

test.describe('@full override POC e2e coverage', () => {
  test('fulfills configured profile rules and swaps live page scripts', async () => {
    let fixture: OverrideFixture | undefined;
    let targetApp: ManagedTargetApp | undefined;
    let server: ManagedServerProcess | undefined;
    let extension: ExtensionContextHandle | undefined;

    try {
      targetApp = await startTargetApp();
      fixture = createMultiRuleOverrideFixture(targetApp.baseUrl);
      server = await startHttpServer(createTempDataDir('bdmcp-e2e-override-hit-'), {
        env: {
          OVERRIDE_POC_CONFIG_PATH: fixture.configPath,
        },
      });

      extension = await launchExtensionContext();
      await extension.setServerBaseUrl(`http://127.0.0.1:${server.port}`);

      const targetPage = await extension.context.newPage();
      await targetPage.goto(targetApp.baseUrl, { waitUntil: 'domcontentloaded' });
      await expect.poll(async () => {
        return await targetPage.evaluate(() => document.body.dataset.scriptMode ?? 'missing');
      }).toBe('original');
      await expect.poll(async () => {
        return await targetPage.evaluate(() => document.body.dataset.extraScriptMode ?? 'missing');
      }).toBe('original-extra');

      const popupPage = await openExtensionPage(extension.context, extension.extensionId, 'popup.html');
      await saveAllowlist(popupPage);
      const boundTabId = await startSessionFromTargetTab(popupPage, targetPage);
      await enableOverrideForTab(popupPage, targetPage, boundTabId);

      await expect.poll(async () => {
        return await targetPage.evaluate(() => document.body.dataset.scriptMode ?? 'missing');
      }).toBe('override');
      await expect.poll(async () => {
        return await targetPage.evaluate(() => document.body.dataset.extraScriptMode ?? 'missing');
      }).toBe('override-extra');

      const status = await getOverrideStatus(popupPage);
      expect(status.active).toBe(true);
      expect(status.configuredEnabled).toBe(true);
      expect(status.selectedTabId).toBe(boundTabId);
      expect(status.tabId).toBe(boundTabId);
      expect(status.matchedRequests).toBeGreaterThanOrEqual(2);
      expect(status.fulfilledRequests).toBeGreaterThanOrEqual(2);
      expect(status.lastError).toBeFalsy();

      const disableResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'OVERRIDE_POC_DISABLE' });
      expect(disableResponse.ok).toBe(true);
      const stopResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_STOP' });
      expect(stopResponse.ok).toBe(true);
    } finally {
      await stopHarness(extension, server, targetApp, fixture);
    }
  });

  test('plans and fulfills a document response override through MCP', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'bdmcp-document-response-'));
    const configPath = join(fixtureRoot, 'override-poc.local.json');
    let targetApp: ManagedTargetApp | undefined;
    let mcp: MCPClientHandle | undefined;
    let extension: ExtensionContextHandle | undefined;

    try {
      targetApp = await startTargetApp();
      const mcpPort = await getFreePort();
      mcp = await connectMcpClient(createTempDataDir('bdmcp-e2e-document-response-data-'), {
        port: mcpPort,
        env: {
          OVERRIDE_POC_CONFIG_PATH: configPath,
        },
      });

      const plan = await callToolJson<OverrideResponsePatchPlan>(mcp.client, 'plan_override_response_patch', {
        targetUrl: `${targetApp.baseUrl}/`,
        ruleType: 'document',
        contentType: 'text/html; charset=utf-8',
        responseBodyText: TARGET_APP_DOCUMENT_HTML,
        documentPatches: [
          { operation: 'replaceText', selector: 'h1', search: 'Override Target', replacement: 'Document Override Target', expectedCount: 1 },
          { operation: 'replaceText', selector: '#extra-mode', search: 'boot-extra', replacement: 'document-extra', expectedCount: 1 },
          { operation: 'removeElement', selector: 'script[src="/extra.js"]', expectedCount: 1 },
        ],
        configPath,
        writeConfig: true,
        overwrite: false,
        profileId: 'document-response-e2e',
      });
      expect(plan.configWritten).toBe(true);
      expect(plan.rule).toMatchObject({
        ruleType: 'document',
        targetAssetUrl: `${targetApp.baseUrl}/`,
      });

      const validation = await callToolJson<{ valid: boolean }>(mcp.client, 'validate_override_profile', {
        profileId: 'document-response-e2e',
      });
      expect(validation.valid).toBe(true);

      extension = await launchExtensionContext();
      await assertExtensionInstalled(extension.context, extension.extensionId);
      await extension.setServerBaseUrl(`http://127.0.0.1:${mcpPort}`);

      const targetPage = await extension.context.newPage();
      await targetPage.goto(targetApp.baseUrl, { waitUntil: 'domcontentloaded' });
      await expect(targetPage.locator('h1')).toHaveText('Override Target');
      await expect(targetPage.locator('#extra-mode')).toHaveText('original-extra');

      const popupPage = await openExtensionPage(extension.context, extension.extensionId, 'popup.html');
      await saveAllowlist(popupPage);
      const boundTabId = await startSessionFromTargetTab(popupPage, targetPage);
      const sessionId = await getActiveSessionId(popupPage);
      await expectMcpSeesLiveSession(mcp, sessionId);

      await enableOverrideForTabViaMcp(mcp, sessionId, targetPage, boundTabId);

      await expect(targetPage.locator('h1')).toHaveText('Document Override Target');
      await expect(targetPage.locator('#extra-mode')).toHaveText('document-extra');

      const status = await callToolJson<OverrideStatus>(mcp.client, 'get_override_status', { sessionId });
      expect(status.active).toBe(true);
      expect(status.matchedRequests).toBeGreaterThanOrEqual(1);
      expect(status.fulfilledRequests).toBeGreaterThanOrEqual(1);
      expect(status.lastError).toBeFalsy();

      await callToolJson(mcp.client, 'disable_overrides', { sessionId });
      const stopResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_STOP' });
      expect(stopResponse.ok).toBe(true);
    } finally {
      try {
        if (extension) {
          await extension.close();
        }
      } finally {
        try {
          if (mcp) {
            await mcp.close();
          }
        } finally {
          if (targetApp) {
            await targetApp.stop();
          }
          rmSync(fixtureRoot, { recursive: true, force: true });
        }
      }
    }
  });

  test('captures a live document response through CDP before planning an MCP override', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'bdmcp-cdp-document-response-'));
    const configPath = join(fixtureRoot, 'override-poc.local.json');
    let targetApp: ManagedTargetApp | undefined;
    let mcp: MCPClientHandle | undefined;
    let extension: ExtensionContextHandle | undefined;

    try {
      targetApp = await startTargetApp();
      const mcpPort = await getFreePort();
      mcp = await connectMcpClient(createTempDataDir('bdmcp-e2e-cdp-document-response-data-'), {
        port: mcpPort,
        env: {
          OVERRIDE_POC_CONFIG_PATH: configPath,
        },
      });

      extension = await launchExtensionContext();
      await assertExtensionInstalled(extension.context, extension.extensionId);
      await extension.setServerBaseUrl(`http://127.0.0.1:${mcpPort}`);

      const targetPage = await extension.context.newPage();
      await targetPage.goto(targetApp.baseUrl, { waitUntil: 'domcontentloaded' });
      await expect(targetPage.locator('h1')).toHaveText('Override Target');

      const popupPage = await openExtensionPage(extension.context, extension.extensionId, 'popup.html');
      await saveAllowlist(popupPage);
      const boundTabId = await startSessionFromTargetTab(popupPage, targetPage);
      const sessionId = await getActiveSessionId(popupPage);
      await expectMcpSeesLiveSession(mcp, sessionId);

      const capture = await callToolJson<OverrideResponseCaptureResult>(mcp.client, 'capture_override_response_body', {
        sessionId,
        tabId: boundTabId,
        targetUrl: `${targetApp.baseUrl}/`,
        captureMode: 'cdp-response',
        triggerReload: true,
        includeBody: true,
        timeoutMs: 15_000,
      });
      expect(capture).toMatchObject({
        captureMode: 'cdp-response',
        source: 'cdp-response',
        tabId: boundTabId,
        ruleType: 'document',
        bodyCaptured: true,
        truncated: false,
      });
      expect(capture.bodyText).toContain('Override Target');
      await expect(targetPage.locator('h1')).toHaveText('Override Target');

      const plan = await callToolJson<OverrideResponsePatchPlan>(mcp.client, 'plan_override_response_patch', {
        sessionId,
        tabId: boundTabId,
        targetUrl: `${targetApp.baseUrl}/`,
        captureMode: 'cdp-response',
        triggerReload: true,
        timeoutMs: 15_000,
        documentPatches: [
          { operation: 'replaceText', selector: 'h1', search: 'Override Target', replacement: 'CDP Document Override Target', expectedCount: 1 },
          { operation: 'replaceText', selector: '#extra-mode', search: 'boot-extra', replacement: 'cdp-document-extra', expectedCount: 1 },
          { operation: 'removeElement', selector: 'script[src="/extra.js"]', expectedCount: 1 },
        ],
        configPath,
        writeConfig: true,
        overwrite: false,
        profileId: 'cdp-document-response-e2e',
      });
      expect(plan.configWritten).toBe(true);
      expect(plan.capturedFromLiveSession).toMatchObject({
        captureMode: 'cdp-response',
        source: 'cdp-response',
        tabId: boundTabId,
      });
      expect(plan.rule).toMatchObject({
        ruleType: 'document',
        targetAssetUrl: `${targetApp.baseUrl}/`,
      });

      const validation = await callToolJson<{ valid: boolean }>(mcp.client, 'validate_override_profile', {
        profileId: 'cdp-document-response-e2e',
      });
      expect(validation.valid).toBe(true);

      await enableOverrideForTabViaMcp(mcp, sessionId, targetPage, boundTabId);

      await expect(targetPage.locator('h1')).toHaveText('CDP Document Override Target');
      await expect(targetPage.locator('#extra-mode')).toHaveText('cdp-document-extra');

      const status = await callToolJson<OverrideStatus>(mcp.client, 'get_override_status', { sessionId });
      expect(status.active).toBe(true);
      expect(status.fulfilledRequests).toBeGreaterThanOrEqual(1);
      expect(status.lastError).toBeFalsy();

      await callToolJson(mcp.client, 'disable_overrides', { sessionId });
      const stopResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_STOP' });
      expect(stopResponse.ok).toBe(true);
    } finally {
      try {
        if (extension) {
          await extension.close();
        }
      } finally {
        try {
          if (mcp) {
            await mcp.close();
          }
        } finally {
          if (targetApp) {
            await targetApp.stop();
          }
          rmSync(fixtureRoot, { recursive: true, force: true });
        }
      }
    }
  });

  test('captures and overrides a Next.js API response through CDP and MCP', async () => {
    await runNextApiResponseOverrideScenario();
  });

  test('captures and overrides a Next.js data response through CDP and MCP', async () => {
    await runNextDataResponseOverrideScenario();
  });

  test('captures and rewrites a Next.js Pages Router document through __NEXT_DATA__', async () => {
    await runNextLegacyDocumentRewriteScenario();
  });

  test('captures, validates, and fulfills production Next.js RSC flight response overrides through CDP and MCP', async () => {
    await runNextRscFlightOverrideScenario();
  });

  test('captures, plans, and fulfills a POST text/x-component response-stage override through CDP and MCP', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'bdmcp-post-rsc-response-'));
    const configPath = join(fixtureRoot, 'override-poc.local.json');
    let targetApp: ManagedTargetApp | undefined;
    let mcp: MCPClientHandle | undefined;
    let extension: ExtensionContextHandle | undefined;

    try {
      targetApp = await startTargetApp();
      const mcpPort = await getFreePort();
      mcp = await connectMcpClient(createTempDataDir('bdmcp-e2e-post-rsc-response-data-'), {
        port: mcpPort,
        env: {
          OVERRIDE_POC_CONFIG_PATH: configPath,
        },
      });

      extension = await launchExtensionContext();
      await assertExtensionInstalled(extension.context, extension.extensionId);
      await extension.setServerBaseUrl(`http://127.0.0.1:${mcpPort}`);

      const targetPage = await extension.context.newPage();
      await targetPage.goto(targetApp.baseUrl, { waitUntil: 'domcontentloaded' });
      const popupPage = await openExtensionPage(extension.context, extension.extensionId, 'popup.html');
      await saveAllowlist(popupPage);
      const boundTabId = await startSessionFromTargetTab(popupPage, targetPage);
      const sessionId = await getActiveSessionId(popupPage);
      await expectMcpSeesLiveSession(mcp, sessionId);

      const postRscUrl = `${targetApp.baseUrl}/rsc-post`;
      const planPromise = callToolJson<OverrideResponsePatchPlan>(mcp.client, 'plan_override_response_patch', {
        sessionId,
        tabId: boundTabId,
        targetUrl: postRscUrl,
        requestMethod: 'POST',
        ruleType: 'rsc-flight',
        matchMode: 'exact',
        captureMode: 'cdp-response',
        timeoutMs: 15_000,
        textPatches: [{
          search: 'Original POST RSC proof',
          replacement: 'Override POST RSC proof',
          expectedCount: 1,
        }],
        configPath,
        writeConfig: true,
        overwrite: true,
        profileId: 'post-rsc-response-e2e',
        profileName: 'POST RSC response override e2e',
      });
      await waitForCaptureSetup();
      await targetPage.click('#post-rsc-trigger');
      await expect(targetPage.locator('#post-rsc-result')).toHaveText('Original POST RSC proof');

      const plan = await planPromise;
      expect(plan.ruleType).toBe('rsc-flight');
      expect(plan.requestMethod).toBe('POST');
      expect(plan.configWritten).toBe(true);
      expect(plan.blockers).toEqual([]);
      expect(plan.rule).toMatchObject({
        ruleType: 'rsc-flight',
        requestMethod: 'POST',
        matchMode: 'exact',
        targetAssetUrl: postRscUrl,
        rscFlight: {
          productionMode: 'structured-flight-v1',
          source: 'cdp-response',
          patchKind: 'string-value-text',
        },
      });

      const validation = await callToolJson<{ valid: boolean; issues?: Array<{ code?: string; severity?: string }> }>(mcp.client, 'validate_override_profile', {
        profileId: 'post-rsc-response-e2e',
      });
      expect(validation.valid).toBe(true);
      expect(validation.issues).toEqual([]);

      await enableOverrideForTabViaMcp(mcp, sessionId, targetPage, boundTabId);
      await expect(targetPage.locator('#post-rsc-result')).toHaveText('post-rsc-idle');
      await targetPage.click('#post-rsc-trigger');
      await expect(targetPage.locator('#post-rsc-result')).toHaveText('Override POST RSC proof');

      const status = await callToolJson<OverrideStatus>(mcp.client, 'get_override_status', { sessionId });
      expect(status.active).toBe(true);
      expect(status.matchedRequests).toBeGreaterThanOrEqual(1);
      expect(status.fulfilledRequests).toBeGreaterThanOrEqual(1);
      expect(status.lastError).toBeFalsy();
      await expectMcpOverrideRequestLogForUrl(mcp, sessionId, '/rsc-post');

      await callToolJson(mcp.client, 'disable_overrides', { sessionId });
      const stopResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_STOP' });
      expect(stopResponse.ok).toBe(true);
    } finally {
      try {
        if (extension) {
          await extension.close();
        }
      } finally {
        try {
          if (mcp) {
            await mcp.close();
          }
        } finally {
          if (targetApp) {
            await targetApp.stop();
          }
          rmSync(fixtureRoot, { recursive: true, force: true });
        }
      }
    }
  });

  test('keeps production RSC dynamic route overrides isolated across history navigation', async () => {
    await runNextRscDynamicRouteMatrixScenario();
  });

  test('matches production RSC search-param overrides without affecting other search states', async () => {
    await runNextRscSearchParamScenario();
  });

  test('proves experimental Next.js RSC flight fulfillment behind an explicit opt-in flag', async () => {
    await runNextExperimentalRscFlightFulfillmentScenario();
  });

  test('blocks planning overrides for real Next.js server action requests', async ({ page }) => {
    const sourceSnapshot = snapshotNextFixtureSources();
    let nextApp: ManagedServerProcess | undefined;
    let mcp: MCPClientHandle | undefined;

    try {
      nextApp = await startNextFixtureApp();
      const nextBaseUrl = `http://127.0.0.1:${nextApp.port}`;
      const mcpPort = await getFreePort();
      mcp = await connectMcpClient(createTempDataDir('bdmcp-e2e-next-server-action-block-'), {
        port: mcpPort,
      });

      await page.goto(`${nextBaseUrl}/server-actions`, { waitUntil: 'networkidle' });
      await expect(page.locator('#server-action-title')).toHaveText('Original server action workflow');

      const serverActionRequestPromise = page.waitForRequest((request) => {
        return request.method() === 'POST' && request.url().includes('/server-actions');
      });
      await page.click('#server-action-submit');
      const serverActionRequest = await serverActionRequestPromise;
      const headers = await serverActionRequest.allHeaders();

      expect(headers['next-action']).toBeTruthy();

      const result = await callToolText(mcp.client, 'plan_override_response_patch', {
        targetUrl: serverActionRequest.url(),
        ruleType: 'rsc-flight',
        requestMethod: serverActionRequest.method(),
        requestHeaders: headers,
        contentType: 'text/x-component; charset=utf-8',
        responseBodyText: '1:["$","div",null,{"children":"Original server action payload"}]',
        textPatches: [{ search: 'Original server action payload', replacement: 'Override server action payload', expectedCount: 1 }],
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain('SERVER_ACTION_UNSUPPORTED');
    } finally {
      try {
        if (mcp) {
          await mcp.close();
        }
      } finally {
        if (nextApp) {
          await nextApp.stop();
        }
        expectNextFixtureSourcesUnchanged(sourceSnapshot);
      }
    }
  });

  test('blocks planning overrides for real Next.js POST mutation requests', async ({ page }) => {
    const sourceSnapshot = snapshotNextFixtureSources();
    let nextApp: ManagedServerProcess | undefined;
    let mcp: MCPClientHandle | undefined;

    try {
      nextApp = await startNextFixtureApp();
      const nextBaseUrl = `http://127.0.0.1:${nextApp.port}`;
      const mcpPort = await getFreePort();
      mcp = await connectMcpClient(createTempDataDir('bdmcp-e2e-next-mutation-block-'), {
        port: mcpPort,
      });

      await page.goto(`${nextBaseUrl}/mutation-lab`, { waitUntil: 'networkidle' });
      await expect(page.locator('#mutation-lab-title')).toHaveText('Original mutation route handler');

      const mutationRequestPromise = page.waitForRequest((request) => {
        return request.method() === 'POST' && request.url().includes('/api/mutation-signal');
      });
      await page.click('#mutation-lab-submit');
      const mutationRequest = await mutationRequestPromise;
      const headers = await mutationRequest.allHeaders();

      expect(headers['content-type']).toContain('application/json');
      await expect(page.locator('#mutation-lab-status')).toHaveText('Original mutation response from Next route.');

      const result = await callToolText(mcp.client, 'plan_override_response_patch', {
        targetUrl: mutationRequest.url(),
        ruleType: 'api-response',
        requestMethod: mutationRequest.method(),
        requestHeaders: headers,
        contentType: 'application/json; charset=utf-8',
        responseBodyText: '{"mode":"original-mutation","message":"Original mutation response from Next route."}',
        jsonPatches: [{ path: '/mode', value: 'override-mutation' }],
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain('MUTATION_REPLAY_UNSUPPORTED');
    } finally {
      try {
        if (mcp) {
          await mcp.close();
        }
      } finally {
        if (nextApp) {
          await nextApp.stop();
        }
        expectNextFixtureSourcesUnchanged(sourceSnapshot);
      }
    }
  });

  for (const scenario of NEXT_PAGE_OVERRIDE_SCENARIOS) {
    test(`generates a Next.js profile and overrides the ${scenario.page} page through MCP`, async () => {
      await runNextPageOverrideScenario(scenario);
    });
  }

  test('plans a temp Next.js source overlay patch and overrides through MCP', async () => {
    await runNextSourcePlannerScenario();
  });

  test('keeps SRI-protected source override candidates blocked before config writing', async () => {
    await runNextSourcePlannerSriBlockerScenario();
  });

  test('leaves the original asset untouched when the configured target URL does not match', async () => {
    let fixture: OverrideFixture | undefined;
    let targetApp: ManagedTargetApp | undefined;
    let server: ManagedServerProcess | undefined;
    let extension: ExtensionContextHandle | undefined;

    try {
      targetApp = await startTargetApp();
      fixture = createOverrideFixture(`${targetApp.baseUrl}/never-hit.js`);
      server = await startHttpServer(createTempDataDir('bdmcp-e2e-override-miss-'), {
        env: {
          OVERRIDE_POC_CONFIG_PATH: fixture.configPath,
        },
      });

      extension = await launchExtensionContext();
      await extension.setServerBaseUrl(`http://127.0.0.1:${server.port}`);

      const targetPage = await extension.context.newPage();
      await targetPage.goto(targetApp.baseUrl, { waitUntil: 'domcontentloaded' });
      await expect.poll(async () => {
        return await targetPage.evaluate(() => document.body.dataset.scriptMode ?? 'missing');
      }).toBe('original');

      const popupPage = await openExtensionPage(extension.context, extension.extensionId, 'popup.html');
      await saveAllowlist(popupPage);
      const boundTabId = await startSessionFromTargetTab(popupPage, targetPage);
      await enableOverrideForTab(popupPage, targetPage, boundTabId);

      await expect.poll(async () => {
        return await targetPage.evaluate(() => document.body.dataset.scriptMode ?? 'missing');
      }).toBe('original');

      const status = await getOverrideStatus(popupPage);
      expect(status.active).toBe(true);
      expect(status.configuredEnabled).toBe(true);
      expect(status.selectedTabId).toBe(boundTabId);
      expect(status.tabId).toBe(boundTabId);
      expect(status.matchedRequests).toBe(0);
      expect(status.fulfilledRequests).toBe(0);
      expect(status.lastError).toBeFalsy();

      const disableResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'OVERRIDE_POC_DISABLE' });
      expect(disableResponse.ok).toBe(true);
      const stopResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_STOP' });
      expect(stopResponse.ok).toBe(true);
    } finally {
      await stopHarness(extension, server, targetApp, fixture);
    }
  });

  test('pausing the session disables the active override and records a terminal audit run', async () => {
    let fixture: OverrideFixture | undefined;
    let targetApp: ManagedTargetApp | undefined;
    let server: ManagedServerProcess | undefined;
    let extension: ExtensionContextHandle | undefined;

    try {
      targetApp = await startTargetApp();
      fixture = createOverrideFixture(`${targetApp.baseUrl}/app.js`);
      server = await startHttpServer(createTempDataDir('bdmcp-e2e-override-pause-'), {
        env: {
          OVERRIDE_POC_CONFIG_PATH: fixture.configPath,
        },
      });

      extension = await launchExtensionContext();
      await extension.setServerBaseUrl(`http://127.0.0.1:${server.port}`);

      const targetPage = await extension.context.newPage();
      await targetPage.goto(targetApp.baseUrl, { waitUntil: 'domcontentloaded' });

      const popupPage = await openExtensionPage(extension.context, extension.extensionId, 'popup.html');
      await saveAllowlist(popupPage);
      const boundTabId = await startSessionFromTargetTab(popupPage, targetPage);
      const sessionId = await getActiveSessionId(popupPage);
      await enableOverrideForTab(popupPage, targetPage, boundTabId);

      await expect.poll(async () => {
        return await targetPage.evaluate(() => document.body.dataset.scriptMode ?? 'missing');
      }).toBe('override');

      const pauseResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_PAUSE' });
      expect(pauseResponse.ok).toBe(true);

      await expect.poll(async () => {
        const state = await getSessionState(popupPage);
        return state.isPaused === true;
      }).toBe(true);

      await expect.poll(async () => {
        const status = await getOverrideStatus(popupPage);
        return status.active;
      }).toBe(false);

      const latestRun = await waitForLatestOverrideRun(server.port, sessionId, (run) => {
        return run.runStatus === 'disabled' && typeof run.endedAt === 'number';
      });
      expect(latestRun.matchedRequests).toBeGreaterThan(0);
      expect(latestRun.fulfilledRequests).toBeGreaterThan(0);
      expect(latestRun.lastErrorCode ?? null).toBeNull();

      const enableWhilePaused = await sendRuntimeMessage<RuntimeResponse>(popupPage, {
        type: 'OVERRIDE_POC_ENABLE',
        tabId: boundTabId,
      });
      expect(enableWhilePaused.ok).toBe(false);
      if (!enableWhilePaused.ok) {
        expect(enableWhilePaused.error).toContain('Start or resume an active session before enabling the override POC.');
      }
    } finally {
      await stopHarness(extension, server, targetApp, fixture);
    }
  });

  test('unbinding the active override tab disables the override while keeping the session active', async () => {
    let fixture: OverrideFixture | undefined;
    let targetApp: ManagedTargetApp | undefined;
    let server: ManagedServerProcess | undefined;
    let extension: ExtensionContextHandle | undefined;

    try {
      targetApp = await startTargetApp();
      fixture = createOverrideFixture(`${targetApp.baseUrl}/app.js`);
      server = await startHttpServer(createTempDataDir('bdmcp-e2e-override-unbind-'), {
        env: {
          OVERRIDE_POC_CONFIG_PATH: fixture.configPath,
        },
      });

      extension = await launchExtensionContext();
      await extension.setServerBaseUrl(`http://127.0.0.1:${server.port}`);

      const targetPage = await extension.context.newPage();
      await targetPage.goto(targetApp.baseUrl, { waitUntil: 'domcontentloaded' });
      const secondaryPage = await extension.context.newPage();
      await secondaryPage.goto(`${targetApp.baseUrl}/secondary`, { waitUntil: 'domcontentloaded' });

      const popupPage = await openExtensionPage(extension.context, extension.extensionId, 'popup.html');
      await saveAllowlist(popupPage);
      const boundTabId = await startSessionFromTargetTab(popupPage, targetPage);
      const secondaryTabId = await waitForTabIdByUrl(popupPage, '/secondary');

      const addSecondaryResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, {
        type: 'SESSION_ADD_TAB_TO_SESSION',
        tabId: secondaryTabId,
      });
      expect(addSecondaryResponse.ok).toBe(true);

      await enableOverrideForTab(popupPage, targetPage, boundTabId);
      await expect.poll(async () => {
        return await targetPage.evaluate(() => document.body.dataset.scriptMode ?? 'missing');
      }).toBe('override');

      const removeActiveResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, {
        type: 'SESSION_REMOVE_TAB_FROM_SESSION',
        tabId: boundTabId,
      });
      expect(removeActiveResponse.ok).toBe(true);

      await expect.poll(async () => {
        const state = await getSessionState(popupPage);
        return state.isActive;
      }).toBe(true);

      await expect.poll(async () => {
        const status = await getOverrideStatus(popupPage);
        return status.active;
      }).toBe(false);

      await targetPage.reload({ waitUntil: 'domcontentloaded' });
      await expect.poll(async () => {
        return await targetPage.evaluate(() => document.body.dataset.scriptMode ?? 'missing');
      }).toBe('original');
    } finally {
      await stopHarness(extension, server, targetApp, fixture);
    }
  });

  test('stopping the session disables the active override and preserves the final audit run', async () => {
    let fixture: OverrideFixture | undefined;
    let targetApp: ManagedTargetApp | undefined;
    let server: ManagedServerProcess | undefined;
    let extension: ExtensionContextHandle | undefined;

    try {
      targetApp = await startTargetApp();
      fixture = createOverrideFixture(`${targetApp.baseUrl}/app.js`);
      server = await startHttpServer(createTempDataDir('bdmcp-e2e-override-stop-'), {
        env: {
          OVERRIDE_POC_CONFIG_PATH: fixture.configPath,
        },
      });

      extension = await launchExtensionContext();
      await extension.setServerBaseUrl(`http://127.0.0.1:${server.port}`);

      const targetPage = await extension.context.newPage();
      await targetPage.goto(targetApp.baseUrl, { waitUntil: 'domcontentloaded' });

      const popupPage = await openExtensionPage(extension.context, extension.extensionId, 'popup.html');
      await saveAllowlist(popupPage);
      const boundTabId = await startSessionFromTargetTab(popupPage, targetPage);
      const sessionId = await getActiveSessionId(popupPage);
      await enableOverrideForTab(popupPage, targetPage, boundTabId);

      await expect.poll(async () => {
        return await targetPage.evaluate(() => document.body.dataset.scriptMode ?? 'missing');
      }).toBe('override');

      const stopResponse = await sendRuntimeMessage<RuntimeResponse>(popupPage, { type: 'SESSION_STOP' });
      expect(stopResponse.ok).toBe(true);

      await expect.poll(async () => {
        const state = await getSessionState(popupPage);
        return state.isActive;
      }).toBe(false);

      await expect.poll(async () => {
        const status = await getOverrideStatus(popupPage);
        return status.active;
      }).toBe(false);

      const latestRun = await waitForLatestOverrideRun(server.port, sessionId, (run) => {
        return run.runStatus === 'disabled' && typeof run.endedAt === 'number';
      });
      expect(latestRun.matchedRequests).toBeGreaterThan(0);
      expect(latestRun.fulfilledRequests).toBeGreaterThan(0);
      expect(latestRun.lastErrorCode ?? null).toBeNull();

      const finalStatus = await getOverrideStatus(popupPage);
      expect(finalStatus.selectedTabId).toBeUndefined();
    } finally {
      await stopHarness(extension, server, targetApp, fixture);
    }
  });
});
