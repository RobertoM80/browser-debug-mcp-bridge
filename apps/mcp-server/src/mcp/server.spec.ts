import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
import { createToolLoopGuard } from './tool-loop-guard.js';
import { persistObservedOverrideAssets } from '../override-observed-assets.js';

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

  it('warns and then blocks repeated same failing tool attempts before side effects', async () => {
    const db = new Database(':memory:');
    initializeDatabase(db);
    let callCount = 0;
    const failingEnable: ToolHandler = async (input) => {
      callCount += 1;
      return {
        sessionId: typeof input.sessionId === 'string' ? input.sessionId : undefined,
        limitsApplied: {
          maxResults: 1,
          truncated: false,
        },
        redactionSummary: {
          totalFields: 0,
          redactedFields: 0,
          rulesApplied: [],
        },
        preflight: {
          ready: false,
          issues: [{ code: 'CONFIG_DISABLED', severity: 'error' }],
        },
        nextActions: [{ code: 'ENABLE_CONFIG', message: 'Enable config first.' }],
      };
    };
    const tools = createToolRegistry({ enable_overrides: failingEnable });
    const loopGuard = createToolLoopGuard({ getDb: () => db });
    const input = { sessionId: 'loop-session', tabId: 7 };

    const first = await routeToolCall(tools, 'enable_overrides', input, { loopGuard });
    const second = await routeToolCall(tools, 'enable_overrides', input, { loopGuard });
    const third = await routeToolCall(tools, 'enable_overrides', input, { loopGuard });
    const fourth = await routeToolCall(tools, 'enable_overrides', input, { loopGuard });

    expect(callCount).toBe(3);
    expect(first.loopGuard).toBeUndefined();
    expect((second.loopGuard as { status?: string } | undefined)?.status).toBe('warning');
    expect((third.loopGuard as { status?: string } | undefined)?.status).toBe('blocked_next_attempt');
    expect(fourth.blocked).toBe(true);
    expect((fourth.loopGuard as { status?: string; rootCauseCode?: string })).toMatchObject({
      status: 'blocked',
      rootCauseCode: 'CONFIG_DISABLED',
    });

    const invocationCount = db.prepare('SELECT COUNT(*) AS count FROM mcp_tool_invocations').get() as { count: number };
    const incident = db.prepare('SELECT * FROM mcp_loop_incidents WHERE status = ?').get('open') as {
      root_cause_code: string;
      severity: string;
    };
    expect(invocationCount.count).toBe(4);
    expect(incident).toMatchObject({ root_cause_code: 'CONFIG_DISABLED', severity: 'blocked' });
    db.close();
  });

  it('does not block when repeated tool attempts change input state', async () => {
    const db = new Database(':memory:');
    initializeDatabase(db);
    let callCount = 0;
    const failingEnable: ToolHandler = async (input) => {
      callCount += 1;
      return {
        sessionId: typeof input.sessionId === 'string' ? input.sessionId : undefined,
        limitsApplied: {
          maxResults: 1,
          truncated: false,
        },
        redactionSummary: {
          totalFields: 0,
          redactedFields: 0,
          rulesApplied: [],
        },
        ready: false,
        issues: [{ code: 'TARGET_ASSET_NOT_OBSERVED', severity: 'error' }],
      };
    };
    const tools = createToolRegistry({ enable_overrides: failingEnable });
    const loopGuard = createToolLoopGuard({ getDb: () => db });

    await routeToolCall(tools, 'enable_overrides', { sessionId: 'loop-session', tabId: 1 }, { loopGuard });
    await routeToolCall(tools, 'enable_overrides', { sessionId: 'loop-session', tabId: 2 }, { loopGuard });
    await routeToolCall(tools, 'enable_overrides', { sessionId: 'loop-session', tabId: 3 }, { loopGuard });
    await routeToolCall(tools, 'enable_overrides', { sessionId: 'loop-session', tabId: 4 }, { loopGuard });

    expect(callCount).toBe(4);
    db.close();
  });

  it('can disable loop guarding for controlled diagnostics', async () => {
    const db = new Database(':memory:');
    initializeDatabase(db);
    let callCount = 0;
    const failingEnable: ToolHandler = async (input) => {
      callCount += 1;
      return {
        sessionId: typeof input.sessionId === 'string' ? input.sessionId : undefined,
        limitsApplied: {
          maxResults: 1,
          truncated: false,
        },
        redactionSummary: {
          totalFields: 0,
          redactedFields: 0,
          rulesApplied: [],
        },
        ready: false,
        issues: [{ code: 'TARGET_ASSET_NOT_OBSERVED', severity: 'error' }],
      };
    };
    const tools = createToolRegistry({ enable_overrides: failingEnable });
    const loopGuard = createToolLoopGuard({ getDb: () => db, enabled: false });

    for (let index = 0; index < 5; index += 1) {
      await routeToolCall(tools, 'enable_overrides', { sessionId: 'loop-session', tabId: 1 }, { loopGuard });
    }

    const invocationCount = db.prepare('SELECT COUNT(*) AS count FROM mcp_tool_invocations').get() as { count: number };
    expect(callCount).toBe(5);
    expect(invocationCount.count).toBe(0);
    db.close();
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

  it('lists sessions using last_seen_at activity, not only created_at', async () => {
    const db = createTestDb();
    const now = Date.now();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, last_seen_at, safe_mode, url_start, url_last)
        VALUES (?, ?, ?, ?, ?, ?)
      `
    ).run('session-active-old', now - 2 * 60 * 60_000, now - 2 * 60_000, 0, 'https://old.example', 'https://old.example/live');
    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, last_seen_at, safe_mode, url_start, url_last)
        VALUES (?, ?, ?, ?, ?, ?)
      `
    ).run('session-stale-old', now - 30 * 60_000, now - 4 * 60 * 60_000, 1, 'https://new.example', 'https://new.example');

    const tools = createToolRegistry(createV1ToolHandlers(() => db));
    const response = await routeToolCall(tools, 'list_sessions', { sinceMinutes: 10 });

    expect(response.sessions).toHaveLength(1);
    expect((response.sessions as Array<{ sessionId: string }>)[0]?.sessionId).toBe('session-active-old');

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

  it('returns live session health guidance with stale-aware connection status', async () => {
    const db = createTestDb();
    const now = Date.now();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, last_seen_at, safe_mode, url_start, url_last)
        VALUES (?, ?, ?, ?, ?, ?)
      `
    ).run(
      'session-health',
      now - 20 * 60_000,
      now - 2 * 60_000,
      1,
      'https://app.example',
      'https://ep2.adtrafficquality.google/sodar/sodar2/254/runner.html',
    );

    const tools = createToolRegistry(
      createV1ToolHandlers(
        () => db,
        (sessionId) => sessionId === 'session-health'
          ? {
              connected: false,
              connectedAt: now - 15 * 60_000,
              lastHeartbeatAt: now - 90_000,
              disconnectedAt: now - 45_000,
              disconnectReason: 'stale_timeout',
            }
          : undefined,
      ),
    );

    const response = await routeToolCall(tools, 'get_live_session_health', { sessionId: 'session-health' });

    expect(response.status).toBe('active');
    expect(response.lastSeenAt).toBe(now - 90_000);
    expect(response.scope).toMatchObject({
      kind: 'likely_iframe_noise',
    });
    expect(response.liveConnection).toMatchObject({
      connected: false,
      status: 'disconnected',
      disconnectReason: 'stale_timeout',
      recommendedForLiveCapture: false,
    });
    expect(typeof response.nextAction).toBe('string');

    db.close();
  });

  it('marks recently active disconnected sessions as likely_stale when scope looks interactive', async () => {
    const db = createTestDb();
    const now = Date.now();

    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, last_seen_at, safe_mode, url_start, url_last)
        VALUES (?, ?, ?, ?, ?, ?)
      `
    ).run(
      'session-stale-live',
      now - 40 * 60_000,
      now - 3 * 60_000,
      0,
      'http://localhost:3000',
      'http://localhost:3000/rankings',
    );

    const tools = createToolRegistry(
      createV1ToolHandlers(
        () => db,
        (sessionId) => sessionId === 'session-stale-live'
          ? {
              connected: false,
              connectedAt: now - 30 * 60_000,
              lastHeartbeatAt: now - 2 * 60_000,
              disconnectedAt: now - 30_000,
              disconnectReason: 'stale_timeout',
            }
          : undefined,
      ),
    );

    const response = await routeToolCall(tools, 'get_live_session_health', { sessionId: 'session-stale-live' });

    expect(response.scope).toMatchObject({
      kind: 'top_level_page',
      isLocalhost: true,
    });
    expect(response.liveConnection).toMatchObject({
      status: 'likely_stale',
      recommendedForLiveCapture: false,
    });
    expect(String(response.nextAction)).toContain('Retry list_sessions');

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

  it('returns live session health with reconnect guidance', async () => {
    const db = createTestDb();
    const now = Date.now();

    db.prepare(
      `
        INSERT INTO sessions (
          session_id, created_at, safe_mode, url_start, url_last, tab_id, window_id, viewport_w, viewport_h, dpr, pinned
        )
        VALUES ('session-health', ?, 1, 'http://localhost:8081', 'http://localhost:8081', 11, 22, 1440, 900, 2, 1)
      `
    ).run(now - 30_000);

    const tools = createToolRegistry(
      createV1ToolHandlers(() => db, (sessionId) => sessionId === 'session-health'
        ? {
            connected: false,
            connectedAt: now - 25_000,
            lastHeartbeatAt: now - 5_000,
            disconnectedAt: now - 2_000,
            disconnectReason: 'network_error',
          }
        : undefined),
    );

    const response = await routeToolCall(tools, 'get_live_session_health', {
      sessionId: 'session-health',
    });

    expect(response.session).toMatchObject({
      sessionId: 'session-health',
      tabId: 11,
      windowId: 22,
      safeMode: true,
      pinned: true,
      viewport: {
        width: 1440,
        height: 900,
      },
    });
    expect(response.liveConnection).toMatchObject({
      connected: false,
      disconnectReason: 'network_error',
    });
    expect(response.recommendedAction).toBe('reconnect_extension');

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

  it('exposes override profile, audit log, status, and diagnosis tools', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-override-tools-'));
    const originalOverrideConfigPath = process.env.OVERRIDE_POC_CONFIG_PATH;
    const db = createTestDb();

    try {
      const localAssetPath = join(tempRoot, 'override.js');
      const configPath = join(tempRoot, 'override-poc.config.json');
      writeFileSync(localAssetPath, 'console.log("override");', 'utf8');
      writeFileSync(
        configPath,
        JSON.stringify({
          enabled: true,
          targetAssetUrl: 'https://example.com/app.js',
          localFilePath: './override.js',
          contentType: 'application/javascript; charset=utf-8',
          autoReload: true,
        }),
        'utf8',
      );
      process.env.OVERRIDE_POC_CONFIG_PATH = configPath;

      db.prepare(`
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('override-session', 1000, 0)
      `).run();

      db.prepare(`
        INSERT INTO override_runs (
          run_id, session_id, started_at, run_status, tab_id, selected_tab_id, target_asset_url, local_file_path,
          resolved_local_file_path, content_type, auto_reload, config_path, file_exists, file_size_bytes,
          matched_requests, fulfilled_requests, last_matched_at, last_error_code, last_error_message, created_at, updated_at
        ) VALUES (
          'run-override', 'override-session', 1100, 'failed', 7, 7, 'https://example.com/app.js', './override.js',
          ?, 'application/javascript; charset=utf-8', 1, ?, 1, 24,
          1, 0, 1200, 'FULFILL_FAILED', 'Inspector target closed', 1100, 1300
        )
      `).run(localAssetPath, configPath);

      db.prepare(`
        INSERT INTO override_requests (
          request_log_id, run_id, session_id, request_id, ts, request_url, request_status,
          failure_code, error_message, created_at, updated_at
        ) VALUES (
          'run-override:req-1', 'run-override', 'override-session', 'req-1', 1200, 'https://example.com/app.js', 'failed',
          'FULFILL_FAILED', 'Inspector target closed', 1200, 1300
        )
      `).run();
      persistObservedOverrideAssets(db, {
        sessionId: 'override-session',
        serviceWorkerControlled: true,
        cspMetaTags: ["script-src 'self'"],
        assets: [{
          url: 'https://example.com/app.js',
          kind: 'script',
          integrity: 'sha384-test',
          fromDom: true,
        }],
      });

      const tools = createToolRegistry(createV1ToolHandlers(() => db));
      const profiles = await routeToolCall(tools, 'list_override_profiles', {});
      const validation = await routeToolCall(tools, 'validate_override_profile', { profileId: 'poc' });
      const status = await routeToolCall(tools, 'get_override_status', { sessionId: 'override-session' });
      const requests = await routeToolCall(tools, 'get_override_request_log', { sessionId: 'override-session', runId: 'run-override' });
      const diagnosis = await routeToolCall(tools, 'diagnose_overrides', { sessionId: 'override-session', runId: 'run-override' });

      expect((profiles.profiles as Array<{ profileId: string }>)[0]?.profileId).toBe('poc');
      expect(validation.valid).toBe(true);
      expect((status.latestRun as { runId?: string } | null)?.runId).toBe('run-override');
      expect((status.recentRequests as Array<{ requestLogId: string }>)[0]?.requestLogId).toBe('run-override:req-1');
      expect((requests.requests as Array<{ requestLogId: string }>)[0]?.requestLogId).toBe('run-override:req-1');
      const diagnosisPayload = diagnosis.diagnosis as {
        observedAssets: { targetAssetObserved: boolean; serviceWorkerControlled: boolean; cspMetaTagCount: number };
        issues: Array<{ code: string }>;
      };
      expect(diagnosisPayload.issues.some((issue) => issue.code === 'FULFILL_FAILED')).toBe(true);
      expect(diagnosisPayload.issues.some((issue) => issue.code === 'TARGET_ASSET_SRI_PRESENT')).toBe(true);
      expect(diagnosisPayload.issues.some((issue) => issue.code === 'CSP_META_PRESENT')).toBe(true);
      expect(diagnosisPayload.observedAssets).toMatchObject({
        targetAssetObserved: true,
        serviceWorkerControlled: true,
        cspMetaTagCount: 1,
      });
    } finally {
      if (originalOverrideConfigPath === undefined) {
        delete process.env.OVERRIDE_POC_CONFIG_PATH;
      } else {
        process.env.OVERRIDE_POC_CONFIG_PATH = originalOverrideConfigPath;
      }
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('generates and optionally writes override profiles through MCP', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-override-profile-generator-'));
    const db = createTestDb();

    try {
      const assetsDir = join(tempRoot, 'dist', 'assets');
      mkdirSync(assetsDir, { recursive: true });
      writeFileSync(join(assetsDir, 'app.js'), 'console.log("app");', 'utf8');

      const configPath = join(tempRoot, 'override-poc.local.json');
      const tools = createToolRegistry(createV1ToolHandlers(() => db));
      const generated = await routeToolCall(tools, 'create_override_profile', {
        adapter: 'static',
        projectRoot: tempRoot,
        assetRoot: 'dist/assets',
        targetBaseUrl: 'https://example.com/assets/',
        configPath: 'override-poc.local.json',
        writeConfig: true,
      });

      expect(generated.adapter).toBe('static');
      expect(generated.ruleCount).toBe(1);
      expect((generated.write as { written?: boolean }).written).toBe(true);
      expect((generated.profile as { rules: Array<{ targetAssetUrl: string }> }).rules[0]?.targetAssetUrl).toBe('https://example.com/assets/app.js');
      expect(readFileSync(configPath, 'utf8')).toContain('https://example.com/assets/app.js');
      expect((generated.nextActions as Array<{ code: string }>).some((action) => action.code === 'VALIDATE_PROFILE')).toBe(true);
    } finally {
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('marks RSC flight override profiles invalid before enablement', async () => {
    const originalOverrideConfigPath = process.env.OVERRIDE_POC_CONFIG_PATH;
    const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-override-rsc-validation-'));
    const db = createTestDb();

    try {
      const localResponsePath = join(tempRoot, 'products.rsc.txt');
      writeFileSync(localResponsePath, '1:["$","h1",null,{"children":"Override"}]', 'utf8');
      const configPath = join(tempRoot, 'override-poc.local.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          enabled: true,
          activeProfileId: 'rsc-profile',
          profiles: [{
            profileId: 'rsc-profile',
            name: 'RSC profile',
            enabled: true,
            autoReload: true,
            rules: [{
              ruleId: 'rsc-rule',
              enabled: true,
              ruleType: 'rsc-flight',
              requestMethod: 'GET',
              matchMode: 'prefix',
              targetAssetUrl: 'https://example.com/products?_rsc=',
              localFilePath: localResponsePath,
              contentType: 'text/x-component; charset=utf-8',
            }],
          }],
        }, null, 2),
        'utf8',
      );
      process.env.OVERRIDE_POC_CONFIG_PATH = configPath;

      const tools = createToolRegistry(createV1ToolHandlers(() => db));
      const validation = await routeToolCall(tools, 'validate_override_profile', { profileId: 'rsc-profile' });

      expect(validation.valid).toBe(false);
      expect((validation.issues as Array<{ code?: string; severity?: string }>)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'UNSUPPORTED_RSC_FLIGHT_RULE',
            severity: 'error',
          }),
        ]),
      );
      expect((validation.nextActions as Array<{ code?: string }>)[0]?.code).toBe('REPLAN_RSC_RESPONSE_OVERRIDE');
    } finally {
      if (originalOverrideConfigPath === undefined) {
        delete process.env.OVERRIDE_POC_CONFIG_PATH;
      } else {
        process.env.OVERRIDE_POC_CONFIG_PATH = originalOverrideConfigPath;
      }
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('validates planner-generated production RSC flight override profiles', async () => {
    const originalOverrideConfigPath = process.env.OVERRIDE_POC_CONFIG_PATH;
    const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-override-rsc-production-validation-'));
    const configPath = join(tempRoot, 'override-poc.local.json');
    const db = createTestDb();

    try {
      process.env.OVERRIDE_POC_CONFIG_PATH = configPath;
      const tools = createToolRegistry(createV1ToolHandlers(() => db));
      const plan = await routeToolCall(tools, 'plan_override_response_patch', {
        targetUrl: 'https://example.com/products?_rsc=',
        matchMode: 'prefix',
        captureMode: 'cdp-response',
        contentType: 'text/x-component; charset=utf-8',
        responseBodyText: '1:["$","h1",null,{"children":"Original debugging kits"}]',
        requestHeaders: {
          RSC: '1',
        },
        textPatches: [{ search: 'Original debugging kits', replacement: 'Override debugging kits', expectedCount: 1 }],
        configPath,
        writeConfig: true,
        overwrite: true,
        profileId: 'rsc-production-profile',
      });

      expect(plan.configWritten).toBe(true);
      expect(plan.rule).toMatchObject({
        ruleType: 'rsc-flight',
        rscFlight: {
          productionMode: 'structured-flight-v1',
          source: 'cdp-response',
          patchKind: 'string-value-text',
        },
      });

      const validation = await routeToolCall(tools, 'validate_override_profile', { profileId: 'rsc-production-profile' });
      expect(validation.valid).toBe(true);
      expect(validation.issues).toEqual([]);
      expect((validation.nextActions as Array<{ code?: string }>)[0]?.code).toBe('ENABLE_OVERRIDES');
    } finally {
      if (originalOverrideConfigPath === undefined) {
        delete process.env.OVERRIDE_POC_CONFIG_PATH;
      } else {
        process.env.OVERRIDE_POC_CONFIG_PATH = originalOverrideConfigPath;
      }
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('validates planner-generated captured POST RSC flight override profiles', async () => {
    const originalOverrideConfigPath = process.env.OVERRIDE_POC_CONFIG_PATH;
    const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-override-rsc-post-validation-'));
    const configPath = join(tempRoot, 'override-poc.local.json');
    const db = createTestDb();

    try {
      process.env.OVERRIDE_POC_CONFIG_PATH = configPath;
      const tools = createToolRegistry(createV1ToolHandlers(() => db));
      const plan = await routeToolCall(tools, 'plan_override_response_patch', {
        targetUrl: 'https://example.com/products',
        requestMethod: 'POST',
        ruleType: 'rsc-flight',
        matchMode: 'exact',
        captureMode: 'cdp-response',
        contentType: 'text/x-component; charset=utf-8',
        responseBodyText: '1:["$","h1",null,{"children":"Original POST RSC proof"}]',
        requestHeaders: {
          rsc: '1',
        },
        textPatches: [{ search: 'Original POST RSC proof', replacement: 'Override POST RSC proof', expectedCount: 1 }],
        configPath,
        writeConfig: true,
        overwrite: true,
        profileId: 'rsc-post-production-profile',
      });

      expect(plan.configWritten).toBe(true);
      expect(plan.rule).toMatchObject({
        ruleType: 'rsc-flight',
        requestMethod: 'POST',
        targetAssetUrl: 'https://example.com/products',
        rscFlight: {
          productionMode: 'structured-flight-v1',
          source: 'cdp-response',
          patchKind: 'string-value-text',
          requestHeaders: {
            rsc: '1',
          },
        },
      });

      const validation = await routeToolCall(tools, 'validate_override_profile', { profileId: 'rsc-post-production-profile' });
      expect(validation.valid).toBe(true);
      expect(validation.issues).toEqual([]);
      expect((validation.nextActions as Array<{ code?: string }>)[0]?.code).toBe('ENABLE_OVERRIDES');
    } finally {
      if (originalOverrideConfigPath === undefined) {
        delete process.env.OVERRIDE_POC_CONFIG_PATH;
      } else {
        process.env.OVERRIDE_POC_CONFIG_PATH = originalOverrideConfigPath;
      }
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('marks manual Next.js server action rules invalid with a dedicated blocker', async () => {
    const originalOverrideConfigPath = process.env.OVERRIDE_POC_CONFIG_PATH;
    const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-override-server-action-validation-'));
    const db = createTestDb();

    try {
      const localResponsePath = join(tempRoot, 'server-action.rsc.txt');
      writeFileSync(localResponsePath, '1:["$","div",null,{"children":"Override"}]', 'utf8');
      const configPath = join(tempRoot, 'override-poc.local.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          enabled: true,
          activeProfileId: 'server-action-profile',
          profiles: [{
            profileId: 'server-action-profile',
            name: 'Server action profile',
            enabled: true,
            autoReload: true,
            rules: [{
              ruleId: 'server-action-rule',
              enabled: true,
              ruleType: 'rsc-flight',
              requestMethod: 'POST',
              requestHeaders: {
                'next-action': 'fixture-action',
                rsc: '1',
              },
              matchMode: 'exact',
              targetAssetUrl: 'https://example.com/server-actions',
              localFilePath: localResponsePath,
              contentType: 'text/x-component; charset=utf-8',
            }],
          }],
        }, null, 2),
        'utf8',
      );
      process.env.OVERRIDE_POC_CONFIG_PATH = configPath;

      const tools = createToolRegistry(createV1ToolHandlers(() => db));
      const validation = await routeToolCall(tools, 'validate_override_profile', { profileId: 'server-action-profile' });

      expect(validation.valid).toBe(false);
      expect((validation.issues as Array<{ code?: string; severity?: string }>)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'UNSAFE_REQUEST_METHOD', severity: 'error' }),
          expect.objectContaining({ code: 'SERVER_ACTION_UNSUPPORTED', severity: 'error' }),
        ]),
      );
      expect((validation.nextActions as Array<{ code?: string }>)[0]?.code).toBe('REPLAN_SERVER_ACTION_OVERRIDE');
    } finally {
      if (originalOverrideConfigPath === undefined) {
        delete process.env.OVERRIDE_POC_CONFIG_PATH;
      } else {
        process.env.OVERRIDE_POC_CONFIG_PATH = originalOverrideConfigPath;
      }
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('preflights override enablement with GET-only validation and observed browser constraints', async () => {
    const originalOverrideConfigPath = process.env.OVERRIDE_POC_CONFIG_PATH;
    const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-override-preflight-'));
    const db = createTestDb();

    try {
      const localResponsePath = join(tempRoot, 'mutation.json');
      writeFileSync(localResponsePath, '{"message":"override"}', 'utf8');
      const configPath = join(tempRoot, 'override-poc.local.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          enabled: true,
          activeProfileId: 'mutation-profile',
          profiles: [{
            profileId: 'mutation-profile',
            name: 'Mutation profile',
            enabled: true,
            autoReload: true,
            rules: [{
              ruleId: 'mutation-rule',
              enabled: true,
              ruleType: 'api-response',
              requestMethod: 'POST',
              matchMode: 'exact',
              targetAssetUrl: 'https://example.com/api/cart',
              localFilePath: localResponsePath,
              contentType: 'application/json; charset=utf-8',
            }],
          }],
        }, null, 2),
        'utf8',
      );
      process.env.OVERRIDE_POC_CONFIG_PATH = configPath;

      db.prepare(`
        INSERT INTO sessions (session_id, created_at, last_seen_at, safe_mode)
        VALUES ('session-preflight', 1000, 1100, 0)
      `).run();
      persistObservedOverrideAssets(db, {
        sessionId: 'session-preflight',
        serviceWorkerControlled: true,
        cspMetaTags: ["default-src 'self'"],
        assets: [{
          url: 'https://example.com/api/cart',
          ruleType: 'api-response',
          requestMethod: 'POST',
          kind: 'fetch',
          integrity: 'sha384-cart',
          fromFetch: true,
        }],
      });

      const tools = createToolRegistry(
        createV1ToolHandlers(
          () => db,
          (sessionId) => sessionId === 'session-preflight'
            ? { connected: true, connectedAt: 1200, lastHeartbeatAt: 1300 }
            : undefined,
        ),
      );
      const preflight = await routeToolCall(tools, 'preflight_overrides', { sessionId: 'session-preflight' });
      const status = await routeToolCall(tools, 'get_override_status', { sessionId: 'session-preflight' });

      expect(preflight.ready).toBe(false);
      expect(preflight.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'UNSAFE_REQUEST_METHOD', severity: 'error', source: 'profile' }),
        expect.objectContaining({ code: 'MUTATION_REPLAY_UNSUPPORTED', severity: 'error', source: 'profile' }),
        expect.objectContaining({ code: 'TARGET_ASSET_SRI_PRESENT', severity: 'error', source: 'observed-assets' }),
        expect.objectContaining({ code: 'SERVICE_WORKER_CONTROLLED', severity: 'warning', source: 'observed-assets' }),
        expect.objectContaining({ code: 'CSP_META_PRESENT', severity: 'warning', source: 'observed-assets' }),
      ]));
      expect((preflight.nextActions as Array<{ code?: string }>)[0]?.code).toBe('REPLAN_MUTATION_OVERRIDE');
      expect((status.preflight as { ready?: boolean }).ready).toBe(false);
    } finally {
      if (originalOverrideConfigPath === undefined) {
        delete process.env.OVERRIDE_POC_CONFIG_PATH;
      } else {
        process.env.OVERRIDE_POC_CONFIG_PATH = originalOverrideConfigPath;
      }
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('blocks preflight when a live session has no connected extension state or observed assets', async () => {
    const originalOverrideConfigPath = process.env.OVERRIDE_POC_CONFIG_PATH;
    const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-override-readiness-disconnected-'));
    const db = createTestDb();

    try {
      const localAssetPath = join(tempRoot, 'app.local.js');
      writeFileSync(localAssetPath, 'console.log("override");', 'utf8');
      const configPath = join(tempRoot, 'override-poc.local.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          enabled: true,
          activeProfileId: 'asset-profile',
          profiles: [{
            profileId: 'asset-profile',
            name: 'Asset profile',
            enabled: true,
            autoReload: true,
            rules: [{
              ruleId: 'asset-rule',
              enabled: true,
              ruleType: 'asset',
              requestMethod: 'GET',
              matchMode: 'exact',
              targetAssetUrl: 'https://example.com/app.js',
              localFilePath: localAssetPath,
              contentType: 'application/javascript; charset=utf-8',
            }],
          }],
        }, null, 2),
        'utf8',
      );
      process.env.OVERRIDE_POC_CONFIG_PATH = configPath;

      db.prepare(`
        INSERT INTO sessions (session_id, created_at, last_seen_at, safe_mode, tab_id, url_last)
        VALUES ('session-readiness', 1000, 1100, 0, 7, 'https://example.com/')
      `).run();

      const tools = createToolRegistry(
        createV1ToolHandlers(
          () => db,
          () => undefined,
        ),
      );
      const preflight = await routeToolCall(tools, 'preflight_overrides', { sessionId: 'session-readiness' });

      expect(preflight.ready).toBe(false);
      expect(preflight.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'LIVE_SESSION_DISCONNECTED', severity: 'error', source: 'connection' }),
        expect.objectContaining({ code: 'NO_OBSERVED_ASSETS', severity: 'error', source: 'observed-assets' }),
      ]));
      expect(preflight.checks).toMatchObject({
        connected: false,
        captureReady: false,
        observedAssetCount: 0,
      });
      expect((preflight.nextActions as Array<{ code?: string }>)[0]?.code).toBe('RECONNECT_SESSION');
    } finally {
      if (originalOverrideConfigPath === undefined) {
        delete process.env.OVERRIDE_POC_CONFIG_PATH;
      } else {
        process.env.OVERRIDE_POC_CONFIG_PATH = originalOverrideConfigPath;
      }
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('blocks preflight when observed assets belong only to another tab', async () => {
    const originalOverrideConfigPath = process.env.OVERRIDE_POC_CONFIG_PATH;
    const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-override-readiness-scope-'));
    const db = createTestDb();

    try {
      const localAssetPath = join(tempRoot, 'app.local.js');
      writeFileSync(localAssetPath, 'console.log("override");', 'utf8');
      const configPath = join(tempRoot, 'override-poc.local.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          enabled: true,
          activeProfileId: 'asset-profile',
          profiles: [{
            profileId: 'asset-profile',
            name: 'Asset profile',
            enabled: true,
            autoReload: true,
            rules: [{
              ruleId: 'asset-rule',
              enabled: true,
              ruleType: 'asset',
              requestMethod: 'GET',
              matchMode: 'exact',
              targetAssetUrl: 'https://example.com/app.js',
              localFilePath: localAssetPath,
              contentType: 'application/javascript; charset=utf-8',
            }],
          }],
        }, null, 2),
        'utf8',
      );
      process.env.OVERRIDE_POC_CONFIG_PATH = configPath;

      db.prepare(`
        INSERT INTO sessions (session_id, created_at, last_seen_at, safe_mode, tab_id, url_last)
        VALUES ('session-scope', 1000, 1100, 0, 7, 'https://example.com/')
      `).run();
      persistObservedOverrideAssets(db, {
        sessionId: 'session-scope',
        tabId: 99,
        pageUrl: 'https://ads.example/frame.html',
        assets: [{
          url: 'https://example.com/app.js',
          ruleType: 'asset',
          requestMethod: 'GET',
          kind: 'script',
          fromPerformance: true,
        }],
      });

      const tools = createToolRegistry(
        createV1ToolHandlers(
          () => db,
          () => ({ connected: true, connectedAt: 1200, lastHeartbeatAt: 1300 }),
        ),
      );
      const preflight = await routeToolCall(tools, 'preflight_overrides', { sessionId: 'session-scope' });

      expect(preflight.ready).toBe(false);
      expect(preflight.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'SESSION_SCOPE_DRIFT', severity: 'error', source: 'observed-assets' }),
      ]));
      expect(preflight.checks).toMatchObject({
        connected: true,
        topLevelScopeLikely: false,
        observedAssetTabs: [99],
      });
      expect((preflight.nextActions as Array<{ code?: string }>)[0]?.code).toBe('FOCUS_BOUND_TAB');
    } finally {
      if (originalOverrideConfigPath === undefined) {
        delete process.env.OVERRIDE_POC_CONFIG_PATH;
      } else {
        process.env.OVERRIDE_POC_CONFIG_PATH = originalOverrideConfigPath;
      }
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('accepts a capture-ready generated profile when at least one enabled target was observed', async () => {
    const originalOverrideConfigPath = process.env.OVERRIDE_POC_CONFIG_PATH;
    const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-override-readiness-generated-'));
    const db = createTestDb();

    try {
      const observedLocalAssetPath = join(tempRoot, 'observed.local.js');
      const deferredLocalAssetPath = join(tempRoot, 'deferred.local.js');
      writeFileSync(observedLocalAssetPath, 'console.log("observed");', 'utf8');
      writeFileSync(deferredLocalAssetPath, 'console.log("deferred");', 'utf8');
      const configPath = join(tempRoot, 'override-poc.local.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          enabled: true,
          activeProfileId: 'generated-profile',
          profiles: [{
            profileId: 'generated-profile',
            name: 'Generated asset profile',
            enabled: true,
            autoReload: true,
            rules: [
              {
                ruleId: 'observed-rule',
                enabled: true,
                ruleType: 'asset',
                requestMethod: 'GET',
                matchMode: 'exact',
                targetAssetUrl: 'https://example.com/_next/static/chunks/observed.js',
                localFilePath: observedLocalAssetPath,
                contentType: 'application/javascript; charset=utf-8',
              },
              {
                ruleId: 'deferred-rule',
                enabled: true,
                ruleType: 'asset',
                requestMethod: 'GET',
                matchMode: 'exact',
                targetAssetUrl: 'https://example.com/_next/static/chunks/deferred.js',
                localFilePath: deferredLocalAssetPath,
                contentType: 'application/javascript; charset=utf-8',
              },
            ],
          }],
        }, null, 2),
        'utf8',
      );
      process.env.OVERRIDE_POC_CONFIG_PATH = configPath;

      db.prepare(`
        INSERT INTO sessions (session_id, created_at, last_seen_at, safe_mode, tab_id, url_last)
        VALUES ('session-generated', 1000, 1100, 0, 7, 'https://example.com/')
      `).run();
      persistObservedOverrideAssets(db, {
        sessionId: 'session-generated',
        tabId: 7,
        pageUrl: 'https://example.com/',
        assets: [{
          url: 'https://example.com/_next/static/chunks/observed.js',
          ruleType: 'asset',
          requestMethod: 'GET',
          kind: 'script',
          fromPerformance: true,
        }],
      });

      const tools = createToolRegistry(
        createV1ToolHandlers(
          () => db,
          () => ({ connected: true, connectedAt: 1200, lastHeartbeatAt: 1300 }),
        ),
      );
      const preflight = await routeToolCall(tools, 'preflight_overrides', { sessionId: 'session-generated' });

      expect(preflight.ready).toBe(true);
      expect(preflight.issues).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'TARGET_ASSET_NOT_OBSERVED', severity: 'error' }),
      ]));
      expect(preflight.checks).toMatchObject({
        captureReady: true,
        targetAssetObserved: true,
      });
      expect(preflight.observedAssets).toMatchObject({
        targetAssetObserved: true,
        matchedTargetAssetCount: 1,
        unobservedTargetAssetCount: 1,
      });
    } finally {
      if (originalOverrideConfigPath === undefined) {
        delete process.env.OVERRIDE_POC_CONFIG_PATH;
      } else {
        process.env.OVERRIDE_POC_CONFIG_PATH = originalOverrideConfigPath;
      }
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('treats prefix-match response rules as observed when a captured request starts with the target URL', async () => {
    const originalOverrideConfigPath = process.env.OVERRIDE_POC_CONFIG_PATH;
    const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-override-readiness-prefix-'));
    const db = createTestDb();

    try {
      const localAssetPath = join(tempRoot, 'products.rsc.txt');
      writeFileSync(localAssetPath, '1:["$","h1",null,{"children":"Override"}]', 'utf8');
      const configPath = join(tempRoot, 'override-poc.local.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          enabled: true,
          activeProfileId: 'rsc-profile',
          profiles: [{
            profileId: 'rsc-profile',
            name: 'RSC profile',
            enabled: true,
            autoReload: true,
            rules: [{
              ruleId: 'rsc-rule',
              enabled: true,
              ruleType: 'rsc-flight',
              requestMethod: 'GET',
              matchMode: 'prefix',
              allowExperimentalRscFlightFulfillment: true,
              targetAssetUrl: 'https://example.com/products?_rsc=',
              localFilePath: localAssetPath,
              contentType: 'text/x-component; charset=utf-8',
            }],
          }],
        }, null, 2),
        'utf8',
      );
      process.env.OVERRIDE_POC_CONFIG_PATH = configPath;

      db.prepare(`
        INSERT INTO sessions (session_id, created_at, last_seen_at, safe_mode, tab_id, url_last)
        VALUES ('session-prefix', 1000, 1100, 0, 7, 'https://example.com/products')
      `).run();
      persistObservedOverrideAssets(db, {
        sessionId: 'session-prefix',
        tabId: 7,
        pageUrl: 'https://example.com/products',
        assets: [{
          url: 'https://example.com/products?_rsc=abc123',
          ruleType: 'rsc-flight',
          requestMethod: 'GET',
          kind: 'fetch',
          fromPerformance: true,
        }],
      });

      const tools = createToolRegistry(
        createV1ToolHandlers(
          () => db,
          () => ({ connected: true, connectedAt: 1200, lastHeartbeatAt: 1300 }),
        ),
      );
      const preflight = await routeToolCall(tools, 'preflight_overrides', { sessionId: 'session-prefix' });

      expect(preflight.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'UNSUPPORTED_RSC_FLIGHT_RULE', severity: 'error' }),
      ]));
      expect(preflight.issues).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'TARGET_ASSET_NOT_OBSERVED', severity: 'error' }),
      ]));
      expect(preflight.checks).toMatchObject({
        targetAssetObserved: true,
      });
    } finally {
      if (originalOverrideConfigPath === undefined) {
        delete process.env.OVERRIDE_POC_CONFIG_PATH;
      } else {
        process.env.OVERRIDE_POC_CONFIG_PATH = originalOverrideConfigPath;
      }
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('accepts planner-captured RSC rules when the live session is capture-ready before target navigation', async () => {
    const originalOverrideConfigPath = process.env.OVERRIDE_POC_CONFIG_PATH;
    const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-override-readiness-rsc-captured-'));
    const configPath = join(tempRoot, 'override-poc.local.json');
    const db = createTestDb();

    try {
      process.env.OVERRIDE_POC_CONFIG_PATH = configPath;
      const tools = createToolRegistry(
        createV1ToolHandlers(
          () => db,
          () => ({ connected: true, connectedAt: 1200, lastHeartbeatAt: 1300 }),
        ),
      );
      await routeToolCall(tools, 'plan_override_response_patch', {
        targetUrl: 'https://example.com/products?_rsc=',
        matchMode: 'prefix',
        captureMode: 'cdp-response',
        contentType: 'text/x-component; charset=utf-8',
        responseBodyText: '1:["$","h1",null,{"children":"Original debugging kits"}]',
        requestHeaders: {
          RSC: '1',
        },
        textPatches: [{ search: 'Original debugging kits', replacement: 'Override debugging kits', expectedCount: 1 }],
        configPath,
        writeConfig: true,
        overwrite: true,
        profileId: 'captured-rsc-profile',
      });

      db.prepare(`
        INSERT INTO sessions (session_id, created_at, last_seen_at, safe_mode, tab_id, url_last)
        VALUES ('session-rsc-ready', 1000, 1100, 0, 7, 'https://example.com/')
      `).run();
      persistObservedOverrideAssets(db, {
        sessionId: 'session-rsc-ready',
        tabId: 7,
        pageUrl: 'https://example.com/',
        assets: [{
          url: 'https://example.com/',
          ruleType: 'document',
          requestMethod: 'GET',
          kind: 'document',
          fromNavigation: true,
        }],
      });

      const preflight = await routeToolCall(tools, 'preflight_overrides', {
        sessionId: 'session-rsc-ready',
        profileId: 'captured-rsc-profile',
      });

      expect(preflight.ready).toBe(true);
      expect(preflight.issues).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'TARGET_ASSET_NOT_OBSERVED', severity: 'error' }),
      ]));
      expect(preflight.checks).toMatchObject({
        captureReady: true,
        targetAssetObserved: false,
        targetAssetReadinessSatisfied: true,
        capturedTargetAssetCount: 1,
      });
    } finally {
      if (originalOverrideConfigPath === undefined) {
        delete process.env.OVERRIDE_POC_CONFIG_PATH;
      } else {
        process.env.OVERRIDE_POC_CONFIG_PATH = originalOverrideConfigPath;
      }
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('plans structured JSON response patches through MCP', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-json-response-patch-'));
    const configPath = join(tempRoot, 'override-poc.local.json');
    const db = createTestDb();

    try {
      db.prepare(`
        INSERT INTO sessions (session_id, created_at, last_seen_at, safe_mode)
        VALUES ('session-audit', 1000, 1000, 0)
      `).run();
      const tools = createToolRegistry(createV1ToolHandlers(() => db));
      const plan = await routeToolCall(tools, 'plan_override_response_patch', {
        sessionId: 'session-audit',
        targetUrl: 'https://example.com/api/override-signal',
        ruleType: 'api-response',
        contentType: 'application/json; charset=utf-8',
        responseBodyText: '{"mode":"original-api","message":"Original","badge":"stable"}',
        jsonPatches: [
          { path: '/mode', value: 'override-api', expectedValue: 'original-api' },
          { path: '/message', value: 'Override' },
          { path: '/badge', value: 'override' },
        ],
        configPath,
        writeConfig: true,
        overwrite: true,
        profileId: 'json-response-profile',
        includePreview: true,
      });

      expect(plan.configWritten).toBe(true);
      expect(plan.audit).toMatchObject({
        persisted: true,
        plans: [{
          plannerKind: 'response-patch',
          ruleType: 'api-response',
          profileId: 'json-response-profile',
          targetAssetUrl: 'https://example.com/api/override-signal',
        }],
      });
      expect(plan.patches).toEqual([]);
      expect(plan.jsonPatches).toHaveLength(3);
      expect(plan.variantContext).toMatchObject({
        pathname: '/api/override-signal',
        requestMethod: 'GET',
        ruleType: 'api-response',
        searchParamKeys: [],
      });
      expect(plan.rule).toMatchObject({
        ruleType: 'api-response',
        targetAssetUrl: 'https://example.com/api/override-signal',
      });
      const generated = JSON.parse(readFileSync((plan.rule as { localFilePath: string }).localFilePath, 'utf8')) as {
        mode: string;
        message: string;
        badge: string;
      };
      expect(generated).toEqual({
        mode: 'override-api',
        message: 'Override',
        badge: 'override',
      });

      const planLog = await routeToolCall(tools, 'get_override_plan_log', {
        sessionId: 'session-audit',
        planId: ((plan.audit as { plans: Array<{ planId: string }> }).plans[0] as { planId: string }).planId,
      });
      expect(planLog.plans).toHaveLength(1);
      expect((planLog.plans as Array<{
        originalSha256?: string;
        patchedSha256?: string;
        patchSummary?: { jsonPatches?: unknown[]; variantContext?: { pathname?: string; requestMethod?: string; variantKey?: string } };
        preview?: { before?: string; after?: string };
        rollback?: { disableTool?: string; generatedFiles?: string[]; configPath?: string };
      }>)[0]).toMatchObject({
        originalSha256: plan.originalSha256,
        patchedSha256: plan.patchedSha256,
        patchSummary: {
          jsonPatches: expect.any(Array),
          variantContext: {
            pathname: '/api/override-signal',
            requestMethod: 'GET',
            variantKey: expect.any(String),
          },
        },
        preview: { before: expect.stringContaining('original-api'), after: expect.stringContaining('override-api') },
        rollback: {
          disableTool: 'disable_overrides',
          configPath,
          generatedFiles: [(plan.rule as { localFilePath: string }).localFilePath],
        },
      });
    } finally {
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('plans structured document patches through MCP and persists document patch metadata', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-document-response-patch-'));
    const configPath = join(tempRoot, 'override-poc.local.json');
    const db = createTestDb();

    try {
      db.prepare(`
        INSERT INTO sessions (session_id, created_at, last_seen_at, safe_mode)
        VALUES ('session-document-audit', 1000, 1000, 0)
      `).run();
      const tools = createToolRegistry(createV1ToolHandlers(() => db));
      const plan = await routeToolCall(tools, 'plan_override_response_patch', {
        sessionId: 'session-document-audit',
        targetUrl: 'https://example.com/products',
        ruleType: 'document',
        contentType: 'text/html; charset=utf-8',
        responseBodyText: '<!doctype html><html><body><h1>Original products</h1><p id="mode">boot-extra</p><script src="/extra.js"></script></body></html>',
        documentPatches: [
          {
            operation: 'replaceText',
            selector: 'h1',
            search: 'Original products',
            replacement: 'Document patched products',
            expectedCount: 1,
          },
          {
            operation: 'removeElement',
            selector: 'script[src="/extra.js"]',
            expectedCount: 1,
          },
        ],
        configPath,
        writeConfig: true,
        overwrite: true,
        profileId: 'document-response-profile',
        includePreview: true,
      });

      expect(plan.configWritten).toBe(true);
      expect(plan.documentPatches).toEqual(expect.arrayContaining([
        expect.objectContaining({ operation: 'replaceText', matchedTextCount: 1 }),
        expect.objectContaining({ operation: 'removeElement', removedCount: 1 }),
      ]));

      const planLog = await routeToolCall(tools, 'get_override_plan_log', {
        sessionId: 'session-document-audit',
        planId: ((plan.audit as { plans: Array<{ planId: string }> }).plans[0] as { planId: string }).planId,
      });
      expect((planLog.plans as Array<{
        patchSummary?: {
          documentPatches?: Array<{ operation?: string; matchedTextCount?: number; removedCount?: number }>;
        };
      }>)[0]).toMatchObject({
        patchSummary: {
          documentPatches: expect.arrayContaining([
            expect.objectContaining({ operation: 'replaceText', matchedTextCount: 1 }),
            expect.objectContaining({ operation: 'removeElement', removedCount: 1 }),
          ]),
        },
      });
    } finally {
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects Next.js server action response plans through MCP', async () => {
    const db = createTestDb();

    try {
      const tools = createToolRegistry(createV1ToolHandlers(() => db));
      await expect(routeToolCall(tools, 'plan_override_response_patch', {
        targetUrl: 'https://example.com/server-actions',
        ruleType: 'rsc-flight',
        requestMethod: 'POST',
        requestHeaders: {
          'next-action': 'fixture-action',
          rsc: '1',
        },
        contentType: 'text/x-component; charset=utf-8',
        responseBodyText: '1:["$","div",null,{"children":"Original server action payload"}]',
        textPatches: [{ search: 'Original server action payload', replacement: 'Override server action payload', expectedCount: 1 }],
      })).rejects.toThrow('SERVER_ACTION_UNSUPPORTED');
    } finally {
      db.close();
    }
  });

  it('rejects generic mutation response plans through MCP', async () => {
    const db = createTestDb();

    try {
      const tools = createToolRegistry(createV1ToolHandlers(() => db));
      await expect(routeToolCall(tools, 'plan_override_response_patch', {
        targetUrl: 'https://example.com/api/mutation-signal',
        ruleType: 'api-response',
        requestMethod: 'POST',
        requestHeaders: {
          'content-type': 'application/json',
        },
        contentType: 'application/json; charset=utf-8',
        responseBodyText: '{"mode":"original","message":"Original mutation response"}',
        jsonPatches: [{ path: '/mode', value: 'override' }],
      })).rejects.toThrow('MUTATION_REPLAY_UNSUPPORTED');
    } finally {
      db.close();
    }
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
          stop_reason, target_summary_json, diagnostics_json, failure_json, redaction_json, created_at, updated_at
        ) VALUES
          ('run-new', 'session-automation', 'trace-new', 'click', 7, '#checkout', 'succeeded', 3000, 3050,
           NULL, '{"resolvedSelector":"#checkout"}', '{"backend":"cdp-native-v2"}', NULL, '{"fields":0}', 3000, 3050),
          ('run-old', 'session-automation', 'trace-old', 'input', 7, '#email', 'failed', 2000, 2100,
           'field_blocked', '{"resolvedSelector":"#email"}', '{"actionability":{"visible":true,"editable":false}}', '{"code":"blocked"}', '{"fields":1}', 2000, 2100)
      `
    ).run();

    db.prepare(
      `
        INSERT INTO automation_steps (
          step_id, run_id, session_id, step_order, trace_id, action, selector, status, started_at,
          finished_at, duration_ms, tab_id, target_summary_json, diagnostics_json, redaction_json, failure_json,
          input_metadata_json, event_type, event_id, created_at, updated_at
        ) VALUES
          ('run-new:1', 'run-new', 'session-automation', 1, 'trace-new', 'click', '#checkout', 'succeeded', 3000,
           3050, 50, 7, '{"resolvedSelector":"#checkout"}', '{"backend":"cdp-native-v2"}', '{"fields":0}', NULL,
           NULL, 'automation_succeeded', NULL, 3000, 3050),
          ('run-old:1', 'run-old', 'session-automation', 1, 'trace-old', 'input', '#email', 'failed', 2000,
           2100, 100, 7, '{"resolvedSelector":"#email"}', '{"actionability":{"visible":true,"editable":false}}', '{"fields":1}', '{"code":"blocked"}',
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
      diagnostics: {
        actionability: {
          editable: false,
        },
      },
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
          stop_reason, target_summary_json, diagnostics_json, failure_json, redaction_json, created_at, updated_at
        ) VALUES (
          'run-detail', 'session-automation-detail', 'trace-detail', 'click', 9, '#submit', 'failed', 4000, 4200,
          'action_failed', '{"resolvedSelector":"#submit"}', '{"backend":"cdp-native-v2","actionability":{"hitTargetMatches":false}}', '{"code":"action_failed"}', '{"fields":1}', 4000, 4200
        )
      `
    ).run();

    db.prepare(
      `
        INSERT INTO automation_steps (
          step_id, run_id, session_id, step_order, trace_id, action, selector, status, started_at,
          finished_at, duration_ms, tab_id, target_summary_json, diagnostics_json, redaction_json, failure_json,
          input_metadata_json, event_type, event_id, created_at, updated_at
        ) VALUES
          ('run-detail:1', 'run-detail', 'session-automation-detail', 1, 'trace-detail', 'click', '#submit', 'started', 4000,
           NULL, NULL, 9, '{"resolvedSelector":"#submit"}', NULL, '{"fields":0}', NULL,
           NULL, 'automation_started', NULL, 4000, 4000),
          ('run-detail:2', 'run-detail', 'session-automation-detail', 2, 'trace-detail', 'click', '#submit', 'failed', 4100,
           4200, 100, 9, '{"resolvedSelector":"#submit"}', '{"backend":"cdp-native-v2","actionability":{"hitTargetMatches":false}}', '{"fields":1}', '{"code":"action_failed"}',
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
      diagnostics: {
        actionability: {
          hitTargetMatches: false,
        },
      },
      stepCount: 2,
      source: 'automation_runs',
    });
    expect(response.steps).toHaveLength(1);
    expect((response.steps as Array<Record<string, unknown>>)[0]).toMatchObject({
      stepId: 'run-detail:2',
      stepOrder: 2,
      status: 'failed',
      diagnostics: {
        backend: 'cdp-native-v2',
        actionability: {
          hitTargetMatches: false,
        },
      },
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
  function writeReadyAssetOverrideConfig(tempRoot: string): string {
    const localAssetPath = join(tempRoot, 'app.local.js');
    writeFileSync(localAssetPath, 'console.log("override");', 'utf8');
    const configPath = join(tempRoot, 'override-poc.local.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        enabled: true,
        activeProfileId: 'asset-profile',
        profiles: [{
          profileId: 'asset-profile',
          name: 'Asset profile',
          enabled: true,
          autoReload: true,
          rules: [{
            ruleId: 'asset-rule',
            enabled: true,
            ruleType: 'asset',
            requestMethod: 'GET',
            matchMode: 'exact',
            targetAssetUrl: 'https://example.com/app.js',
            localFilePath: localAssetPath,
            contentType: 'application/javascript; charset=utf-8',
          }],
        }],
      }, null, 2),
      'utf8',
    );
    return configPath;
  }

  function seedReadyOverrideSession(db: Database.Database, sessionId = 'session-live'): void {
    db.prepare(`
      INSERT INTO sessions (session_id, created_at, last_seen_at, safe_mode, tab_id, url_last)
      VALUES (?, 1000, 1100, 0, 7, 'https://example.com/')
    `).run(sessionId);
    persistObservedOverrideAssets(db, {
      sessionId,
      tabId: 7,
      pageUrl: 'https://example.com/',
      assets: [{
        url: 'https://example.com/app.js',
        ruleType: 'asset',
        requestMethod: 'GET',
        kind: 'script',
        fromPerformance: true,
      }],
    });
  }

  it('routes override control tools through live capture commands', async () => {
    const captureCalls: Array<{ sessionId: string; command: string; payload: Record<string, unknown> }> = [];
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (sessionId, command, payload) => {
          captureCalls.push({ sessionId, command, payload });
          return {
            ok: true,
            payload: {
              active: command === 'CAPTURE_OVERRIDE_POC_ENABLE',
              configuredEnabled: true,
              tabId: payload.tabId,
              matchedRequests: 0,
              fulfilledRequests: 0,
            },
          };
        },
      })
    );

    const status = await routeToolCall(tools, 'get_override_status', { sessionId: 'session-live' });
    const enabled = await routeToolCall(tools, 'enable_overrides', { sessionId: 'session-live', tabId: 7 });
    const disabled = await routeToolCall(tools, 'disable_overrides', { sessionId: 'session-live' });

    expect(captureCalls.map((call) => call.command)).toEqual([
      'CAPTURE_OVERRIDE_POC_GET_STATUS',
      'CAPTURE_OVERRIDE_POC_ENABLE',
      'CAPTURE_OVERRIDE_POC_DISABLE',
    ]);
    expect(captureCalls[1]?.payload).toMatchObject({ tabId: 7 });
    expect(status.configuredEnabled).toBe(true);
    expect(enabled.active).toBe(true);
    expect(disabled.active).toBe(false);
  });

  it('returns persisted override status diagnostics when live status times out', async () => {
    const originalOverrideConfigPath = process.env.OVERRIDE_POC_CONFIG_PATH;
    const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-v2-status-timeout-'));
    const db = new Database(':memory:');
    initializeDatabase(db);

    try {
      process.env.OVERRIDE_POC_CONFIG_PATH = writeReadyAssetOverrideConfig(tempRoot);
      seedReadyOverrideSession(db);

      const tools = createToolRegistry(
        createV2ToolHandlers(
          {
            execute: async (_sessionId, command) => {
              expect(command).toBe('CAPTURE_OVERRIDE_POC_GET_STATUS');
              throw new Error('Capture command timed out after 3000ms');
            },
          },
          () => db,
          () => ({ connected: true, connectedAt: 1200, lastHeartbeatAt: 1300 }),
        ),
      );

      const status = await routeToolCall(tools, 'get_override_status', { sessionId: 'session-live' });

      expect(status.statusSource).toBe('persisted-audit');
      expect(status.liveStatus).toMatchObject({
        available: false,
        code: 'OVERRIDE_LIVE_COMMAND_TIMEOUT',
        command: 'CAPTURE_OVERRIDE_POC_GET_STATUS',
        timeoutMs: 3000,
      });
      expect(status.latestRun).toBeNull();
      expect(status.preflight).toMatchObject({ ready: true });
      expect(status.nextActions).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'RECONNECT_OR_RETRY_OVERRIDE_STATUS' }),
      ]));
    } finally {
      if (originalOverrideConfigPath === undefined) {
        delete process.env.OVERRIDE_POC_CONFIG_PATH;
      } else {
        process.env.OVERRIDE_POC_CONFIG_PATH = originalOverrideConfigPath;
      }
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps live status timeout diagnostics when override config cannot be read', async () => {
    const originalOverrideConfigPath = process.env.OVERRIDE_POC_CONFIG_PATH;
    const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-v2-status-missing-config-'));
    const db = new Database(':memory:');
    initializeDatabase(db);

    try {
      process.env.OVERRIDE_POC_CONFIG_PATH = join(tempRoot, 'missing-override-poc.json');
      db.prepare(`
        INSERT INTO sessions (session_id, created_at, last_seen_at, safe_mode, tab_id, url_last)
        VALUES ('session-live', 1000, 1100, 0, 7, 'https://example.com/')
      `).run();

      const tools = createToolRegistry(
        createV2ToolHandlers(
          {
            execute: async (_sessionId, command) => {
              expect(command).toBe('CAPTURE_OVERRIDE_POC_GET_STATUS');
              throw new Error('Capture command timed out after 3000ms');
            },
          },
          () => db,
          () => ({ connected: true, connectedAt: 1200, lastHeartbeatAt: 1300 }),
        ),
      );

      const status = await routeToolCall(tools, 'get_override_status', { sessionId: 'session-live' });

      expect(status.statusSource).toBe('persisted-audit');
      expect(status.liveStatus).toMatchObject({
        code: 'OVERRIDE_LIVE_COMMAND_TIMEOUT',
        command: 'CAPTURE_OVERRIDE_POC_GET_STATUS',
      });
      expect(status.profile).toBeNull();
      expect(status.profileError).toContain('Unable to read override-poc config');
      expect(status.preflight).toMatchObject({
        ready: false,
        issues: [expect.objectContaining({ code: 'OVERRIDE_CONFIG_UNAVAILABLE' })],
      });
    } finally {
      if (originalOverrideConfigPath === undefined) {
        delete process.env.OVERRIDE_POC_CONFIG_PATH;
      } else {
        process.env.OVERRIDE_POC_CONFIG_PATH = originalOverrideConfigPath;
      }
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('reports a structured activation timeout when enable_overrides does not answer', async () => {
    const originalOverrideConfigPath = process.env.OVERRIDE_POC_CONFIG_PATH;
    const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-v2-enable-timeout-'));
    const db = new Database(':memory:');
    initializeDatabase(db);

    try {
      process.env.OVERRIDE_POC_CONFIG_PATH = writeReadyAssetOverrideConfig(tempRoot);
      seedReadyOverrideSession(db);

      const tools = createToolRegistry(
        createV2ToolHandlers(
          {
            execute: async (_sessionId, command) => {
              expect(command).toBe('CAPTURE_OVERRIDE_POC_ENABLE');
              throw new Error('Capture command timed out after 8000ms');
            },
          },
          () => db,
          () => ({ connected: true, connectedAt: 1200, lastHeartbeatAt: 1300 }),
        ),
      );

      await expect(routeToolCall(tools, 'enable_overrides', { sessionId: 'session-live', tabId: 7 }))
        .rejects.toThrow('OVERRIDE_LIVE_COMMAND_TIMEOUT: CAPTURE_OVERRIDE_POC_ENABLE for session session-live timed out after 8000ms');
    } finally {
      if (originalOverrideConfigPath === undefined) {
        delete process.env.OVERRIDE_POC_CONFIG_PATH;
      } else {
        process.env.OVERRIDE_POC_CONFIG_PATH = originalOverrideConfigPath;
      }
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('returns a concrete disable failure when disable_overrides times out', async () => {
    const originalOverrideConfigPath = process.env.OVERRIDE_POC_CONFIG_PATH;
    const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-v2-disable-timeout-'));
    const db = new Database(':memory:');
    initializeDatabase(db);

    try {
      const configPath = writeReadyAssetOverrideConfig(tempRoot);
      process.env.OVERRIDE_POC_CONFIG_PATH = configPath;
      seedReadyOverrideSession(db);
      db.prepare(`
        INSERT INTO override_runs (
          run_id, session_id, started_at, run_status, tab_id, selected_tab_id, target_asset_url, local_file_path,
          resolved_local_file_path, content_type, auto_reload, config_path, file_exists, file_size_bytes,
          matched_requests, fulfilled_requests, created_at, updated_at
        ) VALUES (
          'run-active', 'session-live', 1200, 'active', 7, 7, 'https://example.com/app.js', './app.local.js',
          ?, 'application/javascript; charset=utf-8', 1, ?, 1, 24,
          1, 1, 1200, 1300
        )
      `).run(join(tempRoot, 'app.local.js'), configPath);

      const tools = createToolRegistry(
        createV2ToolHandlers(
          {
            execute: async (_sessionId, command) => {
              expect(command).toBe('CAPTURE_OVERRIDE_POC_DISABLE');
              throw new Error('Capture command timed out after 5000ms');
            },
          },
          () => db,
          () => ({ connected: true, connectedAt: 1200, lastHeartbeatAt: 1300 }),
        ),
      );

      const disabled = await routeToolCall(tools, 'disable_overrides', { sessionId: 'session-live' });

      expect(disabled.disableAttempt).toMatchObject({
        ok: false,
        code: 'OVERRIDE_LIVE_COMMAND_TIMEOUT',
        command: 'CAPTURE_OVERRIDE_POC_DISABLE',
        timeoutMs: 5000,
      });
      expect(disabled.statusSource).toBe('persisted-audit');
      expect(disabled.latestRun).toMatchObject({ runId: 'run-active', runStatus: 'active' });
      expect(disabled.nextActions).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'RECONNECT_OR_RETRY_DISABLE' }),
      ]));
    } finally {
      if (originalOverrideConfigPath === undefined) {
        delete process.env.OVERRIDE_POC_CONFIG_PATH;
      } else {
        process.env.OVERRIDE_POC_CONFIG_PATH = originalOverrideConfigPath;
      }
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('reports a structured asset observation timeout', async () => {
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command) => {
          expect(command).toBe('CAPTURE_OVERRIDE_OBSERVE_ASSETS');
          throw new Error('Capture command timed out after 5000ms');
        },
      }),
    );

    await expect(routeToolCall(tools, 'observe_override_assets', { sessionId: 'session-live', tabId: 7 }))
      .rejects.toThrow('OVERRIDE_LIVE_COMMAND_TIMEOUT: CAPTURE_OVERRIDE_OBSERVE_ASSETS for session session-live timed out after 5000ms');
  });

  it('reports a structured response capture timeout', async () => {
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command) => {
          expect(command).toBe('CAPTURE_OVERRIDE_RESPONSE_BODY');
          throw new Error('Capture command timed out after 12000ms');
        },
      }),
    );

    await expect(routeToolCall(tools, 'capture_override_response_body', {
      sessionId: 'session-live',
      targetUrl: 'https://example.com/api/data',
      timeoutMs: 10_000,
    })).rejects.toThrow('OVERRIDE_LIVE_COMMAND_TIMEOUT: CAPTURE_OVERRIDE_RESPONSE_BODY for session session-live timed out after 12000ms');
  });

  it('auto-observes missing override assets before enabling through the live bridge', async () => {
    const originalOverrideConfigPath = process.env.OVERRIDE_POC_CONFIG_PATH;
    const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-v2-enable-auto-observe-'));
    const db = new Database(':memory:');
    initializeDatabase(db);
    const captureCalls: Array<{ sessionId: string; command: string; payload: Record<string, unknown> }> = [];

    try {
      const localAssetPath = join(tempRoot, 'app.local.js');
      writeFileSync(localAssetPath, 'console.log("override");', 'utf8');
      const configPath = join(tempRoot, 'override-poc.local.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          enabled: true,
          activeProfileId: 'asset-profile',
          profiles: [{
            profileId: 'asset-profile',
            name: 'Asset profile',
            enabled: true,
            autoReload: true,
            rules: [{
              ruleId: 'asset-rule',
              enabled: true,
              ruleType: 'asset',
              requestMethod: 'GET',
              matchMode: 'exact',
              targetAssetUrl: 'https://example.com/app.js',
              localFilePath: localAssetPath,
              contentType: 'application/javascript; charset=utf-8',
            }],
          }],
        }, null, 2),
        'utf8',
      );
      process.env.OVERRIDE_POC_CONFIG_PATH = configPath;

      db.prepare(`
        INSERT INTO sessions (session_id, created_at, last_seen_at, safe_mode, tab_id, url_last)
        VALUES ('session-live', 1000, 1100, 0, 7, 'https://example.com/')
      `).run();

      const tools = createToolRegistry(
        createV2ToolHandlers(
          {
            execute: async (sessionId, command, payload) => {
              captureCalls.push({ sessionId, command, payload });
              if (command === 'CAPTURE_OVERRIDE_OBSERVE_ASSETS') {
                return {
                  ok: true,
                  payload: {
                    sessionId,
                    tabId: payload.tabId,
                    pageUrl: 'https://example.com/',
                    assets: [{
                      url: 'https://example.com/app.js',
                      ruleType: 'asset',
                      requestMethod: 'GET',
                      kind: 'script',
                      fromPerformance: true,
                    }],
                  },
                };
              }
              return {
                ok: true,
                payload: {
                  active: true,
                  configuredEnabled: true,
                  tabId: payload.tabId,
                  matchedRequests: 0,
                  fulfilledRequests: 0,
                },
              };
            },
          },
          () => db,
          () => ({ connected: true, connectedAt: 1200, lastHeartbeatAt: 1300 }),
        ),
      );

      const enabled = await routeToolCall(tools, 'enable_overrides', { sessionId: 'session-live', tabId: 7 });

      expect(captureCalls.map((call) => call.command)).toEqual([
        'CAPTURE_OVERRIDE_OBSERVE_ASSETS',
        'CAPTURE_OVERRIDE_POC_ENABLE',
      ]);
      expect(enabled.active).toBe(true);
      expect(enabled.observedBeforeEnable).toMatchObject({ assetCount: 1, tabId: 7 });
      expect((enabled.preflight as { ready?: boolean }).ready).toBe(true);
    } finally {
      if (originalOverrideConfigPath === undefined) {
        delete process.env.OVERRIDE_POC_CONFIG_PATH;
      } else {
        process.env.OVERRIDE_POC_CONFIG_PATH = originalOverrideConfigPath;
      }
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('enables planner-captured RSC rules after observing capture readiness on the selected tab', async () => {
    const originalOverrideConfigPath = process.env.OVERRIDE_POC_CONFIG_PATH;
    const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-v2-enable-rsc-captured-'));
    const configPath = join(tempRoot, 'override-poc.local.json');
    const db = new Database(':memory:');
    initializeDatabase(db);
    const captureCalls: Array<{ sessionId: string; command: string; payload: Record<string, unknown> }> = [];

    try {
      process.env.OVERRIDE_POC_CONFIG_PATH = configPath;
      const planningTools = createToolRegistry(createV1ToolHandlers(() => db));
      await routeToolCall(planningTools, 'plan_override_response_patch', {
        targetUrl: 'https://example.com/products?_rsc=',
        matchMode: 'prefix',
        captureMode: 'cdp-response',
        contentType: 'text/x-component; charset=utf-8',
        responseBodyText: '1:["$","h1",null,{"children":"Original debugging kits"}]',
        requestHeaders: {
          RSC: '1',
        },
        textPatches: [{ search: 'Original debugging kits', replacement: 'Override debugging kits', expectedCount: 1 }],
        configPath,
        writeConfig: true,
        overwrite: true,
        profileId: 'captured-rsc-profile',
      });

      db.prepare(`
        INSERT INTO sessions (session_id, created_at, last_seen_at, safe_mode, tab_id, url_last)
        VALUES ('session-live', 1000, 1100, 0, 7, 'https://example.com/')
      `).run();

      const tools = createToolRegistry(
        createV2ToolHandlers(
          {
            execute: async (sessionId, command, payload) => {
              captureCalls.push({ sessionId, command, payload });
              if (command === 'CAPTURE_OVERRIDE_OBSERVE_ASSETS') {
                return {
                  ok: true,
                  payload: {
                    sessionId,
                    tabId: payload.tabId,
                    pageUrl: 'https://example.com/',
                    assets: [{
                      url: 'https://example.com/',
                      ruleType: 'document',
                      requestMethod: 'GET',
                      kind: 'document',
                      fromNavigation: true,
                    }],
                  },
                };
              }
              return {
                ok: true,
                payload: {
                  active: true,
                  configuredEnabled: true,
                  tabId: payload.tabId,
                  matchedRequests: 0,
                  fulfilledRequests: 0,
                },
              };
            },
          },
          () => db,
          () => ({ connected: true, connectedAt: 1200, lastHeartbeatAt: 1300 }),
        ),
      );

      const enabled = await routeToolCall(tools, 'enable_overrides', { sessionId: 'session-live', tabId: 7 });

      expect(captureCalls.map((call) => call.command)).toEqual([
        'CAPTURE_OVERRIDE_OBSERVE_ASSETS',
        'CAPTURE_OVERRIDE_POC_ENABLE',
      ]);
      expect(enabled.active).toBe(true);
      expect(enabled.observedBeforeEnable).toMatchObject({ assetCount: 1, tabId: 7 });
      expect(enabled.preflight).toMatchObject({
        ready: true,
        checks: {
          targetAssetObserved: false,
          targetAssetReadinessSatisfied: true,
          capturedTargetAssetCount: 1,
        },
      });
    } finally {
      if (originalOverrideConfigPath === undefined) {
        delete process.env.OVERRIDE_POC_CONFIG_PATH;
      } else {
        process.env.OVERRIDE_POC_CONFIG_PATH = originalOverrideConfigPath;
      }
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('does not enable overrides when readiness asset observation times out', async () => {
    const originalOverrideConfigPath = process.env.OVERRIDE_POC_CONFIG_PATH;
    const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-v2-enable-observe-timeout-'));
    const db = new Database(':memory:');
    initializeDatabase(db);
    const captureCalls: Array<{ sessionId: string; command: string; payload: Record<string, unknown> }> = [];

    try {
      const localAssetPath = join(tempRoot, 'app.local.js');
      writeFileSync(localAssetPath, 'console.log("override");', 'utf8');
      const configPath = join(tempRoot, 'override-poc.local.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          enabled: true,
          activeProfileId: 'asset-profile',
          profiles: [{
            profileId: 'asset-profile',
            name: 'Asset profile',
            enabled: true,
            autoReload: true,
            rules: [{
              ruleId: 'asset-rule',
              enabled: true,
              ruleType: 'asset',
              requestMethod: 'GET',
              matchMode: 'exact',
              targetAssetUrl: 'https://example.com/app.js',
              localFilePath: localAssetPath,
              contentType: 'application/javascript; charset=utf-8',
            }],
          }],
        }, null, 2),
        'utf8',
      );
      process.env.OVERRIDE_POC_CONFIG_PATH = configPath;

      db.prepare(`
        INSERT INTO sessions (session_id, created_at, last_seen_at, safe_mode, tab_id, url_last)
        VALUES ('session-live', 1000, 1100, 0, 7, 'https://example.com/')
      `).run();

      const tools = createToolRegistry(
        createV2ToolHandlers(
          {
            execute: async (sessionId, command, payload) => {
              captureCalls.push({ sessionId, command, payload });
              throw new Error('Capture command timed out after 5000ms');
            },
          },
          () => db,
          () => ({ connected: true, connectedAt: 1200, lastHeartbeatAt: 1300 }),
        ),
      );

      await expect(routeToolCall(tools, 'enable_overrides', { sessionId: 'session-live', tabId: 7 }))
        .rejects.toThrow('observed asset refresh failed');
      expect(captureCalls.map((call) => call.command)).toEqual(['CAPTURE_OVERRIDE_OBSERVE_ASSETS']);
    } finally {
      if (originalOverrideConfigPath === undefined) {
        delete process.env.OVERRIDE_POC_CONFIG_PATH;
      } else {
        process.env.OVERRIDE_POC_CONFIG_PATH = originalOverrideConfigPath;
      }
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects server-action response body capture requests before hitting the live bridge', async () => {
    const captureCalls: Array<{ sessionId: string; command: string; payload: Record<string, unknown> }> = [];
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (sessionId, command, payload) => {
          captureCalls.push({ sessionId, command, payload });
          return { ok: true, payload: {} };
        },
      }),
    );

    await expect(routeToolCall(tools, 'capture_override_response_body', {
      sessionId: 'session-live',
      targetUrl: 'https://example.com/server-actions',
      requestMethod: 'POST',
      requestHeaders: {
        'next-action': 'fixture-action',
        rsc: '1',
      },
    })).rejects.toThrow('SERVER_ACTION_UNSUPPORTED');
    expect(captureCalls).toEqual([]);
  });

  it('allows captured POST RSC response body capture requests without server-action headers', async () => {
    const captureCalls: Array<{ sessionId: string; command: string; payload: Record<string, unknown> }> = [];
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (sessionId, command, payload) => {
          captureCalls.push({ sessionId, command, payload });
          return {
            ok: true,
            payload: {
              targetUrl: 'https://example.com/products',
              requestMethod: 'POST',
              ruleType: 'rsc-flight',
              contentType: 'text/x-component; charset=utf-8',
              bodyCaptured: true,
            },
          };
        },
      }),
    );

    await routeToolCall(tools, 'capture_override_response_body', {
      sessionId: 'session-live',
      targetUrl: 'https://example.com/products',
      ruleType: 'rsc-flight',
      requestMethod: 'POST',
      requestHeaders: {
        rsc: '1',
      },
    });

    expect(captureCalls).toHaveLength(1);
    expect(captureCalls[0]).toMatchObject({
      sessionId: 'session-live',
      command: 'CAPTURE_OVERRIDE_RESPONSE_BODY',
      payload: {
        targetUrl: 'https://example.com/products',
        requestMethod: 'POST',
      },
    });
  });

  it('blocks enable_overrides when preflight finds production-safety errors', async () => {
    const originalOverrideConfigPath = process.env.OVERRIDE_POC_CONFIG_PATH;
    const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-v2-preflight-enable-'));
    const db = new Database(':memory:');
    initializeDatabase(db);
    const captureCalls: Array<{ sessionId: string; command: string; payload: Record<string, unknown> }> = [];

    try {
      const localResponsePath = join(tempRoot, 'mutation.json');
      writeFileSync(localResponsePath, '{"message":"override"}', 'utf8');
      const configPath = join(tempRoot, 'override-poc.local.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          enabled: true,
          activeProfileId: 'mutation-profile',
          profiles: [{
            profileId: 'mutation-profile',
            name: 'Mutation profile',
            enabled: true,
            autoReload: true,
            rules: [{
              ruleId: 'mutation-rule',
              enabled: true,
              ruleType: 'api-response',
              requestMethod: 'POST',
              matchMode: 'exact',
              targetAssetUrl: 'https://example.com/api/cart',
              localFilePath: localResponsePath,
              contentType: 'application/json; charset=utf-8',
            }],
          }],
        }, null, 2),
        'utf8',
      );
      process.env.OVERRIDE_POC_CONFIG_PATH = configPath;

      db.prepare(`
        INSERT INTO sessions (session_id, created_at, last_seen_at, safe_mode)
        VALUES ('session-live', 1000, 1100, 0)
      `).run();

      const tools = createToolRegistry(
        createV2ToolHandlers(
          {
            execute: async (sessionId, command, payload) => {
              captureCalls.push({ sessionId, command, payload });
              return { ok: true, payload: { active: true } };
            },
          },
          () => db,
          () => ({ connected: true, connectedAt: 1200, lastHeartbeatAt: 1300 }),
        ),
      );

      await expect(routeToolCall(tools, 'enable_overrides', { sessionId: 'session-live', tabId: 7 })).rejects.toThrow(
        'MUTATION_REPLAY_UNSUPPORTED',
      );
      expect(captureCalls).toEqual([]);
    } finally {
      if (originalOverrideConfigPath === undefined) {
        delete process.env.OVERRIDE_POC_CONFIG_PATH;
      } else {
        process.env.OVERRIDE_POC_CONFIG_PATH = originalOverrideConfigPath;
      }
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps manual experimental RSC rules invalid but allows the explicit lab-only enable path', async () => {
    const originalOverrideConfigPath = process.env.OVERRIDE_POC_CONFIG_PATH;
    const tempRoot = mkdtempSync(join(tmpdir(), 'mcp-v2-rsc-experimental-enable-'));
    const db = new Database(':memory:');
    initializeDatabase(db);
    const captureCalls: Array<{ sessionId: string; command: string; payload: Record<string, unknown> }> = [];

    try {
      const localResponsePath = join(tempRoot, 'products.rsc.txt');
      writeFileSync(localResponsePath, '1:["$","h1",null,{"children":"Override"}]', 'utf8');
      const configPath = join(tempRoot, 'override-poc.local.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          enabled: true,
          activeProfileId: 'experimental-rsc-profile',
          profiles: [{
            profileId: 'experimental-rsc-profile',
            name: 'Experimental RSC profile',
            enabled: true,
            autoReload: true,
            rules: [{
              ruleId: 'experimental-rsc-rule',
              enabled: true,
              ruleType: 'rsc-flight',
              requestMethod: 'GET',
              matchMode: 'prefix',
              allowExperimentalRscFlightFulfillment: true,
              targetAssetUrl: 'https://example.com/products?_rsc=',
              localFilePath: localResponsePath,
              contentType: 'text/x-component; charset=utf-8',
            }],
          }],
        }, null, 2),
        'utf8',
      );
      process.env.OVERRIDE_POC_CONFIG_PATH = configPath;

      db.prepare(`
        INSERT INTO sessions (session_id, created_at, last_seen_at, safe_mode)
        VALUES ('session-live', 1000, 1100, 0)
      `).run();

      const tools = createToolRegistry(
        createV2ToolHandlers(
          {
            execute: async (sessionId, command, payload) => {
              captureCalls.push({ sessionId, command, payload });
              return { ok: true, payload: { active: true, matchedRequests: 0, fulfilledRequests: 0 } };
            },
          },
          () => db,
          () => ({ connected: true, connectedAt: 1200, lastHeartbeatAt: 1300 }),
        ),
      );

      const preflight = await routeToolCall(tools, 'preflight_overrides', { sessionId: 'session-live' });
      expect(preflight.ready).toBe(false);
      expect(preflight.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'UNSUPPORTED_RSC_FLIGHT_RULE',
          severity: 'error',
        }),
      ]));

      const enabled = await routeToolCall(tools, 'enable_overrides', { sessionId: 'session-live', tabId: 7 });
      expect(enabled.active).toBe(true);
      expect(captureCalls).toEqual([
        {
          sessionId: 'session-live',
          command: 'CAPTURE_OVERRIDE_POC_ENABLE',
          payload: { tabId: 7 },
        },
      ]);
    } finally {
      if (originalOverrideConfigPath === undefined) {
        delete process.env.OVERRIDE_POC_CONFIG_PATH;
      } else {
        process.env.OVERRIDE_POC_CONFIG_PATH = originalOverrideConfigPath;
      }
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('routes bounded override response body capture through the live extension session', async () => {
    const captureCalls: Array<{ sessionId: string; command: string; payload: Record<string, unknown> }> = [];
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (sessionId, command, payload) => {
          captureCalls.push({ sessionId, command, payload });
          return {
            ok: true,
            payload: {
              targetUrl: payload.targetUrl,
              requestMethod: 'GET',
              statusCode: 200,
              contentType: 'text/html; charset=utf-8',
              ruleType: 'document',
              bodyCaptured: true,
              bodyBytes: 39,
              capturedBytes: 39,
              truncated: false,
              bodyPreview: '<h1>Original response</h1>',
            },
          };
        },
      }),
    );

    const captured = await routeToolCall(tools, 'capture_override_response_body', {
      sessionId: 'session-live',
      targetUrl: 'https://example.com/products',
      maxBodyBytes: 64_000,
    });

    expect(captureCalls).toHaveLength(1);
    expect(captureCalls[0]).toMatchObject({
      sessionId: 'session-live',
      command: 'CAPTURE_OVERRIDE_RESPONSE_BODY',
      payload: {
        targetUrl: 'https://example.com/products',
        includeBody: false,
        matchMode: undefined,
        maxBodyBytes: 64_000,
      },
    });
    expect(captured).toMatchObject({
      targetUrl: 'https://example.com/products',
      bodyCaptured: true,
      ruleType: 'document',
    });
  });

  it('captures a live response body before planning a response patch when no body is provided', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'mcp-response-patch-'));
    const configPath = join(fixtureRoot, 'override-poc.local.json');
    const captureCalls: Array<{ command: string; payload: Record<string, unknown> }> = [];
    try {
      const tools = createToolRegistry(
        createV2ToolHandlers({
          execute: async (_sessionId, command, payload) => {
            captureCalls.push({ command, payload });
            return {
              ok: true,
              payload: {
                targetUrl: payload.targetUrl,
                requestMethod: 'GET',
                statusCode: 200,
                contentType: 'text/html; charset=utf-8',
                ruleType: 'document',
                bodyCaptured: true,
                bodyBytes: 36,
                capturedBytes: 36,
                truncated: false,
                bodyText: '<h1>Original response</h1>',
              },
            };
          },
        }),
      );

      const plan = await routeToolCall(tools, 'plan_override_response_patch', {
        sessionId: 'session-live',
        targetUrl: 'https://example.com/products',
        textPatches: [{ search: 'Original response', replacement: 'Patched response' }],
        configPath,
        writeConfig: true,
        overwrite: false,
      });

      expect(captureCalls).toEqual([{
        command: 'CAPTURE_OVERRIDE_RESPONSE_BODY',
        payload: {
          targetUrl: 'https://example.com/products',
          tabId: undefined,
          captureMode: undefined,
          triggerReload: undefined,
          matchMode: undefined,
          requestMethod: undefined,
          requestHeaders: undefined,
          timeoutMs: 10_000,
          maxBodyBytes: undefined,
          includeBody: true,
        },
      }]);
      expect(plan.capturedFromLiveSession).toMatchObject({
        sessionId: 'session-live',
        targetUrl: 'https://example.com/products',
        requestMethod: 'GET',
        ruleType: 'document',
        variantContext: {
          pathname: '/products',
          requestMethod: 'GET',
          ruleType: 'document',
          searchParamKeys: [],
        },
      });
      expect(plan.variantContext).toMatchObject({
        pathname: '/products',
        requestMethod: 'GET',
        ruleType: 'document',
      });
      expect(plan.configWritten).toBe(true);
      expect(readFileSync(configPath, 'utf8')).toContain('https://example.com/products');
      expect(readFileSync((plan.rule as { localFilePath: string }).localFilePath, 'utf8')).toContain('Patched response');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('forwards CDP response capture controls for live response patch planning', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'mcp-response-patch-cdp-'));
    const configPath = join(fixtureRoot, 'override-poc.local.json');
    const captureCalls: Array<{
      sessionId: string;
      command: string;
      payload: Record<string, unknown>;
      timeoutMs?: number;
    }> = [];

    try {
      const tools = createToolRegistry(
        createV2ToolHandlers({
          execute: async (sessionId, command, payload, timeoutMs) => {
            captureCalls.push({ sessionId, command, payload, timeoutMs });
            return {
              ok: true,
              payload: {
                targetUrl: payload.targetUrl,
                requestMethod: 'GET',
                captureMode: payload.captureMode,
                matchMode: payload.matchMode,
                source: 'cdp-response',
                tabId: payload.tabId,
                triggerReload: payload.triggerReload,
                statusCode: 200,
                contentType: 'text/html; charset=utf-8',
                ruleType: 'document',
                bodyCaptured: true,
                bodyBytes: 36,
                capturedBytes: 36,
                truncated: false,
                bodyText: '<h1>Original response</h1>',
              },
            };
          },
        }),
      );

      const plan = await routeToolCall(tools, 'plan_override_response_patch', {
        sessionId: 'session-live',
        tabId: 42,
        targetUrl: 'https://example.com/products',
        captureMode: 'cdp-response',
        triggerReload: true,
        matchMode: 'prefix',
        timeoutMs: 12_000,
        textPatches: [{ search: 'Original response', replacement: 'CDP response' }],
        configPath,
        writeConfig: true,
        overwrite: false,
      });

      expect(captureCalls).toEqual([{
        sessionId: 'session-live',
        command: 'CAPTURE_OVERRIDE_RESPONSE_BODY',
        payload: {
          targetUrl: 'https://example.com/products',
          tabId: 42,
          captureMode: 'cdp-response',
          triggerReload: true,
          matchMode: 'prefix',
          requestMethod: undefined,
          requestHeaders: undefined,
          timeoutMs: 12_000,
          maxBodyBytes: undefined,
          includeBody: true,
        },
        timeoutMs: 14_000,
      }]);
      expect(plan.capturedFromLiveSession).toMatchObject({
        sessionId: 'session-live',
        targetUrl: 'https://example.com/products',
        requestMethod: 'GET',
        captureMode: 'cdp-response',
        matchMode: 'prefix',
        source: 'cdp-response',
        tabId: 42,
        triggerReload: true,
        variantContext: {
          pathname: '/products',
          requestMethod: 'GET',
          matchMode: 'prefix',
          captureMode: 'cdp-response',
          source: 'cdp-response',
        },
      });
      expect(plan.variantContext).toMatchObject({
        pathname: '/products',
        requestMethod: 'GET',
        matchMode: 'prefix',
        captureMode: 'cdp-response',
        source: 'cdp-response',
      });
      expect(readFileSync((plan.rule as { localFilePath: string }).localFilePath, 'utf8')).toContain('CDP response');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('routes observed Next.js asset mapping through the live extension session', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'mcp-next-map-'));
    try {
      const chunkDir = join(fixtureRoot, '.next', 'static', 'chunks', 'app');
      mkdirSync(chunkDir, { recursive: true });
      const chunkPath = join(chunkDir, 'page.js');
      writeFileSync(chunkPath, 'console.log("page");', 'utf8');
      writeFileSync(
        `${chunkPath}.map`,
        JSON.stringify({
          version: 3,
          sources: ['webpack://_N_E/./src/app/page.tsx'],
          mappings: '',
        }),
        'utf8',
      );

      const captureCalls: Array<{ sessionId: string; command: string; payload: Record<string, unknown> }> = [];
      const tools = createToolRegistry(
        createV2ToolHandlers({
          execute: async (sessionId, command, payload) => {
            captureCalls.push({ sessionId, command, payload });
            return {
              ok: true,
              payload: {
                sessionId,
                tabId: 7,
                pageUrl: 'https://www.example.com/',
                assets: [{
                  url: 'https://www.example.com/_next/static/chunks/app/page.js',
                  kind: 'script',
                  fromDom: true,
                }],
              },
            };
          },
        })
      );

      const observed = await routeToolCall(tools, 'observe_override_assets', { sessionId: 'session-live', tabId: 7 });
      const mapped = await routeToolCall(tools, 'map_next_override_assets', {
        sessionId: 'session-live',
        tabId: 7,
        projectRoot: fixtureRoot,
        sourcePaths: ['src/app/page.tsx'],
      });

      expect(captureCalls.map((call) => call.command)).toEqual([
        'CAPTURE_OVERRIDE_OBSERVE_ASSETS',
        'CAPTURE_OVERRIDE_OBSERVE_ASSETS',
      ]);
      expect((observed.assets as unknown[]).length).toBe(1);
      expect((mapped.candidates as Array<{ confidence: string; matchedSourcePaths: string[] }>)[0]).toMatchObject({
        confidence: 'high',
        matchedSourcePaths: ['src/app/page.tsx'],
      });
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('maps persisted observed assets when live capture input is not provided', async () => {
    const db = new Database(':memory:');
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'mcp-next-persisted-map-'));
    try {
      initializeDatabase(db);
      db.prepare(`
        INSERT INTO sessions (session_id, created_at, last_seen_at, safe_mode)
        VALUES ('session-persisted', 1000, 1000, 0)
      `).run();
      const chunkDir = join(fixtureRoot, '.next', 'static', 'chunks', 'app');
      mkdirSync(chunkDir, { recursive: true });
      const chunkPath = join(chunkDir, 'page.js');
      writeFileSync(chunkPath, 'console.log("page");', 'utf8');
      writeFileSync(
        `${chunkPath}.map`,
        JSON.stringify({
          version: 3,
          sources: ['webpack://_N_E/./src/app/page.tsx'],
          mappings: '',
        }),
        'utf8',
      );
      persistObservedOverrideAssets(db, {
        sessionId: 'session-persisted',
        assets: [{
          url: 'https://www.example.com/_next/static/chunks/app/page.js',
          kind: 'script',
          fromDom: true,
        }],
      });

      const tools = createToolRegistry(createV1ToolHandlers(() => db));
      const listed = await routeToolCall(tools, 'list_observed_override_assets', { sessionId: 'session-persisted' });
      const fullListed = await routeToolCall(tools, 'list_observed_override_assets', {
        sessionId: 'session-persisted',
        responseProfile: 'full',
      });
      const mapped = await routeToolCall(tools, 'map_next_override_assets', {
        sessionId: 'session-persisted',
        projectRoot: fixtureRoot,
        sourcePaths: ['src/app/page.tsx'],
      });

      expect((listed.assets as unknown[])).toHaveLength(1);
      expect(listed.responseProfile).toBe('compact');
      expect((listed.assets as Array<Record<string, unknown>>)[0]?.sessionId).toBeUndefined();
      expect(fullListed.responseProfile).toBe('full');
      expect((fullListed.assets as Array<Record<string, unknown>>)[0]).toMatchObject({ sessionId: 'session-persisted' });
      expect(mapped.observedFromPersisted).toMatchObject({ sessionId: 'session-persisted', assetCount: 1 });
      expect((mapped.candidates as Array<{ confidence: string; matchedSourcePaths: string[] }>)[0]).toMatchObject({
        confidence: 'high',
        matchedSourcePaths: ['src/app/page.tsx'],
      });
    } finally {
      db.close();
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

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

  it('captures compact page state through the v2 capture path', async () => {
    const captureCalls: Array<{ command: string; payload: Record<string, unknown> }> = [];
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command, payload) => {
          captureCalls.push({ command, payload });
          return {
            ok: true,
            payload: {
              url: 'http://localhost:8081/',
              title: 'Planner',
              language: 'it',
              viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
              summary: { buttons: 8, inputs: 5, modals: 1 },
              buttons: [{ text: 'Calcola target', selector: '#build' }],
              inputs: [{ label: 'Nome', selector: '#name', valueLength: 7 }],
              modals: [{ title: 'Piano del giorno', selector: '[role="dialog"]' }],
            },
            truncated: false,
          };
        },
      }),
    );

    const response = await routeToolCall(tools, 'get_page_state', {
      sessionId: 'session-v2',
      maxItems: 12,
      maxTextLength: 60,
    });

    expect(captureCalls[0]).toMatchObject({
      command: 'CAPTURE_PAGE_STATE',
      payload: {
        maxItems: 12,
        maxTextLength: 60,
        includeButtons: true,
        includeInputs: true,
        includeModals: true,
      },
    });
    expect(response.summary).toMatchObject({ buttons: 8, inputs: 5, modals: 1 });
    expect((response.buttons as Array<Record<string, unknown>>)[0]?.text).toBe('Calcola target');
  });

  it('returns compact interactive element refs through the v2 capture path', async () => {
    const captureCalls: Array<{ command: string; payload: Record<string, unknown> }> = [];
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command, payload) => {
          captureCalls.push({ command, payload });
          return {
            ok: true,
            payload: {
              url: 'http://localhost:8081/',
              title: 'Planner',
              language: 'it',
              viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
              summary: { buttons: 2, inputs: 1, modals: 1 },
              buttons: [{ text: 'Calcola target', selector: '#build', elementRef: 'ref:button' }],
              inputs: [{ label: 'Nome', selector: '#name', elementRef: 'ref:input' }],
              modals: [{ title: 'Piano del giorno', selector: '[role="dialog"]', elementRef: 'ref:modal' }],
              focused: { selector: '#name', elementRef: 'ref:focused', tagName: 'input' },
            },
            truncated: false,
          };
        },
      }),
    );

    const response = await routeToolCall(tools, 'get_interactive_elements', {
      sessionId: 'session-v2',
      kinds: ['buttons', 'focused'],
      maxItems: 10,
    });

    expect(captureCalls[0]).toMatchObject({
      command: 'CAPTURE_PAGE_STATE',
      payload: {
        includeButtons: true,
        includeInputs: false,
        includeModals: false,
      },
    });
    expect(response.kinds).toEqual(['buttons', 'focused']);
    expect((response.refs as Array<Record<string, unknown>>)[0]).toMatchObject({
      kind: 'buttons',
      elementRef: 'ref:button',
    });
  });

  it('resizes viewport through the v2 capture path', async () => {
    const captureCalls: Array<{ command: string; payload: Record<string, unknown> }> = [];
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command, payload) => {
          captureCalls.push({ command, payload });
          return {
            ok: true,
            payload: {
              requested: {
                width: payload.width,
                height: payload.height,
              },
              viewport: {
                width: 390,
                height: 844,
                scrollX: 0,
                scrollY: 0,
              },
            },
            truncated: false,
          };
        },
      }),
    );

    const response = await routeToolCall(tools, 'set_viewport', {
      sessionId: 'session-v2',
      width: 390,
      height: 844,
    });

    expect(captureCalls[0]).toMatchObject({
      command: 'SET_VIEWPORT',
      payload: {
        width: 390,
        height: 844,
      },
    });
    expect(response.requested).toEqual({ width: 390, height: 844 });
    expect(response.viewport).toMatchObject({ width: 390, height: 844 });
  });

  it('asserts structured page-state conditions through the v2 capture path', async () => {
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async () => {
          return {
            ok: true,
            payload: {
              url: 'http://localhost:8081/',
              title: 'Planner',
              language: 'it',
              viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
              summary: { buttons: 8, inputs: 5, modals: 0 },
              buttons: [
                { text: 'Calcola target', selector: '#build', disabled: false },
                { text: 'Settimana', selector: '#week', disabled: true },
              ],
            },
            truncated: false,
          };
        },
      }),
    );

    const response = await routeToolCall(tools, 'assert_page_state', {
      sessionId: 'session-v2',
      scope: 'buttons',
      textContains: 'Settimana',
      disabled: true,
    });

    expect(response.matched).toBe(true);
    expect(response.matchCount).toBe(1);
    expect((response.sampledMatches as Array<Record<string, unknown>>)[0]?.selector).toBe('#week');
  });

  it('waits for a structured page-state condition to become true', async () => {
    let attempt = 0;
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async () => {
          attempt += 1;
          return {
            ok: true,
            payload: {
              url: 'http://localhost:8081/',
              title: 'Planner',
              language: 'en',
              viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
              summary: { buttons: 2, inputs: 1, modals: attempt >= 2 ? 1 : 0 },
              modals:
                attempt >= 2
                  ? [{ title: 'Day plan', selector: '[role="dialog"]', buttonCount: 2, fieldCount: 0 }]
                  : [],
            },
            truncated: false,
          };
        },
      }),
    );

    const response = await routeToolCall(tools, 'wait_for_page_state', {
      sessionId: 'session-v2',
      scope: 'modals',
      titleContains: 'Day plan',
      timeoutMs: 500,
      pollIntervalMs: 10,
    });

    expect(response.matched).toBe(true);
    expect(response.attempts).toBeGreaterThanOrEqual(2);
    expect(response.waitedMs).toBeGreaterThanOrEqual(0);
  });

  it('preflights production-like automation flows with session, page, and risk diagnostics', async () => {
    const db = new Database(':memory:');
    initializeDatabase(db);
    const now = Date.now();
    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, last_seen_at, safe_mode, tab_id, url_start, url_last)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      'session-v2',
      now - 1000,
      now - 500,
      0,
      7,
      'https://app.example.com/account',
      'https://app.example.com/account',
    );

    const tools = createToolRegistry(
      createV2ToolHandlers(
        {
          execute: async (_sessionId, command) => {
            expect(command).toBe('CAPTURE_PAGE_STATE');
            return {
              ok: true,
              payload: {
                url: 'https://app.example.com/account',
                title: 'Account',
                language: 'en',
                viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
                summary: { buttons: 2, links: 1, inputs: 2, modals: 0, frames: 1 },
                inputs: [
                  {
                    label: 'Email address',
                    selector: '#email',
                    type: 'email',
                  },
                  {
                    label: 'Password',
                    selector: '#password',
                    type: 'password',
                  },
                ],
                frames: [
                  {
                    frameId: 22,
                    url: 'https://payments.example/frame',
                    title: 'Payment',
                    sameOrigin: false,
                    accessible: false,
                  },
                ],
              },
              truncated: false,
            };
          },
        },
        () => db,
        () => ({
          connected: true,
          connectedAt: now - 900,
          lastHeartbeatAt: now - 10,
        }),
      ),
    );

    const response = await routeToolCall(tools, 'preflight_automation_flow', {
      sessionId: 'session-v2',
      expectedUrlContains: '/account',
      plannedActions: ['click', 'input'],
      requireSensitiveAutomation: true,
    });

    expect(response.ready).toBe(true);
    expect(response.blockers).toEqual([]);
    expect((response.warnings as Array<Record<string, unknown>>).map((warning) => warning.code)).toEqual(
      expect.arrayContaining([
        'PRODUCTION_OR_REMOTE_ORIGIN',
        'SENSITIVE_FIELD_AUTOMATION_RISK',
        'CROSS_ORIGIN_FRAME_PRESENT',
      ]),
    );
    expect(response.checks).toMatchObject({
      sessionFound: true,
      liveConnected: true,
      expectedUrlMatched: true,
      pageStateCaptured: true,
      remoteOrProductionLike: true,
      sensitiveInputCount: 2,
      crossOriginFrameCount: 1,
    });
    expect(response.page).toMatchObject({
      url: 'https://app.example.com/account',
      title: 'Account',
    });
    db.close();
  });

  it('preflights disconnected or missing sessions as blockers before page capture', async () => {
    let captureAttempted = false;
    const db = new Database(':memory:');
    initializeDatabase(db);
    const tools = createToolRegistry(
      createV2ToolHandlers(
        {
          execute: async () => {
            captureAttempted = true;
            return { ok: true, payload: {}, truncated: false };
          },
        },
        () => db,
        () => undefined,
      ),
    );

    const response = await routeToolCall(tools, 'preflight_automation_flow', {
      sessionId: 'missing-session',
      expectedUrlContains: '/dashboard',
    });

    expect(response.ready).toBe(false);
    expect(captureAttempted).toBe(false);
    expect((response.blockers as Array<Record<string, unknown>>).map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining(['SESSION_NOT_FOUND', 'LIVE_SESSION_DISCONNECTED']),
    );
    expect(response.nextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'SESSION_NOT_FOUND' }),
        expect.objectContaining({ code: 'LIVE_SESSION_DISCONNECTED' }),
      ]),
    );
    db.close();
  });

  it('waits for URL predicates with exact, contains, or regex matching', async () => {
    let attempt = 0;
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command) => {
          expect(command).toBe('CAPTURE_PAGE_STATE');
          attempt += 1;
          return {
            ok: true,
            payload: {
              url: attempt >= 2 ? 'https://app.example.com/dashboard?tab=weekly' : 'https://app.example.com/loading',
              title: attempt >= 2 ? 'Dashboard' : 'Loading',
              language: 'en',
              viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
              summary: { buttons: 0, links: 0, inputs: 0, modals: 0 },
            },
            truncated: false,
          };
        },
      }),
    );

    const response = await routeToolCall(tools, 'wait_for_url', {
      sessionId: 'session-v2',
      urlContains: '/dashboard',
      urlRegex: 'tab=week',
      timeoutMs: 500,
      pollIntervalMs: 50,
    });

    expect(response.matched).toBe(true);
    expect(response.waitKind).toBe('url');
    expect(response.attempts).toBeGreaterThanOrEqual(2);
    expect(response.evidence).toMatchObject({
      page: {
        url: 'https://app.example.com/dashboard?tab=weekly',
      },
    });
  });

  it('waits for live document load state with optional URL predicates', async () => {
    let attempt = 0;
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command) => {
          expect(command).toBe('CAPTURE_PAGE_STATE');
          attempt += 1;
          return {
            ok: true,
            payload: {
              url: attempt >= 2 ? 'https://app.example.com/dashboard' : 'https://app.example.com/loading',
              title: attempt >= 2 ? 'Dashboard' : 'Loading',
              readyState: attempt >= 2 ? 'interactive' : 'loading',
              language: 'en',
              viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
              summary: { buttons: 0, links: 0, inputs: 0, modals: 0 },
            },
            truncated: false,
          };
        },
      }),
    );

    const response = await routeToolCall(tools, 'wait_for_load_state', {
      sessionId: 'session-v2',
      state: 'domcontentloaded',
      urlContains: '/dashboard',
      timeoutMs: 500,
      pollIntervalMs: 50,
    });

    expect(response.matched).toBe(true);
    expect(response.waitKind).toBe('load_state');
    expect(response.attempts).toBeGreaterThanOrEqual(2);
    expect(response.evidence).toMatchObject({
      state: 'domcontentloaded',
      page: {
        url: 'https://app.example.com/dashboard',
        readyState: 'interactive',
      },
    });
  });

  it('waits for persisted navigation events with URL, from-URL, trigger, and tab filters', async () => {
    const db = new Database(':memory:');
    initializeDatabase(db);
    const now = Date.now();
    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, last_seen_at, safe_mode, tab_id, url_start, url_last)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      'session-v2',
      now - 2000,
      now - 100,
      0,
      7,
      'https://app.example.com/cart',
      'https://app.example.com/checkout?step=shipping',
    );
    db.prepare(
      `
        INSERT INTO events (event_id, session_id, ts, type, payload_json, tab_id, origin)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      'evt-nav-checkout',
      'session-v2',
      now - 100,
      'nav',
      JSON.stringify({
        from: 'https://app.example.com/cart',
        to: 'https://app.example.com/checkout?step=shipping',
        trigger: 'pushState',
      }),
      7,
      'https://app.example.com',
    );
    const tools = createToolRegistry(
      createV2ToolHandlers(
        {
          execute: async () => {
            throw new Error('navigation waits should not call the live capture client');
          },
        },
        () => db,
      ),
    );

    const response = await routeToolCall(tools, 'wait_for_navigation', {
      sessionId: 'session-v2',
      urlContains: '/checkout',
      fromUrlContains: '/cart',
      trigger: 'pushState',
      tabId: 7,
      sinceTs: now - 1000,
      timeoutMs: 500,
      pollIntervalMs: 50,
    });

    expect(response.matched).toBe(true);
    expect(response.waitKind).toBe('navigation');
    expect(response.evidence).toMatchObject({
      navigation: {
        eventId: 'evt-nav-checkout',
        url: 'https://app.example.com/checkout?step=shipping',
        from: 'https://app.example.com/cart',
        trigger: 'pushState',
      },
    });
    db.close();
  });

  it('waits for selector state using live style and layout captures', async () => {
    let styleAttempt = 0;
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command, payload) => {
          expect(payload.selector).toBe('#ready');
          expect(payload.frameId).toBe(0);
          if (command === 'CAPTURE_COMPUTED_STYLES') {
            styleAttempt += 1;
            return {
              ok: true,
              payload: {
                selector: '#ready',
                properties: {
                  display: 'block',
                  visibility: styleAttempt >= 2 ? 'visible' : 'hidden',
                  opacity: '1',
                },
              },
              truncated: false,
            };
          }

          if (command === 'CAPTURE_LAYOUT_METRICS') {
            return {
              ok: true,
              payload: {
                selector: '#ready',
                viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
                element: { x: 10, y: 10, width: 120, height: 40, top: 10, right: 130, bottom: 50, left: 10 },
              },
              truncated: false,
            };
          }

          throw new Error(`Unexpected command ${command}`);
        },
      }),
    );

    const response = await routeToolCall(tools, 'wait_for_selector_state', {
      sessionId: 'session-v2',
      selector: '#ready',
      state: 'visible',
      timeoutMs: 500,
      pollIntervalMs: 50,
    });

    expect(response.matched).toBe(true);
    expect(response.waitKind).toBe('selector_state');
    expect(response.attempts).toBeGreaterThanOrEqual(2);
    expect(response.evidence).toMatchObject({
      selector: '#ready',
      state: 'visible',
      selectorState: {
        attached: true,
        visible: true,
      },
    });
  });

  it('waits for persisted request predicates with method, trace, and content-type filters', async () => {
    const db = new Database(':memory:');
    initializeDatabase(db);
    const now = Date.now();
    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, last_seen_at, safe_mode)
        VALUES (?, ?, ?, ?)
      `,
    ).run('session-v2', now - 2000, now - 100, 0);
    db.prepare(
      `
        INSERT INTO network (
          request_id, session_id, trace_id, tab_id, ts_start, duration_ms, method, url, origin,
          status, initiator, request_content_type, response_content_type
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      'req-checkout',
      'session-v2',
      'trace-checkout',
      7,
      now - 100,
      42,
      'POST',
      'https://app.example.com/api/checkout',
      'https://app.example.com',
      202,
      'fetch',
      'application/json',
      'application/json',
    );
    const tools = createToolRegistry(
      createV2ToolHandlers(
        {
          execute: async () => {
            throw new Error('request waits should not call the live capture client');
          },
        },
        () => db,
      ),
    );

    const response = await routeToolCall(tools, 'wait_for_request', {
      sessionId: 'session-v2',
      urlContains: '/api/checkout',
      method: 'post',
      traceId: 'trace-checkout',
      requestContentType: 'json',
      sinceTs: now - 1000,
      timeoutMs: 500,
      pollIntervalMs: 50,
    });

    expect(response.matched).toBe(true);
    expect(response.waitKind).toBe('request');
    expect(response.evidence).toMatchObject({
      call: {
        requestId: 'req-checkout',
        method: 'POST',
        url: 'https://app.example.com/api/checkout',
        request: {
          contentType: 'application/json',
        },
      },
    });
    db.close();
  });

  it('waits for persisted response predicates with status and content-type filters', async () => {
    const db = new Database(':memory:');
    initializeDatabase(db);
    const now = Date.now();
    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, last_seen_at, safe_mode)
        VALUES (?, ?, ?, ?)
      `,
    ).run('session-v2', now - 2000, now - 100, 0);
    db.prepare(
      `
        INSERT INTO network (
          request_id, session_id, tab_id, ts_start, duration_ms, method, url, origin,
          status, initiator, response_content_type
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      'req-checkout-created',
      'session-v2',
      7,
      now - 100,
      64,
      'POST',
      'https://app.example.com/api/checkout',
      'https://app.example.com',
      201,
      'fetch',
      'application/json; charset=utf-8',
    );
    const tools = createToolRegistry(
      createV2ToolHandlers(
        {
          execute: async () => {
            throw new Error('response waits should not call the live capture client');
          },
        },
        () => db,
      ),
    );

    const response = await routeToolCall(tools, 'wait_for_response', {
      sessionId: 'session-v2',
      urlRegex: '/api/check',
      method: 'POST',
      statusIn: [201],
      statusGte: 200,
      statusLt: 300,
      responseContentType: 'json',
      sinceTs: now - 1000,
      timeoutMs: 500,
      pollIntervalMs: 50,
    });

    expect(response.matched).toBe(true);
    expect(response.waitKind).toBe('response');
    expect(response.evidence).toMatchObject({
      call: {
        requestId: 'req-checkout-created',
        status: 201,
        response: {
          contentType: 'application/json; charset=utf-8',
        },
      },
    });
    db.close();
  });

  it('waits for matching live console messages', async () => {
    let attempt = 0;
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command, payload) => {
          expect(command).toBe('CAPTURE_GET_LIVE_CONSOLE_LOGS');
          expect(payload).toMatchObject({
            levels: ['error'],
            contains: 'checkout',
            includeRuntimeErrors: true,
          });
          attempt += 1;
          return {
            ok: true,
            payload: {
              logs:
                attempt >= 2
                  ? [
                      {
                        timestamp: Date.now(),
                        level: 'error',
                        message: 'checkout failed',
                        url: 'https://app.example.com/checkout',
                      },
                    ]
                  : [],
            },
            truncated: false,
          };
        },
      }),
    );

    const response = await routeToolCall(tools, 'wait_for_console', {
      sessionId: 'session-v2',
      levels: ['error'],
      contains: 'checkout',
      timeoutMs: 500,
      pollIntervalMs: 50,
    });

    expect(response.matched).toBe(true);
    expect(response.waitKind).toBe('console');
    expect(response.attempts).toBeGreaterThanOrEqual(2);
    expect(response.evidence).toMatchObject({
      logs: [expect.objectContaining({ level: 'error', message: 'checkout failed' })],
    });
  });

  it('waits for a bounded network quiet window from persisted network activity', async () => {
    const db = new Database(':memory:');
    initializeDatabase(db);
    const tools = createToolRegistry(
      createV2ToolHandlers(
        {
          execute: async () => {
            throw new Error('network quiet waits should not call the live capture client');
          },
        },
        () => db,
      ),
    );

    const response = await routeToolCall(tools, 'wait_for_network_quiet', {
      sessionId: 'session-v2',
      quietMs: 100,
      timeoutMs: 500,
      pollIntervalMs: 50,
      urlContains: '/api',
      method: 'GET',
    });

    expect(response.matched).toBe(true);
    expect(response.waitKind).toBe('network_quiet');
    expect(response.waitedMs).toBeGreaterThanOrEqual(100);
    expect(response.evidence).toMatchObject({
      quietMs: 100,
      filters: {
        urlContains: '/api',
        method: 'GET',
      },
      sampledCalls: [],
    });
    db.close();
  });

  it('runs generic workflow wait steps for response predicates', async () => {
    const db = new Database(':memory:');
    initializeDatabase(db);
    const now = Date.now();
    db.prepare(
      `
        INSERT INTO sessions (session_id, created_at, last_seen_at, safe_mode)
        VALUES (?, ?, ?, ?)
      `,
    ).run('session-v2', now - 2000, now - 100, 0);
    db.prepare(
      `
        INSERT INTO network (request_id, session_id, ts_start, duration_ms, method, url, status, initiator)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run('req-workflow-response', 'session-v2', now - 100, 30, 'GET', 'https://app.example.com/api/ready', 200, 'fetch');
    const tools = createToolRegistry(
      createV2ToolHandlers(
        {
          execute: async () => {
            throw new Error('workflow response waits should not call the live capture client');
          },
        },
        () => db,
      ),
    );

    const response = await routeToolCall(tools, 'run_ui_steps', {
      sessionId: 'session-v2',
      steps: [
        {
          kind: 'wait',
          id: 'wait-api-ready',
          wait: {
            waitKind: 'response',
            urlContains: '/api/ready',
            statusIn: [200],
            sinceTs: now - 1000,
            timeoutMs: 500,
            pollIntervalMs: 50,
          },
        },
      ],
    });

    expect(response.status).toBe('succeeded');
    expect((response.steps as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'wait-api-ready',
      kind: 'wait',
      status: 'succeeded',
      wait: {
        waitKind: 'response',
        matched: true,
      },
      target: {
        call: {
          requestId: 'req-workflow-response',
          status: 200,
        },
      },
    });
    db.close();
  });

  it('runs generic workflow wait steps for URL predicates', async () => {
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command) => {
          expect(command).toBe('CAPTURE_PAGE_STATE');
          return {
            ok: true,
            payload: {
              url: 'https://app.example.com/dashboard',
              title: 'Dashboard',
              language: 'en',
              viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
              summary: { buttons: 1, links: 0, inputs: 0, modals: 0 },
              buttons: [{ text: 'Refresh', selector: '#refresh', elementRef: 'ref:refresh' }],
            },
            truncated: false,
          };
        },
      }),
    );

    const response = await routeToolCall(tools, 'run_ui_steps', {
      sessionId: 'session-v2',
      steps: [
        {
          kind: 'wait',
          id: 'wait-dashboard-url',
          wait: {
            waitKind: 'url',
            urlContains: '/dashboard',
            timeoutMs: 250,
            pollIntervalMs: 50,
          },
        },
      ],
    });

    expect(response.status).toBe('succeeded');
    expect(response.completedStepCount).toBe(1);
    expect((response.steps as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'wait-dashboard-url',
      kind: 'wait',
      status: 'succeeded',
      wait: {
        waitKind: 'url',
        matched: true,
      },
    });
    expect(response.finalPage).toMatchObject({
      url: 'https://app.example.com/dashboard',
      title: 'Dashboard',
    });
  });

  it('runs generic workflow load-state wait steps', async () => {
    let attempt = 0;
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command) => {
          expect(command).toBe('CAPTURE_PAGE_STATE');
          attempt += 1;
          return {
            ok: true,
            payload: {
              url: 'https://app.example.com/dashboard',
              title: 'Dashboard',
              readyState: attempt >= 2 ? 'complete' : 'interactive',
              language: 'en',
              viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
              summary: { buttons: 0, links: 0, inputs: 0, modals: 0 },
              buttons: [],
              links: [],
              inputs: [],
              modals: [],
            },
            truncated: false,
          };
        },
      }),
    );

    const response = await routeToolCall(tools, 'run_ui_steps', {
      sessionId: 'session-v2',
      steps: [
        {
          kind: 'wait',
          id: 'wait-dashboard-load',
          wait: {
            waitKind: 'load_state',
            state: 'load',
            urlContains: '/dashboard',
            timeoutMs: 500,
            pollIntervalMs: 50,
          },
        },
      ],
    });

    expect(response.status).toBe('succeeded');
    expect((response.steps as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'wait-dashboard-load',
      kind: 'wait',
      status: 'succeeded',
      wait: {
        waitKind: 'load_state',
        matched: true,
      },
      target: {
        state: 'load',
        page: {
          readyState: 'complete',
        },
      },
    });
  });

  it('runs a generic safe UI workflow with action, wait, and assert steps', async () => {
    let pageStateAttempts = 0;
    const captureCalls: Array<{ command: string; payload: Record<string, unknown> }> = [];
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command, payload) => {
          captureCalls.push({ command, payload });
          if (command === 'CAPTURE_PAGE_STATE') {
            pageStateAttempts += 1;
            if (pageStateAttempts === 1) {
              return {
                ok: true,
                payload: {
                  url: 'http://localhost:3000/planner',
                  title: 'Planner',
                  language: 'en',
                  viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
                  summary: { buttons: 1, inputs: 0, modals: 0 },
                  buttons: [
                    {
                      text: 'Build targets',
                      selector: '#build-targets',
                      elementRef: 'ref:build-targets',
                      disabled: false,
                    },
                  ],
                },
                truncated: false,
              };
            }

            return {
              ok: true,
              payload: {
                url: 'http://localhost:3000/planner',
                title: 'Planner',
                language: 'en',
                viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
                summary: { buttons: 1, inputs: 0, modals: 0 },
                buttons: [
                  {
                    text: 'Generate 7-day plan',
                    selector: '#generate-week',
                    elementRef: 'ref:generate-week',
                    disabled: false,
                  },
                ],
              },
              truncated: false,
            };
          }

          if (command === 'EXECUTE_UI_ACTION') {
            expect(payload).toMatchObject({
              action: 'click',
              target: {
                elementRef: 'ref:build-targets',
              },
            });

            return {
              ok: true,
              payload: {
                action: 'click',
                traceId: 'trace-workflow-1',
                status: 'succeeded',
                executionScope: 'top-document-v1',
                startedAt: 1700000000000,
                finishedAt: 1700000000010,
                target: {
                  matched: true,
                  selector: '#build-targets',
                  resolvedSelector: '#build-targets',
                  tagName: 'button',
                  tabId: 7,
                  frameId: 0,
                  url: 'http://localhost:3000/planner',
                },
              },
              truncated: false,
            };
          }

          throw new Error(`Unexpected command ${command}`);
        },
      }),
    );

    const response = await routeToolCall(tools, 'run_ui_steps', {
      sessionId: 'session-v2',
      mode: 'safe',
      steps: [
        {
          kind: 'action',
          id: 'build',
          action: 'click',
          target: {
            scope: 'buttons',
            textContains: 'Build targets',
          },
        },
        {
          kind: 'waitFor',
          id: 'wait-week',
          matcher: {
            scope: 'buttons',
            textContains: 'Generate 7-day plan',
            timeoutMs: 500,
            pollIntervalMs: 50,
          },
        },
        {
          kind: 'assert',
          id: 'assert-week',
          matcher: {
            scope: 'buttons',
            textContains: 'Generate 7-day plan',
          },
        },
      ],
    });

    expect(response.status).toBe('succeeded');
    expect(response.completedStepCount).toBe(3);
    expect(response.failedStepId).toBeUndefined();
    expect((response.steps as Array<Record<string, unknown>>).map((step) => step.status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
    expect((response.finalPageSummary as Record<string, unknown>)?.buttons).toBe(1);
  });

  it('stops a generic safe workflow on the first failed step and marks the rest skipped', async () => {
    const captureCalls: Array<string> = [];
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command) => {
          captureCalls.push(command);
          if (command === 'EXECUTE_UI_ACTION') {
            return {
              ok: true,
              payload: {
                action: 'click',
                traceId: 'trace-workflow-fail-1',
                status: 'failed',
                executionScope: 'top-document-v1',
                startedAt: 1700000000000,
                finishedAt: 1700000000010,
                target: {
                  matched: false,
                  selector: '#missing',
                  frameId: 0,
                },
                failureReason: {
                  code: 'target_not_found',
                  message: 'No element matched the selector.',
                },
              },
              truncated: false,
            };
          }

          if (command === 'CAPTURE_PAGE_STATE') {
            return {
              ok: true,
              payload: {
                url: 'http://localhost:3000/planner',
                title: 'Planner',
                language: 'en',
                viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
                summary: { buttons: 0, inputs: 0, modals: 0 },
                buttons: [],
              },
              truncated: false,
            };
          }

          throw new Error(`Unexpected command ${command}`);
        },
      }),
    );

    const response = await routeToolCall(tools, 'run_ui_steps', {
      sessionId: 'session-v2',
      mode: 'safe',
      steps: [
        {
          kind: 'action',
          id: 'missing-click',
          action: 'click',
          target: {
            selector: '#missing',
          },
        },
        {
          kind: 'assert',
          id: 'never-runs',
          matcher: {
            scope: 'buttons',
            textContains: 'Done',
          },
        },
      ],
    });

    expect(captureCalls).toContain('EXECUTE_UI_ACTION');
    expect(response.status).toBe('failed');
    expect(response.failedStepId).toBe('missing-click');
    expect(response.stoppedEarly).toBe(true);
    expect((response.steps as Array<Record<string, unknown>>).map((step) => step.status)).toEqual([
      'failed',
      'skipped',
    ]);
  });

  it('resolves generic workflow action targets with richer semantic input matchers', async () => {
    const captureCalls: Array<{ command: string; payload: Record<string, unknown> }> = [];
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command, payload) => {
          captureCalls.push({ command, payload });
          if (command === 'CAPTURE_PAGE_STATE') {
            return {
              ok: true,
              payload: {
                url: 'http://localhost:3000/login',
                title: 'Login',
                language: 'en',
                viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
                summary: { buttons: 1, inputs: 2, modals: 0 },
                inputs: [
                  {
                    label: 'Email address',
                    selector: '#email',
                    elementRef: 'ref:email',
                    tagName: 'input',
                    type: 'text',
                    readOnly: false,
                  },
                  {
                    label: 'Password',
                    selector: '#password',
                    elementRef: 'ref:password',
                    tagName: 'input',
                    type: 'password',
                    readOnly: false,
                  },
                ],
              },
              truncated: false,
            };
          }

          if (command === 'EXECUTE_UI_ACTION') {
            expect(payload).toMatchObject({
              action: 'input',
              target: {
                elementRef: 'ref:email',
              },
              input: {
                value: 'person@example.com',
              },
            });

            return {
              ok: true,
              payload: {
                action: 'input',
                traceId: 'trace-workflow-input-1',
                status: 'succeeded',
                executionScope: 'top-document-v1',
                startedAt: 1700000000000,
                finishedAt: 1700000000010,
                target: {
                  matched: true,
                  selector: '#email',
                  resolvedSelector: '#email',
                  tagName: 'input',
                  tabId: 7,
                  frameId: 0,
                  url: 'http://localhost:3000/login',
                },
              },
              truncated: false,
            };
          }

          throw new Error(`Unexpected command ${command}`);
        },
      }),
    );

    const response = await routeToolCall(tools, 'run_ui_steps', {
      sessionId: 'session-v2',
      mode: 'safe',
      steps: [
        {
          kind: 'action',
          id: 'email-input',
          action: 'input',
          target: {
            scope: 'inputs',
            labelContains: 'Email',
            tagName: 'input',
            type: 'text',
            readOnly: false,
          },
          input: {
            value: 'person@example.com',
          },
        },
      ],
    });

    expect(response.status).toBe('succeeded');
    expect((response.steps as Array<Record<string, unknown>>)[0]?.target).toMatchObject({
      resolution: {
        strategy: 'semantic_elementRef',
        matchedCandidateCount: 1,
        matched: {
          selector: '#email',
          tagName: 'input',
          type: 'text',
        },
      },
    });
  });

  it('returns structured ambiguity diagnostics for generic workflow action targets', async () => {
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command) => {
          if (command === 'CAPTURE_PAGE_STATE') {
            return {
              ok: true,
              payload: {
                url: 'http://localhost:3000/planner',
                title: 'Planner',
                language: 'en',
                viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
                summary: { buttons: 2, inputs: 0, modals: 0 },
                buttons: [
                  {
                    text: 'Continue',
                    selector: '#primary-continue',
                    elementRef: 'ref:continue-1',
                    tagName: 'button',
                  },
                  {
                    text: 'Continue',
                    selector: '#secondary-continue',
                    elementRef: 'ref:continue-2',
                    tagName: 'button',
                  },
                ],
              },
              truncated: false,
            };
          }

          throw new Error(`Unexpected command ${command}`);
        },
      }),
    );

    const response = await routeToolCall(tools, 'run_ui_steps', {
      sessionId: 'session-v2',
      mode: 'safe',
      steps: [
        {
          kind: 'action',
          id: 'continue',
          action: 'click',
          target: {
            scope: 'buttons',
            textContains: 'Continue',
          },
        },
        {
          kind: 'assert',
          id: 'never-runs',
          matcher: {
            scope: 'buttons',
            textContains: 'Done',
          },
        },
      ],
    });

    expect(response.status).toBe('failed');
    expect(response.failedStepId).toBe('continue');
    expect((response.steps as Array<Record<string, unknown>>)[0]).toMatchObject({
      status: 'failed',
      target: {
        matcher: {
          scope: 'buttons',
          textContains: 'Continue',
        },
        matchedCandidateCount: 2,
      },
      error: {
        code: 'workflow_target_ambiguous',
      },
    });
  });

  it('reuses cached page state in fast mode and returns compact page change summaries', async () => {
    let captureCount = 0;
    const capturePayloads: Array<Record<string, unknown>> = [];
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command, payload) => {
          if (command === 'CAPTURE_PAGE_STATE') {
            captureCount += 1;
            capturePayloads.push(payload);
            if (captureCount === 1) {
              return {
                ok: true,
                payload: {
                  url: 'http://localhost:3000/planner',
                  title: 'Planner',
                  language: 'en',
                  viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
                  summary: { buttons: 1, inputs: 0, modals: 0 },
                  buttons: [
                    {
                      text: 'Build targets',
                      selector: '#build-targets',
                      elementRef: 'ref:build',
                      tagName: 'button',
                    },
                  ],
                },
                truncated: false,
              };
            }

            return {
              ok: true,
              payload: {
                url: 'http://localhost:3000/planner/week',
                title: 'Planner Week',
                language: 'en',
                viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
                summary: { buttons: 2, inputs: 0, modals: 0 },
                buttons: [
                  {
                    text: 'Generate 7-day plan',
                    selector: '#generate-week',
                    elementRef: 'ref:generate',
                    tagName: 'button',
                  },
                  {
                    text: 'Back',
                    selector: '#back',
                    elementRef: 'ref:back',
                    tagName: 'button',
                  },
                ],
              },
              truncated: false,
            };
          }

          if (command === 'EXECUTE_UI_ACTION') {
            expect(payload).toMatchObject({
              action: 'click',
              target: {
                elementRef: 'ref:build',
              },
            });

            return {
              ok: true,
              payload: {
                action: 'click',
                traceId: 'trace-workflow-fast-1',
                status: 'succeeded',
                executionScope: 'top-document-v1',
                startedAt: 1700000000000,
                finishedAt: 1700000000010,
                target: {
                  matched: true,
                  selector: '#build-targets',
                  resolvedSelector: '#build-targets',
                  tagName: 'button',
                  tabId: 7,
                  frameId: 0,
                  url: 'http://localhost:3000/planner',
                },
              },
              truncated: false,
            };
          }

          throw new Error(`Unexpected command ${command}`);
        },
      }),
    );

    const response = await routeToolCall(tools, 'run_ui_steps', {
      sessionId: 'session-v2',
      mode: 'fast',
      steps: [
        {
          kind: 'action',
          id: 'build',
          action: 'click',
          target: {
            scope: 'buttons',
            textContains: 'Build targets',
          },
        },
        {
          kind: 'assert',
          id: 'assert-week',
          matcher: {
            scope: 'buttons',
            textContains: 'Generate 7-day plan',
          },
        },
      ],
    });

    expect(response.status).toBe('succeeded');
    expect(captureCount).toBe(2);
    expect(capturePayloads).toEqual([
      expect.objectContaining({
        includeButtons: true,
        includeInputs: false,
        includeModals: false,
        maxItems: 100,
        maxTextLength: 120,
      }),
      expect.objectContaining({
        includeButtons: true,
        includeInputs: true,
        includeModals: true,
        maxItems: 12,
        maxTextLength: 60,
      }),
    ]);
    expect((response.steps as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'build',
      status: 'succeeded',
      pageChangeSummary: {
        changes: expect.arrayContaining([
          'buttons 0 -> 2',
          'inputs 0 -> 0',
          'modals 0 -> 0',
        ]),
      },
    });
    expect((response.steps as Array<Record<string, unknown>>)[1]).toMatchObject({
      id: 'assert-week',
      status: 'succeeded',
      pageChangeSummary: {
        changes: [],
      },
    });
  });

  it('continues after a failed workflow step when the step failure policy says continue', async () => {
    const commands: string[] = [];
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command, payload) => {
          commands.push(command);
          if (command === 'CAPTURE_PAGE_STATE') {
            return {
              ok: true,
              payload: {
                url: 'http://localhost:3000/planner',
                title: 'Planner',
                language: 'en',
                viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
                summary: { buttons: 1, inputs: 0, modals: 0 },
                buttons: [
                  {
                    text: 'Done',
                    selector: '#done',
                    elementRef: 'ref:done',
                    tagName: 'button',
                  },
                ],
              },
              truncated: false,
            };
          }

          if (command === 'EXECUTE_UI_ACTION') {
            return {
              ok: true,
              payload: {
                action: 'click',
                traceId: 'trace-workflow-continue-1',
                status: 'failed',
                executionScope: 'top-document-v1',
                startedAt: 1700000000000,
                finishedAt: 1700000000010,
                target: {
                  matched: false,
                  selector: '#missing',
                  frameId: 0,
                },
                failureReason: {
                  code: 'target_not_found',
                  message: 'No element matched the selector.',
                },
              },
              truncated: false,
            };
          }

          throw new Error(`Unexpected command ${command}`);
        },
      }),
    );

    const response = await routeToolCall(tools, 'run_ui_steps', {
      sessionId: 'session-v2',
      mode: 'safe',
      steps: [
        {
          kind: 'action',
          id: 'missing-click',
          action: 'click',
          target: {
            selector: '#missing',
          },
          onFailure: {
            strategy: 'continue',
          },
        },
        {
          kind: 'assert',
          id: 'done-visible',
          matcher: {
            scope: 'buttons',
            textContains: 'Done',
          },
        },
      ],
    });

    expect(response.status).toBe('failed');
    expect(response.failedStepId).toBe('missing-click');
    expect(response.stoppedEarly).toBe(false);
    expect((response.stepCounts as Record<string, unknown>)).toMatchObject({
      succeeded: 1,
      failed: 1,
      skipped: 0,
    });
    expect((response.steps as Array<Record<string, unknown>>).map((step) => step.status)).toEqual([
      'failed',
      'succeeded',
    ]);
    expect(commands).toContain('CAPTURE_PAGE_STATE');
  });

  it('retries one failed workflow step once and reports retry diagnostics', async () => {
    let actionAttempts = 0;
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command) => {
          if (command === 'CAPTURE_PAGE_STATE') {
            return {
              ok: true,
              payload: {
                url: 'http://localhost:3000/planner',
                title: 'Planner',
                language: 'en',
                viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
                summary: { buttons: 1, inputs: 0, modals: 0 },
                buttons: [
                  {
                    text: 'Build targets',
                    selector: '#build-targets',
                    elementRef: 'ref:build',
                    tagName: 'button',
                  },
                ],
              },
              truncated: false,
            };
          }

          if (command === 'EXECUTE_UI_ACTION') {
            actionAttempts += 1;
            if (actionAttempts === 1) {
              return {
                ok: true,
                payload: {
                  action: 'click',
                  traceId: 'trace-workflow-retry-1',
                  status: 'failed',
                  executionScope: 'top-document-v1',
                  startedAt: 1700000000000,
                  finishedAt: 1700000000010,
                  target: {
                    matched: true,
                    selector: '#build-targets',
                    frameId: 0,
                  },
                  failureReason: {
                    code: 'click_intercepted',
                    message: 'Overlay blocked the click.',
                  },
                },
                truncated: false,
              };
            }

            return {
              ok: true,
              payload: {
                action: 'click',
                traceId: 'trace-workflow-retry-2',
                status: 'succeeded',
                executionScope: 'top-document-v1',
                startedAt: 1700000000020,
                finishedAt: 1700000000030,
                target: {
                  matched: true,
                  selector: '#build-targets',
                  resolvedSelector: '#build-targets',
                  tagName: 'button',
                  tabId: 7,
                  frameId: 0,
                  url: 'http://localhost:3000/planner',
                },
              },
              truncated: false,
            };
          }

          throw new Error(`Unexpected command ${command}`);
        },
      }),
    );

    const response = await routeToolCall(tools, 'run_ui_steps', {
      sessionId: 'session-v2',
      mode: 'safe',
      steps: [
        {
          kind: 'action',
          id: 'build',
          action: 'click',
          target: {
            scope: 'buttons',
            textContains: 'Build targets',
          },
          onFailure: {
            strategy: 'retry_once',
          },
        },
      ],
    });

    expect(actionAttempts).toBe(2);
    expect(response.status).toBe('succeeded');
    expect(response.failedStepId).toBeUndefined();
    expect((response.workflowDiagnostics as Record<string, unknown>)).toMatchObject({
      retryCount: 1,
    });
    expect((response.steps as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'build',
      status: 'succeeded',
      executionAttempts: 2,
      failurePolicy: {
        strategy: 'retry_once',
        captureEnabled: false,
      },
    });
  });

  it('captures workflow failure evidence and exposes recovery guidance for failed steps', async () => {
    const commands: Array<{ command: string; payload: Record<string, unknown> }> = [];
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command, payload) => {
          commands.push({ command, payload });
          if (command === 'EXECUTE_UI_ACTION') {
            return {
              ok: true,
              payload: {
                action: 'click',
                traceId: 'trace-workflow-failure-evidence',
                status: 'failed',
                executionScope: 'top-document-v1',
                startedAt: 1700000000000,
                finishedAt: 1700000000010,
                target: {
                  matched: false,
                  selector: '#missing',
                  frameId: 0,
                },
                failureReason: {
                  code: 'target_not_found',
                  message: 'No element matched the selector.',
                },
              },
              truncated: false,
            };
          }

          if (command === 'CAPTURE_UI_SNAPSHOT') {
            return {
              ok: true,
              payload: {
                snapshotId: 'snap-workflow-1',
                mode: 'dom',
                dom: { root: { tagName: 'button' } },
              },
              truncated: false,
            };
          }

          if (command === 'CAPTURE_PAGE_STATE') {
            return {
              ok: true,
              payload: {
                url: 'http://localhost:3000/planner',
                title: 'Planner',
                language: 'en',
                viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
                summary: { buttons: 0, inputs: 0, modals: 0 },
                buttons: [],
              },
              truncated: false,
            };
          }

          throw new Error(`Unexpected command ${command}`);
        },
      }),
    );

    const response = await routeToolCall(tools, 'run_ui_steps', {
      sessionId: 'session-v2',
      mode: 'safe',
      steps: [
        {
          kind: 'action',
          id: 'missing-click',
          action: 'click',
          target: {
            selector: '#missing',
          },
          onFailure: {
            capture: {
              enabled: true,
              mode: 'dom',
            },
          },
        },
      ],
    });

    expect(response.status).toBe('failed');
    expect(response.recommendedAction).toBe('inspect_page_state');
    expect((response.workflowDiagnostics as Record<string, unknown>)).toMatchObject({
      failureCaptureCount: 1,
    });
    expect((response.steps as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'missing-click',
      status: 'failed',
      recommendedAction: 'inspect_page_state',
      failurePolicy: {
        strategy: 'stop',
        captureEnabled: true,
      },
      failureEvidence: {
        captured: true,
      },
    });
    expect(commands.some((entry) => entry.command === 'CAPTURE_UI_SNAPSHOT')).toBe(true);
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
      topDocumentOnly: false,
      opensNewBrowserSession: false,
    });
  });

  it('passes elementRef targets through the live ui action path', async () => {
    const captureCalls: Array<{ command: string; payload: Record<string, unknown> }> = [];
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command, payload) => {
          captureCalls.push({ command, payload });
          return {
            ok: true,
            payload: {
              action: 'click',
              traceId: 'trace-live-ref-1',
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
        elementRef: 'ref:button',
      },
    });

    expect(captureCalls[0]).toMatchObject({
      command: 'EXECUTE_UI_ACTION',
      payload: {
        action: 'click',
        target: {
          elementRef: 'ref:button',
        },
      },
    });
    expect(response.status).toBe('succeeded');
  });

  it('resolves semantic execute_ui_action targets through page-state refs', async () => {
    const captureCalls: Array<{ command: string; payload: Record<string, unknown> }> = [];
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command, payload) => {
          captureCalls.push({ command, payload });
          if (command === 'CAPTURE_PAGE_STATE') {
            return {
              ok: true,
              payload: {
                buttons: [
                  {
                    text: 'Confirm dialog',
                    selector: '#confirm-dialog',
                    elementRef: 'ref:confirm-dialog',
                    frameId: 12,
                    frameUrl: 'http://localhost:3000/frame',
                    tagName: 'button',
                  },
                ],
                summary: {
                  buttons: 1,
                  inputs: 0,
                  modals: 0,
                  frames: 2,
                },
              },
              truncated: false,
            };
          }

          return {
            ok: true,
            payload: {
              action: 'click',
              traceId: 'trace-live-semantic-1',
              status: 'succeeded',
              executionScope: 'top-document-v1',
              startedAt: 1700000000000,
              finishedAt: 1700000000020,
              target: {
                matched: true,
                selector: '#confirm-dialog',
                resolvedSelector: '#confirm-dialog',
                tagName: 'button',
                tabId: 9,
                frameId: 12,
                url: 'http://localhost:3000/frame',
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
        scope: 'buttons',
        textContains: 'Confirm dialog',
        tabId: 9,
      },
    });

    expect(captureCalls.map((call) => call.command)).toEqual(['CAPTURE_PAGE_STATE', 'EXECUTE_UI_ACTION']);
    expect(captureCalls[1]).toMatchObject({
      command: 'EXECUTE_UI_ACTION',
      payload: {
        action: 'click',
        target: {
          elementRef: 'ref:confirm-dialog',
          selector: '#confirm-dialog',
          frameId: 12,
          tabId: 9,
        },
      },
    });
    expect(response.status).toBe('succeeded');
    expect(response.targetResolution).toMatchObject({
      strategy: 'semantic_elementRef',
      matched: {
        selector: '#confirm-dialog',
        frameId: 12,
      },
    });
  });

  it('resolves semantic hover targets by role name and nth link candidate', async () => {
    const captureCalls: Array<{ command: string; payload: Record<string, unknown> }> = [];
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command, payload) => {
          captureCalls.push({ command, payload });
          if (command === 'CAPTURE_PAGE_STATE') {
            return {
              ok: true,
              payload: {
                links: [
                  {
                    text: 'Docs',
                    name: 'Docs',
                    role: 'link',
                    selector: '#docs-a',
                    elementRef: 'ref:docs-a',
                    frameId: 0,
                  },
                  {
                    text: 'Docs',
                    name: 'Docs',
                    role: 'link',
                    selector: '#docs-b',
                    elementRef: 'ref:docs-b',
                    frameId: 0,
                  },
                ],
                summary: {
                  buttons: 0,
                  links: 2,
                  inputs: 0,
                  modals: 0,
                },
              },
              truncated: false,
            };
          }

          return {
            ok: true,
            payload: {
              action: 'hover',
              traceId: 'trace-live-hover-1',
              status: 'succeeded',
              executionScope: 'top-document-v1',
              startedAt: 1700000000000,
              finishedAt: 1700000000020,
              target: {
                matched: true,
                selector: '#docs-b',
                resolvedSelector: '#docs-b',
                tagName: 'a',
                tabId: 9,
                frameId: 0,
                url: 'http://localhost:3000',
              },
            },
            truncated: false,
          };
        },
      }),
    );

    const response = await routeToolCall(tools, 'execute_ui_action', {
      sessionId: 'session-v2',
      action: 'hover',
      target: {
        scope: 'links',
        role: 'link',
        name: 'Docs',
        exact: true,
        nth: 1,
        tabId: 9,
      },
    });

    expect(captureCalls[0]).toMatchObject({
      command: 'CAPTURE_PAGE_STATE',
      payload: {
        includeButtons: false,
        includeLinks: true,
        includeInputs: false,
        includeModals: false,
      },
    });
    expect(captureCalls[1]).toMatchObject({
      command: 'EXECUTE_UI_ACTION',
      payload: {
        action: 'hover',
        target: {
          elementRef: 'ref:docs-b',
          selector: '#docs-b',
          tabId: 9,
        },
      },
    });
    expect(response.status).toBe('succeeded');
    expect(response.targetResolution).toMatchObject({
      strategy: 'semantic_elementRef',
      matchedCandidateCount: 2,
      selectedIndex: 1,
      matched: {
        selector: '#docs-b',
        role: 'link',
        name: 'Docs',
      },
    });
  });

  it('passes chained locator execute_ui_action targets to native extension resolution', async () => {
    const captureCalls: Array<{ command: string; payload: Record<string, unknown> }> = [];
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command, payload) => {
          captureCalls.push({ command, payload });
          return {
            ok: true,
            payload: {
              action: 'click',
              traceId: 'trace-live-locator-1',
              status: 'succeeded',
              executionScope: 'top-document-v1',
              startedAt: 1700000000000,
              finishedAt: 1700000000020,
              target: {
                matched: true,
                selector: '#save-account',
                resolvedSelector: '#save-account',
                tagName: 'button',
                tabId: 9,
                frameId: 22,
                url: 'http://localhost:3000/account-frame',
              },
              result: {
                backend: 'cdp-native-v2',
                locatorResolution: {
                  strategy: 'native_locator',
                  matchedCandidateCount: 1,
                  selectionStrategy: 'strict-single',
                  matched: {
                    selector: '#save-account',
                    frameTitle: 'Account iframe',
                  },
                },
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
        tabId: 9,
        locator: {
          scope: 'buttons',
          frame: {
            titleContains: 'Account',
          },
          steps: [
            {
              kind: 'role',
              role: 'button',
              name: {
                pattern: '^save',
                flags: 'i',
              },
            },
            {
              kind: 'text',
              value: 'Save changes',
              exact: true,
              relation: 'descendant',
            },
          ],
        },
      },
    });

    expect(captureCalls).toHaveLength(1);
    expect(captureCalls[0]).toMatchObject({
      command: 'EXECUTE_UI_ACTION',
      payload: {
        action: 'click',
        target: {
          tabId: 9,
          locator: {
            scope: 'buttons',
            frame: {
              titleContains: 'Account',
            },
            steps: expect.arrayContaining([
              expect.objectContaining({
                kind: 'text',
                relation: 'descendant',
              }),
            ]),
          },
        },
      },
    });
    expect(response.status).toBe('succeeded');
    expect(response.targetResolution).toMatchObject({
      strategy: 'native_locator',
      matchedCandidateCount: 1,
      matched: {
        selector: '#save-account',
        frameTitle: 'Account iframe',
      },
    });
  });

  it('resolves semantic targets with first/last/strict and frame metadata filters', async () => {
    const captureCalls: Array<{ command: string; payload: Record<string, unknown> }> = [];
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command, payload) => {
          captureCalls.push({ command, payload });
          if (command === 'CAPTURE_PAGE_STATE') {
            return {
              ok: true,
              payload: {
                buttons: [
                  {
                    text: 'Continue',
                    selector: '#top-continue',
                    elementRef: 'ref:top-continue',
                    frameId: 0,
                    frameUrl: 'http://localhost:3000/top',
                    frameTitle: 'Top',
                  },
                  {
                    text: 'Continue',
                    selector: '#frame-continue',
                    elementRef: 'ref:frame-continue',
                    frameId: 15,
                    frameUrl: 'http://localhost:3000/account-frame',
                    frameTitle: 'Account iframe',
                  },
                ],
                summary: {
                  buttons: 2,
                  links: 0,
                  inputs: 0,
                  modals: 0,
                  frames: 2,
                },
              },
              truncated: false,
            };
          }

          return {
            ok: true,
            payload: {
              action: 'click',
              traceId: 'trace-live-frame-filter',
              status: 'succeeded',
              executionScope: 'top-document-v1',
              startedAt: 1700000000000,
              finishedAt: 1700000000020,
              target: {
                matched: true,
                selector: '#frame-continue',
                resolvedSelector: '#frame-continue',
                tagName: 'button',
                tabId: 9,
                frameId: 15,
                url: 'http://localhost:3000/account-frame',
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
        scope: 'buttons',
        textContains: 'Continue',
        frameTitleContains: 'Account',
        first: true,
        strict: false,
        tabId: 9,
      },
    });

    expect(captureCalls[1]).toMatchObject({
      command: 'EXECUTE_UI_ACTION',
      payload: {
        target: {
          elementRef: 'ref:frame-continue',
          selector: '#frame-continue',
          frameId: 15,
          tabId: 9,
        },
      },
    });
    expect(response.status).toBe('succeeded');
    expect(response.targetResolution).toMatchObject({
      matchedCandidateCount: 1,
      selectedIndex: 0,
      selectionStrategy: 'first',
      matched: {
        frameTitle: 'Account iframe',
        frameId: 15,
      },
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

  it('waits for structured page state after a successful live ui action', async () => {
    let pageStateAttempts = 0;
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command) => {
          if (command === 'EXECUTE_UI_ACTION') {
            return {
              ok: true,
              payload: {
                action: 'click',
                traceId: 'trace-live-3',
                status: 'succeeded',
                executionScope: 'top-document-v1',
                startedAt: 1700000001000,
                finishedAt: 1700000001010,
                target: {
                  matched: true,
                  selector: '#open-day',
                  resolvedSelector: '#open-day',
                  tagName: 'button',
                  tabId: 7,
                  frameId: 0,
                  url: 'http://localhost:3000/planner',
                },
              },
              truncated: false,
            };
          }

          if (command === 'CAPTURE_PAGE_STATE') {
            pageStateAttempts += 1;
            return {
              ok: true,
              payload: {
                url: 'http://localhost:3000/planner',
                title: 'Planner',
                language: 'en',
                viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
                summary: { buttons: 5, inputs: 2, modals: pageStateAttempts >= 2 ? 1 : 0 },
                modals:
                  pageStateAttempts >= 2
                    ? [{ title: 'Day plan', selector: '[role="dialog"]', buttonCount: 2, fieldCount: 0 }]
                    : [],
              },
              truncated: false,
            };
          }

          throw new Error(`Unexpected command ${command}`);
        },
      }),
    );

    const response = await routeToolCall(tools, 'execute_ui_action', {
      sessionId: 'session-v2',
      action: 'click',
      target: {
        selector: '#open-day',
      },
      waitForPageState: {
        scope: 'modals',
        titleContains: 'Day plan',
        timeoutMs: 500,
        pollIntervalMs: 10,
      },
    });

    expect(response.status).toBe('succeeded');
    expect(response.postActionState).toMatchObject({
      matched: true,
      matchCount: 1,
    });
    expect((response.postActionState as Record<string, unknown>).attempts).toBeGreaterThanOrEqual(2);
  });

  it('does not run post-action page-state wait when the live ui action fails', async () => {
    const captureCalls: Array<string> = [];
    const tools = createToolRegistry(
      createV2ToolHandlers({
        execute: async (_sessionId, command) => {
          captureCalls.push(command);
          return {
            ok: true,
            payload: {
              action: 'click',
              traceId: 'trace-live-4',
              status: 'failed',
              executionScope: 'top-document-v1',
              startedAt: 1700000001000,
              finishedAt: 1700000001010,
              target: {
                matched: false,
                selector: '#missing',
                frameId: 0,
              },
              failureReason: {
                code: 'target_not_found',
                message: 'No element matched the selector.',
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
        selector: '#missing',
      },
      waitForPageState: {
        scope: 'modals',
        titleContains: 'Day plan',
        timeoutMs: 500,
      },
    });

    expect(captureCalls).toEqual(['EXECUTE_UI_ACTION']);
    expect(response.status).toBe('failed');
    expect(response.postActionState).toBeUndefined();
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
