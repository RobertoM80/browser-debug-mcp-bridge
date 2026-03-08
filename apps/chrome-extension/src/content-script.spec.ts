// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyAutomationIndicatorUpdate,
  BRIDGE_KIND,
  BRIDGE_SOURCE,
  executeCaptureCommand,
  installContentCapture,
} from './content-script';

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

  it('attaches traceId to UI events and posts trace_hint control to injected script', () => {
    document.body.innerHTML = '<button id="trace-button">Trace me</button>';
    const sendMessage = vi.fn((_message: unknown, callback?: () => void) => {
      callback?.();
    });
    const postSpy = vi.spyOn(window, 'postMessage');
    const cleanup = installContentCapture({ runtime: createRuntimeMock(sendMessage) });

    const button = document.getElementById('trace-button');
    expect(button).toBeTruthy();
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const clickCall = sendMessage.mock.calls.find((entry: unknown[]) => {
      const message = entry[0] as { eventType?: string };
      return message.eventType === 'click';
    });
    expect(clickCall).toBeDefined();

    const clickPayload = clickCall![0] as { data: Record<string, unknown> };
    expect(typeof clickPayload.data.traceId).toBe('string');

    const traceHintPayload = postSpy.mock.calls
      .map((entry) => entry[0] as { kind?: string; controlType?: string; data?: Record<string, unknown> })
      .find((entry) => entry.kind === 'bridge-control' && entry.controlType === 'trace_hint');
    expect(traceHintPayload).toBeDefined();
    expect(traceHintPayload?.data?.traceId).toBe(clickPayload.data.traceId);

    cleanup();
    postSpy.mockRestore();
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

  it('captures compact structured page state for buttons, inputs, and modals', () => {
    document.body.innerHTML = [
      '<main>',
      '  <button id="primary-cta" aria-pressed="true">Build targets</button>',
      '  <label for="name-field">Name</label>',
      '  <input id="name-field" type="text" placeholder="Roberto" value="Roberto Mirabella" />',
      '  <div role="dialog" aria-label="Day plan" data-testid="modal-surface">',
      '    <h2>Monday</h2>',
      '    <button>Close day</button>',
      '  </div>',
      '</main>',
    ].join('');

    const output = executeCaptureCommand(window, 'CAPTURE_PAGE_STATE', {
      maxItems: 10,
      maxTextLength: 40,
    });

    expect(output.truncated).toBe(false);
    expect(output.result.summary).toMatchObject({
      buttons: 2,
      inputs: 1,
      modals: 1,
    });
    expect((output.result.buttons as Array<Record<string, unknown>>)[0]).toMatchObject({
      text: 'Build targets',
      selector: '#primary-cta',
      pressed: true,
    });
    expect(typeof (output.result.buttons as Array<Record<string, unknown>>)[0]?.elementRef).toBe('string');
    expect((output.result.inputs as Array<Record<string, unknown>>)[0]).toMatchObject({
      label: 'Name',
      selector: '#name-field',
      type: 'text',
      valueLength: 'Roberto Mirabella'.length,
    });
    expect(typeof (output.result.inputs as Array<Record<string, unknown>>)[0]?.elementRef).toBe('string');
    expect((output.result.modals as Array<Record<string, unknown>>)[0]).toMatchObject({
      title: 'Monday',
      testId: 'modal-surface',
      buttonCount: 1,
    });
    expect(typeof (output.result.modals as Array<Record<string, unknown>>)[0]?.elementRef).toBe('string');
  });

  it('can omit DOM and styles in UI snapshot capture payload', () => {
    document.body.innerHTML = '<main><button id="buy-now">Buy</button></main>';

    const output = executeCaptureCommand(window, 'CAPTURE_UI_SNAPSHOT', {
      selector: '#buy-now',
      includeDom: false,
      includeStyles: false,
      maxBytes: 10000,
    });

    expect(output.result.mode).toMatchObject({ dom: false, png: false });
    const snapshot = output.result.snapshot as { dom?: unknown; styles?: unknown };
    expect(snapshot.dom).toBeUndefined();
    expect(snapshot.styles).toBeUndefined();
    expect(output.result.truncation).toMatchObject({ dom: false, styles: false });
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

  it('returns a structured rejection for live UI actions targeting iframes', () => {
    document.body.innerHTML = '<main><button id="buy-now">Buy now</button></main>';

    const output = executeCaptureCommand(window, 'EXECUTE_UI_ACTION', {
      action: 'click',
      traceId: 'trace-live-1',
      target: {
        selector: '#buy-now',
        frameId: 2,
      },
      input: {
        clickCount: 1,
      },
    });

    expect(output.truncated).toBe(false);
    expect(output.result).toMatchObject({
      action: 'click',
      traceId: 'trace-live-1',
      status: 'rejected',
      executionScope: 'top-document-v1',
      target: {
        selector: '#buy-now',
        frameId: 2,
      },
      failureReason: {
        code: 'unsupported_target_frame',
      },
    });
  });

  it('executes click actions and dispatches DOM click events', () => {
    document.body.innerHTML = '<button id="action-target">Run</button>';
    const button = document.getElementById('action-target') as HTMLButtonElement | null;
    expect(button).toBeTruthy();

    let clickCount = 0;
    button?.addEventListener('click', () => {
      clickCount += 1;
    });

    const output = executeCaptureCommand(window, 'EXECUTE_UI_ACTION', {
      action: 'click',
      traceId: 'trace-click-1',
      target: {
        selector: '#action-target',
      },
      input: {
        clickCount: 2,
      },
    });

    expect(clickCount).toBe(2);
    expect(output.result).toMatchObject({
      action: 'click',
      traceId: 'trace-click-1',
      status: 'succeeded',
      result: {
        clickCount: 2,
        button: 'left',
      },
    });
  });

  it('executes actions via elementRef targets from page-state capture', () => {
    document.body.innerHTML = '<button id="action-target">Run</button>';
    const button = document.getElementById('action-target') as HTMLButtonElement | null;
    expect(button).toBeTruthy();

    let clickCount = 0;
    button?.addEventListener('click', () => {
      clickCount += 1;
    });

    const pageState = executeCaptureCommand(window, 'CAPTURE_PAGE_STATE', {
      maxItems: 10,
      maxTextLength: 40,
    });
    const buttonRef = (pageState.result.buttons as Array<Record<string, unknown>>)[0]?.elementRef;

    const output = executeCaptureCommand(window, 'EXECUTE_UI_ACTION', {
      action: 'click',
      traceId: 'trace-click-ref-1',
      target: {
        elementRef: buttonRef,
      },
      input: {
        clickCount: 1,
      },
    });

    expect(clickCount).toBe(1);
    expect(output.result).toMatchObject({
      action: 'click',
      traceId: 'trace-click-ref-1',
      status: 'succeeded',
    });
  });

  it('executes input actions without exposing raw values in the result', () => {
    document.body.innerHTML = '<input id="username" type="text" value="" />';
    const input = document.getElementById('username') as HTMLInputElement | null;
    expect(input).toBeTruthy();

    let inputEvents = 0;
    let changeEvents = 0;
    input?.addEventListener('input', () => {
      inputEvents += 1;
    });
    input?.addEventListener('change', () => {
      changeEvents += 1;
    });

    const output = executeCaptureCommand(window, 'EXECUTE_UI_ACTION', {
      action: 'input',
      target: {
        selector: '#username',
      },
      input: {
        value: 'hello world',
      },
    });

    expect(input?.value).toBe('hello world');
    expect(inputEvents).toBeGreaterThan(0);
    expect(changeEvents).toBeGreaterThan(0);
    expect(output.result).toMatchObject({
      action: 'input',
      status: 'succeeded',
      result: {
        fieldType: 'text',
        valueLength: 11,
      },
    });
    expect((output.result.result as Record<string, unknown>).value).toBeUndefined();
  });

  it('rejects input actions for non-editable targets', () => {
    document.body.innerHTML = '<div id="readonly">No typing</div>';

    const output = executeCaptureCommand(window, 'EXECUTE_UI_ACTION', {
      action: 'input',
      target: {
        selector: '#readonly',
      },
      input: {
        value: 'blocked',
      },
    });

    expect(output.result).toMatchObject({
      action: 'input',
      status: 'rejected',
      failureReason: {
        code: 'target_not_editable',
      },
    });
  });

  it('executes focus, blur, keyboard, scroll, and submit actions on the live target', () => {
    document.body.innerHTML = [
      '<div id="scroll-box" style="overflow:auto;height:40px;width:40px"><div style="height:200px;width:200px"></div></div>',
      '<form id="live-form" method="post" action="/submit"><input id="live-input" type="text" /></form>',
    ].join('');

    const scrollBox = document.getElementById('scroll-box') as HTMLElement | null;
    const input = document.getElementById('live-input') as HTMLInputElement | null;
    const form = document.getElementById('live-form') as HTMLFormElement | null;
    expect(scrollBox).toBeTruthy();
    expect(input).toBeTruthy();
    expect(form).toBeTruthy();

    let focusCount = 0;
    let blurCount = 0;
    let keydownCount = 0;
    let submitCount = 0;
    input?.addEventListener('focusin', () => {
      focusCount += 1;
    });
    input?.addEventListener('focusout', () => {
      blurCount += 1;
    });
    input?.addEventListener('keydown', () => {
      keydownCount += 1;
    });
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      submitCount += 1;
    });

    Object.defineProperty(scrollBox, 'scrollTo', {
      configurable: true,
      value: ({ left, top }: { left?: number; top?: number }) => {
        Object.defineProperty(scrollBox, 'scrollLeft', { configurable: true, value: left ?? 0 });
        Object.defineProperty(scrollBox, 'scrollTop', { configurable: true, value: top ?? 0 });
      },
    });

    const focusResult = executeCaptureCommand(window, 'EXECUTE_UI_ACTION', {
      action: 'focus',
      target: { selector: '#live-input' },
    });
    const keyResult = executeCaptureCommand(window, 'EXECUTE_UI_ACTION', {
      action: 'press_key',
      target: { selector: '#live-input' },
      input: { key: 'A' },
    });
    const blurResult = executeCaptureCommand(window, 'EXECUTE_UI_ACTION', {
      action: 'blur',
      target: { selector: '#live-input' },
    });
    const scrollResult = executeCaptureCommand(window, 'EXECUTE_UI_ACTION', {
      action: 'scroll',
      target: { selector: '#scroll-box' },
      input: { x: 5, y: 80, behavior: 'smooth' },
    });
    const submitResult = executeCaptureCommand(window, 'EXECUTE_UI_ACTION', {
      action: 'submit',
      target: { selector: '#live-form' },
    });

    expect(focusCount).toBeGreaterThan(0);
    expect(blurCount).toBeGreaterThan(0);
    expect(keydownCount).toBeGreaterThan(0);
    expect(input?.value).toBe('A');
    expect(scrollBox?.scrollTop).toBe(80);
    expect(submitCount).toBe(1);
    expect(focusResult.result).toMatchObject({ status: 'succeeded', result: { focused: true } });
    expect(keyResult.result).toMatchObject({ status: 'succeeded', result: { key: 'A' } });
    expect(blurResult.result).toMatchObject({ status: 'succeeded', result: { blurred: true } });
    expect(scrollResult.result).toMatchObject({ status: 'succeeded', result: { y: 80, behavior: 'smooth' } });
    expect(submitResult.result).toMatchObject({
      status: 'succeeded',
      result: {
        submitted: true,
        method: 'post',
      },
    });
  });

  it('renders an in-page automation indicator with emergency stop while armed', () => {
    const sendMessage = vi.fn((_message: unknown, callback?: () => void) => {
      callback?.();
    });
    const runtime = createRuntimeMock(sendMessage);

    applyAutomationIndicatorUpdate(window, runtime, {
      automation: {
        enabled: true,
        allowSensitiveFields: false,
        status: 'armed',
        sessionId: 'sess-1',
      },
    });

    const indicator = document.getElementById('__bdmcp_automation_indicator__');
    expect(indicator?.textContent).toContain('Automation armed');
    expect(indicator?.textContent).toContain('Sensitive-field automation is still blocked.');

    const stopButton = indicator?.querySelector('button');
    expect(stopButton).toBeTruthy();
    stopButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(sendMessage).toHaveBeenCalledWith({ type: 'AUTOMATION_EMERGENCY_STOP' }, expect.any(Function));
  });

  it('removes the in-page automation indicator when automation returns to idle', () => {
    const runtime = createRuntimeMock(() => undefined);

    applyAutomationIndicatorUpdate(window, runtime, {
      automation: {
        enabled: true,
        allowSensitiveFields: false,
        status: 'executing',
        action: 'click',
      },
    });
    expect(document.getElementById('__bdmcp_automation_indicator__')).toBeTruthy();

    applyAutomationIndicatorUpdate(window, runtime, {
      automation: {
        enabled: false,
        allowSensitiveFields: false,
        status: 'idle',
      },
    });

    expect(document.getElementById('__bdmcp_automation_indicator__')).toBeNull();
  });
});
