// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { installInjectedCapture } from './injected-script';

describe('injected-script capture', () => {
  it('captures console.warn and console.error events', () => {
    const postSpy = vi.spyOn(window, 'postMessage');
    const cleanup = installInjectedCapture({ win: window });

    console.warn('warn message');
    console.error('error message');

    const payloads = postSpy.mock.calls.map((entry) => entry[0] as { eventType: string; data: { level?: string } });
    const consolePayloads = payloads.filter((payload) => payload.eventType === 'console');

    expect(consolePayloads.length).toBeGreaterThanOrEqual(2);
    expect(consolePayloads.some((payload) => payload.data.level === 'warn')).toBe(true);
    expect(consolePayloads.some((payload) => payload.data.level === 'error')).toBe(true);

    cleanup();
    postSpy.mockRestore();
  });

  it('captures window error and unhandled rejection events', () => {
    const postSpy = vi.spyOn(window, 'postMessage');
    const cleanup = installInjectedCapture({ win: window });

    const errorEvent = new ErrorEvent('error', {
      message: 'Boom',
      filename: 'app.js',
      lineno: 10,
      colno: 3,
      error: new Error('Boom'),
    });
    window.dispatchEvent(errorEvent);

    const rejectionEvent = new Event('unhandledrejection') as Event & { reason?: unknown };
    rejectionEvent.reason = new Error('Rejected');
    window.dispatchEvent(rejectionEvent);

    const payloads = postSpy.mock.calls.map((entry) => entry[0] as { eventType: string; data: { source?: string } });
    const errorPayloads = payloads.filter((payload) => payload.eventType === 'error');

    expect(errorPayloads.some((payload) => payload.data.source === 'window.onerror')).toBe(true);
    expect(errorPayloads.some((payload) => payload.data.source === 'unhandledrejection')).toBe(true);

    cleanup();
    postSpy.mockRestore();
  });

  it('captures fetch metadata and classifies HTTP errors', async () => {
    const postSpy = vi.spyOn(window, 'postMessage');
    const originalFetch = window.fetch;
    window.fetch = vi.fn(async () =>
      new Response('missing', {
        status: 404,
        headers: {
          'content-length': '7',
        },
      })
    ) as typeof fetch;

    const cleanup = installInjectedCapture({ win: window });
    await window.fetch('/missing', { method: 'post' });

    const payloads = postSpy.mock.calls.map((entry) => entry[0] as { eventType: string; data: Record<string, unknown> });
    const networkPayload = payloads.find((payload) => payload.eventType === 'network');

    expect(networkPayload).toBeDefined();
    expect(networkPayload?.data.method).toBe('POST');
    expect(networkPayload?.data.initiator).toBe('fetch');
    expect(networkPayload?.data.status).toBe(404);
    expect(networkPayload?.data.errorType).toBe('http_error');
    expect(networkPayload?.data.responseSize).toBe(7);

    cleanup();
    window.fetch = originalFetch;
    postSpy.mockRestore();
  });

  it('captures fetch failures and classifies blocked requests', async () => {
    const postSpy = vi.spyOn(window, 'postMessage');
    const originalFetch = window.fetch;
    window.fetch = vi.fn(async () => {
      throw new Error('ERR_BLOCKED_BY_CLIENT');
    }) as typeof fetch;

    const cleanup = installInjectedCapture({ win: window });
    await expect(window.fetch('/api/data')).rejects.toThrow('ERR_BLOCKED_BY_CLIENT');

    const payloads = postSpy.mock.calls.map((entry) => entry[0] as { eventType: string; data: Record<string, unknown> });
    const networkPayload = payloads.find((payload) => payload.eventType === 'network');

    expect(networkPayload).toBeDefined();
    expect(networkPayload?.data.initiator).toBe('fetch');
    expect(networkPayload?.data.status).toBe(0);
    expect(networkPayload?.data.errorType).toBe('blocked');

    cleanup();
    window.fetch = originalFetch;
    postSpy.mockRestore();
  });

  it('captures xhr metadata', async () => {
    const postSpy = vi.spyOn(window, 'postMessage');

    class FakeXhr extends EventTarget {
      status = 0;
      responseText = '';

      open(_method: string, _url: string): void {
        // no-op
      }

      setRequestHeader(_name: string, _value: string): void {
        // no-op
      }

      send(): void {
        this.status = 200;
        this.responseText = 'ok';
        this.dispatchEvent(new Event('loadend'));
      }
    }

    const originalXhr = (window as Window & { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest;
    (window as Window & { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;

    const cleanup = installInjectedCapture({ win: window });

    const xhr = new FakeXhr() as unknown as XMLHttpRequest;
    xhr.open('GET', '/api/health');
    xhr.send();

    const payloads = postSpy.mock.calls.map((entry) => entry[0] as { eventType: string; data: Record<string, unknown> });
    const networkPayload = payloads.find((payload) => payload.eventType === 'network');

    expect(networkPayload).toBeDefined();
    expect(networkPayload?.data.initiator).toBe('xhr');
    expect(networkPayload?.data.method).toBe('GET');
    expect(networkPayload?.data.status).toBe(200);
    expect(networkPayload?.data.responseSize).toBe(2);

    cleanup();
    (window as Window & { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest = originalXhr;
    postSpy.mockRestore();
  });

  it('captures request and response JSON bodies when enabled via control message', async () => {
    const postSpy = vi.spyOn(window, 'postMessage');
    const originalFetch = window.fetch;
    window.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, citations: ['doc-1'] }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      })
    ) as typeof fetch;

    const cleanup = installInjectedCapture({ win: window });
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        source: 'browser-debug-mcp-bridge',
        kind: 'bridge-control',
        controlType: 'network_config',
        data: {
          captureBodies: true,
          maxBodyBytes: 2048,
        },
      },
      source: window,
    }));

    await window.fetch('/api/chat/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ prompt: 'hello' }),
    });

    const payloads = postSpy.mock.calls.map((entry) => entry[0] as { eventType: string; data: Record<string, unknown> });
    const networkPayload = payloads.find((payload) => payload.eventType === 'network');

    expect(networkPayload).toBeDefined();
    expect(networkPayload?.data.requestContentType).toBe('application/json');
    expect(networkPayload?.data.responseContentType).toBe('application/json');
    expect(networkPayload?.data.requestBodyJson).toMatchObject({ prompt: 'hello' });
    expect(networkPayload?.data.responseBodyJson).toMatchObject({ ok: true, citations: ['doc-1'] });

    cleanup();
    window.fetch = originalFetch;
    postSpy.mockRestore();
  });

  it('propagates trace hints to emitted network payloads', async () => {
    const postSpy = vi.spyOn(window, 'postMessage');
    const originalFetch = window.fetch;
    window.fetch = vi.fn(async () => new Response('ok', { status: 200 })) as typeof fetch;

    const cleanup = installInjectedCapture({ win: window });
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        source: 'browser-debug-mcp-bridge',
        kind: 'bridge-control',
        controlType: 'trace_hint',
        data: {
          traceId: 'ui-trace-123',
          eventType: 'click',
          selector: '#send-button',
          timestamp: Date.now(),
        },
      },
      source: window,
    }));

    await window.fetch('/api/chat/messages', { method: 'POST' });

    const payloads = postSpy.mock.calls.map((entry) => entry[0] as { eventType: string; data: Record<string, unknown> });
    const networkPayload = payloads.find((payload) => payload.eventType === 'network');

    expect(networkPayload).toBeDefined();
    expect(networkPayload?.data.traceId).toBe('ui-trace-123');
    expect(networkPayload?.data.traceEventType).toBe('click');
    expect(networkPayload?.data.traceSelector).toBe('#send-button');

    cleanup();
    window.fetch = originalFetch;
    postSpy.mockRestore();
  });
});
