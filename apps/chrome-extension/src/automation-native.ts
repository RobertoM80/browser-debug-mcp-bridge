import type { LiveUIActionRequest, LiveUIActionResult } from '../../../libs/mcp-contracts/src';

const NATIVE_AUTOMATION_BACKEND = 'cdp-native-v2';

type ClickButton = 'left' | 'middle' | 'right';

interface NativeClickTargetSnapshot {
  matched: boolean;
  selector?: string;
  resolvedSelector?: string;
  tagName?: string;
  textPreview?: string;
  frameId: number;
  url?: string;
  center?: {
    x: number;
    y: number;
  };
  topCenter?: {
    x: number;
    y: number;
  };
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  actionability: {
    visible: boolean;
    enabled: boolean;
    editable?: boolean;
    readOnly?: boolean;
    stable: boolean;
    inViewport: boolean;
    receivesPointerEvents: boolean;
    hitTargetMatches: boolean;
    frameCoordinateResolved?: boolean;
    failureCode?: string;
    failureMessage?: string;
    hitTargetTagName?: string;
    hitTargetSelector?: string;
    attempts?: number;
    retryable?: boolean;
  };
}

interface NativeClickExecutionOptions {
  request: Extract<LiveUIActionRequest, { action: 'click' }>;
  tab: chrome.tabs.Tab & { id: number };
  startedAt: number;
  traceId: string;
}

interface NativeHoverExecutionOptions {
  request: Extract<LiveUIActionRequest, { action: 'hover' }>;
  tab: chrome.tabs.Tab & { id: number };
  startedAt: number;
  traceId: string;
}

interface NativeInputExecutionOptions {
  request: Extract<LiveUIActionRequest, { action: 'input' }>;
  tab: chrome.tabs.Tab & { id: number };
  startedAt: number;
  traceId: string;
}

interface NativePressKeyExecutionOptions {
  request: Extract<LiveUIActionRequest, { action: 'press_key' }>;
  tab: chrome.tabs.Tab & { id: number };
  startedAt: number;
  traceId: string;
}

interface NativeSimpleExecutionOptions<TAction extends LiveUIActionRequest['action']> {
  request: Extract<LiveUIActionRequest, { action: TAction }>;
  tab: chrome.tabs.Tab & { id: number };
  startedAt: number;
  traceId: string;
}

function mouseButtonName(button: ClickButton | undefined): 'left' | 'middle' | 'right' {
  return button === 'middle' || button === 'right' ? button : 'left';
}

interface DecodedElementRef {
  selector?: string;
  frameId?: number;
}

function decodeElementRef(elementRef: string | undefined): DecodedElementRef | undefined {
  if (!elementRef?.startsWith('ref:')) {
    return undefined;
  }

  try {
    const decoded = JSON.parse(atob(elementRef.slice(4))) as { selector?: unknown; frameId?: unknown };
    return {
      selector: typeof decoded.selector === 'string' && decoded.selector.length > 0 ? decoded.selector : undefined,
      frameId:
        typeof decoded.frameId === 'number' && Number.isInteger(decoded.frameId) && decoded.frameId >= 0
          ? decoded.frameId
          : undefined,
    };
  } catch {
    return undefined;
  }
}

function resolveActionSelector(request: LiveUIActionRequest): string | undefined {
  return request.target?.selector ?? decodeElementRef(request.target?.elementRef)?.selector;
}

function resolveActionFrameId(request: LiveUIActionRequest): number {
  return request.target?.frameId ?? decodeElementRef(request.target?.elementRef)?.frameId ?? 0;
}

function buildNativeActionTarget(
  request: LiveUIActionRequest,
  tab: chrome.tabs.Tab & { id: number },
  snapshot?: NativeClickTargetSnapshot,
): LiveUIActionResult['target'] {
  return {
    matched: snapshot?.matched === true,
    selector: request.target?.selector,
    resolvedSelector: snapshot?.resolvedSelector,
    tagName: snapshot?.tagName,
    textPreview: snapshot?.textPreview,
    tabId: tab.id,
    frameId: snapshot?.frameId ?? resolveActionFrameId(request),
    url: snapshot?.url ?? tab.url ?? request.target?.url,
  };
}

function buildRejectedResult(
  request: LiveUIActionRequest,
  tab: chrome.tabs.Tab & { id: number },
  startedAt: number,
  traceId: string,
  code: string,
  message: string,
  snapshot?: NativeClickTargetSnapshot,
): LiveUIActionResult {
  return {
    action: request.action,
    traceId,
    status: 'rejected',
    executionScope: 'top-document-v1',
    startedAt,
    finishedAt: Date.now(),
    target: buildNativeActionTarget(request, tab, snapshot),
    failureReason: {
      code,
      message,
    },
    result: {
      backend: NATIVE_AUTOMATION_BACKEND,
      actionability: snapshot?.actionability,
    },
  };
}

function buildFailedResult(
  request: LiveUIActionRequest,
  tab: chrome.tabs.Tab & { id: number },
  startedAt: number,
  traceId: string,
  code: string,
  message: string,
): LiveUIActionResult {
  return {
    action: request.action,
    traceId,
    status: 'failed',
    executionScope: 'top-document-v1',
    startedAt,
    finishedAt: Date.now(),
    target: buildNativeActionTarget(request, tab),
    failureReason: {
      code,
      message,
    },
    result: {
      backend: NATIVE_AUTOMATION_BACKEND,
    },
  };
}

