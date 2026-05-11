import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Database } from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { getConnection } from '../db/connection.js';
import {
  diagnoseOverridePoc,
  insertOverridePlanAudit,
  listOverridePlanAudits,
  listOverridePocRequests,
  listOverridePocRuns,
} from '../override-audit.js';
import type { OverridePlanAuditRecord } from '../override-audit-contract.js';
import {
  createOverrideProfileConfig,
  OVERRIDE_PROFILE_ADAPTERS,
  type OverrideProfileAdapterId,
} from '../override-profile-generator.js';
import {
  assertOverrideResponseRequestCaptureSafe,
  classifyOverrideResponseRequestCapability,
} from '../override-capabilities.js';
import { getOverridePocConfigSummary } from '../override-poc.js';
import { normalizeOverrideRequestMethod } from '../override-rule-types.js';
import { mapNextOverrideAssetsWithDrift } from '../next-asset-mapper.js';
import { planNextSourceOverride, type NextSourceOverridePlanResult, type PlannedNextOverrideRule } from '../next-source-override-planner.js';
import { listObservedOverrideAssets, persistObservedOverrideAssets } from '../override-observed-assets.js';
import { planOverrideResponsePatch, type OverrideResponsePatchPlanResult } from '../override-response-planner.js';

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
  get_live_session_health: {
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
  list_override_profiles: {
    type: 'object',
    properties: {},
  },
  create_override_profile: {
    type: 'object',
    required: ['targetBaseUrl'],
    properties: {
      adapter: { type: 'string' },
      mode: { type: 'string' },
      targetBaseUrl: { type: 'string' },
      projectRoot: { type: 'string' },
      assetRoot: { type: 'string' },
      nextDir: { type: 'string' },
      configPath: { type: 'string' },
      profileId: { type: 'string' },
      profileName: { type: 'string' },
      enabled: { type: 'boolean' },
      profileEnabled: { type: 'boolean' },
      autoReload: { type: 'boolean' },
      includeManifestFiles: { type: 'boolean' },
      includeStaticFiles: { type: 'boolean' },
      extensions: { type: 'array', items: { type: 'string' } },
      maxRules: { type: 'number' },
      writeConfig: { type: 'boolean' },
      overwrite: { type: 'boolean' },
    },
  },
  validate_override_profile: {
    type: 'object',
    properties: {
      profileId: { type: 'string' },
    },
  },
  preflight_overrides: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      profileId: { type: 'string' },
    },
  },
  observe_override_assets: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      tabId: { type: 'number' },
      includePerformance: { type: 'boolean' },
    },
  },
  capture_override_response_body: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      tabId: { type: 'number' },
      targetUrl: { type: 'string' },
      targetAssetUrl: { type: 'string' },
      captureMode: { type: 'string', enum: ['extension-fetch', 'cdp-response'] },
      triggerReload: { type: 'boolean' },
      matchMode: { type: 'string', enum: ['exact', 'prefix'] },
      requestMethod: { type: 'string' },
      requestHeaders: { type: 'object' },
      timeoutMs: { type: 'number' },
      maxBodyBytes: { type: 'number' },
      includeBody: { type: 'boolean' },
    },
  },
  list_observed_override_assets: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      limit: { type: 'number' },
      sinceTimestamp: { type: 'number' },
    },
  },
  map_next_override_assets: {
    type: 'object',
    required: ['projectRoot'],
    properties: {
      sessionId: { type: 'string' },
      tabId: { type: 'number' },
      projectRoot: { type: 'string' },
      nextDir: { type: 'string' },
      route: { type: 'string' },
      sourcePaths: { type: 'array', items: { type: 'string' } },
      observedAssets: { type: 'array', items: { type: 'object' } },
      maxResults: { type: 'number' },
      fetchProductionAssets: { type: 'boolean' },
      productionFetchTimeoutMs: { type: 'number' },
      maxProductionAssetBytes: { type: 'number' },
      maxDriftCandidates: { type: 'number' },
      productionFetchConcurrency: { type: 'number' },
    },
  },
  plan_override_response_patch: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      tabId: { type: 'number' },
      targetUrl: { type: 'string' },
      targetAssetUrl: { type: 'string' },
      captureMode: { type: 'string', enum: ['extension-fetch', 'cdp-response'] },
      triggerReload: { type: 'boolean' },
      ruleType: { type: 'string' },
      requestMethod: { type: 'string' },
      matchMode: { type: 'string', enum: ['exact', 'prefix'] },
      requestHeaders: { type: 'object' },
      timeoutMs: { type: 'number' },
      contentType: { type: 'string' },
      responseBodyText: { type: 'string' },
      bodyText: { type: 'string' },
      responseBodyBase64: { type: 'string' },
      bodyBase64: { type: 'string' },
      textPatches: { type: 'array', items: { type: 'object' } },
      jsonPatches: { type: 'array', items: { type: 'object' } },
      documentPatches: { type: 'array', items: { type: 'object' } },
      maxBodyBytes: { type: 'number' },
      outputRoot: { type: 'string' },
      configPath: { type: 'string' },
      writeBody: { type: 'boolean' },
      writeConfig: { type: 'boolean' },
      overwrite: { type: 'boolean' },
      enabled: { type: 'boolean' },
      profileEnabled: { type: 'boolean' },
      autoReload: { type: 'boolean' },
      profileId: { type: 'string' },
      profileName: { type: 'string' },
      ruleId: { type: 'string' },
      includePreview: { type: 'boolean' },
    },
  },
  plan_next_source_override: {
    type: 'object',
    required: ['projectRoot', 'sourceEdits'],
    properties: {
      sessionId: { type: 'string' },
      tabId: { type: 'number' },
      projectRoot: { type: 'string' },
      nextDir: { type: 'string' },
      route: { type: 'string' },
      sourcePaths: { type: 'array', items: { type: 'string' } },
      sourceEdits: { type: 'array', items: { type: 'object' } },
      observedAssets: { type: 'array', items: { type: 'object' } },
      configPath: { type: 'string' },
      writeConfig: { type: 'boolean' },
      overwrite: { type: 'boolean' },
      enabled: { type: 'boolean' },
      profileEnabled: { type: 'boolean' },
      autoReload: { type: 'boolean' },
      profileId: { type: 'string' },
      profileName: { type: 'string' },
      buildTimeoutMs: { type: 'number' },
      maxRules: { type: 'number' },
      fetchProductionAssets: { type: 'boolean' },
      productionFetchTimeoutMs: { type: 'number' },
      maxProductionAssetBytes: { type: 'number' },
      maxDriftCandidates: { type: 'number' },
      productionFetchConcurrency: { type: 'number' },
      overlayTtlMs: { type: 'number' },
    },
  },
  enable_overrides: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      tabId: { type: 'number' },
      profileId: { type: 'string' },
    },
  },
  disable_overrides: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
    },
  },
  get_override_status: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      profileId: { type: 'string' },
    },
  },
  get_override_request_log: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      runId: { type: 'string' },
      limit: { type: 'number' },
      offset: { type: 'number' },
      maxResponseBytes: { type: 'number' },
    },
  },
  get_override_plan_log: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      planId: { type: 'string' },
      limit: { type: 'number' },
      offset: { type: 'number' },
      maxResponseBytes: { type: 'number' },
    },
  },
  diagnose_overrides: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      runId: { type: 'string' },
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
  get_live_session_health: 'Read live-health guidance for a session using persisted activity plus websocket state',
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
  list_override_profiles: 'List configured browser override profiles',
  create_override_profile: 'Generate a candidate browser override profile from local build assets',
  validate_override_profile: 'Validate the current browser override profile and local asset readiness',
  preflight_overrides: 'Run production-safety checks before enabling browser overrides for a live session',
  observe_override_assets: 'Observe production render artifacts from a live extension tab',
  capture_override_response_body: 'Capture a bounded text response body from a live extension session for override planning, using extension fetch or explicit CDP response-stage capture',
  list_observed_override_assets: 'List persisted production render artifacts observed for a session',
  map_next_override_assets: 'Map observed production Next.js assets to local build chunks and source paths',
  plan_override_response_patch: 'Patch a supplied or live-captured text response body with literal textPatches or JSON Pointer jsonPatches and write an exact or prefix override rule for supported response types',
  plan_next_source_override: 'Apply source edits in a temp Next.js overlay build and plan exact browser override rules',
  enable_overrides: 'Enable browser overrides for a live extension session',
  disable_overrides: 'Disable browser overrides for a live extension session',
  get_override_status: 'Read live or persisted browser override status for a session',
  get_override_request_log: 'Read persisted browser override request audit rows',
  get_override_plan_log: 'Read persisted generated override plan audit rows with previews, hashes, and rollback metadata',
  diagnose_overrides: 'Diagnose persisted browser override runs and failure indicators',
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
const STALE_LIVE_CONNECTION_GRACE_WINDOW_MS = 30 * 60 * 1000;
const NOISE_SESSION_HOST_PATTERNS = [
  /(^|\.)adtrafficquality\.google$/i,
  /(^|\.)doubleclick\.net$/i,
  /(^|\.)googlesyndication\.com$/i,
  /(^|\.)googleadservices\.com$/i,
  /(^|\.)recaptcha\.net$/i,
  /(^|\.)gstatic\.com$/i,
];
const NOISE_SESSION_PATH_PATTERNS = [/\/sodar/i, /\/recaptcha/i, /runner\.html$/i];
const NETWORK_CALL_SELECT_COLUMNS = `
  request_id, session_id, trace_id, tab_id, ts_start, duration_ms, method, url, origin, status, initiator, error_class, response_size_est,
  request_content_type, request_body_text, request_body_json, request_body_bytes, request_body_truncated, request_body_chunk_ref,
  response_content_type, response_body_text, response_body_json, response_body_bytes, response_body_truncated, response_body_chunk_ref
`;

interface SessionScopeAssessment {
  kind: 'top_level_page' | 'likely_iframe_noise' | 'unknown';
  note: string;
  origin?: string;
  host?: string;
  isLocalhost?: boolean;
}

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
  last_seen_at: number | null;
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
      | 'CAPTURE_GET_LIVE_CONSOLE_LOGS'
      | 'CAPTURE_OVERRIDE_OBSERVE_ASSETS'
      | 'CAPTURE_OVERRIDE_RESPONSE_BODY'
      | 'CAPTURE_OVERRIDE_POC_GET_STATUS'
      | 'CAPTURE_OVERRIDE_POC_ENABLE'
      | 'CAPTURE_OVERRIDE_POC_DISABLE',
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

