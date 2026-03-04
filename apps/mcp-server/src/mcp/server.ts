import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Database } from 'better-sqlite3';
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { getConnection } from '../db/connection.js';

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

export interface SessionConnectionLookupResult {
  connected: boolean;
  connectedAt: number;
  lastHeartbeatAt: number;
  disconnectedAt?: number;
  disconnectReason?: 'manual_stop' | 'network_error' | 'stale_timeout' | 'normal_closure' | 'abnormal_close' | 'unknown';
}

export interface MCPServerOptions {
  captureClient?: CaptureCommandClient;
  logger?: MCPLogger;
  getSessionConnectionState?: (sessionId: string) => SessionConnectionLookupResult | undefined;
}

export interface MCPLogger {
  info(payload: Record<string, unknown>, message?: string): void;
  error(payload: Record<string, unknown>, message?: string): void;
  debug(payload: Record<string, unknown>, message?: string): void;
}

function createDefaultMcpLogger(): MCPLogger {
  const write = (level: 'info' | 'error' | 'debug', message: string, payload: Record<string, unknown>): void => {
    process.stderr.write(`${message} ${JSON.stringify({ level, ...payload })}\n`);
  };

  return {
    info: (payload, message) => {
      write('info', message ?? '[MCPServer][MCP][info]', payload);
    },
    error: (payload, message) => {
      write('error', message ?? '[MCPServer][MCP][error]', payload);
    },
    debug: (payload, message) => {
      write('debug', message ?? '[MCPServer][MCP][debug]', payload);
    },
  };
}

const TOOL_SCHEMAS: Record<string, object> = {
  list_sessions: {
    type: 'object',
    properties: {
      sinceMinutes: { type: 'number' },
      limit: { type: 'number' },
      offset: { type: 'number' },
      maxResponseBytes: { type: 'number' },
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
    properties: {
      sessionId: { type: 'string' },
      url: { type: 'string' },
      eventTypes: { type: 'array', items: { type: 'string' } },
      limit: { type: 'number' },
      offset: { type: 'number' },
      responseProfile: { type: 'string' },
      includePayload: { type: 'boolean' },
      maxResponseBytes: { type: 'number' },
    },
  },
  get_navigation_history: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      url: { type: 'string' },
      limit: { type: 'number' },
      offset: { type: 'number' },
      responseProfile: { type: 'string' },
      includePayload: { type: 'boolean' },
      maxResponseBytes: { type: 'number' },
    },
  },
  get_console_events: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      url: { type: 'string' },
      level: { type: 'string' },
      limit: { type: 'number' },
      offset: { type: 'number' },
      responseProfile: { type: 'string' },
      includePayload: { type: 'boolean' },
      maxResponseBytes: { type: 'number' },
    },
  },
  get_console_summary: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      url: { type: 'string' },
      level: { type: 'string' },
      sinceMinutes: { type: 'number' },
      limit: { type: 'number' },
    },
  },
  get_event_summary: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      url: { type: 'string' },
      eventTypes: { type: 'array', items: { type: 'string' } },
      sinceMinutes: { type: 'number' },
      limit: { type: 'number' },
    },
  },
  get_error_fingerprints: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      sinceMinutes: { type: 'number' },
      limit: { type: 'number' },
      offset: { type: 'number' },
      maxResponseBytes: { type: 'number' },
    },
  },
  get_network_failures: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      url: { type: 'string' },
      errorType: { type: 'string' },
      groupBy: { type: 'string' },
      limit: { type: 'number' },
      offset: { type: 'number' },
      maxResponseBytes: { type: 'number' },
    },
  },
  get_network_calls: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      urlContains: { type: 'string' },
      urlRegex: { type: 'string' },
      method: { type: 'string' },
      statusIn: { type: 'array', items: { type: 'number' } },
      tabId: { type: 'number' },
      timeFrom: { type: 'number' },
      timeTo: { type: 'number' },
      includeBodies: { type: 'boolean' },
      limit: { type: 'number' },
      offset: { type: 'number' },
      maxResponseBytes: { type: 'number' },
    },
  },
  wait_for_network_call: {
    type: 'object',
    required: ['sessionId', 'urlPattern'],
    properties: {
      sessionId: { type: 'string' },
      urlPattern: { type: 'string' },
      method: { type: 'string' },
      timeoutMs: { type: 'number' },
      includeBodies: { type: 'boolean' },
    },
  },
  get_request_trace: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      requestId: { type: 'string' },
      traceId: { type: 'string' },
      includeBodies: { type: 'boolean' },
      eventLimit: { type: 'number' },
    },
  },
  get_body_chunk: {
    type: 'object',
    required: ['chunkRef'],
    properties: {
      chunkRef: { type: 'string' },
      sessionId: { type: 'string' },
      offset: { type: 'number' },
      limit: { type: 'number' },
    },
  },
  get_element_refs: {
    type: 'object',
    required: ['sessionId', 'selector'],
    properties: {
      sessionId: { type: 'string' },
      selector: { type: 'string' },
      limit: { type: 'number' },
      offset: { type: 'number' },
      maxResponseBytes: { type: 'number' },
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
  capture_ui_snapshot: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      selector: { type: 'string' },
      trigger: { type: 'string' },
      mode: { type: 'string' },
      styleMode: { type: 'string' },
      maxDepth: { type: 'number' },
      maxBytes: { type: 'number' },
      maxAncestors: { type: 'number' },
      includeDom: { type: 'boolean' },
      includeStyles: { type: 'boolean' },
      includePngDataUrl: { type: 'boolean' },
    },
  },
  get_live_console_logs: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      url: { type: 'string' },
      tabId: { type: 'number' },
      levels: { type: 'array', items: { type: 'string' } },
      contains: { type: 'string' },
      sinceTs: { type: 'number' },
      includeRuntimeErrors: { type: 'boolean' },
      dedupeWindowMs: { type: 'number' },
      limit: { type: 'number' },
      responseProfile: { type: 'string' },
      includeArgs: { type: 'boolean' },
      maxResponseBytes: { type: 'number' },
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
  list_snapshots: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      trigger: { type: 'string' },
      sinceTimestamp: { type: 'number' },
      untilTimestamp: { type: 'number' },
      limit: { type: 'number' },
      offset: { type: 'number' },
      maxResponseBytes: { type: 'number' },
    },
  },
  get_snapshot_for_event: {
    type: 'object',
    required: ['sessionId', 'eventId'],
    properties: {
      sessionId: { type: 'string' },
      eventId: { type: 'string' },
      maxDeltaMs: { type: 'number' },
    },
  },
  get_snapshot_asset: {
    type: 'object',
    required: ['sessionId', 'snapshotId'],
    properties: {
      sessionId: { type: 'string' },
      snapshotId: { type: 'string' },
      asset: { type: 'string' },
      offset: { type: 'number' },
      maxBytes: { type: 'number' },
      encoding: { type: 'string' },
    },
  },
};

const TOOL_DESCRIPTIONS: Record<string, string> = {
  list_sessions: 'List captured debugging sessions',
  get_session_summary: 'Get summary counters for one session',
  get_recent_events: 'Read recent events from a session',
  get_navigation_history: 'Read navigation events for a session',
  get_console_events: 'Read console events for a session',
  get_console_summary: 'Summarize console volume and top repeated messages',
  get_event_summary: 'Summarize event volume and type distribution',
  get_error_fingerprints: 'List aggregated error fingerprints',
  get_network_failures: 'List network failures and groupings',
  get_network_calls: 'Query network calls with targeted filters and optional sanitized bodies',
  wait_for_network_call: 'Wait for the next matching network call and return it deterministically',
  get_request_trace: 'Get correlated UI/events/network chain by requestId or traceId',
  get_body_chunk: 'Retrieve a chunk from a stored large body payload',
  get_element_refs: 'Get element references by selector',
  get_dom_subtree: 'Capture a bounded DOM subtree',
  get_dom_document: 'Capture full document as outline or html',
  get_computed_styles: 'Read computed CSS styles for an element',
  get_layout_metrics: 'Read viewport and element layout metrics',
  capture_ui_snapshot: 'Capture redacted UI snapshot (DOM/styles/optional PNG) and persist it',
  get_live_console_logs: 'Read in-memory live console logs for a connected session',
  explain_last_failure: 'Explain the latest failure timeline',
  get_event_correlation: 'Correlate related events by window',
  list_snapshots: 'List snapshot metadata by session/time/trigger',
  get_snapshot_for_event: 'Find snapshot most related to an event',
  get_snapshot_asset: 'Read bounded binary chunks for snapshot assets',
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
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_SNAPSHOT_ASSET_CHUNK_BYTES = 64 * 1024;
const MAX_SNAPSHOT_ASSET_CHUNK_BYTES = 256 * 1024;
const DEFAULT_BODY_CHUNK_BYTES = 64 * 1024;
const MAX_BODY_CHUNK_BYTES = 256 * 1024;
const DEFAULT_NETWORK_POLL_TIMEOUT_MS = 15_000;
const MAX_NETWORK_POLL_TIMEOUT_MS = 120_000;
const DEFAULT_NETWORK_POLL_INTERVAL_MS = 250;
const LIVE_SESSION_DISCONNECTED_CODE = 'LIVE_SESSION_DISCONNECTED';
const NETWORK_CALL_SELECT_COLUMNS = `
  request_id, session_id, trace_id, tab_id, ts_start, duration_ms, method, url, origin, status, initiator, error_class, response_size_est,
  request_content_type, request_body_text, request_body_json, request_body_bytes, request_body_truncated, request_body_chunk_ref,
  response_content_type, response_body_text, response_body_json, response_body_bytes, response_body_truncated, response_body_chunk_ref
`;

const NETWORK_DOMAIN_GROUP_SQL = `
  CASE
    WHEN instr(replace(replace(url, 'https://', ''), 'http://', ''), '/') > 0
      THEN substr(
        replace(replace(url, 'https://', ''), 'http://', ''),
        1,
        instr(replace(replace(url, 'https://', ''), 'http://', ''), '/') - 1
      )
    ELSE replace(replace(url, 'https://', ''), 'http://', '')
  END
`;

interface SessionRow {
  session_id: string;
  created_at: number;
  paused_at: number | null;
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
  pinned: number;
}

interface EventRow {
  event_id: string;
  session_id: string;
  ts: number;
  type: string;
  payload_json: string;
  tab_id: number | null;
  origin: string | null;
}

interface ErrorFingerprintRow {
  fingerprint: string;
  session_id: string;
  count: number;
  sample_message: string;
  sample_stack: string | null;
  first_seen_at: number;
  last_seen_at: number;
}

interface NetworkFailureRow {
  request_id: string;
  session_id: string;
  trace_id: string | null;
  tab_id: number | null;
  ts_start: number;
  duration_ms: number | null;
  method: string;
  url: string;
  origin: string | null;
  status: number | null;
  initiator: string | null;
  error_class: string | null;
}

interface NetworkCallRow {
  request_id: string;
  session_id: string;
  trace_id: string | null;
  tab_id: number | null;
  ts_start: number;
  duration_ms: number | null;
  method: string;
  url: string;
  origin: string | null;
  status: number | null;
  initiator: string | null;
  error_class: string | null;
  response_size_est: number | null;
  request_content_type: string | null;
  request_body_text: string | null;
  request_body_json: string | null;
  request_body_bytes: number | null;
  request_body_truncated: number;
  request_body_chunk_ref: string | null;
  response_content_type: string | null;
  response_body_text: string | null;
  response_body_json: string | null;
  response_body_bytes: number | null;
  response_body_truncated: number;
  response_body_chunk_ref: string | null;
}

interface BodyChunkRow {
  chunk_ref: string;
  session_id: string;
  request_id: string | null;
  trace_id: string | null;
  body_kind: string;
  content_type: string | null;
  body_text: string;
  body_bytes: number;
  truncated: number;
  created_at: number;
}

interface GroupedNetworkFailureRow {
  group_key: string;
  count: number;
  first_ts: number;
  last_ts: number;
}

interface SnapshotRow {
  snapshot_id: string;
  session_id: string;
  trigger_event_id: string | null;
  ts: number;
  trigger: string;
  selector: string | null;
  url: string | null;
  mode: string;
  style_mode: string | null;
  dom_json: string | null;
  styles_json: string | null;
  png_path: string | null;
  png_mime: string | null;
  png_bytes: number | null;
  dom_truncated: number;
  styles_truncated: number;
  png_truncated: number;
  created_at: number;
}

interface CorrelationCandidate {
  eventId: string;
  type: string;
  timestamp: number;
  payload?: Record<string, unknown>;
  correlationScore: number;
  relationship: string;
  deltaMs: number;
}

type ResponseProfile = 'legacy' | 'compact';

interface ByteBudgetResult<T> {
  items: T[];
  responseBytes: number;
  truncatedByBytes: boolean;
}

export interface CaptureClientResult {
  ok: boolean;
  payload?: Record<string, unknown>;
  truncated?: boolean;
  error?: string;
}

export interface CaptureCommandClient {
  execute(
    sessionId: string,
    command:
      | 'CAPTURE_DOM_SUBTREE'
      | 'CAPTURE_DOM_DOCUMENT'
      | 'CAPTURE_COMPUTED_STYLES'
      | 'CAPTURE_LAYOUT_METRICS'
      | 'CAPTURE_UI_SNAPSHOT'
      | 'CAPTURE_GET_LIVE_CONSOLE_LOGS',
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<CaptureClientResult>;
}

class LiveSessionDisconnectedError extends Error {
  readonly code = LIVE_SESSION_DISCONNECTED_CODE;

  constructor(sessionId: string, reason?: string) {
    const normalizedReason = typeof reason === 'string' && reason.trim().length > 0
      ? reason.trim()
      : 'Extension connection is stale or unavailable';
    super(
      `${LIVE_SESSION_DISCONNECTED_CODE}: Session ${sessionId} is not connected to a live extension target. ${normalizedReason}. Start a fresh session in the extension and retry with a connected sessionId from list_sessions.`,
    );
    this.name = 'LiveSessionDisconnectedError';
  }
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

function resolveOffset(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }

  const floored = Math.floor(value);
  return floored < 0 ? 0 : floored;
}

function resolveResponseProfile(value: unknown): ResponseProfile {
  return value === 'compact' ? 'compact' : 'legacy';
}

function resolveMaxResponseBytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_MAX_RESPONSE_BYTES;
  }

  const floored = Math.floor(value);
  if (floored < 1_024) {
    return DEFAULT_MAX_RESPONSE_BYTES;
  }

  return Math.min(floored, MAX_RESPONSE_BYTES);
}

function estimateJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf-8');
}

function applyByteBudget<T>(items: T[], maxResponseBytes: number): ByteBudgetResult<T> {
  if (items.length === 0) {
    return {
      items: [],
      responseBytes: 2, // []
      truncatedByBytes: false,
    };
  }

  const selected: T[] = [];
  let usedBytes = 2; // []
  let truncatedByBytes = false;

  for (const item of items) {
    const itemBytes = estimateJsonBytes(item);
    const separatorBytes = selected.length > 0 ? 1 : 0; // comma
    const nextBytes = usedBytes + separatorBytes + itemBytes;

    if (nextBytes > maxResponseBytes && selected.length > 0) {
      truncatedByBytes = true;
      break;
    }

    selected.push(item);
    usedBytes = nextBytes;
  }

  if (!truncatedByBytes && selected.length < items.length) {
    truncatedByBytes = true;
  }

  return {
    items: selected,
    responseBytes: usedBytes,
    truncatedByBytes,
  };
}

function buildOffsetPagination(
  offset: number,
  returned: number,
  hasMore: boolean,
  maxResponseBytes: number,
): Record<string, unknown> {
  return {
    offset,
    returned,
    hasMore,
    nextOffset: hasMore ? offset + returned : null,
    maxResponseBytes,
  };
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
    case 'scroll':
    case 'input':
    case 'change':
    case 'submit':
    case 'focus':
    case 'blur':
    case 'keydown':
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

function normalizeRequestedOrigin(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error('url must be a string');
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('url must use http:// or https://');
    }
    return parsed.origin;
  } catch {
    throw new Error('url must be a valid absolute http(s) URL');
  }
}

function ensureSessionOrOriginFilter(sessionId: string | undefined, origin: string | undefined): void {
  if (!sessionId && !origin) {
    throw new Error('sessionId or url is required');
  }
}

function resolveUrlPrefixFromOrigin(origin: string): string {
  return origin.endsWith('/') ? origin : origin + '/';
}

function appendEventOriginFilter(where: string[], params: unknown[], origin: string | undefined): void {
  if (!origin) {
    return;
  }

  const prefix = resolveUrlPrefixFromOrigin(origin);
  where.push(`
    (
      origin = ?
      OR (
        origin IS NULL AND (
          json_extract(payload_json, '$.origin') = ?
          OR json_extract(payload_json, '$.url') = ?
          OR json_extract(payload_json, '$.url') LIKE ?
          OR json_extract(payload_json, '$.to') = ?
          OR json_extract(payload_json, '$.to') LIKE ?
          OR json_extract(payload_json, '$.href') = ?
          OR json_extract(payload_json, '$.href') LIKE ?
          OR json_extract(payload_json, '$.location') = ?
          OR json_extract(payload_json, '$.location') LIKE ?
        )
      )
    )
  `);
  params.push(origin, origin, origin, `${prefix}%`, origin, `${prefix}%`, origin, `${prefix}%`, origin, `${prefix}%`);
}

function appendNetworkOriginFilter(where: string[], params: unknown[], origin: string | undefined): void {
  if (!origin) {
    return;
  }

  const prefix = resolveUrlPrefixFromOrigin(origin);
  where.push('(origin = ? OR (origin IS NULL AND (url = ? OR url LIKE ?)))');
  params.push(origin, origin, `${prefix}%`);
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

function mapEventRecord(
  row: EventRow,
  profile: ResponseProfile = 'legacy',
  options: { includePayload?: boolean } = {},
): Record<string, unknown> {
  const payload = readJsonPayload(row.payload_json);

  if (profile === 'compact') {
    const compact: Record<string, unknown> = {
      eventId: row.event_id,
      sessionId: row.session_id,
      timestamp: row.ts,
      type: row.type,
      summary: describeEvent(row.type, payload),
    };

    if (row.type === 'console') {
      compact.level = typeof payload.level === 'string' ? payload.level : undefined;
      compact.message = typeof payload.message === 'string' ? payload.message : undefined;
    }

    if (row.type === 'nav') {
      compact.url = resolveLastUrl(payload);
    }

    if (options.includePayload === true) {
      compact.payload = payload;
    }

    return compact;
  }

  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    timestamp: row.ts,
    type: row.type,
    tabId: row.tab_id ?? (typeof payload.tabId === 'number' ? payload.tabId : undefined),
    origin:
      row.origin
      ?? (typeof payload.origin === 'string' ? payload.origin : undefined)
      ?? undefined,
    payload,
  };
}

function classifyNetworkFailure(status: number | null, errorClass: string | null): string {
  if (errorClass && errorClass.length > 0) {
    return errorClass;
  }

  if (typeof status === 'number' && status >= 400) {
    return 'http_error';
  }

  return 'unknown';
}

function buildNetworkFailureFilter(errorType: unknown): string {
  if (typeof errorType !== 'string' || errorType.length === 0) {
    return '(error_class IS NOT NULL OR COALESCE(status, 0) >= 400)';
  }

  if (errorType === 'http_error') {
    return "(error_class = 'http_error' OR (error_class IS NULL AND COALESCE(status, 0) >= 400))";
  }

  return 'error_class = ?';
}

function resolveWindowSeconds(value: unknown, fallback: number, maxValue: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const floored = Math.floor(value);
  if (floored < 1) {
    return fallback;
  }

  return Math.min(floored, maxValue);
}

function resolveOptionalTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  const floored = Math.floor(value);
  return floored < 0 ? undefined : floored;
}

function resolveChunkBytes(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const floored = Math.floor(value);
  if (floored < 1) {
    return fallback;
  }

  return Math.min(floored, MAX_SNAPSHOT_ASSET_CHUNK_BYTES);
}

function resolveDurationMs(value: unknown, fallback: number, maxValue: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const floored = Math.floor(value);
  if (floored < 1) {
    return fallback;
  }

  return Math.min(floored, maxValue);
}

function resolveBodyChunkBytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_BODY_CHUNK_BYTES;
  }

  const floored = Math.floor(value);
  if (floored < 1) {
    return DEFAULT_BODY_CHUNK_BYTES;
  }

  return Math.min(floored, MAX_BODY_CHUNK_BYTES);
}

function resolveTimeoutMs(value: unknown, fallback: number, maxValue: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const floored = Math.floor(value);
  if (floored < 100) {
    return fallback;
  }

  return Math.min(floored, maxValue);
}

function normalizeHttpMethod(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStatusIn(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const statuses = value
    .filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry))
    .map((entry) => Math.floor(entry))
    .filter((entry) => entry >= 100 && entry <= 599);

  return Array.from(new Set(statuses));
}

function parseJsonOrUndefined(value: string | null): unknown {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function compileSafeRegex(value: string | undefined): RegExp | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return new RegExp(value);
  } catch {
    throw new Error('urlRegex must be a valid regular expression');
  }
}

