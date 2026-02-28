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
    expect(response.pagination).toEqual({ offset: 1, returned: 1 });
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