function classifySessionUrl(urlValue: string | null | undefined): SessionScopeAssessment {
  if (!urlValue) {
    return {
      kind: 'unknown',
      note: 'No session URL is available yet.',
    };
  }

  try {
    const parsed = new URL(urlValue);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    const origin = parsed.origin;
    const isLocalhost = host === 'localhost' || host === '127.0.0.1';

    if (
      NOISE_SESSION_HOST_PATTERNS.some((pattern) => pattern.test(host))
      || NOISE_SESSION_PATH_PATTERNS.some((pattern) => pattern.test(pathname))
    ) {
      return {
        kind: 'likely_iframe_noise',
        note: 'Last URL looks like third-party iframe/ad traffic rather than the app surface.',
        origin,
        host,
        isLocalhost,
      };
    }

    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return {
        kind: 'top_level_page',
        note: isLocalhost
          ? 'Last URL looks like a local top-level app page.'
          : 'Last URL looks like a top-level app page.',
        origin,
        host,
        isLocalhost,
      };
    }
  } catch {
    return {
      kind: 'unknown',
      note: 'Session URL could not be parsed.',
    };
  }

  return {
    kind: 'unknown',
    note: 'Session URL does not use an http(s) page origin.',
  };
}

function getSessionStatus(row: Pick<SessionRow, 'paused_at' | 'ended_at'>): 'active' | 'paused' | 'ended' {
  if (row.ended_at) {
    return 'ended';
  }
  if (row.paused_at) {
    return 'paused';
  }
  return 'active';
}

function buildOverrideProfileRecords(): Record<string, unknown>[] {
  const summary = getOverridePocConfigSummary();
  return summary.profiles.map((profile) => ({
    profileId: profile.profileId,
    name: profile.name,
    active: profile.profileId === summary.activeProfileId,
    configEnabled: summary.configEnabled,
    enabled: profile.enabled,
    effectiveEnabled: summary.configEnabled && profile.enabled && profile.enabledRuleCount > 0,
    autoReload: profile.autoReload,
    configPath: summary.configPath,
    fileExists: profile.fileExists,
    ruleCount: profile.ruleCount,
    enabledRuleCount: profile.enabledRuleCount,
    rules: profile.rules,
  }));
}

function resolveOverrideProfileRecord(value: unknown): Record<string, unknown> {
  const profiles = buildOverrideProfileRecords();
  const fallbackProfileId = typeof profiles[0]?.profileId === 'string' ? profiles[0].profileId : 'poc';
  const requestedProfileId = typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallbackProfileId;
  const profile = profiles.find((candidate) => candidate.profileId === requestedProfileId);
  if (!profile) {
    throw new Error(`Unknown override profile: ${requestedProfileId}`);
  }

  return profile;
}

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isRecordWithRscFlightMetadata(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && (
      value.productionMode === 'structured-flight-v1' && value.patchKind === 'string-value-text'
      || value.productionMode === 'literal-response-v1' && value.patchKind === 'literal-text'
    )
    && value.source !== undefined
    && value.patchKind !== undefined;
}

function buildRscFlightRuleIssues(rule: Record<string, unknown>): Array<Record<string, unknown>> {
  const ruleId = String(rule.ruleId ?? 'unknown');
  const issues: Array<Record<string, unknown>> = [];
  const rscFlight = rule.rscFlight;
  if (!isRecordWithRscFlightMetadata(rscFlight)) {
    return [{
      code: 'UNSUPPORTED_RSC_FLIGHT_RULE',
      severity: 'error',
      message: `Rule ${ruleId} targets a Next.js RSC flight response without production RSC metadata generated by the response planner.`,
    }];
  }

  const source = rscFlight.source;
  if (source !== 'cdp-response' && source !== 'extension-fetch') {
    issues.push({
      code: 'RSC_FLIGHT_METADATA_INVALID',
      severity: 'error',
      message: `Rule ${ruleId} RSC metadata source must be cdp-response or extension-fetch.`,
    });
  }

  if (!Array.isArray(rscFlight.textPatches) || rscFlight.textPatches.length === 0) {
    issues.push({
      code: 'RSC_FLIGHT_PATCHES_INVALID',
      severity: 'error',
      message: `Rule ${ruleId} RSC flight metadata must include string-value text patches.`,
    });
  } else {
    for (const [index, patch] of rscFlight.textPatches.entries()) {
      if (
        !isRecord(patch)
        || typeof patch.search !== 'string'
        || patch.search.length === 0
        || typeof patch.replacement !== 'string'
        || typeof patch.expectedCount !== 'number'
        || !Number.isFinite(patch.expectedCount)
        || patch.expectedCount < 0
      ) {
        issues.push({
          code: 'RSC_FLIGHT_PATCHES_INVALID',
          severity: 'error',
          message: `Rule ${ruleId} RSC flight textPatches[${index}] is invalid.`,
        });
      }
    }
  }

  if (rule.requestMethod !== 'GET') {
    issues.push({
      code: 'RSC_FLIGHT_METHOD_UNSUPPORTED',
      severity: 'error',
      message: `Rule ${ruleId} RSC flight overrides only support GET requests.`,
    });
  }

  const targetAssetUrl = typeof rule.targetAssetUrl === 'string' ? rule.targetAssetUrl : '';
  try {
    const parsed = new URL(targetAssetUrl);
    if (!parsed.searchParams.has('_rsc')) {
      issues.push({
        code: 'RSC_FLIGHT_TARGET_INVALID',
        severity: 'error',
        message: `Rule ${ruleId} RSC flight targetAssetUrl must include the _rsc search parameter.`,
      });
    }
  } catch {
    issues.push({
      code: 'RSC_FLIGHT_TARGET_INVALID',
      severity: 'error',
      message: `Rule ${ruleId} RSC flight targetAssetUrl must be an absolute http(s) URL.`,
    });
  }

  const contentType = typeof rule.contentType === 'string' ? rule.contentType : '';
  const metadataContentType = typeof rscFlight.contentType === 'string' ? rscFlight.contentType : '';
  if (!contentType.toLowerCase().includes('text/x-component') || !metadataContentType.toLowerCase().includes('text/x-component')) {
    issues.push({
      code: 'RSC_FLIGHT_CONTENT_TYPE_INVALID',
      severity: 'error',
      message: `Rule ${ruleId} RSC flight overrides require text/x-component content types.`,
    });
  }

  const originalSha256 = typeof rscFlight.originalSha256 === 'string' ? rscFlight.originalSha256 : '';
  const patchedSha256 = typeof rscFlight.patchedSha256 === 'string' ? rscFlight.patchedSha256 : '';
  if (!SHA256_HEX_PATTERN.test(originalSha256) || !SHA256_HEX_PATTERN.test(patchedSha256) || originalSha256 === patchedSha256) {
    issues.push({
      code: 'RSC_FLIGHT_HASH_INVALID',
      severity: 'error',
      message: `Rule ${ruleId} RSC flight metadata must include distinct original and patched sha256 hashes.`,
    });
  }

  const patchedBytes = typeof rscFlight.patchedBytes === 'number' && Number.isFinite(rscFlight.patchedBytes)
    ? Math.floor(rscFlight.patchedBytes)
    : null;
  if (patchedBytes === null || patchedBytes < 1) {
    issues.push({
      code: 'RSC_FLIGHT_BYTES_INVALID',
      severity: 'error',
      message: `Rule ${ruleId} RSC flight metadata must include a positive patchedBytes value.`,
    });
  }

  const fileSizeBytes = typeof rule.fileSizeBytes === 'number' && Number.isFinite(rule.fileSizeBytes)
    ? Math.floor(rule.fileSizeBytes)
    : null;
  if (patchedBytes !== null && fileSizeBytes !== null && patchedBytes !== fileSizeBytes) {
    issues.push({
      code: 'RSC_FLIGHT_LOCAL_FILE_MISMATCH',
      severity: 'error',
      message: `Rule ${ruleId} local RSC file size does not match patchedBytes metadata.`,
    });
  }

  const resolvedLocalFilePath = typeof rule.resolvedLocalFilePath === 'string' ? rule.resolvedLocalFilePath : '';
  if (resolvedLocalFilePath && existsSync(resolvedLocalFilePath) && SHA256_HEX_PATTERN.test(patchedSha256)) {
    const body = readFileSync(resolvedLocalFilePath, 'utf8');
    if (!/(^|\n)\d+:/u.test(body)) {
      issues.push({
        code: 'RSC_FLIGHT_BODY_INVALID',
        severity: 'error',
        message: `Rule ${ruleId} local RSC file does not match the supported Flight payload shape.`,
      });
    }
    if (sha256Text(body) !== patchedSha256) {
      issues.push({
        code: 'RSC_FLIGHT_LOCAL_FILE_MISMATCH',
        severity: 'error',
        message: `Rule ${ruleId} local RSC file hash does not match patchedSha256 metadata.`,
      });
    }
  }

  return issues;
}

function buildOverrideProfileIssues(profile: Record<string, unknown>): Array<Record<string, unknown>> {
  const issues: Array<Record<string, unknown>> = [];
  const rules = Array.isArray(profile.rules)
    ? profile.rules.filter((rule): rule is Record<string, unknown> => isRecord(rule))
    : [];

  if (profile.configEnabled !== true) {
    issues.push({
      code: 'CONFIG_DISABLED',
      severity: 'warning',
      message: 'The override config is disabled and cannot replace requests until enabled.',
    });
  }

  if (profile.enabled !== true) {
    issues.push({
      code: 'PROFILE_DISABLED',
      severity: 'warning',
      message: 'The override profile is disabled and cannot replace requests until enabled.',
    });
  }

  if (rules.length === 0 || !rules.some((rule) => rule.enabled === true)) {
    issues.push({
      code: 'NO_ENABLED_RULES',
      severity: 'error',
      message: 'The override profile has no enabled rules.',
    });
  }

  for (const rule of rules) {
    if (rule.enabled !== true) {
      continue;
    }

    if (typeof rule.targetAssetUrl !== 'string' || !rule.targetAssetUrl.startsWith('http')) {
      issues.push({
        code: 'TARGET_URL_INVALID',
        severity: 'error',
        message: `Rule ${String(rule.ruleId ?? 'unknown')} targetAssetUrl must be an absolute http(s) URL.`,
      });
    }

    if (rule.fileExists !== true) {
      issues.push({
        code: 'LOCAL_FILE_MISSING',
        severity: 'error',
        message: `Rule ${String(rule.ruleId ?? 'unknown')} local override file does not exist.`,
      });
    }

    issues.push(...classifyOverrideResponseRequestCapability({
      ruleId: rule.ruleId,
      requestMethod: rule.requestMethod,
      requestHeaders: rule.requestHeaders,
      ruleType: rule.ruleType,
    }).issues.map((issue) => ({ ...issue })));

    if (rule.ruleType === 'rsc-flight') {
      issues.push(...buildRscFlightRuleIssues(rule));
    }
  }

  return issues;
}

