const BRIDGE_SOURCE = 'browser-debug-mcp-bridge';
const BRIDGE_KIND = 'bridge-event';
const BRIDGE_CONTROL_KIND = 'bridge-control';
const DEFAULT_MAX_BODY_BYTES = 262144;
const TRACE_HINT_TTL_MS = 15000;

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
  requestId: string;
  traceId: string;
  traceEventType?: string;
  traceSelector?: string;
  method: string;
  url: string;
  startedAt: number;
  emitted: boolean;
  requestContentType?: string;
  requestBody?: BodyCaptureResult;
}

interface NetworkCaptureConfig {
  captureBodies: boolean;
  maxBodyBytes: number;
}

interface TraceHint {
  traceId: string;
  eventType?: string;
  selector?: string;
  timestamp: number;
}

interface BodyCaptureResult {
  contentType?: string;
  bodyText?: string;
  bodyJson?: unknown;
  bodyBytes?: number;
  truncated: boolean;
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

function normalizeContentType(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.split(';')[0]?.trim().toLowerCase() || undefined;
}

function parseContentTypeFromHeaders(headersInit?: HeadersInit): string | undefined {
  if (!headersInit) {
    return undefined;
  }

  if (headersInit instanceof Headers) {
    return normalizeContentType(headersInit.get('content-type'));
  }

  if (Array.isArray(headersInit)) {
    for (const [name, value] of headersInit) {
      if (name.toLowerCase() === 'content-type') {
        return normalizeContentType(value);
      }
    }
    return undefined;
  }

  for (const [name, value] of Object.entries(headersInit)) {
    if (name.toLowerCase() === 'content-type') {
      return normalizeContentType(String(value));
    }
  }

  return undefined;
}

function isTextualBodyContentType(contentType?: string): boolean {
  if (!contentType) {
    return true;
  }
  if (contentType.startsWith('text/')) {
    return true;
  }
  if (contentType.includes('json') || contentType.includes('xml')) {
    return true;
  }
  if (contentType.includes('javascript') || contentType.includes('x-www-form-urlencoded')) {
    return true;
  }
  return false;
}

function shouldParseJson(contentType: string | undefined, text: string): boolean {
  if (!text) {
    return false;
  }
  if (contentType && contentType.includes('json')) {
    return true;
  }
  const trimmed = text.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function toBodyCaptureResult(
  text: string | null,
  contentType: string | undefined,
  maxBodyBytes: number,
): BodyCaptureResult | undefined {
  if (text === null) {
    return undefined;
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const rawBytes = encoder.encode(text);
  const bytes = rawBytes.length;
  const truncated = bytes > maxBodyBytes;
  const limitedBytes = truncated ? rawBytes.slice(0, maxBodyBytes) : rawBytes;
  const limitedText = decoder.decode(limitedBytes);
  let parsedJson: unknown;
  if (!truncated && shouldParseJson(contentType, limitedText)) {
    try {
      parsedJson = JSON.parse(limitedText);
    } catch {
      parsedJson = undefined;
    }
  }

  return {
    contentType,
    bodyText: limitedText,
    bodyJson: parsedJson,
    bodyBytes: bytes,
    truncated,
  };
}

function serializeFormData(formData: FormData): string {
  const entries: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string') {
      entries[key] = value;
      continue;
    }
    entries[key] = {
      name: value.name,
      size: value.size,
      type: value.type,
    };
  }
  return JSON.stringify(entries);
}

async function serializeFetchBody(body: BodyInit | null | undefined): Promise<string | null> {
  if (body === null || body === undefined) {
    return null;
  }
  if (typeof body === 'string') {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    return serializeFormData(body);
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return await body.text();
  }
  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(body));
  }
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(new Uint8Array(body.buffer));
  }
  return null;
}

function serializeXhrBody(body?: Document | XMLHttpRequestBodyInit | null): string | null {
  if (body === null || body === undefined) {
    return null;
  }

  if (typeof body === 'string') {
    return body;
  }

  if (body instanceof URLSearchParams) {
    return body.toString();
  }

  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    return serializeFormData(body);
  }

  if (body instanceof Document) {
    return body.documentElement?.outerHTML ?? body.textContent ?? null;
  }

  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(body));
  }

  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(new Uint8Array(body.buffer));
  }

  return null;
}

function resolveFetchRequestContentType(input: RequestInfo | URL, init?: RequestInit): string | undefined {
  const fromInit = parseContentTypeFromHeaders(init?.headers);
  if (fromInit) {
    return fromInit;
  }

  if (typeof Request !== 'undefined' && input instanceof Request) {
    return normalizeContentType(input.headers.get('content-type'));
  }

  return undefined;
}

async function captureFetchRequestBody(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  maxBodyBytes: number,
): Promise<BodyCaptureResult | undefined> {
  const contentType = resolveFetchRequestContentType(input, init);
  let bodyText: string | null = null;

  if (init && 'body' in init) {
    bodyText = await serializeFetchBody(init.body);
  } else if (typeof Request !== 'undefined' && input instanceof Request) {
    try {
      bodyText = await input.clone().text();
    } catch {
      bodyText = null;
    }
  }

  return toBodyCaptureResult(bodyText, contentType, maxBodyBytes);
}

