import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import Fastify, { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { WebSocketManager } from './websocket-server';
import { EventsRepository } from '../db/events-repository';
import { createConnection, closeConnection, resetConnection } from '../db/connection';

declare global {
  var testDbConn: { db: Database.Database } | undefined;
}
import { initializeDatabase } from '../db/migrations';
import { join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync, existsSync } from 'fs';
import type {
  PingMessage,
  PongMessage,
  EventMessage,
  SessionStartMessage,
  SessionEndMessage,
  ErrorMessage,
  CaptureCommandMessage,
} from './messages';

async function waitForMessage(ws: WebSocket, timeout = 1000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timeout waiting for message'));
    }, timeout);

    ws.once('message', (data) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data.toString()));
      } catch {
        resolve(data.toString());
      }
    });

    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('WebSocket Server', () => {
  let fastify: FastifyInstance;
  let wsManager: WebSocketManager;
  let testDbPath: string;
  let port: number;

  beforeEach(async () => {
    testDbPath = join(tmpdir(), `ws-test-${Date.now()}.db`);
    resetConnection();
    
    // Create connection and initialize database
    const conn = createConnection(testDbPath);
    initializeDatabase(conn.db);

    fastify = Fastify({ logger: false });
    
    fastify.get('/health', async () => ({ status: 'ok' }));

    await fastify.listen({ port: 0, host: '127.0.0.1' });
    port = (fastify.server.address() as { port: number }).port;

    wsManager = new WebSocketManager();
    wsManager.setRepository(new EventsRepository(conn.db));
    wsManager.initialize(fastify);
    
    // Store conn for use in tests
    (global as { testDbConn?: { db: Database.Database } }).testDbConn = conn;
  });

  afterEach(async () => {
    wsManager?.close();
    await fastify.close();
    
    // Close the test database connection before deleting the file
    if (global.testDbConn) {
      global.testDbConn.db.close();
      global.testDbConn = undefined;
    }
    
    closeConnection();
    
    // Give Windows time to release the file lock
    await wait(100);
    
    if (existsSync(testDbPath)) {
      try {
        unlinkSync(testDbPath);
      } catch {
        // File may still be locked, ignore
      }
    }
  });

  describe('Connection Management', () => {
    it('should accept WebSocket connections', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      
      await new Promise<void>((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it('should track connection stats', async () => {
      const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`);

      await Promise.all([
        new Promise<void>(resolve => ws1.on('open', resolve)),
        new Promise<void>(resolve => ws2.on('open', resolve)),
      ]);

      const stats = wsManager.getConnectionStats();
      expect(stats.total).toBe(2);
      expect(stats.withSession).toBe(0);

      ws1.close();
      ws2.close();
    });

    it('should handle multiple concurrent connections', async () => {
      const connections: WebSocket[] = [];
      
      for (let i = 0; i < 5; i++) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        connections.push(ws);
        await new Promise<void>(resolve => ws.on('open', resolve));
      }

      const stats = wsManager.getConnectionStats();
      expect(stats.total).toBe(5);

      connections.forEach(ws => ws.close());
    });
  });

  describe('Ping/Pong Health Check', () => {
    it('should respond to ping with pong', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>(resolve => ws.on('open', resolve));

      const pingMessage: PingMessage = { type: 'ping', timestamp: Date.now() };
      ws.send(JSON.stringify(pingMessage));

      const response = await waitForMessage(ws) as PongMessage;
      expect(response.type).toBe('pong');
      expect(response.timestamp).toBeDefined();

      ws.close();
    });

    it('should handle multiple ping messages', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>(resolve => ws.on('open', resolve));

      for (let i = 0; i < 3; i++) {
        const pingMessage: PingMessage = { type: 'ping', timestamp: Date.now() };
        ws.send(JSON.stringify(pingMessage));
        
        const response = await waitForMessage(ws) as PongMessage;
        expect(response.type).toBe('pong');
      }

      ws.close();
    });
  });

  describe('Session Management', () => {
    it('should create a session on session_start message', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>(resolve => ws.on('open', resolve));

      const sessionStart: SessionStartMessage = {
        type: 'session_start',
        sessionId: 'test-session-1',
        url: 'https://example.com',
        timestamp: Date.now(),
        safeMode: false,
      };

      ws.send(JSON.stringify(sessionStart));
      await wait(100);

      const { db } = global.testDbConn!;
      const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get('test-session-1');
      expect(session).toBeDefined();

      ws.close();
    });

    it('should end a session on session_end message', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>(resolve => ws.on('open', resolve));

      const sessionStart: SessionStartMessage = {
        type: 'session_start',
        sessionId: 'test-session-2',
        url: 'https://example.com',
        timestamp: Date.now(),
        safeMode: false,
      };

      ws.send(JSON.stringify(sessionStart));
      await wait(100);

      const sessionEnd: SessionEndMessage = {
        type: 'session_end',
        sessionId: 'test-session-2',
        timestamp: Date.now(),
      };

      ws.send(JSON.stringify(sessionEnd));
      await wait(100);

      const { db } = global.testDbConn!;
      const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get('test-session-2') as { ended_at: number | null };
      expect(session).toBeDefined();
      expect(session.ended_at).not.toBeNull();

      ws.close();
    });

    it('should store session metadata correctly', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>(resolve => ws.on('open', resolve));

      const sessionStart: SessionStartMessage = {
        type: 'session_start',
        sessionId: 'test-session-3',
        url: 'https://example.com/page',
        tabId: 42,
        windowId: 1,
        userAgent: 'TestAgent/1.0',
        viewport: { width: 1920, height: 1080 },
        dpr: 2.0,
        safeMode: true,
        timestamp: Date.now(),
      };

      ws.send(JSON.stringify(sessionStart));
      await wait(100);

      const { db } = global.testDbConn!;
      const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get('test-session-3') as {
        url_start: string;
        tab_id: number;
        window_id: number;
        user_agent: string;
        viewport_w: number;
        viewport_h: number;
        dpr: number;
        safe_mode: number;
      };

      expect(session.url_start).toBe('https://example.com/page');
      expect(session.tab_id).toBe(42);
      expect(session.window_id).toBe(1);
      expect(session.user_agent).toBe('TestAgent/1.0');
      expect(session.viewport_w).toBe(1920);
      expect(session.viewport_h).toBe(1080);
      expect(session.dpr).toBe(2.0);
      expect(session.safe_mode).toBe(1);

      ws.close();
    });
  });

  describe('Event Ingestion', () => {
    beforeEach(async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>(resolve => ws.on('open', resolve));

      const sessionStart: SessionStartMessage = {
        type: 'session_start',
        sessionId: 'event-test-session',
        url: 'https://example.com',
        timestamp: Date.now(),
        safeMode: false,
      };

      ws.send(JSON.stringify(sessionStart));
      await wait(100);
      ws.close();
    });

    it('should store console events', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>(resolve => ws.on('open', resolve));

      const eventMessage: EventMessage = {
        type: 'event',
        sessionId: 'event-test-session',
        eventType: 'console',
        data: {
          level: 'error',
          message: 'Test error message',
        },
        timestamp: Date.now(),
      };

      ws.send(JSON.stringify(eventMessage));
      await wait(100);

      const { db } = global.testDbConn!;
      const events = db.prepare('SELECT * FROM events WHERE session_id = ?').all('event-test-session') as { type: string; payload_json: string }[];
      
      expect(events.length).toBeGreaterThan(0);
      const consoleEvent = events.find(e => e.type === 'console');
      expect(consoleEvent).toBeDefined();
      
      const payload = JSON.parse(consoleEvent!.payload_json);
      expect(payload.message).toBe('Test error message');

      ws.close();
    });

    it('should store navigation events', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>(resolve => ws.on('open', resolve));

      const eventMessage: EventMessage = {
        type: 'event',
        sessionId: 'event-test-session',
        eventType: 'navigation',
        data: {
          from: 'https://example.com/old',
          to: 'https://example.com/new',
          timestamp: Date.now(),
        },
        timestamp: Date.now(),
      };

      ws.send(JSON.stringify(eventMessage));
      await wait(100);

      const { db } = global.testDbConn!;
      const events = db.prepare('SELECT * FROM events WHERE session_id = ? AND type = ?').all('event-test-session', 'nav') as { payload_json: string }[];
      
      expect(events.length).toBeGreaterThan(0);
      const payload = JSON.parse(events[0].payload_json);
      expect(payload.to).toBe('https://example.com/new');

      ws.close();
    });

    it('should store click events as user journey records', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>(resolve => ws.on('open', resolve));

      const eventMessage: EventMessage = {
        type: 'event',
        sessionId: 'event-test-session',
        eventType: 'click',
        data: {
          selector: '#purchase-button',
          timestamp: Date.now(),
        },
        timestamp: Date.now(),
      };

      ws.send(JSON.stringify(eventMessage));
      await wait(100);

      const { db } = global.testDbConn!;
      const events = db.prepare('SELECT * FROM events WHERE session_id = ? AND type = ?').all('event-test-session', 'ui') as { payload_json: string }[];

      expect(events.length).toBeGreaterThan(0);
      const payload = JSON.parse(events[0].payload_json);
      expect(payload.selector).toBe('#purchase-button');
      expect(typeof payload.timestamp).toBe('number');

      ws.close();
    });

    it('should store error events and create fingerprint', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>(resolve => ws.on('open', resolve));

      const eventMessage: EventMessage = {
        type: 'event',
        sessionId: 'event-test-session',
        eventType: 'error',
        data: {
          message: 'TypeError: undefined is not a function',
          stack: 'at line 10:5',
          fingerprint: 'fp-abc123',
          filename: 'app.js',
          line: 10,
          column: 5,
        },
        timestamp: Date.now(),
      };

      ws.send(JSON.stringify(eventMessage));
      await wait(100);

      const { db } = global.testDbConn!;
      const events = db.prepare('SELECT * FROM events WHERE session_id = ? AND type = ?').all('event-test-session', 'error') as { payload_json: string }[];
      
      expect(events.length).toBeGreaterThan(0);

      const fingerprint = db.prepare('SELECT * FROM error_fingerprints WHERE fingerprint = ?').get('fp-abc123') as {
        sample_message: string;
        count: number;
      };

      expect(fingerprint).toBeDefined();
      expect(fingerprint.sample_message).toBe('TypeError: undefined is not a function');
      expect(fingerprint.count).toBe(1);

      ws.close();
    });

    it('should store network events', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>(resolve => ws.on('open', resolve));

      const eventMessage: EventMessage = {
        type: 'event',
        sessionId: 'event-test-session',
        eventType: 'network',
        data: {
          method: 'GET',
          url: 'https://api.example.com/data',
          status: 200,
          duration: 150,
          initiator: 'fetch',
          responseSize: 1024,
        },
        timestamp: Date.now(),
      };

      ws.send(JSON.stringify(eventMessage));
      await wait(100);

      const { db } = global.testDbConn!;
      const networkEvents = db.prepare('SELECT * FROM network WHERE session_id = ?').all('event-test-session') as {
        method: string;
        url: string;
        status: number;
        duration_ms: number;
      }[];

      expect(networkEvents.length).toBeGreaterThan(0);
      expect(networkEvents[0].method).toBe('GET');
      expect(networkEvents[0].url).toBe('https://api.example.com/data');
      expect(networkEvents[0].status).toBe(200);
      expect(networkEvents[0].duration_ms).toBe(150);

      ws.close();
    });

    it('should reject events for non-existent sessions', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>(resolve => ws.on('open', resolve));

      const eventMessage: EventMessage = {
        type: 'event',
        sessionId: 'non-existent-session',
        eventType: 'console',
        data: { message: 'test' },
        timestamp: Date.now(),
      };

      ws.send(JSON.stringify(eventMessage));

      const response = await waitForMessage(ws) as ErrorMessage;
      expect(response.type).toBe('error');
      expect(response.code).toBe('SESSION_NOT_FOUND');

      ws.close();
    });
  });

  describe('Error Handling', () => {
    it('should return error for invalid JSON', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>(resolve => ws.on('open', resolve));

      ws.send('not valid json');

      const response = await waitForMessage(ws) as ErrorMessage;
      expect(response.type).toBe('error');

      ws.close();
    });

    it('should return error for invalid message type', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>(resolve => ws.on('open', resolve));

      ws.send(JSON.stringify({ type: 'unknown_type' }));

      const response = await waitForMessage(ws) as ErrorMessage;
      expect(response.type).toBe('error');

      ws.close();
    });

    it('should return error for missing required fields', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>(resolve => ws.on('open', resolve));

      ws.send(JSON.stringify({ type: 'session_start' }));

      const response = await waitForMessage(ws) as ErrorMessage;
      expect(response.type).toBe('error');

      ws.close();
    });
  });

  describe('Message Validation', () => {
    it('should handle valid event types', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>(resolve => ws.on('open', resolve));

      const sessionStart: SessionStartMessage = {
        type: 'session_start',
        sessionId: 'validation-test',
        url: 'https://example.com',
        timestamp: Date.now(),
        safeMode: false,
      };

      ws.send(JSON.stringify(sessionStart));
      await wait(100);

      const validTypes = ['navigation', 'console', 'error', 'network', 'click', 'custom'];

      for (const eventType of validTypes) {
        const eventMessage: EventMessage = {
          type: 'event',
          sessionId: 'validation-test',
          eventType: eventType as EventMessage['eventType'],
          data: { test: true },
          timestamp: Date.now(),
        };

        ws.send(JSON.stringify(eventMessage));
      }

      await wait(200);

      const { db } = global.testDbConn!;
      const events = db.prepare('SELECT COUNT(*) as count FROM events WHERE session_id = ?').get('validation-test') as { count: number };
      expect(events.count).toBe(validTypes.length);

      ws.close();
    });
  });

  describe('Capture Commands', () => {
    it('sends capture command to extension and resolves capture result', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve) => ws.on('open', resolve));

      const sessionStart: SessionStartMessage = {
        type: 'session_start',
        sessionId: 'capture-test-session',
        url: 'https://example.com',
        timestamp: Date.now(),
        safeMode: false,
      };

      ws.send(JSON.stringify(sessionStart));
      await wait(100);

      const commandPromise = wsManager.sendCaptureCommand(
        'capture-test-session',
        'CAPTURE_DOM_SUBTREE',
        { selector: '#app', maxDepth: 2, maxBytes: 4000 },
        2000,
      );

      const commandMessage = await waitForMessage(ws) as CaptureCommandMessage;
      expect(commandMessage.type).toBe('capture_command');
      expect(commandMessage.command).toBe('CAPTURE_DOM_SUBTREE');

      ws.send(
        JSON.stringify({
          type: 'capture_result',
          commandId: commandMessage.commandId,
          sessionId: 'capture-test-session',
          ok: true,
          payload: {
            mode: 'outline',
            selector: '#app',
            outline: '{"tag":"div"}',
          },
          truncated: false,
          timestamp: Date.now(),
        })
      );

      const result = await commandPromise;
      expect(result.ok).toBe(true);
      expect(result.payload?.mode).toBe('outline');

      ws.close();
    });
  });
});
