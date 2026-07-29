import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { pathToFileURL } from 'url';
import { WebSocketManager } from './websocket/websocket-server.js';
import { initializeDatabase, getConnection, getDatabasePath } from './db/index.js';
import { resetDatabase } from './db/migrations.js';
import { getRuntimeDataDir } from './runtime-paths.js';
import {
  exportSessionToJson,
  exportSessionToZip,
  getRetentionSettings,
  importSessionFromJson,
  importSessionFromZipBase64,
  listSnapshots,
  runRetentionCleanup,
  setSessionPinned,
  shouldRunCleanup,
  updateRetentionSettings,
  writeSnapshot,
} from './retention.js';
import {
  getOverridePocAssetResponse,
  getOverridePocConfigSummary,
  type OverridePocConfigSummary,
  type OverridePocRuleSummary,
} from './override-poc.js';
import {
  diagnoseOverridePoc,
  insertOverridePlanAudit,
  listOverridePlanAudits,
  listOverridePocRequests,
  listOverridePocRuns,
  upsertOverridePocRequest,
  upsertOverridePocRun,
} from './override-audit.js';
import {
  isOverridePlanAuditKind,
  type OverridePlanAuditRecord,
  type OverridePocRequestRecord,
  type OverridePocRunRecord,
  isOverridePocFailureCode,
  isOverridePocRequestStatus,
  isOverridePocRunStatus,
  type MockRouteRecord,
} from './override-audit-contract.js';
import {
  buildMockRouteResponse,
  findActiveBrowserMockRoute,
  findActiveSsrMockRoute,
  insertMockHit,
  insertMockRun,
  listActiveBrowserMockRoutes,
} from './mock-store.js';
import { registerCliGateway } from './cli/gateway.js';
import { CaptureCommandSchema, type CaptureCommand } from './websocket/messages.js';

const fastify = Fastify({
  logger: process.env.MCP_STDIO_MODE === '1' ? false : true
});

registerCliGateway(fastify, {
  getWebSocketManager: () => wsManager,
});

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8065;
const HOST = process.env.HOST || '127.0.0.1';
let wsManager: WebSocketManager | null = null;
const startedAt = Date.now();
let cleanupInterval: NodeJS.Timeout | null = null;
let lastCleanupResult: ReturnType<typeof runRetentionCleanup> | null = null;
const MAX_SESSION_IMPORT_BYTES = 10 * 1024 * 1024;
const MOCK_ROUTE_LOCAL_PATH_PREFIX = 'bdmcp-mock-route:';
const CAPTURE_PAYLOAD_KEYS: Record<CaptureCommand, readonly string[]> = {
  CAPTURE_DOM_SUBTREE: ['selector', 'maxDepth', 'maxBytes', 'tabId', 'frameId', 'frameUrlContains'],
  CAPTURE_DOM_DOCUMENT: ['mode', 'maxDepth', 'maxBytes', 'tabId', 'frameId', 'frameUrlContains'],
  CAPTURE_COMPUTED_STYLES: ['selector', 'properties', 'tabId', 'frameId', 'frameUrlContains'],
  CAPTURE_LAYOUT_METRICS: ['selector', 'tabId', 'frameId', 'frameUrlContains'],
  CAPTURE_PAGE_STATE: [
    'maxItems',
    'maxTextLength',
    'includeButtons',
    'includeLinks',
    'includeInputs',
    'includeModals',
    'tabId',
    'frameId',
    'frameUrlContains',
  ],
  CAPTURE_UI_SNAPSHOT: [
    'selector',
    'trigger',
    'mode',
    'styleMode',
    'explicitStyleMode',
    'maxDepth',
    'maxBytes',
    'maxAncestors',
    'includeDom',
    'includeStyles',
    'includePngDataUrl',
    'llmRequested',
    'tabId',
  ],
  CAPTURE_GET_LIVE_CONSOLE_LOGS: [
    'origin',
    'url',
    'tabId',
    'levels',
    'contains',
    'sinceTs',
    'includeRuntimeErrors',
    'dedupeWindowMs',
    'limit',
  ],
  CAPTURE_WAIT_FOR_NAVIGATION_LIFECYCLE: [
    'state',
    'urlContains',
    'urlRegex',
    'exactUrl',
    'tabId',
    'timeoutMs',
  ],
  CAPTURE_WAIT_FOR_DIALOG: [
    'type',
    'messageContains',
    'urlContains',
    'action',
    'promptText',
    'tabId',
    'timeoutMs',
  ],
  CAPTURE_WAIT_FOR_STABLE_LAYOUT: ['selector', 'stableMs', 'tabId', 'timeoutMs', 'pollIntervalMs'],
  CAPTURE_WAIT_FOR_DOWNLOAD: [
    'urlContains',
    'urlRegex',
    'exactUrl',
    'filenameContains',
    'filenameRegex',
    'state',
    'tabId',
    'timeoutMs',
  ],
  CAPTURE_WAIT_FOR_POPUP: ['urlContains', 'urlRegex', 'exactUrl', 'openerTabId', 'timeoutMs'],
  CAPTURE_OVERRIDE_OBSERVE_ASSETS: ['tabId', 'includePerformance'],
  CAPTURE_OVERRIDE_RESPONSE_BODY: [
    'targetUrl',
    'targetAssetUrl',
    'tabId',
    'captureMode',
    'triggerReload',
    'matchMode',
    'ruleType',
    'requestMethod',
    'requestHeaders',
    'timeoutMs',
    'maxBodyBytes',
    'includeBody',
  ],
  CAPTURE_OVERRIDE_POC_GET_STATUS: [],
  CAPTURE_OVERRIDE_POC_ENABLE: ['tabId'],
  CAPTURE_OVERRIDE_POC_DISABLE: [],
  SET_VIEWPORT: ['width', 'height', 'tabId'],
  EXECUTE_UI_ACTION: ['action', 'input', 'target', 'traceId'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateCapturePayload(
  command: CaptureCommand,
  payload: unknown,
): Record<string, unknown> {
  if (payload === undefined) {
    return {};
  }
  if (!isRecord(payload)) {
    throw new Error('payload must be an object');
  }

  const acceptedKeys = CAPTURE_PAYLOAD_KEYS[command];

  const unknownKeys = Object.keys(payload).filter((key) => !acceptedKeys.includes(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `Unknown payload key${unknownKeys.length === 1 ? '' : 's'} for ${command}: ${unknownKeys.join(', ')}. `
      + `Accepted keys: ${acceptedKeys.join(', ') || '(none)'}`,
    );
  }

  return payload;
}

function hasSession(sessionId: string): boolean {
  const row = getConnection().db.prepare('SELECT 1 FROM sessions WHERE session_id = ?').get(sessionId);
  return Boolean(row);
}

function parseLimit(value: unknown, fallback: number, max: number): number {
  const raw = typeof value === 'number' ? value : Number(value ?? fallback);
  return Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 1), max) : fallback;
}

