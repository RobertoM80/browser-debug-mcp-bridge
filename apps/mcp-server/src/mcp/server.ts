import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Database } from 'better-sqlite3';
import { getConnection } from '../db/connection';

type ToolInput = Record<string, unknown>;

interface RedactionSummary {
  totalFields: number;
  redactedFields: number;
  rulesApplied: string[];
}

interface BaseToolResponse {
  sessionId?: string;
  limitsApplied: {
    maxResults: number;
    truncated: boolean;
  };
  redactionSummary: RedactionSummary;
}

type ToolResponse = BaseToolResponse & Record<string, unknown>;

export type ToolHandler = (input: ToolInput) => Promise<ToolResponse>;

export interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: object;
  handler: ToolHandler;
}

export interface MCPServerRuntime {
  server: Server;
  transport: StdioServerTransport;
  tools: RegisteredTool[];
  start: () => Promise<void>;
}

const TOOL_SCHEMAS: Record<string, object> = {
  list_sessions: {
    type: 'object',
    properties: {
      sinceMinutes: { type: 'number' },
    },
  },
  get_session_summary: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
    },
  },
  get_recent_events: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      eventTypes: { type: 'array', items: { type: 'string' } },
      limit: { type: 'number' },
    },
  },
  get_navigation_history: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
    },
  },
  get_console_events: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      level: { type: 'string' },
    },
  },
  get_error_fingerprints: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      sinceMinutes: { type: 'number' },
    },
  },
  get_network_failures: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      errorType: { type: 'string' },
      groupBy: { type: 'string' },
    },
  },
  get_element_refs: {
    type: 'object',
    required: ['sessionId', 'selector'],
    properties: {
      sessionId: { type: 'string' },
      selector: { type: 'string' },
    },
  },
  get_dom_subtree: {
    type: 'object',
    required: ['sessionId', 'selector'],
    properties: {
      sessionId: { type: 'string' },
      selector: { type: 'string' },
      maxDepth: { type: 'number' },
      maxBytes: { type: 'number' },
    },
  },
  get_dom_document: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      mode: { type: 'string' },
    },
  },
  get_computed_styles: {
    type: 'object',
    required: ['sessionId', 'selector'],
    properties: {
      sessionId: { type: 'string' },
      selector: { type: 'string' },
      properties: { type: 'array', items: { type: 'string' } },
    },
  },
  get_layout_metrics: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      selector: { type: 'string' },
    },
  },
  explain_last_failure: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      lookbackSeconds: { type: 'number' },
    },
  },
  get_event_correlation: {
    type: 'object',
    required: ['sessionId', 'eventId'],
    properties: {
      sessionId: { type: 'string' },
      eventId: { type: 'string' },
      windowSeconds: { type: 'number' },
    },
  },
};

const TOOL_DESCRIPTIONS: Record<string, string> = {
  list_sessions: 'List captured debugging sessions',
  get_session_summary: 'Get summary counters for one session',
  get_recent_events: 'Read recent events from a session',
  get_navigation_history: 'Read navigation events for a session',
  get_console_events: 'Read console events for a session',
  get_error_fingerprints: 'List aggregated error fingerprints',
  get_network_failures: 'List network failures and groupings',
  get_element_refs: 'Get element references by selector',
  get_dom_subtree: 'Capture a bounded DOM subtree',
  get_dom_document: 'Capture full document as outline or html',
  get_computed_styles: 'Read computed CSS styles for an element',
  get_layout_metrics: 'Read viewport and element layout metrics',
  explain_last_failure: 'Explain the latest failure timeline',
  get_event_correlation: 'Correlate related events by window',
};

const ALL_TOOLS = Object.keys(TOOL_SCHEMAS);

const DEFAULT_REDACTION_SUMMARY: RedactionSummary = {
  totalFields: 0,
  redactedFields: 0,
  rulesApplied: [],
};

const DEFAULT_LIST_LIMIT = 25;
const DEFAULT_EVENT_LIMIT = 50;
const MAX_LIMIT = 200;

interface SessionRow {
  session_id: string;
  created_at: number;
  ended_at: number | null;
  tab_id: number | null;
  window_id: number | null;
  url_start: string | null;
  url_last: string | null;
  user_agent: string | null;
  viewport_w: number | null;
  viewport_h: number | null;
  dpr: number | null;
  safe_mode: number;
}

interface EventRow {
  event_id: string;
  session_id: string;
  ts: number;
  type: string;
  payload_json: string;
}

