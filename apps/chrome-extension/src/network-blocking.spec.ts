import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkBlockingController } from './network-blocking';
import type { NetworkBlockingRule } from '../../../libs/shared/src';

type Debuggee = { tabId?: number };
type DebugEventListener = (source: Debuggee, method: string, params?: unknown) => void;
type DebugDetachListener = (source: Debuggee, reason: string) => void;

class ChromeNetworkBlockingMock {
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

const RULES: NetworkBlockingRule[] = [
  {
    ruleId: 'api-block',
    enabled: true,
    urlContains: '/api/blocked',
    method: 'POST',
    resourceTypes: ['fetch'],
    errorReason: 'BlockedByClient',
  },
];

function createJsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function isAuditEndpoint(url: string): boolean {
  return /\/sessions\/[^/]+\/network-blocking\/(runs|requests)$/.test(url);
}

function flushPromises(times: number = 4): Promise<void> {
  return Array.from({ length: times }).reduce<Promise<void>>(
    (chain) => chain.then(() => Promise.resolve()),
    Promise.resolve(),
  ).then(() => new Promise((resolvePromise) => setTimeout(resolvePromise, 20)));
}

describe('NetworkBlockingController', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('enables debugger request interception and can reload the selected tab', async () => {
    const chromeMock = new ChromeNetworkBlockingMock();
    vi.stubGlobal('chrome', chromeMock.chrome);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (isAuditEndpoint(url)) {
        return createJsonResponse({ ok: true });
      }
      throw new Error('Unexpected fetch: ' + url);
    }));

    const controller = new NetworkBlockingController('http://127.0.0.1:8065');
    const status = await controller.enableForTab({
      sessionId: 'session-1',
      tabId: 7,
      selectedTabId: 7,
      rules: RULES,
      reload: true,
    });

    expect(chromeMock.attach).toHaveBeenCalledWith({ tabId: 7 }, '1.3');
    expect(chromeMock.sendCommand.mock.calls.map((call) => call[1])).toEqual([
      'Network.enable',
      'Fetch.enable',
      'Network.setCacheDisabled',
      'Network.clearBrowserCache',
      'Network.setBypassServiceWorker',
    ]);
    expect(chromeMock.reload).toHaveBeenCalledWith(7, { bypassCache: true });
    expect(status).toMatchObject({
      active: true,
      sessionId: 'session-1',
      tabId: 7,
      ruleCount: 1,
    });
  });

  it('fails matching paused requests with BlockedByClient and persists the request audit', async () => {
    const chromeMock = new ChromeNetworkBlockingMock();
    vi.stubGlobal('chrome', chromeMock.chrome);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (isAuditEndpoint(url)) {
        return createJsonResponse({ ok: true });
      }
      throw new Error('Unexpected fetch: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    const controller = new NetworkBlockingController('http://127.0.0.1:8065');
    await controller.enableForTab({
      sessionId: 'session-1',
      tabId: 7,
      rules: RULES,
    });

    chromeMock.emitDebuggerEvent({ tabId: 7 }, 'Fetch.requestPaused', {
      requestId: 'request-1',
      resourceType: 'Fetch',
      request: {
        url: 'https://example.com/api/blocked',
        method: 'POST',
      },
    });
    await flushPromises();

    expect(chromeMock.sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      'Fetch.failRequest',
      { requestId: 'request-1', errorReason: 'BlockedByClient' },
    );
    expect(fetchMock.mock.calls.map((call) => String(call[0])).some((url) => url.includes('/network-blocking/requests'))).toBe(true);
    expect(controller.getStatus()).toMatchObject({
      blockedRequests: 1,
      lastErrorCode: undefined,
    });
  });

  it('continues non-matching paused requests', async () => {
    const chromeMock = new ChromeNetworkBlockingMock();
    vi.stubGlobal('chrome', chromeMock.chrome);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (isAuditEndpoint(url)) {
        return createJsonResponse({ ok: true });
      }
      throw new Error('Unexpected fetch: ' + url);
    }));

    const controller = new NetworkBlockingController('http://127.0.0.1:8065');
    await controller.enableForTab({
      sessionId: 'session-1',
      tabId: 7,
      rules: RULES,
    });

    chromeMock.emitDebuggerEvent({ tabId: 7 }, 'Fetch.requestPaused', {
      requestId: 'request-2',
      resourceType: 'Fetch',
      request: {
        url: 'https://example.com/api/allowed',
        method: 'POST',
      },
    });
    await flushPromises();

    expect(chromeMock.sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      'Fetch.continueRequest',
      { requestId: 'request-2' },
    );
  });

  it('marks the run failed when Chrome detaches unexpectedly', async () => {
    const chromeMock = new ChromeNetworkBlockingMock();
    vi.stubGlobal('chrome', chromeMock.chrome);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (isAuditEndpoint(url)) {
        return createJsonResponse({ ok: true });
      }
      throw new Error('Unexpected fetch: ' + url);
    }));

    const controller = new NetworkBlockingController('http://127.0.0.1:8065');
    await controller.enableForTab({
      sessionId: 'session-1',
      tabId: 7,
      rules: RULES,
    });

    chromeMock.emitDebuggerDetach({ tabId: 7 }, 'target_closed');
    await flushPromises();

    expect(controller.getStatus().active).toBe(false);
  });
});