function parseOffset(value: unknown): number {
  const raw = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(raw) ? Math.max(Math.floor(raw), 0) : 0;
}

function requireStringField(body: Record<string, unknown>, fieldName: string): string {
  const value = body[fieldName];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function inferMockRouteContentType(route: MockRouteRecord): string {
  const configured = route.responseHeaders['content-type'];
  if (configured) {
    return configured;
  }
  return route.bodyKind === 'json'
    ? 'application/json; charset=utf-8'
    : route.bodyKind === 'text'
      ? 'text/plain; charset=utf-8'
      : 'application/octet-stream';
}

function estimateMockRouteBodySize(route: MockRouteRecord): number | null {
  switch (route.bodyKind) {
    case 'json':
      return Buffer.byteLength(JSON.stringify(route.bodyJson ?? null), 'utf8');
    case 'text':
      return Buffer.byteLength(route.bodyText ?? '', 'utf8');
    case 'base64':
      return Buffer.from(route.bodyBase64 ?? '', 'base64').byteLength;
    case 'file':
      return null;
  }
}

function toMockOverrideRule(route: MockRouteRecord): OverridePocRuleSummary {
  const localFilePath = `${MOCK_ROUTE_LOCAL_PATH_PREFIX}${route.routeId}`;
  return {
    ruleId: `mock-route-${route.routeId}`,
    enabled: route.enabled,
    ruleType: 'api-response',
    requestMethod: route.method,
    matchMode: route.matchMode,
    allowExperimentalRscFlightFulfillment: false,
    targetAssetUrl: route.targetUrl,
    localFilePath,
    resolvedLocalFilePath: localFilePath,
    contentType: inferMockRouteContentType(route),
    fileExists: true,
    fileSizeBytes: estimateMockRouteBodySize(route),
  };
}

function getOverridePocConfigSummaryWithBrowserMocks(): OverridePocConfigSummary {
  const db = getConnection().db;
  const summary = getOverridePocConfigSummary();
  const mockRules = listActiveBrowserMockRoutes(db).map(toMockOverrideRule);
  if (mockRules.length === 0) {
    return summary;
  }

  const rules = [...mockRules, ...summary.rules];
  const primaryRule = mockRules[0] ?? rules[0];
  return {
    ...summary,
    enabled: true,
    profileName: `${summary.profileName} + browser mocks`,
    configPath: `${summary.configPath};mock-routes-db`,
    rules,
    ruleCount: rules.length,
    enabledRuleCount: rules.filter((rule) => rule.enabled).length,
    ruleType: primaryRule.ruleType,
    requestMethod: primaryRule.requestMethod,
    matchMode: primaryRule.matchMode,
    targetAssetUrl: primaryRule.targetAssetUrl,
    localFilePath: primaryRule.localFilePath,
    resolvedLocalFilePath: primaryRule.resolvedLocalFilePath,
    contentType: primaryRule.contentType,
    fileExists: true,
    fileSizeBytes: primaryRule.fileSizeBytes,
  };
}

function normalizeRequestMethod(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().toUpperCase() : 'GET';
}

async function applyMockRouteDelay(route: MockRouteRecord): Promise<void> {
  if (route.delayMs <= 0) {
    return;
  }
  const delayMs = Math.min(route.delayMs, 30_000);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
}

function ensureMockRunForOverrideRequest(options: {
  route: MockRouteRecord;
  overrideRunId: string;
  sessionId: string;
  timestamp: number;
}): string {
  const mockRunId = `${options.overrideRunId}:${options.route.routeId}`;
  insertMockRun(getConnection().db, {
    runId: mockRunId,
    routeId: options.route.routeId,
    executionMode: 'browser',
    sessionId: options.sessionId,
    projectRoot: options.route.projectRoot,
    startedAt: options.timestamp,
    status: 'active',
  });
  return mockRunId;
}

function getSsrMockRequestPath(rawUrl: string | undefined, scope: string): string {
  const parsed = new URL(rawUrl ?? '/', 'http://bdmcp.local');
  const prefix = `/mock/ssr/${scope}`;
  const pathname = parsed.pathname;
  const suffix = pathname === prefix
    ? '/'
    : pathname.startsWith(`${prefix}/`)
      ? pathname.slice(prefix.length)
      : pathname;
  return `${suffix || '/'}${parsed.search}`;
}

function createMockHitId(prefix: string, routeId: string): string {
  return `${prefix}:${routeId}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

function optionalStringField(body: Record<string, unknown>, fieldName: string): string | null {
  const value = body[fieldName];
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string when provided`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requireIntegerField(body: Record<string, unknown>, fieldName: string): number {
  const value = body[fieldName];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
  return Math.floor(value);
}

function optionalIntegerField(body: Record<string, unknown>, fieldName: string): number | null {
  const value = body[fieldName];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number when provided`);
  }
  return Math.floor(value);
}

function requireBooleanField(body: Record<string, unknown>, fieldName: string): boolean {
  const value = body[fieldName];
  if (typeof value !== 'boolean') {
    throw new Error(`${fieldName} must be a boolean`);
  }
  return value;
}

function getDbStats(): { status: 'connected' | 'disconnected'; sessions: number; events: number; network: number; fingerprints: number; snapshots: number } {
  try {
    const db = getConnection().db;
    return {
      status: 'connected',
      sessions: (db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number }).count,
      events: (db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number }).count,
      network: (db.prepare('SELECT COUNT(*) as count FROM network').get() as { count: number }).count,
      fingerprints: (db.prepare('SELECT COUNT(*) as count FROM error_fingerprints').get() as { count: number }).count,
      snapshots: (db.prepare('SELECT COUNT(*) as count FROM snapshots').get() as { count: number }).count,
    };
  } catch {
    return {
      status: 'disconnected',
      sessions: 0,
      events: 0,
      network: 0,
      fingerprints: 0,
      snapshots: 0,
    };
  }
}

fastify.get('/health', async () => {
  const dbStats = getDbStats();
  
  const wsStats = wsManager?.getConnectionStats() ?? { total: 0, withSession: 0 };
  
  return { 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    database: dbStats.status,
    websocket: {
      connections: wsStats.total,
      activeSessions: wsStats.withSession
    }
  };
});

fastify.get('/stats', async () => {
  const dbStats = getDbStats();
  const wsStats = wsManager?.getConnectionStats() ?? { total: 0, withSession: 0 };
  const settings = getRetentionSettings(getConnection().db);

  return {
    timestamp: new Date().toISOString(),
    uptimeMs: Date.now() - startedAt,
    memory: process.memoryUsage(),
    database: dbStats,
    websocket: {
      connections: wsStats.total,
      activeSessions: wsStats.withSession,
    },
    retention: {
      settings,
      lastCleanup: lastCleanupResult,
    },
  };
});

fastify.get('/overrides/poc/config', async (_request, reply) => {
  try {
    return {
      ok: true,
      ...getOverridePocConfigSummaryWithBrowserMocks(),
    };
  } catch (error) {
    return reply.code(500).send({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to load override POC config',
    });
  }
});

fastify.get('/overrides/poc/asset', async (request, reply) => {
  const query = (request.query ?? {}) as { assetUrl?: string; requestMethod?: string };
  const assetUrl = typeof query.assetUrl === 'string' ? query.assetUrl.trim() : '';
  const requestMethod = typeof query.requestMethod === 'string' ? query.requestMethod.trim() : 'GET';
  if (!assetUrl) {
    return reply.code(400).send({
      ok: false,
      error: 'assetUrl query parameter is required',
    });
  }

  try {
    const mockRoute = findActiveBrowserMockRoute(getConnection().db, assetUrl, requestMethod);
    if (mockRoute) {
      await applyMockRouteDelay(mockRoute);
      const result = buildMockRouteResponse(mockRoute);
      for (const [name, value] of Object.entries(result.responseHeaders)) {
        reply.header(name, value);
      }
      reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
      reply.header('X-BDMCP-Mock', '1');
      reply.header('X-BDMCP-Mock-Route', result.route.routeId);
      reply.header('X-BDMCP-Mock-Response-Code', String(result.responseCode));
      return reply.send(result.buffer);
    }

    const result = getOverridePocAssetResponse(assetUrl, undefined, requestMethod);
    reply.header('Content-Type', result.contentType);
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    reply.header('X-BDMCP-Override-Poc', '1');
    reply.header('X-BDMCP-Override-Config', result.summary.configPath);
    reply.header('X-BDMCP-Override-Profile', result.summary.profileId);
    reply.header('X-BDMCP-Override-Rule', result.rule.ruleId);
    return reply.send(result.buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to resolve override asset';
    const statusCode = message.includes('disabled')
      ? 409
      : message.includes('does not exist') || message.includes('does not match')
        ? 404
        : 500;

    return reply.code(statusCode).send({
      ok: false,
      error: message,
    });
  }
});

async function handleSsrMockRequest(request: FastifyRequest, reply: FastifyReply) {
  const params = request.params as { scope?: string };
  const scope = typeof params.scope === 'string' ? params.scope.trim() : '';
  if (!scope) {
    return reply.code(400).send({
      ok: false,
      error: 'SSR mock scope is required',
    });
  }

  const requestPath = getSsrMockRequestPath(request.raw.url, scope);
  const requestMethod = normalizeRequestMethod(request.method);
  const db = getConnection().db;
  const route = findActiveSsrMockRoute(db, scope, requestPath, requestMethod);
  if (!route) {
    return reply.code(404).send({
      ok: false,
      error: `No active SSR mock route matched ${requestMethod} ${requestPath}`,
    });
  }

  const timestamp = Date.now();
  const runId = `ssr:${scope}:${route.routeId}`;
  insertMockRun(db, {
    runId,
    routeId: route.routeId,
    executionMode: 'ssr',
    sessionId: null,
    tabId: null,
    projectRoot: route.projectRoot,
    startedAt: timestamp,
    status: 'active',
  });

  try {
    await applyMockRouteDelay(route);
    const result = buildMockRouteResponse(route);
    for (const [name, value] of Object.entries(result.responseHeaders)) {
      reply.header(name, value);
    }
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    reply.header('X-BDMCP-Mock', '1');
    reply.header('X-BDMCP-Mock-Route', route.routeId);
    reply.header('X-BDMCP-Mock-Execution-Mode', 'ssr');
    insertMockHit(db, {
      hitId: createMockHitId('ssr-hit', route.routeId),
      runId,
      routeId: route.routeId,
      timestamp,
      requestUrl: requestPath,
      requestMethod,
      matched: true,
      fulfilled: true,
      statusCode: result.responseCode,
      responseSource: route.sourceKind,
      errorCode: null,
      errorMessage: null,
    });
    return reply.code(result.responseCode).send(result.buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to build SSR mock response';
    insertMockHit(db, {
      hitId: createMockHitId('ssr-hit', route.routeId),
      runId,
      routeId: route.routeId,
      timestamp,
      requestUrl: requestPath,
      requestMethod,
      matched: true,
      fulfilled: false,
      statusCode: 500,
      responseSource: route.sourceKind,
      errorCode: 'SSR_MOCK_RESPONSE_FAILED',
      errorMessage: message,
    });
    return reply.code(500).send({
      ok: false,
      error: message,
    });
  }
}

fastify.route({
  method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
  url: '/mock/ssr/:scope',
  handler: handleSsrMockRequest,
});

fastify.route({
  method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
  url: '/mock/ssr/:scope/*',
  handler: handleSsrMockRequest,
});

fastify.post('/sessions/:sessionId/overrides/runs', async (request, reply) => {
  const params = request.params as { sessionId: string };
  if (!hasSession(params.sessionId)) {
    return reply.code(404).send({ ok: false, error: 'Session not found' });
  }

  if (!isRecord(request.body)) {
    return reply.code(400).send({ ok: false, error: 'Invalid override run payload' });
  }

  try {
    const body = request.body;
    const runStatus = body.runStatus;
    if (!isOverridePocRunStatus(runStatus)) {
      throw new Error('runStatus must be a valid override run status');
    }

    const lastErrorCodeValue = body.lastErrorCode;
    if (lastErrorCodeValue !== undefined && lastErrorCodeValue !== null && !isOverridePocFailureCode(lastErrorCodeValue)) {
      throw new Error('lastErrorCode must be a valid override failure code when provided');
    }

    const record: OverridePocRunRecord = {
      runId: requireStringField(body, 'runId'),
      sessionId: params.sessionId,
      startedAt: requireIntegerField(body, 'startedAt'),
      endedAt: optionalIntegerField(body, 'endedAt'),
      runStatus,
      tabId: requireIntegerField(body, 'tabId'),
      selectedTabId: optionalIntegerField(body, 'selectedTabId'),
      targetAssetUrl: requireStringField(body, 'targetAssetUrl'),
      localFilePath: requireStringField(body, 'localFilePath'),
      resolvedLocalFilePath: requireStringField(body, 'resolvedLocalFilePath'),
      contentType: requireStringField(body, 'contentType'),
      autoReload: requireBooleanField(body, 'autoReload'),
      configPath: requireStringField(body, 'configPath'),
      fileExists: requireBooleanField(body, 'fileExists'),
      fileSizeBytes: optionalIntegerField(body, 'fileSizeBytes'),
      matchedRequests: requireIntegerField(body, 'matchedRequests'),
      fulfilledRequests: requireIntegerField(body, 'fulfilledRequests'),
      lastMatchedAt: optionalIntegerField(body, 'lastMatchedAt'),
      lastFulfilledAt: optionalIntegerField(body, 'lastFulfilledAt'),
      lastErrorCode: lastErrorCodeValue ?? null,
      lastErrorMessage: optionalStringField(body, 'lastErrorMessage'),
    };

    const mockRoute = findActiveBrowserMockRoute(getConnection().db, record.targetAssetUrl, normalizeRequestMethod(body.requestMethod));
    if (mockRoute) {
      insertMockRun(getConnection().db, {
        runId: `${record.runId}:${mockRoute.routeId}`,
        routeId: mockRoute.routeId,
        executionMode: 'browser',
        sessionId: params.sessionId,
        tabId: record.tabId,
        projectRoot: mockRoute.projectRoot,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        status: record.runStatus === 'disabled' ? 'stopped' : record.runStatus,
      });
    }

    return {
      ok: true,
      run: upsertOverridePocRun(getConnection().db, record),
    };
  } catch (error) {
    return reply.code(400).send({
      ok: false,
      error: error instanceof Error ? error.message : 'Invalid override run payload',
    });
  }
});

fastify.get('/sessions/:sessionId/overrides/runs', async (request, reply) => {
  const params = request.params as { sessionId: string };
  if (!hasSession(params.sessionId)) {
    return reply.code(404).send({ ok: false, error: 'Session not found' });
  }

  const query = (request.query ?? {}) as { limit?: string | number; offset?: string | number };
  const limit = parseLimit(query.limit, 20, 200);
  const offset = parseOffset(query.offset);
  const result = listOverridePocRuns(getConnection().db, params.sessionId, limit, offset);

  return {
    ok: true,
    sessionId: params.sessionId,
    limit,
    offset,
    hasMore: result.hasMore,
    nextOffset: result.nextOffset,
    runs: result.runs,
  };
});

fastify.post('/sessions/:sessionId/overrides/requests', async (request, reply) => {
  const params = request.params as { sessionId: string };
  if (!hasSession(params.sessionId)) {
    return reply.code(404).send({ ok: false, error: 'Session not found' });
  }

  if (!isRecord(request.body)) {
    return reply.code(400).send({ ok: false, error: 'Invalid override request payload' });
  }

  try {
    const body = request.body;
    const status = body.status;
    if (!isOverridePocRequestStatus(status)) {
      throw new Error('status must be a valid override request status');
    }

    const failureCodeValue = body.failureCode;
    if (failureCodeValue !== undefined && failureCodeValue !== null && !isOverridePocFailureCode(failureCodeValue)) {
      throw new Error('failureCode must be a valid override failure code when provided');
    }

    const record: OverridePocRequestRecord = {
      requestLogId: requireStringField(body, 'requestLogId'),
      runId: requireStringField(body, 'runId'),
      sessionId: params.sessionId,
      requestId: requireStringField(body, 'requestId'),
      timestamp: requireIntegerField(body, 'timestamp'),
      requestUrl: requireStringField(body, 'requestUrl'),
      requestMethod: normalizeRequestMethod(body.requestMethod),
      status,
      failureCode: failureCodeValue ?? null,
      errorMessage: optionalStringField(body, 'errorMessage'),
      responseCode: optionalIntegerField(body, 'responseCode'),
    };

    const requestMethod = record.requestMethod ?? 'GET';
    const mockRoute = findActiveBrowserMockRoute(getConnection().db, record.requestUrl, requestMethod);
    if (mockRoute) {
      const mockRunId = ensureMockRunForOverrideRequest({
        route: mockRoute,
        overrideRunId: record.runId,
        sessionId: params.sessionId,
        timestamp: record.timestamp,
      });
      insertMockHit(getConnection().db, {
        hitId: `${record.requestLogId}:${mockRoute.routeId}`,
        runId: mockRunId,
        routeId: mockRoute.routeId,
        timestamp: record.timestamp,
        requestUrl: record.requestUrl,
        requestMethod,
        matched: true,
        fulfilled: record.status === 'fulfilled',
        statusCode: record.responseCode,
        responseSource: mockRoute.sourceKind,
        errorCode: record.failureCode,
        errorMessage: record.errorMessage,
      });
    }

    return {
      ok: true,
      request: upsertOverridePocRequest(getConnection().db, record),
    };
  } catch (error) {
    return reply.code(400).send({
      ok: false,
      error: error instanceof Error ? error.message : 'Invalid override request payload',
    });
  }
});

fastify.get('/internal/session-connection/:sessionId', async (request, reply) => {
  const params = request.params as { sessionId: string };
  if (!wsManager) {
    return reply.code(503).send({ ok: false, error: 'WebSocket manager unavailable' });
  }

  return {
    ok: true,
    sessionId: params.sessionId,
    state: wsManager.getSessionConnectionState(params.sessionId) ?? null,
  };
});

fastify.post('/internal/capture-command', async (request, reply) => {
  const body = (request.body ?? {}) as Partial<{
    sessionId: string;
    command: unknown;
    payload: unknown;
    timeoutMs: number;
  }>;

  if (typeof body.sessionId !== 'string' || body.sessionId.trim().length === 0) {
    return reply.code(400).send({ ok: false, error: 'sessionId is required' });
  }

  const command = CaptureCommandSchema.safeParse(body.command);
  if (!command.success) {
    return reply.code(400).send({ ok: false, error: 'command must be a supported capture command' });
  }

  let payload: Record<string, unknown>;
  try {
    payload = validateCapturePayload(command.data, body.payload);
  } catch (error) {
    return reply.code(400).send({
      ok: false,
      error: error instanceof Error ? error.message : 'Invalid capture payload',
    });
  }

  if (!wsManager) {
    return reply.code(503).send({ ok: false, error: 'WebSocket manager unavailable' });
  }

  try {
    const result = await wsManager.sendCaptureCommand(
      body.sessionId,
      command.data,
      payload,
      typeof body.timeoutMs === 'number' && Number.isFinite(body.timeoutMs) ? Math.floor(body.timeoutMs) : 4000,
    );
    return result;
  } catch (error) {
    return reply.code(502).send({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to send capture command',
    });
  }
});

fastify.get('/sessions/:sessionId/overrides/requests', async (request, reply) => {
  const params = request.params as { sessionId: string };
  if (!hasSession(params.sessionId)) {
    return reply.code(404).send({ ok: false, error: 'Session not found' });
  }

  const query = (request.query ?? {}) as {
    limit?: string | number;
    offset?: string | number;
    runId?: string;
  };
  const limit = parseLimit(query.limit, 50, 500);
  const offset = parseOffset(query.offset);
  const runId = typeof query.runId === 'string' && query.runId.trim().length > 0 ? query.runId.trim() : undefined;
  const result = listOverridePocRequests(getConnection().db, params.sessionId, limit, offset, runId);

  return {
    ok: true,
    sessionId: params.sessionId,
    runId: runId ?? null,
    limit,
    offset,
    hasMore: result.hasMore,
    nextOffset: result.nextOffset,
    requests: result.requests,
  };
});

fastify.post('/sessions/:sessionId/overrides/plans', async (request, reply) => {
  const params = request.params as { sessionId: string };
  if (!hasSession(params.sessionId)) {
    return reply.code(404).send({ ok: false, error: 'Session not found' });
  }

  if (!isRecord(request.body)) {
    return reply.code(400).send({ ok: false, error: 'Invalid override plan payload' });
  }

  try {
    const body = request.body;
    const plannerKind = body.plannerKind;
    if (!isOverridePlanAuditKind(plannerKind)) {
      throw new Error('plannerKind must be a valid override plan audit kind');
    }

    const stringArrayField = (fieldName: string): string[] => {
      const value = body[fieldName];
      return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
    };

    const record: OverridePlanAuditRecord = {
      planId: requireStringField(body, 'planId'),
      sessionId: params.sessionId,
      createdAt: optionalIntegerField(body, 'createdAt') ?? Date.now(),
      plannerKind,
      toolName: requireStringField(body, 'toolName'),
      profileId: optionalStringField(body, 'profileId'),
      ruleId: requireStringField(body, 'ruleId'),
      ruleType: requireStringField(body, 'ruleType'),
      requestMethod: requireStringField(body, 'requestMethod'),
      matchMode: requireStringField(body, 'matchMode'),
      targetAssetUrl: requireStringField(body, 'targetAssetUrl'),
      localFilePath: optionalStringField(body, 'localFilePath'),
      configPath: optionalStringField(body, 'configPath'),
      contentType: requireStringField(body, 'contentType'),
      originalSha256: optionalStringField(body, 'originalSha256'),
      patchedSha256: optionalStringField(body, 'patchedSha256'),
      originalBytes: optionalIntegerField(body, 'originalBytes'),
      patchedBytes: optionalIntegerField(body, 'patchedBytes'),
      patchSummary: body.patchSummary ?? null,
      preview: body.preview ?? null,
      warnings: stringArrayField('warnings'),
      blockers: stringArrayField('blockers'),
      capturedFromLiveSession: body.capturedFromLiveSession ?? null,
      rollback: body.rollback ?? null,
    };

    return {
      ok: true,
      plan: insertOverridePlanAudit(getConnection().db, record),
    };
  } catch (error) {
    return reply.code(400).send({
      ok: false,
      error: error instanceof Error ? error.message : 'Invalid override plan payload',
    });
  }
});

fastify.get('/sessions/:sessionId/overrides/plans', async (request, reply) => {
  const params = request.params as { sessionId: string };
  if (!hasSession(params.sessionId)) {
    return reply.code(404).send({ ok: false, error: 'Session not found' });
  }

  const query = (request.query ?? {}) as {
    limit?: string | number;
    offset?: string | number;
    planId?: string;
  };
  const limit = parseLimit(query.limit, 50, 500);
  const offset = parseOffset(query.offset);
  const planId = typeof query.planId === 'string' && query.planId.trim().length > 0 ? query.planId.trim() : undefined;
  const result = listOverridePlanAudits(getConnection().db, { sessionId: params.sessionId, limit, offset, planId });

  return {
    ok: true,
    sessionId: params.sessionId,
    planId: planId ?? null,
    limit,
    offset,
    hasMore: result.hasMore,
    nextOffset: result.nextOffset,
    plans: result.plans,
  };
});

fastify.get('/sessions/:sessionId/overrides/diagnosis', async (request, reply) => {
  const params = request.params as { sessionId: string };
  if (!hasSession(params.sessionId)) {
    return reply.code(404).send({ ok: false, error: 'Session not found' });
  }

  const query = (request.query ?? {}) as { runId?: string };
  const runId = typeof query.runId === 'string' && query.runId.trim().length > 0 ? query.runId.trim() : undefined;
  return {
    ok: true,
    diagnosis: diagnoseOverridePoc(getConnection().db, params.sessionId, runId),
  };
});

fastify.get('/retention/settings', async () => {
  return {
    settings: getRetentionSettings(getConnection().db),
    lastCleanup: lastCleanupResult,
  };
});

fastify.post('/retention/settings', async (request) => {
  const body = (request.body ?? {}) as Partial<{
    retentionDays: number;
    maxDbMb: number;
    maxSessions: number;
    cleanupIntervalMinutes: number;
    exportPathOverride: string | null;
  }>;

  const settings = updateRetentionSettings(getConnection().db, {
    retentionDays: body.retentionDays,
    maxDbMb: body.maxDbMb,
    maxSessions: body.maxSessions,
    cleanupIntervalMinutes: body.cleanupIntervalMinutes,
    exportPathOverride: body.exportPathOverride,
  });

  return { ok: true, settings };
});

fastify.post('/retention/run-cleanup', async () => {
  const db = getConnection().db;
  const settings = getRetentionSettings(db);
  const result = runRetentionCleanup(db, getDatabasePath(), settings, 'manual');
  lastCleanupResult = result;

  fastify.log.warn(
    {
      component: 'retention',
      event: 'cleanup_executed',
      trigger: result.trigger,
      deletedSessions: result.deletedSessions,
      warning: result.warning,
      dbSizeBeforeMb: result.dbSizeBeforeMb,
      dbSizeAfterMb: result.dbSizeAfterMb,
    },
    'Auto cleanup removed old sessions to enforce limits',
  );

  return { ok: true, result };
});

fastify.post('/sessions/:sessionId/pin', async (request) => {
  const params = request.params as { sessionId: string };
  const body = (request.body ?? {}) as { pinned?: boolean };
  const pinned = body.pinned ?? true;
  const updated = setSessionPinned(getConnection().db, params.sessionId, pinned);
  if (!updated) {
    return { ok: false, error: 'Session not found' };
  }
  return { ok: true, sessionId: params.sessionId, pinned };
});

fastify.post('/sessions/:sessionId/export', async (request) => {
  const params = request.params as { sessionId: string };
  const body = (request.body ?? {}) as {
    format?: 'json' | 'zip';
    compatibilityMode?: boolean;
    includePngBase64?: boolean;
  };
  const settings = getRetentionSettings(getConnection().db);
  const format = body.format === 'zip' || body.format === 'json' ? body.format : 'zip';
  const result = format === 'zip'
    ? await exportSessionToZip(getConnection().db, getDatabasePath(), params.sessionId, getRuntimeDataDir(), settings.exportPathOverride)
    : exportSessionToJson(getConnection().db, getDatabasePath(), params.sessionId, getRuntimeDataDir(), settings.exportPathOverride, {
      compatibilityMode: body.compatibilityMode,
      includePngBase64: body.includePngBase64,
    });
  return { ok: true, sessionId: params.sessionId, ...result };
});

fastify.post('/sessions/:sessionId/snapshots', async (request) => {
  const params = request.params as { sessionId: string };
  const body = (request.body ?? {}) as Record<string, unknown>;
  try {
    const result = writeSnapshot(
      getConnection().db,
      getDatabasePath(),
      params.sessionId,
      body,
      typeof body.triggerEventId === 'string' ? body.triggerEventId : null,
    );
    return { ok: true, sessionId: params.sessionId, ...result };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to persist snapshot',
    };
  }
});

fastify.get('/sessions/:sessionId/snapshots', async (request) => {
  const params = request.params as { sessionId: string };
  const query = (request.query ?? {}) as { limit?: string | number; offset?: string | number };
  const rawLimit = typeof query.limit === 'number' ? query.limit : Number(query.limit ?? 50);
  const rawOffset = typeof query.offset === 'number' ? query.offset : Number(query.offset ?? 0);

  const result = listSnapshots(getConnection().db, params.sessionId, rawLimit, rawOffset);
  return {
    ok: true,
    sessionId: params.sessionId,
    ...result,
  };
});

fastify.post('/sessions/import', async (request) => {
  const body = request.body;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Invalid import payload: expected JSON object.' };
  }

  const payloadSize = Buffer.byteLength(JSON.stringify(body), 'utf-8');
  if (payloadSize > MAX_SESSION_IMPORT_BYTES) {
    return {
      ok: false,
      error: `Import payload too large (${payloadSize} bytes). Max is ${MAX_SESSION_IMPORT_BYTES} bytes.`,
    };
  }

  try {
    const importBody = body as Record<string, unknown>;
    const result = importBody.format === 'zip' && typeof importBody.archiveBase64 === 'string'
      ? await importSessionFromZipBase64(getConnection().db, getDatabasePath(), importBody.archiveBase64)
      : importSessionFromJson(getConnection().db, body, { dbPath: getDatabasePath() });
    return { ok: true, ...result };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to import session',
    };
  }
});

fastify.post('/db/reset', async (_request, reply) => {
  try {
    resetDatabase(getConnection().db);
    fastify.log.warn(
      {
        component: 'db',
        event: 'database_reset',
      },
      'Database has been reset completely',
    );
    return { ok: true, message: 'Database reset successfully. All sessions deleted.' };
  } catch (error) {
    return reply.code(500).send({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to reset database',
    });
  }
});

fastify.get('/sessions', async (request) => {
  const query = (request.query ?? {}) as { limit?: string | number; offset?: string | number };
  const db = getConnection().db;
  const rawLimit = typeof query.limit === 'number' ? query.limit : Number(query.limit ?? 0);
  const rawOffset = typeof query.offset === 'number' ? query.offset : Number(query.offset ?? 0);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 200) : 20;
  const offset = Number.isFinite(rawOffset) ? Math.max(Math.floor(rawOffset), 0) : 0;

  type SessionRow = {
    session_id: string;
    created_at: number;
    last_seen_at: number | null;
    paused_at: number | null;
    ended_at: number | null;
    url_last: string | null;
    pinned: number;
  };

  const rows = db.prepare(
    `
      SELECT session_id, created_at, last_seen_at, paused_at, ended_at, url_last, pinned
      FROM sessions
      ORDER BY
        CASE
          WHEN COALESCE(last_seen_at, 0) > created_at THEN COALESCE(last_seen_at, 0)
          ELSE created_at
        END DESC,
        created_at DESC
      LIMIT ? OFFSET ?
    `
  ).all(limit + 1, offset) as SessionRow[];

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  return {
    ok: true,
    limit,
    offset,
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
    sessions: page.map((row) => ({
      sessionId: row.session_id,
      createdAt: row.created_at,
      lastSeenAt: Math.max(row.last_seen_at ?? 0, row.created_at),
      pausedAt: row.paused_at,
      endedAt: row.ended_at,
      status: row.ended_at ? 'ended' : row.paused_at ? 'paused' : 'active',
      urlLast: row.url_last,
      pinned: row.pinned === 1,
    })),
  };
});

fastify.get('/sessions/:sessionId/entries', async (request) => {
  const params = request.params as { sessionId: string };
  const query = (request.query ?? {}) as { limit?: string | number; offset?: string | number };
  const db = getConnection().db;

  const rawLimit = typeof query.limit === 'number' ? query.limit : Number(query.limit ?? 0);
  const rawOffset = typeof query.offset === 'number' ? query.offset : Number(query.offset ?? 0);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 10), 500) : 50;
  const offset = Number.isFinite(rawOffset) ? Math.max(Math.floor(rawOffset), 0) : 0;

  const exists = db.prepare('SELECT 1 FROM sessions WHERE session_id = ?').get(params.sessionId);
  if (!exists) {
    return { ok: false, error: 'Session not found' };
  }

  type EntryRow = {
    entry_id: string;
    source: 'event' | 'network';
    ts: number;
    kind: string;
    summary: string;
    raw_json: string;
  };

  const rows = db.prepare(
    `
      SELECT entry_id, source, ts, kind, summary, raw_json
      FROM (
        SELECT
          event_id AS entry_id,
          'event' AS source,
          ts,
          type AS kind,
          REPLACE(REPLACE(payload_json, CHAR(10), ' '), CHAR(13), ' ') AS summary,
          payload_json AS raw_json
        FROM events
        WHERE session_id = ?

        UNION ALL

        SELECT
          request_id AS entry_id,
          'network' AS source,
          ts_start AS ts,
          TRIM(method || ' ' || COALESCE(CAST(status AS TEXT), '-')) AS kind,
          REPLACE(REPLACE(
            TRIM(
              method
              || ' '
              || url
              || CASE WHEN status IS NOT NULL THEN ' (' || status || ')' ELSE '' END
              || CASE WHEN error_class IS NOT NULL THEN ' [' || error_class || ']' ELSE '' END
            ),
            CHAR(10),
            ' '
          ), CHAR(13), ' ') AS summary,
          json_object(
            'requestId', request_id,
            'traceId', trace_id,
            'tabId', tab_id,
            'timestamp', ts_start,
            'durationMs', duration_ms,
            'method', method,
            'url', url,
            'status', status,
            'initiator', initiator,
            'errorClass', error_class,
            'responseSizeEst', response_size_est,
            'request', json_object(
              'contentType', request_content_type,
              'bodyBytes', request_body_bytes,
              'truncated', request_body_truncated,
              'bodyChunkRef', request_body_chunk_ref
            ),
            'response', json_object(
              'contentType', response_content_type,
              'bodyBytes', response_body_bytes,
              'truncated', response_body_truncated,
              'bodyChunkRef', response_body_chunk_ref
            )
          ) AS raw_json
        FROM network
        WHERE session_id = ?
      ) entries
      ORDER BY ts DESC
      LIMIT ? OFFSET ?
    `
  ).all(params.sessionId, params.sessionId, limit + 1, offset) as EntryRow[];

  const eventsCount = (db.prepare('SELECT COUNT(*) as count FROM events WHERE session_id = ?').get(params.sessionId) as { count: number }).count;
  const networkCount = (db.prepare('SELECT COUNT(*) as count FROM network WHERE session_id = ?').get(params.sessionId) as { count: number }).count;
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  return {
    ok: true,
    sessionId: params.sessionId,
    limit,
    offset,
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
    totalApprox: eventsCount + networkCount,
    rows: page.map((row) => {
      let raw: unknown;
      try {
        raw = JSON.parse(row.raw_json);
      } catch {
        raw = { parseError: 'Unable to parse row JSON', raw: row.raw_json };
      }

      return {
        id: row.entry_id,
        source: row.source,
        timestamp: row.ts,
        kind: row.kind,
        summary: row.summary,
        raw,
      };
    }),
  };
});

fastify.get('/', async () => {
  return { 
    name: 'Browser Debug MCP Bridge Server',
    version: '1.0.0',
    websocket: '/ws'
  };
});

export async function startServer(): Promise<void> {
  try {
    const dbPath = getDatabasePath();
    mkdirSync(dirname(dbPath), { recursive: true });
    
    initializeDatabase(getConnection().db);
    fastify.log.info('Database initialized');

    const db = getConnection().db;
    const settings = getRetentionSettings(db);
    if (shouldRunCleanup(settings)) {
      lastCleanupResult = runRetentionCleanup(db, getDatabasePath(), settings, 'startup');
      fastify.log.warn(
        {
          component: 'retention',
          event: 'cleanup_executed',
          trigger: lastCleanupResult.trigger,
          deletedSessions: lastCleanupResult.deletedSessions,
          warning: lastCleanupResult.warning,
          dbSizeBeforeMb: lastCleanupResult.dbSizeBeforeMb,
          dbSizeAfterMb: lastCleanupResult.dbSizeAfterMb,
        },
        'Auto cleanup removed old sessions to enforce limits',
      );
    }

    cleanupInterval = setInterval(() => {
      const localDb = getConnection().db;
      const currentSettings = getRetentionSettings(localDb);
      lastCleanupResult = runRetentionCleanup(localDb, getDatabasePath(), currentSettings, 'scheduled');
      if (lastCleanupResult.deletedSessions > 0 || lastCleanupResult.warning) {
        fastify.log.warn(
          {
            component: 'retention',
            event: 'cleanup_executed',
            trigger: lastCleanupResult.trigger,
            deletedSessions: lastCleanupResult.deletedSessions,
            warning: lastCleanupResult.warning,
            dbSizeBeforeMb: lastCleanupResult.dbSizeBeforeMb,
            dbSizeAfterMb: lastCleanupResult.dbSizeAfterMb,
          },
          'Auto cleanup removed old sessions to enforce limits',
        );
      }
    }, settings.cleanupIntervalMinutes * 60_000);

    await fastify.listen({ port: PORT, host: HOST });
    fastify.log.info(`Server listening on ${HOST}:${PORT}`);

    wsManager = new WebSocketManager();
    wsManager.initialize(fastify);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

export function stopServer(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  wsManager?.close();
  getConnection().db.close();
}

export { fastify, wsManager };

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;

if (entryUrl && import.meta.url === entryUrl) {
  void startServer();
}
