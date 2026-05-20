import { Database } from 'better-sqlite3';
import {
  isNetworkBlockingErrorReason,
  isNetworkBlockingFailureCode,
  isNetworkBlockingResourceType,
  isNetworkBlockingRunStatus,
  type NetworkBlockingRequestRecord,
  type NetworkBlockingRule,
  type NetworkBlockingRunRecord,
} from './network-blocking-contract.js';

export interface NetworkBlockingRunListResult {
  runs: NetworkBlockingRunRecord[];
  hasMore: boolean;
  nextOffset: number | null;
}

export interface NetworkBlockingRequestListOptions {
  sessionId: string;
  limit: number;
  offset: number;
  runId?: string;
  ruleId?: string;
  urlContains?: string;
  method?: string;
}

export interface NetworkBlockingRequestListResult {
  requests: NetworkBlockingRequestRecord[];
  hasMore: boolean;
  nextOffset: number | null;
}

interface NetworkBlockingRunRow {
  run_id: string;
  session_id: string;
  started_at: number;
  ended_at: number | null;
  run_status: string;
  tab_id: number;
  selected_tab_id: number | null;
  rule_count: number;
  blocked_requests: number;
  last_blocked_at: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  rules_json: string;
}

interface NetworkBlockingRequestRow {
  request_log_id: string;
  run_id: string;
  session_id: string;
  request_id: string;
  ts: number;
  tab_id: number;
  frame_id: number | null;
  request_url: string;
  request_method: string;
  resource_type: string;
  rule_id: string;
  error_reason: string;
}

function parseRules(value: string): NetworkBlockingRule[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is NetworkBlockingRule => isNetworkBlockingRule(entry))
      : [];
  } catch {
    return [];
  }
}

function isNetworkBlockingRule(value: unknown): value is NetworkBlockingRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<NetworkBlockingRule>;
  return typeof candidate.ruleId === 'string'
    && typeof candidate.enabled === 'boolean'
    && isNetworkBlockingErrorReason(candidate.errorReason);
}

function mapRunRow(row: NetworkBlockingRunRow): NetworkBlockingRunRecord {
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    runStatus: isNetworkBlockingRunStatus(row.run_status) ? row.run_status : 'failed',
    tabId: row.tab_id,
    selectedTabId: row.selected_tab_id,
    ruleCount: row.rule_count,
    blockedRequests: row.blocked_requests,
    lastBlockedAt: row.last_blocked_at,
    lastErrorCode: isNetworkBlockingFailureCode(row.last_error_code) ? row.last_error_code : null,
    lastErrorMessage: row.last_error_message,
    rules: parseRules(row.rules_json),
  };
}

function mapRequestRow(row: NetworkBlockingRequestRow): NetworkBlockingRequestRecord {
  return {
    requestLogId: row.request_log_id,
    runId: row.run_id,
    sessionId: row.session_id,
    requestId: row.request_id,
    timestamp: row.ts,
    tabId: row.tab_id,
    frameId: row.frame_id,
    requestUrl: row.request_url,
    requestMethod: row.request_method,
    resourceType: isNetworkBlockingResourceType(row.resource_type) ? row.resource_type : 'other',
    ruleId: row.rule_id,
    errorReason: isNetworkBlockingErrorReason(row.error_reason) ? row.error_reason : 'BlockedByClient',
  };
}

export function upsertNetworkBlockingRun(db: Database, record: NetworkBlockingRunRecord): NetworkBlockingRunRecord {
  const now = Date.now();
  db.prepare(`
    INSERT INTO network_blocking_runs (
      run_id,
      session_id,
      started_at,
      ended_at,
      run_status,
      tab_id,
      selected_tab_id,
      rule_count,
      blocked_requests,
      last_blocked_at,
      last_error_code,
      last_error_message,
      rules_json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      ended_at = excluded.ended_at,
      run_status = excluded.run_status,
      tab_id = excluded.tab_id,
      selected_tab_id = excluded.selected_tab_id,
      rule_count = excluded.rule_count,
      blocked_requests = excluded.blocked_requests,
      last_blocked_at = excluded.last_blocked_at,
      last_error_code = excluded.last_error_code,
      last_error_message = excluded.last_error_message,
      rules_json = excluded.rules_json,
      updated_at = excluded.updated_at
  `).run(
    record.runId,
    record.sessionId,
    record.startedAt,
    record.endedAt ?? null,
    record.runStatus,
    record.tabId,
    record.selectedTabId ?? null,
    record.ruleCount,
    record.blockedRequests,
    record.lastBlockedAt ?? null,
    record.lastErrorCode ?? null,
    record.lastErrorMessage ?? null,
    JSON.stringify(record.rules),
    now,
    now,
  );

  return record;
}

