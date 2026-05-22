import { Database } from 'better-sqlite3';
import { readFileSync } from 'fs';
import {
  type MockHitRecord,
  type MockRouteBodyKind,
  type MockRouteMode,
  type MockRouteRecord,
  type MockRunRecord,
  isMockRouteBodyKind,
  isMockRouteMatchMode,
  isMockRouteMode,
  isMockRouteSourceKind,
  isMockRunStatus,
} from './override-audit-contract.js';

export interface MockRouteListResult {
  routes: MockRouteRecord[];
  hasMore: boolean;
  nextOffset: number | null;
}

export interface MockRunListResult {
  runs: MockRunRecord[];
  hasMore: boolean;
  nextOffset: number | null;
}

export interface MockHitListResult {
  hits: MockHitRecord[];
  hasMore: boolean;
  nextOffset: number | null;
}

export interface MockRouteResponse {
  route: MockRouteRecord;
  buffer: Buffer;
  contentType: string;
  responseHeaders: Record<string, string>;
  responseCode: number;
}

interface MockRouteRow {
  route_id: string;
  created_at: number;
  updated_at: number;
  enabled: number;
  mode: string;
  method: string;
  match_mode: string;
  target_url: string;
  status_code: number;
  response_headers_json: string;
  body_kind: string;
  body_json: string | null;
  body_text: string | null;
  body_base64: string | null;
  body_file_path: string | null;
  delay_ms: number;
  source_kind: string;
  session_scope: string | null;
  project_root: string | null;
  ttl_ms: number | null;
  expires_at: number | null;
}

interface MockRunRow {
  run_id: string;
  route_id: string;
  execution_mode: string;
  session_id: string | null;
  tab_id: number | null;
  project_root: string | null;
  started_at: number;
  ended_at: number | null;
  status: string;
}

interface MockHitRow {
  hit_id: string;
  run_id: string | null;
  route_id: string;
  ts: number;
  request_url: string;
  request_method: string;
  matched: number;
  fulfilled: number;
  status_code: number | null;
  response_source: string;
  error_code: string | null;
  error_message: string | null;
}

function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJsonValue(value: string | null): unknown {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseHeaderRecord(value: string): Record<string, string> {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(parsed)) {
    if (typeof raw === 'string') {
      headers[key.toLowerCase()] = raw;
    }
  }
  return headers;
}

function mapMockRouteRow(row: MockRouteRow): MockRouteRecord {
  const bodyKind: MockRouteBodyKind = isMockRouteBodyKind(row.body_kind) ? row.body_kind : 'text';
  return {
    routeId: row.route_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    enabled: row.enabled === 1,
    mode: isMockRouteMode(row.mode) ? row.mode : 'browser',
    method: row.method,
    matchMode: isMockRouteMatchMode(row.match_mode) ? row.match_mode : 'exact',
    targetUrl: row.target_url,
    statusCode: row.status_code,
    responseHeaders: parseHeaderRecord(row.response_headers_json),
    bodyKind,
    bodyJson: bodyKind === 'json' ? parseJsonValue(row.body_json) : undefined,
    bodyText: row.body_text,
    bodyBase64: row.body_base64,
    bodyFilePath: row.body_file_path,
    delayMs: row.delay_ms,
    sourceKind: isMockRouteSourceKind(row.source_kind) ? row.source_kind : 'manual',
    sessionScope: row.session_scope,
    projectRoot: row.project_root,
    ttlMs: row.ttl_ms,
    expiresAt: row.expires_at,
  };
}

function mapMockRunRow(row: MockRunRow): MockRunRecord {
  return {
    runId: row.run_id,
    routeId: row.route_id,
    executionMode: isMockRouteMode(row.execution_mode) ? row.execution_mode : 'browser',
    sessionId: row.session_id,
    tabId: row.tab_id,
    projectRoot: row.project_root,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: isMockRunStatus(row.status) ? row.status : 'active',
  };
}