async function captureFetchResponseBody(response: Response, maxBodyBytes: number): Promise<BodyCaptureResult | undefined> {
  const contentType = normalizeContentType(response.headers.get('content-type'));
  if (!isTextualBodyContentType(contentType)) {
    const contentLengthHeader = response.headers.get('content-length');
    const parsedLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
    if (parsedLength !== undefined && Number.isFinite(parsedLength)) {
      return {
        contentType,
        bodyBytes: parsedLength,
        truncated: parsedLength > maxBodyBytes,
      };
    }
    return undefined;
  }

  try {
    const text = await response.clone().text();
    return toBodyCaptureResult(text, contentType, maxBodyBytes);
  } catch {
    return undefined;
  }
}

function makeRequestId(counter: { value: number }): string {
  counter.value += 1;
  return `req-${Date.now()}-${counter.value}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeTraceId(): string {
  return `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeMaxBodyBytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_MAX_BODY_BYTES;
  }
  const floored = Math.floor(value);
  if (floored < 4096) {
    return DEFAULT_MAX_BODY_BYTES;
  }
  return Math.min(floored, 5 * 1024 * 1024);
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
  const originalXhrSetRequestHeader = xhrPrototype?.setRequestHeader;
  const xhrCaptures = new WeakMap<XMLHttpRequest, XhrCaptureRecord>();
  const requestCounter = { value: 0 };
  let networkConfig: NetworkCaptureConfig = {
    captureBodies: false,
    maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
  };
  let lastTraceHint: TraceHint | null = null;

  const emit = (eventType: string, data: Record<string, unknown>): void => {
    const payload: BridgePayload = {
      source: BRIDGE_SOURCE,
      kind: BRIDGE_KIND,
      eventType,
      data,
    };
    win.postMessage(payload, '*');
  };

  const resolveTraceContext = (startedAt: number): { traceId: string; eventType?: string; selector?: string } => {
    if (lastTraceHint && startedAt - lastTraceHint.timestamp <= TRACE_HINT_TTL_MS) {
      return {
        traceId: lastTraceHint.traceId,
        eventType: lastTraceHint.eventType,
        selector: lastTraceHint.selector,
      };
    }
    return {
      traceId: makeTraceId(),
    };
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

  const onControlMessage = (event: MessageEvent<unknown>): void => {
    if (event.source && event.source !== win) {
      return;
    }

    const payload = event.data as {
      source?: string;
      kind?: string;
      controlType?: string;
      data?: Record<string, unknown>;
    } | null;
    if (!payload || payload.source !== BRIDGE_SOURCE || payload.kind !== BRIDGE_CONTROL_KIND) {
      return;
    }

    if (payload.controlType === 'network_config') {
      const data = payload.data ?? {};
      networkConfig = {
        captureBodies: data.captureBodies === true,
        maxBodyBytes: normalizeMaxBodyBytes(data.maxBodyBytes),
      };
      return;
    }

    if (payload.controlType === 'trace_hint') {
      const data = payload.data ?? {};
      if (typeof data.traceId !== 'string' || data.traceId.trim().length === 0) {
        return;
      }
      lastTraceHint = {
        traceId: data.traceId,
        eventType: typeof data.eventType === 'string' ? data.eventType : undefined,
        selector: typeof data.selector === 'string' ? data.selector : undefined,
        timestamp:
          typeof data.timestamp === 'number' && Number.isFinite(data.timestamp)
            ? Math.floor(data.timestamp)
            : Date.now(),
      };
    }
  };

  const emitNetwork = (payload: {
    requestId: string;
    traceId: string;
    traceEventType?: string;
    traceSelector?: string;
    method: string;
    url: string;
    status: number;
    duration: number;
    initiator: 'fetch' | 'xhr';
    errorType?: NetworkErrorType;
    responseSize?: number;
    requestBody?: BodyCaptureResult;
    responseBody?: BodyCaptureResult;
  }): void => {
    emit('network', {
      requestId: payload.requestId,
      traceId: payload.traceId,
      traceEventType: payload.traceEventType,
      traceSelector: payload.traceSelector,
      method: payload.method,
      url: payload.url,
      status: payload.status,
      duration: payload.duration,
      initiator: payload.initiator,
      errorType: payload.errorType,
      responseSize: payload.responseSize,
      requestContentType: payload.requestBody?.contentType,
      requestBodyText: payload.requestBody?.bodyText,
      requestBodyJson: payload.requestBody?.bodyJson,
      requestBodyBytes: payload.requestBody?.bodyBytes,
      requestBodyTruncated: payload.requestBody?.truncated === true,
      responseContentType: payload.responseBody?.contentType,
      responseBodyText: payload.responseBody?.bodyText,
      responseBodyJson: payload.responseBody?.bodyJson,
      responseBodyBytes: payload.responseBody?.bodyBytes,
      responseBodyTruncated: payload.responseBody?.truncated === true,
      timestamp: Date.now(),
    });
  };

  if (originalFetch) {
    win.fetch = (async (...args: Parameters<typeof fetch>) => {
      const startedAt = Date.now();
      const [input, init] = args;
      const method = parseFetchMethod(input, init);
      const url = parseFetchUrl(input, win);
      const requestId = makeRequestId(requestCounter);
      const trace = resolveTraceContext(startedAt);
      const requestBody = networkConfig.captureBodies
        ? await captureFetchRequestBody(input, init, networkConfig.maxBodyBytes)
        : undefined;

      try {
        const response = await originalFetch(...args);
        const duration = Date.now() - startedAt;
        const responseBody = networkConfig.captureBodies
          ? await captureFetchResponseBody(response, networkConfig.maxBodyBytes)
          : undefined;
        const contentLengthHeader = response.headers.get('content-length');
        const parsedContentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
        const responseSize = responseBody?.bodyBytes
          ?? (Number.isFinite(parsedContentLength) ? parsedContentLength : undefined);

        emitNetwork({
          requestId,
          traceId: trace.traceId,
          traceEventType: trace.eventType,
          traceSelector: trace.selector,
          method,
          url,
          status: response.status,
          duration,
          initiator: 'fetch',
          errorType: inferErrorType(response.status, undefined),
          responseSize,
          requestBody,
          responseBody,
        });

        return response;
      } catch (error) {
        const duration = Date.now() - startedAt;
        emitNetwork({
          requestId,
          traceId: trace.traceId,
          traceEventType: trace.eventType,
          traceSelector: trace.selector,
          method,
          url,
          status: 0,
          duration,
          initiator: 'fetch',
          errorType: inferErrorType(0, error),
          requestBody,
        });
        throw error;
      }
    }) as typeof fetch;
  }

  if (xhrPrototype && originalXhrOpen && originalXhrSend && originalXhrSetRequestHeader) {
    xhrPrototype.open = function open(
      method: string,
      url: string,
      async?: boolean,
      username?: string | null,
      password?: string | null
    ): void {
      const startedAt = Date.now();
      const requestId = makeRequestId(requestCounter);
      const trace = resolveTraceContext(startedAt);
      xhrCaptures.set(this, {
        requestId,
        traceId: trace.traceId,
        traceEventType: trace.eventType,
        traceSelector: trace.selector,
        method: normalizeMethod(method),
        url: toAbsoluteUrl(url, win),
        startedAt,
        emitted: false,
      });
      originalXhrOpen.call(this, method, url, async ?? true, username ?? null, password ?? null);
    };

    xhrPrototype.setRequestHeader = function setRequestHeader(name: string, value: string): void {
      const capture = xhrCaptures.get(this);
      if (capture && name.toLowerCase() === 'content-type') {
        capture.requestContentType = normalizeContentType(value);
      }
      originalXhrSetRequestHeader.call(this, name, value);
    };

    xhrPrototype.send = function send(body?: Document | XMLHttpRequestBodyInit | null): void {
      const capture = xhrCaptures.get(this);
      if (capture) {
        capture.startedAt = Date.now();
        if (networkConfig.captureBodies) {
          const serializedBody = serializeXhrBody(body);
          capture.requestBody = toBodyCaptureResult(
            serializedBody,
            capture.requestContentType,
            networkConfig.maxBodyBytes,
          );
        }
        const emitFromXhr = (statusOverride?: number, reason?: unknown): void => {
          if (capture.emitted) {
            return;
          }
          capture.emitted = true;
          const status = statusOverride ?? this.status ?? 0;
          const responseContentType = normalizeContentType(
            typeof this.getResponseHeader === 'function' ? this.getResponseHeader('content-type') : null,
          );
          const responseBody = networkConfig.captureBodies
            ? toBodyCaptureResult(this.responseText ?? '', responseContentType, networkConfig.maxBodyBytes)
            : undefined;
          emitNetwork({
            requestId: capture.requestId,
            traceId: capture.traceId,
            traceEventType: capture.traceEventType,
            traceSelector: capture.traceSelector,
            method: capture.method,
            url: capture.url,
            status,
            duration: Date.now() - capture.startedAt,
            initiator: 'xhr',
            errorType: inferErrorType(status, reason),
            responseSize: responseBody?.bodyBytes ?? getResponseSize(this.responseText),
            requestBody: capture.requestBody,
            responseBody,
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
  win.addEventListener('message', onControlMessage);

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
    if (xhrPrototype && originalXhrOpen && originalXhrSend && originalXhrSetRequestHeader) {
      xhrPrototype.open = originalXhrOpen;
      xhrPrototype.send = originalXhrSend;
      xhrPrototype.setRequestHeader = originalXhrSetRequestHeader;
    }
    win.removeEventListener('error', onRuntimeError);
    win.removeEventListener('unhandledrejection', onUnhandledRejection);
    win.removeEventListener('message', onControlMessage);
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