function resolveLimit(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const floored = Math.floor(value);
  if (floored < 1) {
    return fallback;
  }

  return Math.min(floored, MAX_LIMIT);
}

function readJsonPayload(payloadJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed payloads and return an empty object
  }

  return {};
}

function mapRequestedEventType(type: string): string {
  switch (type) {
    case 'navigation':
      return 'nav';
    case 'click':
    case 'custom':
      return 'ui';
    default:
      return type;
  }
}

function parseRequestedTypes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = value
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    .map((entry) => mapRequestedEventType(entry));

  return Array.from(new Set(normalized));
}

function resolveLastUrl(payload: Record<string, unknown>): string | undefined {
  const candidates = [payload.url, payload.to, payload.href, payload.location];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }

  return undefined;
}

function mapEventRecord(row: EventRow): Record<string, unknown> {
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    timestamp: row.ts,
    type: row.type,
    payload: readJsonPayload(row.payload_json),
  };
}

export function createV1ToolHandlers(getDb: () => Database): Partial<Record<string, ToolHandler>> {
  return {
    list_sessions: async (input) => {
      const db = getDb();
      const sinceMinutes = typeof input.sinceMinutes === 'number' ? input.sinceMinutes : undefined;
      const limit = resolveLimit(input.limit, DEFAULT_LIST_LIMIT);

      const where: string[] = [];
      const params: unknown[] = [];

      if (sinceMinutes !== undefined && Number.isFinite(sinceMinutes) && sinceMinutes > 0) {
        where.push('created_at >= ?');
        params.push(Date.now() - Math.floor(sinceMinutes * 60_000));
      }

      const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      const sql = `
        SELECT
          session_id,
          created_at,
          ended_at,
          tab_id,
          window_id,
          url_start,
          url_last,
          user_agent,
          viewport_w,
          viewport_h,
          dpr,
          safe_mode
        FROM sessions
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT ?
      `;

      const rows = db.prepare(sql).all(...params, limit + 1) as SessionRow[];
      const truncated = rows.length > limit;
      const sessions = rows.slice(0, limit).map((row) => ({
        sessionId: row.session_id,
        createdAt: row.created_at,
        endedAt: row.ended_at ?? undefined,
        tabId: row.tab_id ?? undefined,
        windowId: row.window_id ?? undefined,
        urlStart: row.url_start ?? undefined,
        urlLast: row.url_last ?? undefined,
        userAgent: row.user_agent ?? undefined,
        viewport:
          row.viewport_w !== null && row.viewport_h !== null
            ? {
                width: row.viewport_w,
                height: row.viewport_h,
              }
            : undefined,
        dpr: row.dpr ?? undefined,
        safeMode: row.safe_mode === 1,
      }));

      return {
        ...createBaseResponse(),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        sessions,
      };
    },

    get_session_summary: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const session = db
        .prepare('SELECT session_id, created_at, ended_at, url_last FROM sessions WHERE session_id = ?')
        .get(sessionId) as
        | {
            session_id: string;
            created_at: number;
            ended_at: number | null;
            url_last: string | null;
          }
        | undefined;

      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const counters = db
        .prepare(`
        SELECT
          SUM(CASE WHEN type = 'error' THEN 1 ELSE 0 END) AS errors,
          SUM(CASE WHEN type = 'console' AND json_extract(payload_json, '$.level') = 'warn' THEN 1 ELSE 0 END) AS warnings
        FROM events
        WHERE session_id = ?
      `)
        .get(sessionId) as { errors: number | null; warnings: number | null };

      const networkFails = db
        .prepare(`
        SELECT COUNT(*) AS count
        FROM network
        WHERE session_id = ?
          AND (error_class IS NOT NULL OR COALESCE(status, 0) >= 400)
      `)
        .get(sessionId) as { count: number };

      const latestNav = db
        .prepare(`
        SELECT payload_json
        FROM events
        WHERE session_id = ? AND type = 'nav'
        ORDER BY ts DESC
        LIMIT 1
      `)
        .get(sessionId) as { payload_json: string } | undefined;

      const eventRange = db
        .prepare(`
        SELECT MIN(ts) AS start_ts, MAX(ts) AS end_ts
        FROM events
        WHERE session_id = ?
      `)
        .get(sessionId) as { start_ts: number | null; end_ts: number | null };

      const navPayload = latestNav ? readJsonPayload(latestNav.payload_json) : {};
      const lastUrl = resolveLastUrl(navPayload) ?? session.url_last ?? undefined;

      return {
        ...createBaseResponse(sessionId),
        counts: {
          errors: counters.errors ?? 0,
          warnings: counters.warnings ?? 0,
          networkFails: networkFails.count,
        },
        lastUrl,
        timeRange: {
          start: eventRange.start_ts ?? session.created_at,
          end: eventRange.end_ts ?? session.ended_at ?? session.created_at,
        },
      };
    },

    get_recent_events: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const limit = resolveLimit(input.limit, DEFAULT_EVENT_LIMIT);
      const requestedTypes = parseRequestedTypes(input.types ?? input.eventTypes);

      const params: unknown[] = [sessionId];
      const where: string[] = ['session_id = ?'];
      if (requestedTypes.length > 0) {
        const placeholders = requestedTypes.map(() => '?').join(', ');
        where.push(`type IN (${placeholders})`);
        params.push(...requestedTypes);
      }

      const rows = db
        .prepare(`
        SELECT event_id, session_id, ts, type, payload_json
        FROM events
        WHERE ${where.join(' AND ')}
        ORDER BY ts DESC
        LIMIT ?
      `)
        .all(...params, limit + 1) as EventRow[];

      const truncated = rows.length > limit;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        events: rows.slice(0, limit).map((row) => mapEventRecord(row)),
      };
    },

    get_navigation_history: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const limit = resolveLimit(input.limit, DEFAULT_EVENT_LIMIT);
      const rows = db
        .prepare(`
        SELECT event_id, session_id, ts, type, payload_json
        FROM events
        WHERE session_id = ? AND type = 'nav'
        ORDER BY ts DESC
        LIMIT ?
      `)
        .all(sessionId, limit + 1) as EventRow[];

      const truncated = rows.length > limit;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        events: rows.slice(0, limit).map((row) => mapEventRecord(row)),
      };
    },

    get_console_events: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const level = typeof input.level === 'string' ? input.level : undefined;
      const limit = resolveLimit(input.limit, DEFAULT_EVENT_LIMIT);
      const params: unknown[] = [sessionId];
      let levelClause = '';

      if (level) {
        levelClause = "AND json_extract(payload_json, '$.level') = ?";
        params.push(level);
      }

      const rows = db
        .prepare(`
        SELECT event_id, session_id, ts, type, payload_json
        FROM events
        WHERE session_id = ? AND type = 'console' ${levelClause}
        ORDER BY ts DESC
        LIMIT ?
      `)
        .all(...params, limit + 1) as EventRow[];

      const truncated = rows.length > limit;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        events: rows.slice(0, limit).map((row) => mapEventRecord(row)),
      };
    },
  };
}

