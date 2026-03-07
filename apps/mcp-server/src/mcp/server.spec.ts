import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initializeDatabase } from '../db/migrations';
import {
  createMCPServer,
  createToolRegistry,
  createV1ToolHandlers,
  createV2ToolHandlers,
  routeToolCall,
  type ToolHandler,
} from './server.js';

describe('mcp/server foundation', () => {
  it('creates MCP runtime with stdio transport', () => {
    const runtime = createMCPServer();

    expect(runtime.server).toBeDefined();
    expect(runtime.transport).toBeDefined();
    expect(runtime.tools.length).toBeGreaterThan(0);
  });

  it('registers known tools with input schemas', () => {
    const tools = createToolRegistry();
    const listSessions = tools.find((tool) => tool.name === 'list_sessions');

    expect(listSessions).toBeDefined();
    expect(listSessions?.inputSchema).toMatchObject({ type: 'object' });
  });

  it('routes a tool call to custom handler', async () => {
    const handler: ToolHandler = async (input) => ({
      sessionId: typeof input.sessionId === 'string' ? input.sessionId : undefined,
      limitsApplied: {
        maxResults: 25,
        truncated: false,
      },
      redactionSummary: {
        totalFields: 2,
        redactedFields: 1,
        rulesApplied: ['token'],
      },
      ok: true,
    });
    const tools = createToolRegistry({ list_sessions: handler });

    const response = await routeToolCall(tools, 'list_sessions', { sessionId: 's-1' });

    expect(response.ok).toBe(true);
    expect(response.sessionId).toBe('s-1');
    expect(response.limitsApplied.maxResults).toBe(25);
    expect(response.redactionSummary.redactedFields).toBe(1);
  });

  it('returns default response contract for unimplemented tools', async () => {
    const tools = createToolRegistry();
    const response = await routeToolCall(tools, 'get_dom_subtree', { sessionId: 's-2', selector: 'body' });

    expect(response.sessionId).toBe('s-2');
    expect(response.limitsApplied).toEqual({ maxResults: 0, truncated: false });
    expect(response.redactionSummary).toEqual({
      totalFields: 0,
      redactedFields: 0,
      rulesApplied: [],
    });
    expect(response.status).toBe('not_implemented');
  });

  it('throws on unknown tools', async () => {
    const tools = createToolRegistry();

    await expect(routeToolCall(tools, 'does_not_exist', {})).rejects.toThrow('Unknown tool');
  });
});

