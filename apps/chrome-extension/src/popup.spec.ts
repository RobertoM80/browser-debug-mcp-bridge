// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

function createCaptureConfig() {
  return {
    safeMode: true,
    allowlist: [],
    snapshots: {
      enabled: false,
      requireOptIn: true,
      mode: 'dom',
      styleMode: 'computed-lite',
      triggers: [],
      pngPolicy: {
        maxImagesPerSession: 8,
        maxBytesPerImage: 1_048_576,
        minCaptureIntervalMs: 5_000,
      },
    },
    network: {
      captureBodies: false,
      maxBodyBytes: 262_144,
    },
  };
}

function createRetentionSettings() {
  return {
    retentionDays: 30,
    maxDbMb: 1024,
    maxSessions: 10_000,
    cleanupIntervalMinutes: 60,
    lastCleanupAt: null,
    exportPathOverride: null,
  };
}

function createDom(): void {
  document.body.innerHTML = `
    <span id="app-version"></span>
    <div id="status"></div>
    <div id="session-id"></div>
    <div id="queue-size"></div>
    <div id="dropped-events"></div>
    <div id="config-status"></div>
    <div id="retention-status"></div>
    <div id="session-base-origin"></div>
    <div id="session-tabs-list"></div>
    <div id="override-poc-status"></div>
    <span id="override-poc-target-url"></span>
    <span id="override-poc-local-file"></span>
    <span id="override-poc-config-path"></span>
    <span id="override-poc-profile"></span>
    <span id="override-poc-rules"></span>
    <span id="override-poc-selected-tab-id"></span>
    <span id="override-poc-tab-id"></span>
    <span id="override-poc-matched"></span>
    <span id="override-poc-fulfilled"></span>
    <span id="override-poc-audit"></span>
    <div id="override-poc-diagnostics"></div>
    <div id="override-poc-request-log"></div>
    <div id="override-poc-plan-log"></div>
    <select id="override-poc-target-tab"></select>
    <button id="override-poc-enable" type="button"></button>
    <button id="override-poc-disable" type="button"></button>
    <button id="override-poc-refresh" type="button"></button>
  `;
}

function flushPromises(times: number = 6): Promise<void> {
  return Array.from({ length: times }).reduce<Promise<void>>(
    (chain) => chain.then(() => Promise.resolve()),
    Promise.resolve(),
  );
}

async function loadPopupModule(): Promise<void> {
  vi.resetModules();
  const popupModule = await import('./popup');
  popupModule.initializePopup();
  await flushPromises();
}