function buildOverrideProfileNextActions(
  profile: Record<string, unknown>,
  issues: Array<Record<string, unknown>>,
): Array<Record<string, string>> {
  if (issues.some((issue) => issue.code === 'SERVER_ACTION_UNSUPPORTED')) {
    return [{
      code: 'REPLAN_SERVER_ACTION_OVERRIDE',
      message: 'Server actions stay unsupported in production override mode; replace the flow with a GET document/data/API response path instead.',
    }];
  }

  if (issues.some((issue) => issue.code === 'MUTATION_REPLAY_UNSUPPORTED')) {
    return [{
      code: 'REPLAN_MUTATION_OVERRIDE',
      message: 'Mutation responses are not replay-safe; move the override to a GET document/data/API response or remove the non-GET rule.',
    }];
  }

  if (issues.some((issue) => issue.code === 'UNSAFE_REQUEST_METHOD')) {
    return [{
      code: 'REPLAN_GET_ONLY_OVERRIDE',
      message: 'Response override rules are production-safe only for GET requests; regenerate or remove non-GET rules.',
    }];
  }

  if (issues.some((issue) => issue.code === 'LOCAL_FILE_MISSING')) {
    return [{
      code: 'REBUILD_OR_FIX_LOCAL_PATHS',
      message: 'Rebuild the local app or fix localFilePath values before enabling overrides.',
    }];
  }

  if (issues.some((issue) => issue.code === 'NO_ENABLED_RULES')) {
    return [{
      code: 'ENABLE_RULES',
      message: 'Enable at least one rule in the selected override profile.',
    }];
  }

  if (issues.some((issue) => issue.code === 'TARGET_URL_INVALID')) {
    return [{
      code: 'FIX_TARGET_URLS',
      message: 'Use absolute http(s) production URLs for every targetAssetUrl.',
    }];
  }

  if (issues.some((issue) => typeof issue.code === 'string' && issue.code.startsWith('RSC_FLIGHT_'))
    || issues.some((issue) => issue.code === 'UNSUPPORTED_RSC_FLIGHT_RULE')) {
    return [{
      code: 'REPLAN_RSC_RESPONSE_OVERRIDE',
      message: 'Regenerate the RSC rule with plan_override_response_patch from a captured text/x-component response body.',
    }];
  }

  if (profile.configEnabled !== true) {
    return [{
      code: 'ENABLE_CONFIG',
      message: 'Set the root override config enabled=true after reviewing the profile.',
    }];
  }

  if (profile.enabled !== true) {
    return [{
      code: 'ENABLE_PROFILE',
      message: 'Set the selected override profile enabled=true after reviewing its rules.',
    }];
  }

  return [{
    code: 'ENABLE_OVERRIDES',
    message: 'Enable overrides on a connected session, then reload the target tab if needed.',
  }];
}

function hasEnabledExperimentalRscFlightRule(profile: Record<string, unknown>): boolean {
  const rules = Array.isArray(profile.rules)
    ? profile.rules.filter((rule): rule is Record<string, unknown> => isRecord(rule))
    : [];
  return rules.some((rule) => {
    return rule.enabled === true
      && rule.ruleType === 'rsc-flight'
      && rule.allowExperimentalRscFlightFulfillment === true;
  });
}

function canBypassPreflightForExperimentalRsc(
  profile: Record<string, unknown>,
  blockingCodes: string[],
): boolean {
  return blockingCodes.length > 0
    && blockingCodes.every((code) => code === 'UNSUPPORTED_RSC_FLIGHT_RULE')
    && hasEnabledExperimentalRscFlightRule(profile);
}

const OVERRIDE_VARIANT_HEADER_ALLOWLIST = new Set([
  'accept',
  'content-type',
  'next-router-prefetch',
  'next-router-state-tree',
  'purpose',
  'rsc',
  'x-nextjs-data',
]);

function normalizeOverrideVariantHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.trim().toLowerCase();
    if (!OVERRIDE_VARIANT_HEADER_ALLOWLIST.has(name)) {
      continue;
    }
    if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
      normalized[name] = rawValue.trim();
      continue;
    }
    if (typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      normalized[name] = String(rawValue);
    }
  }

  return normalized;
}

function buildOverrideVariantContext(options: {
  targetUrl?: unknown;
  requestMethod?: unknown;
  matchMode?: unknown;
  ruleType?: unknown;
  captureMode?: unknown;
  source?: unknown;
  triggerReload?: unknown;
  requestHeaders?: unknown;
}): Record<string, unknown> | null {
  const targetUrl = normalizeOptionalString(options.targetUrl);
  if (!targetUrl) {
    return null;
  }

  const requestMethod = normalizeOverrideRequestMethod(options.requestMethod);
  const matchMode = normalizeOptionalString(options.matchMode) ?? 'exact';
  const ruleType = normalizeOptionalString(options.ruleType) ?? 'document';
  const captureMode = normalizeOptionalString(options.captureMode);
  const source = normalizeOptionalString(options.source);
  const headers = normalizeOverrideVariantHeaders(options.requestHeaders);
  const isPrefetchVariant = headers['next-router-prefetch'] === '1'
    || headers.purpose?.toLowerCase() === 'prefetch';
  const isRscRequest = ruleType === 'rsc-flight' || headers.rsc === '1';
  let isNextDataRequest = ruleType === 'next-data' || headers['x-nextjs-data'] === '1';

  let origin: string | undefined;
  let pathname: string | undefined;
  let searchParams: Array<{ name: string; value: string }> = [];

  try {
    const parsed = new URL(targetUrl);
    origin = parsed.origin;
    pathname = parsed.pathname;
    searchParams = Array.from(parsed.searchParams.entries()).map(([name, value]) => ({ name, value }));
    if (pathname.startsWith('/_next/data/')) {
      isNextDataRequest = true;
    }
  } catch {
    pathname = undefined;
  }

  const searchParamKeys = [...new Set(searchParams.map((entry) => entry.name))].sort();
  const variantBasis = {
    targetUrl,
    origin: origin ?? null,
    pathname: pathname ?? null,
    searchParams,
    requestMethod,
    matchMode,
    ruleType,
    captureMode: captureMode ?? null,
    source: source ?? null,
    triggerReload: options.triggerReload === true,
    headers,
    isPrefetchVariant,
    isRscRequest,
    isNextDataRequest,
  };

  return {
    ...variantBasis,
    searchParamKeys,
    variantKey: sha256Text(JSON.stringify(variantBasis)),
  };
}

function extractPlanVariantContext(plan: OverridePlanAuditRecord): Record<string, unknown> | null {
  if (isRecord(plan.patchSummary) && isRecord(plan.patchSummary.variantContext)) {
    return plan.patchSummary.variantContext;
  }

  if (isRecord(plan.capturedFromLiveSession)) {
    if (isRecord(plan.capturedFromLiveSession.variantContext)) {
      return plan.capturedFromLiveSession.variantContext;
    }
    return buildOverrideVariantContext({
      targetUrl: plan.capturedFromLiveSession.targetUrl ?? plan.targetAssetUrl,
      requestMethod: plan.capturedFromLiveSession.requestMethod ?? plan.requestMethod,
      matchMode: plan.capturedFromLiveSession.matchMode ?? plan.matchMode,
      ruleType: plan.capturedFromLiveSession.ruleType ?? plan.ruleType,
      captureMode: plan.capturedFromLiveSession.captureMode,
      source: plan.capturedFromLiveSession.source,
      triggerReload: plan.capturedFromLiveSession.triggerReload,
      requestHeaders: plan.capturedFromLiveSession.requestHeaders,
    });
  }

  return buildOverrideVariantContext({
    targetUrl: plan.targetAssetUrl,
    requestMethod: plan.requestMethod,
    matchMode: plan.matchMode,
    ruleType: plan.ruleType,
  });
}

function pushOverridePreflightIssue(
  issues: Array<Record<string, unknown>>,
  issue: Record<string, unknown>,
): void {
  const code = typeof issue.code === 'string' ? issue.code : '';
  const source = typeof issue.source === 'string' ? issue.source : '';
  const message = typeof issue.message === 'string' ? issue.message : '';
  if (issues.some((existing) => existing.code === code && existing.source === source && existing.message === message)) {
    return;
  }
  issues.push(issue);
}

