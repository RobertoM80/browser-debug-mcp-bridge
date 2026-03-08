import { describe, it, expect, vi } from 'vitest';
import { SessionManager } from './session-manager';

type Listener = (event: unknown) => void;

class MockWebSocket {
  readyState = 0;
  sentMessages: string[] = [];
  private listeners: Record<string, Listener[]> = {};

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners[type]) {
      this.listeners[type] = [];
    }
    this.listeners[type].push(listener);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  receive(data: unknown): void {
    this.emit('message', { data });
  }

  private emit(type: string, event: unknown): void {
    const listeners = this.listeners[type] ?? [];
    for (const listener of listeners) {
      listener(event);
    }
  }
}

describe('SessionManager', () => {
  it('starts a session and flushes session_start when socket opens', () => {
    const ws = new MockWebSocket();
    const manager = new SessionManager({
      createSessionId: () => 'session-1',
      createWebSocket: () => ws,
      now: () => 1700000000000,
    });

    const startState = manager.startSession({
      url: 'https://example.com',
      baseOrigin: 'https://example.com',
      allowedTabIds: [11],
    });

    expect(startState.isActive).toBe(true);
    expect(startState.sessionId).toBe('session-1');
    expect(startState.baseOrigin).toBe('https://example.com');
    expect(startState.allowedTabIds).toEqual([11]);
    expect(startState.connectionStatus).toBe('connecting');
    expect(startState.queuedEvents).toBe(1);

    ws.open();

    const finalState = manager.getState();
    expect(finalState.connectionStatus).toBe('connected');
    expect(finalState.queuedEvents).toBe(0);

    const sent = JSON.parse(ws.sentMessages[0]) as { type: string; sessionId: string; url: string; origin?: string };
    expect(sent.type).toBe('session_start');
    expect(sent.sessionId).toBe('session-1');
    expect(sent.url).toBe('https://example.com');
    expect(sent.origin).toBe('https://example.com');
  });

  it('applies backpressure by dropping oldest queued events', () => {
    const ws = new MockWebSocket();
    const manager = new SessionManager({
      maxBufferSize: 2,
      createSessionId: () => 'session-2',
      createWebSocket: () => ws,
    });

    manager.startSession({ url: 'https://example.com' });
    manager.queueEvent('console', { level: 'error' });
    manager.queueEvent('console', { level: 'warn' });
    manager.queueEvent('console', { level: 'info' });

    const state = manager.getState();
    expect(state.queuedEvents).toBe(2);
    expect(state.droppedEvents).toBe(2);
  });

  it('sends queued events as batches when connection opens', () => {
    const ws = new MockWebSocket();
    const manager = new SessionManager({
      createSessionId: () => 'session-batch',
      createWebSocket: () => ws,
      maxBatchSize: 10,
    });

    manager.startSession({ url: 'https://example.com' });
    manager.queueEvent('console', { level: 'warn' });
    manager.queueEvent('navigation', { to: 'https://example.com/next' });
    manager.queueEvent('click', { selector: '#buy' });

    ws.open();

    expect(ws.sentMessages).toHaveLength(2);
    const batch = JSON.parse(ws.sentMessages[1]) as {
      type: string;
      sessionId: string;
      events: Array<{ eventType: string }>;
    };

    expect(batch.type).toBe('event_batch');
    expect(batch.sessionId).toBe('session-batch');
    expect(batch.events).toHaveLength(3);
    expect(batch.events.map((event) => event.eventType)).toEqual(['console', 'navigation', 'click']);
  });

  it('sends session_end when stopping an active session', () => {
    const ws = new MockWebSocket();
    const manager = new SessionManager({
      createSessionId: () => 'session-3',
      createWebSocket: () => ws,
      now: () => 1700000000000,
    });

    manager.startSession({ url: 'https://example.com' });
    ws.open();
    ws.sentMessages.length = 0;

    const stopped = manager.stopSession();

    expect(stopped.isActive).toBe(false);
    expect(stopped.sessionId).toBeNull();
    expect(ws.sentMessages).toHaveLength(1);
    const sent = JSON.parse(ws.sentMessages[0]) as { type: string };
    expect(sent.type).toBe('session_end');
  });

  it('pauses and resumes an active session with the same session id', () => {
    const ws = new MockWebSocket();
    const manager = new SessionManager({
      createSessionId: () => 'session-pause',
      createWebSocket: () => ws,
      now: () => 1700000000000,
    });

    manager.startSession({ url: 'https://example.com' });
    ws.open();
    ws.sentMessages.length = 0;

    const paused = manager.pauseSession();
    expect(paused.isActive).toBe(true);
    expect(paused.isPaused).toBe(true);
    expect(paused.sessionId).toBe('session-pause');
    expect(JSON.parse(ws.sentMessages[0])).toMatchObject({ type: 'session_pause', sessionId: 'session-pause' });

    const resumed = manager.resumeSession({
      url: 'https://example.com/resume',
    });
    expect(resumed.isActive).toBe(true);
    expect(resumed.isPaused).toBe(false);
    expect(resumed.sessionId).toBe('session-pause');
    expect(JSON.parse(ws.sentMessages[1])).toMatchObject({ type: 'session_resume', sessionId: 'session-pause' });
  });

  it('rejects queued events while paused and accepts again after resume', () => {
    const ws = new MockWebSocket();
    const manager = new SessionManager({
      createSessionId: () => 'session-paused-events',
      createWebSocket: () => ws,
      now: () => 1700000000000,
    });

    manager.startSession({ url: 'https://example.com' });
    ws.open();
    ws.sentMessages.length = 0;

    manager.pauseSession();
    const acceptedWhilePaused = manager.queueEvent('console', { level: 'warn' });
    expect(acceptedWhilePaused).toBe(false);

    manager.resumeSession({ url: 'https://example.com' });
    const acceptedAfterResume = manager.queueEvent('console', { level: 'info' });
    expect(acceptedAfterResume).toBe(true);

    const lastSent = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]) as { type: string; eventType?: string };
    expect(lastSent.type).toBe('event');
    expect(lastSent.eventType).toBe('console');
  });

  it('rejects queued events when no active session exists', () => {
    const manager = new SessionManager({
      createWebSocket: () => new MockWebSocket(),
    });

    const accepted = manager.queueEvent('console', { level: 'error' });
    expect(accepted).toBe(false);
  });

  it('forwards tab and origin metadata in event payloads', () => {
    const ws = new MockWebSocket();
    const manager = new SessionManager({
      createSessionId: () => 'session-meta',
      createWebSocket: () => ws,
      now: () => 1700000000000,
    });

    manager.startSession({ url: 'https://example.com' });
    ws.open();
    ws.sentMessages.length = 0;

    manager.queueEvent('navigation', { to: 'https://example.com/next' }, {
      tabId: 7,
      origin: 'https://example.com',
    });

    expect(ws.sentMessages).toHaveLength(1);
    const sent = JSON.parse(ws.sentMessages[0]) as {
      type: string;
      tabId?: number;
      origin?: string;
      eventType: string;
    };
    expect(sent.type).toBe('event');
    expect(sent.eventType).toBe('navigation');
    expect(sent.tabId).toBe(7);
    expect(sent.origin).toBe('https://example.com');
  });

  it('redacts sensitive data in outbound events', () => {
    const ws = new MockWebSocket();
    const manager = new SessionManager({
      createSessionId: () => 'session-4',
      createWebSocket: () => ws,
      now: () => 1700000000000,
    });

    manager.startSession({ url: 'https://example.com' });
    ws.open();
    ws.sentMessages.length = 0;

    manager.queueEvent('console', {
      auth: 'Authorization: Bearer token123',
      jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      apiKey: 'api_key: sk-abcdef',
      token: 'token: top-secret',
      password: 'password: super-secret',
    });

    const sent = JSON.parse(ws.sentMessages[0]) as {
      data: {
        auth: string;
        jwt: string;
        apiKey: string;
        token: string;
        password: string;
      };
    };

    expect(sent.data.auth).toBe('Authorization: Bearer [REDACTED]');
    expect(sent.data.jwt).toBe('[JWT_TOKEN]');
    expect(sent.data.apiKey).toBe('api_key: [API_KEY]');
    expect(sent.data.token).toBe('token: [TOKEN]');
    expect(sent.data.password).toBe('password: [PASSWORD]');
  });

  it('handles capture commands received from server', async () => {
    const ws = new MockWebSocket();
    const manager = new SessionManager({
      createSessionId: () => 'session-5',
      createWebSocket: () => ws,
      now: () => 1700000000000,
      handleCaptureCommand: async (command, payload, context) => ({
        payload: {
          command,
          selector: payload.selector,
          sessionId: context.sessionId,
          ok: true,
        },
        truncated: false,
      }),
    });

    manager.startSession({ url: 'https://example.com' });
    ws.open();
    ws.sentMessages.length = 0;

    ws.receive(
      JSON.stringify({
        type: 'capture_command',
        commandId: 'cmd-1',
        sessionId: 'session-5',
        command: 'CAPTURE_UI_SNAPSHOT',
        payload: { selector: '#app' },
      })
    );

    await Promise.resolve();

    expect(ws.sentMessages).toHaveLength(1);
    const response = JSON.parse(ws.sentMessages[0]) as {
      type: string;
      commandId: string;
      ok: boolean;
      payload: { selector: string; command: string; sessionId: string };
    };
    expect(response.type).toBe('capture_result');
    expect(response.commandId).toBe('cmd-1');
    expect(response.ok).toBe(true);
    expect(response.payload.selector).toBe('#app');
    expect(response.payload.command).toBe('CAPTURE_UI_SNAPSHOT');
    expect(response.payload.sessionId).toBe('session-5');
  });

  it('returns capture_result error when capture command arrives while paused', async () => {
    const ws = new MockWebSocket();
    const manager = new SessionManager({
      createSessionId: () => 'session-paused-capture',
      createWebSocket: () => ws,
      now: () => 1700000000000,
      handleCaptureCommand: async () => ({
        payload: { ok: true },
      }),
    });

    manager.startSession({ url: 'https://example.com' });
    ws.open();
    manager.pauseSession();
    ws.sentMessages.length = 0;

    ws.receive(
      JSON.stringify({
        type: 'capture_command',
        commandId: 'cmd-paused',
        sessionId: 'session-paused-capture',
        command: 'CAPTURE_DOM_DOCUMENT',
        payload: {},
      }),
    );

    await Promise.resolve();

    expect(ws.sentMessages).toHaveLength(1);
    expect(JSON.parse(ws.sentMessages[0])).toMatchObject({
      type: 'capture_result',
      commandId: 'cmd-paused',
      ok: false,
      error: 'Session is paused',
    });
  });

  it('accepts live console log capture commands from server', async () => {
    const ws = new MockWebSocket();
    const manager = new SessionManager({
      createSessionId: () => 'session-live-logs',
      createWebSocket: () => ws,
      now: () => 1700000000000,
      handleCaptureCommand: async (command) => ({
        payload: {
          command,
          logs: [{ message: '[auth] logged in success', level: 'info' }],
        },
        truncated: false,
      }),
    });

    manager.startSession({ url: 'https://example.com' });
    ws.open();
    ws.sentMessages.length = 0;

    ws.receive(
      JSON.stringify({
        type: 'capture_command',
        commandId: 'cmd-live-1',
        sessionId: 'session-live-logs',
        command: 'CAPTURE_GET_LIVE_CONSOLE_LOGS',
        payload: { contains: '[auth]' },
      }),
    );

    await Promise.resolve();

    expect(ws.sentMessages).toHaveLength(1);
    const response = JSON.parse(ws.sentMessages[0]) as {
      type: string;
      commandId: string;
      ok: boolean;
      payload: { command: string; logs: Array<{ message: string }> };
    };
    expect(response.type).toBe('capture_result');
    expect(response.commandId).toBe('cmd-live-1');
    expect(response.ok).toBe(true);
    expect(response.payload.command).toBe('CAPTURE_GET_LIVE_CONSOLE_LOGS');
    expect(response.payload.logs[0]?.message).toContain('[auth]');
  });

  it('accepts live UI action commands from server', async () => {
    const ws = new MockWebSocket();
    const manager = new SessionManager({
      createSessionId: () => 'session-live-action',
      createWebSocket: () => ws,
      now: () => 1700000000000,
      handleCaptureCommand: async (command, payload) => ({
        payload: {
          command,
          action: payload.action,
          traceId: payload.traceId,
          status: 'rejected',
        },
      }),
    });

    manager.startSession({ url: 'https://example.com' });
    ws.open();
    ws.sentMessages.length = 0;

    ws.receive(
      JSON.stringify({
        type: 'capture_command',
        commandId: 'cmd-action-1',
        sessionId: 'session-live-action',
        command: 'EXECUTE_UI_ACTION',
        payload: {
          action: 'click',
          traceId: 'trace-action-1',
          target: { selector: '#buy-now' },
        },
      }),
    );

    await Promise.resolve();

    expect(ws.sentMessages).toHaveLength(1);
    const response = JSON.parse(ws.sentMessages[0]) as {
      type: string;
      commandId: string;
      ok: boolean;
      payload: { command: string; action: string; traceId: string; status: string };
    };
    expect(response.type).toBe('capture_result');
    expect(response.commandId).toBe('cmd-action-1');
    expect(response.ok).toBe(true);
    expect(response.payload.command).toBe('EXECUTE_UI_ACTION');
    expect(response.payload.action).toBe('click');
    expect(response.payload.traceId).toBe('trace-action-1');
  });

  it('uses readable default session ids with date hints', () => {
    const manager = new SessionManager({
      createWebSocket: () => new MockWebSocket(),
    });

    const startState = manager.startSession({ url: 'https://example.com' });
    const sessionId = startState.sessionId ?? '';

    expect(sessionId).toMatch(/^sess-[a-z]+-[a-z]+-\d{8}-[a-z0-9]{6}$/);
    expect(sessionId).not.toMatch(/\d{13,}/);
  });

  it('sends heartbeat ping while an active session is connected', () => {
    vi.useFakeTimers();
    const ws = new MockWebSocket();
    const manager = new SessionManager({
      createSessionId: () => 'session-heartbeat',
      createWebSocket: () => ws,
      now: () => 1700000000000,
    });

    manager.startSession({ url: 'https://example.com' });
    ws.open();
    ws.sentMessages.length = 0;

    vi.advanceTimersByTime(15000);

    expect(ws.sentMessages).toHaveLength(1);
    expect(JSON.parse(ws.sentMessages[0])).toMatchObject({ type: 'ping' });
    vi.useRealTimers();
  });

  it('auto-reconnects when a connected session drops unexpectedly', () => {
    vi.useFakeTimers();
    const sockets: MockWebSocket[] = [];
    const manager = new SessionManager({
      createSessionId: () => 'session-reconnect',
      createWebSocket: () => {
        const ws = new MockWebSocket();
        sockets.push(ws);
        return ws;
      },
      now: () => Date.now(),
    });

    manager.startSession({ url: 'https://example.com' });
    const first = sockets[0];
    expect(first).toBeDefined();
    first?.open();
    first?.close();

    expect(manager.getState().connectionStatus).toBe('reconnecting');
    vi.advanceTimersByTime(1000);

    expect(sockets).toHaveLength(2);
    expect(manager.getState().connectionStatus).toBe('connecting');
    vi.useRealTimers();
  });

  it('re-announces the active session when websocket reconnects', () => {
    vi.useFakeTimers();
    const sockets: MockWebSocket[] = [];
    const manager = new SessionManager({
      createSessionId: () => 'session-rebind',
      createWebSocket: () => {
        const ws = new MockWebSocket();
        sockets.push(ws);
        return ws;
      },
      now: () => Date.now(),
    });

    manager.startSession({
      url: 'https://example.com/planner',
      tabId: 21,
      windowId: 7,
      baseOrigin: 'https://example.com',
      allowedTabIds: [21],
      viewport: { width: 1280, height: 720 },
      dpr: 2,
      safeMode: true,
    });

    const first = sockets[0];
    expect(first).toBeDefined();
    first?.open();
    if (first) {
      first.sentMessages.length = 0;
      first.close();
    }

    vi.advanceTimersByTime(1000);
    const second = sockets[1];
    expect(second).toBeDefined();
    second?.open();

    const sent = second?.sentMessages.map((entry) => JSON.parse(entry) as { type: string; sessionId?: string; url?: string; tabId?: number }) ?? [];
    expect(sent[0]).toMatchObject({
      type: 'session_resume',
      sessionId: 'session-rebind',
      url: 'https://example.com/planner',
      tabId: 21,
    });
    vi.useRealTimers();
  });

  it('uses an updated websocket url for the next reconnect attempt', () => {
    vi.useFakeTimers();
    const socketUrls: string[] = [];
    const sockets: MockWebSocket[] = [];
    const manager = new SessionManager({
      createSessionId: () => 'session-ws-url',
      createWebSocket: (url) => {
        socketUrls.push(url);
        const ws = new MockWebSocket();
        sockets.push(ws);
        return ws;
      },
      now: () => Date.now(),
    });

    manager.startSession({ url: 'https://example.com' });
    expect(socketUrls[0]).toBe('ws://127.0.0.1:8065/ws');

    sockets[0]?.open();
    manager.setWsUrl('ws://127.0.0.1:49213/ws');
    sockets[0]?.close();

    vi.advanceTimersByTime(1000);

    expect(socketUrls[1]).toBe('ws://127.0.0.1:49213/ws');
    vi.useRealTimers();
  });
});