function buildSucceededResult(
  request: Extract<LiveUIActionRequest, { action: 'click' | 'hover' | 'input' | 'press_key' | 'focus' | 'blur' | 'scroll' | 'submit' }>,
  tab: chrome.tabs.Tab & { id: number },
  startedAt: number,
  traceId: string,
  snapshot: NativeClickTargetSnapshot,
  result: Record<string, unknown>,
): LiveUIActionResult {
  return {
    action: request.action,
    traceId,
    status: 'succeeded',
    executionScope: 'top-document-v1',
    startedAt,
    finishedAt: Date.now(),
    target: buildNativeActionTarget(request, tab, snapshot),
    result: {
      backend: NATIVE_AUTOMATION_BACKEND,
      actionability: snapshot.actionability,
      point: snapshot.center,
      ...result,
    },
  };
}

async function executeScriptInFrame<T>(
  tabId: number,
  frameId: number,
  func: (...args: unknown[]) => T | Promise<T>,
  args: unknown[] = [],
): Promise<T> {
  const results = await chrome.scripting.executeScript({
    target: frameId === 0 ? { tabId } : { tabId, frameIds: [frameId] },
    func,
    args,
  });

  const firstResult = results[0];
  if (!firstResult) {
    throw new Error('No executeScript result from target tab');
  }

  return firstResult.result as T;
}

