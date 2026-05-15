import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
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
  ).then(() => new Promise((resolvePromise) => setTimeout(resolvePromise, 20)));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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

  it('records precise setup failures and restores debugger toggles', async () => {
    const chromeMock = new ChromeOverrideMock();
    chromeMock.sendCommand.mockImplementation(async (_source, method, params) => {
      if (method === 'Network.setCacheDisabled' && params?.cacheDisabled === true) {
        throw new Error('cache command rejected');
      }
      return {};
    });
    vi.stubGlobal('chrome', chromeMock.chrome);
    const runAudits: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
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
        if (/\/sessions\/[^/]+\/overrides\/runs$/.test(url)) {
          runAudits.push(JSON.parse(String(init?.body)));
          return createJsonResponse({ ok: true });
        }
        if (isAuditEndpoint(url)) {
          return createJsonResponse({ ok: true });
        }

        throw new Error('Unexpected fetch: ' + url);
      }),
    );

    const controller = new OverridePocController('http://127.0.0.1:8065');
    await expect(controller.enableForTab({ sessionId: 'session-1', tabId: 17, selectedTabId: 17 }))
      .rejects.toMatchObject({ code: 'CACHE_DISABLE_FAILED' });

    expect(chromeMock.detach).toHaveBeenCalledWith({ tabId: 17 });
    expect(chromeMock.reload).not.toHaveBeenCalled();
    expect(chromeMock.sendCommand.mock.calls.map((call) => call[1])).toEqual([
      'Network.enable',
      'Fetch.enable',
      'Network.setCacheDisabled',
      'Fetch.disable',
      'Network.setCacheDisabled',
      'Network.setBypassServiceWorker',
    ]);
    expect(runAudits).toHaveLength(1);
    expect(runAudits[0]).toMatchObject({
      runStatus: 'failed',
      lastErrorCode: 'CACHE_DISABLE_FAILED',
    });
    const status = await controller.getStatus();
    expect(status.active).toBe(false);
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

  it('matches duplicate target URLs by request method before fulfillment', async () => {
    const chromeMock = new ChromeOverrideMock();
    vi.stubGlobal('chrome', chromeMock.chrome);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/overrides/poc/config')) {
        return createJsonResponse({
          ok: true,
          enabled: true,
          targetAssetUrl: 'https://example.com/api/products',
          localFilePath: './get.json',
          resolvedLocalFilePath: 'C:/repo/get.json',
          contentType: 'application/json; charset=utf-8',
          autoReload: false,
          configPath: 'C:/repo/override-poc.local.json',
          fileExists: true,
          fileSizeBytes: 20,
          ruleCount: 2,
          enabledRuleCount: 2,
          rules: [
            {
              ruleId: 'get-products',
              enabled: true,
              ruleType: 'api-response',
              requestMethod: 'GET',
              matchMode: 'exact',
              targetAssetUrl: 'https://example.com/api/products',
              localFilePath: './get.json',
              resolvedLocalFilePath: 'C:/repo/get.json',
              contentType: 'application/json; charset=utf-8',
              fileExists: true,
              fileSizeBytes: 20,
            },
            {
              ruleId: 'post-products',
              enabled: true,
              ruleType: 'api-response',
              requestMethod: 'POST',
              matchMode: 'exact',
              targetAssetUrl: 'https://example.com/api/products',
              localFilePath: './post.json',
              resolvedLocalFilePath: 'C:/repo/post.json',
              contentType: 'application/json; charset=utf-8',
              fileExists: true,
              fileSizeBytes: 21,
            },
          ],
        });
      }
      if (url.includes('/overrides/poc/asset?assetUrl=')) {
        return new Response('{"mode":"post"}', {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
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
        requestId: 'request-post',
        request: {
          method: 'POST',
          url: 'https://example.com/api/products',
        },
      },
    );

    await flushPromises();

    const assetFetchUrl = fetchMock.mock.calls.map((call) => String(call[0])).find((url) => url.includes('/overrides/poc/asset?assetUrl='));
    expect(assetFetchUrl).toContain('requestMethod=POST');
    expect(chromeMock.sendCommand).toHaveBeenCalledWith(
      { tabId: 17 },
      'Fetch.fulfillRequest',
      expect.objectContaining({ requestId: 'request-post' }),
    );
  });

  it('continues prefix-matched RSC response requests and records an unsupported failure', async () => {
    const chromeMock = new ChromeOverrideMock();
    vi.stubGlobal('chrome', chromeMock.chrome);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/overrides/poc/config')) {
        return createJsonResponse({
          ok: true,
          enabled: true,
          targetAssetUrl: 'https://example.com/about?_rsc=',
          localFilePath: './about.rsc',
          resolvedLocalFilePath: 'C:/repo/about.rsc',
          contentType: 'text/x-component',
          autoReload: false,
          configPath: 'C:/repo/override-poc.local.json',
          fileExists: true,
          fileSizeBytes: 48,
          ruleCount: 1,
          enabledRuleCount: 1,
          rules: [{
            ruleId: 'about-rsc',
            enabled: true,
            ruleType: 'rsc-flight',
            requestMethod: 'GET',
            matchMode: 'prefix',
            targetAssetUrl: 'https://example.com/about?_rsc=',
            localFilePath: './about.rsc',
            resolvedLocalFilePath: 'C:/repo/about.rsc',
            contentType: 'text/x-component',
            fileExists: true,
            fileSizeBytes: 48,
          }],
        });
      }
      if (url.includes('/overrides/poc/asset?assetUrl=')) {
        throw new Error('RSC body should not be fetched for unsupported fulfillment');
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
        requestId: 'request-rsc',
        request: {
          method: 'GET',
          url: 'https://example.com/about?_rsc=random-token',
        },
      },
    );

    await flushPromises();

    const assetFetchUrl = fetchMock.mock.calls.map((call) => String(call[0])).find((url) => url.includes('/overrides/poc/asset?assetUrl='));
    expect(assetFetchUrl).toBeUndefined();
    expect(chromeMock.sendCommand).toHaveBeenCalledWith(
      { tabId: 17 },
      'Fetch.continueRequest',
      { requestId: 'request-rsc' },
    );
    expect(chromeMock.sendCommand.mock.calls.some((call) => call[1] === 'Fetch.fulfillRequest')).toBe(false);
    const status = await controller.getStatus();
    expect(status.matchedRequests).toBe(1);
    expect(status.fulfilledRequests).toBe(0);
    expect(status.lastErrorCode).toBe('RSC_PATCH_UNSUPPORTED');
    expect(status.lastError).toContain('RSC flight response fulfillment is not supported');
  });

  it('fulfills prefix-matched RSC response requests only when experimental fulfillment is explicitly allowed', async () => {
    const chromeMock = new ChromeOverrideMock();
    vi.stubGlobal('chrome', chromeMock.chrome);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/overrides/poc/config')) {
        return createJsonResponse({
          ok: true,
          enabled: true,
          targetAssetUrl: 'https://example.com/about?_rsc=',
          localFilePath: './about.rsc',
          resolvedLocalFilePath: 'C:/repo/about.rsc',
          contentType: 'text/x-component',
          autoReload: false,
          configPath: 'C:/repo/override-poc.local.json',
          fileExists: true,
          fileSizeBytes: 48,
          ruleCount: 1,
          enabledRuleCount: 1,
          rules: [{
            ruleId: 'about-rsc',
            enabled: true,
            ruleType: 'rsc-flight',
            requestMethod: 'GET',
            matchMode: 'prefix',
            allowExperimentalRscFlightFulfillment: true,
            targetAssetUrl: 'https://example.com/about?_rsc=',
            localFilePath: './about.rsc',
            resolvedLocalFilePath: 'C:/repo/about.rsc',
            contentType: 'text/x-component',
            fileExists: true,
            fileSizeBytes: 48,
          }],
        });
      }
      if (url.includes('/overrides/poc/asset?assetUrl=')) {
        return new Response('1:["$","h1",null,{"children":"Override proof"}]', {
          status: 200,
          headers: {
            'Content-Type': 'text/x-component',
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
        requestId: 'request-rsc',
        request: {
          method: 'GET',
          url: 'https://example.com/about?_rsc=random-token',
        },
      },
    );

    await flushPromises();

    expect(fetchMock.mock.calls.map((call) => String(call[0])).some((url) => url.includes('/overrides/poc/asset?assetUrl='))).toBe(true);
    expect(chromeMock.sendCommand).toHaveBeenCalledWith(
      { tabId: 17 },
      'Fetch.fulfillRequest',
      expect.objectContaining({ requestId: 'request-rsc' }),
    );
    const status = await controller.getStatus();
    expect(status.matchedRequests).toBe(1);
    expect(status.fulfilledRequests).toBe(1);
    expect(status.lastError).toBeFalsy();
  });

  it('fulfills production RSC response-stage requests only after request context and original hash match', async () => {
    const chromeMock = new ChromeOverrideMock();
    const originalBody = '1:["$","h1",null,{"children":"Original proof"}]';
    const patchedBody = '1:["$","h1",null,{"children":"Override proof"}]';
    chromeMock.sendCommand.mockImplementation(async (_source, method) => {
      if (method === 'Fetch.getResponseBody') {
        return { body: originalBody, base64Encoded: false };
      }
      return {};
    });
    vi.stubGlobal('chrome', chromeMock.chrome);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/overrides/poc/config')) {
        return createJsonResponse({
          ok: true,
          enabled: true,
          targetAssetUrl: 'https://example.com/about?_rsc=',
          localFilePath: './about.rsc',
          resolvedLocalFilePath: 'C:/repo/about.rsc',
          contentType: 'text/x-component; charset=utf-8',
          autoReload: false,
          configPath: 'C:/repo/override-poc.local.json',
          fileExists: true,
          fileSizeBytes: Buffer.byteLength(patchedBody),
          ruleCount: 1,
          enabledRuleCount: 1,
          rules: [{
            ruleId: 'about-rsc',
            enabled: true,
            ruleType: 'rsc-flight',
            requestMethod: 'GET',
            matchMode: 'prefix',
            targetAssetUrl: 'https://example.com/about?_rsc=',
            localFilePath: './about.rsc',
            resolvedLocalFilePath: 'C:/repo/about.rsc',
            contentType: 'text/x-component; charset=utf-8',
            fileExists: true,
            fileSizeBytes: Buffer.byteLength(patchedBody),
            rscFlight: {
              productionMode: 'structured-flight-v1',
              source: 'cdp-response',
              patchKind: 'string-value-text',
              textPatches: [{ search: 'Original proof', replacement: 'Override proof', expectedCount: 1 }],
              originalSha256: sha256(originalBody),
              patchedSha256: sha256(patchedBody),
              originalBytes: Buffer.byteLength(originalBody),
              patchedBytes: Buffer.byteLength(patchedBody),
              contentType: 'text/x-component; charset=utf-8',
              requestHeaders: {
                rsc: '1',
                'next-url': '/',
              },
            },
          }],
        });
      }
      if (url.includes('/overrides/poc/asset?assetUrl=')) {
        return new Response(patchedBody, {
          status: 200,
          headers: {
            'Content-Type': 'text/x-component; charset=utf-8',
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
    const fetchEnableCall = chromeMock.sendCommand.mock.calls.find((call) => call[1] === 'Fetch.enable');
    expect(fetchEnableCall?.[2]).toMatchObject({
      patterns: expect.arrayContaining([
        { urlPattern: 'https://example.com/about?_rsc=*', requestStage: 'Response' },
      ]),
    });
    chromeMock.sendCommand.mockClear();

    chromeMock.emitDebuggerEvent(
      { tabId: 17 },
      'Fetch.requestPaused',
      {
        requestId: 'request-rsc',
        request: {
          method: 'GET',
          url: 'https://example.com/about?_rsc=random-token',
          headers: {
            RSC: '1',
            'Next-Url': '/',
          },
        },
      },
    );
    await flushPromises();

    chromeMock.emitDebuggerEvent(
      { tabId: 17 },
      'Fetch.requestPaused',
      {
        requestId: 'request-rsc',
        request: {
          method: 'GET',
          url: 'https://example.com/about?_rsc=random-token',
        },
        responseStatusCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'text/x-component; charset=utf-8' }],
      },
    );
    await flushPromises(8);

    expect(chromeMock.sendCommand).toHaveBeenCalledWith(
      { tabId: 17 },
      'Fetch.getResponseBody',
      { requestId: 'request-rsc' },
    );
    expect(chromeMock.sendCommand).toHaveBeenCalledWith(
      { tabId: 17 },
      'Fetch.fulfillRequest',
      expect.objectContaining({ requestId: 'request-rsc' }),
    );
    const status = await controller.getStatus();
    expect(status.matchedRequests).toBe(1);
    expect(status.fulfilledRequests).toBe(1);
    expect(status.lastError).toBeFalsy();
  });

  it('fulfills captured POST RSC response-stage requests without replaying the request', async () => {
    const chromeMock = new ChromeOverrideMock();
    const originalBody = '1:["$","h1",null,{"children":"Original server-rendered products"}]';
    const patchedBody = '1:["$","h1",null,{"children":"Override server-rendered products"}]';
    chromeMock.sendCommand.mockImplementation(async (_source, method) => {
      if (method === 'Fetch.getResponseBody') {
        return { body: originalBody, base64Encoded: false };
      }
      return {};
    });
    vi.stubGlobal('chrome', chromeMock.chrome);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/overrides/poc/config')) {
        return createJsonResponse({
          ok: true,
          enabled: true,
          targetAssetUrl: 'https://example.com/products',
          localFilePath: './products.rsc',
          resolvedLocalFilePath: 'C:/repo/products.rsc',
          contentType: 'text/x-component; charset=utf-8',
          autoReload: false,
          configPath: 'C:/repo/override-poc.local.json',
          fileExists: true,
          fileSizeBytes: Buffer.byteLength(patchedBody),
          ruleCount: 1,
          enabledRuleCount: 1,
          rules: [{
            ruleId: 'products-post-rsc',
            enabled: true,
            ruleType: 'rsc-flight',
            requestMethod: 'POST',
            matchMode: 'exact',
            targetAssetUrl: 'https://example.com/products',
            localFilePath: './products.rsc',
            resolvedLocalFilePath: 'C:/repo/products.rsc',
            contentType: 'text/x-component; charset=utf-8',
            fileExists: true,
            fileSizeBytes: Buffer.byteLength(patchedBody),
            rscFlight: {
              productionMode: 'structured-flight-v1',
              source: 'cdp-response',
              patchKind: 'string-value-text',
              textPatches: [{
                search: 'Original server-rendered products',
                replacement: 'Override server-rendered products',
                expectedCount: 1,
              }],
              originalSha256: sha256(originalBody),
              patchedSha256: sha256(patchedBody),
              originalBytes: Buffer.byteLength(originalBody),
              patchedBytes: Buffer.byteLength(patchedBody),
              contentType: 'text/x-component; charset=utf-8',
              requestHeaders: {
                rsc: '1',
              },
            },
          }],
        });
      }
      if (url.includes('/overrides/poc/asset?assetUrl=')) {
        throw new Error('Response-stage RSC fulfillment must patch the live response body instead of fetching a static asset');
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
        requestId: 'request-post-rsc',
        request: {
          method: 'POST',
          url: 'https://example.com/products',
          headers: {
            RSC: '1',
          },
        },
      },
    );
    await flushPromises();

    expect(chromeMock.sendCommand).toHaveBeenCalledWith(
      { tabId: 17 },
      'Fetch.continueRequest',
      { requestId: 'request-post-rsc' },
    );

    chromeMock.emitDebuggerEvent(
      { tabId: 17 },
      'Fetch.requestPaused',
      {
        requestId: 'request-post-rsc',
        request: {
          method: 'POST',
          url: 'https://example.com/products',
        },
        responseStatusCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'text/x-component; charset=utf-8' }],
      },
    );
    await flushPromises(8);

    expect(chromeMock.sendCommand).toHaveBeenCalledWith(
      { tabId: 17 },
      'Fetch.getResponseBody',
      { requestId: 'request-post-rsc' },
    );
    expect(chromeMock.sendCommand).toHaveBeenCalledWith(
      { tabId: 17 },
      'Fetch.fulfillRequest',
      expect.objectContaining({
        requestId: 'request-post-rsc',
        body: Buffer.from(patchedBody).toString('base64'),
      }),
    );
    const status = await controller.getStatus();
    expect(status.matchedRequests).toBe(1);
    expect(status.fulfilledRequests).toBe(1);
    expect(status.lastError).toBeFalsy();
  });

  it('continues production RSC requests when request context does not match or has extra Next context', async () => {
    const chromeMock = new ChromeOverrideMock();
    chromeMock.sendCommand.mockImplementation(async (_source, method) => {
      if (method === 'Fetch.getResponseBody') {
        return { body: '1:["$","meta",null,{"children":"prefetch-only"}]', base64Encoded: false };
      }
      return {};
    });
    vi.stubGlobal('chrome', chromeMock.chrome);
    const originalBody = '1:["$","h1",null,{"children":"Original proof"}]';
    const patchedBody = '1:["$","h1",null,{"children":"Override proof"}]';
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/overrides/poc/config')) {
        return createJsonResponse({
          ok: true,
          enabled: true,
          targetAssetUrl: 'https://example.com/about?_rsc=',
          localFilePath: './about.rsc',
          resolvedLocalFilePath: 'C:/repo/about.rsc',
          contentType: 'text/x-component; charset=utf-8',
          autoReload: false,
          configPath: 'C:/repo/override-poc.local.json',
          fileExists: true,
          fileSizeBytes: Buffer.byteLength(patchedBody),
          ruleCount: 1,
          enabledRuleCount: 1,
          rules: [{
            ruleId: 'about-rsc',
            enabled: true,
            ruleType: 'rsc-flight',
            requestMethod: 'GET',
            matchMode: 'prefix',
            targetAssetUrl: 'https://example.com/about?_rsc=',
            localFilePath: './about.rsc',
            resolvedLocalFilePath: 'C:/repo/about.rsc',
            contentType: 'text/x-component; charset=utf-8',
            fileExists: true,
            fileSizeBytes: Buffer.byteLength(patchedBody),
            rscFlight: {
              productionMode: 'structured-flight-v1',
              source: 'cdp-response',
              patchKind: 'string-value-text',
              textPatches: [{ search: 'Original proof', replacement: 'Override proof', expectedCount: 1 }],
              originalSha256: sha256(originalBody),
              patchedSha256: sha256(patchedBody),
              originalBytes: Buffer.byteLength(originalBody),
              patchedBytes: Buffer.byteLength(patchedBody),
              contentType: 'text/x-component; charset=utf-8',
              requestHeaders: {
                rsc: '1',
              },
            },
          }],
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
        requestId: 'request-rsc',
        request: {
          method: 'GET',
          url: 'https://example.com/about?_rsc=random-token',
          headers: {
            RSC: '0',
          },
        },
      },
    );
    await flushPromises();

    chromeMock.emitDebuggerEvent(
      { tabId: 17 },
      'Fetch.requestPaused',
      {
        requestId: 'request-rsc',
        request: {
          method: 'GET',
          url: 'https://example.com/about?_rsc=random-token',
        },
        responseStatusCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'text/x-component; charset=utf-8' }],
      },
    );
    await flushPromises();

    chromeMock.emitDebuggerEvent(
      { tabId: 17 },
      'Fetch.requestPaused',
      {
        requestId: 'request-rsc-prefetch',
        request: {
          method: 'GET',
          url: 'https://example.com/about?_rsc=prefetch-token',
          headers: {
            RSC: '1',
            'Next-Router-Prefetch': '1',
          },
        },
      },
    );
    await flushPromises();
    chromeMock.emitDebuggerEvent(
      { tabId: 17 },
      'Fetch.requestPaused',
      {
        requestId: 'request-rsc-prefetch',
        request: {
          method: 'GET',
          url: 'https://example.com/about?_rsc=prefetch-token',
        },
        responseStatusCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'text/x-component; charset=utf-8' }],
      },
    );
    await flushPromises();

    expect(chromeMock.sendCommand.mock.calls.some((call) => call[1] === 'Fetch.fulfillRequest')).toBe(false);
    expect(chromeMock.sendCommand).toHaveBeenCalledWith(
      { tabId: 17 },
      'Fetch.getResponseBody',
      { requestId: 'request-rsc-prefetch' },
    );
    expect(chromeMock.sendCommand).toHaveBeenCalledWith(
      { tabId: 17 },
      'Fetch.continueRequest',
      { requestId: 'request-rsc' },
    );
    const status = await controller.getStatus();
    expect(status.matchedRequests).toBe(2);
    expect(status.fulfilledRequests).toBe(0);
    expect(status.lastError).toBeFalsy();
  });

  it('continues production RSC responses when the live body no longer contains the expected patch anchor', async () => {
    const chromeMock = new ChromeOverrideMock();
    const capturedBody = '1:["$","h1",null,{"children":"Original proof"}]';
    const changedBody = '1:["$","h1",null,{"children":"Changed proof"}]';
    const patchedBody = '1:["$","h1",null,{"children":"Override proof"}]';
    chromeMock.sendCommand.mockImplementation(async (_source, method) => {
      if (method === 'Fetch.getResponseBody') {
        return { body: changedBody, base64Encoded: false };
      }
      return {};
    });
    vi.stubGlobal('chrome', chromeMock.chrome);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/overrides/poc/config')) {
        return createJsonResponse({
          ok: true,
          enabled: true,
          targetAssetUrl: 'https://example.com/about?_rsc=',
          localFilePath: './about.rsc',
          resolvedLocalFilePath: 'C:/repo/about.rsc',
          contentType: 'text/x-component; charset=utf-8',
          autoReload: false,
          configPath: 'C:/repo/override-poc.local.json',
          fileExists: true,
          fileSizeBytes: Buffer.byteLength(patchedBody),
          ruleCount: 1,
          enabledRuleCount: 1,
          rules: [{
            ruleId: 'about-rsc',
            enabled: true,
            ruleType: 'rsc-flight',
            requestMethod: 'GET',
            matchMode: 'prefix',
            targetAssetUrl: 'https://example.com/about?_rsc=',
            localFilePath: './about.rsc',
            resolvedLocalFilePath: 'C:/repo/about.rsc',
            contentType: 'text/x-component; charset=utf-8',
            fileExists: true,
            fileSizeBytes: Buffer.byteLength(patchedBody),
            rscFlight: {
              productionMode: 'structured-flight-v1',
              source: 'cdp-response',
              patchKind: 'string-value-text',
              textPatches: [{ search: 'Original proof', replacement: 'Override proof', expectedCount: 1 }],
              originalSha256: sha256(capturedBody),
              patchedSha256: sha256(patchedBody),
              originalBytes: Buffer.byteLength(capturedBody),
              patchedBytes: Buffer.byteLength(patchedBody),
              contentType: 'text/x-component; charset=utf-8',
            },
          }],
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
        requestId: 'request-rsc',
        request: {
          method: 'GET',
          url: 'https://example.com/about?_rsc=random-token',
        },
      },
    );
    await flushPromises();
    chromeMock.emitDebuggerEvent(
      { tabId: 17 },
      'Fetch.requestPaused',
      {
        requestId: 'request-rsc',
        request: {
          method: 'GET',
          url: 'https://example.com/about?_rsc=random-token',
        },
        responseStatusCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'text/x-component; charset=utf-8' }],
      },
    );
    await flushPromises(8);

    expect(chromeMock.sendCommand.mock.calls.some((call) => call[1] === 'Fetch.fulfillRequest')).toBe(false);
    expect(chromeMock.sendCommand).toHaveBeenCalledWith(
      { tabId: 17 },
      'Fetch.continueRequest',
      { requestId: 'request-rsc' },
    );
    const status = await controller.getStatus();
    expect(status.fulfilledRequests).toBe(0);
    expect(status.lastErrorCode).toBe('RSC_FLIGHT_STRUCTURAL_DRIFT');
    expect(status.lastError).toContain('matched 0 time');
  });

  it('continues production RSC responses when the patch would mutate a Flight object key', async () => {
    const chromeMock = new ChromeOverrideMock();
    const originalBody = '1:["$","h1",null,{"children":"Original proof"}]';
    const patchedBody = '1:["$","h1",null,{"content":"Original proof"}]';
    chromeMock.sendCommand.mockImplementation(async (_source, method) => {
      if (method === 'Fetch.getResponseBody') {
        return { body: originalBody, base64Encoded: false };
      }
      return {};
    });
    vi.stubGlobal('chrome', chromeMock.chrome);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/overrides/poc/config')) {
        return createJsonResponse({
          ok: true,
          enabled: true,
          targetAssetUrl: 'https://example.com/about?_rsc=',
          localFilePath: './about.rsc',
          resolvedLocalFilePath: 'C:/repo/about.rsc',
          contentType: 'text/x-component; charset=utf-8',
          autoReload: false,
          configPath: 'C:/repo/override-poc.local.json',
          fileExists: true,
          fileSizeBytes: Buffer.byteLength(patchedBody),
          ruleCount: 1,
          enabledRuleCount: 1,
          rules: [{
            ruleId: 'about-rsc',
            enabled: true,
            ruleType: 'rsc-flight',
            requestMethod: 'GET',
            matchMode: 'prefix',
            targetAssetUrl: 'https://example.com/about?_rsc=',
            localFilePath: './about.rsc',
            resolvedLocalFilePath: 'C:/repo/about.rsc',
            contentType: 'text/x-component; charset=utf-8',
            fileExists: true,
            fileSizeBytes: Buffer.byteLength(patchedBody),
            rscFlight: {
              productionMode: 'structured-flight-v1',
              source: 'cdp-response',
              patchKind: 'string-value-text',
              textPatches: [{ search: 'children', replacement: 'content', expectedCount: 1 }],
              originalSha256: sha256(originalBody),
              patchedSha256: sha256(patchedBody),
              originalBytes: Buffer.byteLength(originalBody),
              patchedBytes: Buffer.byteLength(patchedBody),
              contentType: 'text/x-component; charset=utf-8',
            },
          }],
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
        requestId: 'request-rsc',
        request: {
          method: 'GET',
          url: 'https://example.com/about?_rsc=random-token',
        },
      },
    );
    await flushPromises();
    chromeMock.emitDebuggerEvent(
      { tabId: 17 },
      'Fetch.requestPaused',
      {
        requestId: 'request-rsc',
        request: {
          method: 'GET',
          url: 'https://example.com/about?_rsc=random-token',
        },
        responseStatusCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'text/x-component; charset=utf-8' }],
      },
    );
    await flushPromises(8);

    expect(chromeMock.sendCommand.mock.calls.some((call) => call[1] === 'Fetch.fulfillRequest')).toBe(false);
    expect(chromeMock.sendCommand).toHaveBeenCalledWith(
      { tabId: 17 },
      'Fetch.continueRequest',
      { requestId: 'request-rsc' },
    );
    const status = await controller.getStatus();
    expect(status.fulfilledRequests).toBe(0);
    expect(status.lastErrorCode).toBe('RSC_PATCH_UNSAFE');
    expect(status.lastError).toContain('matched a JSON object key');
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
