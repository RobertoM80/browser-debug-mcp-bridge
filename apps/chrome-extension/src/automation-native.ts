import type { LiveUIActionLocator, LiveUIActionRequest, LiveUIActionResult, LiveUIActionTarget } from '../../../libs/mcp-contracts/src';

const NATIVE_AUTOMATION_BACKEND = 'cdp-native-v2';

type ClickButton = 'left' | 'middle' | 'right';

interface NativeFramePolicy {
  frameId: number;
  url?: string;
  title?: string;
  origin?: string;
  topAccessible?: boolean;
  parentAccessible?: boolean;
  sameOriginWithTop?: boolean;
  isOpaqueOrigin?: boolean;
  sandboxFlags?: string[];
  pointerActionsSupported: boolean;
  unsupportedReason?: string;
}

interface NativeClickTargetSnapshot {
  matched: boolean;
  selector?: string;
  resolvedSelector?: string;
  frameSelector?: string;
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
  framePolicy?: NativeFramePolicy;
  actionability: {
    visible: boolean;
    enabled: boolean;
    editable?: boolean;
    readOnly?: boolean;
    stable: boolean;
    inViewport: boolean;
    receivesPointerEvents: boolean;
    hitTargetMatches: boolean;
    scrolledIntoView?: boolean;
    preScrollRect?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    postScrollRect?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    boundingRect?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    intersectionRect?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    viewportRect?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    frameCoordinateResolved?: boolean;
    frameRefreshed?: boolean;
    previousFrameId?: number;
    failureCode?: string;
    failureMessage?: string;
    hitTargetTagName?: string;
    hitTargetSelector?: string;
    hitTargetTextPreview?: string;
    isCovered?: boolean;
    attempts?: number;
    retryCount?: number;
    retriedAfterDetach?: boolean;
    previousFailureCode?: string;
    retryable?: boolean;
  };
  locatorResolution?: Record<string, unknown>;
  frameResolution?: Record<string, unknown>;
}

interface FrameCoordinateTranslationRect {
  frameSelector: string;
  x: number;
  y: number;
  width: number;
  height: number;
  clientLeft: number;
  clientTop: number;
}

interface FrameCoordinateTranslationResult {
  resolved: boolean;
  frameSelector?: string;
  localFramePoint: {
    x: number;
    y: number;
  };
  translatedPoint?: {
    x: number;
    y: number;
  };
  matchedSegments?: string[];
  failedSegment?: string;
  failureCode?: string;
  frameElementRects: FrameCoordinateTranslationRect[];
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
  frameUrl?: string;
  frameTitle?: string;
  frameSelector?: string;
  frameSameOriginWithTop?: boolean;
  frameAutomationSupport?: 'native' | 'diagnostic-only';
  frameAutomationUnsupportedReason?: string;
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
      frameUrl: typeof (decoded as { frameUrl?: unknown }).frameUrl === 'string' && (decoded as { frameUrl: string }).frameUrl.length > 0
        ? (decoded as { frameUrl: string }).frameUrl
        : undefined,
      frameTitle:
        typeof (decoded as { frameTitle?: unknown }).frameTitle === 'string' && (decoded as { frameTitle: string }).frameTitle.length > 0
          ? (decoded as { frameTitle: string }).frameTitle
          : undefined,
      frameSelector:
        typeof (decoded as { frameSelector?: unknown }).frameSelector === 'string' && (decoded as { frameSelector: string }).frameSelector.length > 0
          ? (decoded as { frameSelector: string }).frameSelector
          : undefined,
      frameSameOriginWithTop:
        typeof (decoded as { frameSameOriginWithTop?: unknown }).frameSameOriginWithTop === 'boolean'
          ? (decoded as { frameSameOriginWithTop: boolean }).frameSameOriginWithTop
          : undefined,
      frameAutomationSupport:
        (decoded as { frameAutomationSupport?: unknown }).frameAutomationSupport === 'native'
          || (decoded as { frameAutomationSupport?: unknown }).frameAutomationSupport === 'diagnostic-only'
          ? (decoded as { frameAutomationSupport: 'native' | 'diagnostic-only' }).frameAutomationSupport
          : undefined,
      frameAutomationUnsupportedReason:
        typeof (decoded as { frameAutomationUnsupportedReason?: unknown }).frameAutomationUnsupportedReason === 'string'
          ? (decoded as { frameAutomationUnsupportedReason: string }).frameAutomationUnsupportedReason
          : undefined,
    };
  } catch {
    return undefined;
  }
}

function buildDecodedElementRefFramePolicy(decoded: DecodedElementRef | undefined): NativeFramePolicy | undefined {
  if (!decoded || decoded.frameAutomationSupport !== 'diagnostic-only') {
    return undefined;
  }

  const unsupportedReason = decoded.frameAutomationUnsupportedReason === 'sandboxed_opaque_origin'
    || decoded.frameAutomationUnsupportedReason === 'cross_origin_with_top'
    ? decoded.frameAutomationUnsupportedReason
    : 'cross_origin_with_top';

  return {
    frameId: decoded.frameId ?? 0,
    url: decoded.frameUrl,
    title: decoded.frameTitle,
    origin: undefined,
    topAccessible: unsupportedReason !== 'cross_origin_with_top' ? false : false,
    parentAccessible: false,
    sameOriginWithTop: decoded.frameSameOriginWithTop ?? false,
    isOpaqueOrigin: unsupportedReason === 'sandboxed_opaque_origin',
    pointerActionsSupported: false,
    unsupportedReason,
  };
}

function resolveActionSelector(request: LiveUIActionRequest): string | undefined {
  return request.target?.selector ?? decodeElementRef(request.target?.elementRef)?.selector;
}

function resolveActionFrameId(request: LiveUIActionRequest): number {
  return request.target?.frameId
    ?? request.target?.coordinates?.frameId
    ?? decodeElementRef(request.target?.elementRef)?.frameId
    ?? 0;
}

interface ActionFrameContext {
  frameId: number;
  frameSelector?: string;
  frameUrl?: string;
  frameTitle?: string;
  frameUrlContains?: string;
  frameTitleContains?: string;
}

function resolveActionFrameContext(request: LiveUIActionRequest): ActionFrameContext {
  const decoded = decodeElementRef(request.target?.elementRef);
  return {
    frameId: request.target?.frameId ?? decoded?.frameId ?? 0,
    frameSelector: request.target?.locator?.frame?.selector ?? decoded?.frameSelector,
    frameUrl: decoded?.frameUrl,
    frameTitle: decoded?.frameTitle,
    frameUrlContains: request.target?.locator?.frame?.urlContains ?? request.target?.frameUrlContains,
    frameTitleContains: request.target?.locator?.frame?.titleContains ?? request.target?.frameTitleContains,
  };
}