async function inspectClickableTarget(tabId: number, frameId: number, selector: string): Promise<NativeClickTargetSnapshot> {
  return executeScriptInFrame<NativeClickTargetSnapshot>(
    tabId,
    frameId,
    async (rawSelector, rawFrameId) => {
      const selectorValue = String(rawSelector);
      const resolvedFrameId = typeof rawFrameId === 'number' && Number.isFinite(rawFrameId)
        ? Math.max(0, Math.floor(rawFrameId))
        : 0;

      const cssEscapeFallback = (value: string): string => {
        const cssApi = (globalThis as { CSS?: { escape?: (input: string) => string } }).CSS;
        if (cssApi?.escape) {
          return cssApi.escape(value);
        }
        return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
      };

      const shadowSeparator = ' >> ';
      const getLocalElementSelector = (element: Element): string => {
        if (element.id) {
          return `#${cssEscapeFallback(element.id)}`;
        }
        const testId = element.getAttribute('data-testid');
        if (testId) {
          return `[data-testid="${cssEscapeFallback(testId)}"]`;
        }
        return element.tagName.toLowerCase();
      };
      const getElementSelector = (element: Element): string => {
        const localSelector = getLocalElementSelector(element);
        const root = element.getRootNode();
        if (root instanceof ShadowRoot) {
          return `${getElementSelector(root.host)}${shadowSeparator}${localSelector}`;
        }
        return localSelector;
      };
      const queryElement = (root: Document | ShadowRoot, query: string): Element | null => {
        const parts = query
          .split(shadowSeparator)
          .map((part) => part.trim())
          .filter((part) => part.length > 0);
        if (parts.length === 0) {
          return null;
        }

        let currentRoot: Document | ShadowRoot = root;
        let currentElement: Element | null = null;
        for (const [index, part] of parts.entries()) {
          currentElement = currentRoot.querySelector(part);
          if (!currentElement) {
            return null;
          }
          if (index < parts.length - 1) {
            const shadowRoot = currentElement.shadowRoot;
            if (!shadowRoot) {
              return null;
            }
            currentRoot = shadowRoot;
          }
        }
        return currentElement;
      };

      const textPreview = (element: Element): string | undefined => {
        const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
        return text.length > 120 ? `${text.slice(0, 117)}...` : text || undefined;
      };
      const isShadowHostForTarget = (candidate: Element | null, element: Element): boolean => {
        if (!candidate) {
          return false;
        }

        let root = element.getRootNode();
        while (root instanceof ShadowRoot) {
          if (candidate === root.host || candidate.contains(root.host)) {
            return true;
          }
          root = root.host.getRootNode();
        }
        return false;
      };

      const makeFailure = (
        code: string,
        message: string,
        target: Element | null,
        overrides: Partial<NativeClickTargetSnapshot['actionability']> = {},
      ): NativeClickTargetSnapshot => ({
        matched: target instanceof Element,
        selector: selectorValue,
        resolvedSelector: target instanceof Element ? getElementSelector(target) : undefined,
        tagName: target instanceof Element ? target.tagName.toLowerCase() : undefined,
        textPreview: target instanceof Element ? textPreview(target) : undefined,
        frameId: resolvedFrameId,
        url: window.location.href,
        actionability: {
          visible: false,
          enabled: true,
          editable: undefined,
          readOnly: undefined,
          stable: false,
          inViewport: false,
          receivesPointerEvents: false,
          hitTargetMatches: false,
          ...overrides,
          failureCode: code,
          failureMessage: message,
        },
      });

      const target = queryElement(document, selectorValue);
      if (!target) {
        return makeFailure('target_not_found', 'No matching element was found for the native click target.', null);
      }

      if (!(target instanceof HTMLElement) && !(target instanceof SVGElement)) {
        return makeFailure('target_not_clickable', 'The matching element cannot receive native pointer input.', target);
      }

      target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const firstRect = target.getBoundingClientRect();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const rect = target.getBoundingClientRect();
      const stable = Math.abs(firstRect.x - rect.x) < 0.5
        && Math.abs(firstRect.y - rect.y) < 0.5
        && Math.abs(firstRect.width - rect.width) < 0.5
        && Math.abs(firstRect.height - rect.height) < 0.5;
      const style = getComputedStyle(target);
      const visible = rect.width > 0
        && rect.height > 0
        && style.visibility !== 'hidden'
        && style.display !== 'none'
        && Number(style.opacity || '1') > 0;
      const disabled = target instanceof HTMLButtonElement
        || target instanceof HTMLInputElement
        || target instanceof HTMLSelectElement
        || target instanceof HTMLTextAreaElement
        ? target.disabled
        : target.getAttribute('aria-disabled') === 'true';
      const editable = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && target.isContentEditable);
      const readOnly = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
        ? target.readOnly || target.getAttribute('aria-readonly') === 'true'
        : target.getAttribute('aria-readonly') === 'true';
      const center = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
      const topCenter = resolvedFrameId === 0 ? center : undefined;
      const inViewport = center.x >= 0
        && center.y >= 0
        && center.x <= window.innerWidth
        && center.y <= window.innerHeight;
      const receivesPointerEvents = style.pointerEvents !== 'none';
      const hitTarget = inViewport ? document.elementFromPoint(center.x, center.y) : null;
      const hitTargetMatches = hitTarget === target
        || Boolean(hitTarget && target.contains(hitTarget))
        || isShadowHostForTarget(hitTarget, target);

      const baseSnapshot: NativeClickTargetSnapshot = {
        matched: true,
        selector: selectorValue,
        resolvedSelector: getElementSelector(target),
        tagName: target.tagName.toLowerCase(),
        textPreview: textPreview(target),
        frameId: resolvedFrameId,
        url: window.location.href,
        center,
        topCenter,
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
        actionability: {
          visible,
          enabled: !disabled,
          editable,
          readOnly,
          stable,
          inViewport,
          receivesPointerEvents,
          hitTargetMatches,
          frameCoordinateResolved: resolvedFrameId === 0,
          hitTargetTagName: hitTarget instanceof Element ? hitTarget.tagName.toLowerCase() : undefined,
          hitTargetSelector: hitTarget instanceof Element ? getElementSelector(hitTarget) : undefined,
        },
      };

      if (!visible) {
        baseSnapshot.actionability.failureCode = 'target_not_visible';
        baseSnapshot.actionability.failureMessage = 'The native click target is not visible.';
      } else if (disabled) {
        baseSnapshot.actionability.failureCode = 'target_disabled';
        baseSnapshot.actionability.failureMessage = 'The native click target is disabled.';
      } else if (!stable) {
        baseSnapshot.actionability.failureCode = 'target_not_stable';
        baseSnapshot.actionability.failureMessage = 'The native click target layout did not stabilize before the action.';
      } else if (!inViewport) {
        baseSnapshot.actionability.failureCode = 'target_outside_viewport';
        baseSnapshot.actionability.failureMessage = 'The native click target center is outside the viewport.';
      } else if (!receivesPointerEvents) {
        baseSnapshot.actionability.failureCode = 'target_pointer_events_none';
        baseSnapshot.actionability.failureMessage = 'The native click target has pointer-events disabled.';
      } else if (!hitTargetMatches) {
        baseSnapshot.actionability.failureCode = 'hit_target_mismatch';
        baseSnapshot.actionability.failureMessage = 'The native click target is obscured by another element.';
      }

      return baseSnapshot;
    },
    [selector, frameId],
  );
}

function buildSucceededSimpleResult(
  request: Extract<LiveUIActionRequest, { action: 'focus' | 'blur' | 'scroll' | 'submit' }>,
  tab: chrome.tabs.Tab & { id: number },
  startedAt: number,
  traceId: string,
  snapshot: NativeClickTargetSnapshot,
  result: Record<string, unknown>,
): LiveUIActionResult {
  return buildSucceededResult(request, tab, startedAt, traceId, snapshot, result);
}

async function sendDebuggerCommand<T = unknown>(
  source: chrome.debugger.Debuggee,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const result = await chrome.debugger.sendCommand(source, method, params);
  return result as T;
}