function isRecord(value: unknown): value is ToolInput {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getSessionId(input: ToolInput): string | undefined {
  return typeof input.sessionId === 'string' ? input.sessionId : undefined;
}

function createBaseResponse(sessionId?: string): BaseToolResponse {
  return {
    sessionId,
    limitsApplied: {
      maxResults: 0,
      truncated: false,
    },
    redactionSummary: DEFAULT_REDACTION_SUMMARY,
  };
}

function createDefaultHandler(toolName: string): ToolHandler {
  return async (input) => {
    return {
      ...createBaseResponse(getSessionId(input)),
      tool: toolName,
      status: 'not_implemented',
    };
  };
}

export function createToolRegistry(overrides: Partial<Record<string, ToolHandler>> = {}): RegisteredTool[] {
  return ALL_TOOLS.map((toolName) => {
    const schema = TOOL_SCHEMAS[toolName] ?? { type: 'object', properties: {} };

    return {
      name: toolName,
      description: TOOL_DESCRIPTIONS[toolName] ?? `Execute ${toolName}`,
      inputSchema: schema,
      handler: overrides[toolName] ?? createDefaultHandler(toolName),
    };
  });
}

export async function routeToolCall(
  tools: RegisteredTool[],
  toolName: string,
  input: unknown,
): Promise<ToolResponse> {
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (!tool) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  return tool.handler(isRecord(input) ? input : {});
}

export function createMCPServer(overrides: Partial<Record<string, ToolHandler>> = {}): MCPServerRuntime {
  const tools = createToolRegistry({
    ...createV1ToolHandlers(() => getConnection().db),
    ...overrides,
  });
  const server = new Server(
    {
      name: 'browser-debug-mcp-bridge',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;

    try {
      const response = await routeToolCall(tools, toolName, request.params.arguments);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown MCP tool error';
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: message,
          },
        ],
      };
    }
  });

  const transport = new StdioServerTransport();

  return {
    server,
    transport,
    tools,
    start: async () => {
      await server.connect(transport);
    },
  };
}

export { createBaseResponse };