describe('popup override target selection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    createDom();
    vi.spyOn(window, 'setInterval').mockReturnValue(1 as unknown as ReturnType<typeof window.setInterval>);
    vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined);
  });

  it('renders the selected override target tab from background status', async () => {
    let selectedTabId = 22;
    const sendMessage = vi.fn((message: { type: string; tabId?: number }, callback: (response: unknown) => void) => {
      switch (message.type) {
        case 'SESSION_GET_STATE':
          callback({
            ok: true,
            state: {
              isActive: true,
              isPaused: false,
              sessionId: 'session-1',
              connectionStatus: 'connected',
              queuedEvents: 0,
              droppedEvents: 0,
              reconnectAttempts: 0,
            },
          });
          return;
        case 'SESSION_GET_TAB_SCOPE':
          callback({
            ok: true,
            result: {
              isActive: true,
              sessionId: 'session-1',
              baseOrigin: 'https://example.com',
              allowedTabIds: [21, 22],
              tabs: [
                { tabId: 21, title: 'Example Home', url: 'https://example.com', origin: 'https://example.com', active: true, bound: true },
                { tabId: 22, title: 'Example Settings', url: 'https://example.com/settings', origin: 'https://example.com', active: false, bound: true },
              ],
            },
          });
          return;
        case 'OVERRIDE_POC_GET_STATUS':
        case 'OVERRIDE_POC_SET_TARGET_TAB':
          if (message.type === 'OVERRIDE_POC_SET_TARGET_TAB' && typeof message.tabId === 'number') {
            selectedTabId = message.tabId;
          }
          callback({
            ok: true,
            result: {
              active: false,
              configuredEnabled: true,
              profileName: 'Next local',
              ruleCount: 3,
              enabledRuleCount: 2,
              selectedTabId,
              targetAssetUrl: 'https://example.com/_next/static/chunks/app/page-prod.js',
              localFilePath: '.next/static/chunks/app/page-local.js',
              resolvedLocalFilePath: 'C:/repo/.next/static/chunks/app/page-local.js',
              contentType: 'application/javascript; charset=utf-8',
              autoReload: true,
              configPath: 'C:/repo/override-poc.local.json',
              fileExists: true,
              fileSizeBytes: 123,
              matchedRequests: 0,
              fulfilledRequests: 0,
              diagnosis: {
                issueCount: 2,
                observedAssets: {
                  observedAssetCount: 4,
                  targetAssetObserved: false,
                  targetAssetIntegrity: null,
                  serviceWorkerControlled: true,
                  cspMetaTagCount: 1,
                  sriAssetCount: 0,
                },
                issues: [{
                  code: 'TARGET_ASSET_NOT_OBSERVED',
                  severity: 'warning',
                  message: 'The configured target asset URL was not observed.',
                }],
              },
              requestLog: [{
                requestLogId: 'run-1:req-1',
                timestamp: 1700000000200,
                requestUrl: 'https://example.com/_next/static/chunks/app/page-prod.js',
                status: 'failed',
                failureCode: 'RSC_PATCH_ANCHOR_MISMATCH',
                errorMessage: 'Patch anchor drifted',
              }],
              planLog: [{
                planId: 'plan-1',
                createdAt: 1700000000100,
                plannerKind: 'next-source-overlay',
                ruleType: 'rsc-flight',
                requestMethod: 'GET',
                matchMode: 'prefix',
                targetAssetUrl: 'https://example.com/about?_rsc=',
                originalBytes: 88,
                patchedBytes: 92,
                warnings: ['live drift possible'],
                blockers: [],
              }],
            },
          });
          return;
        case 'SESSION_GET_CONFIG':
          callback({ ok: true, config: createCaptureConfig() });
          return;
        case 'RETENTION_GET_SETTINGS':
          callback({ ok: true, retention: createRetentionSettings() });
          return;
        case 'SESSION_LIST_RECENT':
          callback({ ok: true, result: { sessions: [] } });
          return;
        default:
          callback({ ok: false, error: 'Unexpected message: ' + message.type });
      }
    });

    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage,
        getManifest: vi.fn(() => ({ version: '1.11.0' })),
        getURL: vi.fn(() => 'chrome-extension://extension/db-viewer.html'),
      },
      tabs: {
        create: vi.fn(async () => undefined),
      },
    });

    await loadPopupModule();

    expect(document.getElementById('app-version')?.textContent).toBe('v1.11.0');

    const select = document.getElementById('override-poc-target-tab') as HTMLSelectElement | null;
    const selectedLabel = document.getElementById('override-poc-selected-tab-id');
    const diagnostics = document.getElementById('override-poc-diagnostics');
    const requestLog = document.getElementById('override-poc-request-log');
    const planLog = document.getElementById('override-poc-plan-log');

    expect(select).not.toBeNull();
    expect(select?.disabled).toBe(false);
    expect(Array.from(select?.options ?? []).map((option) => option.value)).toEqual(['21', '22']);
    expect(select?.value).toBe('22');
    expect(selectedLabel?.textContent).toBe('22');
    expect(document.getElementById('override-poc-profile')?.textContent).toBe('Next local');
    expect(document.getElementById('override-poc-rules')?.textContent).toBe('2/3 enabled');
    expect(diagnostics?.textContent).toContain('Observed assets: 4; target not observed');
    expect(diagnostics?.textContent).toContain('TARGET_ASSET_NOT_OBSERVED');
    expect(requestLog?.textContent).toContain('RSC_PATCH_ANCHOR_MISMATCH');
    expect(requestLog?.textContent).toContain('Patch anchor drifted');
    expect(planLog?.textContent).toContain('next-source-overlay GET rsc-flight');
    expect(planLog?.textContent).toContain('88->92 bytes');
  });

  it('locks the override target selector while an override is active', async () => {
    const sendMessage = vi.fn((message: { type: string }, callback: (response: unknown) => void) => {
      switch (message.type) {
        case 'SESSION_GET_STATE':
          callback({
            ok: true,
            state: {
              isActive: true,
              isPaused: false,
              sessionId: 'session-1',
              connectionStatus: 'connected',
              queuedEvents: 0,
              droppedEvents: 0,
              reconnectAttempts: 0,
            },
          });
          return;
        case 'SESSION_GET_TAB_SCOPE':
          callback({
            ok: true,
            result: {
              isActive: true,
              sessionId: 'session-1',
              baseOrigin: 'https://example.com',
              allowedTabIds: [21, 22],
              tabs: [
                { tabId: 21, title: 'Example Home', url: 'https://example.com', origin: 'https://example.com', active: true, bound: true },
                { tabId: 22, title: 'Example Settings', url: 'https://example.com/settings', origin: 'https://example.com', active: false, bound: true },
              ],
            },
          });
          return;
        case 'OVERRIDE_POC_GET_STATUS':
          callback({
            ok: true,
            result: {
              active: true,
              configuredEnabled: true,
              selectedTabId: 21,
              tabId: 21,
              targetAssetUrl: 'https://example.com/_next/static/chunks/app/page-prod.js',
              localFilePath: '.next/static/chunks/app/page-local.js',
              resolvedLocalFilePath: 'C:/repo/.next/static/chunks/app/page-local.js',
              contentType: 'application/javascript; charset=utf-8',
              autoReload: true,
              configPath: 'C:/repo/override-poc.local.json',
              fileExists: true,
              fileSizeBytes: 123,
              matchedRequests: 1,
              fulfilledRequests: 1,
            },
          });
          return;
        case 'SESSION_GET_CONFIG':
          callback({ ok: true, config: createCaptureConfig() });
          return;
        case 'RETENTION_GET_SETTINGS':
          callback({ ok: true, retention: createRetentionSettings() });
          return;
        case 'SESSION_LIST_RECENT':
          callback({ ok: true, result: { sessions: [] } });
          return;
        default:
          callback({ ok: false, error: 'Unexpected message: ' + message.type });
      }
    });

    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage,
        getManifest: vi.fn(() => ({ version: '1.11.0' })),
        getURL: vi.fn(() => 'chrome-extension://extension/db-viewer.html'),
      },
      tabs: {
        create: vi.fn(async () => undefined),
      },
    });

    await loadPopupModule();

    const select = document.getElementById('override-poc-target-tab') as HTMLSelectElement | null;
    expect(select?.disabled).toBe(true);
    expect(select?.title).toContain('Disable the active override');
  });

  it('sends OVERRIDE_POC_SET_TARGET_TAB when the operator changes the selected tab', async () => {
    let selectedTabId = 21;
    const sendMessage = vi.fn((message: { type: string; tabId?: number }, callback: (response: unknown) => void) => {
      switch (message.type) {
        case 'SESSION_GET_STATE':
          callback({
            ok: true,
            state: {
              isActive: true,
              isPaused: false,
              sessionId: 'session-1',
              connectionStatus: 'connected',
              queuedEvents: 0,
              droppedEvents: 0,
              reconnectAttempts: 0,
            },
          });
          return;
        case 'SESSION_GET_TAB_SCOPE':
          callback({
            ok: true,
            result: {
              isActive: true,
              sessionId: 'session-1',
              baseOrigin: 'https://example.com',
              allowedTabIds: [21, 22],
              tabs: [
                { tabId: 21, title: 'Example Home', url: 'https://example.com', origin: 'https://example.com', active: true, bound: true },
                { tabId: 22, title: 'Example Settings', url: 'https://example.com/settings', origin: 'https://example.com', active: false, bound: true },
              ],
            },
          });
          return;
        case 'OVERRIDE_POC_GET_STATUS':
        case 'OVERRIDE_POC_SET_TARGET_TAB':
          if (message.type === 'OVERRIDE_POC_SET_TARGET_TAB' && typeof message.tabId === 'number') {
            selectedTabId = message.tabId;
          }
          callback({
            ok: true,
            result: {
              active: false,
              configuredEnabled: true,
              selectedTabId,
              targetAssetUrl: 'https://example.com/_next/static/chunks/app/page-prod.js',
              localFilePath: '.next/static/chunks/app/page-local.js',
              resolvedLocalFilePath: 'C:/repo/.next/static/chunks/app/page-local.js',
              contentType: 'application/javascript; charset=utf-8',
              autoReload: true,
              configPath: 'C:/repo/override-poc.local.json',
              fileExists: true,
              fileSizeBytes: 123,
              matchedRequests: 0,
              fulfilledRequests: 0,
            },
          });
          return;
        case 'SESSION_GET_CONFIG':
          callback({ ok: true, config: createCaptureConfig() });
          return;
        case 'RETENTION_GET_SETTINGS':
          callback({ ok: true, retention: createRetentionSettings() });
          return;
        case 'SESSION_LIST_RECENT':
          callback({ ok: true, result: { sessions: [] } });
          return;
        default:
          callback({ ok: false, error: 'Unexpected message: ' + message.type });
      }
    });

    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage,
        getManifest: vi.fn(() => ({ version: '1.11.0' })),
        getURL: vi.fn(() => 'chrome-extension://extension/db-viewer.html'),
      },
      tabs: {
        create: vi.fn(async () => undefined),
      },
    });

    await loadPopupModule();

    const select = document.getElementById('override-poc-target-tab') as HTMLSelectElement;
    select.value = '22';
    select.dispatchEvent(new Event('change'));
    await flushPromises();

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'OVERRIDE_POC_SET_TARGET_TAB', tabId: 22 }),
      expect.any(Function),
    );
    expect((document.getElementById('override-poc-selected-tab-id')?.textContent ?? '').trim()).toBe('22');
  });
});
