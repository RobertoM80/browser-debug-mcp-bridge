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
});