export function upsertNetworkBlockingRequest(
  db: Database,
  record: NetworkBlockingRequestRecord,
): NetworkBlockingRequestRecord {
  const now = Date.now();
  db.prepare(`
    INSERT INTO network_blocking_requests (
      request_log_id,
      run_id,
      session_id,
      request_id,
      ts,
      tab_id,
      frame_id,
      request_url,
      request_method,
      resource_type,
      rule_id,
      error_reason,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(request_log_id) DO UPDATE SET
      tab_id = excluded.tab_id,
      frame_id = excluded.frame_id,
      request_url = excluded.request_url,
      request_method = excluded.request_method,
      resource_type = excluded.resource_type,
      rule_id = excluded.rule_id,
      error_reason = excluded.error_reason,
      updated_at = excluded.updated_at
  `).run(
    record.requestLogId,
    record.runId,
    record.sessionId,
    record.requestId,
    record.timestamp,
    record.tabId,
    record.frameId ?? null,
    record.requestUrl,
    record.requestMethod,
    record.resourceType,
    record.ruleId,
    record.errorReason,
    now,
    now,
  );

  return record;
}

export function listNetworkBlockingRuns(
  db: Database,
  sessionId: string,
  limit: number,
  offset: number,
): NetworkBlockingRunListResult {
  const rows = db.prepare(`
    SELECT
      run_id,
      session_id,
      started_at,
      ended_at,
      run_status,
      tab_id,
      selected_tab_id,
      rule_count,
      blocked_requests,
      last_blocked_at,
      last_error_code,
      last_error_message,
      rules_json
    FROM network_blocking_runs
    WHERE session_id = ?
    ORDER BY started_at DESC, run_id DESC
    LIMIT ? OFFSET ?
  `).all(sessionId, limit + 1, offset) as NetworkBlockingRunRow[];

  const hasMore = rows.length > limit;
  return {
    runs: rows.slice(0, limit).map(mapRunRow),
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
  };
}

export function getLatestNetworkBlockingRun(
  db: Database,
  sessionId: string,
): NetworkBlockingRunRecord | null {
  const row = db.prepare(`
    SELECT
      run_id,
      session_id,
      started_at,
      ended_at,
      run_status,
      tab_id,
      selected_tab_id,
      rule_count,
      blocked_requests,
      last_blocked_at,
      last_error_code,
      last_error_message,
      rules_json
    FROM network_blocking_runs
    WHERE session_id = ?
    ORDER BY started_at DESC, run_id DESC
    LIMIT 1
  `).get(sessionId) as NetworkBlockingRunRow | undefined;

  return row ? mapRunRow(row) : null;
}

export function listNetworkBlockingRequests(
  db: Database,
  options: NetworkBlockingRequestListOptions,
): NetworkBlockingRequestListResult {
  const where = ['session_id = ?'];
  const params: unknown[] = [options.sessionId];

  if (options.runId) {
    where.push('run_id = ?');
    params.push(options.runId);
  }
  if (options.ruleId) {
    where.push('rule_id = ?');
    params.push(options.ruleId);
  }
  if (options.urlContains) {
    where.push('request_url LIKE ?');
    params.push(`%${options.urlContains}%`);
  }
  if (options.method) {
    where.push('request_method = ?');
    params.push(options.method.toUpperCase());
  }

  const rows = db.prepare(`
    SELECT
      request_log_id,
      run_id,
      session_id,
      request_id,
      ts,
      tab_id,
      frame_id,
      request_url,
      request_method,
      resource_type,
      rule_id,
      error_reason
    FROM network_blocking_requests
    WHERE ${where.join(' AND ')}
    ORDER BY ts DESC, request_log_id DESC
    LIMIT ? OFFSET ?
  `).all(...params, options.limit + 1, options.offset) as NetworkBlockingRequestRow[];

  const hasMore = rows.length > options.limit;
  return {
    requests: rows.slice(0, options.limit).map(mapRequestRow),
    hasMore,
    nextOffset: hasMore ? options.offset + options.limit : null,
  };
}
