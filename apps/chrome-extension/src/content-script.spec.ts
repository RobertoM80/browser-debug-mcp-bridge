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

  it('captures input and change events without exposing values', () => {
    document.body.innerHTML = '<input id="email-field" type="email" value="" />';
    const sendMessage = vi.fn((_message: unknown, callback?: () => void) => {
      callback?.();
    });
    const cleanup = installContentCapture({ runtime: createRuntimeMock(sendMessage) });

    const input = document.getElementById('email-field') as HTMLInputElement | null;
    expect(input).toBeTruthy();
    input!.value = 'secret@example.com';
    input!.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    input!.dispatchEvent(new Event('change', { bubbles: true }));

    const inputCall = sendMessage.mock.calls.find((entry: unknown[]) => {
      const message = entry[0] as { eventType?: string };
      return message.eventType === 'input';
    });
    const changeCall = sendMessage.mock.calls.find((entry: unknown[]) => {
      const message = entry[0] as { eventType?: string };
      return message.eventType === 'change';
    });

    expect(inputCall).toBeDefined();
    expect(changeCall).toBeDefined();
    const inputPayload = inputCall![0] as { data: Record<string, unknown> };
    expect(inputPayload.data.selector).toBe('#email-field');
    expect(inputPayload.data.fieldType).toBe('email');
    expect(inputPayload.data.valueLength).toBe('secret@example.com'.length);
    expect(inputPayload.data.value).toBeUndefined();

    cleanup();
  });

  it('captures submit events with form metadata', () => {
    document.body.innerHTML = '<form id="checkout" method="post" action="/submit"><button type="submit">Go</button></form>';
    const sendMessage = vi.fn((_message: unknown, callback?: () => void) => {
      callback?.();
    });
    const cleanup = installContentCapture({ runtime: createRuntimeMock(sendMessage) });

    const form = document.getElementById('checkout') as HTMLFormElement | null;
    expect(form).toBeTruthy();
    form!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));

    const submitCall = sendMessage.mock.calls.find((entry: unknown[]) => {
      const message = entry[0] as { eventType?: string };
      return message.eventType === 'submit';
    });

    expect(submitCall).toBeDefined();
    const payload = submitCall![0] as { data: Record<string, unknown> };
    expect(payload.data.selector).toBe('#checkout');
    expect(payload.data.method).toBe('post');

    cleanup();
  });

  it('captures focus and blur transitions', () => {
    document.body.innerHTML = '<input id="username" type="text" />';
    const sendMessage = vi.fn((_message: unknown, callback?: () => void) => {
      callback?.();
    });
    const cleanup = installContentCapture({ runtime: createRuntimeMock(sendMessage) });

    const input = document.getElementById('username') as HTMLInputElement | null;
    expect(input).toBeTruthy();
    input!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    input!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

    const focusCall = sendMessage.mock.calls.find((entry: unknown[]) => {
      const message = entry[0] as { eventType?: string };
      return message.eventType === 'focus';
    });
    const blurCall = sendMessage.mock.calls.find((entry: unknown[]) => {
      const message = entry[0] as { eventType?: string };
      return message.eventType === 'blur';
    });

    expect(focusCall).toBeDefined();
    expect(blurCall).toBeDefined();

    cleanup();
  });

  it('captures keydown without raw character content', () => {
    document.body.innerHTML = '<input id="note" type="text" />';
    const sendMessage = vi.fn((_message: unknown, callback?: () => void) => {
      callback?.();
    });
    const cleanup = installContentCapture({ runtime: createRuntimeMock(sendMessage) });

    const input = document.getElementById('note') as HTMLInputElement | null;
    expect(input).toBeTruthy();
    input!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a', code: 'KeyA' }));
    input!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter' }));

    const keydownCalls = sendMessage.mock.calls.filter((entry: unknown[]) => {
      const message = entry[0] as { eventType?: string };
      return message.eventType === 'keydown';
    });

    expect(keydownCalls.length).toBeGreaterThanOrEqual(1);
    const payload = keydownCalls[0]?.[0] as { data: Record<string, unknown> };
    expect(payload.data.keyClass).toBeDefined();
    if (payload.data.keyClass === 'character') {
      expect(payload.data.key).toBeUndefined();
      expect(payload.data.code).toBeUndefined();
    }

    cleanup();
  });

  it('captures scroll events with throttled position deltas', () => {
    Object.defineProperty(window, 'scrollX', { value: 0, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 120, configurable: true });
    const sendMessage = vi.fn((_message: unknown, callback?: () => void) => {
      callback?.();
    });
    const cleanup = installContentCapture({ runtime: createRuntimeMock(sendMessage) });

    Object.defineProperty(window, 'scrollY', { value: 220, configurable: true });
    window.dispatchEvent(new Event('scroll'));

    const scrollCall = sendMessage.mock.calls.find((entry: unknown[]) => {
      const message = entry[0] as { eventType?: string };
      return message.eventType === 'scroll';
    });

    expect(scrollCall).toBeDefined();
    const payload = scrollCall![0] as { data: Record<string, unknown> };
    expect(payload.data.scrollY).toBe(220);
    expect(typeof payload.data.deltaY).toBe('number');

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

  it('captures UI snapshot with timestamp, trigger, and selector context', () => {
    document.body.innerHTML = '<main><button id="buy-now">Buy</button></main>';

    const output = executeCaptureCommand(window, 'CAPTURE_UI_SNAPSHOT', {
      selector: '#buy-now',
      trigger: 'click',
      maxBytes: 10000,
    });

    expect(output.result.trigger).toBe('click');
    expect(output.result.selector).toBe('#buy-now');
    expect(output.result.url).toBe(window.location.href);
    expect(typeof output.result.timestamp).toBe('number');
    expect(output.result.mode).toMatchObject({ dom: true, png: false });
    expect(output.result.snapshot).toBeDefined();
    expect(output.result.truncation).toMatchObject({ dom: false });
  });

  it('enforces explicit request for computed-full snapshot styles', () => {
    document.body.innerHTML = '<div id="snapshot-target" style="display: block; color: rgb(0, 0, 0)"></div>';

    const downgraded = executeCaptureCommand(window, 'CAPTURE_UI_SNAPSHOT', {
      selector: '#snapshot-target',
      styleMode: 'computed-full',
      explicitStyleMode: false,
    });
    const full = executeCaptureCommand(window, 'CAPTURE_UI_SNAPSHOT', {
      selector: '#snapshot-target',
      styleMode: 'computed-full',
      explicitStyleMode: true,
    });

    const downgradedStyles = downgraded.result.snapshot as {
      styles: { mode: string; chain: Array<{ properties: Record<string, string> }> };
    };
    const fullStyles = full.result.snapshot as {
      styles: { mode: string; chain: Array<{ properties: Record<string, string> }> };
    };

    expect(downgradedStyles.styles.mode).toBe('computed-lite');
    expect(fullStyles.styles.mode).toBe('computed-full');
    expect(Object.keys(fullStyles.styles.chain[0].properties).length).toBeGreaterThanOrEqual(
      Object.keys(downgradedStyles.styles.chain[0].properties).length
    );
  });
});
