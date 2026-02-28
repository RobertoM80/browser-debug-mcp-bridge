import { RedactionEngine } from '../../../libs/redaction/src';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface SessionStartContext {
  url: string;
  tabId?: number;
  windowId?: number;
  baseOrigin?: string;
  allowedTabIds?: number[];
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
  baseOrigin?: string;
  allowedTabIds?: number[];
  connectionStatus: ConnectionStatus;
  queuedEvents: number;
  droppedEvents: number;
  reconnectAttempts: number;
}

type WsEventType = 'open' | 'close' | 'error' | 'message';

export type CaptureCommandType =
  | 'CAPTURE_DOM_SUBTREE'
  | 'CAPTURE_DOM_DOCUMENT'
  | 'CAPTURE_COMPUTED_STYLES'
  | 'CAPTURE_LAYOUT_METRICS'
  | 'CAPTURE_UI_SNAPSHOT'
  | 'CAPTURE_GET_LIVE_CONSOLE_LOGS';

interface CaptureCommandMessage {
  type: 'capture_command';
  commandId: string;
  sessionId: string;
  command: CaptureCommandType;
  payload?: Record<string, unknown>;
}

interface CaptureCommandResponse {
  payload: Record<string, unknown>;
  truncated?: boolean;
}

type CaptureCommandHandler = (
  command: CaptureCommandType,
  payload: Record<string, unknown>,
  context: { sessionId: string; commandId: string }
) => Promise<CaptureCommandResponse>;

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
  origin?: string;
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

interface OutboundEventPayload {
  eventType: string;
  data: Record<string, unknown>;
  timestamp: number;
  tabId?: number;
  origin?: string;
}

interface EventBatchMessage {
  type: 'event_batch';
  sessionId: string;
  timestamp: number;
  events: OutboundEventPayload[];
}

interface SessionManagerOptions {
  wsUrl?: string;
  maxBufferSize?: number;
  createSessionId?: () => string;
  createWebSocket?: (url: string) => WebSocketLike;
  now?: () => number;
  maxBatchSize?: number;
  redactionEngine?: RedactionEngine;
  handleCaptureCommand?: CaptureCommandHandler;
}

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const HEARTBEAT_INTERVAL_MS = 15000;
const RECONNECT_BUDGET_MS = 10 * 60 * 1000;
const RECONNECT_DELAYS_MS = [1000, 2000, 5000];

const SESSION_ADJECTIVES = [
  'brisk',
  'calm',
  'curious',
  'eager',
  'fuzzy',
  'gentle',
  'nimble',
  'rapid',
  'steady',
  'sunny',
];

const SESSION_ANIMALS = [
  'otter',
  'falcon',
  'lynx',
  'badger',
  'fox',
  'koala',
  'panda',
  'heron',
  'tiger',
  'yak',
];

function randomInt(maxExclusive: number): number {
  const safeMax = Math.max(1, Math.floor(maxExclusive));
  if (globalThis.crypto?.getRandomValues) {
    const values = new Uint32Array(1);
    globalThis.crypto.getRandomValues(values);
    return (values[0] ?? 0) % safeMax;
  }
  return Math.floor(Math.random() * safeMax);
}