function rejectMissingSelector(
  request: LiveUIActionRequest,
  tab: chrome.tabs.Tab & { id: number },
  startedAt: number,
  traceId: string,
): LiveUIActionResult {
  return buildRejectedResult(
    request,
    tab,
    startedAt,
    traceId,
    'native_target_selector_required',
    'Native actions require a selector or an elementRef containing a selector.',
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableActionabilityFailure(code: string | undefined): boolean {
  return code === 'target_not_found'
    || code === 'target_not_stable'
    || code === 'target_outside_viewport'
    || code === 'hit_target_mismatch';
}

async function inspectActionableTargetForRequest(
  request: LiveUIActionRequest,
  tab: chrome.tabs.Tab & { id: number },
  startedAt: number,
  traceId: string,
): Promise<{ ok: true; selector: string; snapshot: NativeClickTargetSnapshot } | { ok: false; result: LiveUIActionResult }> {
  const selector = resolveActionSelector(request);
  if (!selector) {
    return { ok: false, result: rejectMissingSelector(request, tab, startedAt, traceId) };
  }

  const frameId = resolveActionFrameId(request);
  let snapshot: NativeClickTargetSnapshot | undefined;
  try {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      snapshot = await inspectClickableTarget(tab.id, frameId, selector);
      snapshot = {
        ...snapshot,
        frameId: snapshot.frameId ?? frameId,
        actionability: {
          ...snapshot.actionability,
          attempts: attempt,
          retryable: isRetryableActionabilityFailure(snapshot.actionability.failureCode),
        },
      };

      if (!isRetryableActionabilityFailure(snapshot.actionability.failureCode) || attempt === maxAttempts) {
        break;
      }
      await sleep(75);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Native target inspection failed.';
    const looksLikeMissingFrame = /frame/i.test(message) && /not|no|cannot|missing|found/i.test(message);
    return {
      ok: false,
      result: looksLikeMissingFrame
        ? buildRejectedResult(
            request,
            tab,
            startedAt,
            traceId,
            'target_frame_not_found',
            message,
          )
        : buildFailedResult(
            request,
            tab,
            startedAt,
            traceId,
            'native_target_inspection_failed',
            message,
          ),
    };
  }

  if (!snapshot) {
    return {
      ok: false,
      result: buildFailedResult(
        request,
        tab,
        startedAt,
        traceId,
        'native_target_inspection_failed',
        'Native target inspection returned no snapshot.',
      ),
    };
  }

  const failureCode = snapshot.actionability.failureCode;
  if (failureCode) {
    return {
      ok: false,
      result: buildRejectedResult(
        request,
        tab,
        startedAt,
        traceId,
        failureCode,
        snapshot.actionability.failureMessage ?? 'The native target is not actionable.',
        snapshot,
      ),
    };
  }

  return { ok: true, selector, snapshot };
}

async function dispatchNativeClick(
  tabId: number,
  point: { x: number; y: number },
  button: ClickButton,
  clickCount: number,
): Promise<void> {
  const source: chrome.debugger.Debuggee = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(source, '1.3');
    attached = true;
    await sendDebuggerCommand(source, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      button: 'none',
      buttons: 0,
    });

    for (let index = 1; index <= clickCount; index += 1) {
      await sendDebuggerCommand(source, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: point.x,
        y: point.y,
        button,
        buttons: button === 'left' ? 1 : button === 'right' ? 2 : 4,
        clickCount: index,
      });
      await sendDebuggerCommand(source, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: point.x,
        y: point.y,
        button,
        buttons: 0,
        clickCount: index,
      });
    }
  } finally {
    if (attached) {
      await chrome.debugger.detach(source).catch(() => undefined);
    }
  }
}

async function dispatchNativeMouseMove(tabId: number, point: { x: number; y: number }): Promise<void> {
  const source: chrome.debugger.Debuggee = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(source, '1.3');
    attached = true;
    await sendDebuggerCommand(source, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      button: 'none',
      buttons: 0,
    });
  } finally {
    if (attached) {
      await chrome.debugger.detach(source).catch(() => undefined);
    }
  }
}

async function resolveSameOriginFrameOffset(
  tabId: number,
  selector: string,
  frameUrl: string | undefined,
): Promise<{ x: number; y: number } | null> {
  return executeScriptInFrame(
    tabId,
    0,
    (rawSelector, rawFrameUrl) => {
      const selectorValue = String(rawSelector);
      const frameUrlValue = typeof rawFrameUrl === 'string' && rawFrameUrl.length > 0 ? rawFrameUrl : undefined;
      const shadowSeparator = ' >> ';
      const queryElement = (root: Document | ShadowRoot, query: string): Element | null => {
        const parts = query
          .split(shadowSeparator)
          .map((part) => part.trim())
          .filter((part) => part.length > 0);
        if (parts.length === 0) {
          return null;
        }

        let currentRoot: Document | ShadowRoot = root;
        let currentElement: Element | null = null;
        for (const [index, part] of parts.entries()) {
          currentElement = currentRoot.querySelector(part);
          if (!currentElement) {
            return null;
          }
          if (index < parts.length - 1) {
            const shadowRoot = currentElement.shadowRoot;
            if (!shadowRoot) {
              return null;
            }
            currentRoot = shadowRoot;
          }
        }
        return currentElement;
      };

      const findFrameOffset = (
        rootWindow: Window,
        accumulatedX: number,
        accumulatedY: number,
      ): { x: number; y: number } | null => {
        const frameElements = Array.from(rootWindow.document.querySelectorAll('iframe, frame')) as HTMLIFrameElement[];
        for (const frameElement of frameElements) {
          try {
            const childWindow = frameElement.contentWindow;
            const childDocument = frameElement.contentDocument;
            if (!childWindow || !childDocument) {
              continue;
            }

            const frameRect = frameElement.getBoundingClientRect();
            const nextX = accumulatedX + frameRect.left;
            const nextY = accumulatedY + frameRect.top;
            const urlMatches = !frameUrlValue || childWindow.location.href === frameUrlValue;
            if (urlMatches && queryElement(childDocument, selectorValue)) {
              return {
                x: nextX,
                y: nextY,
              };
            }

            const nested = findFrameOffset(childWindow, nextX, nextY);
            if (nested) {
              return nested;
            }
          } catch {
            // Cross-origin frames cannot be inspected from the top document.
          }
        }

        return null;
      };

      return findFrameOffset(window, 0, 0);
    },
    [selector, frameUrl],
  );
}

