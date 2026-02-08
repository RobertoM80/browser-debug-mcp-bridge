import { BRIDGE_KIND, BRIDGE_SOURCE, BridgePayload } from './content-script';

interface InjectedCaptureOptions {
  win?: Window;
}

type ConsoleLevel = 'warn' | 'error';

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
  const originalWarn = console.warn;
  const originalError = console.error;

  const emit = (eventType: string, data: Record<string, unknown>): void => {
    const payload: BridgePayload = {
      source: BRIDGE_SOURCE,
      kind: BRIDGE_KIND,
      eventType,
      data,
    };
    win.postMessage(payload, '*');
  };

  const hookConsole = (level: ConsoleLevel, originalFn: typeof console.warn): typeof console.warn => {
    return (...args: unknown[]): void => {
      emit('console', {
        level,
        args: args.map(serializeArg),
        message: args.map((entry) => String(entry)).join(' '),
        timestamp: Date.now(),
      });
      originalFn.apply(console, args as Parameters<typeof console.warn>);
    };
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

  console.warn = hookConsole('warn', originalWarn);
  console.error = hookConsole('error', originalError);
  win.addEventListener('error', onRuntimeError);
  win.addEventListener('unhandledrejection', onUnhandledRejection);

  return () => {
    console.warn = originalWarn;
    console.error = originalError;
    win.removeEventListener('error', onRuntimeError);
    win.removeEventListener('unhandledrejection', onUnhandledRejection);
  };
}

if (typeof window !== 'undefined') {
  installInjectedCapture();
  console.log('[BrowserDebug] Injected script loaded');
}