function buildNativeActionTarget(
  request: LiveUIActionRequest,
  tab: chrome.tabs.Tab & { id: number },
  snapshot?: NativeClickTargetSnapshot,
): LiveUIActionResult['target'] {
  return {
    matched: snapshot?.matched === true,
    selector: request.target?.selector ?? snapshot?.selector,
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
  resultOverrides: Record<string, unknown> = {},
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
      framePolicy: snapshot?.framePolicy,
      locatorResolution: snapshot?.locatorResolution,
      frameResolution: snapshot?.frameResolution,
      ...resultOverrides,
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
      framePolicy: snapshot.framePolicy,
      locatorResolution: snapshot.locatorResolution,
      frameResolution: snapshot.frameResolution,
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
      const framePathSeparator = ' => ';
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
      const resolveCurrentFrameSelector = (): string | undefined => {
        if (window === window.top) {
          return undefined;
        }

        try {
          const selectors: string[] = [];
          let currentWindow: Window | null = window;
          while (currentWindow && currentWindow !== currentWindow.top) {
            const frameElement = currentWindow.frameElement;
            if (!(frameElement instanceof Element)) {
              return undefined;
            }
            selectors.unshift(getElementSelector(frameElement));
            currentWindow = currentWindow.parent;
          }
          return selectors.length > 0 ? selectors.join(framePathSeparator) : undefined;
        } catch {
          return undefined;
        }
      };
      const currentFrameSelector = resolveCurrentFrameSelector();
      const queryElementWithDiagnostics = (
        root: Document | ShadowRoot,
        query: string,
      ): { element: Element | null; closedShadowBlocked: boolean } => {
        const parts = query
          .split(shadowSeparator)
          .map((part) => part.trim())
          .filter((part) => part.length > 0);
        if (parts.length === 0) {
          return { element: null, closedShadowBlocked: false };
        }

        let currentRoot: Document | ShadowRoot = root;
        let currentElement: Element | null = null;
        for (const [index, part] of parts.entries()) {
          currentElement = currentRoot.querySelector(part);
          if (!currentElement) {
            return { element: null, closedShadowBlocked: false };
          }
          if (index < parts.length - 1) {
            const shadowRoot = currentElement.shadowRoot;
            if (!shadowRoot) {
              return { element: null, closedShadowBlocked: true };
            }
            currentRoot = shadowRoot;
          }
        }
        return { element: currentElement, closedShadowBlocked: false };
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
      const readSandboxFlags = (): string[] | undefined => {
        try {
          const frameElement = window.frameElement;
          if (!(frameElement instanceof HTMLIFrameElement)) {
            return undefined;
          }
          const sandbox = frameElement.getAttribute('sandbox');
          if (sandbox === null) {
            return undefined;
          }
          return sandbox
            .split(/\s+/)
            .map((flag) => flag.trim())
            .filter((flag) => flag.length > 0);
        } catch {
          return undefined;
        }
      };
      const buildFramePolicy = (): NativeFramePolicy => {
        const origin = window.location.origin;
        const sandboxFlags = readSandboxFlags();
        let parentAccessible = resolvedFrameId === 0;
        let topAccessible = resolvedFrameId === 0;
        const isInspectableFromTop = (): boolean => {
          if (resolvedFrameId === 0) {
            return true;
          }

          try {
            let currentWindow: Window | null = window;
            while (currentWindow && currentWindow !== currentWindow.top) {
              const parentWindow: Window = currentWindow.parent;
              void parentWindow.document;
              currentWindow = parentWindow;
            }
            return true;
          } catch {
            return false;
          }
        };
        let sameOriginWithTop = isInspectableFromTop();

        try {
          void window.parent.location.href;
          parentAccessible = true;
        } catch {
          parentAccessible = false;
        }

        try {
          if (window.top) {
            topAccessible = true;
          }
        } catch {
          topAccessible = false;
        }

        const isOpaqueOrigin = origin === 'null' && !sameOriginWithTop;

        const pointerActionsSupported = resolvedFrameId === 0 || sameOriginWithTop;
        const unsupportedReason = pointerActionsSupported
          ? undefined
          : isOpaqueOrigin || (sandboxFlags !== undefined && !sandboxFlags.includes('allow-same-origin'))
            ? 'sandboxed_opaque_origin'
            : 'cross_origin_with_top';

        return {
          frameId: resolvedFrameId,
          url: window.location.href,
          title: document.title,
          origin,
          topAccessible,
          parentAccessible,
          sameOriginWithTop,
          isOpaqueOrigin,
          sandboxFlags,
          pointerActionsSupported,
          unsupportedReason,
        };
      };
      const framePolicy = buildFramePolicy();

      const makeFailure = (
        code: string,
        message: string,
        target: Element | null,
        overrides: Partial<NativeClickTargetSnapshot['actionability']> = {},
      ): NativeClickTargetSnapshot => ({
        matched: target instanceof Element,
        selector: selectorValue,
        resolvedSelector: target instanceof Element ? getElementSelector(target) : undefined,
        frameSelector: currentFrameSelector,
        tagName: target instanceof Element ? target.tagName.toLowerCase() : undefined,
        textPreview: target instanceof Element ? textPreview(target) : undefined,
        frameId: resolvedFrameId,
        url: window.location.href,
        framePolicy,
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
      const rectSnapshot = (rect: DOMRect | DOMRectReadOnly): { x: number; y: number; width: number; height: number } => ({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });

      const queriedTarget = queryElementWithDiagnostics(document, selectorValue);
      const target = queriedTarget.element;
      if (!target) {
        if (queriedTarget.closedShadowBlocked) {
          return makeFailure(
            'closed_shadow_root_unsupported',
            'The target selector requires traversing a closed or inaccessible shadow root, which native automation does not support.',
            null,
          );
        }
        return makeFailure('target_not_found', 'No matching element was found for the native click target.', null);
      }

      if (!(target instanceof HTMLElement) && !(target instanceof SVGElement)) {
        return makeFailure('target_not_clickable', 'The matching element cannot receive native pointer input.', target);
      }

      const preScrollRect = rectSnapshot(target.getBoundingClientRect());
      target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!target.isConnected) {
        return makeFailure(
          'target_detached',
          'The native click target detached while scrolling into view.',
          target,
          {
            scrolledIntoView: true,
            preScrollRect,
          },
        );
      }

      const firstRect = target.getBoundingClientRect();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (!target.isConnected) {
        return makeFailure(
          'target_detached',
          'The native click target detached before layout stabilized.',
          target,
          {
            scrolledIntoView: true,
            preScrollRect,
            postScrollRect: rectSnapshot(firstRect),
          },
        );
      }
      const rect = target.getBoundingClientRect();
      const postScrollRect = rectSnapshot(rect);
      const viewportRect = {
        x: 0,
        y: 0,
        width: window.innerWidth,
        height: window.innerHeight,
      };
      const intersectionRect = {
        x: Math.max(0, rect.left),
        y: Math.max(0, rect.top),
        width: Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0)),
        height: Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0)),
      };
      const stable = Math.abs(firstRect.x - rect.x) < 0.5
        && Math.abs(firstRect.y - rect.y) < 0.5
        && Math.abs(firstRect.width - rect.width) < 0.5
        && Math.abs(firstRect.height - rect.height) < 0.5;
      const style = getComputedStyle(target);
      const hasBox = rect.width > 0 && rect.height > 0;
      const styleVisible = style.visibility !== 'hidden'
        && style.display !== 'none'
        && Number(style.opacity || '1') > 0;
      const visible = hasBox && styleVisible;
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
      const isCovered = inViewport && !hitTargetMatches;

      const baseSnapshot: NativeClickTargetSnapshot = {
        matched: true,
        selector: selectorValue,
        resolvedSelector: getElementSelector(target),
        frameSelector: currentFrameSelector,
        tagName: target.tagName.toLowerCase(),
        textPreview: textPreview(target),
        frameId: resolvedFrameId,
        url: window.location.href,
        framePolicy,
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
          scrolledIntoView: Math.abs(preScrollRect.x - postScrollRect.x) >= 0.5
            || Math.abs(preScrollRect.y - postScrollRect.y) >= 0.5,
          preScrollRect,
          postScrollRect,
          boundingRect: postScrollRect,
          intersectionRect,
          viewportRect,
          frameCoordinateResolved: resolvedFrameId === 0,
          hitTargetTagName: hitTarget instanceof Element ? hitTarget.tagName.toLowerCase() : undefined,
          hitTargetSelector: hitTarget instanceof Element ? getElementSelector(hitTarget) : undefined,
          hitTargetTextPreview: hitTarget instanceof Element ? textPreview(hitTarget) : undefined,
          isCovered,
        },
      };

      if (!styleVisible) {
        baseSnapshot.actionability.failureCode = 'target_not_visible';
        baseSnapshot.actionability.failureMessage = 'The native click target is not visible.';
      } else if (!hasBox) {
        baseSnapshot.actionability.failureCode = 'zero_size_target';
        baseSnapshot.actionability.failureMessage = 'The native click target has zero size.';
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

function hasCoordinateTarget(request: LiveUIActionRequest): request is LiveUIActionRequest & {
  target: NonNullable<LiveUIActionRequest['target']> & {
    coordinates: {
      x: number;
      y: number;
      frameId?: number;
    };
  };
} {
  return typeof request.target?.coordinates?.x === 'number' && typeof request.target?.coordinates?.y === 'number';
}

async function inspectCoordinatePoint(
  tabId: number,
  x: number,
  y: number,
  frameId = 0,
): Promise<{
  url?: string;
  frameId: number;
  frameSelector?: string;
  framePolicy?: NativeFramePolicy;
  inViewport: boolean;
  point: { x: number; y: number };
  viewportRect: { x: number; y: number; width: number; height: number };
  hitTargetSelector?: string;
  hitTargetTagName?: string;
  hitTargetTextPreview?: string;
}> {
  return executeScriptInFrame(
    tabId,
    frameId,
    (rawX, rawY, rawFrameId) => {
      const point = {
        x: typeof rawX === 'number' && Number.isFinite(rawX) ? rawX : 0,
        y: typeof rawY === 'number' && Number.isFinite(rawY) ? rawY : 0,
      };
      const resolvedFrameId = typeof rawFrameId === 'number' && Number.isInteger(rawFrameId) && rawFrameId >= 0
        ? rawFrameId
        : 0;
      const cssEscapeFallback = (value: string): string => {
        const cssApi = (globalThis as { CSS?: { escape?: (input: string) => string } }).CSS;
        if (cssApi?.escape) {
          return cssApi.escape(value);
        }
        return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
      };
      const shadowSeparator = ' >> ';
      const framePathSeparator = ' => ';
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
      const resolveCurrentFrameSelector = (): string | undefined => {
        if (window === window.top) {
          return undefined;
        }

        try {
          const selectors: string[] = [];
          let currentWindow: Window | null = window;
          while (currentWindow && currentWindow !== currentWindow.top) {
            const frameElement = currentWindow.frameElement;
            if (!(frameElement instanceof Element)) {
              return undefined;
            }
            selectors.unshift(getElementSelector(frameElement));
            currentWindow = currentWindow.parent;
          }
          return selectors.length > 0 ? selectors.join(framePathSeparator) : undefined;
        } catch {
          return undefined;
        }
      };
      const buildFramePolicy = (): NativeFramePolicy => {
        const origin = window.location.origin;
        let parentAccessible = resolvedFrameId === 0;
        let topAccessible = resolvedFrameId === 0;
        let sameOriginWithTop = resolvedFrameId === 0;
        let sandboxFlags: string[] | undefined;

        try {
          void window.parent.location.href;
          parentAccessible = true;
        } catch {
          parentAccessible = false;
        }

        try {
          if (window.top) {
            topAccessible = true;
          }
        } catch {
          topAccessible = false;
        }

        try {
          let currentWindow: Window | null = window;
          while (currentWindow && currentWindow !== currentWindow.top) {
            const parentWindow: Window = currentWindow.parent;
            void parentWindow.document;
            currentWindow = parentWindow;
          }
          sameOriginWithTop = true;
        } catch {
          sameOriginWithTop = false;
        }

        try {
          const frameElement = window.frameElement;
          if (frameElement instanceof HTMLIFrameElement) {
            const sandbox = frameElement.getAttribute('sandbox');
            sandboxFlags = sandbox === null
              ? undefined
              : sandbox
                .split(/\s+/)
                .map((flag) => flag.trim())
                .filter((flag) => flag.length > 0);
          }
        } catch {
          sandboxFlags = undefined;
        }

        const isOpaqueOrigin = origin === 'null' && !sameOriginWithTop;
        const pointerActionsSupported = resolvedFrameId === 0 || sameOriginWithTop;
        const unsupportedReason = pointerActionsSupported
          ? undefined
          : isOpaqueOrigin || (sandboxFlags !== undefined && !sandboxFlags.includes('allow-same-origin'))
            ? 'sandboxed_opaque_origin'
            : 'cross_origin_with_top';

        return {
          frameId: resolvedFrameId,
          url: window.location.href,
          title: document.title,
          origin,
          topAccessible,
          parentAccessible,
          sameOriginWithTop,
          isOpaqueOrigin,
          sandboxFlags,
          pointerActionsSupported,
          unsupportedReason,
        };
      };
      const textPreview = (element: Element): string | undefined => {
        const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
        return text.length > 120 ? `${text.slice(0, 117)}...` : text || undefined;
      };
      const viewportRect = {
        x: 0,
        y: 0,
        width: window.innerWidth,
        height: window.innerHeight,
      };
      const inViewport = point.x >= 0
        && point.y >= 0
        && point.x <= window.innerWidth
        && point.y <= window.innerHeight;
      const hitTarget = inViewport ? document.elementFromPoint(point.x, point.y) : null;
      return {
        url: window.location.href,
        frameId: resolvedFrameId,
        frameSelector: resolveCurrentFrameSelector(),
        framePolicy: buildFramePolicy(),
        inViewport,
        point,
        viewportRect,
        hitTargetSelector: hitTarget instanceof Element ? getElementSelector(hitTarget) : undefined,
        hitTargetTagName: hitTarget instanceof Element ? hitTarget.tagName.toLowerCase() : undefined,
        hitTargetTextPreview: hitTarget instanceof Element ? textPreview(hitTarget) : undefined,
      };
    },
    [x, y, frameId],
  );
}

function buildCoordinateSnapshot(
  inspection: Awaited<ReturnType<typeof inspectCoordinatePoint>>,
): NativeClickTargetSnapshot {
  return {
    matched: Boolean(inspection.hitTargetSelector),
    frameSelector: inspection.frameSelector,
    resolvedSelector: inspection.hitTargetSelector,
    tagName: inspection.hitTargetTagName,
    textPreview: inspection.hitTargetTextPreview,
    frameId: inspection.frameId,
    url: inspection.url,
    framePolicy: inspection.framePolicy,
    center: inspection.point,
    topCenter: inspection.frameId === 0 ? inspection.point : undefined,
    actionability: {
      visible: inspection.inViewport,
      enabled: true,
      stable: true,
      inViewport: inspection.inViewport,
      receivesPointerEvents: true,
      hitTargetMatches: true,
      viewportRect: inspection.viewportRect,
      frameCoordinateResolved: inspection.frameId === 0,
      hitTargetTagName: inspection.hitTargetTagName,
      hitTargetSelector: inspection.hitTargetSelector,
      hitTargetTextPreview: inspection.hitTargetTextPreview,
      failureCode: inspection.inViewport ? undefined : 'target_outside_viewport',
      failureMessage: inspection.inViewport ? undefined : 'The requested coordinate is outside the current viewport.',
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableActionabilityFailure(code: string | undefined): boolean {
  return code === 'target_not_found'
    || code === 'target_detached'
    || code === 'target_not_stable'
    || code === 'target_outside_viewport'
    || code === 'hit_target_mismatch';
}

function normalizeSearchValue(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function matchesFrameText(value: string | undefined, expected: string | undefined, contains: string | undefined): boolean {
  const normalizedValue = normalizeSearchValue(value);
  const exact = normalizeSearchValue(expected);
  const partial = normalizeSearchValue(contains);
  return (!exact || normalizedValue === exact)
    && (!partial || Boolean(normalizedValue?.includes(partial)));
}

function matchesFrameSelector(value: string | undefined, expected: string | undefined): boolean {
  if (!expected) {
    return true;
  }

  if (!value) {
    return false;
  }

  const actualSegments = value
    .split('=>')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const expectedSegments = expected
    .split('=>')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (actualSegments.length === 0 || expectedSegments.length === 0) {
    return value.trim() === expected.trim();
  }

  const shorter = actualSegments.length <= expectedSegments.length ? actualSegments : expectedSegments;
  const longer = actualSegments.length <= expectedSegments.length ? expectedSegments : actualSegments;
  if (shorter.length === longer.length) {
    return shorter.every((segment, index) => segment === longer[index]);
  }

  const startIndex = longer.length - shorter.length;
  return shorter.every((segment, index) => segment === longer[startIndex + index]);
}

function hasFrameLocatorContext(context: ActionFrameContext): boolean {
  return Boolean(
    context.frameSelector
    || context.frameUrl
    || context.frameTitle
    || context.frameUrlContains
    || context.frameTitleContains,
  );
}

async function resolveFrameSelectorChainsForSelector(
  tabId: number,
  selector: string,
  frameUrl: string | undefined,
): Promise<string[]> {
  return executeScriptInFrame(
    tabId,
    0,
    (rawSelector, rawFrameUrl) => {
      const selectorValue = String(rawSelector);
      const frameUrlValue = typeof rawFrameUrl === 'string' && rawFrameUrl.length > 0 ? rawFrameUrl : undefined;
      const shadowSeparator = ' >> ';
      const framePathSeparator = ' => ';
      const cssEscapeFallback = (value: string): string => {
        const cssApi = (globalThis as { CSS?: { escape?: (input: string) => string } }).CSS;
        if (cssApi?.escape) {
          return cssApi.escape(value);
        }
        return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
      };
      const localSelector = (element: Element): string => {
        if (element.id) {
          return `#${cssEscapeFallback(element.id)}`;
        }
        const testId = element.getAttribute('data-testid');
        if (testId) {
          return `[data-testid="${cssEscapeFallback(testId)}"]`;
        }

        const parent = element.parentElement;
        const tagName = element.tagName.toLowerCase();
        if (!parent) {
          return tagName;
        }

        const sameTagSiblings = Array.from(parent.children).filter((child) => child.tagName === element.tagName);
        if (sameTagSiblings.length <= 1) {
          return tagName;
        }

        return `${tagName}:nth-of-type(${sameTagSiblings.indexOf(element) + 1})`;
      };
      const elementSelectorPath = (element: Element): string => {
        const root = element.getRootNode();
        const parts: string[] = [];
        let current: Element | null = element;
        while (current) {
          const part = localSelector(current);
          parts.unshift(part);
          if (part.startsWith('#') || part.startsWith('[data-testid=')) {
            break;
          }
          current = current.parentElement;
        }
        const localPath = parts.join(' > ');
        if (root instanceof ShadowRoot) {
          return `${elementSelectorPath(root.host)}${shadowSeparator}${localPath}`;
        }
        return localPath;
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
      const matches: string[] = [];

      const visitFrameTree = (rootWindow: Window, selectors: string[]): void => {
        const frameElements = Array.from(rootWindow.document.querySelectorAll('iframe, frame')) as HTMLIFrameElement[];
        for (const frameElement of frameElements) {
          try {
            const childWindow = frameElement.contentWindow;
            const childDocument = frameElement.contentDocument;
            if (!childWindow || !childDocument) {
              continue;
            }

            const nextSelectors = [...selectors, elementSelectorPath(frameElement)];
            if ((!frameUrlValue || childWindow.location.href === frameUrlValue) && queryElement(childDocument, selectorValue)) {
              matches.push(nextSelectors.join(framePathSeparator));
            }

            visitFrameTree(childWindow, nextSelectors);
          } catch {
            // Cross-origin frames cannot be inspected from the top document.
          }
        }
      };

      visitFrameTree(window, []);
      return matches;
    },
    [selector, frameUrl],
  );
}

interface FrameResolutionCandidate {
  frameId: number;
  selector?: string;
  url?: string;
  title?: string;
}

type FrameResolutionResult =
  | { status: 'found'; candidate: FrameResolutionCandidate; diagnostics: Record<string, unknown> }
  | { status: 'not_found'; candidates: FrameResolutionCandidate[]; diagnostics: Record<string, unknown> }
  | { status: 'ambiguous'; candidates: FrameResolutionCandidate[]; diagnostics: Record<string, unknown> };

interface NativeLocatorCandidate {
  selector: string;
  frameId: number;
  frameSelector?: string;
  url?: string;
  title?: string;
  text?: string;
  role?: string;
  name?: string;
  testId?: string;
  tagName?: string;
  type?: string;
  visible?: boolean;
  enabled?: boolean;
  disabled?: boolean;
  editable?: boolean;
  checked?: boolean;
  selected?: boolean;
  pressed?: boolean;
  expanded?: boolean;
  readOnly?: boolean;
  requiredField?: boolean;
}

interface NativeLocatorFrameResult {
  frameSelector?: string;
  url?: string;
  title?: string;
  candidates: Array<Omit<NativeLocatorCandidate, 'frameId' | 'url' | 'title'>>;
}

type NativeLocatorSelectionStrategy = 'strict-single' | 'nth' | 'first' | 'last' | 'first-non-strict';

type NativeLocatorResolutionResult =
  | {
    status: 'found';
    candidate: NativeLocatorCandidate;
    resolution: Record<string, unknown>;
  }
  | {
    status: 'not_found' | 'ambiguous';
    resolution: Record<string, unknown>;
  };

async function resolveFrameIdForTarget(
  tabId: number,
  selector: string,
  context: ActionFrameContext,
): Promise<FrameResolutionResult> {
  const results = await chrome.scripting.executeScript({
    target: {
      tabId,
      allFrames: true,
    },
    func: (rawSelector) => {
      const selectorValue = String(rawSelector);
      const shadowSeparator = ' >> ';
      const framePathSeparator = ' => ';
      const cssEscapeFallback = (value: string): string => {
        const cssApi = (globalThis as { CSS?: { escape?: (input: string) => string } }).CSS;
        if (cssApi?.escape) {
          return cssApi.escape(value);
        }
        return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
      };
      const localSelector = (element: Element): string => {
        if (element.id) {
          return `#${cssEscapeFallback(element.id)}`;
        }
        const testId = element.getAttribute('data-testid');
        if (testId) {
          return `[data-testid="${cssEscapeFallback(testId)}"]`;
        }

        const parent = element.parentElement;
        const tagName = element.tagName.toLowerCase();
        if (!parent) {
          return tagName;
        }

        const sameTagSiblings = Array.from(parent.children).filter((child) => child.tagName === element.tagName);
        if (sameTagSiblings.length <= 1) {
          return tagName;
        }

        return `${tagName}:nth-of-type(${sameTagSiblings.indexOf(element) + 1})`;
      };
      const elementSelectorPath = (element: Element): string => {
        const root = element.getRootNode();
        const parts: string[] = [];
        let current: Element | null = element;
        while (current) {
          const part = localSelector(current);
          parts.unshift(part);
          if (part.startsWith('#') || part.startsWith('[data-testid=')) {
            break;
          }
          current = current.parentElement;
        }
        const localPath = parts.join(' > ');
        if (root instanceof ShadowRoot) {
          return `${elementSelectorPath(root.host)}${shadowSeparator}${localPath}`;
        }
        return localPath;
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
      const resolveCurrentFrameSelector = (): string | undefined => {
        if (window === window.top) {
          return undefined;
        }

        try {
          const selectors: string[] = [];
          let currentWindow: Window | null = window;
          while (currentWindow && currentWindow !== currentWindow.top) {
            const frameElement = currentWindow.frameElement;
            if (!(frameElement instanceof Element)) {
              return undefined;
            }
            selectors.unshift(elementSelectorPath(frameElement));
            currentWindow = currentWindow.parent;
          }
          return selectors.length > 0 ? selectors.join(framePathSeparator) : undefined;
        } catch {
          return undefined;
        }
      };

      return {
        matched: Boolean(queryElement(document, selectorValue)),
        selector: resolveCurrentFrameSelector(),
        url: window.location.href,
        title: document.title,
      };
    },
    args: [selector],
  });

  const allCandidates = results.map((entry) => ({
    frameId: entry.frameId ?? 0,
    selector: typeof entry.result?.selector === 'string' ? entry.result.selector : undefined,
    url: typeof entry.result?.url === 'string' ? entry.result.url : undefined,
    title: typeof entry.result?.title === 'string' ? entry.result.title : undefined,
    matched: entry.result?.matched === true,
  }));
  const frameIdCandidates = context.frameId > 0
    ? allCandidates.filter((entry) => entry.frameId === context.frameId)
    : [];
  const selectorMatchedFrameIdCandidates = frameIdCandidates.filter((entry) => entry.matched);
  const frameTextCandidates = allCandidates
    .filter((entry) => matchesFrameText(entry.url, context.frameUrl, context.frameUrlContains))
    .filter((entry) => matchesFrameText(entry.title, context.frameTitle, context.frameTitleContains));
  const selectorMatchedFrameTextCandidates = frameTextCandidates.filter((entry) => entry.matched);
  const frameContextCandidates = frameTextCandidates
    .filter((entry) => matchesFrameSelector(entry.selector, context.frameSelector));
  const selectorMatchedCandidates = frameContextCandidates.filter((entry) => entry.matched);
  const searchedFrameCandidates = allCandidates.slice(0, 10).map(({ matched: _matched, ...entry }) => ({
    frameId: entry.frameId,
    frameSelector: entry.selector,
    frameUrl: entry.url,
    frameTitle: entry.title,
  }));
  const sampledCandidates = (selectorMatchedCandidates.length > 0 ? selectorMatchedCandidates : frameContextCandidates)
    .slice(0, 5)
    .map(({ matched: _matched, ...entry }) => ({
      frameId: entry.frameId,
      frameSelector: entry.selector,
      frameUrl: entry.url,
      frameTitle: entry.title,
    }));
  const buildDiagnostics = (options: {
    selectedBy: 'frame_id' | 'frame_context' | 'target_selector';
    matched?: FrameResolutionCandidate;
    finalCandidateCount: number;
  }): Record<string, unknown> => ({
    strategy: 'frame_context',
    matcher: {
      selector,
      frameId: context.frameId > 0 ? context.frameId : undefined,
      frameSelector: context.frameSelector,
      frameUrl: context.frameUrl,
      frameTitle: context.frameTitle,
      frameUrlContains: context.frameUrlContains,
      frameTitleContains: context.frameTitleContains,
    },
    searchedFrames: results.length,
    searchedFrameCandidates,
    frameIdCandidateCount: frameIdCandidates.length,
    selectorMatchedFrameIdCandidateCount: selectorMatchedFrameIdCandidates.length,
    frameTextCandidateCount: frameTextCandidates.length,
    selectorMatchedFrameTextCandidateCount: selectorMatchedFrameTextCandidates.length,
    frameContextCandidateCount: frameContextCandidates.length,
    selectorMatchedCandidateCount: selectorMatchedCandidates.length,
    matchedCandidateCount: options.finalCandidateCount,
    selectedBy: options.selectedBy,
    sampledCandidates,
    matched: options.matched
      ? {
          frameId: options.matched.frameId,
          frameSelector: options.matched.selector,
          frameUrl: options.matched.url,
          frameTitle: options.matched.title,
        }
      : undefined,
  });

  if (selectorMatchedFrameIdCandidates.length === 1) {
    const [candidate] = selectorMatchedFrameIdCandidates;
    return {
      status: 'found',
      candidate,
      diagnostics: buildDiagnostics({
        selectedBy: 'frame_id',
        matched: candidate,
        finalCandidateCount: 1,
      }),
    };
  }

  if (frameContextCandidates.length === 1) {
    const [candidate] = frameContextCandidates;
    return {
      status: 'found',
      candidate,
      diagnostics: buildDiagnostics({
        selectedBy: 'frame_context',
        matched: candidate,
        finalCandidateCount: 1,
      }),
    };
  }

  if (frameContextCandidates.length === 0 && selectorMatchedFrameTextCandidates.length === 1) {
    const [candidate] = selectorMatchedFrameTextCandidates;
    return {
      status: 'found',
      candidate,
      diagnostics: buildDiagnostics({
        selectedBy: 'target_selector',
        matched: candidate,
        finalCandidateCount: 1,
      }),
    };
  }

  if (frameContextCandidates.length === 0) {
    return {
      status: 'not_found',
      candidates: [],
      diagnostics: buildDiagnostics({
        selectedBy: 'frame_context',
        finalCandidateCount: 0,
      }),
    };
  }

  if (selectorMatchedCandidates.length === 1) {
    const [candidate] = selectorMatchedCandidates;
    return {
      status: 'found',
      candidate,
      diagnostics: buildDiagnostics({
        selectedBy: 'target_selector',
        matched: candidate,
        finalCandidateCount: 1,
      }),
    };
  }

  const finalCandidates = selectorMatchedCandidates.length > 0
    ? selectorMatchedCandidates
    : frameContextCandidates;
  return {
    status: 'ambiguous',
    candidates: finalCandidates.map(({ matched: _matched, ...entry }) => entry),
    diagnostics: buildDiagnostics({
      selectedBy: selectorMatchedCandidates.length > 0 ? 'target_selector' : 'frame_context',
      finalCandidateCount: finalCandidates.length,
    }),
  };
}

function describeNativeLocatorCandidate(candidate: NativeLocatorCandidate): Record<string, unknown> {
  return {
    selector: candidate.selector,
    frameId: candidate.frameId,
    frameSelector: candidate.frameSelector,
    frameUrl: candidate.url,
    frameTitle: candidate.title,
    text: candidate.text,
    role: candidate.role,
    name: candidate.name,
    testId: candidate.testId,
    tagName: candidate.tagName,
    type: candidate.type,
    visible: candidate.visible,
    enabled: candidate.enabled,
    disabled: candidate.disabled,
    editable: candidate.editable,
    checked: candidate.checked,
    selected: candidate.selected,
    pressed: candidate.pressed,
    expanded: candidate.expanded,
    readOnly: candidate.readOnly,
    requiredField: candidate.requiredField,
  };
}

function selectNativeLocatorCandidate(
  candidates: NativeLocatorCandidate[],
  target: LiveUIActionTarget,
): {
  candidate?: NativeLocatorCandidate;
  selectedCandidates: NativeLocatorCandidate[];
  selectedIndex?: number;
  selectionStrategy: NativeLocatorSelectionStrategy;
  outOfRange: boolean;
} {
  if (typeof target.nth === 'number') {
    return {
      candidate: candidates[target.nth],
      selectedCandidates: candidates[target.nth] ? [candidates[target.nth] as NativeLocatorCandidate] : [],
      selectedIndex: target.nth,
      selectionStrategy: 'nth',
      outOfRange: candidates[target.nth] === undefined,
    };
  }

  if (target.last === true) {
    const selectedIndex = candidates.length - 1;
    return {
      candidate: selectedIndex >= 0 ? candidates[selectedIndex] : undefined,
      selectedCandidates: selectedIndex >= 0 ? [candidates[selectedIndex] as NativeLocatorCandidate] : [],
      selectedIndex,
      selectionStrategy: 'last',
      outOfRange: selectedIndex < 0,
    };
  }

  if (target.first === true || target.strict === false) {
    return {
      candidate: candidates[0],
      selectedCandidates: candidates[0] ? [candidates[0] as NativeLocatorCandidate] : [],
      selectedIndex: 0,
      selectionStrategy: target.strict === false && target.first !== true ? 'first-non-strict' : 'first',
      outOfRange: candidates[0] === undefined,
    };
  }

  return {
    candidate: candidates.length === 1 ? candidates[0] : undefined,
    selectedCandidates: candidates,
    selectedIndex: candidates.length === 1 ? 0 : undefined,
    selectionStrategy: 'strict-single',
    outOfRange: false,
  };
}

function matchesOptionalFrameText(value: string | undefined, contains: string | undefined): boolean {
  const normalizedValue = normalizeSearchValue(value);
  const normalizedContains = normalizeSearchValue(contains);
  return !normalizedContains || Boolean(normalizedValue?.includes(normalizedContains));
}

async function resolveNativeLocatorTarget(
  tabId: number,
  target: LiveUIActionTarget,
): Promise<NativeLocatorResolutionResult | undefined> {
  const locator = target.locator;
  if (!locator) {
    return undefined;
  }

  let frameResults: chrome.scripting.InjectionResult<NativeLocatorFrameResult>[];
  try {
    frameResults = await chrome.scripting.executeScript({
      target: {
        tabId,
        allFrames: true,
      },
      func: (rawLocator, rawTarget) => {
        const locatorValue = rawLocator as LiveUIActionLocator;
        const targetValue = rawTarget as LiveUIActionTarget;
        const shadowSeparator = ' >> ';
        const framePathSeparator = ' => ';

        const cssEscapeFallback = (value: string): string => {
          const cssApi = (globalThis as { CSS?: { escape?: (input: string) => string } }).CSS;
          if (cssApi?.escape) {
            return cssApi.escape(value);
          }
          return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
        };

        const truncatePreview = (value: string | null | undefined, maxLength = 120): string | undefined => {
          if (typeof value !== 'string') {
            return undefined;
          }
          const normalized = value.replace(/\s+/g, ' ').trim();
          return normalized ? normalized.slice(0, maxLength) : undefined;
        };

        const getRootForElement = (element: Element): Document | ShadowRoot => {
          const root = element.getRootNode();
          return root instanceof ShadowRoot ? root : element.ownerDocument;
        };

        const localSelector = (element: Element): string => {
          if (element.id) {
            return `#${cssEscapeFallback(element.id)}`;
          }
          const testId = element.getAttribute('data-testid');
          if (testId) {
            return `[data-testid="${cssEscapeFallback(testId)}"]`;
          }

          const parent = element.parentElement;
          const tagName = element.tagName.toLowerCase();
          if (!parent) {
            return tagName;
          }

          const sameTagSiblings = Array.from(parent.children).filter((child) => child.tagName === element.tagName);
          if (sameTagSiblings.length <= 1) {
            return tagName;
          }

          return `${tagName}:nth-of-type(${sameTagSiblings.indexOf(element) + 1})`;
        };

        const elementSelectorPath = (element: Element): string => {
          const root = element.getRootNode();
          const parts: string[] = [];
          let current: Element | null = element;
          while (current) {
            const part = localSelector(current);
            parts.unshift(part);
            if (part.startsWith('#') || part.startsWith('[data-testid=')) {
              break;
            }
            current = current.parentElement;
          }
          const localPath = parts.join(' > ');
          if (root instanceof ShadowRoot) {
            return `${elementSelectorPath(root.host)}${shadowSeparator}${localPath}`;
          }
          return localPath;
        };
        const resolveCurrentFrameSelector = (): string | undefined => {
          if (window === window.top) {
            return undefined;
          }

          try {
            const selectors: string[] = [];
            let currentWindow: Window | null = window;
            while (currentWindow && currentWindow !== currentWindow.top) {
              const frameElement = currentWindow.frameElement;
              if (!(frameElement instanceof Element)) {
                return undefined;
              }
              selectors.unshift(elementSelectorPath(frameElement));
              currentWindow = currentWindow.parent;
            }
            return selectors.length > 0 ? selectors.join(framePathSeparator) : undefined;
          } catch {
            return undefined;
          }
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

        const queryAllElements = (root: Document | ShadowRoot, query: string): Element[] => {
          if (query.includes(shadowSeparator)) {
            const matched = queryElement(root, query);
            return matched ? [matched] : [];
          }
          return Array.from(root.querySelectorAll(query));
        };

        const collectAllElements = (root: Document | ShadowRoot): Element[] => {
          const elements: Element[] = [];
          const visit = (currentRoot: Document | ShadowRoot): void => {
            for (const element of Array.from(currentRoot.querySelectorAll('*'))) {
              elements.push(element);
              if (element.shadowRoot) {
                visit(element.shadowRoot);
              }
            }
          };
          visit(root);
          return elements;
        };

        const normalize = (value: string | undefined): string | undefined => {
          const normalized = value?.trim().toLowerCase();
          return normalized && normalized.length > 0 ? normalized : undefined;
        };

        const matchesText = (value: unknown, expected: string | undefined, exact: boolean | undefined): boolean => {
          if (!expected) {
            return true;
          }
          if (typeof value !== 'string') {
            return false;
          }
          const normalizedValue = normalize(value);
          const normalizedExpected = normalize(expected);
          return exact === true
            ? normalizedValue === normalizedExpected
            : Boolean(normalizedValue?.includes(normalizedExpected ?? ''));
        };

        const matchesLocatorMatcher = (
          value: unknown,
          matcher: LiveUIActionLocator['steps'][number]['value'],
          exact: boolean | undefined,
        ): boolean => {
          if (matcher === undefined) {
            return true;
          }
          if (typeof value !== 'string') {
            return false;
          }
          if (typeof matcher === 'string') {
            return matchesText(value, matcher, exact);
          }
          try {
            return new RegExp(matcher.pattern, matcher.flags).test(value);
          } catch {
            return false;
          }
        };

        const resolveInputLabel = (element: Element): string | undefined => {
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
            const labels = element.labels ? Array.from(element.labels) : [];
            for (const label of labels) {
              const text = truncatePreview(label.textContent);
              if (text) {
                return text;
              }
            }

            if (element.id) {
              const explicit = getRootForElement(element).querySelector(`label[for="${cssEscapeFallback(element.id)}"]`);
              const text = truncatePreview(explicit?.textContent);
              if (text) {
                return text;
              }
            }
          }

          const ariaLabel = truncatePreview(element.getAttribute('aria-label'));
          if (ariaLabel) {
            return ariaLabel;
          }

          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            return truncatePreview(element.placeholder);
          }

          return undefined;
        };

        const getNativeRole = (element: Element): string | undefined => {
          const explicitRole = truncatePreview(element.getAttribute('role'), 32);
          if (explicitRole) {
            return explicitRole.toLowerCase();
          }
          const tagName = element.tagName.toLowerCase();
          if (tagName === 'button') {
            return 'button';
          }
          if ((tagName === 'a' || tagName === 'area') && element.hasAttribute('href')) {
            return 'link';
          }
          if (tagName === 'textarea') {
            return 'textbox';
          }
          if (tagName === 'select') {
            return 'combobox';
          }
          if (element instanceof HTMLInputElement) {
            if (element.type === 'button' || element.type === 'submit' || element.type === 'reset') {
              return 'button';
            }
            if (element.type === 'checkbox' || element.type === 'radio') {
              return element.type;
            }
            if (element.type === 'range') {
              return 'slider';
            }
            return 'textbox';
          }
          if (tagName === 'img') {
            return 'img';
          }
          if (element.getAttribute('aria-modal') === 'true') {
            return 'dialog';
          }
          return undefined;
        };

        const getAltText = (element: Element): string | undefined => {
          if (element instanceof HTMLImageElement || element instanceof HTMLAreaElement || element instanceof HTMLInputElement) {
            return truncatePreview(element.getAttribute('alt'));
          }
          return undefined;
        };

        const resolveAriaLabelledBy = (element: Element): string | undefined => {
          const labelledBy = element.getAttribute('aria-labelledby');
          if (!labelledBy) {
            return undefined;
          }
          const root = getRootForElement(element);
          const parts = labelledBy
            .split(/\s+/)
            .map((id) => root.getElementById(id))
            .filter((label): label is HTMLElement => Boolean(label))
            .map((label) => truncatePreview(label.textContent))
            .filter((value): value is string => Boolean(value));
          return truncatePreview(parts.join(' '));
        };

        const accessibleName = (element: Element): string | undefined => {
          const ariaLabel = truncatePreview(element.getAttribute('aria-label'));
          if (ariaLabel) {
            return ariaLabel;
          }
          const labelledBy = resolveAriaLabelledBy(element);
          if (labelledBy) {
            return labelledBy;
          }
          const altText = getAltText(element);
          if (altText) {
            return altText;
          }
          const label = resolveInputLabel(element);
          if (label) {
            return label;
          }
          if (element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(element.type)) {
            const valueName = truncatePreview(element.value || element.getAttribute('value'));
            if (valueName) {
              return valueName;
            }
          }
          return truncatePreview(element.textContent) ?? truncatePreview(element.getAttribute('title'));
        };

        const isVisible = (element: Element): boolean => {
          if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) {
            return false;
          }
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0
            && rect.height > 0
            && style.display !== 'none'
            && style.visibility !== 'hidden'
            && Number(style.opacity || '1') > 0
            && element.getAttribute('aria-hidden') !== 'true';
        };

        const isDisabled = (element: Element): boolean => {
          if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
            return element.disabled;
          }
          return element.getAttribute('aria-disabled') === 'true';
        };

        const isEditable = (element: Element): boolean => {
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            return !isDisabled(element)
              && !element.readOnly
              && element.getAttribute('aria-readonly') !== 'true';
          }
          if (element instanceof HTMLSelectElement) {
            return !isDisabled(element);
          }
          return element instanceof HTMLElement
            && element.isContentEditable
            && element.getAttribute('aria-readonly') !== 'true';
        };

        const isChecked = (element: Element): boolean | undefined => {
          if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
            return element.checked;
          }
          const ariaChecked = element.getAttribute('aria-checked');
          if (ariaChecked === 'true') {
            return true;
          }
          if (ariaChecked === 'false') {
            return false;
          }
          return undefined;
        };

        const isSelected = (element: Element): boolean | undefined => {
          if (element instanceof HTMLOptionElement) {
            return element.selected;
          }
          const ariaSelected = element.getAttribute('aria-selected');
          if (ariaSelected === 'true') {
            return true;
          }
          if (ariaSelected === 'false') {
            return false;
          }
          return undefined;
        };

        const isPressed = (element: Element): boolean | undefined => {
          const ariaPressed = element.getAttribute('aria-pressed');
          if (ariaPressed === 'true') {
            return true;
          }
          if (ariaPressed === 'false') {
            return false;
          }
          return undefined;
        };

        const isExpanded = (element: Element): boolean | undefined => {
          const ariaExpanded = element.getAttribute('aria-expanded');
          if (ariaExpanded === 'true') {
            return true;
          }
          if (ariaExpanded === 'false') {
            return false;
          }
          return undefined;
        };

        const isReadOnly = (element: Element): boolean => {
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            return element.readOnly || element.getAttribute('aria-readonly') === 'true';
          }
          return element.getAttribute('aria-readonly') === 'true';
        };

        const isRequiredField = (element: Element): boolean => {
          if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
            return element.required || element.getAttribute('aria-required') === 'true';
          }
          return element.getAttribute('aria-required') === 'true';
        };

        const elementText = (element: Element): string | undefined => {
          if (element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(element.type)) {
            return truncatePreview(element.value || element.getAttribute('value'));
          }
          return truncatePreview(element.textContent);
        };

        const roleValue = (step: LiveUIActionLocator['steps'][number]): string | undefined => {
          if (typeof step.role === 'string') {
            return step.role;
          }
          return typeof step.value === 'string' ? step.value : undefined;
        };

        const scopeMatches = (element: Element, scope: LiveUIActionLocator['scope']): boolean => {
          if (!scope) {
            return true;
          }
          if (scope === 'focused') {
            let active: Element | null = document.activeElement;
            while (active?.shadowRoot?.activeElement) {
              active = active.shadowRoot.activeElement;
            }
            return active === element;
          }
          const role = getNativeRole(element);
          if (scope === 'buttons') {
            return role === 'button' || element instanceof HTMLButtonElement;
          }
          if (scope === 'links') {
            return role === 'link';
          }
          if (scope === 'inputs') {
            return element instanceof HTMLInputElement
              || element instanceof HTMLTextAreaElement
              || element instanceof HTMLSelectElement
              || (element instanceof HTMLElement && element.isContentEditable);
          }
          return role === 'dialog'
            || element.getAttribute('aria-modal') === 'true'
            || element instanceof HTMLDialogElement;
        };

        let candidates: Element[] | undefined;
        const allScopedElements = (): Element[] => collectAllElements(document)
          .filter((element) => scopeMatches(element, locatorValue.scope));

        const descendantElements = (roots: Element[]): Element[] => {
          const seen = new Set<Element>();
          const descendants: Element[] = [];
          const addElement = (element: Element): void => {
            if (seen.has(element)) {
              return;
            }
            seen.add(element);
            descendants.push(element);
            if (element.shadowRoot) {
              for (const shadowElement of collectAllElements(element.shadowRoot)) {
                addElement(shadowElement);
              }
            }
            for (const child of Array.from(element.querySelectorAll('*'))) {
              addElement(child);
            }
          };

          for (const root of roots) {
            if (root.shadowRoot) {
              for (const shadowElement of collectAllElements(root.shadowRoot)) {
                addElement(shadowElement);
              }
            }
            for (const child of Array.from(root.querySelectorAll('*'))) {
              addElement(child);
            }
          }
          return descendants.filter((element) => scopeMatches(element, locatorValue.scope));
        };

        const immediateAncestor = (element: Element): Element | null => {
          if (element.parentElement) {
            return element.parentElement;
          }
          const root = element.getRootNode();
          return root instanceof ShadowRoot ? root.host : null;
        };

        const ancestorElements = (roots: Element[]): Element[] => {
          const seen = new Set<Element>();
          const ancestors: Element[] = [];
          for (const root of roots) {
            let current = immediateAncestor(root);
            while (current) {
              if (!seen.has(current)) {
                seen.add(current);
                ancestors.push(current);
              }
              current = immediateAncestor(current);
            }
          }
          return ancestors.filter((element) => scopeMatches(element, locatorValue.scope));
        };

        const stepSource = (step: LiveUIActionLocator['steps'][number]): Element[] => {
          if (step.relation === 'descendant' && candidates) {
            return descendantElements(candidates);
          }
          if (step.relation === 'ancestor' && candidates) {
            return ancestorElements(candidates);
          }
          return candidates ?? allScopedElements();
        };

        const matchesCssLocator = (element: Element, matcher: string): boolean => {
          try {
            return matcher.includes(shadowSeparator)
              ? elementSelectorPath(element) === matcher
              : element.matches(matcher);
          } catch {
            return elementSelectorPath(element) === matcher;
          }
        };

        const matchesStep = (element: Element, step: LiveUIActionLocator['steps'][number]): boolean => {
          if (step.kind === 'role') {
            const expectedRole = roleValue(step)?.toLowerCase();
            return (!expectedRole || getNativeRole(element) === expectedRole)
              && matchesLocatorMatcher(accessibleName(element), step.name, step.exact);
          }
          if (step.kind === 'text') {
            return matchesLocatorMatcher(elementText(element), step.value, step.exact);
          }
          if (step.kind === 'label') {
            return matchesLocatorMatcher(resolveInputLabel(element), step.value, step.exact);
          }
          if (step.kind === 'testId') {
            return matchesLocatorMatcher(element.getAttribute('data-testid') ?? undefined, step.value, step.exact ?? true);
          }
          if (step.kind === 'placeholder') {
            const placeholder = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
              ? element.placeholder
              : undefined;
            return matchesLocatorMatcher(placeholder, step.value, step.exact);
          }
          if (step.kind === 'altText') {
            return matchesLocatorMatcher(getAltText(element), step.value, step.exact);
          }
          const matcher = step.value;
          if (typeof matcher === 'string') {
            return matchesCssLocator(element, matcher);
          }
          return matchesLocatorMatcher(elementSelectorPath(element), matcher, step.exact ?? true);
        };

        for (const step of locatorValue.steps) {
          if (step.relation === 'ancestor' && candidates) {
            candidates = candidates.filter((candidate) => {
              return ancestorElements([candidate]).some((ancestor) => matchesStep(ancestor, step));
            });
            continue;
          }

          if (step.kind === 'css') {
            const matcher = step.value;
            if (typeof matcher === 'string') {
              if (step.relation === 'descendant' && candidates) {
                candidates = stepSource(step).filter((element) => matchesCssLocator(element, matcher));
              } else if (candidates) {
                candidates = candidates.filter((element) => matchesCssLocator(element, matcher));
              } else {
                candidates = queryAllElements(document, matcher);
              }
              candidates = candidates.filter((element) => scopeMatches(element, locatorValue.scope));
            } else {
              const source = stepSource(step);
              candidates = source.filter((element) => matchesLocatorMatcher(elementSelectorPath(element), matcher, step.exact ?? true));
            }
            continue;
          }

          const source = stepSource(step);
          candidates = source.filter((element) => matchesStep(element, step));
        }

        candidates = (candidates ?? allScopedElements()).filter((element) => {
          const role = getNativeRole(element);
          const disabled = isDisabled(element);
          const checked = isChecked(element);
          const selected = isSelected(element);
          const pressed = isPressed(element);
          const expanded = isExpanded(element);
          const readOnly = isReadOnly(element);
          return matchesText(element.getAttribute('data-testid') ?? undefined, targetValue.testId, targetValue.exact)
            && matchesText(elementText(element), targetValue.textContains, targetValue.exact)
            && matchesText(resolveInputLabel(element), targetValue.labelContains, targetValue.exact)
            && matchesText(element.getAttribute('title') ?? undefined, targetValue.titleContains, targetValue.exact)
            && (!targetValue.role || role === targetValue.role.toLowerCase())
            && matchesText(accessibleName(element), targetValue.name, targetValue.exact)
            && matchesText(
              element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.placeholder : undefined,
              targetValue.placeholder,
              targetValue.exact,
            )
            && matchesText(getAltText(element), targetValue.altText, targetValue.exact)
            && (!targetValue.tagName || element.tagName.toLowerCase() === targetValue.tagName.toLowerCase())
            && (!targetValue.type || !(element instanceof HTMLInputElement) || element.type.toLowerCase() === targetValue.type.toLowerCase())
            && (targetValue.visible === undefined || isVisible(element) === targetValue.visible)
            && (targetValue.enabled === undefined || (!disabled) === targetValue.enabled)
            && (targetValue.disabled === undefined || disabled === targetValue.disabled)
            && (targetValue.editable === undefined || isEditable(element) === targetValue.editable)
            && (targetValue.checked === undefined || checked === targetValue.checked)
            && (targetValue.selected === undefined || selected === targetValue.selected)
            && (targetValue.pressed === undefined || pressed === targetValue.pressed)
            && (targetValue.expanded === undefined || expanded === targetValue.expanded)
            && (targetValue.readOnly === undefined || readOnly === targetValue.readOnly)
            && (targetValue.requiredField === undefined || isRequiredField(element) === targetValue.requiredField);
        });

        return {
          frameSelector: resolveCurrentFrameSelector(),
          url: window.location.href,
          title: document.title,
          candidates: candidates.slice(0, 200).map((element) => ({
            selector: elementSelectorPath(element),
            text: elementText(element),
            role: getNativeRole(element),
            name: accessibleName(element),
            testId: element.getAttribute('data-testid') ?? undefined,
            tagName: element.tagName.toLowerCase(),
            type: element instanceof HTMLInputElement ? element.type : undefined,
            visible: isVisible(element),
            enabled: !isDisabled(element),
            disabled: isDisabled(element),
            editable: isEditable(element),
            checked: isChecked(element),
            selected: isSelected(element),
            pressed: isPressed(element),
            expanded: isExpanded(element),
            readOnly: isReadOnly(element),
            requiredField: isRequiredField(element),
          })),
        };
      },
      args: [locator, target],
    });
  } catch {
    return {
      status: 'not_found',
      resolution: {
        strategy: 'native_locator',
        matcher: {
          locator,
        },
        matchedCandidateCount: 0,
        searchedFrames: 0,
        error: 'locator_execution_failed',
      },
    };
  }

  let candidates = frameResults
    .flatMap((entry) => {
      const result = entry.result;
      if (!result) {
        return [];
      }
      const frameId = entry.frameId ?? 0;
      return result.candidates
        .filter(() => target.frameId === undefined || target.frameId === frameId)
        .filter(() => matchesOptionalFrameText(result.url, locator.frame?.urlContains ?? target.frameUrlContains))
        .filter(() => matchesOptionalFrameText(result.title, locator.frame?.titleContains ?? target.frameTitleContains))
        .map((candidate) => ({
          ...candidate,
          frameId,
          frameSelector: result.frameSelector,
          url: result.url,
          title: result.title,
        }));
    });

  if (locator.frame?.selector && candidates.length > 0) {
    const expectedFrameSelector = locator.frame.selector;
    const enrichedCandidates = await Promise.all(
      candidates.map(async (candidate) => {
        const frameSelectors = await resolveFrameSelectorChainsForSelector(tabId, candidate.selector, candidate.url).catch(() => []);
        const frameSelectorList = Array.isArray(frameSelectors) ? frameSelectors : [];
        const matchedFrameSelector = frameSelectorList.find((frameSelector) => matchesFrameSelector(frameSelector, expectedFrameSelector));
        return matchedFrameSelector
          ? {
              ...candidate,
              frameSelector: matchedFrameSelector,
            }
          : undefined;
      }),
    );
    candidates = enrichedCandidates.filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);
  }
  const searchedFrameCandidates = frameResults
    .map((entry) => {
      const result = entry.result;
      return {
        frameId: entry.frameId ?? 0,
        frameSelector: result?.frameSelector,
        frameUrl: result?.url,
        frameTitle: result?.title,
      };
    })
    .slice(0, 10);
  const selection = selectNativeLocatorCandidate(candidates, target);
  const baseResolution = {
    strategy: 'native_locator',
    matcher: {
      locator,
      frameSelector: locator.frame?.selector,
      frameUrlContains: target.frameUrlContains,
      frameTitleContains: target.frameTitleContains,
      visible: target.visible,
      enabled: target.enabled,
      disabled: target.disabled,
      editable: target.editable,
      checked: target.checked,
      selected: target.selected,
      pressed: target.pressed,
      expanded: target.expanded,
      readOnly: target.readOnly,
      requiredField: target.requiredField,
      nth: target.nth,
      first: target.first,
      last: target.last,
      strict: target.strict,
    },
    searchedFrames: frameResults.length,
    searchedFrameCandidates,
    matchedCandidateCount: candidates.length,
    visibleCandidateCount: candidates.filter((candidate) => candidate.visible === true).length,
    enabledCandidateCount: candidates.filter((candidate) => candidate.enabled === true).length,
    editableCandidateCount: candidates.filter((candidate) => candidate.editable === true).length,
    checkedCandidateCount: candidates.filter((candidate) => candidate.checked === true).length,
    selectionStrategy: selection.selectionStrategy,
    selectedIndex: selection.selectedIndex,
  };

  if (candidates.length === 0 || selection.outOfRange) {
    return {
      status: 'not_found',
      resolution: {
        ...baseResolution,
        sampledCandidates: candidates.slice(0, 5).map(describeNativeLocatorCandidate),
      },
    };
  }

  if (!selection.candidate || selection.selectedCandidates.length > 1) {
    return {
      status: 'ambiguous',
      resolution: {
        ...baseResolution,
        sampledCandidates: selection.selectedCandidates.slice(0, 5).map(describeNativeLocatorCandidate),
      },
    };
  }

  return {
    status: 'found',
    candidate: selection.candidate,
    resolution: {
      ...baseResolution,
      matched: describeNativeLocatorCandidate(selection.candidate),
    },
  };
}