async function runElementCommand(
  tabId: number,
  frameId: number,
  selector: string,
  command: 'focus' | 'blur' | 'scroll' | 'submit',
  input?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return executeScriptInFrame(
    tabId,
    frameId,
    (rawSelector, rawCommand, rawInput) => {
      const selectorValue = String(rawSelector);
      const commandValue = String(rawCommand);
      const inputValue = rawInput && typeof rawInput === 'object' ? rawInput as Record<string, unknown> : {};
      const shadowSeparator = ' >> ';
      const queryElement = (root: Document | ShadowRoot, query: string): Element | null => {
        const parts = query
          .split(shadowSeparator)
          .map((part) => part.trim())
          .filter((part) => part.length > 0);
        if (parts.length === 0) {
          return null;
        }

        let currentRoot: Document | ShadowRoot = root;
        let currentElement: Element | null = null;
        for (const [index, part] of parts.entries()) {
          currentElement = currentRoot.querySelector(part);
          if (!currentElement) {
            return null;
          }
          if (index < parts.length - 1) {
            const shadowRoot = currentElement.shadowRoot;
            if (!shadowRoot) {
              return null;
            }
            currentRoot = shadowRoot;
          }
        }
        return currentElement;
      };
      const target = queryElement(document, selectorValue);
      if (!target) {
        throw new Error('Native action target disappeared before execution.');
      }
      if (!(target instanceof HTMLElement)) {
        throw new Error('Native action target is not an HTMLElement.');
      }

      if (commandValue === 'focus') {
        target.focus();
        return {
          focused: document.activeElement === target,
        };
      }

      if (commandValue === 'blur') {
        target.blur();
        return {
          blurred: document.activeElement !== target,
        };
      }

      if (commandValue === 'scroll') {
        const left = typeof inputValue.x === 'number' && Number.isFinite(inputValue.x) ? inputValue.x : 0;
        const top = typeof inputValue.y === 'number' && Number.isFinite(inputValue.y) ? inputValue.y : 0;
        const behavior = inputValue.behavior === 'smooth' ? 'smooth' : 'auto';
        if (target === document.documentElement || target === document.body) {
          window.scrollTo({ left, top, behavior });
          return {
            scrollTarget: 'window',
            x: window.scrollX,
            y: window.scrollY,
            behavior,
          };
        }

        target.scrollTo({ left, top, behavior });
        return {
          scrollTarget: selectorValue,
          x: target.scrollLeft,
          y: target.scrollTop,
          behavior,
        };
      }

      const form = target instanceof HTMLFormElement
        ? target
        : target instanceof HTMLButtonElement || target instanceof HTMLInputElement
          ? target.form
          : target.closest('form');
      if (!form) {
        throw new Error('Native submit target is not associated with a form.');
      }
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
      } else {
        form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
      }
      return {
        submitted: true,
        method: (form.method || 'get').toLowerCase(),
        action: form.action || window.location.href,
      };
    },
    [selector, command, input ?? {}],
  );
}

async function focusAndSelectEditableTarget(tabId: number, frameId: number, selector: string): Promise<{ fieldType: string; valueLength: number }> {
  return executeScriptInFrame(
    tabId,
    frameId,
    (rawSelector) => {
      const selectorValue = String(rawSelector);
      const shadowSeparator = ' >> ';
      const queryElement = (root: Document | ShadowRoot, query: string): Element | null => {
        const parts = query
          .split(shadowSeparator)
          .map((part) => part.trim())
          .filter((part) => part.length > 0);
        if (parts.length === 0) {
          return null;
        }

        let currentRoot: Document | ShadowRoot = root;
        let currentElement: Element | null = null;
        for (const [index, part] of parts.entries()) {
          currentElement = currentRoot.querySelector(part);
          if (!currentElement) {
            return null;
          }
          if (index < parts.length - 1) {
            const shadowRoot = currentElement.shadowRoot;
            if (!shadowRoot) {
              return null;
            }
            currentRoot = shadowRoot;
          }
        }
        return currentElement;
      };
      const target = queryElement(document, selectorValue);
      if (!target) {
        throw new Error('Native input target disappeared before focus.');
      }
      if (!(target instanceof HTMLElement)) {
        throw new Error('Native input target is not an HTMLElement.');
      }

      target.focus();
      let fieldType = target.tagName.toLowerCase();
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        if (target.readOnly || target.getAttribute('aria-readonly') === 'true') {
          throw new Error('target_readonly: Native input target is read-only.');
        }
        fieldType = target instanceof HTMLInputElement ? (target.type || 'text') : 'textarea';
        target.select();
        return {
          fieldType,
          valueLength: target.value.length,
        };
      }

      if (target.isContentEditable) {
        fieldType = 'contenteditable';
        const range = document.createRange();
        range.selectNodeContents(target);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return {
          fieldType,
          valueLength: target.textContent?.length ?? 0,
        };
      }

      throw new Error('Native input target is not editable.');
    },
    [selector],
  );
}

