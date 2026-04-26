import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OverridePocController } from './override-poc';

type Debuggee = { tabId?: number };
type DebugEventListener = (source: Debuggee, method: string, params?: unknown) => void;
type DebugDetachListener = (source: Debuggee, reason: string) => void;

class ChromeOverrideMock {
  readonly debugEventListeners: DebugEventListener[] = [];
  readonly debugDetachListeners: DebugDetachListener[] = [];
  readonly attach = vi.fn(async (_source: Debuggee, _version: string) => undefined);
  readonly detach = vi.fn(async (_source: Debuggee) => undefined);
  readonly sendCommand = vi.fn(async (_source: Debuggee, _method: string, _params?: Record<string, unknown>) => ({}));
  readonly reload = vi.fn(async (_tabId: number, _options?: { bypassCache?: boolean }) => undefined);

  readonly chrome = {
    debugger: {
      onEvent: {
        addListener: (listener: DebugEventListener) => {
          this.debugEventListeners.push(listener);
        },
      },
      onDetach: {
        addListener: (listener: DebugDetachListener) => {
          this.debugDetachListeners.push(listener);
        },
      },
      attach: this.attach,
      detach: this.detach,
      sendCommand: this.sendCommand,
    },
    tabs: {
      reload: this.reload,
    },
  };

  emitDebuggerEvent(source: Debuggee, method: string, params?: unknown): void {
    for (const listener of this.debugEventListeners) {
      listener(source, method, params);
    }
  }

  emitDebuggerDetach(source: Debuggee, reason: string): void {
    for (const listener of this.debugDetachListeners) {
      listener(source, reason);
    }
  }
}

function createJsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function isAuditEndpoint(url: string): boolean {
  return /\/sessions\/[^/]+\/overrides\/(runs|requests)$/.test(url);
}

function flushPromises(times: number = 4): Promise<void> {
  return Array.from({ length: times }).reduce<Promise<void>>(
    (chain) => chain.then(() => Promise.resolve()),
    Promise.resolve(),
  );
}