function mapNetworkCallRecord(row: NetworkCallRow, includeBodies: boolean): Record<string, unknown> {
  const requestBodyJson = parseJsonOrUndefined(row.request_body_json);
  const responseBodyJson = parseJsonOrUndefined(row.response_body_json);
  return {
    requestId: row.request_id,
    sessionId: row.session_id,
    traceId: row.trace_id ?? undefined,
    tabId: row.tab_id ?? undefined,
    timestamp: row.ts_start,
    durationMs: row.duration_ms ?? undefined,
    method: row.method,
    url: row.url,
    origin: row.origin ?? undefined,
    status: row.status ?? undefined,
    initiator: row.initiator ?? undefined,
    errorType: classifyNetworkFailure(row.status, row.error_class),
    responseSizeEst: row.response_size_est ?? undefined,
    request: {
      contentType: row.request_content_type ?? undefined,
      bodyBytes: row.request_body_bytes ?? undefined,
      truncated: row.request_body_truncated === 1,
      bodyChunkRef: row.request_body_chunk_ref ?? undefined,
      bodyJson: includeBodies ? requestBodyJson : undefined,
      bodyText: includeBodies ? row.request_body_text ?? undefined : undefined,
    },
    response: {
      contentType: row.response_content_type ?? undefined,
      bodyBytes: row.response_body_bytes ?? undefined,
      truncated: row.response_body_truncated === 1,
      bodyChunkRef: row.response_body_chunk_ref ?? undefined,
      bodyJson: includeBodies ? responseBodyJson : undefined,
      bodyText: includeBodies ? row.response_body_text ?? undefined : undefined,
    },
  };
}

function mapBodyChunkRecord(row: BodyChunkRow, offset: number, limit: number): Record<string, unknown> {
  const fullBuffer = Buffer.from(row.body_text, 'utf-8');
  if (offset >= fullBuffer.byteLength) {
    return {
      chunkRef: row.chunk_ref,
      sessionId: row.session_id,
      requestId: row.request_id ?? undefined,
      traceId: row.trace_id ?? undefined,
      bodyKind: row.body_kind,
      contentType: row.content_type ?? undefined,
      totalBytes: fullBuffer.byteLength,
      offset,
      returnedBytes: 0,
      hasMore: false,
      nextOffset: null,
      chunkText: '',
      truncated: row.truncated === 1,
      createdAt: row.created_at,
    };
  }

  const chunkBuffer = fullBuffer.subarray(offset, Math.min(offset + limit, fullBuffer.byteLength));
  const returnedBytes = chunkBuffer.byteLength;
  const nextOffset = offset + returnedBytes;
  const hasMore = nextOffset < fullBuffer.byteLength;

  return {
    chunkRef: row.chunk_ref,
    sessionId: row.session_id,
    requestId: row.request_id ?? undefined,
    traceId: row.trace_id ?? undefined,
    bodyKind: row.body_kind,
    contentType: row.content_type ?? undefined,
    totalBytes: fullBuffer.byteLength,
    offset,
    returnedBytes,
    hasMore,
    nextOffset: hasMore ? nextOffset : null,
    chunkText: chunkBuffer.toString('utf-8'),
    truncated: row.truncated === 1,
    createdAt: row.created_at,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function normalizeAssetPath(pathValue: string): string {
  return pathValue.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
}

function getMainDbPath(db: Database): string {
  const entries = db.prepare('PRAGMA database_list').all() as Array<{ name: string; file: string }>;
  const main = entries.find((entry) => entry.name === 'main');
  if (!main || !main.file) {
    throw new Error('Snapshot asset retrieval is unavailable for in-memory databases.');
  }
  return main.file;
}

function resolveSnapshotAbsolutePath(dbPath: string, relativeAssetPath: string): string {
  const baseDir = resolve(dirname(dbPath));
  const normalized = normalizeAssetPath(relativeAssetPath);
  const absolutePath = resolve(baseDir, normalized);
  const inBaseDir = absolutePath === baseDir || absolutePath.startsWith(`${baseDir}\\`) || absolutePath.startsWith(`${baseDir}/`);
  if (!inBaseDir) {
    throw new Error('Snapshot asset path is invalid.');
  }
  return absolutePath;
}

function mapSnapshotMetadata(row: SnapshotRow): Record<string, unknown> {
  return {
    snapshotId: row.snapshot_id,
    sessionId: row.session_id,
    triggerEventId: row.trigger_event_id ?? undefined,
    timestamp: row.ts,
    trigger: row.trigger,
    selector: row.selector ?? undefined,
    url: row.url ?? undefined,
    mode: row.mode,
    styleMode: row.style_mode ?? undefined,
    hasDom: row.dom_json !== null,
    hasStyles: row.styles_json !== null,
    hasPng: row.png_path !== null,
    pngBytes: row.png_bytes ?? undefined,
    truncation: {
      dom: row.dom_truncated === 1,
      styles: row.styles_truncated === 1,
      png: row.png_truncated === 1,
    },
    createdAt: row.created_at,
  };
}

function formatUrlPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function describeEvent(type: string, payload: Record<string, unknown>): string {
  if (type === 'nav') {
    return `Navigation to ${resolveLastUrl(payload) ?? 'unknown URL'}`;
  }

  if (type === 'ui') {
    const selector = typeof payload.selector === 'string' ? payload.selector : 'unknown target';
    const eventType = typeof payload.eventType === 'string' ? payload.eventType : 'interaction';
    return `User ${eventType} on ${selector}`;
  }

  if (type === 'console') {
    const level = typeof payload.level === 'string' ? payload.level : 'log';
    const message = typeof payload.message === 'string' ? payload.message : 'no message';
    return `Console ${level}: ${message}`;
  }

  if (type === 'error') {
    const message = typeof payload.message === 'string' ? payload.message : 'Unknown runtime error';
    return `Runtime error: ${message}`;
  }

  return `${type} event`;
}

function describeNetworkFailure(row: NetworkFailureRow): string {
  const errorType = classifyNetworkFailure(row.status, row.error_class);
  const method = row.method || 'REQUEST';
  const target = formatUrlPath(row.url);
  const statusText = typeof row.status === 'number' ? ` status ${row.status}` : '';
  return `Network ${errorType}: ${method} ${target}${statusText}`;
}

function inferCorrelationRelationship(anchorType: string, candidateType: string, deltaMs: number): string {
  if (anchorType === 'ui' && (candidateType === 'error' || candidateType === 'network')) {
    return deltaMs >= 0 ? 'possible_consequence' : 'possible_trigger';
  }

  if ((anchorType === 'error' || anchorType === 'network') && (candidateType === 'error' || candidateType === 'network')) {
    return 'same_failure_window';
  }

  if (candidateType === 'nav') {
    return 'navigation_context';
  }

  if (candidateType === 'ui') {
    return deltaMs <= 0 ? 'preceding_user_action' : 'subsequent_user_action';
  }

  return 'temporal_proximity';
}

function scoreCorrelation(anchorType: string, candidateType: string, deltaMs: number, windowMs: number): number {
  const distance = Math.abs(deltaMs);
  const temporalScore = Math.max(0, 1 - distance / Math.max(windowMs, 1));

  let semanticWeight = 0.45;
  if (anchorType === 'ui' && (candidateType === 'error' || candidateType === 'network')) {
    semanticWeight = 0.85;
  } else if ((anchorType === 'error' || anchorType === 'network') && (candidateType === 'error' || candidateType === 'network')) {
    semanticWeight = 0.9;
  } else if ((anchorType === 'error' || anchorType === 'network') && candidateType === 'ui') {
    semanticWeight = 0.75;
  } else if (candidateType === 'nav') {
    semanticWeight = 0.6;
  }

  const combined = semanticWeight * 0.7 + temporalScore * 0.3;
  return Number(combined.toFixed(3));
}

function resolveCaptureBytes(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const floored = Math.floor(value);
  if (floored < 1_000) {
    return fallback;
  }

  return Math.min(floored, 1_000_000);
}

function resolveCaptureDepth(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const floored = Math.floor(value);
  if (floored < 1) {
    return fallback;
  }

  return Math.min(floored, 10);
}

function resolveCaptureAncestors(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const floored = Math.floor(value);
  if (floored < 0) {
    return fallback;
  }

  return Math.min(floored, 8);
}

function asStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    .slice(0, maxItems);
}

const LIVE_CONSOLE_LEVELS = new Set(['log', 'info', 'warn', 'error', 'debug', 'trace']);

function resolveLiveConsoleLevels(value: unknown): string[] {
  const levels = asStringArray(value, 16)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => LIVE_CONSOLE_LEVELS.has(entry));

  return Array.from(new Set(levels));
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null);
}

function mapLiveConsoleLogRecord(
  log: Record<string, unknown>,
  profile: ResponseProfile,
  options: { includeArgs?: boolean } = {},
): Record<string, unknown> {
  if (profile === 'compact') {
    const compact: Record<string, unknown> = {
      timestamp:
        typeof log.timestamp === 'number'
          ? log.timestamp
          : typeof log.ts === 'number'
            ? log.ts
            : undefined,
      level: typeof log.level === 'string' ? log.level : undefined,
      message: typeof log.message === 'string' ? log.message : '',
    };

    if (typeof log.count === 'number') {
      compact.count = log.count;
    }
    if (typeof log.firstTimestamp === 'number') {
      compact.firstTimestamp = log.firstTimestamp;
    }
    if (typeof log.lastTimestamp === 'number') {
      compact.lastTimestamp = log.lastTimestamp;
    }

    if (options.includeArgs === true && Array.isArray(log.args)) {
      compact.args = log.args;
    }

    return compact;
  }

  return log;
}

function resolveOptionalTabId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('tabId must be an integer');
  }

  const tabId = Math.floor(value);
  if (!Number.isInteger(tabId) || tabId < 0) {
    throw new Error('tabId must be an integer');
  }

  return tabId;
}

function isLiveSessionDisconnectedMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('no active extension connection')
    || normalized.includes('receiving end does not exist')
    || normalized.includes('could not establish connection')
    || normalized.includes('connection closed before capture completed')
    || normalized.includes('websocket manager closed')
    || normalized.includes('extension target is unavailable')
    || normalized.includes('target tab for this session is unavailable');
}

function normalizeCaptureError(sessionId: string, error: unknown): Error {
  const fallback = error instanceof Error ? error : new Error(String(error));
  const message = fallback.message ?? '';

  if (isLiveSessionDisconnectedMessage(message)) {
    return new LiveSessionDisconnectedError(sessionId, message);
  }

  return fallback;
}

function isLiveSessionDisconnectedError(error: unknown): error is LiveSessionDisconnectedError {
  return error instanceof LiveSessionDisconnectedError;
}

