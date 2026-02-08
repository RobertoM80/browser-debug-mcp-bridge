export const BRIDGE_SOURCE = 'browser-debug-mcp-bridge';
export const BRIDGE_KIND = 'bridge-event';

export interface BridgePayload {
  source: string;
  kind: string;
  eventType: string;
  data: Record<string, unknown>;
}

type CaptureCommandType =
  | 'CAPTURE_DOM_SUBTREE'
  | 'CAPTURE_DOM_DOCUMENT'
  | 'CAPTURE_COMPUTED_STYLES'
  | 'CAPTURE_LAYOUT_METRICS';

interface CaptureCommandRequest {
  type: 'CAPTURE_EXECUTE';
  command: CaptureCommandType;
  payload?: Record<string, unknown>;
}

interface CaptureCommandResponse {
  ok: boolean;
  result?: Record<string, unknown>;
  truncated?: boolean;
  error?: string;
}

function getClickableTarget(event: Event): Element | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  const firstPathTarget = path.find((entry) => entry instanceof Element);
  if (firstPathTarget instanceof Element) {
    return firstPathTarget;
  }

  if (event.target instanceof Element) {
    return event.target;
  }

  return null;
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function getClickSelector(target: Element): string | null {
  if (target.id) {
    return `#${cssEscape(target.id)}`;
  }

  const testId = target.getAttribute('data-testid');
  if (testId) {
    return `[data-testid="${cssEscape(testId)}"]`;
  }

  const classes = Array.from(target.classList).filter((entry) => !/^\d/.test(entry));
  if (classes.length > 0) {
    return `${target.tagName.toLowerCase()}.${cssEscape(classes[0])}`;
  }

  const tagName = target.tagName.toLowerCase();
  return tagName || null;
}

interface ContentCaptureOptions {
  win?: Window;
  runtime?: RuntimeMessenger;
}

interface RuntimeMessenger {
  sendMessage(message: unknown, callback?: () => void): void;
}

function sendToBackground(
  runtime: RuntimeMessenger,
  eventType: string,
  data: Record<string, unknown>
): void {
  try {
    runtime.sendMessage(
      {
        type: 'SESSION_QUEUE_EVENT',
        eventType,
        data,
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  } catch {
    // Ignore runtime messaging failures when no receiver is active.
  }
}

function clampMaxDepth(value: unknown, fallback = 3): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const depth = Math.floor(value);
  if (depth < 1) {
    return fallback;
  }

  return Math.min(depth, 10);
}

function clampMaxBytes(value: unknown, fallback = 50_000): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const bytes = Math.floor(value);
  if (bytes < 1_000) {
    return fallback;
  }

  return Math.min(bytes, 1_000_000);
}

function byteSize(value: string): number {
  return new TextEncoder().encode(value).length;
}

function serializeWithinLimit(value: unknown, maxBytes: number): { text: string; truncated: boolean } {
  const serialized = JSON.stringify(value);
  if (byteSize(serialized) <= maxBytes) {
    return { text: serialized, truncated: false };
  }

  const limited = serialized.slice(0, Math.max(maxBytes - 40, 20));
  return { text: `${limited}...[TRUNCATED]`, truncated: true };
}

function buildDomOutline(root: Element, maxDepth: number, maxNodes = 400): Record<string, unknown> {
  let visited = 0;

  const visit = (element: Element, depth: number): Record<string, unknown> | null => {
    if (visited >= maxNodes) {
      return null;
    }

    visited += 1;
    const classes = Array.from(element.classList).slice(0, 3);
    const node: Record<string, unknown> = {
      tag: element.tagName.toLowerCase(),
    };

    if (element.id) {
      node.id = element.id;
    }
    if (classes.length > 0) {
      node.class = classes.join(' ');
    }

    if (depth >= maxDepth) {
      return node;
    }

    const children: Record<string, unknown>[] = [];
    for (const child of Array.from(element.children)) {
      const next = visit(child, depth + 1);
      if (next) {
        children.push(next);
      }
      if (visited >= maxNodes) {
        break;
      }
    }

    if (children.length > 0) {
      node.children = children;
    }

    return node;
  };

  return {
    truncated: visited >= maxNodes,
    nodeCount: visited,
    root: visit(root, 0),
  };
}