describe('OverridePocController', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('btoa', (value: string) => Buffer.from(value, 'binary').toString('base64'));
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('enables the debugger flow and reloads the selected tab', async () => {
    const chromeMock = new ChromeOverrideMock();
    vi.stubGlobal('chrome', chromeMock.chrome);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/overrides/poc/config')) {
          return createJsonResponse({
            ok: true,
            enabled: true,
            targetAssetUrl: 'https://example.com/_next/static/chunks/app/page-prod.js',
            localFilePath: '.next/static/chunks/app/page-local.js',
            resolvedLocalFilePath: 'C:/repo/.next/static/chunks/app/page-local.js',
            contentType: 'application/javascript; charset=utf-8',
            autoReload: true,
            configPath: 'C:/repo/override-poc.local.json',
            fileExists: true,
            fileSizeBytes: 1234,
          });
        }
        if (isAuditEndpoint(url)) {
          return createJsonResponse({ ok: true });
        }

        throw new Error('Unexpected fetch: ' + url);
      }),
    );

    const controller = new OverridePocController('http://127.0.0.1:8065');
    const status = await controller.enableForTab({ sessionId: 'session-1', tabId: 17, selectedTabId: 17 });

    expect(chromeMock.attach).toHaveBeenCalledWith({ tabId: 17 }, '1.3');
    expect(chromeMock.sendCommand.mock.calls.map((call) => call[1])).toEqual([
      'Network.enable',
      'Fetch.enable',
      'Network.setCacheDisabled',
      'Network.setBypassServiceWorker',
      'Network.clearBrowserCache',
    ]);
    expect(chromeMock.reload).toHaveBeenCalledWith(17, { bypassCache: true });
    expect(status.active).toBe(true);
    expect(status.tabId).toBe(17);
    expect(status.sessionId).toBe('session-1');
    expect(status.targetAssetUrl).toContain('page-prod.js');
  });

  it('fulfills matching requests with local override bytes', async () => {
    const chromeMock = new ChromeOverrideMock();
    vi.stubGlobal('chrome', chromeMock.chrome);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/overrides/poc/config')) {
        return createJsonResponse({
          ok: true,
          enabled: true,
          targetAssetUrl: 'https://example.com/_next/static/chunks/app/page-prod.js',
          localFilePath: '.next/static/chunks/app/page-local.js',
          resolvedLocalFilePath: 'C:/repo/.next/static/chunks/app/page-local.js',
          contentType: 'application/javascript; charset=utf-8',
          autoReload: false,
          configPath: 'C:/repo/override-poc.local.json',
          fileExists: true,
          fileSizeBytes: 31,
        });
      }
      if (url.includes('/overrides/poc/asset?assetUrl=')) {
        return new Response('console.log("override works");', {
          status: 200,
          headers: {
            'Content-Type': 'application/javascript; charset=utf-8',
          },
        });
      }
      if (isAuditEndpoint(url)) {
        return createJsonResponse({ ok: true });
      }

      throw new Error('Unexpected fetch: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    const controller = new OverridePocController('http://127.0.0.1:8065');
    await controller.enableForTab({ sessionId: 'session-1', tabId: 17, selectedTabId: 17 });
    chromeMock.sendCommand.mockClear();

    chromeMock.emitDebuggerEvent(
      { tabId: 17 },
      'Fetch.requestPaused',
      {
        requestId: 'request-1',
        request: {
          url: 'https://example.com/_next/static/chunks/app/page-prod.js',
        },
      },
    );

    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/overrides/poc/asset?assetUrl='),
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(chromeMock.sendCommand).toHaveBeenCalledWith(
      { tabId: 17 },
      'Fetch.fulfillRequest',
      expect.objectContaining({
        requestId: 'request-1',
        responseCode: 200,
      }),
    );

    const status = await controller.getStatus();
    expect(status.matchedRequests).toBe(1);
    expect(status.fulfilledRequests).toBe(1);
    expect(status.lastErrorCode).toBeUndefined();
    expect(status.lastError).toBeUndefined();
  });

  it('fulfills matching requests from any enabled profile rule', async () => {
    const chromeMock = new ChromeOverrideMock();
    vi.stubGlobal('chrome', chromeMock.chrome);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/overrides/poc/config')) {
        return createJsonResponse({
          ok: true,
          enabled: true,
          activeProfileId: 'local-dev',
          profileId: 'local-dev',
          profileName: 'Local dev',
          targetAssetUrl: 'https://example.com/app.js',
          localFilePath: './app.js',
          resolvedLocalFilePath: 'C:/repo/app.js',
          contentType: 'application/javascript; charset=utf-8',
          autoReload: false,
          configPath: 'C:/repo/override-poc.local.json',
          fileExists: true,
          fileSizeBytes: 31,
          ruleCount: 2,
          enabledRuleCount: 2,
          rules: [
            {
              ruleId: 'app',
              enabled: true,
              targetAssetUrl: 'https://example.com/app.js',
              localFilePath: './app.js',
              resolvedLocalFilePath: 'C:/repo/app.js',
              contentType: 'application/javascript; charset=utf-8',
              fileExists: true,
              fileSizeBytes: 31,
            },
            {
              ruleId: 'extra',
              enabled: true,
              targetAssetUrl: 'https://example.com/extra.js',
              localFilePath: './extra.js',
              resolvedLocalFilePath: 'C:/repo/extra.js',
              contentType: 'application/javascript; charset=utf-8',
              fileExists: true,
              fileSizeBytes: 33,
            },
          ],
        });
      }
      if (url.includes('/overrides/poc/asset?assetUrl=')) {
        return new Response('console.log("multi-rule override works");', {
          status: 200,
          headers: {
            'Content-Type': 'application/javascript; charset=utf-8',
          },
        });
      }
      if (isAuditEndpoint(url)) {
        return createJsonResponse({ ok: true });
      }

      throw new Error('Unexpected fetch: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    const controller = new OverridePocController('http://127.0.0.1:8065');
    await controller.enableForTab({ sessionId: 'session-1', tabId: 17, selectedTabId: 17 });
    chromeMock.sendCommand.mockClear();

    chromeMock.emitDebuggerEvent(
      { tabId: 17 },
      'Fetch.requestPaused',
      {
        requestId: 'request-extra',
        request: {
          url: 'https://example.com/extra.js',
        },
      },
    );

    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent('https://example.com/extra.js')),
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(chromeMock.sendCommand).toHaveBeenCalledWith(
      { tabId: 17 },
      'Fetch.fulfillRequest',
      expect.objectContaining({ requestId: 'request-extra' }),
    );
    const status = await controller.getStatus();
    expect(status.ruleCount).toBe(2);
    expect(status.matchedRequests).toBe(1);
    expect(status.fulfilledRequests).toBe(1);
  });

  it('continues non-matching requests without fetching local override bytes', async () => {
    const chromeMock = new ChromeOverrideMock();
    vi.stubGlobal('chrome', chromeMock.chrome);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/overrides/poc/config')) {
        return createJsonResponse({
          ok: true,
          enabled: true,
          targetAssetUrl: 'https://example.com/_next/static/chunks/app/page-prod.js',
          localFilePath: '.next/static/chunks/app/page-local.js',
          resolvedLocalFilePath: 'C:/repo/.next/static/chunks/app/page-local.js',
          contentType: 'application/javascript; charset=utf-8',
          autoReload: false,
          configPath: 'C:/repo/override-poc.local.json',
          fileExists: true,
            fileSizeBytes: 31,
          });
      }
      if (isAuditEndpoint(url)) {
        return createJsonResponse({ ok: true });
      }

      throw new Error('Unexpected fetch: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    const controller = new OverridePocController('http://127.0.0.1:8065');
    await controller.enableForTab({ sessionId: 'session-1', tabId: 17, selectedTabId: 17 });
    chromeMock.sendCommand.mockClear();

    chromeMock.emitDebuggerEvent(
      { tabId: 17 },
      'Fetch.requestPaused',
      {
        requestId: 'request-2',
        request: {
          url: 'https://example.com/_next/static/chunks/app/other.js',
        },
      },
    );

    await flushPromises();

    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/overrides/poc/asset?assetUrl='))).toBe(false);
    expect(chromeMock.sendCommand).toHaveBeenCalledWith(
      { tabId: 17 },
      'Fetch.continueRequest',
      { requestId: 'request-2' },
    );

    const status = await controller.getStatus();
    expect(status.matchedRequests).toBe(0);
    expect(status.fulfilledRequests).toBe(0);
  });
});