async function executeLiveCapture(
  captureClient: CaptureCommandClient,
  sessionId: string,
  command:
    | 'CAPTURE_DOM_SUBTREE'
    | 'CAPTURE_DOM_DOCUMENT'
    | 'CAPTURE_COMPUTED_STYLES'
    | 'CAPTURE_LAYOUT_METRICS'
    | 'CAPTURE_UI_SNAPSHOT'
    | 'CAPTURE_GET_LIVE_CONSOLE_LOGS',
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<CaptureClientResult> {
  try {
    return await captureClient.execute(sessionId, command, payload, timeoutMs);
  } catch (error) {
    throw normalizeCaptureError(sessionId, error);
  }
}

function ensureCaptureSuccess(result: CaptureClientResult, sessionId: string): Record<string, unknown> {
  if (!result.ok) {
    throw normalizeCaptureError(sessionId, new Error(result.error ?? 'Capture command failed'));
  }

  return result.payload ?? {};
}

export function createV1ToolHandlers(
  getDb: () => Database,
  getSessionConnectionState?: (sessionId: string) => SessionConnectionLookupResult | undefined,
): Partial<Record<string, ToolHandler>> {
  return {
    list_sessions: async (input) => {
      const db = getDb();
      const sinceMinutes = typeof input.sinceMinutes === 'number' ? input.sinceMinutes : undefined;
      const limit = resolveLimit(input.limit, DEFAULT_LIST_LIMIT);
      const offset = resolveOffset(input.offset);
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);

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
          paused_at,
          ended_at,
          tab_id,
          window_id,
          url_start,
          url_last,
          user_agent,
          viewport_w,
          viewport_h,
          dpr,
          safe_mode,
          pinned
        FROM sessions
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `;

      const rows = db.prepare(sql).all(...params, limit + 1, offset) as SessionRow[];
      const truncatedByLimit = rows.length > limit;
      const sessions = rows.slice(0, limit).map((row) => ({
        sessionId: row.session_id,
        createdAt: row.created_at,
        pausedAt: row.paused_at ?? undefined,
        endedAt: row.ended_at ?? undefined,
        status: row.ended_at ? 'ended' : row.paused_at ? 'paused' : 'active',
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
        pinned: row.pinned === 1,
        liveConnection: (() => {
          const state = getSessionConnectionState?.(row.session_id);
          if (!state) {
            return {
              connected: false,
              lastHeartbeatAt: undefined,
              disconnectReason: row.ended_at ? 'manual_stop' : undefined,
            };
          }

          return {
            connected: state.connected,
            connectedAt: state.connectedAt,
            lastHeartbeatAt: state.lastHeartbeatAt,
            disconnectedAt: state.disconnectedAt,
            disconnectReason: state.disconnectReason,
          };
        })(),
      }));
      const bytePage = applyByteBudget(sessions, maxResponseBytes);
      const truncated = truncatedByLimit || bytePage.truncatedByBytes;

      return {
        ...createBaseResponse(),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
        responseBytes: bytePage.responseBytes,
        sessions: bytePage.items,
      };
    },

    get_session_summary: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const session = db
        .prepare('SELECT session_id, created_at, ended_at, url_last, pinned FROM sessions WHERE session_id = ?')
        .get(sessionId) as
        | {
            session_id: string;
            created_at: number;
            ended_at: number | null;
            url_last: string | null;
            pinned: number;
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
        pinned: session.pinned === 1,
      };
    },

    get_recent_events: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      const origin = normalizeRequestedOrigin(input.url);
      ensureSessionOrOriginFilter(sessionId, origin);

      const limit = resolveLimit(input.limit, DEFAULT_EVENT_LIMIT);
      const offset = resolveOffset(input.offset);
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);
      const responseProfile = resolveResponseProfile(input.responseProfile);
      const includePayload = responseProfile === 'compact' && input.includePayload === true;
      const requestedTypes = parseRequestedTypes(input.types ?? input.eventTypes);

      const params: unknown[] = [];
      const where: string[] = [];
      if (sessionId) {
        where.push('session_id = ?');
        params.push(sessionId);
      }
      appendEventOriginFilter(where, params, origin);
      if (requestedTypes.length > 0) {
        const placeholders = requestedTypes.map(() => '?').join(', ');
        where.push(`type IN (${placeholders})`);
        params.push(...requestedTypes);
      }

      const rows = db
        .prepare(`
        SELECT event_id, session_id, ts, type, payload_json, tab_id, origin
        FROM events
        WHERE ${where.join(' AND ')}
        ORDER BY ts DESC
        LIMIT ? OFFSET ?
      `)
        .all(...params, limit + 1, offset) as EventRow[];

      const truncatedByLimit = rows.length > limit;
      const events = rows
        .slice(0, limit)
        .map((row) => mapEventRecord(row, responseProfile, { includePayload }));
      const bytePage = applyByteBudget(events, maxResponseBytes);
      const truncated = truncatedByLimit || bytePage.truncatedByBytes;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
        responseProfile,
        responseBytes: bytePage.responseBytes,
        events: bytePage.items,
      };
    },

    get_navigation_history: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      const origin = normalizeRequestedOrigin(input.url);
      ensureSessionOrOriginFilter(sessionId, origin);

      const limit = resolveLimit(input.limit, DEFAULT_EVENT_LIMIT);
      const offset = resolveOffset(input.offset);
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);
      const responseProfile = resolveResponseProfile(input.responseProfile);
      const includePayload = responseProfile === 'compact' && input.includePayload === true;
      const params: unknown[] = [];
      const where: string[] = ["type = 'nav'"];
      if (sessionId) {
        where.push('session_id = ?');
        params.push(sessionId);
      }
      appendEventOriginFilter(where, params, origin);
      const rows = db
        .prepare(`
        SELECT event_id, session_id, ts, type, payload_json, tab_id, origin
        FROM events
        WHERE ${where.join(' AND ')}
        ORDER BY ts DESC
        LIMIT ? OFFSET ?
      `)
        .all(...params, limit + 1, offset) as EventRow[];

      const truncatedByLimit = rows.length > limit;
      const events = rows
        .slice(0, limit)
        .map((row) => mapEventRecord(row, responseProfile, { includePayload }));
      const bytePage = applyByteBudget(events, maxResponseBytes);
      const truncated = truncatedByLimit || bytePage.truncatedByBytes;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
        responseProfile,
        responseBytes: bytePage.responseBytes,
        events: bytePage.items,
      };
    },

    get_console_events: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      const origin = normalizeRequestedOrigin(input.url);
      ensureSessionOrOriginFilter(sessionId, origin);

      const level = typeof input.level === 'string' ? input.level : undefined;
      const limit = resolveLimit(input.limit, DEFAULT_EVENT_LIMIT);
      const offset = resolveOffset(input.offset);
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);
      const responseProfile = resolveResponseProfile(input.responseProfile);
      const includePayload = responseProfile === 'compact' && input.includePayload === true;
      const params: unknown[] = [];
      const where: string[] = ["type = 'console'"];
      if (sessionId) {
        where.push('session_id = ?');
        params.push(sessionId);
      }
      appendEventOriginFilter(where, params, origin);

      if (level) {
        where.push("json_extract(payload_json, '$.level') = ?");
        params.push(level);
      }

      const rows = db
        .prepare(`
        SELECT event_id, session_id, ts, type, payload_json, tab_id, origin
        FROM events
        WHERE ${where.join(' AND ')}
        ORDER BY ts DESC
        LIMIT ? OFFSET ?
      `)
        .all(...params, limit + 1, offset) as EventRow[];

      const truncatedByLimit = rows.length > limit;
      const events = rows
        .slice(0, limit)
        .map((row) => mapEventRecord(row, responseProfile, { includePayload }));
      const bytePage = applyByteBudget(events, maxResponseBytes);
      const truncated = truncatedByLimit || bytePage.truncatedByBytes;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
        responseProfile,
        responseBytes: bytePage.responseBytes,
        events: bytePage.items,
      };
    },

    get_console_summary: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      const origin = normalizeRequestedOrigin(input.url);
      ensureSessionOrOriginFilter(sessionId, origin);
      const level = typeof input.level === 'string' && input.level.length > 0 ? input.level : undefined;
      const sinceMinutes = typeof input.sinceMinutes === 'number' && Number.isFinite(input.sinceMinutes)
        ? Math.floor(input.sinceMinutes)
        : undefined;
      const limit = resolveLimit(input.limit, 10);

      const where: string[] = ["type = 'console'"];
      const params: unknown[] = [];
      if (sessionId) {
        where.push('session_id = ?');
        params.push(sessionId);
      }
      appendEventOriginFilter(where, params, origin);
      if (level) {
        where.push("json_extract(payload_json, '$.level') = ?");
        params.push(level);
      }
      if (sinceMinutes !== undefined && sinceMinutes > 0) {
        where.push('ts >= ?');
        params.push(Date.now() - sinceMinutes * 60_000);
      }
      const whereClause = `WHERE ${where.join(' AND ')}`;

      const totals = db
        .prepare(
          `
          SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN json_extract(payload_json, '$.level') = 'log' THEN 1 ELSE 0 END) AS log_count,
            SUM(CASE WHEN json_extract(payload_json, '$.level') = 'info' THEN 1 ELSE 0 END) AS info_count,
            SUM(CASE WHEN json_extract(payload_json, '$.level') = 'warn' THEN 1 ELSE 0 END) AS warn_count,
            SUM(CASE WHEN json_extract(payload_json, '$.level') = 'error' THEN 1 ELSE 0 END) AS error_count,
            SUM(CASE WHEN json_extract(payload_json, '$.level') = 'debug' THEN 1 ELSE 0 END) AS debug_count,
            SUM(CASE WHEN json_extract(payload_json, '$.level') = 'trace' THEN 1 ELSE 0 END) AS trace_count,
            MIN(ts) AS first_ts,
            MAX(ts) AS last_ts
          FROM events
          ${whereClause}
        `,
        )
        .get(...params) as {
        total: number;
        log_count: number | null;
        info_count: number | null;
        warn_count: number | null;
        error_count: number | null;
        debug_count: number | null;
        trace_count: number | null;
        first_ts: number | null;
        last_ts: number | null;
      };

      const topMessages = db
        .prepare(
          `
          SELECT
            COALESCE(json_extract(payload_json, '$.message'), 'console event') AS message,
            COALESCE(json_extract(payload_json, '$.level'), 'log') AS level,
            COUNT(*) AS count,
            MIN(ts) AS first_ts,
            MAX(ts) AS last_ts
          FROM events
          ${whereClause}
          GROUP BY message, level
          ORDER BY count DESC, last_ts DESC
          LIMIT ?
        `,
        )
        .all(...params, limit) as Array<{
        message: string;
        level: string;
        count: number;
        first_ts: number;
        last_ts: number;
      }>;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated: false,
        },
        counts: {
          total: totals.total ?? 0,
          byLevel: {
            log: totals.log_count ?? 0,
            info: totals.info_count ?? 0,
            warn: totals.warn_count ?? 0,
            error: totals.error_count ?? 0,
            debug: totals.debug_count ?? 0,
            trace: totals.trace_count ?? 0,
          },
        },
        firstSeenAt: totals.first_ts ?? undefined,
        lastSeenAt: totals.last_ts ?? undefined,
        topMessages: topMessages.map((entry) => ({
          level: entry.level,
          message: entry.message,
          count: entry.count,
          firstSeenAt: entry.first_ts,
          lastSeenAt: entry.last_ts,
        })),
      };
    },

    get_event_summary: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      const origin = normalizeRequestedOrigin(input.url);
      ensureSessionOrOriginFilter(sessionId, origin);
      const requestedTypes = parseRequestedTypes(input.types ?? input.eventTypes);
      const sinceMinutes = typeof input.sinceMinutes === 'number' && Number.isFinite(input.sinceMinutes)
        ? Math.floor(input.sinceMinutes)
        : undefined;
      const limit = resolveLimit(input.limit, 20);

      const where: string[] = [];
      const params: unknown[] = [];
      if (sessionId) {
        where.push('session_id = ?');
        params.push(sessionId);
      }
      appendEventOriginFilter(where, params, origin);
      if (requestedTypes.length > 0) {
        const placeholders = requestedTypes.map(() => '?').join(', ');
        where.push(`type IN (${placeholders})`);
        params.push(...requestedTypes);
      }
      if (sinceMinutes !== undefined && sinceMinutes > 0) {
        where.push('ts >= ?');
        params.push(Date.now() - sinceMinutes * 60_000);
      }
      const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

      const totals = db
        .prepare(
          `
          SELECT COUNT(*) AS total, MIN(ts) AS first_ts, MAX(ts) AS last_ts
          FROM events
          ${whereClause}
        `,
        )
        .get(...params) as {
        total: number;
        first_ts: number | null;
        last_ts: number | null;
      };

      const byType = db
        .prepare(
          `
          SELECT type, COUNT(*) AS count, MIN(ts) AS first_ts, MAX(ts) AS last_ts
          FROM events
          ${whereClause}
          GROUP BY type
          ORDER BY count DESC, last_ts DESC
          LIMIT ?
        `,
        )
        .all(...params, limit) as Array<{
        type: string;
        count: number;
        first_ts: number;
        last_ts: number;
      }>;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated: false,
        },
        counts: {
          total: totals.total ?? 0,
        },
        firstSeenAt: totals.first_ts ?? undefined,
        lastSeenAt: totals.last_ts ?? undefined,
        byType: byType.map((entry) => ({
          type: entry.type,
          count: entry.count,
          firstSeenAt: entry.first_ts,
          lastSeenAt: entry.last_ts,
        })),
      };
    },

    get_error_fingerprints: async (input) => {
      const db = getDb();
      const sessionId = typeof input.sessionId === 'string' ? input.sessionId : undefined;
      const sinceMinutes = typeof input.sinceMinutes === 'number' && Number.isFinite(input.sinceMinutes)
        ? Math.floor(input.sinceMinutes)
        : undefined;
      const limit = resolveLimit(input.limit, DEFAULT_LIST_LIMIT);
      const offset = resolveOffset(input.offset);
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);

      const params: unknown[] = [];
      const where: string[] = [];

      if (sessionId) {
        where.push('session_id = ?');
        params.push(sessionId);
      }

      if (sinceMinutes !== undefined && sinceMinutes > 0) {
        where.push('last_seen_at >= ?');
        params.push(Date.now() - sinceMinutes * 60_000);
      }

      const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

      const rows = db
        .prepare(`
          SELECT fingerprint, session_id, count, sample_message, sample_stack, first_seen_at, last_seen_at
          FROM error_fingerprints
          ${whereClause}
          ORDER BY count DESC, last_seen_at DESC
          LIMIT ? OFFSET ?
        `)
        .all(...params, limit + 1, offset) as ErrorFingerprintRow[];

      const truncatedByLimit = rows.length > limit;
      const fingerprints = rows.slice(0, limit).map((row) => ({
        fingerprint: row.fingerprint,
        sessionId: row.session_id,
        count: row.count,
        sampleMessage: row.sample_message,
        sampleStack: row.sample_stack ?? undefined,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
      }));
      const bytePage = applyByteBudget(fingerprints, maxResponseBytes);
      const truncated = truncatedByLimit || bytePage.truncatedByBytes;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
        responseBytes: bytePage.responseBytes,
        fingerprints: bytePage.items,
      };
    },

    get_network_failures: async (input) => {
      const db = getDb();
      const sessionId = typeof input.sessionId === 'string' ? input.sessionId : undefined;
      const origin = normalizeRequestedOrigin(input.url);
      ensureSessionOrOriginFilter(sessionId, origin);
      const groupBy = typeof input.groupBy === 'string' ? input.groupBy : undefined;
      const errorType = typeof input.errorType === 'string' ? input.errorType : undefined;
      const limit = resolveLimit(input.limit, DEFAULT_LIST_LIMIT);
      const offset = resolveOffset(input.offset);
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);

      const params: unknown[] = [];
      const where: string[] = [];
      const errorFilter = buildNetworkFailureFilter(errorType);

      if (sessionId) {
        where.push('session_id = ?');
        params.push(sessionId);
      }
      appendNetworkOriginFilter(where, params, origin);

      where.push(errorFilter);
      if (errorFilter === 'error_class = ?' && errorType) {
        params.push(errorType);
      }

      const whereClause = `WHERE ${where.join(' AND ')}`;

      if (groupBy === 'url' || groupBy === 'errorType' || groupBy === 'domain') {
        const groupExpression =
          groupBy === 'url'
            ? 'url'
            : groupBy === 'domain'
              ? NETWORK_DOMAIN_GROUP_SQL
              : "COALESCE(error_class, CASE WHEN COALESCE(status, 0) >= 400 THEN 'http_error' ELSE 'unknown' END)";

        const rows = db
          .prepare(`
            SELECT
              ${groupExpression} AS group_key,
              COUNT(*) AS count,
              MIN(ts_start) AS first_ts,
              MAX(ts_start) AS last_ts
            FROM network
            ${whereClause}
            GROUP BY group_key
            ORDER BY count DESC, last_ts DESC
            LIMIT ? OFFSET ?
          `)
          .all(...params, limit + 1, offset) as GroupedNetworkFailureRow[];

        const truncatedByLimit = rows.length > limit;
        const groups = rows.slice(0, limit).map((row) => ({
          key: row.group_key,
          count: row.count,
          firstSeenAt: row.first_ts,
          lastSeenAt: row.last_ts,
        }));
        const bytePage = applyByteBudget(groups, maxResponseBytes);
        const truncated = truncatedByLimit || bytePage.truncatedByBytes;

        return {
          ...createBaseResponse(sessionId),
          limitsApplied: {
            maxResults: limit,
            truncated,
          },
          pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
          responseBytes: bytePage.responseBytes,
          groupBy,
          groups: bytePage.items,
        };
      }

      const rows = db
        .prepare(`
          SELECT request_id, session_id, trace_id, tab_id, ts_start, duration_ms, method, url, origin, status, initiator, error_class
          FROM network
          ${whereClause}
          ORDER BY ts_start DESC
          LIMIT ? OFFSET ?
        `)
        .all(...params, limit + 1, offset) as NetworkFailureRow[];

      const truncatedByLimit = rows.length > limit;
      const failures = rows.slice(0, limit).map((row) => ({
        requestId: row.request_id,
        sessionId: row.session_id,
        traceId: row.trace_id ?? undefined,
        tabId: row.tab_id ?? undefined,
        timestamp: row.ts_start,
        durationMs: row.duration_ms ?? undefined,
        method: row.method,
        url: row.url,
        origin: row.origin ?? undefined,
        status: row.status ?? undefined,
        initiator: row.initiator ?? undefined,
        errorType: classifyNetworkFailure(row.status, row.error_class),
      }));
      const bytePage = applyByteBudget(failures, maxResponseBytes);
      const truncated = truncatedByLimit || bytePage.truncatedByBytes;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
        responseBytes: bytePage.responseBytes,
        failures: bytePage.items,
      };
    },

    get_network_calls: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const includeBodies = input.includeBodies === true;
      const urlContains = normalizeOptionalString(input.urlContains);
      const urlRegex = compileSafeRegex(normalizeOptionalString(input.urlRegex));
      const method = normalizeHttpMethod(input.method);
      const statusIn = normalizeStatusIn(input.statusIn);
      const tabId = resolveOptionalTabId(input.tabId);
      const timeFrom = resolveOptionalTimestamp(input.timeFrom);
      const timeTo = resolveOptionalTimestamp(input.timeTo);
      const limit = resolveLimit(input.limit, DEFAULT_EVENT_LIMIT);
      const offset = resolveOffset(input.offset);
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);
      if (timeFrom !== undefined && timeTo !== undefined && timeFrom > timeTo) {
        throw new Error('timeFrom must be <= timeTo');
      }

      const where: string[] = ['session_id = ?'];
      const params: unknown[] = [sessionId];
      if (urlContains) {
        where.push('url LIKE ?');
        params.push(`%${urlContains}%`);
      }
      if (method) {
        where.push('method = ?');
        params.push(method);
      }
      if (statusIn.length > 0) {
        where.push(`status IN (${statusIn.map(() => '?').join(', ')})`);
        params.push(...statusIn);
      }
      if (tabId !== undefined) {
        where.push('tab_id = ?');
        params.push(tabId);
      }
      if (timeFrom !== undefined) {
        where.push('ts_start >= ?');
        params.push(timeFrom);
      }
      if (timeTo !== undefined) {
        where.push('ts_start <= ?');
        params.push(timeTo);
      }
      const whereClause = `WHERE ${where.join(' AND ')}`;

      if (!urlRegex) {
        const rows = db.prepare(
          `SELECT ${NETWORK_CALL_SELECT_COLUMNS}
           FROM network
           ${whereClause}
           ORDER BY ts_start DESC
           LIMIT ? OFFSET ?`
        ).all(...params, limit + 1, offset) as NetworkCallRow[];

        const truncatedByLimit = rows.length > limit;
        const calls = rows
          .slice(0, limit)
          .map((row) => mapNetworkCallRecord(row, includeBodies));
        const bytePage = applyByteBudget(calls, maxResponseBytes);
        const truncated = truncatedByLimit || bytePage.truncatedByBytes;

        return {
          ...createBaseResponse(sessionId),
          limitsApplied: {
            maxResults: limit,
            truncated,
          },
          filtersApplied: {
            sessionId,
            urlContains,
            method,
            statusIn,
            tabId,
            timeFrom,
            timeTo,
            includeBodies,
          },
          pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
          responseBytes: bytePage.responseBytes,
          calls: bytePage.items,
        };
      }

      const regexScanLimit = Math.min(Math.max(limit + offset + 200, 500), 5000);
      const regex = urlRegex;
      const regexRows = db.prepare(
        `SELECT ${NETWORK_CALL_SELECT_COLUMNS}
         FROM network
         ${whereClause}
         ORDER BY ts_start DESC
         LIMIT ?`
      ).all(...params, regexScanLimit) as NetworkCallRow[];
      const matched = regexRows.filter((row) => regex.test(row.url));
      const sliced = matched.slice(offset, offset + limit + 1);
      const truncatedByLimit = matched.length > offset + limit;
      const calls = sliced
        .slice(0, limit)
        .map((row) => mapNetworkCallRecord(row, includeBodies));
      const bytePage = applyByteBudget(calls, maxResponseBytes);
      const truncated = truncatedByLimit || bytePage.truncatedByBytes;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        filtersApplied: {
          sessionId,
          urlContains,
          urlRegex: urlRegex.source,
          method,
          statusIn,
          tabId,
          timeFrom,
          timeTo,
          includeBodies,
          regexScanLimit,
        },
        pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
        responseBytes: bytePage.responseBytes,
        calls: bytePage.items,
      };
    },

    wait_for_network_call: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const urlPattern = normalizeOptionalString(input.urlPattern);
      if (!urlPattern) {
        throw new Error('urlPattern is required');
      }

      const method = normalizeHttpMethod(input.method);
      const timeoutMs = resolveTimeoutMs(input.timeoutMs, DEFAULT_NETWORK_POLL_TIMEOUT_MS, MAX_NETWORK_POLL_TIMEOUT_MS);
      const includeBodies = input.includeBodies === true;
      const startedAt = Date.now();
      const deadline = startedAt + timeoutMs;
      const urlRegex = compileSafeRegex(urlPattern);
      if (!urlRegex) {
        throw new Error('urlPattern is required');
      }

      while (Date.now() <= deadline) {
        const where: string[] = ['session_id = ?', 'ts_start >= ?'];
        const params: unknown[] = [sessionId, startedAt];
        if (method) {
          where.push('method = ?');
          params.push(method);
        }

        const rows = db.prepare(
          `SELECT ${NETWORK_CALL_SELECT_COLUMNS}
           FROM network
           WHERE ${where.join(' AND ')}
           ORDER BY ts_start ASC
           LIMIT 200`
        ).all(...params) as NetworkCallRow[];

        const matched = rows.find((row) => urlRegex.test(row.url));
        if (matched) {
          return {
            ...createBaseResponse(sessionId),
            limitsApplied: {
              maxResults: 1,
              truncated: false,
            },
            waitedMs: Date.now() - startedAt,
            filter: {
              urlPattern,
              method,
              timeoutMs,
              includeBodies,
            },
            call: mapNetworkCallRecord(matched, includeBodies),
          };
        }

        await sleep(DEFAULT_NETWORK_POLL_INTERVAL_MS);
      }

      throw new Error(`No matching network call for pattern "${urlPattern}" within ${timeoutMs}ms.`);
    },

    get_request_trace: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      const includeBodies = input.includeBodies === true;
      const requestId = normalizeOptionalString(input.requestId);
      const traceIdInput = normalizeOptionalString(input.traceId);
      const eventLimit = resolveLimit(input.eventLimit, DEFAULT_EVENT_LIMIT);

      if (!requestId && !traceIdInput) {
        throw new Error('requestId or traceId is required');
      }

      let anchor: NetworkCallRow | undefined;
      if (requestId) {
        const params: unknown[] = [requestId];
        let sql = `SELECT ${NETWORK_CALL_SELECT_COLUMNS} FROM network WHERE request_id = ?`;
        if (sessionId) {
          sql += ' AND session_id = ?';
          params.push(sessionId);
        }
        sql += ' LIMIT 1';
        anchor = db.prepare(sql).get(...params) as NetworkCallRow | undefined;
        if (!anchor) {
          throw new Error(`Request not found: ${requestId}`);
        }
      }

      const traceId = traceIdInput ?? anchor?.trace_id ?? null;
      const traceSessionId = sessionId ?? anchor?.session_id;
      const networkWhere: string[] = [];
      const networkParams: unknown[] = [];
      if (traceId) {
        networkWhere.push('trace_id = ?');
        networkParams.push(traceId);
      } else if (requestId) {
        networkWhere.push('request_id = ?');
        networkParams.push(requestId);
      }
      if (traceSessionId) {
        networkWhere.push('session_id = ?');
        networkParams.push(traceSessionId);
      }

      const networkRows = db.prepare(
        `SELECT ${NETWORK_CALL_SELECT_COLUMNS}
         FROM network
         WHERE ${networkWhere.join(' AND ')}
         ORDER BY ts_start ASC
         LIMIT 500`
      ).all(...networkParams) as NetworkCallRow[];

      const eventRows = traceId
        ? db.prepare(
          `SELECT event_id, session_id, ts, type, payload_json, tab_id, origin
           FROM events
           WHERE json_extract(payload_json, '$.traceId') = ?
             ${traceSessionId ? 'AND session_id = ?' : ''}
           ORDER BY ts ASC
           LIMIT ?`
        ).all(...(traceSessionId ? [traceId, traceSessionId, eventLimit + 1] : [traceId, eventLimit + 1])) as EventRow[]
        : [];
      const eventsTruncated = eventRows.length > eventLimit;
      const correlatedEvents = eventRows.slice(0, eventLimit).map((row) => mapEventRecord(row));

      return {
        ...createBaseResponse(traceSessionId),
        limitsApplied: {
          maxResults: eventLimit,
          truncated: eventsTruncated,
        },
        traceId: traceId ?? undefined,
        requestId: requestId ?? anchor?.request_id ?? undefined,
        anchorRequest: anchor ? mapNetworkCallRecord(anchor, includeBodies) : undefined,
        networkCalls: networkRows.map((row) => mapNetworkCallRecord(row, includeBodies)),
        correlatedEvents,
      };
    },

    get_body_chunk: async (input) => {
      const db = getDb();
      const chunkRef = normalizeOptionalString(input.chunkRef);
      if (!chunkRef) {
        throw new Error('chunkRef is required');
      }

      const sessionId = getSessionId(input);
      const offset = resolveOffset(input.offset);
      const limit = resolveBodyChunkBytes(input.limit);
      const row = db.prepare(
        `SELECT chunk_ref, session_id, request_id, trace_id, body_kind, content_type, body_text, body_bytes, truncated, created_at
         FROM body_chunks
         WHERE chunk_ref = ?
           ${sessionId ? 'AND session_id = ?' : ''}
         LIMIT 1`
      ).get(...(sessionId ? [chunkRef, sessionId] : [chunkRef])) as BodyChunkRow | undefined;

      if (!row) {
        throw new Error(`Body chunk not found: ${chunkRef}`);
      }

      return {
        ...createBaseResponse(row.session_id),
        limitsApplied: {
          maxResults: limit,
          truncated: offset + limit < row.body_bytes,
        },
        ...mapBodyChunkRecord(row, offset, limit),
      };
    },

    get_element_refs: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const selector = typeof input.selector === 'string' ? input.selector : undefined;
      if (!selector) {
        throw new Error('selector is required');
      }

      const limit = resolveLimit(input.limit, DEFAULT_EVENT_LIMIT);
      const offset = resolveOffset(input.offset);
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);
      const rows = db
        .prepare(`
          SELECT event_id, session_id, ts, type, payload_json, tab_id, origin
          FROM events
          WHERE session_id = ?
            AND type IN ('ui', 'element_ref')
            AND json_extract(payload_json, '$.selector') = ?
          ORDER BY ts DESC
          LIMIT ? OFFSET ?
        `)
        .all(sessionId, selector, limit + 1, offset) as EventRow[];

      const truncatedByLimit = rows.length > limit;
      const refs = rows.slice(0, limit).map((row) => mapEventRecord(row));
      const bytePage = applyByteBudget(refs, maxResponseBytes);
      const truncated = truncatedByLimit || bytePage.truncatedByBytes;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
        responseBytes: bytePage.responseBytes,
        selector,
        refs: bytePage.items,
      };
    },

    explain_last_failure: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const lookbackSeconds = resolveWindowSeconds(input.lookbackSeconds, 30, 300);
      const windowMs = lookbackSeconds * 1000;

      const latestErrorEvent = db
        .prepare(`
          SELECT event_id, session_id, ts, type, payload_json, tab_id, origin
          FROM events
          WHERE session_id = ?
            AND (type = 'error' OR (type = 'console' AND json_extract(payload_json, '$.level') = 'error'))
          ORDER BY ts DESC
          LIMIT 1
        `)
        .get(sessionId) as EventRow | undefined;

      const latestNetworkFailure = db
        .prepare(`
          SELECT request_id, session_id, trace_id, tab_id, ts_start, duration_ms, method, url, origin, status, initiator, error_class
          FROM network
          WHERE session_id = ?
            AND (error_class IS NOT NULL OR COALESCE(status, 0) >= 400)
          ORDER BY ts_start DESC
          LIMIT 1
        `)
        .get(sessionId) as NetworkFailureRow | undefined;

      const eventFailureTs = latestErrorEvent?.ts ?? -1;
      const networkFailureTs = latestNetworkFailure?.ts_start ?? -1;

      if (eventFailureTs < 0 && networkFailureTs < 0) {
        return {
          ...createBaseResponse(sessionId),
          limitsApplied: {
            maxResults: 0,
            truncated: false,
          },
          explanation: 'No failure events found for this session.',
          timeline: [],
        };
      }

      const anchorIsEvent = eventFailureTs >= networkFailureTs;
      const anchorTs = anchorIsEvent ? eventFailureTs : networkFailureTs;
      const anchorType = anchorIsEvent ? latestErrorEvent?.type ?? 'error' : 'network';

      const windowStart = anchorTs - windowMs;
      const windowEnd = anchorTs + 1_000;

      const eventRows = db
        .prepare(`
          SELECT event_id, session_id, ts, type, payload_json, tab_id, origin
          FROM events
          WHERE session_id = ?
            AND ts BETWEEN ? AND ?
          ORDER BY ts ASC
        `)
        .all(sessionId, windowStart, windowEnd) as EventRow[];

      const networkRows = db
        .prepare(`
          SELECT request_id, session_id, trace_id, tab_id, ts_start, duration_ms, method, url, origin, status, initiator, error_class
          FROM network
          WHERE session_id = ?
            AND ts_start BETWEEN ? AND ?
            AND (error_class IS NOT NULL OR COALESCE(status, 0) >= 400)
          ORDER BY ts_start ASC
        `)
        .all(sessionId, windowStart, windowEnd) as NetworkFailureRow[];

      const timeline = [
        ...eventRows.map((row) => {
          const payload = readJsonPayload(row.payload_json);
          return {
            timestamp: row.ts,
            type: row.type,
            eventId: row.event_id,
            description: describeEvent(row.type, payload),
            payload,
          };
        }),
        ...networkRows.map((row) => ({
          timestamp: row.ts_start,
          type: 'network',
          eventId: row.request_id,
          description: describeNetworkFailure(row),
          payload: {
            method: row.method,
            url: row.url,
            status: row.status ?? undefined,
            errorType: classifyNetworkFailure(row.status, row.error_class),
          },
        })),
      ]
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(0, 60);

      const closestAction = timeline
        .filter((entry) => entry.type === 'ui' && entry.timestamp <= anchorTs)
        .at(-1);

      const closestNetworkFailure = timeline
        .filter((entry) => entry.type === 'network' && entry.timestamp <= anchorTs)
        .at(-1);

      let rootCause = '';
      if (anchorType === 'network' && latestNetworkFailure) {
        rootCause = describeNetworkFailure(latestNetworkFailure);
      } else if (anchorType === 'error' || anchorType === 'console') {
        if (closestNetworkFailure && anchorTs - closestNetworkFailure.timestamp <= 5_000) {
          rootCause = `Runtime failure likely connected to recent ${closestNetworkFailure.description.toLowerCase()}.`;
        } else if (closestAction && anchorTs - closestAction.timestamp <= 10_000) {
          rootCause = `Runtime failure likely triggered after user action (${closestAction.description.toLowerCase()}).`;
        } else {
          rootCause = 'Runtime failure occurred without a clear nearby trigger in the correlation window.';
        }
      }

      const explanation = `Latest failure at ${anchorTs} with a ${lookbackSeconds}s correlation window.`;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: timeline.length,
          truncated: timeline.length >= 60,
        },
        explanation,
        rootCause,
        anchor: {
          type: anchorType,
          timestamp: anchorTs,
        },
        timeline,
      };
    },

    get_event_correlation: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const eventId = typeof input.eventId === 'string' ? input.eventId : '';
      if (!eventId) {
        throw new Error('eventId is required');
      }

      const anchorEvent = db
        .prepare(`
          SELECT event_id, session_id, ts, type, payload_json, tab_id, origin
          FROM events
          WHERE session_id = ? AND event_id = ?
          LIMIT 1
        `)
        .get(sessionId, eventId) as EventRow | undefined;

      if (!anchorEvent) {
        throw new Error(`Event not found: ${eventId}`);
      }

      const windowSeconds = resolveWindowSeconds(input.windowSeconds, 5, 60);
      const windowMs = windowSeconds * 1000;
      const windowStart = anchorEvent.ts - windowMs;
      const windowEnd = anchorEvent.ts + windowMs;

      const nearbyEvents = db
        .prepare(`
          SELECT event_id, session_id, ts, type, payload_json, tab_id, origin
          FROM events
          WHERE session_id = ?
            AND event_id != ?
            AND ts BETWEEN ? AND ?
        `)
        .all(sessionId, eventId, windowStart, windowEnd) as EventRow[];

      const nearbyNetworkFailures = db
        .prepare(`
          SELECT request_id, session_id, trace_id, tab_id, ts_start, duration_ms, method, url, origin, status, initiator, error_class
          FROM network
          WHERE session_id = ?
            AND ts_start BETWEEN ? AND ?
            AND (error_class IS NOT NULL OR COALESCE(status, 0) >= 400)
        `)
        .all(sessionId, windowStart, windowEnd) as NetworkFailureRow[];

      const correlations: CorrelationCandidate[] = [
        ...nearbyEvents.map((row) => {
          const deltaMs = row.ts - anchorEvent.ts;
          return {
            eventId: row.event_id,
            type: row.type,
            timestamp: row.ts,
            payload: readJsonPayload(row.payload_json),
            correlationScore: scoreCorrelation(anchorEvent.type, row.type, deltaMs, windowMs),
            relationship: inferCorrelationRelationship(anchorEvent.type, row.type, deltaMs),
            deltaMs,
          };
        }),
        ...nearbyNetworkFailures.map((row) => {
          const deltaMs = row.ts_start - anchorEvent.ts;
          return {
            eventId: row.request_id,
            type: 'network',
            timestamp: row.ts_start,
            payload: {
              method: row.method,
              url: row.url,
              status: row.status ?? undefined,
              errorType: classifyNetworkFailure(row.status, row.error_class),
            },
            correlationScore: scoreCorrelation(anchorEvent.type, 'network', deltaMs, windowMs),
            relationship: inferCorrelationRelationship(anchorEvent.type, 'network', deltaMs),
            deltaMs,
          };
        }),
      ]
        .sort((a, b) => {
          if (b.correlationScore !== a.correlationScore) {
            return b.correlationScore - a.correlationScore;
          }
          return Math.abs(a.deltaMs) - Math.abs(b.deltaMs);
        })
        .slice(0, 50);

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 50,
          truncated: nearbyEvents.length + nearbyNetworkFailures.length > 50,
        },
        anchorEvent: {
          eventId: anchorEvent.event_id,
          type: anchorEvent.type,
          timestamp: anchorEvent.ts,
          payload: readJsonPayload(anchorEvent.payload_json),
        },
        windowSeconds,
        correlatedEvents: correlations,
      };
    },

    list_snapshots: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const trigger = typeof input.trigger === 'string' && input.trigger.length > 0 ? input.trigger : undefined;
      const sinceTimestamp = resolveOptionalTimestamp(input.sinceTimestamp);
      const untilTimestamp = resolveOptionalTimestamp(input.untilTimestamp);
      const limit = resolveLimit(input.limit, DEFAULT_LIST_LIMIT);
      const offset = resolveOffset(input.offset);
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);

      const where: string[] = ['session_id = ?'];
      const params: unknown[] = [sessionId];
      if (trigger) {
        where.push('trigger = ?');
        params.push(trigger);
      }
      if (sinceTimestamp !== undefined) {
        where.push('ts >= ?');
        params.push(sinceTimestamp);
      }
      if (untilTimestamp !== undefined) {
        where.push('ts <= ?');
        params.push(untilTimestamp);
      }

      const rows = db
        .prepare(
          `SELECT
            snapshot_id, session_id, trigger_event_id, ts, trigger, selector, url, mode, style_mode,
            dom_json, styles_json, png_path, png_mime, png_bytes,
            dom_truncated, styles_truncated, png_truncated, created_at
           FROM snapshots
           WHERE ${where.join(' AND ')}
           ORDER BY ts DESC
           LIMIT ? OFFSET ?`
        )
        .all(...params, limit + 1, offset) as SnapshotRow[];

      const truncatedByLimit = rows.length > limit;
      const snapshots = rows.slice(0, limit).map((row) => mapSnapshotMetadata(row));
      const bytePage = applyByteBudget(snapshots, maxResponseBytes);
      const truncated = truncatedByLimit || bytePage.truncatedByBytes;
      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
        responseBytes: bytePage.responseBytes,
        snapshots: bytePage.items,
      };
    },

    get_snapshot_for_event: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const eventId = typeof input.eventId === 'string' ? input.eventId : '';
      if (!eventId) {
        throw new Error('eventId is required');
      }

      const maxDeltaMs = resolveDurationMs(input.maxDeltaMs, 10_000, 60_000);
      const event = db
        .prepare('SELECT event_id, ts, type FROM events WHERE session_id = ? AND event_id = ? LIMIT 1')
        .get(sessionId, eventId) as { event_id: string; ts: number; type: string } | undefined;

      if (!event) {
        throw new Error(`Event not found: ${eventId}`);
      }

      const byTriggerLink = db
        .prepare(
          `SELECT
            snapshot_id, session_id, trigger_event_id, ts, trigger, selector, url, mode, style_mode,
            dom_json, styles_json, png_path, png_mime, png_bytes,
            dom_truncated, styles_truncated, png_truncated, created_at
           FROM snapshots
           WHERE session_id = ? AND trigger_event_id = ?
           ORDER BY ts ASC
           LIMIT 1`
        )
        .get(sessionId, eventId) as SnapshotRow | undefined;

      if (byTriggerLink) {
        return {
          ...createBaseResponse(sessionId),
          limitsApplied: {
            maxResults: 1,
            truncated: false,
          },
          event: {
            eventId: event.event_id,
            timestamp: event.ts,
            type: event.type,
          },
          matchReason: 'trigger_event_id',
          snapshot: mapSnapshotMetadata(byTriggerLink),
        };
      }

      const byTimestamp = db
        .prepare(
          `SELECT
            snapshot_id, session_id, trigger_event_id, ts, trigger, selector, url, mode, style_mode,
            dom_json, styles_json, png_path, png_mime, png_bytes,
            dom_truncated, styles_truncated, png_truncated, created_at
           FROM snapshots
           WHERE session_id = ? AND ts BETWEEN ? AND ?
           ORDER BY ABS(ts - ?) ASC, ts ASC
           LIMIT 1`
        )
        .get(sessionId, event.ts, event.ts + maxDeltaMs, event.ts) as SnapshotRow | undefined;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 1,
          truncated: false,
        },
        event: {
          eventId: event.event_id,
          timestamp: event.ts,
          type: event.type,
        },
        matchReason: byTimestamp ? 'nearest_timestamp' : 'none',
        snapshot: byTimestamp ? mapSnapshotMetadata(byTimestamp) : null,
      };
    },

    get_snapshot_asset: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const snapshotId = typeof input.snapshotId === 'string' ? input.snapshotId : '';
      if (!snapshotId) {
        throw new Error('snapshotId is required');
      }

      const assetType = input.asset === 'png' ? 'png' : 'png';
      const encoding = input.encoding === 'raw' ? 'raw' : 'base64';
      const offset = resolveOffset(input.offset);
      const maxBytes = resolveChunkBytes(input.maxBytes, DEFAULT_SNAPSHOT_ASSET_CHUNK_BYTES);

      const snapshot = db
        .prepare(
          `SELECT snapshot_id, session_id, png_path, png_mime, png_bytes
           FROM snapshots
           WHERE session_id = ? AND snapshot_id = ?
           LIMIT 1`
        )
        .get(sessionId, snapshotId) as {
        snapshot_id: string;
        session_id: string;
        png_path: string | null;
        png_mime: string | null;
        png_bytes: number | null;
      } | undefined;

      if (!snapshot) {
        throw new Error(`Snapshot not found: ${snapshotId}`);
      }

      if (assetType !== 'png' || !snapshot.png_path) {
        throw new Error('Requested snapshot asset is not available.');
      }

      const dbPath = getMainDbPath(db);
      const absolutePath = resolveSnapshotAbsolutePath(dbPath, snapshot.png_path);
      if (!existsSync(absolutePath)) {
        throw new Error(`Snapshot asset is missing on disk: ${snapshot.png_path}`);
      }

      const fullBuffer = readFileSync(absolutePath);
      if (offset >= fullBuffer.byteLength) {
        return {
          ...createBaseResponse(sessionId),
          limitsApplied: {
            maxResults: maxBytes,
            truncated: false,
          },
          snapshotId,
          asset: assetType,
          assetUri: `snapshot://${encodeURIComponent(sessionId)}/${encodeURIComponent(snapshotId)}/${assetType}`,
          mime: snapshot.png_mime ?? 'image/png',
          totalBytes: fullBuffer.byteLength,
          offset,
          returnedBytes: 0,
          hasMore: false,
          nextOffset: null,
          encoding,
          chunk: encoding === 'raw' ? [] : undefined,
          chunkBase64: encoding === 'base64' ? '' : undefined,
        };
      }

      const chunkBuffer = fullBuffer.subarray(offset, Math.min(offset + maxBytes, fullBuffer.byteLength));
      const returnedBytes = chunkBuffer.byteLength;
      const nextOffset = offset + returnedBytes;
      const hasMore = nextOffset < fullBuffer.byteLength;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: maxBytes,
          truncated: hasMore,
        },
        snapshotId,
        asset: assetType,
        assetUri: `snapshot://${encodeURIComponent(sessionId)}/${encodeURIComponent(snapshotId)}/${assetType}`,
        mime: snapshot.png_mime ?? 'image/png',
        totalBytes: fullBuffer.byteLength,
        offset,
        returnedBytes,
        hasMore,
        nextOffset: hasMore ? nextOffset : null,
        encoding,
        chunk: encoding === 'raw' ? Array.from(chunkBuffer.values()) : undefined,
        chunkBase64: encoding === 'base64' ? chunkBuffer.toString('base64') : undefined,
      };
    },
  };
}