function buildOverridePreflight(options: {
  db: Database;
  sessionId: string;
  profileId?: unknown;
  getSessionConnectionState?: (sessionId: string) => SessionConnectionLookupResult | undefined;
}): Record<string, unknown> {
  const session = options.db
    .prepare(`
      SELECT
        session_id,
        created_at,
        last_seen_at,
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
      WHERE session_id = ?
      LIMIT 1
    `)
    .get(options.sessionId) as SessionRow | undefined;
  const profile = resolveOverrideProfileRecord(options.profileId);
  const issues: Array<Record<string, unknown>> = [];
  const observedAssets = session
    ? listObservedOverrideAssets(options.db, { sessionId: options.sessionId, limit: 200 })
    : [];
  const latestRun = session ? listOverridePocRuns(options.db, options.sessionId, 1, 0).runs[0] ?? null : null;
  const recentPlans = session
    ? listOverridePlanAudits(options.db, { sessionId: options.sessionId, limit: 5, offset: 0 }).plans
    : [];
  const variantContexts = [...new Map(
    recentPlans
      .map((plan) => extractPlanVariantContext(plan))
      .filter((context): context is Record<string, unknown> => context !== null)
      .map((context) => [String(context.variantKey ?? JSON.stringify(context)), context]),
  ).values()];
  const sessionState = options.getSessionConnectionState?.(options.sessionId);
  const diagnosis = session ? diagnoseOverridePoc(options.db, options.sessionId, latestRun?.runId) : null;

  for (const issue of buildOverrideProfileIssues(profile)) {
    pushOverridePreflightIssue(issues, { ...issue, source: 'profile' });
  }

  if (!session) {
    pushOverridePreflightIssue(issues, {
      code: 'SESSION_NOT_FOUND',
      severity: 'error',
      source: 'session',
      message: `Session not found: ${options.sessionId}`,
    });
  } else {
    const sessionStatus = getSessionStatus(session);
    if (sessionStatus === 'paused') {
      pushOverridePreflightIssue(issues, {
        code: 'SESSION_PAUSED',
        severity: 'error',
        source: 'session',
        message: `Session ${options.sessionId} is paused and cannot enable overrides until it resumes.`,
      });
    }
    if (sessionStatus === 'ended') {
      pushOverridePreflightIssue(issues, {
        code: 'SESSION_ENDED',
        severity: 'error',
        source: 'session',
        message: `Session ${options.sessionId} has ended and cannot enable overrides.`,
      });
    }
    if (sessionState && sessionState.connected !== true) {
      pushOverridePreflightIssue(issues, {
        code: LIVE_SESSION_DISCONNECTED_CODE,
        severity: 'error',
        source: 'connection',
        message: `Session ${options.sessionId} is not currently connected to the live extension bridge.`,
      });
    }
  }

  const enabledRules = Array.isArray(profile.rules)
    ? profile.rules.filter((rule): rule is Record<string, unknown> => isRecord(rule) && rule.enabled === true)
    : [];
  const anyServiceWorkerControlled = observedAssets.some((asset) => asset.serviceWorkerControlled);
  const cspMetaTags = [...new Set(observedAssets.flatMap((asset) => asset.cspMetaTags))];

  if (observedAssets.length === 0) {
    pushOverridePreflightIssue(issues, {
      code: 'NO_OBSERVED_ASSETS',
      severity: 'warning',
      source: 'observed-assets',
      message: 'No observed production assets are stored for this session yet.',
    });
  }

  for (const rule of enabledRules) {
    const ruleId = String(rule.ruleId ?? 'unknown');
    const targetAssetUrl = normalizeOptionalString(rule.targetAssetUrl);
    if (!targetAssetUrl) {
      continue;
    }
    const requestMethod = normalizeOverrideRequestMethod(rule.requestMethod);
    const matchingAssets = observedAssets.filter((asset) => {
      return asset.url === targetAssetUrl
        && normalizeOverrideRequestMethod(asset.requestMethod) === requestMethod;
    });

    if (observedAssets.length > 0 && matchingAssets.length === 0) {
      pushOverridePreflightIssue(issues, {
        code: 'TARGET_ASSET_NOT_OBSERVED',
        severity: 'warning',
        source: 'observed-assets',
        message: `Rule ${ruleId} target asset was not observed for ${requestMethod} ${targetAssetUrl}.`,
      });
      continue;
    }

    for (const asset of matchingAssets) {
      if (typeof asset.integrity === 'string' && asset.integrity.length > 0) {
        pushOverridePreflightIssue(issues, {
          code: 'TARGET_ASSET_SRI_PRESENT',
          severity: 'error',
          source: 'observed-assets',
          message: `Rule ${ruleId} target asset ${asset.url} includes integrity="${asset.integrity}" and cannot be overridden safely.`,
        });
      }
    }
  }

  if (anyServiceWorkerControlled) {
    pushOverridePreflightIssue(issues, {
      code: 'SERVICE_WORKER_CONTROLLED',
      severity: 'warning',
      source: 'observed-assets',
      message: 'The observed page is service-worker controlled; verify the target requests still reach the network path that the debugger can fulfill.',
    });
  }

  if (cspMetaTags.length > 0) {
    pushOverridePreflightIssue(issues, {
      code: 'CSP_META_PRESENT',
      severity: 'warning',
      source: 'observed-assets',
      message: `The observed page emitted ${cspMetaTags.length} CSP meta tag(s); document or bootstrap rewrites may still be constrained by page policy.`,
    });
  }

  const ready = !issues.some((issue) => issue.severity === 'error');
  const nextActions = !ready
    ? issues.some((issue) => issue.code === 'SERVER_ACTION_UNSUPPORTED')
      ? [{
          code: 'REPLAN_SERVER_ACTION_OVERRIDE',
          message: 'Server actions stay unsupported in production override mode; move the override to a GET document/data/API response.',
        }]
      : issues.some((issue) => issue.code === 'MUTATION_REPLAY_UNSUPPORTED')
        ? [{
            code: 'REPLAN_MUTATION_OVERRIDE',
            message: 'Mutation responses are not replay-safe; use a GET document/data/API response path instead.',
          }]
        : issues.some((issue) => issue.code === 'UNSAFE_REQUEST_METHOD')
          ? [{ code: 'REPLAN_GET_ONLY_OVERRIDE', message: 'Remove or regenerate non-GET rules before enabling overrides.' }]
          : issues.some((issue) => issue.code === 'TARGET_ASSET_SRI_PRESENT')
            ? [{ code: 'CHOOSE_ANOTHER_OVERRIDE_PATH', message: 'Choose a document/data response path or remove SRI on the production asset before enabling overrides.' }]
            : issues.some((issue) => issue.code === 'SESSION_NOT_FOUND' || issue.code === 'SESSION_PAUSED' || issue.code === 'SESSION_ENDED' || issue.code === LIVE_SESSION_DISCONNECTED_CODE)
              ? [{ code: 'RECONNECT_SESSION', message: 'Reconnect or resume the target session before enabling overrides.' }]
              : buildOverrideProfileNextActions(profile, issues)
    : observedAssets.length === 0
      ? [{ code: 'OBSERVE_OVERRIDE_ASSETS', message: 'Run observe_override_assets on the target route before enabling overrides in production workflows.' }]
      : [{ code: 'ENABLE_OVERRIDES', message: 'Preflight checks passed; the selected profile can be enabled on the live session.' }];

  return {
    ready,
    profileId: profile.profileId,
    profile,
    session: session
      ? {
          sessionId: session.session_id,
          status: getSessionStatus(session),
          lastSeenAt: resolveSessionLastSeenAt(session, sessionState),
          connected: sessionState?.connected === true,
          disconnectedAt: sessionState?.disconnectedAt,
          disconnectReason: sessionState?.disconnectReason,
          urlLast: session.url_last ?? undefined,
          tabId: session.tab_id ?? undefined,
        }
      : null,
    issues,
    checks: {
      sessionFound: session !== undefined,
      connected: sessionState?.connected === true,
      observedAssetCount: observedAssets.length,
      targetAssetObserved: issues.every((issue) => issue.code !== 'TARGET_ASSET_NOT_OBSERVED'),
      serviceWorkerControlled: anyServiceWorkerControlled,
      cspMetaTagCount: cspMetaTags.length,
      recentPlanCount: recentPlans.length,
      variantContextCount: variantContexts.length,
    },
    observedAssets: {
      count: observedAssets.length,
      serviceWorkerControlled: anyServiceWorkerControlled,
      cspMetaTags,
    },
    latestRun,
    recentPlans,
    variantContexts,
    diagnosis,
    nextActions,
  };
}

function normalizeOptionalBooleanInput(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${fieldName} must be a boolean when provided`);
  }
  return value;
}

function normalizeOptionalNumberInput(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number when provided`);
  }
  return value;
}