function annotateFrameRefresh(
  snapshot: NativeClickTargetSnapshot,
  previousFrameId: number | undefined,
): NativeClickTargetSnapshot {
  if (previousFrameId === undefined || previousFrameId === snapshot.frameId) {
    return snapshot;
  }

  return {
    ...snapshot,
    actionability: {
      ...snapshot.actionability,
      frameRefreshed: true,
      previousFrameId,
    },
  };
}

function annotateFrameCoordinateResolution(
  snapshot: NativeClickTargetSnapshot,
  resolved: boolean,
): NativeClickTargetSnapshot {
  return {
    ...snapshot,
    framePolicy: snapshot.framePolicy
      ? {
          ...snapshot.framePolicy,
          pointerActionsSupported: resolved || snapshot.frameId === 0,
          unsupportedReason: resolved ? undefined : snapshot.framePolicy.unsupportedReason,
        }
      : undefined,
    actionability: {
      ...snapshot.actionability,
      frameCoordinateResolved: resolved || snapshot.frameId === 0,
    },
  };
}

function buildFrameCoordinateTranslationResult(
  translation: FrameCoordinateTranslationResult | undefined,
): Record<string, unknown> | undefined {
  if (!translation) {
    return undefined;
  }

  return {
    resolved: translation.resolved,
    frameSelector: translation.frameSelector,
    localFramePoint: translation.localFramePoint,
    translatedPoint: translation.translatedPoint,
    matchedSegments: translation.matchedSegments,
    failedSegment: translation.failedSegment,
    failureCode: translation.failureCode,
    frameElementRects: translation.frameElementRects,
  };
}