async function getEditableValueLength(tabId: number, frameId: number, selector: string): Promise<number> {
  return executeScriptInFrame(
    tabId,
    frameId,
    (rawSelector) => {
      const selectorValue = String(rawSelector);
      const shadowSeparator = ' >> ';
      const queryElement = (root: Document | ShadowRoot, query: string): Element | null => {
        const parts = query
          .split(shadowSeparator)
          .map((part) => part.trim())
          .filter((part) => part.length > 0);
        if (parts.length === 0) {
          return null;
        }

        let currentRoot: Document | ShadowRoot = root;
        let currentElement: Element | null = null;
        for (const [index, part] of parts.entries()) {
          currentElement = currentRoot.querySelector(part);
          if (!currentElement) {
            return null;
          }
          if (index < parts.length - 1) {
            const shadowRoot = currentElement.shadowRoot;
            if (!shadowRoot) {
              return null;
            }
            currentRoot = shadowRoot;
          }
        }
        return currentElement;
      };
      const target = queryElement(document, selectorValue);
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return target.value.length;
      }
      if (target instanceof HTMLElement && target.isContentEditable) {
        return target.textContent?.length ?? 0;
      }
      return 0;
    },
    [selector],
  );
}

async function focusFrameForKeyboard(tabId: number, frameId: number): Promise<{ url?: string }> {
  if (frameId === 0) {
    return {};
  }

  return executeScriptInFrame(
    tabId,
    frameId,
    () => {
      window.focus();
      return {
        url: window.location.href,
      };
    },
  );
}

async function dispatchNativeTextInput(tabId: number, value: string): Promise<void> {
  const source: chrome.debugger.Debuggee = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(source, '1.3');
    attached = true;
    await sendDebuggerCommand(source, 'Input.insertText', { text: value });
  } finally {
    if (attached) {
      await chrome.debugger.detach(source).catch(() => undefined);
    }
  }
}

function keyCodeForKey(key: string): { code?: string; windowsVirtualKeyCode?: number } {
  if (/^[a-z]$/i.test(key)) {
    return {
      code: `Key${key.toUpperCase()}`,
      windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
    };
  }
  if (/^[0-9]$/.test(key)) {
    return {
      code: `Digit${key}`,
      windowsVirtualKeyCode: key.charCodeAt(0),
    };
  }

  const special: Record<string, { code: string; windowsVirtualKeyCode: number }> = {
    Enter: { code: 'Enter', windowsVirtualKeyCode: 13 },
    Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
    Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
    Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8 },
    Delete: { code: 'Delete', windowsVirtualKeyCode: 46 },
    ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
    ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38 },
    ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
    ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
    Space: { code: 'Space', windowsVirtualKeyCode: 32 },
    ' ': { code: 'Space', windowsVirtualKeyCode: 32 },
  };

  return special[key] ?? {};
}

function keyModifiers(input: Extract<LiveUIActionRequest, { action: 'press_key' }>['input']): number {
  return (input.altKey ? 1 : 0)
    | (input.ctrlKey ? 2 : 0)
    | (input.metaKey ? 4 : 0)
    | (input.shiftKey ? 8 : 0);
}

async function dispatchNativeKey(tabId: number, input: Extract<LiveUIActionRequest, { action: 'press_key' }>['input']): Promise<void> {
  const source: chrome.debugger.Debuggee = { tabId };
  const modifiers = keyModifiers(input);
  const keyCode = keyCodeForKey(input.key);
  const text = input.key.length === 1 && modifiers === 0 ? input.key : undefined;
  let attached = false;
  try {
    await chrome.debugger.attach(source, '1.3');
    attached = true;
    await sendDebuggerCommand(source, 'Input.dispatchKeyEvent', {
      type: text ? 'keyDown' : 'rawKeyDown',
      key: input.key,
      code: keyCode.code,
      windowsVirtualKeyCode: keyCode.windowsVirtualKeyCode,
      nativeVirtualKeyCode: keyCode.windowsVirtualKeyCode,
      modifiers,
      text,
      unmodifiedText: text,
    });
    await sendDebuggerCommand(source, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: input.key,
      code: keyCode.code,
      windowsVirtualKeyCode: keyCode.windowsVirtualKeyCode,
      nativeVirtualKeyCode: keyCode.windowsVirtualKeyCode,
      modifiers,
    });
  } finally {
    if (attached) {
      await chrome.debugger.detach(source).catch(() => undefined);
    }
  }
}