export function createV2ToolHandlers(captureClient: CaptureCommandClient): Partial<Record<string, ToolHandler>> {
  return {
    get_dom_subtree: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const selector = typeof input.selector === 'string' ? input.selector : '';
      if (!selector) {
        throw new Error('selector is required');
      }

      const maxDepth = resolveCaptureDepth(input.maxDepth, 3);
      const maxBytes = resolveCaptureBytes(input.maxBytes, 50_000);
      const capture = await executeLiveCapture(
        captureClient,
        sessionId,
        'CAPTURE_DOM_SUBTREE',
        { selector, maxDepth, maxBytes },
        4_000,
      );

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: maxBytes,
          truncated: capture.truncated ?? false,
        },
        ...ensureCaptureSuccess(capture, sessionId),
      };
    },

    get_dom_document: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const mode = input.mode === 'html' ? 'html' : 'outline';
      const maxBytes = resolveCaptureBytes(input.maxBytes, 200_000);
      const maxDepth = resolveCaptureDepth(input.maxDepth, 4);

      try {
        const capture = await executeLiveCapture(
          captureClient,
          sessionId,
          'CAPTURE_DOM_DOCUMENT',
          { mode, maxBytes, maxDepth },
          4_000,
        );

        return {
          ...createBaseResponse(sessionId),
          limitsApplied: {
            maxResults: maxBytes,
            truncated: capture.truncated ?? false,
          },
          ...ensureCaptureSuccess(capture, sessionId),
        };
      } catch (error) {
        const normalized = normalizeCaptureError(sessionId, error);
        if (mode !== 'html' || isLiveSessionDisconnectedError(normalized)) {
          throw normalized;
        }

        const fallback = await executeLiveCapture(
          captureClient,
          sessionId,
          'CAPTURE_DOM_DOCUMENT',
          { mode: 'outline', maxBytes, maxDepth },
          4_000,
        );

        return {
          ...createBaseResponse(sessionId),
          limitsApplied: {
            maxResults: maxBytes,
            truncated: true,
          },
          fallbackReason: 'timeout',
          ...ensureCaptureSuccess(fallback, sessionId),
        };
      }
    },

    get_computed_styles: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const selector = typeof input.selector === 'string' ? input.selector : '';
      if (!selector) {
        throw new Error('selector is required');
      }

      const properties = asStringArray(input.properties, 64);
      const capture = await executeLiveCapture(
        captureClient,
        sessionId,
        'CAPTURE_COMPUTED_STYLES',
        { selector, properties },
        3_000,
      );

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: properties.length || 8,
          truncated: capture.truncated ?? false,
        },
        ...ensureCaptureSuccess(capture, sessionId),
      };
    },

    get_layout_metrics: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const selector = typeof input.selector === 'string' ? input.selector : undefined;
      const capture = await executeLiveCapture(
        captureClient,
        sessionId,
        'CAPTURE_LAYOUT_METRICS',
        { selector },
        3_000,
      );

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 1,
          truncated: capture.truncated ?? false,
        },
        ...ensureCaptureSuccess(capture, sessionId),
      };
    },

    capture_ui_snapshot: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const trigger =
        input.trigger === 'click' || input.trigger === 'manual' || input.trigger === 'navigation' || input.trigger === 'error'
          ? input.trigger
          : 'manual';
      const mode = input.mode === 'dom' || input.mode === 'png' || input.mode === 'both' ? input.mode : 'dom';
      const styleMode = input.styleMode === 'computed-full' || input.styleMode === 'computed-lite'
        ? input.styleMode
        : 'computed-lite';
      const explicitStyleMode = input.styleMode === 'computed-full' || input.styleMode === 'computed-lite';
      const selector = typeof input.selector === 'string' && input.selector.trim().length > 0
        ? input.selector.trim()
        : undefined;
      const maxDepth = resolveCaptureDepth(input.maxDepth, 3);
      const maxBytes = resolveCaptureBytes(input.maxBytes, 50_000);
      const maxAncestors = resolveCaptureAncestors(input.maxAncestors, 4);
      const includeDom = typeof input.includeDom === 'boolean' ? input.includeDom : mode !== 'png';
      const includeStyles = typeof input.includeStyles === 'boolean' ? input.includeStyles : mode !== 'png';
      const includePngDataUrl = typeof input.includePngDataUrl === 'boolean' ? input.includePngDataUrl : mode !== 'png';

      const capture = await executeLiveCapture(
        captureClient,
        sessionId,
        'CAPTURE_UI_SNAPSHOT',
        {
          selector,
          trigger,
          mode,
          styleMode,
          explicitStyleMode,
          maxDepth,
          maxBytes,
          maxAncestors,
          includeDom,
          includeStyles,
          includePngDataUrl,
          llmRequested: true,
        },
        5_000,
      );

      const payload = ensureCaptureSuccess(capture, sessionId);
      const snapshotRecord = structuredClone(payload);

      const snapshotRoot = snapshotRecord.snapshot;
      if (typeof snapshotRoot === 'object' && snapshotRoot !== null) {
        const snapshotObject = snapshotRoot as Record<string, unknown>;
        if (!includeDom) {
          delete snapshotObject.dom;
        }
        if (!includeStyles) {
          delete snapshotObject.styles;
        }
      }

      const png = snapshotRecord.png;
      if (!includePngDataUrl && typeof png === 'object' && png !== null) {
        delete (png as Record<string, unknown>).dataUrl;
      }

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: maxBytes,
          truncated: capture.truncated ?? false,
        },
        includeDom,
        includeStyles,
        includePngDataUrl,
        ...snapshotRecord,
      };
    },

    get_live_console_logs: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const origin = normalizeRequestedOrigin(input.url);
      const tabId = resolveOptionalTabId(input.tabId);
      const levels = resolveLiveConsoleLevels(input.levels);
      const contains = typeof input.contains === 'string' && input.contains.trim().length > 0
        ? input.contains.trim()
        : undefined;
      const sinceTs = resolveOptionalTimestamp(input.sinceTs);
      const includeRuntimeErrors = input.includeRuntimeErrors !== false;
      const limit = resolveLimit(input.limit, DEFAULT_EVENT_LIMIT);
      const responseProfile = resolveResponseProfile(input.responseProfile);
      const includeArgs = responseProfile === 'compact' && input.includeArgs === true;
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);
      const dedupeWindowMs = resolveDurationMs(input.dedupeWindowMs, 0, 60_000);
      const capture = await executeLiveCapture(
        captureClient,
        sessionId,
        'CAPTURE_GET_LIVE_CONSOLE_LOGS',
        {
          origin,
          tabId,
          levels,
          contains,
          sinceTs,
          includeRuntimeErrors,
          dedupeWindowMs,
          limit,
        },
        3_000,
      );

      const payload = ensureCaptureSuccess(capture, sessionId);
      const rawLogs = asRecordArray(payload.logs);
      const logs = rawLogs.map((entry) => mapLiveConsoleLogRecord(entry, responseProfile, { includeArgs }));
      const bytePage = applyByteBudget(logs, maxResponseBytes);
      const truncated = (capture.truncated ?? false) || bytePage.truncatedByBytes;
      const paginationRecord =
        typeof payload.pagination === 'object' && payload.pagination !== null
          ? payload.pagination as Record<string, unknown>
          : {};
      const matched = typeof paginationRecord.matched === 'number'
        ? Math.max(0, Math.floor(paginationRecord.matched))
        : rawLogs.length;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        responseProfile,
        responseBytes: bytePage.responseBytes,
        logs: bytePage.items,
        pagination: {
          returned: bytePage.items.length,
          matched,
          hasMore: truncated,
          maxResponseBytes,
        },
        filtersApplied:
          typeof payload.filtersApplied === 'object' && payload.filtersApplied !== null
            ? payload.filtersApplied
            : {
              tabId,
              origin,
              levels,
              contains,
              sinceTs,
              includeRuntimeErrors,
              dedupeWindowMs,
            },
        bufferStats: payload.bufferStats,
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

