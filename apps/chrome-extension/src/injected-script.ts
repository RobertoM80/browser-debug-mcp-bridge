const BRIDGE_SOURCE = 'browser-debug-mcp-bridge';
const BRIDGE_KIND = 'bridge-event';

interface BridgePayload {
  source: string;
  kind: string;
  eventType: string;
  data: Record<string, unknown>;
}

interface InjectedCaptureOptions {
  win?: Window;
}

type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace';

type NetworkErrorType = 'timeout' | 'cors' | 'dns' | 'blocked' | 'http_error';

interface XhrCaptureRecord {
  method: string;
  url: string;
  startedAt: number;
  emitted: boolean;
}

function normalizeMethod(method: string | undefined): string {
  if (!method) {
    return 'GET';
  }
  return method.toUpperCase();
}

function toAbsoluteUrl(url: string, win: Window): string {
  try {
    return new URL(url, win.location.href).toString();
  } catch {
    return url;
  }
}

function inferErrorType(status: number, reason: unknown): NetworkErrorType | undefined {
  if (status >= 400) {
    return 'http_error';
  }

  if (!reason) {
    return undefined;
  }

  const errorName =
    typeof reason === 'object' && reason !== null && 'name' in reason
      ? String((reason as { name?: unknown }).name ?? '')
      : '';

  const errorMessage =
    typeof reason === 'string'
      ? reason
      : typeof reason === 'object' && reason !== null && 'message' in reason
        ? String((reason as { message?: unknown }).message ?? '')
        : '';

  const combined = `${errorName} ${errorMessage}`.toLowerCase();

  if (combined.includes('timeout') || errorName === 'AbortError') {
    return 'timeout';
  }
  if (combined.includes('cors') || combined.includes('cross-origin')) {
    return 'cors';
  }
  if (combined.includes('dns') || combined.includes('name_not_resolved')) {
    return 'dns';
  }
  if (combined.includes('blocked') || combined.includes('err_blocked_by_client')) {
    return 'blocked';
  }

  return 'blocked';
}

function getResponseSize(value: unknown): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.length;
}

function parseFetchUrl(input: RequestInfo | URL, win: Window): string {
  if (typeof input === 'string') {
    return toAbsoluteUrl(input, win);
  }

  if (typeof URL !== 'undefined' && input instanceof URL) {
    return input.toString();
  }

  const requestLike = input as { url?: string };
  return requestLike.url ? toAbsoluteUrl(requestLike.url, win) : win.location.href;
}

function parseFetchMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) {
    return normalizeMethod(init.method);
  }

  const requestLike = input as { method?: string };
  return normalizeMethod(requestLike.method);
}