export async function executeNativeClickAction(options: NativeClickExecutionOptions): Promise<LiveUIActionResult> {
  const { request, tab, startedAt, traceId } = options;
  const target = await inspectActionableTargetForRequest(request, tab, startedAt, traceId);
  if (!target.ok) {
    return target.result;
  }

  let clickPoint = target.snapshot.topCenter ?? target.snapshot.center;
  let pointCoordinateSpace = target.snapshot.frameId === 0 ? 'top-document' : 'frame-local';
  if (target.snapshot.frameId !== 0 && target.snapshot.center) {
    const frameOffset = await resolveSameOriginFrameOffset(tab.id, target.selector, target.snapshot.url);
    if (!frameOffset) {
      return buildRejectedResult(
        request,
        tab,
        startedAt,
        traceId,
        'unsupported_cross_origin_frame',
        'The target frame could not be mapped to top-document coordinates. Cross-origin or inaccessible frames are not supported for native pointer actions yet.',
        target.snapshot,
      );
    }
    clickPoint = {
      x: target.snapshot.center.x + frameOffset.x,
      y: target.snapshot.center.y + frameOffset.y,
    };
    pointCoordinateSpace = 'translated-frame';
  }

  if (!clickPoint) {
    return buildRejectedResult(
      request,
      tab,
      startedAt,
      traceId,
      'target_click_point_unavailable',
      'No native click point could be computed for the target.',
      target.snapshot,
    );
  }

  try {
    const button = mouseButtonName(request.input?.button);
    const clickCount = request.input?.clickCount ?? 1;
    await dispatchNativeClick(tab.id, clickPoint, button, clickCount);
    return buildSucceededResult(request, tab, startedAt, traceId, target.snapshot, {
      clickCount,
      button,
      point: clickPoint,
      pointCoordinateSpace,
    });
  } catch (error) {
    return buildFailedResult(
      request,
      tab,
      startedAt,
      traceId,
      'native_click_dispatch_failed',
      error instanceof Error ? error.message : 'Native click dispatch failed.',
    );
  }
}

export async function executeNativeHoverAction(options: NativeHoverExecutionOptions): Promise<LiveUIActionResult> {
  const { request, tab, startedAt, traceId } = options;
  const target = await inspectActionableTargetForRequest(request, tab, startedAt, traceId);
  if (!target.ok) {
    return target.result;
  }

  let hoverPoint = target.snapshot.topCenter ?? target.snapshot.center;
  let pointCoordinateSpace = target.snapshot.frameId === 0 ? 'top-document' : 'frame-local';
  if (target.snapshot.frameId !== 0 && target.snapshot.center) {
    const frameOffset = await resolveSameOriginFrameOffset(tab.id, target.selector, target.snapshot.url);
    if (!frameOffset) {
      return buildRejectedResult(
        request,
        tab,
        startedAt,
        traceId,
        'unsupported_cross_origin_frame',
        'The target frame could not be mapped to top-document coordinates. Cross-origin or inaccessible frames are not supported for native pointer actions yet.',
        target.snapshot,
      );
    }
    hoverPoint = {
      x: target.snapshot.center.x + frameOffset.x,
      y: target.snapshot.center.y + frameOffset.y,
    };
    pointCoordinateSpace = 'translated-frame';
  }

  if (!hoverPoint) {
    return buildRejectedResult(
      request,
      tab,
      startedAt,
      traceId,
      'target_hover_point_unavailable',
      'No native hover point could be computed for the target.',
      target.snapshot,
    );
  }

  try {
    await dispatchNativeMouseMove(tab.id, hoverPoint);
    return buildSucceededResult(request, tab, startedAt, traceId, target.snapshot, {
      point: hoverPoint,
      pointCoordinateSpace,
    });
  } catch (error) {
    return buildFailedResult(
      request,
      tab,
      startedAt,
      traceId,
      'native_hover_dispatch_failed',
      error instanceof Error ? error.message : 'Native hover dispatch failed.',
    );
  }
}

export async function executeNativeInputAction(options: NativeInputExecutionOptions): Promise<LiveUIActionResult> {
  const { request, tab, startedAt, traceId } = options;
  const target = await inspectActionableTargetForRequest(request, tab, startedAt, traceId);
  if (!target.ok) {
    return target.result;
  }

  if (target.snapshot.actionability.readOnly === true) {
    return buildRejectedResult(
      request,
      tab,
      startedAt,
      traceId,
      'target_readonly',
      'Native input target is read-only.',
      target.snapshot,
    );
  }

  if (target.snapshot.actionability.editable === false) {
    return buildRejectedResult(
      request,
      tab,
      startedAt,
      traceId,
      'target_not_editable',
      'The native input target is not editable.',
      target.snapshot,
    );
  }

  let focusResult: { fieldType: string; valueLength: number };
  try {
    focusResult = await focusAndSelectEditableTarget(tab.id, target.snapshot.frameId, target.selector);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The native input target is not editable.';
    const readonlyPrefix = 'target_readonly: ';
    return buildRejectedResult(
      request,
      tab,
      startedAt,
      traceId,
      message.startsWith(readonlyPrefix) ? 'target_readonly' : 'target_not_editable',
      message.startsWith(readonlyPrefix) ? message.slice(readonlyPrefix.length) : message,
      target.snapshot,
    );
  }

  try {
    await dispatchNativeTextInput(tab.id, request.input.value);
    const valueLength = await getEditableValueLength(tab.id, target.snapshot.frameId, target.selector);
    return buildSucceededResult(request, tab, startedAt, traceId, target.snapshot, {
      fieldType: focusResult.fieldType,
      previousValueLength: focusResult.valueLength,
      valueLength,
    });
  } catch (error) {
    return buildFailedResult(
      request,
      tab,
      startedAt,
      traceId,
      'native_input_dispatch_failed',
      error instanceof Error ? error.message : 'Native input dispatch failed.',
    );
  }
}

