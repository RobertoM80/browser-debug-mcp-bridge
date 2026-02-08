import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
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
});