function annotateActionabilityRetryMetadata(
  snapshot: NativeClickTargetSnapshot,
  options: {
    retryCount: number;
    retriedAfterDetach: boolean;
    previousFailureCode?: string;
  },
): NativeClickTargetSnapshot {
  if (options.retryCount < 1 && !options.retriedAfterDetach && !options.previousFailureCode) {
    return snapshot;
  }

  return {
    ...snapshot,
    actionability: {
      ...snapshot.actionability,
      retryCount: options.retryCount > 0 ? options.retryCount : undefined,
      retriedAfterDetach: options.retriedAfterDetach || undefined,
      previousFailureCode: options.previousFailureCode,
    },
  };
}

async function inspectActionableTargetForRequest(
  request: LiveUIActionRequest,
  tab: chrome.tabs.Tab & { id: number },
  startedAt: number,
  traceId: string,
): Promise<{ ok: true; selector: string; snapshot: NativeClickTargetSnapshot } | { ok: false; result: LiveUIActionResult }> {
  let selector = resolveActionSelector(request);
  let locatorResolution: Record<string, unknown> | undefined;
  let locatorFrameId: number | undefined;
  if (!selector && request.target?.locator) {
    const resolvedLocator = await resolveNativeLocatorTarget(tab.id, request.target);
    if (resolvedLocator?.status === 'found') {
      selector = resolvedLocator.candidate.selector;
      locatorFrameId = resolvedLocator.candidate.frameId;
      locatorResolution = resolvedLocator.resolution;
    } else if (resolvedLocator?.status === 'ambiguous') {
      return {
        ok: false,
        result: buildRejectedResult(
          request,
          tab,
          startedAt,
          traceId,
          'target_locator_ambiguous',
          'Native locator matched multiple elements; refine the locator or provide nth, first, last, or strict:false.',
          undefined,
          {
            locatorResolution: resolvedLocator.resolution,
          },
        ),
      };
    } else {
      return {
        ok: false,
        result: buildRejectedResult(
          request,
          tab,
          startedAt,
          traceId,
          'target_locator_not_found',
          'No element matched the native locator target.',
          undefined,
          {
            locatorResolution: resolvedLocator?.resolution ?? {
              strategy: 'native_locator',
              matcher: {
                locator: request.target.locator,
              },
              matchedCandidateCount: 0,
            },
          },
        ),
      };
    }
  }

  if (!selector) {
    return { ok: false, result: rejectMissingSelector(request, tab, startedAt, traceId) };
  }

  const frameContext = resolveActionFrameContext(request);
  const decodedElementRef = decodeElementRef(request.target?.elementRef);
  const decodedFramePolicy = buildDecodedElementRefFramePolicy(decodedElementRef);
  let frameId = locatorFrameId ?? frameContext.frameId;
  let frameResolution: Record<string, unknown> | undefined;
  let previousFrameId: number | undefined;
  if (locatorFrameId === undefined && hasFrameLocatorContext(frameContext)) {
    try {
      const resolvedFrame = await resolveFrameIdForTarget(tab.id, selector, frameContext);
      frameResolution = resolvedFrame.diagnostics;
      if (resolvedFrame.status === 'found') {
        if (frameId > 0 && frameId !== resolvedFrame.candidate.frameId) {
          previousFrameId = frameId;
        }
        frameId = resolvedFrame.candidate.frameId;
      } else if (resolvedFrame.status === 'ambiguous') {
        return {
          ok: false,
          result: buildRejectedResult(
            request,
            tab,
            startedAt,
            traceId,
            'frame_target_ambiguous',
            `Frame locator matched ${resolvedFrame.candidates.length} frames for the native target selector.`,
            undefined,
            {
              frameResolution,
            },
          ),
        };
      } else {
        return {
          ok: false,
          result: decodedFramePolicy
            ? buildRejectedResult(
                request,
                tab,
                startedAt,
                traceId,
                'unsupported_cross_origin_frame',
                'The target frame could not be mapped to top-document coordinates. Cross-origin or inaccessible frames are not supported for native pointer actions yet.',
                undefined,
                {
                  framePolicy: decodedFramePolicy,
                  frameResolution,
                },
              )
            : buildRejectedResult(
                request,
                tab,
                startedAt,
                traceId,
                'target_frame_not_found',
                'No frame matched the requested frame locator and native target selector.',
                undefined,
                {
                  frameResolution,
                },
              ),
        };
      }
    } catch {
      // Fall through to the direct frame path so the existing inspection error remains visible.
    }
  }

  let snapshot: NativeClickTargetSnapshot | undefined;
  try {
    const maxAttempts = 3;
    let retryCount = 0;
    let retriedAfterDetach = false;
    let previousFailureCode: string | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      snapshot = await inspectClickableTarget(tab.id, frameId, selector);
      snapshot = {
        ...snapshot,
        frameId: snapshot.frameId ?? frameId,
        selector,
        locatorResolution,
        frameResolution,
        actionability: {
          ...snapshot.actionability,
          attempts: attempt,
          retryable: isRetryableActionabilityFailure(snapshot.actionability.failureCode),
        },
      };

      if (!isRetryableActionabilityFailure(snapshot.actionability.failureCode) || attempt === maxAttempts) {
        snapshot = annotateActionabilityRetryMetadata(snapshot, {
          retryCount,
          retriedAfterDetach,
          previousFailureCode,
        });
        break;
      }

      retryCount += 1;
      retriedAfterDetach = retriedAfterDetach || snapshot.actionability.failureCode === 'target_detached';
      previousFailureCode = snapshot.actionability.failureCode ?? previousFailureCode;
      await sleep(75);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Native target inspection failed.';
    const looksLikeMissingFrame = /frame/i.test(message) && /not|no|cannot|missing|found/i.test(message);
    if (looksLikeMissingFrame && hasFrameLocatorContext(frameContext)) {
      const resolvedFrame = await resolveFrameIdForTarget(tab.id, selector, frameContext).catch(() => undefined);
      frameResolution = resolvedFrame?.diagnostics ?? frameResolution;
      if (resolvedFrame?.status === 'found') {
        if (frameId > 0 && frameId !== resolvedFrame.candidate.frameId) {
          previousFrameId = frameId;
        }
        frameId = resolvedFrame.candidate.frameId;
        try {
          snapshot = await inspectClickableTarget(tab.id, frameId, selector);
          snapshot = {
            ...snapshot,
            selector,
            locatorResolution,
            frameResolution,
          };
        } catch (retryError) {
          const retryMessage = retryError instanceof Error ? retryError.message : message;
          return {
            ok: false,
            result: buildRejectedResult(
              request,
              tab,
              startedAt,
              traceId,
              'target_frame_not_found',
              retryMessage,
              undefined,
              {
                frameResolution,
              },
            ),
          };
        }
      } else if (resolvedFrame?.status === 'ambiguous') {
        return {
          ok: false,
          result: buildRejectedResult(
            request,
            tab,
            startedAt,
            traceId,
            'frame_target_ambiguous',
            `Frame locator matched ${resolvedFrame.candidates.length} frames while recovering a stale native target frame.`,
            undefined,
            {
              frameResolution,
            },
          ),
        };
      }
    }

    if (snapshot) {
      snapshot = annotateFrameRefresh(snapshot, previousFrameId);
    }

    if (snapshot) {
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

    return {
      ok: false,
      result: looksLikeMissingFrame
        ? decodedFramePolicy
          ? buildRejectedResult(
              request,
              tab,
              startedAt,
              traceId,
              'unsupported_cross_origin_frame',
              'The target frame could not be mapped to top-document coordinates. Cross-origin or inaccessible frames are not supported for native pointer actions yet.',
              undefined,
              {
                framePolicy: decodedFramePolicy,
                frameResolution,
              },
            )
          : buildRejectedResult(
              request,
              tab,
              startedAt,
              traceId,
              'target_frame_not_found',
              message,
              undefined,
              {
                frameResolution,
              },
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
  snapshot = annotateFrameRefresh(snapshot, previousFrameId);
  snapshot = {
    ...snapshot,
    selector,
    locatorResolution,
    frameResolution,
  };

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

async function resolveFrameCoordinateTranslation(
  tabId: number,
  frameSelector: string | undefined,
  point: {
    x: number;
    y: number;
  },
): Promise<FrameCoordinateTranslationResult | undefined> {
  if (!frameSelector) {
    return undefined;
  }

  return executeScriptInFrame(
    tabId,
    0,
    (rawFrameSelector, rawPoint) => {
      const frameSelectorValue = typeof rawFrameSelector === 'string' ? rawFrameSelector.trim() : '';
      const pointValue = rawPoint && typeof rawPoint === 'object'
        ? rawPoint as { x?: unknown; y?: unknown }
        : {};
      const localFramePoint = {
        x: typeof pointValue.x === 'number' && Number.isFinite(pointValue.x) ? pointValue.x : 0,
        y: typeof pointValue.y === 'number' && Number.isFinite(pointValue.y) ? pointValue.y : 0,
      };

      const emptyResult: FrameCoordinateTranslationResult = {
        resolved: false,
        frameSelector: frameSelectorValue || undefined,
        localFramePoint,
        failureCode: 'frame_selector_missing',
        frameElementRects: [],
      };
      if (!frameSelectorValue) {
        return emptyResult;
      }

      const segments = frameSelectorValue
        .split('=>')
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0);
      if (segments.length === 0) {
        return emptyResult;
      }

      let rootDocument: Document | null = document;
      let accumulatedX = 0;
      let accumulatedY = 0;
      const matchedSegments: string[] = [];
      const frameElementRects: FrameCoordinateTranslationRect[] = [];

      for (const [index, segment] of segments.entries()) {
        if (!rootDocument) {
          return {
            resolved: false,
            frameSelector: frameSelectorValue,
            localFramePoint,
            matchedSegments,
            failedSegment: segment,
            failureCode: 'frame_document_unavailable',
            frameElementRects,
          };
        }

        let frameElement: Element | null = null;
        try {
          frameElement = rootDocument.querySelector(segment);
        } catch {
          return {
            resolved: false,
            frameSelector: frameSelectorValue,
            localFramePoint,
            matchedSegments,
            failedSegment: segment,
            failureCode: 'frame_selector_invalid',
            frameElementRects,
          };
        }

        if (!(frameElement instanceof HTMLIFrameElement) && !(frameElement instanceof HTMLFrameElement)) {
          return {
            resolved: false,
            frameSelector: frameSelectorValue,
            localFramePoint,
            matchedSegments,
            failedSegment: segment,
            failureCode: 'frame_element_not_found',
            frameElementRects,
          };
        }

        matchedSegments.push(segment);
        const rect = frameElement.getBoundingClientRect();
        const clientLeft = frameElement.clientLeft ?? 0;
        const clientTop = frameElement.clientTop ?? 0;
        frameElementRects.push({
          frameSelector: segment,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          clientLeft,
          clientTop,
        });
        accumulatedX += rect.left + clientLeft;
        accumulatedY += rect.top + clientTop;

        if (index === segments.length - 1) {
          return {
            resolved: true,
            frameSelector: frameSelectorValue,
            localFramePoint,
            translatedPoint: {
              x: localFramePoint.x + accumulatedX,
              y: localFramePoint.y + accumulatedY,
            },
            matchedSegments,
            frameElementRects,
          };
        }

        try {
          rootDocument = frameElement.contentDocument;
        } catch {
          rootDocument = null;
        }

        if (!rootDocument) {
          return {
            resolved: false,
            frameSelector: frameSelectorValue,
            localFramePoint,
            matchedSegments,
            failedSegment: segments[index + 1],
            failureCode: 'intermediate_frame_inaccessible',
            frameElementRects,
          };
        }
      }

      return emptyResult;
    },
    [frameSelector, point],
  );
}

async function resolveFrameSelectorFromTopDocument(
  tabId: number,
  snapshot: NativeClickTargetSnapshot,
): Promise<string | undefined> {
  return executeScriptInFrame(
    tabId,
    0,
    (rawSnapshot) => {
      const snapshotValue = rawSnapshot && typeof rawSnapshot === 'object'
        ? rawSnapshot as {
            url?: unknown;
            title?: unknown;
            sandboxFlags?: unknown;
            isOpaqueOrigin?: unknown;
          }
        : {};
      const expectedUrl = typeof snapshotValue.url === 'string' && snapshotValue.url.length > 0
        ? snapshotValue.url
        : undefined;
      const expectedTitle = typeof snapshotValue.title === 'string' && snapshotValue.title.length > 0
        ? snapshotValue.title
        : undefined;
      const expectedSandboxFlags = Array.isArray(snapshotValue.sandboxFlags)
        ? snapshotValue.sandboxFlags.filter((flag): flag is string => typeof flag === 'string')
        : [];
      const expectedOpaqueOrigin = snapshotValue.isOpaqueOrigin === true;
      const cssEscapeFallback = (value: string): string => {
        const cssApi = (globalThis as { CSS?: { escape?: (input: string) => string } }).CSS;
        if (cssApi?.escape) {
          return cssApi.escape(value);
        }
        return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
      };
      const localSelector = (element: Element): string => {
        if (element.id) {
          return `#${cssEscapeFallback(element.id)}`;
        }
        const testId = element.getAttribute('data-testid');
        if (testId) {
          return `[data-testid="${cssEscapeFallback(testId)}"]`;
        }
        const name = element.getAttribute('name');
        if (name) {
          return `${element.tagName.toLowerCase()}[name="${cssEscapeFallback(name)}"]`;
        }
        const siblings = element.parentElement
          ? Array.from(element.parentElement.children).filter((child) => child.tagName === element.tagName)
          : [element];
        const index = Math.max(0, siblings.indexOf(element)) + 1;
        return `${element.tagName.toLowerCase()}:nth-of-type(${index})`;
      };
      const matchesSandboxFlags = (left: string[], right: string[]): boolean => {
        if (left.length !== right.length) {
          return false;
        }
        return left.every((flag, index) => flag === right[index]);
      };

      const matches: string[] = [];
      const opaqueMatches: string[] = [];
      const visitWindow = (rootWindow: Window, parentPath?: string): void => {
        const frameElements = Array.from(rootWindow.document.querySelectorAll('iframe, frame')) as HTMLIFrameElement[];
        for (const frameElement of frameElements) {
          const sandbox = frameElement instanceof HTMLIFrameElement ? frameElement.getAttribute('sandbox') : null;
          const sandboxFlags = sandbox === null
            ? []
            : sandbox
              .split(/\s+/)
              .map((flag) => flag.trim())
              .filter((flag) => flag.length > 0);
          const selectorPath = parentPath
            ? `${parentPath} => ${localSelector(frameElement)}`
            : localSelector(frameElement);
          const title = frameElement.getAttribute('title') ?? undefined;
          const resolvedUrl = frameElement.src || undefined;
          const urlMatch = expectedUrl === undefined
            || (expectedUrl === 'about:srcdoc' ? frameElement.getAttribute('srcdoc') !== null : resolvedUrl === expectedUrl);
          const titleMatch = !expectedTitle || !title || title === expectedTitle;
          const sandboxMatch = expectedSandboxFlags.length === 0 || matchesSandboxFlags(expectedSandboxFlags, sandboxFlags);
          if (urlMatch && titleMatch && sandboxMatch) {
            matches.push(selectorPath);
            if (expectedOpaqueOrigin && sandboxFlags.length > 0) {
              opaqueMatches.push(selectorPath);
            }
          }
          try {
            const childWindow = frameElement.contentWindow;
            const childDocument = frameElement.contentDocument;
            if (childWindow && childDocument) {
              visitWindow(childWindow, selectorPath);
            }
          } catch {
            // Cross-origin descendants cannot be inspected from the top document.
          }
        }
      };

      visitWindow(window);
      if (expectedOpaqueOrigin && opaqueMatches.length === 1) {
        return opaqueMatches[0];
      }
      return matches.length === 1 ? matches[0] : undefined;
    },
    [{
      url: snapshot.url,
      title: snapshot.framePolicy?.title,
      sandboxFlags: snapshot.framePolicy?.sandboxFlags,
      isOpaqueOrigin: snapshot.framePolicy?.isOpaqueOrigin,
    }],
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
  if (hasCoordinateTarget(request)) {
    const requestedFrameId = request.target.coordinates.frameId ?? request.target.frameId ?? 0;
    let inspection: Awaited<ReturnType<typeof inspectCoordinatePoint>>;
    try {
      inspection = await inspectCoordinatePoint(
        tab.id,
        request.target.coordinates.x,
        request.target.coordinates.y,
        requestedFrameId,
      );
    } catch (error) {
      return buildRejectedResult(
        request,
        tab,
        startedAt,
        traceId,
        'target_frame_not_found',
        error instanceof Error ? error.message : 'Coordinate target frame could not be resolved.',
      );
    }
    const snapshot = buildCoordinateSnapshot(inspection);
    if (!snapshot.actionability.inViewport || !snapshot.center) {
      return buildRejectedResult(
        request,
        tab,
        startedAt,
        traceId,
        'target_outside_viewport',
        'The requested coordinate is outside the current viewport.',
        snapshot,
      );
    }

    try {
      const button = mouseButtonName(request.input?.button);
      const clickCount = request.input?.clickCount ?? 1;
      let clickPoint = snapshot.center;
      let pointCoordinateSpace = requestedFrameId === 0 ? 'top-document' : 'frame-local';
      let resultSnapshot = snapshot;
      let frameCoordinateTranslation = buildFrameCoordinateTranslationResult(undefined);
      if (requestedFrameId !== 0) {
        const frameSelector = snapshot.frameSelector
          ?? resolveActionFrameContext(request).frameSelector
          ?? await resolveFrameSelectorFromTopDocument(tab.id, snapshot);
        const translation = await resolveFrameCoordinateTranslation(tab.id, frameSelector, snapshot.center);
        frameCoordinateTranslation = buildFrameCoordinateTranslationResult(translation);
        if (!translation?.resolved || !translation.translatedPoint) {
          return buildRejectedResult(
            request,
            tab,
            startedAt,
            traceId,
            'coordinate_frame_translation_failed',
            'The coordinate target frame could not be mapped to top-document coordinates.',
            annotateFrameCoordinateResolution(snapshot, false),
            {
              frameCoordinateTranslation,
            },
          );
        }
        clickPoint = translation.translatedPoint;
        resultSnapshot = annotateFrameCoordinateResolution(snapshot, true);
        pointCoordinateSpace = 'translated-frame';
      }

      await dispatchNativeClick(tab.id, clickPoint, button, clickCount);
      return buildSucceededResult(request, tab, startedAt, traceId, resultSnapshot, {
        clickCount,
        button,
        point: clickPoint,
        pointCoordinateSpace,
        coordinateTarget: true,
        frameCoordinateTranslation,
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

  const target = await inspectActionableTargetForRequest(request, tab, startedAt, traceId);
  if (!target.ok) {
    return target.result;
  }

  let clickPoint = target.snapshot.topCenter ?? target.snapshot.center;
  let pointCoordinateSpace = target.snapshot.frameId === 0 ? 'top-document' : 'frame-local';
  let resultSnapshot = target.snapshot;
  let frameCoordinateTranslation = buildFrameCoordinateTranslationResult(undefined);
  if (target.snapshot.frameId !== 0 && target.snapshot.center) {
    const requiresCrossOriginTranslation = target.snapshot.framePolicy?.sameOriginWithTop === false
      || target.snapshot.framePolicy?.isOpaqueOrigin === true
      || target.snapshot.framePolicy?.topAccessible === false;
    if (!requiresCrossOriginTranslation) {
      const frameOffset = await resolveSameOriginFrameOffset(tab.id, target.selector, target.snapshot.url);
      if (frameOffset) {
        clickPoint = {
          x: target.snapshot.center.x + frameOffset.x,
          y: target.snapshot.center.y + frameOffset.y,
        };
        resultSnapshot = annotateFrameCoordinateResolution(target.snapshot, true);
        pointCoordinateSpace = 'translated-frame';
      } else {
        const frameSelector = target.snapshot.frameSelector
          ?? resolveActionFrameContext(request).frameSelector
          ?? await resolveFrameSelectorFromTopDocument(tab.id, target.snapshot);
        const translation = await resolveFrameCoordinateTranslation(tab.id, frameSelector, target.snapshot.center);
        frameCoordinateTranslation = buildFrameCoordinateTranslationResult(translation);
        if (!translation?.resolved || !translation.translatedPoint) {
          return buildRejectedResult(
            request,
            tab,
            startedAt,
            traceId,
            'unsupported_cross_origin_frame',
            'The target frame could not be mapped to top-document coordinates.',
            annotateFrameCoordinateResolution(target.snapshot, false),
            {
              frameCoordinateTranslation,
            },
          );
        }
        clickPoint = translation.translatedPoint;
        resultSnapshot = annotateFrameCoordinateResolution(target.snapshot, true);
        pointCoordinateSpace = 'translated-frame';
      }
    } else {
      const frameSelector = target.snapshot.frameSelector
        ?? resolveActionFrameContext(request).frameSelector
        ?? await resolveFrameSelectorFromTopDocument(tab.id, target.snapshot);
      const translation = await resolveFrameCoordinateTranslation(tab.id, frameSelector, target.snapshot.center);
      frameCoordinateTranslation = buildFrameCoordinateTranslationResult(translation);
      if (translation?.resolved && translation.translatedPoint) {
        clickPoint = translation.translatedPoint;
        resultSnapshot = annotateFrameCoordinateResolution(target.snapshot, true);
        pointCoordinateSpace = 'translated-frame';
      } else {
        const frameOffset = await resolveSameOriginFrameOffset(tab.id, target.selector, target.snapshot.url);
        if (!frameOffset) {
          return buildRejectedResult(
            request,
            tab,
            startedAt,
            traceId,
            'unsupported_cross_origin_frame',
            'The target frame could not be mapped to top-document coordinates.',
            annotateFrameCoordinateResolution(target.snapshot, false),
            {
              frameCoordinateTranslation,
            },
          );
        }
        clickPoint = {
          x: target.snapshot.center.x + frameOffset.x,
          y: target.snapshot.center.y + frameOffset.y,
        };
        resultSnapshot = annotateFrameCoordinateResolution(target.snapshot, true);
        pointCoordinateSpace = 'translated-frame';
      }
    }
  }

  if (!clickPoint) {
    return buildRejectedResult(
      request,
      tab,
      startedAt,
      traceId,
      'target_click_point_unavailable',
      'No native click point could be computed for the target.',
      resultSnapshot,
    );
  }

  try {
    const button = mouseButtonName(request.input?.button);
    const clickCount = request.input?.clickCount ?? 1;
    await dispatchNativeClick(tab.id, clickPoint, button, clickCount);
    return buildSucceededResult(request, tab, startedAt, traceId, resultSnapshot, {
      clickCount,
      button,
      point: clickPoint,
      pointCoordinateSpace,
      frameCoordinateTranslation,
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
  if (hasCoordinateTarget(request)) {
    const requestedFrameId = request.target.coordinates.frameId ?? request.target.frameId ?? 0;
    let inspection: Awaited<ReturnType<typeof inspectCoordinatePoint>>;
    try {
      inspection = await inspectCoordinatePoint(
        tab.id,
        request.target.coordinates.x,
        request.target.coordinates.y,
        requestedFrameId,
      );
    } catch (error) {
      return buildRejectedResult(
        request,
        tab,
        startedAt,
        traceId,
        'target_frame_not_found',
        error instanceof Error ? error.message : 'Coordinate target frame could not be resolved.',
      );
    }
    const snapshot = buildCoordinateSnapshot(inspection);
    if (!snapshot.actionability.inViewport || !snapshot.center) {
      return buildRejectedResult(
        request,
        tab,
        startedAt,
        traceId,
        'target_outside_viewport',
        'The requested coordinate is outside the current viewport.',
        snapshot,
      );
    }

    try {
      let hoverPoint = snapshot.center;
      let pointCoordinateSpace = requestedFrameId === 0 ? 'top-document' : 'frame-local';
      let resultSnapshot = snapshot;
      let frameCoordinateTranslation = buildFrameCoordinateTranslationResult(undefined);
      if (requestedFrameId !== 0) {
        const frameSelector = snapshot.frameSelector
          ?? resolveActionFrameContext(request).frameSelector
          ?? await resolveFrameSelectorFromTopDocument(tab.id, snapshot);
        const translation = await resolveFrameCoordinateTranslation(tab.id, frameSelector, snapshot.center);
        frameCoordinateTranslation = buildFrameCoordinateTranslationResult(translation);
        if (!translation?.resolved || !translation.translatedPoint) {
          return buildRejectedResult(
            request,
            tab,
            startedAt,
            traceId,
            'coordinate_frame_translation_failed',
            'The coordinate target frame could not be mapped to top-document coordinates.',
            annotateFrameCoordinateResolution(snapshot, false),
            {
              frameCoordinateTranslation,
            },
          );
        }
        hoverPoint = translation.translatedPoint;
        resultSnapshot = annotateFrameCoordinateResolution(snapshot, true);
        pointCoordinateSpace = 'translated-frame';
      }

      await dispatchNativeMouseMove(tab.id, hoverPoint);
      return buildSucceededResult(request, tab, startedAt, traceId, resultSnapshot, {
        point: hoverPoint,
        pointCoordinateSpace,
        coordinateTarget: true,
        frameCoordinateTranslation,
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

  const target = await inspectActionableTargetForRequest(request, tab, startedAt, traceId);
  if (!target.ok) {
    return target.result;
  }

  let hoverPoint = target.snapshot.topCenter ?? target.snapshot.center;
  let pointCoordinateSpace = target.snapshot.frameId === 0 ? 'top-document' : 'frame-local';
  let resultSnapshot = target.snapshot;
  let frameCoordinateTranslation = buildFrameCoordinateTranslationResult(undefined);
  if (target.snapshot.frameId !== 0 && target.snapshot.center) {
    const requiresCrossOriginTranslation = target.snapshot.framePolicy?.sameOriginWithTop === false
      || target.snapshot.framePolicy?.isOpaqueOrigin === true
      || target.snapshot.framePolicy?.topAccessible === false;
    if (!requiresCrossOriginTranslation) {
      const frameOffset = await resolveSameOriginFrameOffset(tab.id, target.selector, target.snapshot.url);
      if (frameOffset) {
        hoverPoint = {
          x: target.snapshot.center.x + frameOffset.x,
          y: target.snapshot.center.y + frameOffset.y,
        };
        resultSnapshot = annotateFrameCoordinateResolution(target.snapshot, true);
        pointCoordinateSpace = 'translated-frame';
      } else {
        const frameSelector = target.snapshot.frameSelector
          ?? resolveActionFrameContext(request).frameSelector
          ?? await resolveFrameSelectorFromTopDocument(tab.id, target.snapshot);
        const translation = await resolveFrameCoordinateTranslation(tab.id, frameSelector, target.snapshot.center);
        frameCoordinateTranslation = buildFrameCoordinateTranslationResult(translation);
        if (!translation?.resolved || !translation.translatedPoint) {
          return buildRejectedResult(
            request,
            tab,
            startedAt,
            traceId,
            'unsupported_cross_origin_frame',
            'The target frame could not be mapped to top-document coordinates.',
            annotateFrameCoordinateResolution(target.snapshot, false),
            {
              frameCoordinateTranslation,
            },
          );
        }
        hoverPoint = translation.translatedPoint;
        resultSnapshot = annotateFrameCoordinateResolution(target.snapshot, true);
        pointCoordinateSpace = 'translated-frame';
      }
    } else {
      const frameSelector = target.snapshot.frameSelector
        ?? resolveActionFrameContext(request).frameSelector
        ?? await resolveFrameSelectorFromTopDocument(tab.id, target.snapshot);
      const translation = await resolveFrameCoordinateTranslation(tab.id, frameSelector, target.snapshot.center);
      frameCoordinateTranslation = buildFrameCoordinateTranslationResult(translation);
      if (translation?.resolved && translation.translatedPoint) {
        hoverPoint = translation.translatedPoint;
        resultSnapshot = annotateFrameCoordinateResolution(target.snapshot, true);
        pointCoordinateSpace = 'translated-frame';
      } else {
        const frameOffset = await resolveSameOriginFrameOffset(tab.id, target.selector, target.snapshot.url);
        if (!frameOffset) {
          return buildRejectedResult(
            request,
            tab,
            startedAt,
            traceId,
            'unsupported_cross_origin_frame',
            'The target frame could not be mapped to top-document coordinates.',
            annotateFrameCoordinateResolution(target.snapshot, false),
            {
              frameCoordinateTranslation,
            },
          );
        }
        hoverPoint = {
          x: target.snapshot.center.x + frameOffset.x,
          y: target.snapshot.center.y + frameOffset.y,
        };
        resultSnapshot = annotateFrameCoordinateResolution(target.snapshot, true);
        pointCoordinateSpace = 'translated-frame';
      }
    }
  }

  if (!hoverPoint) {
    return buildRejectedResult(
      request,
      tab,
      startedAt,
      traceId,
      'target_hover_point_unavailable',
      'No native hover point could be computed for the target.',
      resultSnapshot,
    );
  }

  try {
    await dispatchNativeMouseMove(tab.id, hoverPoint);
    return buildSucceededResult(request, tab, startedAt, traceId, resultSnapshot, {
      point: hoverPoint,
      pointCoordinateSpace,
      frameCoordinateTranslation,
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