function serializeArg(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value == null) {
    return value;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function extractErrorDetails(reason: unknown): { message: string; stack?: string } {
  if (reason instanceof Error) {
    return {
      message: reason.message,
      stack: reason.stack,
    };
  }

  if (typeof reason === 'string') {
    return { message: reason };
  }

  return {
    message: 'Unhandled promise rejection',
    stack: undefined,
  };
}

export function installInjectedCapture(options: InjectedCaptureOptions = {}): () => void {
  const win = options.win ?? window;
  const winWithXhr = win as Window & { XMLHttpRequest?: typeof XMLHttpRequest };
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalDebug = console.debug;
  const originalTrace = console.trace;
  const originalFetch = win.fetch ? win.fetch.bind(win) : undefined;
  const xhrPrototype = winWithXhr.XMLHttpRequest?.prototype;
  const originalXhrOpen = xhrPrototype?.open;
  const originalXhrSend = xhrPrototype?.send;
  const xhrCaptures = new WeakMap<XMLHttpRequest, XhrCaptureRecord>();

  const emit = (eventType: string, data: Record<string, unknown>): void => {
    const payload: BridgePayload = {
      source: BRIDGE_SOURCE,
      kind: BRIDGE_KIND,
      eventType,
      data,
    };
    win.postMessage(payload, '*');
  };

  const hookConsole = <T extends (...args: unknown[]) => void>(
    level: ConsoleLevel,
    originalFn: T
  ): T => {
    const wrapped = (...args: unknown[]): void => {
      emit('console', {
        level,
        args: args.map(serializeArg),
        message: args.map((entry) => String(entry)).join(' '),
        timestamp: Date.now(),
      });
      originalFn.apply(console, args);
    };
    return wrapped as T;
  };

  const onRuntimeError = (event: ErrorEvent): void => {
    const details = extractErrorDetails(event.error ?? event.message);
    emit('error', {
      message: details.message,
      stack: details.stack,
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
      source: 'window.onerror',
      timestamp: Date.now(),
    });
  };

  const onUnhandledRejection = (event: Event): void => {
    const reason = (event as Event & { reason?: unknown }).reason;
    const details = extractErrorDetails(reason);
    emit('error', {
      message: details.message,
      stack: details.stack,
      reason: serializeArg(reason),
      source: 'unhandledrejection',
      timestamp: Date.now(),
    });
  };

  const emitNetwork = (payload: {
    method: string;
    url: string;
    status: number;
    duration: number;
    initiator: 'fetch' | 'xhr';
    errorType?: NetworkErrorType;
    responseSize?: number;
  }): void => {
    emit('network', {
      method: payload.method,
      url: payload.url,
      status: payload.status,
      duration: payload.duration,
      initiator: payload.initiator,
      errorType: payload.errorType,
      responseSize: payload.responseSize,
      timestamp: Date.now(),
    });
  };

  if (originalFetch) {
    win.fetch = (async (...args: Parameters<typeof fetch>) => {
      const startedAt = Date.now();
      const [input, init] = args;
      const method = parseFetchMethod(input, init);
      const url = parseFetchUrl(input, win);

      try {
        const response = await originalFetch(...args);
        const duration = Date.now() - startedAt;
        const contentLengthHeader = response.headers.get('content-length');
        const parsedContentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;

        emitNetwork({
          method,
          url,
          status: response.status,
          duration,
          initiator: 'fetch',
          errorType: inferErrorType(response.status, undefined),
          responseSize: Number.isFinite(parsedContentLength) ? parsedContentLength : undefined,
        });

        return response;
      } catch (error) {
        const duration = Date.now() - startedAt;
        emitNetwork({
          method,
          url,
          status: 0,
          duration,
          initiator: 'fetch',
          errorType: inferErrorType(0, error),
        });
        throw error;
      }
    }) as typeof fetch;
  }

  if (xhrPrototype && originalXhrOpen && originalXhrSend) {
    xhrPrototype.open = function open(
      method: string,
      url: string,
      async?: boolean,
      username?: string | null,
      password?: string | null
    ): void {
      xhrCaptures.set(this, {
        method: normalizeMethod(method),
        url: toAbsoluteUrl(url, win),
        startedAt: Date.now(),
        emitted: false,
      });
      originalXhrOpen.call(this, method, url, async ?? true, username ?? null, password ?? null);
    };

    xhrPrototype.send = function send(body?: Document | XMLHttpRequestBodyInit | null): void {
      const capture = xhrCaptures.get(this);
      if (capture) {
        capture.startedAt = Date.now();
        const emitFromXhr = (statusOverride?: number, reason?: unknown): void => {
          if (capture.emitted) {
            return;
          }
          capture.emitted = true;
          const status = statusOverride ?? this.status ?? 0;
          emitNetwork({
            method: capture.method,
            url: capture.url,
            status,
            duration: Date.now() - capture.startedAt,
            initiator: 'xhr',
            errorType: inferErrorType(status, reason),
            responseSize: getResponseSize(this.responseText),
          });
        };

        this.addEventListener('loadend', () => emitFromXhr());
        this.addEventListener('timeout', () => emitFromXhr(0, new Error('timeout')));
        this.addEventListener('error', () => emitFromXhr(0, new Error('network error')));
        this.addEventListener('abort', () => emitFromXhr(0, new Error('blocked')));
      }

      originalXhrSend.call(this, body ?? null);
    };
  }

  console.log = hookConsole('log', originalLog);
  console.info = hookConsole('info', originalInfo);
  console.warn = hookConsole('warn', originalWarn);
  console.error = hookConsole('error', originalError);
  console.debug = hookConsole('debug', originalDebug);
  console.trace = hookConsole('trace', originalTrace);
  win.addEventListener('error', onRuntimeError);
  win.addEventListener('unhandledrejection', onUnhandledRejection);

  emit('custom', {
    marker: 'injected_script_loaded',
    url: win.location.href,
    timestamp: Date.now(),
  });

  return () => {
    console.log = originalLog;
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;
    console.debug = originalDebug;
    console.trace = originalTrace;
    if (originalFetch) {
      win.fetch = originalFetch;
    }
    if (xhrPrototype && originalXhrOpen && originalXhrSend) {
      xhrPrototype.open = originalXhrOpen;
      xhrPrototype.send = originalXhrSend;
    }
    win.removeEventListener('error', onRuntimeError);
    win.removeEventListener('unhandledrejection', onUnhandledRejection);
  };
}

if (typeof window !== 'undefined') {
  const guard = window as Window & { __BDMCP_INJECTED_CAPTURE_INSTALLED__?: boolean };
  if (!guard.__BDMCP_INJECTED_CAPTURE_INSTALLED__) {
    guard.__BDMCP_INJECTED_CAPTURE_INSTALLED__ = true;
    installInjectedCapture();
  }
  console.log('[BrowserDebug][InjectedScript] Loaded');
}