export function executeCaptureCommand(
  win: Window,
  command: CaptureCommandType,
  payload: Record<string, unknown> = {}
): { result: Record<string, unknown>; truncated: boolean } {
  const maxDepth = clampMaxDepth(payload.maxDepth);
  const maxBytes = clampMaxBytes(payload.maxBytes);

  if (command === 'CAPTURE_DOM_SUBTREE') {
    const selector = typeof payload.selector === 'string' ? payload.selector : '';
    if (!selector) {
      throw new Error('selector is required');
    }

    const target = win.document.querySelector(selector);
    if (!target) {
      throw new Error(`No element found for selector: ${selector}`);
    }

    const html = target.outerHTML;
    if (byteSize(html) <= maxBytes) {
      return {
        truncated: false,
        result: {
          mode: 'html',
          selector,
          html,
          maxBytes,
        },
      };
    }

    const outline = buildDomOutline(target, maxDepth);
    const serialized = serializeWithinLimit(outline, maxBytes);
    return {
      truncated: true,
      result: {
        mode: 'outline',
        selector,
        fallbackReason: 'maxBytes',
        outline: serialized.text,
        maxDepth,
        maxBytes,
      },
    };
  }

  if (command === 'CAPTURE_DOM_DOCUMENT') {
    const mode = payload.mode === 'html' ? 'html' : 'outline';
    const root = win.document.documentElement;
    const html = root?.outerHTML ?? '';

    if (mode === 'html' && byteSize(html) <= maxBytes) {
      return {
        truncated: false,
        result: {
          mode,
          html,
          maxBytes,
        },
      };
    }

    const outline = root ? buildDomOutline(root, maxDepth) : { root: null, truncated: false, nodeCount: 0 };
    const serialized = serializeWithinLimit(outline, maxBytes);
    return {
      truncated: mode === 'html' || serialized.truncated,
      result: {
        mode: 'outline',
        fallbackReason: mode === 'html' ? 'maxBytes' : undefined,
        outline: serialized.text,
        maxDepth,
        maxBytes,
      },
    };
  }

  if (command === 'CAPTURE_COMPUTED_STYLES') {
    const selector = typeof payload.selector === 'string' ? payload.selector : '';
    if (!selector) {
      throw new Error('selector is required');
    }

    const target = win.document.querySelector(selector);
    if (!target) {
      throw new Error(`No element found for selector: ${selector}`);
    }

    const style = win.getComputedStyle(target);
    const requestedProperties = Array.isArray(payload.properties)
      ? payload.properties.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      : [];

    const properties = requestedProperties.length > 0
      ? requestedProperties
      : [
          'display',
          'position',
          'visibility',
          'opacity',
          'width',
          'height',
          'z-index',
          'overflow',
        ];

    const values: Record<string, string> = {};
    for (const property of properties.slice(0, 64)) {
      values[property] = style.getPropertyValue(property);
    }

    return {
      truncated: false,
      result: {
        selector,
        properties: values,
      },
    };
  }

  if (command === 'CAPTURE_LAYOUT_METRICS') {
    const selector = typeof payload.selector === 'string' ? payload.selector : undefined;
    const target = selector ? win.document.querySelector(selector) : win.document.documentElement;

    if (!target) {
      throw new Error(`No element found for selector: ${selector}`);
    }

    const rect = target.getBoundingClientRect();
    return {
      truncated: false,
      result: {
        selector,
        viewport: {
          width: win.innerWidth,
          height: win.innerHeight,
          scrollX: win.scrollX,
          scrollY: win.scrollY,
        },
        element: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          left: rect.left,
        },
      },
    };
  }

  throw new Error(`Unsupported capture command: ${command}`);
}

export function installContentCapture(options: ContentCaptureOptions = {}): () => void {
  const win = options.win ?? window;
  const runtime = options.runtime ?? chrome.runtime;
  const originalPushState = win.history.pushState.bind(win.history);
  const originalReplaceState = win.history.replaceState.bind(win.history);
  let lastUrl = win.location.href;

  const emitNavigation = (trigger: string): void => {
    const nextUrl = win.location.href;
    sendToBackground(runtime, 'navigation', {
      from: lastUrl,
      to: nextUrl,
      trigger,
      timestamp: Date.now(),
    });
    lastUrl = nextUrl;
  };

  const onPopState = (): void => emitNavigation('popstate');
  const onHashChange = (): void => emitNavigation('hashchange');
  const onMessage = (event: MessageEvent<unknown>): void => {
    if (event.source && event.source !== win) {
      return;
    }

    const payload = event.data as Partial<BridgePayload> | null;
    if (!payload || payload.source !== BRIDGE_SOURCE || payload.kind !== BRIDGE_KIND) {
      return;
    }

    if (!payload.eventType || !payload.data) {
      return;
    }

    sendToBackground(runtime, payload.eventType, payload.data);
  };
  const onClick = (event: MouseEvent): void => {
    const target = getClickableTarget(event);
    if (!target) {
      return;
    }

    const selector = getClickSelector(target);
    if (!selector) {
      return;
    }

    sendToBackground(runtime, 'click', {
      selector,
      timestamp: Date.now(),
    });
  };

  const onRuntimeCommand = (
    request: CaptureCommandRequest,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: CaptureCommandResponse) => void
  ): boolean | void => {
    if (!request || request.type !== 'CAPTURE_EXECUTE') {
      return;
    }

    try {
      const output = executeCaptureCommand(win, request.command, request.payload ?? {});
      sendResponse({
        ok: true,
        result: output.result,
        truncated: output.truncated,
      });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : 'Capture command failed',
      });
    }

    return true;
  };

  win.history.pushState = function pushState(...args: Parameters<History['pushState']>): void {
    originalPushState(...args);
    emitNavigation('pushState');
  };

  win.history.replaceState = function replaceState(...args: Parameters<History['replaceState']>): void {
    originalReplaceState(...args);
    emitNavigation('replaceState');
  };

  win.addEventListener('popstate', onPopState);
  win.addEventListener('hashchange', onHashChange);
  win.addEventListener('message', onMessage);
  win.addEventListener('click', onClick, true);
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener(onRuntimeCommand);
  }

  sendToBackground(runtime, 'navigation', {
    from: null,
    to: win.location.href,
    trigger: 'init',
    timestamp: Date.now(),
  });

  return () => {
    win.history.pushState = originalPushState;
    win.history.replaceState = originalReplaceState;
    win.removeEventListener('popstate', onPopState);
    win.removeEventListener('hashchange', onHashChange);
    win.removeEventListener('message', onMessage);
    win.removeEventListener('click', onClick, true);
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.removeListener(onRuntimeCommand);
    }
  };
}

if (typeof window !== 'undefined' && typeof chrome !== 'undefined' && !!chrome.runtime) {
  installContentCapture();
  console.log('[BrowserDebug][ContentScript] Loaded');
}