export async function executeNativeFocusAction(options: NativeSimpleExecutionOptions<'focus'>): Promise<LiveUIActionResult> {
  const { request, tab, startedAt, traceId } = options;
  const target = await inspectActionableTargetForRequest(request, tab, startedAt, traceId);
  if (!target.ok) {
    return target.result;
  }
  try {
    const result = await runElementCommand(tab.id, target.snapshot.frameId, target.selector, 'focus');
    return buildSucceededSimpleResult(request, tab, startedAt, traceId, target.snapshot, {
      focused: result.focused === true,
    });
  } catch (error) {
    return buildFailedResult(request, tab, startedAt, traceId, 'native_focus_failed', error instanceof Error ? error.message : 'Native focus failed.');
  }
}

export async function executeNativeBlurAction(options: NativeSimpleExecutionOptions<'blur'>): Promise<LiveUIActionResult> {
  const { request, tab, startedAt, traceId } = options;
  const target = await inspectActionableTargetForRequest(request, tab, startedAt, traceId);
  if (!target.ok) {
    return target.result;
  }
  try {
    const result = await runElementCommand(tab.id, target.snapshot.frameId, target.selector, 'blur');
    return buildSucceededSimpleResult(request, tab, startedAt, traceId, target.snapshot, {
      blurred: result.blurred === true,
    });
  } catch (error) {
    return buildFailedResult(request, tab, startedAt, traceId, 'native_blur_failed', error instanceof Error ? error.message : 'Native blur failed.');
  }
}

export async function executeNativeScrollAction(options: NativeSimpleExecutionOptions<'scroll'>): Promise<LiveUIActionResult> {
  const { request, tab, startedAt, traceId } = options;
  const target = await inspectActionableTargetForRequest(request, tab, startedAt, traceId);
  if (!target.ok) {
    return target.result;
  }
  try {
    const result = await runElementCommand(tab.id, target.snapshot.frameId, target.selector, 'scroll', request.input);
    return buildSucceededSimpleResult(request, tab, startedAt, traceId, target.snapshot, result);
  } catch (error) {
    return buildFailedResult(request, tab, startedAt, traceId, 'native_scroll_failed', error instanceof Error ? error.message : 'Native scroll failed.');
  }
}

export async function executeNativeSubmitAction(options: NativeSimpleExecutionOptions<'submit'>): Promise<LiveUIActionResult> {
  const { request, tab, startedAt, traceId } = options;
  const target = await inspectActionableTargetForRequest(request, tab, startedAt, traceId);
  if (!target.ok) {
    return target.result;
  }
  try {
    const result = await runElementCommand(tab.id, target.snapshot.frameId, target.selector, 'submit');
    return buildSucceededSimpleResult(request, tab, startedAt, traceId, target.snapshot, result);
  } catch (error) {
    return buildRejectedResult(request, tab, startedAt, traceId, 'form_not_found', error instanceof Error ? error.message : 'The resolved target is not associated with a form.', target.snapshot);
  }
}

export async function executeNativePressKeyAction(options: NativePressKeyExecutionOptions): Promise<LiveUIActionResult> {
  const { request, tab, startedAt, traceId } = options;
  let snapshot: NativeClickTargetSnapshot | undefined;
  const selector = resolveActionSelector(request);
  if (selector) {
    const target = await inspectActionableTargetForRequest(request, tab, startedAt, traceId);
    if (!target.ok) {
      return target.result;
    }
    snapshot = target.snapshot;
    try {
      await runElementCommand(tab.id, target.snapshot.frameId, target.selector, 'focus');
    } catch (error) {
      return buildFailedResult(
        request,
        tab,
        startedAt,
        traceId,
        'native_key_focus_failed',
        error instanceof Error ? error.message : 'Native key target focus failed.',
      );
    }
  } else {
    try {
      await focusFrameForKeyboard(tab.id, resolveActionFrameId(request));
    } catch (error) {
      return buildRejectedResult(
        request,
        tab,
        startedAt,
        traceId,
        'target_frame_not_found',
        error instanceof Error ? error.message : 'Native key target frame could not be focused.',
      );
    }
  }

  try {
    await dispatchNativeKey(tab.id, request.input);
    return {
      action: request.action,
      traceId,
      status: 'succeeded',
      executionScope: 'top-document-v1',
      startedAt,
      finishedAt: Date.now(),
      target: snapshot
        ? buildNativeActionTarget(request, tab, snapshot)
        : {
            matched: true,
            selector: request.target?.selector,
            tabId: tab.id,
            frameId: resolveActionFrameId(request),
            url: tab.url ?? request.target?.url,
          },
      result: {
        backend: NATIVE_AUTOMATION_BACKEND,
        actionability: snapshot?.actionability,
        key: request.input.key,
        modifiers: {
          altKey: request.input.altKey === true,
          ctrlKey: request.input.ctrlKey === true,
          metaKey: request.input.metaKey === true,
          shiftKey: request.input.shiftKey === true,
        },
      },
    };
  } catch (error) {
    return buildFailedResult(
      request,
      tab,
      startedAt,
      traceId,
      'native_key_dispatch_failed',
      error instanceof Error ? error.message : 'Native key dispatch failed.',
    );
  }
}

export const nativeAutomationBackend = NATIVE_AUTOMATION_BACKEND;
