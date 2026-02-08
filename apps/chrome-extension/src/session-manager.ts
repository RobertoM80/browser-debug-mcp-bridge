import { RedactionEngine } from '../../../libs/redaction/src';

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

export type CaptureCommandType =
  | 'CAPTURE_DOM_SUBTREE'
  | 'CAPTURE_DOM_DOCUMENT'
  | 'CAPTURE_COMPUTED_STYLES'
  | 'CAPTURE_LAYOUT_METRICS';

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
  payload: Record<string, unknown>
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

  constructor(options: SessionManagerOptions = {}) {
    this.wsUrl = options.wsUrl ?? 'ws://127.0.0.1:3000/ws';
    this.maxBufferSize = options.maxBufferSize ?? 200;
    this.createSessionId = options.createSessionId ?? (() => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
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
      const response = await this.handleCaptureCommand(parsed.command, parsed.payload ?? {});
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
          }));
          continue;
        }
      }

      this.buffer.shift();
      this.ws.send(JSON.stringify(next));
    }
  }
}
