import { FastifyInstance } from 'fastify';
import { WebSocketServer, WebSocket } from 'ws';
import {
  parseMessage,
  createPongMessage,
  createErrorMessage,
  createCaptureCommandMessage,
  CaptureCommand,
  CaptureResultMessage,
  EventBatchMessage,
} from './messages.js';
import { EventsRepository } from '../db/events-repository.js';
import { getConnection } from '../db/connection.js';

interface StructuredLogger {
  info(payload: Record<string, unknown>, message?: string): void;
  warn(payload: Record<string, unknown>, message?: string): void;
  error(payload: Record<string, unknown>, message?: string): void;
  debug(payload: Record<string, unknown>, message?: string): void;
}

function createConsoleLogger(): StructuredLogger {
  return {
    info: (payload, message) => {
      console.info(message ?? '[MCPServer][WebSocket][info]', payload);
    },
    warn: (payload, message) => {
      console.warn(message ?? '[MCPServer][WebSocket][warn]', payload);
    },
    error: (payload, message) => {
      console.error(message ?? '[MCPServer][WebSocket][error]', payload);
    },
    debug: (payload, message) => {
      console.debug(message ?? '[MCPServer][WebSocket][debug]', payload);
    },
  };
}

interface ConnectionInfo {
  ws: WebSocket;
  sessionId?: string;
  connectedAt: number;
  lastPingAt: number;
  messageCount: number;
  disconnectReason?: 'manual_stop' | 'network_error' | 'stale_timeout' | 'normal_closure' | 'abnormal_close' | 'unknown';
}

export interface SessionConnectionState {
  sessionId: string;
  connected: boolean;
  connectedAt: number;
  lastHeartbeatAt: number;
  disconnectedAt?: number;
  disconnectReason?: 'manual_stop' | 'network_error' | 'stale_timeout' | 'normal_closure' | 'abnormal_close' | 'unknown';
}

