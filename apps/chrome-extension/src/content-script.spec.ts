// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_KIND, BRIDGE_SOURCE, executeCaptureCommand, installContentCapture } from './content-script';

function createRuntimeMock(
  sendMessage: (message: unknown, callback?: () => void) => void
): { sendMessage: (message: unknown, callback?: () => void) => void } {
  return {
    sendMessage,
  };
}

describe('content-script capture', () => {
  beforeEach(() => {
    history.replaceState({}, '', '/start');
  });

  it('captures navigation events from history updates', () => {
    const sendMessage = vi.fn((_message: unknown, callback?: () => void) => {
      callback?.();
    });
    const cleanup = installContentCapture({ runtime: createRuntimeMock(sendMessage) });

    history.pushState({}, '', '/next');
    window.dispatchEvent(new PopStateEvent('popstate'));

    const eventTypes = sendMessage.mock.calls.map((entry: unknown[]) => {
      const message = entry[0] as { eventType: string };
      return message.eventType;
    });

    expect(eventTypes.filter((type: string) => type === 'navigation').length).toBeGreaterThanOrEqual(3);
    cleanup();
  });

  it('forwards injected script events to background worker', async () => {
    const sendMessage = vi.fn((_message: unknown, callback?: () => void) => {
      callback?.();
    });
    const cleanup = installContentCapture({ runtime: createRuntimeMock(sendMessage) });

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          source: BRIDGE_SOURCE,
          kind: BRIDGE_KIND,
          eventType: 'console',
          data: { level: 'error', message: 'boom' },
        },
        source: window,
      })
    );

    await Promise.resolve();

    const forwarded = sendMessage.mock.calls.find((entry: unknown[]) => {
      const message = entry[0] as { eventType?: string };
      return message.eventType === 'console';
    });

    expect(forwarded).toBeDefined();
    cleanup();
  });

  it('captures click events with selector and timestamp', () => {
    document.body.innerHTML = '<button id="cta-button">Click me</button>';
    const sendMessage = vi.fn((_message: unknown, callback?: () => void) => {
      callback?.();
    });
    const cleanup = installContentCapture({ runtime: createRuntimeMock(sendMessage) });

    const button = document.getElementById('cta-button');
    expect(button).toBeTruthy();
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const clickCall = sendMessage.mock.calls.find((entry: unknown[]) => {
      const message = entry[0] as { eventType?: string };
      return message.eventType === 'click';
    });

    expect(clickCall).toBeDefined();
    const payload = clickCall![0] as { data: { selector: string; timestamp: number } };
    expect(payload.data.selector).toBe('#cta-button');
    expect(typeof payload.data.timestamp).toBe('number');

    cleanup();
  });

  it('does not include typed text or values in click payload', () => {
    document.body.innerHTML = '<input id="secret-input" value="my-secret" />';
    const sendMessage = vi.fn((_message: unknown, callback?: () => void) => {
      callback?.();
    });
    const cleanup = installContentCapture({ runtime: createRuntimeMock(sendMessage) });

    const input = document.getElementById('secret-input');
    expect(input).toBeTruthy();
    input!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const clickCall = sendMessage.mock.calls.find((entry: unknown[]) => {
      const message = entry[0] as { eventType?: string };
      return message.eventType === 'click';
    });

    expect(clickCall).toBeDefined();
    const payload = clickCall![0] as { data: Record<string, unknown> };
    expect(payload.data.selector).toBe('#secret-input');
    expect(payload.data.value).toBeUndefined();
    expect(payload.data.typedText).toBeUndefined();

    cleanup();
  });

  it('captures DOM subtree and falls back to outline when maxBytes is exceeded', () => {
    const longText = 'x'.repeat(4000);
    document.body.innerHTML = `<div id="root"><section><p>${longText}</p></section></div>`;

    const output = executeCaptureCommand(window, 'CAPTURE_DOM_SUBTREE', {
      selector: '#root',
      maxDepth: 2,
      maxBytes: 1000,
    });

    expect(output.result.mode).toBe('outline');
    expect(output.truncated).toBe(true);
    expect(output.result.fallbackReason).toBe('maxBytes');
  });

  it('captures only requested computed style properties', () => {
    document.body.innerHTML = '<div id="target" style="display: block; visibility: visible;"></div>';

    const output = executeCaptureCommand(window, 'CAPTURE_COMPUTED_STYLES', {
      selector: '#target',
      properties: ['display', 'visibility'],
    });

    expect(output.result.selector).toBe('#target');
    expect(output.result.properties).toMatchObject({
      display: 'block',
      visibility: 'visible',
    });
  });
});