describe('mcp/server V1 query tools', () => {
  function createTestDb(): Database.Database {
    const db = new Database(':memory:');
    initializeDatabase(db);
    return db;
  }

  it('lists sessions with sinceMinutes filtering', async () => {
    const db = createTestDb();
    const now = Date.now();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, safe_mode, url_start, url_last)
        VALUES (?, ?, ?, ?, ?)
      `
    ).run('session-old', now - 30 * 60_000, 0, 'https://old.example', 'https://old.example');
    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, safe_mode, url_start, url_last)
        VALUES (?, ?, ?, ?, ?)
      `
    ).run('session-new', now - 5 * 60_000, 1, 'https://new.example', 'https://new.example');

    const tools = createToolRegistry(createV1ToolHandlers(() => db));
    const response = await routeToolCall(tools, 'list_sessions', { sinceMinutes: 10 });

    expect(response.limitsApplied.maxResults).toBe(25);
    expect(response.limitsApplied.truncated).toBe(false);
    expect(response.sessions).toHaveLength(1);
    expect((response.sessions as Array<{ sessionId: string }>)[0]?.sessionId).toBe('session-new');

    db.close();
  });

  it('includes live connection metadata in list_sessions when available', async () => {
    const db = createTestDb();
    const now = Date.now();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, safe_mode, url_start, url_last)
        VALUES (?, ?, ?, ?, ?)
      `
    ).run('session-live', now - 2 * 60_000, 1, 'https://live.example', 'https://live.example');

    const tools = createToolRegistry(
      createV1ToolHandlers(
        () => db,
        (sessionId) => sessionId === "session-live"
          ? {
              connected: true,
              connectedAt: now - 60_000,
              lastHeartbeatAt: now - 1_000,
            }
          : undefined,
      ),
    );

    const response = await routeToolCall(tools, 'list_sessions', { sinceMinutes: 10 });

    const session = (response.sessions as Array<{
      sessionId: string;
      liveConnection?: {
        connected: boolean;
        connectedAt?: number;
        lastHeartbeatAt?: number;
      };
    }>)[0];
    expect(session?.sessionId).toBe('session-live');
    expect(session?.liveConnection?.connected).toBe(true);
    expect(session?.liveConnection?.connectedAt).toBe(now - 60_000);
    expect(session?.liveConnection?.lastHeartbeatAt).toBe(now - 1_000);

    db.close();
  });

  it('includes paused metadata and status in list_sessions', async () => {
    const db = createTestDb();
    const now = Date.now();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, paused_at, safe_mode, url_start, url_last)
        VALUES (?, ?, ?, ?, ?, ?)
      `
    ).run('session-paused', now - 2 * 60_000, now - 30_000, 1, 'https://paused.example', 'https://paused.example');

    const tools = createToolRegistry(createV1ToolHandlers(() => db));
    const response = await routeToolCall(tools, 'list_sessions', { sinceMinutes: 10 });
    const session = (response.sessions as Array<{ sessionId: string; pausedAt?: number; status?: string }>)
      .find((entry) => entry.sessionId === 'session-paused');

    expect(session).toBeDefined();
    expect(typeof session?.pausedAt).toBe('number');
    expect(session?.status).toBe('paused');

    db.close();
  });
  it('returns session summary counts and time range', async () => {
    const db = createTestDb();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, ended_at, safe_mode, url_start, url_last)
        VALUES ('session-1', 1000, 5000, 0, 'https://start.example', 'https://fallback.example')
      `
    ).run();

    db.prepare(
      `
        INSERT INTO events (event_id, session_id, ts, type, payload_json)
        VALUES
          ('evt-nav', 'session-1', 1100, 'nav', '{"url":"https://latest-nav.example"}'),
          ('evt-warn', 'session-1', 1200, 'console', '{"level":"warn","message":"watch out"}'),
          ('evt-error', 'session-1', 1300, 'error', '{"message":"boom"}')
      `
    ).run();

    db.prepare(
      `
        INSERT INTO network (request_id, session_id, ts_start, duration_ms, method, url, status, initiator)
        VALUES ('req-1', 'session-1', 1250, 20, 'GET', 'https://api.example/fail', 500, 'fetch')
      `
    ).run();

    const tools = createToolRegistry(createV1ToolHandlers(() => db));
    const response = await routeToolCall(tools, 'get_session_summary', { sessionId: 'session-1' });

    expect(response.sessionId).toBe('session-1');
    expect(response.counts).toEqual({ errors: 1, warnings: 1, networkFails: 1 });
    expect(response.lastUrl).toBe('https://latest-nav.example');
    expect(response.timeRange).toEqual({ start: 1100, end: 1300 });

    db.close();
  });

  it('returns recent events with type filtering and limits', async () => {
    const db = createTestDb();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('session-1', 1000, 0)
      `
    ).run();
    db.prepare(
      `
        INSERT INTO events (event_id, session_id, ts, type, payload_json)
        VALUES
          ('evt-nav', 'session-1', 1001, 'nav', '{"url":"https://a.example"}'),
          ('evt-console', 'session-1', 1002, 'console', '{"level":"info"}'),
          ('evt-error', 'session-1', 1003, 'error', '{"message":"boom"}')
      `
    ).run();

    const tools = createToolRegistry(createV1ToolHandlers(() => db));
    const response = await routeToolCall(tools, 'get_recent_events', {
      sessionId: 'session-1',
      types: ['navigation', 'error'],
      limit: 1,
    });

    expect(response.limitsApplied).toEqual({ maxResults: 1, truncated: true });
    expect(response.events).toHaveLength(1);
    expect((response.events as Array<{ eventId: string }>)[0]?.eventId).toBe('evt-error');

    db.close();
  });

  it('returns recent events filtered by url origin across sessions when sessionId is omitted', async () => {
    const db = createTestDb();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('session-a', 1000, 0), ('session-b', 1001, 0)
      `
    ).run();
    db.prepare(
      `
        INSERT INTO events (event_id, session_id, ts, type, payload_json)
        VALUES
          ('evt-local', 'session-a', 2001, 'nav', '{"url":"http://localhost:3000/app"}'),
          ('evt-remote', 'session-b', 2002, 'nav', '{"url":"https://example.com/home"}')
      `
    ).run();

    const tools = createToolRegistry(createV1ToolHandlers(() => db));
    const response = await routeToolCall(tools, 'get_recent_events', {
      url: 'http://localhost:3000',
      limit: 10,
    });

    expect(response.sessionId).toBeUndefined();
    expect(response.events).toHaveLength(1);
    expect((response.events as Array<{ eventId: string }>)[0]?.eventId).toBe('evt-local');

    db.close();
  });

  it('applies sessionId and url intersection for recent events', async () => {
    const db = createTestDb();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('session-1', 1000, 0)
      `
    ).run();
    db.prepare(
      `
        INSERT INTO events (event_id, session_id, ts, type, payload_json)
        VALUES
          ('evt-local', 'session-1', 2001, 'nav', '{"url":"http://localhost:3000/app"}'),
          ('evt-remote', 'session-1', 2002, 'nav', '{"url":"https://example.com/home"}')
      `
    ).run();

    const tools = createToolRegistry(createV1ToolHandlers(() => db));
    const response = await routeToolCall(tools, 'get_recent_events', {
      sessionId: 'session-1',
      url: 'http://localhost:3000',
      limit: 10,
    });

    expect(response.sessionId).toBe('session-1');
    expect(response.events).toHaveLength(1);
    expect((response.events as Array<{ eventId: string }>)[0]?.eventId).toBe('evt-local');

    db.close();
  });

  it('rejects invalid url filters for recent events', async () => {
    const db = createTestDb();
    const tools = createToolRegistry(createV1ToolHandlers(() => db));

    await expect(routeToolCall(tools, 'get_recent_events', {
      url: 'localhost:3000',
    })).rejects.toThrow('url must be a valid absolute http(s) URL');

    db.close();
  });

  it('returns only navigation history entries', async () => {
    const db = createTestDb();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('session-1', 1000, 0)
      `
    ).run();
    db.prepare(
      `
        INSERT INTO events (event_id, session_id, ts, type, payload_json)
        VALUES
          ('evt-nav-1', 'session-1', 1001, 'nav', '{"url":"https://first.example"}'),
          ('evt-console', 'session-1', 1002, 'console', '{"level":"warn"}'),
          ('evt-nav-2', 'session-1', 1003, 'nav', '{"url":"https://second.example"}')
      `
    ).run();

    const tools = createToolRegistry(createV1ToolHandlers(() => db));
    const response = await routeToolCall(tools, 'get_navigation_history', { sessionId: 'session-1', limit: 10 });

    expect(response.events).toHaveLength(2);
    expect((response.events as Array<{ eventId: string }>).map((event) => event.eventId)).toEqual([
      'evt-nav-2',
      'evt-nav-1',
    ]);

    db.close();
  });

  it('returns console events filtered by level', async () => {
    const db = createTestDb();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('session-1', 1000, 0)
      `
    ).run();
    db.prepare(
      `
        INSERT INTO events (event_id, session_id, ts, type, payload_json)
        VALUES
          ('evt-info', 'session-1', 1001, 'console', '{"level":"info","message":"ok"}'),
          ('evt-warn', 'session-1', 1002, 'console', '{"level":"warn","message":"warn"}'),
          ('evt-error', 'session-1', 1003, 'console', '{"level":"error","message":"err"}')
      `
    ).run();

    const tools = createToolRegistry(createV1ToolHandlers(() => db));
    const response = await routeToolCall(tools, 'get_console_events', {
      sessionId: 'session-1',
      level: 'warn',
    });

    expect(response.events).toHaveLength(1);
    expect((response.events as Array<{ eventId: string }>)[0]?.eventId).toBe('evt-warn');

    db.close();
  });

  it('returns compact events without payload by default', async () => {
    const db = createTestDb();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('session-compact', 1000, 0)
      `
    ).run();
    db.prepare(
      `
        INSERT INTO events (event_id, session_id, ts, type, payload_json)
        VALUES ('evt-compact', 'session-compact', 1001, 'console', '{"level":"warn","message":"watch out"}')
      `
    ).run();

    const tools = createToolRegistry(createV1ToolHandlers(() => db));
    const response = await routeToolCall(tools, 'get_recent_events', {
      sessionId: 'session-compact',
      responseProfile: 'compact',
    });

    const event = (response.events as Array<Record<string, unknown>>)[0];
    expect(response.responseProfile).toBe('compact');
    expect(event?.payload).toBeUndefined();
    expect(typeof event?.summary).toBe('string');
    expect(event?.message).toBe('watch out');

    db.close();
  });

  it('applies maxResponseBytes budget for event queries', async () => {
    const db = createTestDb();
    const longMessage = 'x'.repeat(5000);

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('session-budget', 1000, 0)
      `
    ).run();
    db.prepare(
      `
        INSERT INTO events (event_id, session_id, ts, type, payload_json)
        VALUES
          ('evt-budget-1', 'session-budget', 1002, 'console', ?),
          ('evt-budget-2', 'session-budget', 1001, 'console', ?)
      `
    ).run(
      JSON.stringify({ level: 'info', message: longMessage }),
      JSON.stringify({ level: 'info', message: longMessage }),
    );

    const tools = createToolRegistry(createV1ToolHandlers(() => db));
    const response = await routeToolCall(tools, 'get_recent_events', {
      sessionId: 'session-budget',
      limit: 2,
      maxResponseBytes: 1024,
    });

    expect((response.events as Array<Record<string, unknown>>).length).toBe(1);
    expect(response.limitsApplied.truncated).toBe(true);
    expect(response.pagination).toMatchObject({
      hasMore: true,
      nextOffset: 1,
      maxResponseBytes: 1024,
    });

    db.close();
  });

  it('returns console summary with level counters and top repeated messages', async () => {
    const db = createTestDb();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('session-summary-console', 1000, 0)
      `
    ).run();
    db.prepare(
      `
        INSERT INTO events (event_id, session_id, ts, type, payload_json)
        VALUES
          ('evt-c1', 'session-summary-console', 1001, 'console', '{"level":"warn","message":"retry"}'),
          ('evt-c2', 'session-summary-console', 1002, 'console', '{"level":"warn","message":"retry"}'),
          ('evt-c3', 'session-summary-console', 1003, 'console', '{"level":"error","message":"boom"}')
      `
    ).run();

    const tools = createToolRegistry(createV1ToolHandlers(() => db));
    const response = await routeToolCall(tools, 'get_console_summary', {
      sessionId: 'session-summary-console',
      limit: 5,
    });

    expect((response.counts as { total: number }).total).toBe(3);
    expect((response.counts as { byLevel: { warn: number; error: number } }).byLevel.warn).toBe(2);
    expect((response.counts as { byLevel: { warn: number; error: number } }).byLevel.error).toBe(1);
    expect((response.topMessages as Array<{ message: string; count: number }>)[0]).toMatchObject({
      message: 'retry',
      count: 2,
    });

    db.close();
  });

  it('returns event summary grouped by event type', async () => {
    const db = createTestDb();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('session-summary-events', 1000, 0)
      `
    ).run();
    db.prepare(
      `
        INSERT INTO events (event_id, session_id, ts, type, payload_json)
        VALUES
          ('evt-e1', 'session-summary-events', 1001, 'nav', '{"url":"https://example.com"}'),
          ('evt-e2', 'session-summary-events', 1002, 'ui', '{"eventType":"click"}'),
          ('evt-e3', 'session-summary-events', 1003, 'ui', '{"eventType":"input"}')
      `
    ).run();

    const tools = createToolRegistry(createV1ToolHandlers(() => db));
    const response = await routeToolCall(tools, 'get_event_summary', {
      sessionId: 'session-summary-events',
      limit: 5,
    });

    expect((response.counts as { total: number }).total).toBe(3);
    expect((response.byType as Array<{ type: string; count: number }>)[0]).toMatchObject({
      type: 'ui',
      count: 2,
    });

    db.close();
  });

  it('returns error fingerprints with pagination', async () => {
    const db = createTestDb();
    const now = Date.now();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('session-1', ?, 0)
      `
    ).run(now - 1_000);

    db.prepare(
      `
        INSERT INTO error_fingerprints (
          fingerprint, session_id, count, sample_message, sample_stack, first_seen_at, last_seen_at
        ) VALUES
          ('fp-1', 'session-1', 4, 'boom-1', 'stack-1', ?, ?),
          ('fp-2', 'session-1', 2, 'boom-2', 'stack-2', ?, ?)
      `
    ).run(now - 5_000, now - 5_000, now - 4_000, now - 4_000);

    const tools = createToolRegistry(createV1ToolHandlers(() => db));
    const response = await routeToolCall(tools, 'get_error_fingerprints', {
      sessionId: 'session-1',
      limit: 1,
      offset: 1,
    });

    expect(response.sessionId).toBe('session-1');
    expect(response.limitsApplied).toEqual({ maxResults: 1, truncated: false });
    expect(response.pagination).toMatchObject({
      offset: 1,
      returned: 1,
      hasMore: false,
      nextOffset: null,
    });
    expect((response.fingerprints as Array<{ fingerprint: string }>)[0]?.fingerprint).toBe('fp-2');

    db.close();
  });

  it('returns grouped network failures by errorType', async () => {
    const db = createTestDb();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('session-1', 1000, 0)
      `
    ).run();

    db.prepare(
      `
        INSERT INTO network (request_id, session_id, ts_start, duration_ms, method, url, status, initiator, error_class)
        VALUES
          ('req-timeout', 'session-1', 1010, 1200, 'GET', 'https://a.example/api', NULL, 'fetch', 'timeout'),
          ('req-http-a', 'session-1', 1020, 200, 'GET', 'https://a.example/fail', 500, 'fetch', NULL),
          ('req-http-b', 'session-1', 1030, 210, 'POST', 'https://b.example/fail', 502, 'xhr', NULL)
      `
    ).run();

    const tools = createToolRegistry(createV1ToolHandlers(() => db));
    const response = await routeToolCall(tools, 'get_network_failures', {
      sessionId: 'session-1',
      groupBy: 'errorType',
    });

    expect(response.groupBy).toBe('errorType');
    expect(response.limitsApplied.truncated).toBe(false);
    expect((response.groups as Array<{ key: string; count: number }>)[0]).toEqual({
      key: 'http_error',
      count: 2,
      firstSeenAt: 1020,
      lastSeenAt: 1030,
    });

    db.close();
  });

  it('filters network failures by url origin without sessionId', async () => {
    const db = createTestDb();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('session-1', 1000, 0), ('session-2', 1001, 0)
      `
    ).run();

    db.prepare(
      `
        INSERT INTO network (request_id, session_id, ts_start, duration_ms, method, url, status, initiator, error_class)
        VALUES
          ('req-local', 'session-1', 1010, 120, 'GET', 'http://localhost:3000/api', 500, 'fetch', NULL),
          ('req-remote', 'session-2', 1020, 120, 'GET', 'https://example.com/api', 500, 'fetch', NULL)
      `
    ).run();

    const tools = createToolRegistry(createV1ToolHandlers(() => db));
    const response = await routeToolCall(tools, 'get_network_failures', {
      url: 'http://localhost:3000',
      limit: 10,
    });

    expect(response.sessionId).toBeUndefined();
    expect(response.failures).toHaveLength(1);
    expect((response.failures as Array<{ requestId: string }>)[0]?.requestId).toBe('req-local');

    db.close();
  });

  it('queries network calls with targeted filters and sanitized bodies', async () => {
    const db = createTestDb();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('session-1', 1000, 0)
      `
    ).run();

    db.prepare(
      `
        INSERT INTO network (
          request_id, session_id, trace_id, tab_id, ts_start, duration_ms, method, url, origin, status, initiator, error_class, response_size_est,
          request_content_type, request_body_json, request_body_bytes, request_body_truncated,
          response_content_type, response_body_json, response_body_bytes, response_body_truncated
        ) VALUES
          ('req-chat', 'session-1', 'trace-1', 7, 1010, 120, 'POST', 'http://localhost:3000/api/chat/messages', 'http://localhost:3000', 200, 'fetch', NULL, 512,
           'application/json', '{"prompt":"hello","authorization":"[REDACTED]"}', 64, 0,
           'application/json', '{"answer":"ok","citations":["doc-1"]}', 96, 0)
      `
    ).run();

    const tools = createToolRegistry(createV1ToolHandlers(() => db));
    const response = await routeToolCall(tools, 'get_network_calls', {
      sessionId: 'session-1',
      method: 'post',
      urlContains: '/api/chat/messages',
      statusIn: [200],
      tabId: 7,
      includeBodies: true,
    });

    expect(response.calls).toHaveLength(1);
    expect((response.calls as Array<{ requestId: string }>)[0]?.requestId).toBe('req-chat');
    expect((response.calls as Array<{ traceId: string }>)[0]?.traceId).toBe('trace-1');
    expect((response.calls as Array<{ request: { bodyJson: Record<string, unknown> } }>)[0]?.request.bodyJson).toMatchObject({
      prompt: 'hello',
      authorization: '[REDACTED]',
    });

    db.close();
  });

  it('waits for matching network calls', async () => {
    const db = createTestDb();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('session-wait', 1000, 0)
      `
    ).run();

    setTimeout(() => {
      db.prepare(
        `
          INSERT INTO network (request_id, session_id, trace_id, ts_start, duration_ms, method, url, status, initiator)
          VALUES ('req-late', 'session-wait', 'trace-late', ?, 80, 'POST', 'http://localhost:3000/api/chat/messages', 200, 'fetch')
        `
      ).run(Date.now());
    }, 60);

    const tools = createToolRegistry(createV1ToolHandlers(() => db));
    const response = await routeToolCall(tools, 'wait_for_network_call', {
      sessionId: 'session-wait',
      urlPattern: '/api/chat/messages',
      method: 'POST',
      timeoutMs: 5000,
    });

    expect((response.call as { requestId: string }).requestId).toBe('req-late');
    expect((response.call as { traceId: string }).traceId).toBe('trace-late');
    expect((response.call as { method: string }).method).toBe('POST');

    db.close();
  });

  it('returns request trace chains and supports body chunk retrieval', async () => {
    const db = createTestDb();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('session-trace', 1000, 0)
      `
    ).run();

    db.prepare(
      `
        INSERT INTO events (event_id, session_id, ts, type, payload_json, tab_id, origin)
        VALUES ('evt-ui', 'session-trace', 1001, 'ui', '{"eventType":"click","selector":"#send","traceId":"trace-ui-1"}', 7, 'http://localhost:3000')
      `
    ).run();

    db.prepare(
      `
        INSERT INTO network (
          request_id, session_id, trace_id, tab_id, ts_start, duration_ms, method, url, origin, status, initiator,
          request_content_type, request_body_bytes, request_body_chunk_ref,
          response_content_type, response_body_bytes, response_body_chunk_ref
        ) VALUES
          ('req-trace', 'session-trace', 'trace-ui-1', 7, 1010, 120, 'POST', 'http://localhost:3000/api/chat/messages', 'http://localhost:3000', 200, 'fetch',
           'application/json', 40960, 'chunk-req-1',
           'application/json', 51200, 'chunk-res-1')
      `
    ).run();

    db.prepare(
      `
        INSERT INTO body_chunks (
          chunk_ref, session_id, request_id, trace_id, body_kind, content_type, body_text, body_bytes, truncated, created_at
        ) VALUES
          ('chunk-req-1', 'session-trace', 'req-trace', 'trace-ui-1', 'request', 'application/json', '{"prompt":"hello"}', 18, 0, 1011)
      `
    ).run();

    const tools = createToolRegistry(createV1ToolHandlers(() => db));
    const trace = await routeToolCall(tools, 'get_request_trace', {
      sessionId: 'session-trace',
      requestId: 'req-trace',
      includeBodies: true,
    });

    expect((trace.traceId as string)).toBe('trace-ui-1');
    expect((trace.networkCalls as Array<{ requestId: string }>).map((entry) => entry.requestId)).toEqual(['req-trace']);
    expect((trace.correlatedEvents as Array<{ eventId: string }>).map((entry) => entry.eventId)).toContain('evt-ui');

    const chunk = await routeToolCall(tools, 'get_body_chunk', {
      chunkRef: 'chunk-req-1',
      offset: 0,
      limit: 1024,
    });

    expect(chunk.chunkRef).toBe('chunk-req-1');
    expect(chunk.chunkText).toContain('"prompt":"hello"');

    db.close();
  });

  it('returns element refs filtered by selector with pagination', async () => {
    const db = createTestDb();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('session-1', 1000, 0)
      `
    ).run();

    db.prepare(
      `
        INSERT INTO events (event_id, session_id, ts, type, payload_json)
        VALUES
          ('evt-1', 'session-1', 1001, 'ui', '{"selector":"#save","eventType":"click"}'),
          ('evt-2', 'session-1', 1002, 'ui', '{"selector":"#cancel","eventType":"click"}'),
          ('evt-3', 'session-1', 1003, 'element_ref', '{"selector":"#save","label":"Save"}')
      `
    ).run();

    const tools = createToolRegistry(createV1ToolHandlers(() => db));
    const response = await routeToolCall(tools, 'get_element_refs', {
      sessionId: 'session-1',
      selector: '#save',
      limit: 1,
    });

    expect(response.selector).toBe('#save');
    expect(response.limitsApplied).toEqual({ maxResults: 1, truncated: true });
    expect((response.refs as Array<{ eventId: string }>)[0]?.eventId).toBe('evt-3');

    db.close();
  });

  it('explains latest failure timeline with correlated user action', async () => {
    const db = createTestDb();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('session-1', 1000, 0)
      `
    ).run();

    db.prepare(
      `
        INSERT INTO events (event_id, session_id, ts, type, payload_json)
        VALUES
          ('evt-click', 'session-1', 2000, 'ui', '{"eventType":"click","selector":"#submit"}'),
          ('evt-error', 'session-1', 2400, 'error', '{"message":"boom"}')
      `
    ).run();

    db.prepare(
      `
        INSERT INTO network (request_id, session_id, ts_start, duration_ms, method, url, status, initiator, error_class)
        VALUES
          ('req-1', 'session-1', 2300, 50, 'POST', 'https://api.example/submit', 500, 'fetch', NULL)
      `
    ).run();

    const tools = createToolRegistry(createV1ToolHandlers(() => db));
    const response = await routeToolCall(tools, 'explain_last_failure', {
      sessionId: 'session-1',
      lookbackSeconds: 10,
    });

    expect(response.sessionId).toBe('session-1');
    expect(response.explanation).toContain('Latest failure');
    expect(response.rootCause).toContain('network http_error');
    expect(response.timeline).toBeInstanceOf(Array);
    expect((response.timeline as Array<{ eventId: string }>).map((entry) => entry.eventId)).toEqual([
      'evt-click',
      'req-1',
      'evt-error',
    ]);

    db.close();
  });

  it('returns correlated events around an anchor event', async () => {
    const db = createTestDb();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('session-1', 1000, 0)
      `
    ).run();

    db.prepare(
      `
        INSERT INTO events (event_id, session_id, ts, type, payload_json)
        VALUES
          ('evt-click', 'session-1', 1000, 'ui', '{"eventType":"click","selector":"#save"}'),
          ('evt-nav', 'session-1', 1050, 'nav', '{"url":"https://app.example/dashboard"}'),
          ('evt-error', 'session-1', 1100, 'error', '{"message":"request failed"}')
      `
    ).run();

    db.prepare(
      `
        INSERT INTO network (request_id, session_id, ts_start, duration_ms, method, url, status, initiator, error_class)
        VALUES
          ('req-timeout', 'session-1', 1120, 1200, 'GET', 'https://api.example/items', NULL, 'fetch', 'timeout')
      `
    ).run();

    const tools = createToolRegistry(createV1ToolHandlers(() => db));
    const response = await routeToolCall(tools, 'get_event_correlation', {
      sessionId: 'session-1',
      eventId: 'evt-click',
      windowSeconds: 1,
    });

    expect(response.sessionId).toBe('session-1');
    expect(response.anchorEvent).toMatchObject({ eventId: 'evt-click', type: 'ui' });
    expect(response.windowSeconds).toBe(1);
    expect((response.correlatedEvents as Array<{ eventId: string }>).map((entry) => entry.eventId)).toEqual([
      'evt-error',
      'req-timeout',
      'evt-nav',
    ]);
    expect((response.correlatedEvents as Array<{ relationship: string }>)[0]?.relationship).toBe('possible_consequence');

    db.close();
  });

  it('lists snapshots with metadata-first pagination and filters', async () => {
    const db = createTestDb();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('session-1', 1000, 0)
      `
    ).run();

    db.prepare(
      `
        INSERT INTO snapshots (
          snapshot_id, session_id, trigger_event_id, ts, trigger, selector, url, mode, style_mode,
          dom_json, styles_json, png_path, png_mime, png_bytes,
          dom_truncated, styles_truncated, png_truncated, created_at
        ) VALUES
          ('snap-1', 'session-1', NULL, 2000, 'click', '#buy', 'https://example.dev', 'dom', 'computed-lite',
           '{"outline":true}', '{"display":"block"}', 'snapshot-assets/s1/snap-1.png', 'image/png', 128,
           0, 0, 0, 2010),
          ('snap-2', 'session-1', NULL, 3000, 'manual', '#save', 'https://example.dev/account', 'dom', 'computed-lite',
           '{"outline":true}', '{"display":"inline"}', NULL, NULL, NULL,
           1, 0, 0, 3010)
      `
    ).run();

    const tools = createToolRegistry(createV1ToolHandlers(() => db));
    const response = await routeToolCall(tools, 'list_snapshots', {
      sessionId: 'session-1',
      trigger: 'manual',
      sinceTimestamp: 2500,
      limit: 5,
    });

    expect(response.sessionId).toBe('session-1');
    expect(response.limitsApplied).toEqual({ maxResults: 5, truncated: false });
    expect(response.snapshots).toHaveLength(1);
    expect((response.snapshots as Array<{ snapshotId: string; hasDom: boolean; hasPng: boolean }>)[0]).toMatchObject({
      snapshotId: 'snap-2',
      hasDom: true,
      hasPng: false,
    });

    db.close();
  });

  it('finds snapshots for an event via trigger link and timestamp fallback', async () => {
    const db = createTestDb();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('session-1', 1000, 0)
      `
    ).run();

    db.prepare(
      `
        INSERT INTO events (event_id, session_id, ts, type, payload_json)
        VALUES
          ('evt-click', 'session-1', 4000, 'ui', '{"eventType":"click"}'),
          ('evt-manual', 'session-1', 8000, 'ui', '{"eventType":"manual"}')
      `
    ).run();

    db.prepare(
      `
        INSERT INTO snapshots (
          snapshot_id, session_id, trigger_event_id, ts, trigger, selector, url, mode, style_mode,
          dom_json, styles_json, png_path, png_mime, png_bytes,
          dom_truncated, styles_truncated, png_truncated, created_at
        ) VALUES
          ('snap-direct', 'session-1', 'evt-click', 4010, 'click', '#buy', NULL, 'dom', 'computed-lite',
           '{}', '{}', NULL, NULL, NULL, 0, 0, 0, 4011),
          ('snap-nearby', 'session-1', NULL, 8200, 'manual', '#manual', NULL, 'dom', 'computed-lite',
           '{}', '{}', NULL, NULL, NULL, 0, 0, 0, 8201)
      `
    ).run();

    const tools = createToolRegistry(createV1ToolHandlers(() => db));
    const direct = await routeToolCall(tools, 'get_snapshot_for_event', {
      sessionId: 'session-1',
      eventId: 'evt-click',
    });
    const fallback = await routeToolCall(tools, 'get_snapshot_for_event', {
      sessionId: 'session-1',
      eventId: 'evt-manual',
      maxDeltaMs: 500,
    });

    expect(direct.matchReason).toBe('trigger_event_id');
    expect((direct.snapshot as { snapshotId: string }).snapshotId).toBe('snap-direct');

    expect(fallback.matchReason).toBe('nearest_timestamp');
    expect((fallback.snapshot as { snapshotId: string }).snapshotId).toBe('snap-nearby');

    db.close();
  });

  it('reconstructs click to snapshot to failure analysis flow', async () => {
    const db = createTestDb();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('session-flow', 1000, 0)
      `
    ).run();

    db.prepare(
      `
        INSERT INTO events (event_id, session_id, ts, type, payload_json)
        VALUES
          ('evt-click', 'session-flow', 5000, 'ui', '{"eventType":"click","selector":"#checkout"}'),
          ('evt-error', 'session-flow', 5600, 'error', '{"message":"checkout failed"}')
      `
    ).run();

    db.prepare(
      `
        INSERT INTO network (request_id, session_id, ts_start, duration_ms, method, url, status, initiator, error_class)
        VALUES ('req-fail', 'session-flow', 5450, 40, 'POST', 'https://api.example/checkout', 500, 'fetch', NULL)
      `
    ).run();

    db.prepare(
      `
        INSERT INTO snapshots (
          snapshot_id, session_id, trigger_event_id, ts, trigger, selector, url, mode, style_mode,
          dom_json, styles_json, png_path, png_mime, png_bytes,
          dom_truncated, styles_truncated, png_truncated, created_at
        ) VALUES
          ('snap-checkout', 'session-flow', 'evt-click', 5050, 'click', '#checkout', 'https://example.dev/cart', 'dom', 'computed-lite',
           '{}', '{}', NULL, NULL, NULL, 0, 0, 0, 5060)
      `
    ).run();

    const tools = createToolRegistry(createV1ToolHandlers(() => db));
    const snapshotForClick = await routeToolCall(tools, 'get_snapshot_for_event', {
      sessionId: 'session-flow',
      eventId: 'evt-click',
    });
    const failureTimeline = await routeToolCall(tools, 'explain_last_failure', {
      sessionId: 'session-flow',
      lookbackSeconds: 10,
    });

    expect(snapshotForClick.matchReason).toBe('trigger_event_id');
    expect((snapshotForClick.snapshot as { snapshotId: string }).snapshotId).toBe('snap-checkout');
    expect((failureTimeline.timeline as Array<{ eventId: string }>).map((entry) => entry.eventId)).toEqual([
      'evt-click',
      'req-fail',
      'evt-error',
    ]);

    db.close();
  });

  it('returns chunked snapshot asset payloads with raw and base64 encoding', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-snapshot-asset-'));
    const dbPath = join(tempRoot, 'data', 'debug.sqlite');
    mkdirSync(join(tempRoot, 'data'), { recursive: true });
    const db = new Database(dbPath);
    initializeDatabase(db);

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('session-asset', 1000, 0)
      `
    ).run();

    const pngRelativePath = 'snapshot-assets/session-asset/snap-asset.png';
    mkdirSync(join(tempRoot, 'data', 'snapshot-assets', 'session-asset'), { recursive: true });
    const pngBuffer = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de', 'hex');
    writeFileSync(join(tempRoot, 'data', pngRelativePath), pngBuffer);

    db.prepare(
      `
        INSERT INTO snapshots (
          snapshot_id, session_id, trigger_event_id, ts, trigger, selector, url, mode, style_mode,
          dom_json, styles_json, png_path, png_mime, png_bytes,
          dom_truncated, styles_truncated, png_truncated, created_at
        ) VALUES
          ('snap-asset', 'session-asset', NULL, 2000, 'manual', '#asset', NULL, 'png', 'computed-lite',
           NULL, NULL, ?, 'image/png', ?,
           0, 0, 0, 2010)
      `
    ).run(pngRelativePath, pngBuffer.byteLength);

    const tools = createToolRegistry(createV1ToolHandlers(() => db));
    const rawChunk = await routeToolCall(tools, 'get_snapshot_asset', {
      sessionId: 'session-asset',
      snapshotId: 'snap-asset',
      maxBytes: 8,
      offset: 0,
      encoding: 'raw',
    });

    expect(rawChunk.encoding).toBe('raw');
    expect(rawChunk.returnedBytes).toBe(8);
    expect(rawChunk.hasMore).toBe(true);
    expect((rawChunk.chunk as number[]).length).toBe(8);

    const base64Chunk = await routeToolCall(tools, 'get_snapshot_asset', {
      sessionId: 'session-asset',
      snapshotId: 'snap-asset',
      maxBytes: 8,
      offset: 8,
      encoding: 'base64',
    });

    expect(base64Chunk.encoding).toBe('base64');
    expect(base64Chunk.returnedBytes).toBe(8);
    expect(typeof base64Chunk.chunkBase64).toBe('string');

    db.close();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('lists automation runs from dedicated automation tables', async () => {
    const db = createTestDb();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('session-automation', 1000, 0)
      `
    ).run();

    db.prepare(
      `
        INSERT INTO automation_runs (
          run_id, session_id, trace_id, action, tab_id, selector, status, started_at, completed_at,
          stop_reason, target_summary_json, failure_json, redaction_json, created_at, updated_at
        ) VALUES
          ('run-new', 'session-automation', 'trace-new', 'click', 7, '#checkout', 'succeeded', 3000, 3050,
           NULL, '{"resolvedSelector":"#checkout"}', NULL, '{"fields":0}', 3000, 3050),
          ('run-old', 'session-automation', 'trace-old', 'input', 7, '#email', 'failed', 2000, 2100,
           'field_blocked', '{"resolvedSelector":"#email"}', '{"code":"blocked"}', '{"fields":1}', 2000, 2100)
      `
    ).run();

    db.prepare(
      `
        INSERT INTO automation_steps (
          step_id, run_id, session_id, step_order, trace_id, action, selector, status, started_at,
          finished_at, duration_ms, tab_id, target_summary_json, redaction_json, failure_json,
          input_metadata_json, event_type, event_id, created_at, updated_at
        ) VALUES
          ('run-new:1', 'run-new', 'session-automation', 1, 'trace-new', 'click', '#checkout', 'succeeded', 3000,
           3050, 50, 7, '{"resolvedSelector":"#checkout"}', '{"fields":0}', NULL,
           NULL, 'automation_succeeded', NULL, 3000, 3050),
          ('run-old:1', 'run-old', 'session-automation', 1, 'trace-old', 'input', '#email', 'failed', 2000,
           2100, 100, 7, '{"resolvedSelector":"#email"}', '{"fields":1}', '{"code":"blocked"}',
           '{"valueLength":12}', 'automation_failed', NULL, 2000, 2100)
      `
    ).run();

    const tools = createToolRegistry(createV1ToolHandlers(() => db));
    const response = await routeToolCall(tools, 'list_automation_runs', {
      sessionId: 'session-automation',
      status: 'failed',
      limit: 5,
    });

    expect(response.sessionId).toBe('session-automation');
    expect(response.limitsApplied).toEqual({ maxResults: 5, truncated: false });
    expect(response.runs).toHaveLength(1);
    expect((response.runs as Array<Record<string, unknown>>)[0]).toMatchObject({
      runId: 'run-old',
      status: 'failed',
      action: 'input',
      stepCount: 1,
      source: 'automation_runs',
    });

    db.close();
  });

  it('returns one automation run with paginated steps', async () => {
    const db = createTestDb();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('session-automation-detail', 1000, 0)
      `
    ).run();

    db.prepare(
      `
        INSERT INTO automation_runs (
          run_id, session_id, trace_id, action, tab_id, selector, status, started_at, completed_at,
          stop_reason, target_summary_json, failure_json, redaction_json, created_at, updated_at
        ) VALUES (
          'run-detail', 'session-automation-detail', 'trace-detail', 'click', 9, '#submit', 'failed', 4000, 4200,
          'action_failed', '{"resolvedSelector":"#submit"}', '{"code":"action_failed"}', '{"fields":1}', 4000, 4200
        )
      `
    ).run();

    db.prepare(
      `
        INSERT INTO automation_steps (
          step_id, run_id, session_id, step_order, trace_id, action, selector, status, started_at,
          finished_at, duration_ms, tab_id, target_summary_json, redaction_json, failure_json,
          input_metadata_json, event_type, event_id, created_at, updated_at
        ) VALUES
          ('run-detail:1', 'run-detail', 'session-automation-detail', 1, 'trace-detail', 'click', '#submit', 'started', 4000,
           NULL, NULL, 9, '{"resolvedSelector":"#submit"}', '{"fields":0}', NULL,
           NULL, 'automation_started', NULL, 4000, 4000),
          ('run-detail:2', 'run-detail', 'session-automation-detail', 2, 'trace-detail', 'click', '#submit', 'failed', 4100,
           4200, 100, 9, '{"resolvedSelector":"#submit"}', '{"fields":1}', '{"code":"action_failed"}',
           '{"valueLength":0}', 'automation_failed', NULL, 4100, 4200)
      `
    ).run();

    const tools = createToolRegistry(createV1ToolHandlers(() => db));
    const response = await routeToolCall(tools, 'get_automation_run', {
      sessionId: 'session-automation-detail',
      runId: 'run-detail',
      stepLimit: 1,
      stepOffset: 1,
    });

    expect(response.sessionId).toBe('session-automation-detail');
    expect((response.run as Record<string, unknown>)).toMatchObject({
      runId: 'run-detail',
      status: 'failed',
      stepCount: 2,
      source: 'automation_runs',
    });
    expect(response.steps).toHaveLength(1);
    expect((response.steps as Array<Record<string, unknown>>)[0]).toMatchObject({
      stepId: 'run-detail:2',
      stepOrder: 2,
      status: 'failed',
      eventType: 'automation_failed',
      source: 'automation_steps',
    });
    expect(response.pagination).toMatchObject({
      offset: 1,
      returned: 1,
      hasMore: false,
      nextOffset: null,
    });

    db.close();
  });
});

describe('mcp/server V2 capture tools', () => {
  it('captures dom subtree with limits', async () => {
    const captureCalls: Array<{ command: string; payload: Record<string, unknown> }> = [];
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command, payload) => {
          captureCalls.push({ command, payload });
          return {
            ok: true,
            payload: {
              mode: 'outline',
              selector: payload.selector,
              outline: '{"tag":"body"}',
            },
            truncated: true,
          };
        },
      })
    );

    const response = await routeToolCall(tools, 'get_dom_subtree', {
      sessionId: 'session-v2',
      selector: '#root',
      maxDepth: 2,
      maxBytes: 10000,
    });

    expect(captureCalls).toHaveLength(1);
    expect(captureCalls[0]).toMatchObject({ command: 'CAPTURE_DOM_SUBTREE' });
    expect(response.mode).toBe('outline');
    expect(response.limitsApplied).toEqual({ maxResults: 10000, truncated: true });
  });

  it('falls back to outline document mode when html capture times out', async () => {
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command, payload) => {
          if (command === 'CAPTURE_DOM_DOCUMENT' && payload.mode === 'html') {
            throw new Error('Capture command timed out after 4000ms');
          }

          return {
            ok: true,
            payload: {
              mode: 'outline',
              outline: '{"tag":"html"}',
            },
            truncated: true,
          };
        },
      })
    );

    const response = await routeToolCall(tools, 'get_dom_document', {
      sessionId: 'session-v2',
      mode: 'html',
      maxBytes: 5000,
    });

    expect(response.mode).toBe('outline');
    expect(response.fallbackReason).toBe('timeout');
    expect(response.limitsApplied).toEqual({ maxResults: 5000, truncated: true });
  });

  it('requests only specified computed style properties', async () => {
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command, payload) => {
          expect(command).toBe('CAPTURE_COMPUTED_STYLES');
          expect(payload.properties).toEqual(['display', 'visibility']);

          return {
            ok: true,
            payload: {
              selector: payload.selector,
              properties: {
                display: 'block',
                visibility: 'visible',
              },
            },
          };
        },
      })
    );

    const response = await routeToolCall(tools, 'get_computed_styles', {
      sessionId: 'session-v2',
      selector: '.target',
      properties: ['display', 'visibility'],
    });

    expect(response.selector).toBe('.target');
    expect(response.properties).toEqual({ display: 'block', visibility: 'visible' });
  });

  it('normalizes disconnected extension errors for live capture tools', async () => {
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async () => {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        },
      })
    );

    await expect(routeToolCall(tools, 'get_dom_document', {
      sessionId: 'session-v2',
      mode: 'outline',
    })).rejects.toThrow('LIVE_SESSION_DISCONNECTED');
  });
  it('captures ui snapshot through v2 capture command path', async () => {
    const captureCalls: Array<{ command: string; payload: Record<string, unknown> }> = [];
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command, payload) => {
          captureCalls.push({ command, payload });
          return {
            ok: true,
            payload: {
              trigger: payload.trigger,
              selector: payload.selector ?? 'body',
              mode: { dom: true, png: false },
              snapshot: {
                dom: { mode: 'outline', outline: '{"tag":"button"}' },
                styles: { mode: 'computed-lite', chain: [] },
              },
            },
            truncated: false,
          };
        },
      })
    );

    const response = await routeToolCall(tools, 'capture_ui_snapshot', {
      sessionId: 'session-v2',
      selector: '#checkout',
      trigger: 'click',
      mode: 'dom',
      styleMode: 'computed-lite',
      maxDepth: 2,
      maxBytes: 16000,
      maxAncestors: 2,
    });

    expect(captureCalls).toHaveLength(1);
    expect(captureCalls[0]).toMatchObject({
      command: 'CAPTURE_UI_SNAPSHOT',
      payload: {
        selector: '#checkout',
        trigger: 'click',
        mode: 'dom',
        styleMode: 'computed-lite',
        explicitStyleMode: true,
        llmRequested: true,
      },
    });
    expect(response.trigger).toBe('click');
    expect(response.snapshot).toBeDefined();
  });

  it('uses metadata-first defaults for png snapshot mode', async () => {
    const captureCalls: Array<{ command: string; payload: Record<string, unknown> }> = [];
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command, payload) => {
          captureCalls.push({ command, payload });
          return {
            ok: true,
            payload: {
              mode: {
                dom: true,
                png: true,
              },
              snapshot: {
                dom: { html: '<div>heavy</div>' },
                styles: { chain: [{ properties: { display: 'block' } }] },
              },
              png: {
                captured: true,
                byteLength: 2048,
                dataUrl: 'data:image/png;base64,AAAA',
              },
            },
            truncated: false,
          };
        },
      }),
    );

    const response = await routeToolCall(tools, 'capture_ui_snapshot', {
      sessionId: 'session-v2',
      mode: 'png',
    });

    expect(captureCalls[0]).toMatchObject({
      payload: {
        includeDom: false,
        includeStyles: false,
        includePngDataUrl: false,
      },
    });
    expect((response.snapshot as { dom?: unknown; styles?: unknown })?.dom).toBeUndefined();
    expect((response.snapshot as { dom?: unknown; styles?: unknown })?.styles).toBeUndefined();
    expect((response.png as { dataUrl?: string })?.dataUrl).toBeUndefined();
  });

  it('requests live console logs through v2 capture command path', async () => {
    const captureCalls: Array<{ command: string; payload: Record<string, unknown> }> = [];
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command, payload) => {
          captureCalls.push({ command, payload });
          return {
            ok: true,
            payload: {
              logs: [
                {
                  timestamp: 1700000001000,
                  level: 'info',
                  message: '[auth] logged in success',
                  tabId: 7,
                  origin: 'http://localhost:3000',
                  source: 'console',
                },
              ],
              pagination: {
                returned: 1,
                matched: 1,
              },
              bufferStats: {
                buffered: 42,
                dropped: 0,
              },
            },
            truncated: false,
          };
        },
      }),
    );

    const response = await routeToolCall(tools, 'get_live_console_logs', {
      sessionId: 'session-v2',
      url: 'http://localhost:3000/path',
      tabId: 7,
      levels: ['info', 'error'],
      contains: '[auth]',
      sinceTs: 1700000000000,
      limit: 25,
    });

    expect(captureCalls).toHaveLength(1);
    expect(captureCalls[0]).toMatchObject({
      command: 'CAPTURE_GET_LIVE_CONSOLE_LOGS',
      payload: {
        origin: 'http://localhost:3000',
        tabId: 7,
        levels: ['info', 'error'],
        contains: '[auth]',
        sinceTs: 1700000000000,
        includeRuntimeErrors: true,
        limit: 25,
      },
    });
    expect(response.limitsApplied).toEqual({ maxResults: 25, truncated: false });
    expect((response.logs as Array<{ message: string }>)[0]?.message).toContain('[auth]');
  });

  it('executes live ui actions through the existing session command path', async () => {
    const captureCalls: Array<{ command: string; payload: Record<string, unknown> }> = [];
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command, payload) => {
          captureCalls.push({ command, payload });
          return {
            ok: true,
            payload: {
              action: 'click',
              traceId: 'trace-live-1',
              status: 'succeeded',
              executionScope: 'top-document-v1',
              startedAt: 1700000000000,
              finishedAt: 1700000000020,
              target: {
                matched: true,
                selector: '#submit',
                resolvedSelector: '#submit',
                tagName: 'button',
                tabId: 9,
                frameId: 0,
                url: 'http://localhost:3000/checkout',
              },
              result: {
                button: 'left',
                clickCount: 1,
              },
            },
            truncated: false,
          };
        },
      }),
    );

    const response = await routeToolCall(tools, 'execute_ui_action', {
      sessionId: 'session-v2',
      action: 'click',
      target: {
        selector: '#submit',
        tabId: 9,
      },
      input: {
        clickCount: 1,
      },
    });

    expect(captureCalls).toHaveLength(1);
    expect(captureCalls[0]).toMatchObject({
      command: 'EXECUTE_UI_ACTION',
      payload: {
        action: 'click',
        target: {
          selector: '#submit',
          tabId: 9,
        },
      },
    });
    expect(response.status).toBe('succeeded');
    expect(response.traceId).toBe('trace-live-1');
    expect(response.tabContext).toEqual({
      tabId: 9,
      frameId: 0,
      url: 'http://localhost:3000/checkout',
    });
    expect(response.supportedScopes).toEqual({
      executionScope: 'top-document-v1',
      topDocumentOnly: true,
      opensNewBrowserSession: false,
    });
  });

  it('captures snapshot evidence when a live ui action fails', async () => {
    const captureCalls: Array<{ command: string; payload: Record<string, unknown> }> = [];
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command, payload) => {
          captureCalls.push({ command, payload });
          if (command === 'EXECUTE_UI_ACTION') {
            return {
              ok: true,
              payload: {
                action: 'input',
                traceId: 'trace-live-2',
                status: 'failed',
                executionScope: 'top-document-v1',
                startedAt: 1700000000100,
                finishedAt: 1700000000200,
                target: {
                  matched: true,
                  selector: '#email',
                  resolvedSelector: '#email',
                  tagName: 'input',
                  tabId: 4,
                  frameId: 0,
                  url: 'http://localhost:3000/login',
                },
                failureReason: {
                  code: 'action_execution_failed',
                  message: 'Mutation observer blocked the field update.',
                },
              },
              truncated: false,
            };
          }

          return {
            ok: true,
            payload: {
              timestamp: 1700000000300,
              trigger: 'error',
              selector: '#email',
              snapshot: {
                dom: { html: '<input id="email" />' },
                styles: { chain: [] },
              },
            },
            truncated: false,
          };
        },
      }),
    );

    const response = await routeToolCall(tools, 'execute_ui_action', {
      sessionId: 'session-v2',
      action: 'input',
      target: {
        selector: '#email',
      },
      input: {
        value: 'person@example.com',
      },
      captureOnFailure: {
        enabled: true,
        mode: 'dom',
        styleMode: 'computed-lite',
      },
    });

    expect(captureCalls).toHaveLength(2);
    expect(captureCalls[1]).toMatchObject({
      command: 'CAPTURE_UI_SNAPSHOT',
      payload: {
        selector: '#email',
        trigger: 'error',
        mode: 'dom',
        styleMode: 'computed-lite',
      },
    });
    expect(response.status).toBe('failed');
    expect(response.failureDetails).toEqual({
      code: 'action_execution_failed',
      message: 'Mutation observer blocked the field update.',
    });
    expect(response.postActionEvidence).toMatchObject({
      captured: true,
      snapshot: {
        selector: '#email',
        trigger: 'error',
      },
    });
  });

  it('supports compact live console profile with byte-budget truncation', async () => {
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async () => ({
          ok: true,
          payload: {
            logs: [
              {
                timestamp: 1700000001000,
                level: 'info',
                message: 'a'.repeat(5000),
                args: ['verbose'],
              },
              {
                timestamp: 1700000000000,
                level: 'warn',
                message: 'b'.repeat(5000),
                args: ['verbose'],
              },
            ],
            pagination: {
              returned: 2,
              matched: 2,
            },
          },
          truncated: false,
        }),
      }),
    );

    const response = await routeToolCall(tools, 'get_live_console_logs', {
      sessionId: 'session-v2',
      responseProfile: 'compact',
      maxResponseBytes: 1024,
    });

    expect(response.responseProfile).toBe('compact');
    expect((response.logs as Array<Record<string, unknown>>).length).toBe(1);
    expect((response.logs as Array<Record<string, unknown>>)[0]?.args).toBeUndefined();
    expect(response.limitsApplied).toEqual({ maxResults: 50, truncated: true });
    expect(response.pagination).toMatchObject({
      returned: 1,
      hasMore: true,
      maxResponseBytes: 1024,
    });
  });

  it('rejects invalid url for live console log capture tool', async () => {
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async () => ({ ok: true, payload: { logs: [] } }),
      }),
    );

    await expect(routeToolCall(tools, 'get_live_console_logs', {
      sessionId: 'session-v2',
      url: 'localhost:3000',
    })).rejects.toThrow('url must be a valid absolute http(s) URL');
  });

  it('rejects invalid tabId for live console log capture tool', async () => {
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async () => ({ ok: true, payload: { logs: [] } }),
      }),
    );

    await expect(routeToolCall(tools, 'get_live_console_logs', {
      sessionId: 'session-v2',
      tabId: 'abc',
    })).rejects.toThrow('tabId must be an integer');
  });
});