function normalizeOptionalStringArrayInput(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of strings when provided`);
  }

  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new Error(`${fieldName}[${index}] must be a non-empty string`);
    }
    return entry.trim();
  });
}

function resolveSessionLastSeenAt(
  row: Pick<SessionRow, 'created_at' | 'last_seen_at' | 'paused_at' | 'ended_at'>,
  state?: SessionConnectionLookupResult,
): number {
  return Math.max(
    row.created_at,
    row.last_seen_at ?? 0,
    row.paused_at ?? 0,
    row.ended_at ?? 0,
    state?.lastHeartbeatAt ?? 0,
  );
}

function buildLiveConnectionRecord(
  row: Pick<SessionRow, 'created_at' | 'last_seen_at' | 'paused_at' | 'ended_at'>,
  scope: SessionScopeAssessment,
  state?: SessionConnectionLookupResult,
): Record<string, unknown> {
  const status = getSessionStatus(row);
  const lastSeenAt = resolveSessionLastSeenAt(row, state);
  const heartbeatAt = state?.lastHeartbeatAt;
  const heartbeatAgeMs = typeof heartbeatAt === 'number' ? Math.max(0, Date.now() - heartbeatAt) : undefined;
  const likelyStale = Boolean(
    !state?.connected
      && status === 'active'
      && scope.kind !== 'likely_iframe_noise'
      && typeof heartbeatAt === 'number'
      && Date.now() - heartbeatAt <= STALE_LIVE_CONNECTION_GRACE_WINDOW_MS,
  );

  return {
    connected: state?.connected === true,
    connectedAt: state?.connectedAt,
    lastHeartbeatAt: heartbeatAt,
    heartbeatAgeMs,
    disconnectedAt: state?.disconnectedAt,
    disconnectReason: state?.disconnectReason ?? (status === 'ended' ? 'manual_stop' : undefined),
    status: status === 'ended'
      ? 'ended'
      : status === 'paused'
        ? 'paused'
        : state?.connected
          ? 'connected'
          : likelyStale
            ? 'likely_stale'
            : 'disconnected',
    captureReady: state?.connected === true && status === 'active',
    recommendedForLiveCapture: state?.connected === true && status === 'active' && scope.kind !== 'likely_iframe_noise',
    lastSeenAt,
    activityAgeMs: Math.max(0, Date.now() - lastSeenAt),
  };
}

function buildLiveSessionNextAction(
  liveConnection: Record<string, unknown>,
  scope: SessionScopeAssessment,
): string {
  const liveStatus = typeof liveConnection.status === 'string' ? liveConnection.status : 'disconnected';

  if (liveStatus === 'connected' && scope.kind !== 'likely_iframe_noise') {
    return 'Use this session for live capture tools.';
  }

  if (liveStatus === 'connected' && scope.kind === 'likely_iframe_noise') {
    return 'Reconnect on a top-level app tab before relying on live navigation or performance captures.';
  }

  if (liveStatus === 'likely_stale') {
    return 'Retry list_sessions after a fresh app interaction or restart the session if live capture still fails.';
  }

  if (liveStatus === 'paused') {
    return 'Resume the session from the extension popup before using live capture tools.';
  }

  if (liveStatus === 'ended') {
    return 'Start a new extension session before using live capture tools.';
  }

  return 'Reconnect or restart the extension session before using live capture tools.';
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
    | 'CAPTURE_GET_LIVE_CONSOLE_LOGS'
    | 'CAPTURE_OVERRIDE_OBSERVE_ASSETS'
    | 'CAPTURE_OVERRIDE_RESPONSE_BODY'
    | 'CAPTURE_OVERRIDE_POC_GET_STATUS'
    | 'CAPTURE_OVERRIDE_POC_ENABLE'
    | 'CAPTURE_OVERRIDE_POC_DISABLE',
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

function auditSessionExists(db: Database, sessionId: string): boolean {
  const row = db.prepare('SELECT 1 FROM sessions WHERE session_id = ? LIMIT 1').get(sessionId);
  return row !== undefined;
}

function hashLocalFileIfPresent(filePath: string | undefined): { sha256: string | null; bytes: number | null } {
  if (!filePath || !existsSync(filePath)) {
    return { sha256: null, bytes: null };
  }
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    return { sha256: null, bytes: null };
  }
  return {
    sha256: createHash('sha256').update(readFileSync(filePath)).digest('hex'),
    bytes: stat.size,
  };
}

function resolveAuditProfileId(input: ToolInput): string | null {
  return normalizeOptionalString(input.profileId) ?? null;
}

function buildOverrideRollbackMetadata(options: {
  sessionId: string;
  profileId: string | null;
  configPath?: string | null;
  generatedFiles: string[];
  generatedDirectories?: string[];
  note?: string;
}): Record<string, unknown> {
  return {
    disableTool: 'disable_overrides',
    validateTool: 'validate_override_profile',
    sessionId: options.sessionId,
    profileId: options.profileId,
    configPath: options.configPath ?? null,
    generatedFiles: Array.from(new Set(options.generatedFiles.filter((entry) => entry.trim().length > 0))),
    generatedDirectories: Array.from(new Set((options.generatedDirectories ?? []).filter((entry) => entry.trim().length > 0))),
    notes: [
      'Disable overrides for this session before deleting generated files or config entries.',
      'Re-run validate_override_profile after editing or removing generated config rules.',
      options.note,
    ].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0),
  };
}

function persistResponsePlanAudit(options: {
  db: Database;
  sessionId?: string;
  input: ToolInput;
  plan: OverrideResponsePatchPlanResult;
  capturedFromLiveSession?: unknown;
  variantContext?: unknown;
}): OverridePlanAuditRecord | undefined {
  if (!options.sessionId || !options.plan.rule || !auditSessionExists(options.db, options.sessionId)) {
    return undefined;
  }

  const profileId = resolveAuditProfileId(options.input);
  const record: OverridePlanAuditRecord = {
    planId: randomUUID(),
    sessionId: options.sessionId,
    createdAt: Date.now(),
    plannerKind: 'response-patch',
    toolName: 'plan_override_response_patch',
    profileId,
    ruleId: options.plan.rule.ruleId,
    ruleType: options.plan.rule.ruleType,
    requestMethod: options.plan.requestMethod,
    matchMode: options.plan.matchMode,
    targetAssetUrl: options.plan.targetUrl,
    localFilePath: options.plan.localFilePath ?? options.plan.rule.localFilePath,
    configPath: options.plan.configPath ?? null,
    contentType: options.plan.contentType,
    originalSha256: options.plan.originalSha256,
    patchedSha256: options.plan.patchedSha256,
    originalBytes: options.plan.originalBytes,
    patchedBytes: options.plan.patchedBytes,
    patchSummary: {
      textPatches: options.plan.patches,
      jsonPatches: options.plan.jsonPatches,
      documentPatches: options.plan.documentPatches,
      ruleType: options.plan.ruleType,
      configWritten: options.plan.configWritten,
      rscFlight: options.plan.rule.rscFlight ?? null,
      variantContext: options.variantContext ?? null,
    },
    preview: options.plan.preview ?? null,
    warnings: options.plan.warnings,
    blockers: options.plan.blockers,
    capturedFromLiveSession: options.capturedFromLiveSession ?? null,
    rollback: buildOverrideRollbackMetadata({
      sessionId: options.sessionId,
      profileId,
      configPath: options.plan.configPath ?? null,
      generatedFiles: options.plan.localFilePath ? [options.plan.localFilePath] : [],
      note: 'Generated response override bodies are disposable once the override has been disabled.',
    }),
  };

  return insertOverridePlanAudit(options.db, record);
}

function persistNextSourcePlanAudits(options: {
  db: Database;
  sessionId?: string;
  input: ToolInput;
  plan: NextSourceOverridePlanResult;
}): OverridePlanAuditRecord[] {
  if (!options.sessionId || !auditSessionExists(options.db, options.sessionId)) {
    return [];
  }

  const sessionId = options.sessionId;
  const profileId = resolveAuditProfileId(options.input);
  const generatedFiles = options.plan.rules.map((rule) => rule.localFilePath);
  return options.plan.rules.map((rule: PlannedNextOverrideRule) => {
    const localFile = hashLocalFileIfPresent(rule.localFilePath);
    const record: OverridePlanAuditRecord = {
      planId: randomUUID(),
      sessionId: options.sessionId,
      createdAt: Date.now(),
      plannerKind: 'next-source-overlay',
      toolName: 'plan_next_source_override',
      profileId,
      ruleId: rule.ruleId,
      ruleType: rule.ruleType,
      requestMethod: rule.requestMethod,
      matchMode: rule.matchMode,
      targetAssetUrl: rule.targetAssetUrl,
      localFilePath: rule.localFilePath,
      configPath: options.plan.configPath ?? null,
      contentType: rule.contentType,
      originalSha256: null,
      patchedSha256: localFile.sha256,
      originalBytes: null,
      patchedBytes: localFile.bytes,
      patchSummary: {
        sourcePaths: options.plan.sourcePaths,
        editsApplied: options.plan.editsApplied,
        ruleReason: rule.reason,
        confidence: rule.confidence,
        score: rule.score,
        matchedSourcePaths: rule.matchedSourcePaths,
        originalAssetPath: rule.originalAssetPath ?? null,
        build: options.plan.build,
        configWritten: options.plan.configWritten,
      },
      preview: null,
      warnings: [...options.plan.warnings, ...rule.blockers.map((blocker) => `rule ${rule.ruleId}: ${blocker}`)],
      blockers: options.plan.blockers,
      capturedFromLiveSession: null,
      rollback: buildOverrideRollbackMetadata({
        sessionId,
        profileId,
        configPath: options.plan.configPath ?? null,
        generatedFiles,
        generatedDirectories: [options.plan.overlayRoot],
        note: 'Generated Next.js overlay folders are disposable once the override has been disabled.',
      }),
    };
    return insertOverridePlanAudit(options.db, record);
  });
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
        where.push(`
          CASE
            WHEN COALESCE(last_seen_at, 0) > created_at THEN COALESCE(last_seen_at, 0)
            ELSE created_at
          END >= ?
        `);
        params.push(Date.now() - Math.floor(sinceMinutes * 60_000));
      }

      const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      const sql = `
        SELECT
          session_id,
          created_at,
          last_seen_at,
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
        ORDER BY
          CASE
            WHEN COALESCE(last_seen_at, 0) > created_at THEN COALESCE(last_seen_at, 0)
            ELSE created_at
          END DESC,
          created_at DESC
        LIMIT ? OFFSET ?
      `;

      const rows = db.prepare(sql).all(...params, limit + 1, offset) as SessionRow[];
      const truncatedByLimit = rows.length > limit;
      const sessions = rows.slice(0, limit).map((row) => {
        const status = getSessionStatus(row);
        const state = getSessionConnectionState?.(row.session_id);
        const lastUrl = row.url_last ?? undefined;
        const scope = classifySessionUrl(lastUrl);
        const liveConnection = buildLiveConnectionRecord(row, scope, state);

        return {
          sessionId: row.session_id,
          createdAt: row.created_at,
          lastSeenAt: resolveSessionLastSeenAt(row, state),
          pausedAt: row.paused_at ?? undefined,
          endedAt: row.ended_at ?? undefined,
          status,
          tabId: row.tab_id ?? undefined,
          windowId: row.window_id ?? undefined,
          urlStart: row.url_start ?? undefined,
          urlLast: lastUrl,
          lastUrl,
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
          scope,
          liveConnection,
        };
      });
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

    get_live_session_health: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const session = db
        .prepare(`
          SELECT
            session_id,
            created_at,
            last_seen_at,
            paused_at,
            ended_at,
            tab_id,
            window_id,
            url_last,
            safe_mode,
            pinned
          FROM sessions
          WHERE session_id = ?
        `)
        .get(sessionId) as
        | {
            session_id: string;
            created_at: number;
            last_seen_at: number | null;
            paused_at: number | null;
            ended_at: number | null;
            tab_id: number | null;
            window_id: number | null;
            url_last: string | null;
            safe_mode: number;
            pinned: number;
          }
        | undefined;

      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const latestNav = db
        .prepare(`
          SELECT payload_json
          FROM events
          WHERE session_id = ? AND type = 'nav'
          ORDER BY ts DESC
          LIMIT 1
        `)
        .get(sessionId) as { payload_json: string } | undefined;

      const navPayload = latestNav ? readJsonPayload(latestNav.payload_json) : {};
      const lastUrl = resolveLastUrl(navPayload) ?? session.url_last ?? undefined;
      const scope = classifySessionUrl(lastUrl);
      const connectionState = getSessionConnectionState?.(sessionId);
      const liveConnection = buildLiveConnectionRecord(session, scope, connectionState);

      return {
        ...createBaseResponse(sessionId),
        status: getSessionStatus(session),
        createdAt: session.created_at,
        lastSeenAt: resolveSessionLastSeenAt(session, connectionState),
        pausedAt: session.paused_at ?? undefined,
        endedAt: session.ended_at ?? undefined,
        tabId: session.tab_id ?? undefined,
        windowId: session.window_id ?? undefined,
        lastUrl,
        safeMode: session.safe_mode === 1,
        pinned: session.pinned === 1,
        scope,
        liveConnection,
        nextAction: buildLiveSessionNextAction(liveConnection, scope),
      };
    },

    list_override_profiles: async () => {
      const profiles = buildOverrideProfileRecords();

      return {
        ...createBaseResponse(),
        limitsApplied: {
          maxResults: profiles.length,
          truncated: false,
        },
        profiles,
        nextActions: profiles.length > 0
          ? [{ code: 'VALIDATE_PROFILE', message: 'Run validate_override_profile before enabling overrides.' }]
          : [{ code: 'CREATE_PROFILE', message: 'Run create_override_profile to generate a candidate profile.' }],
      };
    },

    create_override_profile: async (input) => {
      const adapterInput = normalizeOptionalString(input.adapter) ?? normalizeOptionalString(input.mode);
      let adapter: OverrideProfileAdapterId | undefined;
      if (adapterInput !== undefined) {
        if (!OVERRIDE_PROFILE_ADAPTERS.includes(adapterInput as OverrideProfileAdapterId)) {
          throw new Error(`adapter must be one of: ${OVERRIDE_PROFILE_ADAPTERS.join(', ')}`);
        }
        adapter = adapterInput as OverrideProfileAdapterId;
      }

      const targetBaseUrl = normalizeOptionalString(input.targetBaseUrl);
      if (!targetBaseUrl) {
        throw new Error('targetBaseUrl is required, for example https://example.com/_next/ or https://example.com/assets/');
      }

      const generated = createOverrideProfileConfig({
        adapter,
        targetBaseUrl,
        projectRoot: normalizeOptionalString(input.projectRoot),
        assetRoot: normalizeOptionalString(input.assetRoot),
        nextDir: normalizeOptionalString(input.nextDir),
        configPath: normalizeOptionalString(input.configPath),
        profileId: normalizeOptionalString(input.profileId),
        profileName: normalizeOptionalString(input.profileName),
        enabled: normalizeOptionalBooleanInput(input.enabled, 'enabled'),
        profileEnabled: normalizeOptionalBooleanInput(input.profileEnabled, 'profileEnabled'),
        autoReload: normalizeOptionalBooleanInput(input.autoReload, 'autoReload'),
        includeManifestFiles: normalizeOptionalBooleanInput(input.includeManifestFiles, 'includeManifestFiles'),
        includeStaticFiles: normalizeOptionalBooleanInput(input.includeStaticFiles, 'includeStaticFiles'),
        extensions: normalizeOptionalStringArrayInput(input.extensions, 'extensions'),
        maxRules: normalizeOptionalNumberInput(input.maxRules, 'maxRules'),
      });

      const writeConfig = normalizeOptionalBooleanInput(input.writeConfig, 'writeConfig') ?? false;
      const overwrite = normalizeOptionalBooleanInput(input.overwrite, 'overwrite') ?? false;
      const write: Record<string, unknown> = {
        written: false,
        path: generated.suggestedConfigPath,
      };
      let nextActions = generated.nextActions;

      if (writeConfig && generated.ruleCount === 0) {
        write.failureCode = 'NO_RULES';
        write.message = 'Generated profile has no rules; config was not written.';
        nextActions = [{
          code: 'BUILD_APP',
          message: 'Build the app so local assets exist, then generate the profile again.',
        }];
      } else if (writeConfig && existsSync(generated.suggestedConfigPath) && !overwrite) {
        write.failureCode = 'CONFIG_EXISTS';
        write.message = 'Config file already exists; pass overwrite=true or choose another configPath.';
        nextActions = [{
          code: 'OVERWRITE_OR_CHOOSE_CONFIG_PATH',
          message: 'Pass overwrite=true to replace the config file, or choose a different configPath.',
        }, ...generated.nextActions];
      } else if (writeConfig) {
        mkdirSync(dirname(generated.suggestedConfigPath), { recursive: true });
        writeFileSync(generated.suggestedConfigPath, generated.configJson, 'utf8');
        write.written = true;
        write.bytes = Buffer.byteLength(generated.configJson, 'utf8');
        nextActions = generated.nextActions.filter((action) => action.code !== 'SAVE_LOCAL_CONFIG');
      }

      return {
        ...createBaseResponse(),
        limitsApplied: {
          maxResults: generated.ruleCount,
          truncated: generated.warnings.some((warning) => warning.startsWith('Rule generation was limited')),
        },
        adapter: generated.adapter,
        mode: generated.mode,
        projectRoot: generated.projectRoot,
        assetRoot: generated.assetRoot,
        nextDir: generated.nextDir,
        targetBaseUrl: generated.targetBaseUrl,
        suggestedConfigPath: generated.suggestedConfigPath,
        ruleCount: generated.ruleCount,
        manifestFiles: generated.manifestFiles,
        staticFileCount: generated.staticFileCount,
        missingManifestAssetCount: generated.missingManifestAssetCount,
        warnings: generated.warnings,
        nextActions,
        write,
        profile: generated.profile,
        config: generated.config,
        configJson: generated.configJson,
      };
    },

    validate_override_profile: async (input) => {
      const profile = resolveOverrideProfileRecord(input.profileId);
      const issues = buildOverrideProfileIssues(profile);

      return {
        ...createBaseResponse(),
        profileId: profile.profileId,
        valid: !issues.some((issue) => issue.severity === 'error'),
        issues,
        nextActions: buildOverrideProfileNextActions(profile, issues),
        profile,
      };
    },

    preflight_overrides: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const preflight = buildOverridePreflight({
        db,
        sessionId,
        profileId: input.profileId,
        getSessionConnectionState,
      });

      return {
        ...createBaseResponse(sessionId),
        ...preflight,
      };
    },

    list_observed_override_assets: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const assets = listObservedOverrideAssets(getDb(), {
        sessionId,
        limit: typeof input.limit === 'number' ? input.limit : undefined,
        sinceTimestamp: typeof input.sinceTimestamp === 'number' ? input.sinceTimestamp : undefined,
      });

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: assets.length,
          truncated: false,
        },
        assets,
      };
    },

    plan_override_response_patch: async (input) => {
      const sessionId = getSessionId(input);
      const plan = planOverrideResponsePatch(input);
      const variantContext = buildOverrideVariantContext({
        targetUrl: plan.targetUrl,
        requestMethod: plan.requestMethod,
        matchMode: plan.matchMode,
        ruleType: plan.ruleType,
        captureMode: input.captureMode,
        source: input.source,
        triggerReload: input.triggerReload,
        requestHeaders: input.requestHeaders,
      });
      const auditPlan = persistResponsePlanAudit({
        db: getDb(),
        sessionId,
        input,
        plan,
        variantContext,
      });

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: plan.rule ? 1 : 0,
          truncated: false,
        },
        variantContext,
        audit: {
          persisted: auditPlan !== undefined,
          plans: auditPlan ? [auditPlan] : [],
        },
        ...plan,
      };
    },

    map_next_override_assets: async (input) => {
      const projectRoot = normalizeOptionalString(input.projectRoot);
      if (!projectRoot) {
        throw new Error('projectRoot is required');
      }

      const sessionId = getSessionId(input);
      const observedAssets = Array.isArray(input.observedAssets)
        ? input.observedAssets
        : sessionId
          ? listObservedOverrideAssets(getDb(), { sessionId })
          : input.observedAssets;

      const mapping = await mapNextOverrideAssetsWithDrift({
        projectRoot,
        nextDir: normalizeOptionalString(input.nextDir),
        observedAssets,
        sourcePaths: input.sourcePaths,
        route: input.route,
        maxResults: input.maxResults,
        fetchProductionAssets: input.fetchProductionAssets,
        productionFetchTimeoutMs: input.productionFetchTimeoutMs,
        maxProductionAssetBytes: input.maxProductionAssetBytes,
        maxDriftCandidates: input.maxDriftCandidates,
        productionFetchConcurrency: input.productionFetchConcurrency,
      });

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: mapping.candidates.length,
          truncated: false,
        },
        observedFromPersisted: !Array.isArray(input.observedAssets) && sessionId
          ? { sessionId, assetCount: Array.isArray(observedAssets) ? observedAssets.length : 0 }
          : undefined,
        ...mapping,
      };
    },

    plan_next_source_override: async (input) => {
      const projectRoot = normalizeOptionalString(input.projectRoot);
      if (!projectRoot) {
        throw new Error('projectRoot is required');
      }

      const sessionId = getSessionId(input);
      const observedAssets = Array.isArray(input.observedAssets)
        ? input.observedAssets
        : sessionId
          ? listObservedOverrideAssets(getDb(), { sessionId })
          : input.observedAssets;

      const plan = await planNextSourceOverride({
        projectRoot,
        nextDir: normalizeOptionalString(input.nextDir),
        observedAssets,
        sourceEdits: input.sourceEdits,
        sourcePaths: input.sourcePaths,
        route: input.route,
        configPath: input.configPath,
        writeConfig: input.writeConfig,
        overwrite: input.overwrite,
        enabled: input.enabled,
        profileEnabled: input.profileEnabled,
        autoReload: input.autoReload,
        profileId: input.profileId,
        profileName: input.profileName,
        buildTimeoutMs: input.buildTimeoutMs,
        maxRules: input.maxRules,
        fetchProductionAssets: input.fetchProductionAssets,
        productionFetchTimeoutMs: input.productionFetchTimeoutMs,
        maxProductionAssetBytes: input.maxProductionAssetBytes,
        maxDriftCandidates: input.maxDriftCandidates,
        productionFetchConcurrency: input.productionFetchConcurrency,
        overlayTtlMs: input.overlayTtlMs,
      });
      const auditPlans = persistNextSourcePlanAudits({
        db: getDb(),
        sessionId,
        input,
        plan,
      });

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: plan.rules.length,
          truncated: false,
        },
        observedFromPersisted: !Array.isArray(input.observedAssets) && sessionId
          ? { sessionId, assetCount: Array.isArray(observedAssets) ? observedAssets.length : 0 }
          : undefined,
        audit: {
          persisted: auditPlans.length > 0,
          plans: auditPlans,
        },
        ...plan,
      };
    },

    get_override_status: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      const profile = resolveOverrideProfileRecord(input.profileId);
      const latestRun = sessionId ? listOverridePocRuns(db, sessionId, 1, 0).runs[0] ?? null : null;
      const recentRequests = sessionId
        ? listOverridePocRequests(db, sessionId, 5, 0, latestRun?.runId).requests
        : [];
      const recentPlans = sessionId
        ? listOverridePlanAudits(db, { sessionId, limit: 5, offset: 0 }).plans
        : [];

      return {
        ...createBaseResponse(sessionId),
        profile,
        latestRun,
        recentRequests,
        recentPlans,
        preflight: sessionId
          ? buildOverridePreflight({
              db,
              sessionId,
              profileId: input.profileId,
              getSessionConnectionState,
            })
          : null,
        diagnosis: sessionId ? diagnoseOverridePoc(db, sessionId, latestRun?.runId) : null,
        nextActions: latestRun?.lastErrorCode
          ? [{ code: 'DIAGNOSE_OVERRIDES', message: 'Run diagnose_overrides for the latest failed override run.' }]
          : latestRun
            ? [{ code: 'GET_OVERRIDE_REQUEST_LOG', message: 'Inspect get_override_request_log for matched and fulfilled requests.' }]
            : [{ code: 'ENABLE_OVERRIDES', message: 'Enable overrides on a connected session after profile validation succeeds.' }],
      };
    },

    get_override_request_log: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const limit = resolveLimit(input.limit, DEFAULT_EVENT_LIMIT);
      const offset = resolveOffset(input.offset);
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);
      const runId = typeof input.runId === 'string' && input.runId.trim().length > 0
        ? input.runId.trim()
        : undefined;
      const result = listOverridePocRequests(db, sessionId, limit, offset, runId);
      const bytePage = applyByteBudget(result.requests, maxResponseBytes);
      const truncated = result.hasMore || bytePage.truncatedByBytes;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        runId: runId ?? null,
        pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
        responseBytes: bytePage.responseBytes,
        requests: bytePage.items,
        nextActions: bytePage.items.length === 0
          ? [{ code: 'RELOAD_TAB', message: 'Reload the selected tab after enabling overrides so matching requests are observed.' }]
          : [{ code: 'DIAGNOSE_OVERRIDES', message: 'Run diagnose_overrides if any matched request failed or did not fulfill.' }],
      };
    },

    get_override_plan_log: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const limit = resolveLimit(input.limit, DEFAULT_EVENT_LIMIT);
      const offset = resolveOffset(input.offset);
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);
      const planId = typeof input.planId === 'string' && input.planId.trim().length > 0
        ? input.planId.trim()
        : undefined;
      const result = listOverridePlanAudits(db, { sessionId, limit, offset, planId });
      const bytePage = applyByteBudget(result.plans, maxResponseBytes);
      const truncated = result.hasMore || bytePage.truncatedByBytes;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        planId: planId ?? null,
        pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
        responseBytes: bytePage.responseBytes,
        plans: bytePage.items,
        nextActions: bytePage.items.length === 0
          ? [{ code: 'PLAN_OVERRIDE', message: 'Run plan_override_response_patch or plan_next_source_override with sessionId to persist generated rule metadata.' }]
          : [{ code: 'REVIEW_ROLLBACK', message: 'Review rollback metadata before enabling or deleting generated override files.' }],
      };
    },

    diagnose_overrides: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const runId = typeof input.runId === 'string' && input.runId.trim().length > 0
        ? input.runId.trim()
        : undefined;

      const diagnosis = diagnoseOverridePoc(db, sessionId, runId);
      const firstIssue = diagnosis.issues[0];

      return {
        ...createBaseResponse(sessionId),
        diagnosis,
        nextActions: firstIssue?.suggestedActions[0]
          ? [{ code: firstIssue.code, message: firstIssue.suggestedActions[0] }]
          : [{ code: 'NO_DIAGNOSIS_ISSUES', message: 'No diagnosis issues were found for the selected override run.' }],
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

export function createV2ToolHandlers(
  captureClient: CaptureCommandClient,
  getDb?: () => Database,
  getSessionConnectionState?: (sessionId: string) => SessionConnectionLookupResult | undefined,
): Partial<Record<string, ToolHandler>> {
  return {
    observe_override_assets: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const tabId = resolveOptionalTabId(input.tabId);
      const capture = await executeLiveCapture(
        captureClient,
        sessionId,
        'CAPTURE_OVERRIDE_OBSERVE_ASSETS',
        { tabId, includePerformance: input.includePerformance !== false },
        5_000,
      );
      const payload = ensureCaptureSuccess(capture, sessionId);
      const assetCount = Array.isArray(payload.assets) ? payload.assets.length : 0;
      const persisted = getDb
        ? persistObservedOverrideAssets(getDb(), { ...payload, sessionId, tabId: payload.tabId ?? tabId })
        : undefined;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: assetCount,
          truncated: capture.truncated ?? false,
        },
        persisted,
        ...payload,
        nextActions: assetCount > 0
          ? [{ code: 'MAP_NEXT_ASSETS', message: 'Run map_next_override_assets with projectRoot and sourcePaths to score override candidates.' }]
          : [{ code: 'LOAD_ROUTE', message: 'Load or interact with the target route so document, asset, and fetch resources are requested, then observe again.' }],
      };
    },

    capture_override_response_body: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const targetUrl = normalizeOptionalString(input.targetUrl) ?? normalizeOptionalString(input.targetAssetUrl);
      if (!targetUrl) {
        throw new Error('targetUrl is required');
      }
      assertOverrideResponseRequestCaptureSafe({
        requestMethod: input.requestMethod,
        requestHeaders: input.requestHeaders,
        subject: 'Response body capture request',
      });

      const tabId = resolveOptionalTabId(input.tabId);
      const timeoutMs = resolveTimeoutMs(input.timeoutMs, 10_000, 60_000);
      const capture = await executeLiveCapture(
        captureClient,
        sessionId,
        'CAPTURE_OVERRIDE_RESPONSE_BODY',
        {
          targetUrl,
          tabId,
          captureMode: normalizeOptionalString(input.captureMode),
          triggerReload: typeof input.triggerReload === 'boolean' ? input.triggerReload : undefined,
          matchMode: normalizeOptionalString(input.matchMode),
          requestMethod: input.requestMethod,
          requestHeaders: isRecord(input.requestHeaders) ? input.requestHeaders : undefined,
          timeoutMs,
          maxBodyBytes: input.maxBodyBytes,
          includeBody: input.includeBody === true,
        },
        timeoutMs + 2_000,
      );
      const payload = ensureCaptureSuccess(capture, sessionId);

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 1,
          truncated: capture.truncated ?? payload.truncated === true,
        },
        ...payload,
        nextActions: payload.bodyCaptured === true
          ? [{ code: 'PLAN_RESPONSE_PATCH', message: 'Run plan_override_response_patch with textPatches or jsonPatches to generate an exact response override.' }]
          : [{ code: 'UNSUPPORTED_RESPONSE_BODY', message: 'Only bounded text-like response bodies can be patched safely.' }],
      };
    },

    plan_override_response_patch: async (input) => {
      const sessionId = getSessionId(input);
      let plannerInput: ToolInput = input;
      let capturedFromLiveSession: Record<string, unknown> | undefined;
      const hasProvidedBody = typeof input.responseBodyText === 'string'
        || typeof input.bodyText === 'string'
        || typeof input.responseBodyBase64 === 'string'
        || typeof input.bodyBase64 === 'string';

      if (!hasProvidedBody && sessionId) {
        const targetUrl = normalizeOptionalString(input.targetUrl) ?? normalizeOptionalString(input.targetAssetUrl);
        if (!targetUrl) {
          throw new Error('targetUrl is required');
        }
        const tabId = resolveOptionalTabId(input.tabId);
        const timeoutMs = resolveTimeoutMs(input.timeoutMs, 10_000, 60_000);
        const capture = await executeLiveCapture(
          captureClient,
          sessionId,
          'CAPTURE_OVERRIDE_RESPONSE_BODY',
          {
            targetUrl,
            tabId,
            captureMode: normalizeOptionalString(input.captureMode),
            triggerReload: typeof input.triggerReload === 'boolean' ? input.triggerReload : undefined,
            matchMode: normalizeOptionalString(input.matchMode),
            requestMethod: input.requestMethod,
            requestHeaders: isRecord(input.requestHeaders) ? input.requestHeaders : undefined,
            timeoutMs,
            maxBodyBytes: input.maxBodyBytes,
            includeBody: true,
          },
          timeoutMs + 2_000,
        );
        const payload = ensureCaptureSuccess(capture, sessionId);
        if (payload.truncated === true) {
          throw new Error('Captured response body was truncated; increase maxBodyBytes before planning a patch.');
        }
        if (typeof payload.bodyText !== 'string') {
          throw new Error('Captured response did not include a text body that can be patched.');
        }
        plannerInput = {
          ...input,
          responseBodyText: payload.bodyText,
          contentType: input.contentType ?? payload.contentType,
          ruleType: input.ruleType ?? payload.ruleType,
          requestMethod: input.requestMethod ?? payload.requestMethod,
          captureMode: input.captureMode ?? payload.captureMode,
          source: payload.source,
          requestHeaders: payload.requestHeaders,
        };
        const variantContext = buildOverrideVariantContext({
          targetUrl: payload.targetUrl,
          requestMethod: input.requestMethod ?? payload.requestMethod,
          matchMode: payload.matchMode,
          ruleType: input.ruleType ?? payload.ruleType,
          captureMode: payload.captureMode,
          source: payload.source,
          triggerReload: payload.triggerReload,
          requestHeaders: payload.requestHeaders,
        });
        capturedFromLiveSession = {
          sessionId,
          targetUrl: payload.targetUrl,
          requestMethod: input.requestMethod ?? payload.requestMethod,
          statusCode: payload.statusCode,
          contentType: payload.contentType,
          bodyBytes: payload.bodyBytes,
          capturedBytes: payload.capturedBytes,
          truncated: payload.truncated === true,
          ruleType: payload.ruleType,
          matchMode: payload.matchMode,
          captureMode: payload.captureMode,
          source: payload.source,
          tabId: payload.tabId,
          triggerReload: payload.triggerReload,
          requestHeaders: payload.requestHeaders,
          variantContext,
        };
      }

      const plan = planOverrideResponsePatch(plannerInput);
      const variantContext = buildOverrideVariantContext({
        targetUrl: plan.targetUrl,
        requestMethod: plan.requestMethod,
        matchMode: plan.matchMode,
        ruleType: plan.ruleType,
        captureMode: plannerInput.captureMode,
        source: plannerInput.source,
        triggerReload: plannerInput.triggerReload,
        requestHeaders: plannerInput.requestHeaders,
      });
      const auditPlan = getDb
        ? persistResponsePlanAudit({
            db: getDb(),
            sessionId,
            input,
            plan,
            capturedFromLiveSession,
            variantContext,
          })
        : undefined;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: plan.rule ? 1 : 0,
          truncated: false,
        },
        capturedFromLiveSession,
        variantContext,
        audit: {
          persisted: auditPlan !== undefined,
          plans: auditPlan ? [auditPlan] : [],
        },
        ...plan,
      };
    },

    map_next_override_assets: async (input) => {
      const projectRoot = normalizeOptionalString(input.projectRoot);
      if (!projectRoot) {
        throw new Error('projectRoot is required');
      }

      const sessionId = getSessionId(input);
      let observedAssets = input.observedAssets;
      let observedFromLiveTab: Record<string, unknown> | undefined;
      let observedFromPersisted: { sessionId: string; assetCount: number } | undefined;
      if (!Array.isArray(observedAssets) && sessionId) {
        const tabId = resolveOptionalTabId(input.tabId);
        try {
          const capture = await executeLiveCapture(
            captureClient,
            sessionId,
            'CAPTURE_OVERRIDE_OBSERVE_ASSETS',
            { tabId, includePerformance: true },
            5_000,
          );
          observedFromLiveTab = ensureCaptureSuccess(capture, sessionId);
          observedAssets = observedFromLiveTab.assets;
          if (getDb) {
            persistObservedOverrideAssets(getDb(), { ...observedFromLiveTab, sessionId, tabId: observedFromLiveTab.tabId ?? tabId });
          }
        } catch (error) {
          if (!getDb || !isLiveSessionDisconnectedError(error)) {
            throw error;
          }
          observedAssets = listObservedOverrideAssets(getDb(), { sessionId });
          observedFromPersisted = { sessionId, assetCount: Array.isArray(observedAssets) ? observedAssets.length : 0 };
        }
      }

      const mapping = await mapNextOverrideAssetsWithDrift({
        projectRoot,
        nextDir: normalizeOptionalString(input.nextDir),
        observedAssets,
        sourcePaths: input.sourcePaths,
        route: input.route,
        maxResults: input.maxResults,
        fetchProductionAssets: input.fetchProductionAssets,
        productionFetchTimeoutMs: input.productionFetchTimeoutMs,
        maxProductionAssetBytes: input.maxProductionAssetBytes,
        maxDriftCandidates: input.maxDriftCandidates,
        productionFetchConcurrency: input.productionFetchConcurrency,
      });

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: mapping.candidates.length,
          truncated: false,
        },
        observedFromLiveTab: observedFromLiveTab
          ? {
              pageUrl: observedFromLiveTab.pageUrl,
              tabId: observedFromLiveTab.tabId,
              assetCount: Array.isArray(observedFromLiveTab.assets) ? observedFromLiveTab.assets.length : 0,
            }
          : undefined,
        observedFromPersisted,
        ...mapping,
      };
    },

    plan_next_source_override: async (input) => {
      const projectRoot = normalizeOptionalString(input.projectRoot);
      if (!projectRoot) {
        throw new Error('projectRoot is required');
      }

      const sessionId = getSessionId(input);
      let observedAssets = input.observedAssets;
      let observedFromLiveTab: Record<string, unknown> | undefined;
      let observedFromPersisted: { sessionId: string; assetCount: number } | undefined;
      if (!Array.isArray(observedAssets) && sessionId) {
        const tabId = resolveOptionalTabId(input.tabId);
        try {
          const capture = await executeLiveCapture(
            captureClient,
            sessionId,
            'CAPTURE_OVERRIDE_OBSERVE_ASSETS',
            { tabId, includePerformance: true },
            5_000,
          );
          observedFromLiveTab = ensureCaptureSuccess(capture, sessionId);
          observedAssets = observedFromLiveTab.assets;
          if (getDb) {
            persistObservedOverrideAssets(getDb(), { ...observedFromLiveTab, sessionId, tabId: observedFromLiveTab.tabId ?? tabId });
          }
        } catch (error) {
          if (!getDb || !isLiveSessionDisconnectedError(error)) {
            throw error;
          }
          observedAssets = listObservedOverrideAssets(getDb(), { sessionId });
          observedFromPersisted = { sessionId, assetCount: Array.isArray(observedAssets) ? observedAssets.length : 0 };
        }
      }

      const plan = await planNextSourceOverride({
        projectRoot,
        nextDir: normalizeOptionalString(input.nextDir),
        observedAssets,
        sourceEdits: input.sourceEdits,
        sourcePaths: input.sourcePaths,
        route: input.route,
        configPath: input.configPath,
        writeConfig: input.writeConfig,
        overwrite: input.overwrite,
        enabled: input.enabled,
        profileEnabled: input.profileEnabled,
        autoReload: input.autoReload,
        profileId: input.profileId,
        profileName: input.profileName,
        buildTimeoutMs: input.buildTimeoutMs,
        maxRules: input.maxRules,
        fetchProductionAssets: input.fetchProductionAssets,
        productionFetchTimeoutMs: input.productionFetchTimeoutMs,
        maxProductionAssetBytes: input.maxProductionAssetBytes,
        maxDriftCandidates: input.maxDriftCandidates,
        productionFetchConcurrency: input.productionFetchConcurrency,
        overlayTtlMs: input.overlayTtlMs,
      });
      const auditPlans = getDb
        ? persistNextSourcePlanAudits({
            db: getDb(),
            sessionId,
            input,
            plan,
          })
        : [];

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: plan.rules.length,
          truncated: false,
        },
        observedFromLiveTab: observedFromLiveTab
          ? {
              pageUrl: observedFromLiveTab.pageUrl,
              tabId: observedFromLiveTab.tabId,
              assetCount: Array.isArray(observedFromLiveTab.assets) ? observedFromLiveTab.assets.length : 0,
            }
          : undefined,
        observedFromPersisted,
        audit: {
          persisted: auditPlans.length > 0,
          plans: auditPlans,
        },
        ...plan,
      };
    },

    get_override_status: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const capture = await executeLiveCapture(
        captureClient,
        sessionId,
        'CAPTURE_OVERRIDE_POC_GET_STATUS',
        {},
        3_000,
      );
      const payload = ensureCaptureSuccess(capture, sessionId);

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 1,
          truncated: capture.truncated ?? false,
        },
        preflight: getDb
          ? buildOverridePreflight({
              db: getDb(),
              sessionId,
              profileId: input.profileId,
              getSessionConnectionState,
            })
          : null,
        ...payload,
        nextActions: payload.lastErrorCode
          ? [{ code: 'DIAGNOSE_OVERRIDES', message: 'Run diagnose_overrides for the latest override failure.' }]
          : payload.active === true
            ? [{ code: 'GET_OVERRIDE_REQUEST_LOG', message: 'Inspect get_override_request_log after the target tab loads matching assets.' }]
            : [{ code: 'ENABLE_OVERRIDES', message: 'Enable overrides after validating the selected profile.' }],
      };
    },

    preflight_overrides: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }
      if (!getDb) {
        throw new Error('preflight_overrides requires database-backed override state');
      }

      return {
        ...createBaseResponse(sessionId),
        ...buildOverridePreflight({
          db: getDb(),
          sessionId,
          profileId: input.profileId,
          getSessionConnectionState,
        }),
      };
    },

    enable_overrides: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }
      const preflight = getDb
        ? buildOverridePreflight({
            db: getDb(),
            sessionId,
            profileId: input.profileId,
            getSessionConnectionState,
          })
        : null;
      if (preflight && preflight.ready !== true) {
        const blockingCodes = Array.isArray(preflight.issues)
          ? preflight.issues
            .filter((issue): issue is Record<string, unknown> => isRecord(issue) && issue.severity === 'error')
            .map((issue) => String(issue.code ?? 'UNKNOWN'))
          : [];
        const profile = isRecord(preflight.profile) ? preflight.profile : {};
        if (!canBypassPreflightForExperimentalRsc(profile, blockingCodes)) {
          throw new Error(`Override preflight failed: ${blockingCodes.join(', ') || 'UNKNOWN'}`);
        }
      }

      const tabId = resolveOptionalTabId(input.tabId);
      const capture = await executeLiveCapture(
        captureClient,
        sessionId,
        'CAPTURE_OVERRIDE_POC_ENABLE',
        { tabId },
        8_000,
      );
      const payload = ensureCaptureSuccess(capture, sessionId);

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 1,
          truncated: capture.truncated ?? false,
        },
        preflight,
        ...payload,
        nextActions: [{ code: 'RELOAD_OR_INTERACT', message: 'Reload or interact with the tab so configured asset requests occur under the active override.' }],
      };
    },

    disable_overrides: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const capture = await executeLiveCapture(
        captureClient,
        sessionId,
        'CAPTURE_OVERRIDE_POC_DISABLE',
        {},
        5_000,
      );
      const payload = ensureCaptureSuccess(capture, sessionId);

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 1,
          truncated: capture.truncated ?? false,
        },
        ...payload,
        nextActions: [{ code: 'VERIFY_DISABLED', message: 'Run get_override_status if you need to confirm the debugger override is inactive.' }],
      };
    },

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
  const v2Handlers = options.captureClient
    ? createV2ToolHandlers(options.captureClient, () => getConnection().db, options.getSessionConnectionState)
    : {};
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
