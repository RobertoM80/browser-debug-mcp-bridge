export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export interface SessionStartContext {
  url: string;
  tabId?: number;
  windowId?: number;
  userAgent?: string;
  viewport?: {
    width: number;
    height: number;
  };
  dpr?: number;
  safeMode?: boolean;
}

export interface SessionState {
  isActive: boolean;
  sessionId: string | null;
  connectionStatus: ConnectionStatus;
  queuedEvents: number;
  droppedEvents: number;
}

type WsEventType = 'open' | 'close' | 'error' | 'message';

interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: WsEventType, listener: (event: unknown) => void): void;
}

interface OutboundMessage {
  type: 'session_start' | 'session_end' | 'event';
  timestamp: number;
  sessionId: string;
  url?: string;
  tabId?: number;
  windowId?: number;
  userAgent?: string;
  viewport?: {
    width: number;
    height: number;
  };
  dpr?: number;
  safeMode?: boolean;
  eventType?: string;
  data?: Record<string, unknown>;
}

interface SessionManagerOptions {
  wsUrl?: string;
  maxBufferSize?: number;
  createSessionId?: () => string;
  createWebSocket?: (url: string) => WebSocketLike;
  now?: () => number;
}

const WS_CONNECTING = 0;
const WS_OPEN = 1;

export class SessionManager {
  private readonly wsUrl: string;
  private readonly maxBufferSize: number;
  private readonly createSessionId: () => string;
  private readonly createWebSocket: (url: string) => WebSocketLike;
  private readonly now: () => number;

  private ws: WebSocketLike | null = null;
  private buffer: OutboundMessage[] = [];
  private isActive = false;
  private sessionId: string | null = null;
  private connectionStatus: ConnectionStatus = 'disconnected';
  private droppedEvents = 0;

  constructor(options: SessionManagerOptions = {}) {
    this.wsUrl = options.wsUrl ?? 'ws://127.0.0.1:3000/ws';
    this.maxBufferSize = options.maxBufferSize ?? 200;
    this.createSessionId = options.createSessionId ?? (() => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    this.createWebSocket = options.createWebSocket ?? ((url) => new WebSocket(url));
    this.now = options.now ?? (() => Date.now());
  }

  startSession(context: SessionStartContext): SessionState {
    if (this.isActive && this.sessionId) {
      return this.getState();
    }

    this.sessionId = this.createSessionId();
    this.isActive = true;
    this.ensureConnection();

    this.enqueueMessage({
      type: 'session_start',
      sessionId: this.sessionId,
      timestamp: this.now(),
      url: context.url,
      tabId: context.tabId,
      windowId: context.windowId,
      userAgent: context.userAgent,
      viewport: context.viewport,
      dpr: context.dpr,
      safeMode: context.safeMode ?? false,
    });

    return this.getState();
  }

  stopSession(): SessionState {
    if (!this.isActive || !this.sessionId) {
      return this.getState();
    }

    this.enqueueMessage({
      type: 'session_end',
      sessionId: this.sessionId,
      timestamp: this.now(),
    });

    this.isActive = false;
    this.sessionId = null;
    return this.getState();
  }

  queueEvent(eventType: string, data: Record<string, unknown>): boolean {
    if (!this.isActive || !this.sessionId) {
      return false;
    }

    this.enqueueMessage({
      type: 'event',
      sessionId: this.sessionId,
      eventType,
      data,
      timestamp: this.now(),
    });

    return true;
  }

  getState(): SessionState {
    return {
      isActive: this.isActive,
      sessionId: this.sessionId,
      connectionStatus: this.connectionStatus,
      queuedEvents: this.buffer.length,
      droppedEvents: this.droppedEvents,
    };
  }

  private ensureConnection(): void {
    if (this.ws && (this.ws.readyState === WS_CONNECTING || this.ws.readyState === WS_OPEN)) {
      return;
    }

    this.connectionStatus = 'connecting';
    this.ws = this.createWebSocket(this.wsUrl);

    this.ws.addEventListener('open', () => {
      this.connectionStatus = 'connected';
      this.flushBuffer();
    });

    this.ws.addEventListener('close', () => {
      this.connectionStatus = 'disconnected';
      this.ws = null;
    });

    this.ws.addEventListener('error', () => {
      this.connectionStatus = 'disconnected';
    });
  }

  private enqueueMessage(message: OutboundMessage): void {
    if (this.buffer.length >= this.maxBufferSize) {
      this.buffer.shift();
      this.droppedEvents += 1;
    }

    this.buffer.push(message);
    this.flushBuffer();
  }

  private flushBuffer(): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      return;
    }

    while (this.buffer.length > 0) {
      const next = this.buffer.shift();
      if (!next) {
        return;
      }
      this.ws.send(JSON.stringify(next));
    }
  }
}