function attachResponseBytes(response: ToolResponse): ToolResponse {
  if (typeof response.responseBytes === 'number' && Number.isFinite(response.responseBytes)) {
    return response;
  }

  return {
    ...response,
    responseBytes: estimateJsonBytes(response),
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

  const response = await tool.handler(isRecord(input) ? input : {});
  return attachResponseBytes(response);
}

export function createMCPServer(
  overrides: Partial<Record<string, ToolHandler>> = {},
  options: MCPServerOptions = {},
): MCPServerRuntime {
  const logger = options.logger ?? createDefaultMcpLogger();
  const v2Handlers = options.captureClient ? createV2ToolHandlers(options.captureClient) : {};
  const tools = createToolRegistry({
    ...createV1ToolHandlers(() => getConnection().db, options.getSessionConnectionState),
    ...v2Handlers,
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
    logger.debug({ component: 'mcp', event: 'list_tools' }, '[MCPServer][MCP] list_tools request');
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
    const startedAt = Date.now();

    logger.info(
      { component: 'mcp', event: 'tool_call_started', toolName },
      '[MCPServer][MCP] Tool call started',
    );

    try {
      const response = await routeToolCall(tools, toolName, request.params.arguments);
      logger.info(
        {
          component: 'mcp',
          event: 'tool_call_completed',
          toolName,
          durationMs: Date.now() - startedAt,
        },
        '[MCPServer][MCP] Tool call completed',
      );
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
      logger.error(
        {
          component: 'mcp',
          event: 'tool_call_failed',
          toolName,
          durationMs: Date.now() - startedAt,
          error: message,
        },
        '[MCPServer][MCP] Tool call failed',
      );
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