interface PendingCaptureRequest {
  sessionId: string;
  resolve: (result: CaptureCommandResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface CaptureCommandResult {
  ok: boolean;
  payload?: Record<string, unknown>;
  truncated?: boolean;
  error?: string;
}

export class WebSocketManager {
  private wss: WebSocketServer | null = null;
  private connections: Map<WebSocket, ConnectionInfo> = new Map();
  private sessionStates: Map<string, SessionConnectionState> = new Map();
  private eventsRepository: EventsRepository | null = null;
  private pendingCaptureRequests: Map<string, PendingCaptureRequest> = new Map();
  private commandCounter = 0;
  private logger: StructuredLogger;
  private pingInterval: NodeJS.Timeout | null = null;
  private readonly PING_INTERVAL_MS = 30000;
  private readonly PONG_TIMEOUT_MS = 10000;

  constructor(eventsRepository?: EventsRepository, logger?: StructuredLogger) {
    if (eventsRepository) {
      this.eventsRepository = eventsRepository;
    }
    this.logger = logger ?? createConsoleLogger();
  }

  setRepository(repository: EventsRepository): void {
    this.eventsRepository = repository;
  }

  private getRepository(): EventsRepository {
    if (!this.eventsRepository) {
      const { db } = getConnection();
      this.eventsRepository = new EventsRepository(db);
    }
    return this.eventsRepository;
  }

  initialize(server: FastifyInstance): void {
    this.logger = {
      info: (payload, message) => server.log.info(payload, message),
      warn: (payload, message) => server.log.warn(payload, message),
      error: (payload, message) => server.log.error(payload, message),
      debug: (payload, message) => server.log.debug(payload, message),
    };

    this.wss = new WebSocketServer({
      server: server.server,
      path: '/ws',
    });

    this.wss.on('connection', (ws: WebSocket) => {
      this.handleConnection(ws);
    });

    this.startPingInterval();

    this.logger.info({ component: 'websocket', event: 'server_initialized', path: '/ws' }, '[MCPServer][WebSocket] Initialized');
  }

  private handleConnection(ws: WebSocket): void {
    const connectionInfo: ConnectionInfo = {
      ws,
      connectedAt: Date.now(),
      lastPingAt: Date.now(),
      messageCount: 0,
    };

    this.connections.set(ws, connectionInfo);
    this.logger.info(
      {
        component: 'websocket',
        event: 'connection_open',
        connections: this.connections.size,
      },
      '[MCPServer][WebSocket] Connection opened',
    );

    ws.on('message', (data: Buffer) => {
      this.handleMessage(ws, data.toString());
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this.handleDisconnect(ws, code, reason);
    });

    ws.on('error', (error: Error) => {
      this.logger.error(
        {
          component: 'websocket',
          event: 'connection_error',
          message: error.message,
        },
        '[MCPServer][WebSocket] Connection error',
      );
      connectionInfo.disconnectReason = 'network_error';
      this.handleDisconnect(ws);
    });
  }

  private handleMessage(ws: WebSocket, data: string): void {
    const connectionInfo = this.connections.get(ws);
    if (!connectionInfo) return;

    connectionInfo.messageCount++;

    const message = parseMessage(data);
    
    if (!message) {
      ws.send(JSON.stringify(createErrorMessage('Invalid message format', 'INVALID_MESSAGE')));
      return;
    }

    connectionInfo.lastPingAt = Date.now();

    if (connectionInfo.sessionId) {
      const previous = this.sessionStates.get(connectionInfo.sessionId);
      this.sessionStates.set(connectionInfo.sessionId, {
        sessionId: connectionInfo.sessionId,
        connected: true,
        connectedAt: previous?.connectedAt ?? connectionInfo.connectedAt,
        lastHeartbeatAt: connectionInfo.lastPingAt,
      });
    }

    this.logger.debug(
      {
        component: 'websocket',
        event: 'message_received',
        messageType: message.type,
      },
      '[MCPServer][WebSocket] Message received',
    );

    try {
      switch (message.type) {
        case 'ping':
          ws.send(JSON.stringify(createPongMessage()));
          connectionInfo.lastPingAt = Date.now();
          break;

        case 'pong':
          connectionInfo.lastPingAt = Date.now();
          break;

        case 'session_start':
          this.getRepository().createSession(message);
          connectionInfo.sessionId = message.sessionId;
          this.sessionStates.set(message.sessionId, {
            sessionId: message.sessionId,
            connected: true,
            connectedAt: connectionInfo.connectedAt,
            lastHeartbeatAt: connectionInfo.lastPingAt,
          });
          break;

        case 'session_end':
          this.getRepository().endSession(message);
          if (connectionInfo.sessionId === message.sessionId) {
            connectionInfo.sessionId = undefined;
          }
          connectionInfo.disconnectReason = 'manual_stop';
          this.markSessionDisconnected(message.sessionId, 'manual_stop');
          break;

        case 'event':
          if (!this.getRepository().sessionExists(message.sessionId)) {
            ws.send(JSON.stringify(createErrorMessage('Session not found', 'SESSION_NOT_FOUND')));
            return;
          }
          this.getRepository().insertEvent(message);
          break;

        case 'event_batch':
          if (!this.getRepository().sessionExists(message.sessionId)) {
            ws.send(JSON.stringify(createErrorMessage('Session not found', 'SESSION_NOT_FOUND')));
            return;
          }
          this.getRepository().insertEventsBatch(this.toEventMessages(message));
          break;

        case 'capture_result':
          this.resolvePendingCapture(message);
          break;

        default:
          ws.send(JSON.stringify(createErrorMessage(`Unknown message type`, 'UNKNOWN_TYPE')));
      }
    } catch (error) {
      this.logger.error(
        {
          component: 'websocket',
          event: 'message_error',
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        '[MCPServer][WebSocket] Error handling message',
      );
      ws.send(JSON.stringify(createErrorMessage(
        error instanceof Error ? error.message : 'Internal server error',
        'INTERNAL_ERROR'
      )));
    }
  }

  private handleDisconnect(ws: WebSocket, closeCode?: number, closeReasonRaw?: Buffer): void {
    const connection = this.connections.get(ws);
    if (connection?.sessionId) {
      this.rejectPendingForSession(connection.sessionId, 'Connection closed before capture completed');
    }

    const closeReason = closeReasonRaw && closeReasonRaw.length > 0 ? closeReasonRaw.toString('utf8') : undefined;
    const disconnectReason =
      connection?.disconnectReason
      ?? (closeCode === 1000 ? 'normal_closure' : closeCode ? 'abnormal_close' : 'unknown');

    if (connection?.sessionId) {
      this.markSessionDisconnected(connection.sessionId, disconnectReason);
    }

    this.connections.delete(ws);
    this.logger.info(
      {
        component: 'websocket',
        event: 'connection_closed',
        sessionId: connection?.sessionId,
        reason: disconnectReason,
        closeCode,
        closeReason,
        connections: this.connections.size,
      },
      '[MCPServer][WebSocket] Connection closed',
    );
  }

  private toEventMessages(message: EventBatchMessage) {
    return message.events.map((event) => ({
      type: 'event' as const,
      sessionId: message.sessionId,
      eventType: event.eventType,
      data: event.data,
      timestamp: event.timestamp ?? message.timestamp ?? Date.now(),
      tabId: event.tabId,
      origin: event.origin,
    }));
  }

  private resolvePendingCapture(message: CaptureResultMessage): void {
    const pending = this.pendingCaptureRequests.get(message.commandId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingCaptureRequests.delete(message.commandId);

    pending.resolve({
      ok: message.ok,
      payload: message.payload,
      truncated: message.truncated,
      error: message.error,
    });
  }

  private rejectPendingForSession(sessionId: string, reason: string): void {
    const entries = Array.from(this.pendingCaptureRequests.entries());
    for (const [commandId, pending] of entries) {
      if (pending.sessionId !== sessionId) {
        continue;
      }

      clearTimeout(pending.timeout);
      this.pendingCaptureRequests.delete(commandId);
      pending.reject(new Error(reason));
    }
  }

  private findConnectionBySession(sessionId: string): ConnectionInfo | undefined {
    for (const connection of this.connections.values()) {
      if (connection.sessionId === sessionId) {
        return connection;
      }
    }

    return undefined;
  }

  async sendCaptureCommand(
    sessionId: string,
    command: CaptureCommand,
    payload: Record<string, unknown>,
    timeoutMs: number = 4000,
  ): Promise<CaptureCommandResult> {
    const connection = this.findConnectionBySession(sessionId);
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`No active extension connection for session ${sessionId}`);
    }

    const commandId = `capture-${Date.now()}-${this.commandCounter++}`;
    const message = createCaptureCommandMessage(commandId, sessionId, command, payload, timeoutMs);

    this.logger.debug(
      {
        component: 'websocket',
        event: 'capture_command_sent',
        sessionId,
        command,
        commandId,
      },
      '[MCPServer][WebSocket] Sending capture command',
    );

    return new Promise<CaptureCommandResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCaptureRequests.delete(commandId);
        reject(new Error(`Capture command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingCaptureRequests.set(commandId, {
        sessionId,
        resolve,
        reject,
        timeout,
      });

      try {
        connection.ws.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timeout);
        this.pendingCaptureRequests.delete(commandId);
        reject(error instanceof Error ? error : new Error('Failed to send capture command'));
      }
    });
  }

  private startPingInterval(): void {
    this.pingInterval = setInterval(() => {
      const now = Date.now();
      
      for (const [ws, info] of this.connections) {
        if (now - info.lastPingAt > this.PING_INTERVAL_MS + this.PONG_TIMEOUT_MS) {
          info.disconnectReason = 'stale_timeout';
          this.logger.warn(
            {
              component: 'websocket',
              event: 'stale_connection_terminated',
              sessionId: info.sessionId,
              idleMs: now - info.lastPingAt,
            },
            '[MCPServer][WebSocket] Closing stale connection',
          );
          ws.terminate();
          this.connections.delete(ws);
        }

        if (info.sessionId) {
          const previous = this.sessionStates.get(info.sessionId);
          this.sessionStates.set(info.sessionId, {
            sessionId: info.sessionId,
            connected: true,
            connectedAt: previous?.connectedAt ?? info.connectedAt,
            lastHeartbeatAt: info.lastPingAt,
          });
        }
      }
    }, this.PING_INTERVAL_MS);
  }

  private markSessionDisconnected(
    sessionId: string,
    reason: SessionConnectionState['disconnectReason'],
  ): void {
    const previous = this.sessionStates.get(sessionId);
    const disconnectedAt = Date.now();
    this.sessionStates.set(sessionId, {
      sessionId,
      connected: false,
      connectedAt: previous?.connectedAt ?? disconnectedAt,
      lastHeartbeatAt: previous?.lastHeartbeatAt ?? disconnectedAt,
      disconnectedAt,
      disconnectReason: reason,
    });
  }

  getConnectionStats(): { total: number; withSession: number } {
    let withSession = 0;
    for (const info of this.connections.values()) {
      if (info.sessionId) withSession++;
    }
    return {
      total: this.connections.size,
      withSession,
    };
  }

  getSessionConnectionState(sessionId: string): SessionConnectionState | undefined {
    const direct = this.sessionStates.get(sessionId);
    if (direct) {
      return { ...direct };
    }

    const live = this.findConnectionBySession(sessionId);
    if (!live) {
      return undefined;
    }

    return {
      sessionId,
      connected: live.ws.readyState === WebSocket.OPEN,
      connectedAt: live.connectedAt,
      lastHeartbeatAt: live.lastPingAt,
    };
  }

  close(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    for (const [commandId, pending] of this.pendingCaptureRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('WebSocket manager closed'));
      this.pendingCaptureRequests.delete(commandId);
    }

    for (const [ws] of this.connections) {
      ws.close();
    }
    this.connections.clear();

    this.wss?.close();
    this.wss = null;
  }
}
