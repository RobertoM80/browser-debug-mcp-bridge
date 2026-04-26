import { expect, test, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { callToolJson, connectMcpClient, type MCPClientHandle } from './utils/mcp-client';
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
  'src/app/about/page.tsx',
  'src/app/products/page.tsx',
  'src/app/scenario-boot.tsx',
].map((relativePath) => join(NEXT_FIXTURE_ROOT, relativePath));

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

    if (requestUrl.pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }

    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
    response.end(`<!doctype html>
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
    </main>
    <script src="/app.js"></script>
    <script src="/extra.js"></script>
  </body>
</html>`);
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

async function expectMcpOverrideRequestLog(mcp: MCPClientHandle, sessionId: string): Promise<void> {
  await expect.poll(async () => {
    const log = await callToolJson<OverrideRequestLog>(mcp.client, 'get_override_request_log', {
      sessionId,
      limit: 50,
    });
    return log.requests?.some((request) => {
      return request.requestUrl?.includes('/_next/static/') === true && request.status === 'fulfilled';
    }) === true;
  }, { timeout: 20_000 }).toBe(true);
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