function getUtcDateStamp(): string {
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function createDefaultSessionId(): string {
  const adjective = SESSION_ADJECTIVES[randomInt(SESSION_ADJECTIVES.length)] ?? 'calm';
  const animal = SESSION_ANIMALS[randomInt(SESSION_ANIMALS.length)] ?? 'otter';
  const dateStamp = getUtcDateStamp();
  const suffix = randomInt(36 ** 6).toString(36).padStart(6, '0');
  return `sess-${adjective}-${animal}-${dateStamp}-${suffix}`;
}

export class SessionManager {
  private readonly wsUrl: string;
  private readonly maxBufferSize: number;
  private readonly createSessionId: () => string;
  private readonly createWebSocket: (url: string) => WebSocketLike;
  private readonly now: () => number;
  private readonly maxBatchSize: number;
  private readonly redactionEngine: RedactionEngine;
  private readonly handleCaptureCommand?: CaptureCommandHandler;

  private ws: WebSocketLike | null = null;
  private buffer: OutboundMessage[] = [];
  private isActive = false;
  private sessionId: string | null = null;
  private connectionStatus: ConnectionStatus = 'disconnected';
  private droppedEvents = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private reconnectEligible = false;
  private reconnectStartedAt: number | null = null;
  private manualStopRequested = false;
  private activeBaseOrigin: string | null = null;
  private activeAllowedTabIds: number[] = [];

  constructor(options: SessionManagerOptions = {}) {
    this.wsUrl = options.wsUrl ?? 'ws://127.0.0.1:8065/ws';
    this.maxBufferSize = options.maxBufferSize ?? 200;
    this.createSessionId = options.createSessionId ?? createDefaultSessionId;
    this.createWebSocket = options.createWebSocket ?? ((url) => new WebSocket(url));
    this.now = options.now ?? (() => Date.now());
    this.maxBatchSize = options.maxBatchSize ?? 20;
    this.redactionEngine = options.redactionEngine ?? new RedactionEngine();
    this.handleCaptureCommand = options.handleCaptureCommand;
  }

  startSession(context: SessionStartContext): SessionState {
    if (this.isActive && this.sessionId) {
      return this.getState();
    }

    this.manualStopRequested = false;
    this.reconnectAttempts = 0;
    this.reconnectEligible = false;
    this.reconnectStartedAt = null;
    this.clearReconnectTimer();
    this.sessionId = this.createSessionId();
    this.isActive = true;
    this.activeBaseOrigin = typeof context.baseOrigin === 'string' ? context.baseOrigin : null;
    this.activeAllowedTabIds = Array.from(
      new Set(
        (context.allowedTabIds ?? []).filter(
          (tabId): tabId is number => typeof tabId === 'number' && Number.isFinite(tabId),
        ),
      ),
    );
    this.ensureConnection();
    this.startHeartbeat();

    this.enqueueMessage({
      type: 'session_start',
      sessionId: this.sessionId,
      timestamp: this.now(),
      url: context.url,
      origin: this.activeBaseOrigin ?? undefined,
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

    this.manualStopRequested = true;
    this.reconnectEligible = false;
    this.reconnectStartedAt = null;
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();
    this.stopHeartbeat();

    this.enqueueMessage({
      type: 'session_end',
      sessionId: this.sessionId,
      timestamp: this.now(),
    });

    this.isActive = false;
    this.sessionId = null;
    this.activeBaseOrigin = null;
    this.activeAllowedTabIds = [];
    return this.getState();
  }

  queueEvent(
    eventType: string,
    data: Record<string, unknown>,
    metadata?: { tabId?: number; origin?: string }
  ): boolean {
    if (!this.isActive || !this.sessionId) {
      return false;
    }

    this.enqueueMessage({
      type: 'event',
      sessionId: this.sessionId,
      eventType,
      data,
      tabId: metadata?.tabId,
      origin: metadata?.origin,
      timestamp: this.now(),
    });

    return true;
  }

  getState(): SessionState {
    return {
      isActive: this.isActive,
      sessionId: this.sessionId,
      baseOrigin: this.activeBaseOrigin ?? undefined,
      allowedTabIds: this.activeAllowedTabIds.slice(),
      connectionStatus: this.connectionStatus,
      queuedEvents: this.buffer.length,
      droppedEvents: this.droppedEvents,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  setSessionScope(scope: { baseOrigin?: string; allowedTabIds?: number[] }): void {
    if (!this.isActive || !this.sessionId) {
      return;
    }

    if (scope.baseOrigin !== undefined) {
      this.activeBaseOrigin = scope.baseOrigin;
    }

    if (Array.isArray(scope.allowedTabIds)) {
      this.activeAllowedTabIds = Array.from(
        new Set(
          scope.allowedTabIds.filter(
            (tabId): tabId is number => typeof tabId === 'number' && Number.isFinite(tabId),
          ),
        ),
      );
    }
  }

  private ensureConnection(): void {
    if (this.ws && (this.ws.readyState === WS_CONNECTING || this.ws.readyState === WS_OPEN)) {
      return;
    }

    this.connectionStatus = 'connecting';
    this.ws = this.createWebSocket(this.wsUrl);

    this.ws.addEventListener('open', () => {
      this.connectionStatus = 'connected';
      this.reconnectAttempts = 0;
      this.reconnectEligible = false;
      this.reconnectStartedAt = null;
      this.clearReconnectTimer();
      this.startHeartbeat();
      this.flushBuffer();
    });

    this.ws.addEventListener('close', () => {
      this.stopHeartbeat();
      if (this.connectionStatus === 'connected' && this.isActive && !this.manualStopRequested) {
        this.reconnectEligible = true;
        this.reconnectStartedAt = this.reconnectStartedAt ?? this.now();
      }

      this.ws = null;
      if (this.shouldReconnect()) {
        this.scheduleReconnect();
      } else {
        this.connectionStatus = 'disconnected';
      }
    });

    this.ws.addEventListener('error', () => {
      this.stopHeartbeat();
    });

    this.ws.addEventListener('message', (event) => {
      void this.handleInboundMessage(event);
    });
  }

  private async handleInboundMessage(event: unknown): Promise<void> {
    const data = this.readInboundData(event);
    if (!data || !this.ws || this.ws.readyState !== WS_OPEN) {
      return;
    }

    const parsed = this.parseCaptureCommand(data);
    if (!parsed || !this.sessionId || parsed.sessionId !== this.sessionId) {
      return;
    }

    if (!this.handleCaptureCommand) {
      this.ws.send(
        JSON.stringify({
          type: 'capture_result',
          commandId: parsed.commandId,
          sessionId: parsed.sessionId,
          ok: false,
          error: 'Capture command handler not configured',
          timestamp: this.now(),
        })
      );
      return;
    }

    try {
      const response = await this.handleCaptureCommand(parsed.command, parsed.payload ?? {}, {
        sessionId: parsed.sessionId,
        commandId: parsed.commandId,
      });
      this.ws.send(
        JSON.stringify({
          type: 'capture_result',
          commandId: parsed.commandId,
          sessionId: parsed.sessionId,
          ok: true,
          payload: response.payload,
          truncated: response.truncated,
          timestamp: this.now(),
        })
      );
    } catch (error) {
      this.ws.send(
        JSON.stringify({
          type: 'capture_result',
          commandId: parsed.commandId,
          sessionId: parsed.sessionId,
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to capture',
          timestamp: this.now(),
        })
      );
    }
  }

  private readInboundData(event: unknown): string | null {
    if (typeof event === 'string') {
      return event;
    }

    if (event && typeof event === 'object' && 'data' in event) {
      const data = (event as { data?: unknown }).data;
      if (typeof data === 'string') {
        return data;
      }
    }

    return null;
  }

  private parseCaptureCommand(data: string): CaptureCommandMessage | null {
    try {
      const parsed = JSON.parse(data) as unknown;
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }

      const message = parsed as Partial<CaptureCommandMessage>;
      if (
        message.type !== 'capture_command'
        || typeof message.commandId !== 'string'
        || typeof message.sessionId !== 'string'
        || typeof message.command !== 'string'
      ) {
        return null;
      }

      if (
        message.command !== 'CAPTURE_DOM_SUBTREE'
        && message.command !== 'CAPTURE_DOM_DOCUMENT'
        && message.command !== 'CAPTURE_COMPUTED_STYLES'
        && message.command !== 'CAPTURE_LAYOUT_METRICS'
        && message.command !== 'CAPTURE_UI_SNAPSHOT'
        && message.command !== 'CAPTURE_GET_LIVE_CONSOLE_LOGS'
      ) {
        return null;
      }

      return {
        type: 'capture_command',
        commandId: message.commandId,
        sessionId: message.sessionId,
        command: message.command,
        payload:
          message.payload && typeof message.payload === 'object' && !Array.isArray(message.payload)
            ? (message.payload as Record<string, unknown>)
            : {},
      };
    } catch {
      return null;
    }
  }

  private enqueueMessage(message: OutboundMessage): void {
    const sanitizedMessage = this.redactOutboundMessage(message);

    if (this.buffer.length >= this.maxBufferSize) {
      this.buffer.shift();
      this.droppedEvents += 1;
      console.warn(`[mcpdbg] dropped oldest queued event; total dropped=${this.droppedEvents}`);
    }

    this.buffer.push(sanitizedMessage);
    this.flushBuffer();
  }

  private redactOutboundMessage(message: OutboundMessage): OutboundMessage {
    const { result } = this.redactionEngine.redactObject(message as unknown as Record<string, unknown>);
    return result as unknown as OutboundMessage;
  }

  private flushBuffer(): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      return;
    }

    while (this.buffer.length > 0) {
      const next = this.buffer[0];
      if (!next) {
        return;
      }

      if (next.type === 'event') {
        const eventBatch: OutboundEventPayload[] = [];
        while (this.buffer.length > 0 && eventBatch.length < this.maxBatchSize) {
          const candidate = this.buffer[0];
          if (!candidate || candidate.type !== 'event' || !candidate.eventType || !candidate.data) {
            break;
          }

          this.buffer.shift();
          eventBatch.push({
            eventType: candidate.eventType,
            data: candidate.data,
            timestamp: candidate.timestamp,
            tabId: candidate.tabId,
            origin: candidate.origin,
          });
        }

        if (eventBatch.length >= 2) {
          const batchMessage: EventBatchMessage = {
            type: 'event_batch',
            sessionId: next.sessionId,
            timestamp: this.now(),
            events: eventBatch,
          };
          this.ws.send(JSON.stringify(batchMessage));
          console.debug(`[mcpdbg] sent batch size=${eventBatch.length} dropped=${this.droppedEvents}`);
          continue;
        }

        const single = eventBatch[0];
        if (single) {
          this.ws.send(JSON.stringify({
            type: 'event',
            sessionId: next.sessionId,
            eventType: single.eventType,
            data: single.data,
            timestamp: single.timestamp,
            tabId: single.tabId,
            origin: single.origin,
          }));
          continue;
        }
      }

      this.buffer.shift();
      this.ws.send(JSON.stringify(next));
    }
  }

  private shouldReconnect(): boolean {
    if (!this.isActive || this.manualStopRequested || !this.reconnectEligible) {
      return false;
    }

    if (this.reconnectStartedAt === null) {
      return false;
    }

    return this.now() - this.reconnectStartedAt <= RECONNECT_BUDGET_MS;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    this.connectionStatus = 'reconnecting';
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)] ?? 5000;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.shouldReconnect()) {
        this.connectionStatus = 'disconnected';
        return;
      }

      this.reconnectAttempts += 1;
      this.ensureConnection();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private startHeartbeat(): void {
    if (!this.isActive || this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WS_OPEN) {
        return;
      }

      try {
        this.ws.send(JSON.stringify({ type: 'ping', timestamp: this.now() }));
      } catch {
        // no-op, close handler will manage reconnect state
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) {
      return;
    }

    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}
