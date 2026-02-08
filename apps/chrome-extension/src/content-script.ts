export const BRIDGE_SOURCE = 'browser-debug-mcp-bridge';
export const BRIDGE_KIND = 'bridge-event';

export interface BridgePayload {
  source: string;
  kind: string;
  eventType: string;
  data: Record<string, unknown>;
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
  };
}

if (typeof window !== 'undefined' && typeof chrome !== 'undefined' && !!chrome.runtime) {
  installContentCapture();
  console.log('[BrowserDebug] Content script loaded');
}