function mapMockHitRow(row: MockHitRow): MockHitRecord {
  return {
    hitId: row.hit_id,
    runId: row.run_id,
    routeId: row.route_id,
    timestamp: row.ts,
    requestUrl: row.request_url,
    requestMethod: row.request_method,
    matched: row.matched === 1,
    fulfilled: row.fulfilled === 1,
    statusCode: row.status_code,
    responseSource: isMockRouteSourceKind(row.response_source) ? row.response_source : 'manual',
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

export function upsertMockRoute(db: Database, record: MockRouteRecord): MockRouteRecord {
  db.prepare(`
    INSERT INTO mock_routes (
      route_id,
      created_at,
      updated_at,
      enabled,
      mode,
      method,
      match_mode,
      target_url,
      status_code,
      response_headers_json,
      body_kind,
      body_json,
      body_text,
      body_base64,
      body_file_path,
      delay_ms,
      source_kind,
      session_scope,
      project_root,
      ttl_ms,
      expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(route_id) DO UPDATE SET
      updated_at = excluded.updated_at,
      enabled = excluded.enabled,
      mode = excluded.mode,
      method = excluded.method,
      match_mode = excluded.match_mode,
      target_url = excluded.target_url,
      status_code = excluded.status_code,
      response_headers_json = excluded.response_headers_json,
      body_kind = excluded.body_kind,
      body_json = excluded.body_json,
      body_text = excluded.body_text,
      body_base64 = excluded.body_base64,
      body_file_path = excluded.body_file_path,
      delay_ms = excluded.delay_ms,
      source_kind = excluded.source_kind,
      session_scope = excluded.session_scope,
      project_root = excluded.project_root,
      ttl_ms = excluded.ttl_ms,
      expires_at = excluded.expires_at
  `).run(
    record.routeId,
    record.createdAt,
    record.updatedAt,
    record.enabled ? 1 : 0,
    record.mode,
    record.method,
    record.matchMode,
    record.targetUrl,
    record.statusCode,
    encodeJson(record.responseHeaders),
    record.bodyKind,
    record.bodyKind === 'json' ? encodeJson(record.bodyJson) : null,
    record.bodyKind === 'text' ? (record.bodyText ?? '') : null,
    record.bodyKind === 'base64' ? (record.bodyBase64 ?? '') : null,
    record.bodyKind === 'file' ? (record.bodyFilePath ?? '') : null,
    record.delayMs,
    record.sourceKind,
    record.sessionScope ?? null,
    record.projectRoot ?? null,
    record.ttlMs ?? null,
    record.expiresAt ?? null,
  );

  return record;
}

export function getMockRoute(db: Database, routeId: string): MockRouteRecord | null {
  const row = db.prepare(`
    SELECT
      route_id, created_at, updated_at, enabled, mode, method, match_mode, target_url,
      status_code, response_headers_json, body_kind, body_json, body_text, body_base64,
      body_file_path, delay_ms, source_kind, session_scope, project_root, ttl_ms, expires_at
    FROM mock_routes
    WHERE route_id = ?
    LIMIT 1
  `).get(routeId) as MockRouteRow | undefined;

  return row ? mapMockRouteRow(row) : null;
}

export function deleteMockRoute(db: Database, routeId: string): boolean {
  const result = db.prepare('DELETE FROM mock_routes WHERE route_id = ?').run(routeId);
  return result.changes > 0;
}

export function listMockRoutes(
  db: Database,
  options: {
    projectRoot?: string;
    mode?: MockRouteMode;
    enabled?: boolean;
    limit: number;
    offset: number;
  },
): MockRouteListResult {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.projectRoot) {
    where.push('project_root = ?');
    params.push(options.projectRoot);
  }
  if (options.mode) {
    where.push('(mode = ? OR mode = ?)');
    params.push(options.mode, 'both');
  }
  if (typeof options.enabled === 'boolean') {
    where.push('enabled = ?');
    params.push(options.enabled ? 1 : 0);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT
      route_id, created_at, updated_at, enabled, mode, method, match_mode, target_url,
      status_code, response_headers_json, body_kind, body_json, body_text, body_base64,
      body_file_path, delay_ms, source_kind, session_scope, project_root, ttl_ms, expires_at
    FROM mock_routes
    ${whereSql}
    ORDER BY created_at DESC, rowid DESC
    LIMIT ? OFFSET ?
  `).all(...params, options.limit + 1, options.offset) as MockRouteRow[];
  const hasMore = rows.length > options.limit;
  return {
    routes: rows.slice(0, options.limit).map(mapMockRouteRow),
    hasMore,
    nextOffset: hasMore ? options.offset + options.limit : null,
  };
}

export function insertMockRun(db: Database, record: MockRunRecord): MockRunRecord {
  const now = Date.now();
  db.prepare(`
    INSERT INTO mock_runs (
      run_id, route_id, execution_mode, session_id, tab_id, project_root,
      started_at, ended_at, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      route_id = excluded.route_id,
      execution_mode = excluded.execution_mode,
      session_id = excluded.session_id,
      tab_id = excluded.tab_id,
      project_root = excluded.project_root,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      status = excluded.status,
      updated_at = excluded.updated_at
  `).run(
    record.runId,
    record.routeId,
    record.executionMode,
    record.sessionId ?? null,
    record.tabId ?? null,
    record.projectRoot ?? null,
    record.startedAt,
    record.endedAt ?? null,
    record.status,
    now,
    now,
  );
  return record;
}

export function insertMockHit(db: Database, record: MockHitRecord): MockHitRecord {
  const now = Date.now();
  db.prepare(`
    INSERT INTO mock_hits (
      hit_id, run_id, route_id, ts, request_url, request_method, matched, fulfilled,
      status_code, response_source, error_code, error_message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(hit_id) DO UPDATE SET
      run_id = excluded.run_id,
      route_id = excluded.route_id,
      ts = excluded.ts,
      request_url = excluded.request_url,
      request_method = excluded.request_method,
      matched = excluded.matched,
      fulfilled = excluded.fulfilled,
      status_code = excluded.status_code,
      response_source = excluded.response_source,
      error_code = excluded.error_code,
      error_message = excluded.error_message,
      updated_at = excluded.updated_at
  `).run(
    record.hitId,
    record.runId ?? null,
    record.routeId,
    record.timestamp,
    record.requestUrl,
    record.requestMethod,
    record.matched ? 1 : 0,
    record.fulfilled ? 1 : 0,
    record.statusCode ?? null,
    record.responseSource,
    record.errorCode ?? null,
    record.errorMessage ?? null,
    now,
    now,
  );
  return record;
}

export function listActiveBrowserMockRoutes(db: Database, now = Date.now()): MockRouteRecord[] {
  const rows = db.prepare(`
    SELECT
      route_id, created_at, updated_at, enabled, mode, method, match_mode, target_url,
      status_code, response_headers_json, body_kind, body_json, body_text, body_base64,
      body_file_path, delay_ms, source_kind, session_scope, project_root, ttl_ms, expires_at
    FROM mock_routes
    WHERE enabled = 1
      AND (mode = 'browser' OR mode = 'both')
      AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY created_at DESC, rowid DESC
    LIMIT 500
  `).all(now) as MockRouteRow[];

  return rows.map(mapMockRouteRow);
}

export function listActiveSsrMockRoutes(db: Database, now = Date.now()): MockRouteRecord[] {
  const rows = db.prepare(`
    SELECT
      route_id, created_at, updated_at, enabled, mode, method, match_mode, target_url,
      status_code, response_headers_json, body_kind, body_json, body_text, body_base64,
      body_file_path, delay_ms, source_kind, session_scope, project_root, ttl_ms, expires_at
    FROM mock_routes
    WHERE enabled = 1
      AND (mode = 'ssr' OR mode = 'both')
      AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY created_at DESC, rowid DESC
    LIMIT 500
  `).all(now) as MockRouteRow[];

  return rows.map(mapMockRouteRow);
}

export function findActiveBrowserMockRoute(
  db: Database,
  requestUrl: string,
  requestMethod = 'GET',
  now = Date.now(),
): MockRouteRecord | null {
  const normalizedMethod = requestMethod.trim().toUpperCase();
  const routes = listActiveBrowserMockRoutes(db, now)
    .filter((route) => route.method === normalizedMethod)
    .sort((left, right) => {
      if (left.matchMode !== right.matchMode) {
        return left.matchMode === 'exact' ? -1 : 1;
      }
      return right.targetUrl.length - left.targetUrl.length || right.createdAt - left.createdAt;
    });

  return routes.find((route) => {
    return route.matchMode === 'prefix'
      ? requestUrl.startsWith(route.targetUrl)
    : requestUrl === route.targetUrl;
  }) ?? null;
}

function getRoutePathWithSearch(route: MockRouteRecord): string | null {
  try {
    const parsed = new URL(route.targetUrl);
    return `${parsed.pathname || '/'}${parsed.search}`;
  } catch {
    return null;
  }
}

function matchesSsrRequestPath(route: MockRouteRecord, requestPathWithSearch: string): boolean {
  const targetPathWithSearch = getRoutePathWithSearch(route);
  if (!targetPathWithSearch) {
    return false;
  }

  return route.matchMode === 'prefix'
    ? requestPathWithSearch.startsWith(targetPathWithSearch)
    : requestPathWithSearch === targetPathWithSearch;
}

export function findActiveSsrMockRoute(
  db: Database,
  scope: string,
  requestPathWithSearch: string,
  requestMethod = 'GET',
  now = Date.now(),
): MockRouteRecord | null {
  const normalizedMethod = requestMethod.trim().toUpperCase();
  const routes = listActiveSsrMockRoutes(db, now)
    .filter((route) => route.method === normalizedMethod)
    .filter((route) => route.routeId === scope || route.sessionScope === scope || route.sessionScope === null)
    .sort((left, right) => {
      const leftScopeScore = left.routeId === scope ? 0 : left.sessionScope === scope ? 1 : 2;
      const rightScopeScore = right.routeId === scope ? 0 : right.sessionScope === scope ? 1 : 2;
      if (leftScopeScore !== rightScopeScore) {
        return leftScopeScore - rightScopeScore;
      }
      if (left.matchMode !== right.matchMode) {
        return left.matchMode === 'exact' ? -1 : 1;
      }
      const leftPathLength = getRoutePathWithSearch(left)?.length ?? 0;
      const rightPathLength = getRoutePathWithSearch(right)?.length ?? 0;
      return rightPathLength - leftPathLength || right.createdAt - left.createdAt;
    });

  return routes.find((route) => matchesSsrRequestPath(route, requestPathWithSearch)) ?? null;
}

function defaultMockContentType(route: MockRouteRecord): string {
  const configured = route.responseHeaders['content-type'];
  if (configured) {
    return configured;
  }
  switch (route.bodyKind) {
    case 'json':
      return 'application/json; charset=utf-8';
    case 'text':
      return 'text/plain; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

export function buildMockRouteResponse(route: MockRouteRecord): MockRouteResponse {
  const contentType = defaultMockContentType(route);
  const responseHeaders = {
    ...route.responseHeaders,
    'content-type': contentType,
  };
  let buffer: Buffer;

  switch (route.bodyKind) {
    case 'json':
      buffer = Buffer.from(JSON.stringify(route.bodyJson ?? null), 'utf8');
      break;
    case 'text':
      buffer = Buffer.from(route.bodyText ?? '', 'utf8');
      break;
    case 'base64':
      buffer = Buffer.from(route.bodyBase64 ?? '', 'base64');
      break;
    case 'file':
      if (!route.bodyFilePath) {
        throw new Error(`Mock route ${route.routeId} has bodyKind=file but no bodyFilePath`);
      }
      buffer = readFileSync(route.bodyFilePath);
      break;
  }

  return {
    route,
    buffer,
    contentType,
    responseHeaders,
    responseCode: route.statusCode,
  };
}

export function listMockRuns(
  db: Database,
  options: {
    routeId?: string;
    sessionId?: string;
    limit: number;
    offset: number;
  },
): MockRunListResult {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.routeId) {
    where.push('route_id = ?');
    params.push(options.routeId);
  }
  if (options.sessionId) {
    where.push('session_id = ?');
    params.push(options.sessionId);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT run_id, route_id, execution_mode, session_id, tab_id, project_root, started_at, ended_at, status
    FROM mock_runs
    ${whereSql}
    ORDER BY started_at DESC, rowid DESC
    LIMIT ? OFFSET ?
  `).all(...params, options.limit + 1, options.offset) as MockRunRow[];
  const hasMore = rows.length > options.limit;
  return {
    runs: rows.slice(0, options.limit).map(mapMockRunRow),
    hasMore,
    nextOffset: hasMore ? options.offset + options.limit : null,
  };
}

export function listMockHits(
  db: Database,
  options: {
    routeId?: string;
    runId?: string;
    limit: number;
    offset: number;
  },
): MockHitListResult {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.routeId) {
    where.push('route_id = ?');
    params.push(options.routeId);
  }
  if (options.runId) {
    where.push('run_id = ?');
    params.push(options.runId);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT hit_id, run_id, route_id, ts, request_url, request_method, matched, fulfilled, status_code,
      response_source, error_code, error_message
    FROM mock_hits
    ${whereSql}
    ORDER BY ts DESC, rowid DESC
    LIMIT ? OFFSET ?
  `).all(...params, options.limit + 1, options.offset) as MockHitRow[];
  const hasMore = rows.length > options.limit;
  return {
    hits: rows.slice(0, options.limit).map(mapMockHitRow),
    hasMore,
    nextOffset: hasMore ? options.offset + options.limit : null,
  };
}
