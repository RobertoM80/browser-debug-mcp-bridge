import { FastifyInstance } from 'fastify';
import { WebSocketServer, WebSocket } from 'ws';
import { parseMessage, createPongMessage, createErrorMessage, WebSocketMessage } from './messages';
import { EventsRepository } from '../db/events-repository';
import { getConnection } from '../db/connection';

interface ConnectionInfo {
  ws: WebSocket;
  sessionId?: string;
  connectedAt: number;
  lastPingAt: number;
  messageCount: number;
}

export class WebSocketManager {
  private wss: WebSocketServer | null = null;
  private connections: Map<WebSocket, ConnectionInfo> = new Map();
  private eventsRepository: EventsRepository | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private readonly PING_INTERVAL_MS = 30000;
  private readonly PONG_TIMEOUT_MS = 10000;

  constructor(eventsRepository?: EventsRepository) {
    if (eventsRepository) {
      this.eventsRepository = eventsRepository;
    }
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
    this.wss = new WebSocketServer({
      server: server.server,
      path: '/ws',
    });

    this.wss.on('connection', (ws: WebSocket) => {
      this.handleConnection(ws);
    });

    this.startPingInterval();

    server.log.info('WebSocket server initialized on /ws');
  }

  private handleConnection(ws: WebSocket): void {
    const connectionInfo: ConnectionInfo = {
      ws,
      connectedAt: Date.now(),
      lastPingAt: Date.now(),
      messageCount: 0,
    };

    this.connections.set(ws, connectionInfo);

    ws.on('message', (data: Buffer) => {
      this.handleMessage(ws, data.toString());
    });

    ws.on('close', () => {
      this.handleDisconnect(ws);
    });

    ws.on('error', (error: Error) => {
      console.error('[WebSocket] Connection error:', error.message);
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
          break;

        case 'session_end':
          this.getRepository().endSession(message);
          if (connectionInfo.sessionId === message.sessionId) {
            connectionInfo.sessionId = undefined;
          }
          break;

        case 'event':
          if (!this.getRepository().sessionExists(message.sessionId)) {
            ws.send(JSON.stringify(createErrorMessage('Session not found', 'SESSION_NOT_FOUND')));
            return;
          }
          this.getRepository().insertEvent(message);
          break;

        default:
          ws.send(JSON.stringify(createErrorMessage(`Unknown message type`, 'UNKNOWN_TYPE')));
      }
    } catch (error) {
      console.error('[WebSocket] Error handling message:', error);
      ws.send(JSON.stringify(createErrorMessage(
        error instanceof Error ? error.message : 'Internal server error',
        'INTERNAL_ERROR'
      )));
    }
  }

  private handleDisconnect(ws: WebSocket): void {
    this.connections.delete(ws);
  }

  private startPingInterval(): void {
    this.pingInterval = setInterval(() => {
      const now = Date.now();
      
      for (const [ws, info] of this.connections) {
        if (now - info.lastPingAt > this.PING_INTERVAL_MS + this.PONG_TIMEOUT_MS) {
          console.log('[WebSocket] Closing stale connection');
          ws.terminate();
          this.connections.delete(ws);
        }
      }
    }, this.PING_INTERVAL_MS);
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

  close(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    for (const [ws] of this.connections) {
      ws.close();
    }
    this.connections.clear();

    this.wss?.close();
    this.wss = null;
  }
}
