import { Database } from 'better-sqlite3';
import {
  type OverridePocFailureCode,
  type OverridePocRequestRecord,
  type OverridePocRunRecord,
  isOverridePocFailureCode,
  type OverridePocRunStatus,
} from './override-audit-contract.js';

export interface OverridePocRunListResult {
  runs: OverridePocRunRecord[];
  hasMore: boolean;
  nextOffset: number | null;
}

export interface OverridePocRequestListResult {
  requests: OverridePocRequestRecord[];
  hasMore: boolean;
  nextOffset: number | null;
}

export interface OverridePocDiagnosisIssue {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  suggestedActions: string[];
}

export interface OverridePocObservedAssetDiagnostics {
  observedAssetCount: number;
  targetAssetObserved: boolean;
  targetAssetIntegrity: string | null;
  latestObservedAt: number | null;
  serviceWorkerControlled: boolean;
  cspMetaTagCount: number;
  sriAssetCount: number;
}

export interface OverridePocDiagnosis {
  sessionId: string;
  runId: string | null;
  summary: {
    runStatus: OverridePocRunStatus | null;
    matchedRequests: number;
    fulfilledRequests: number;
    requestFailureCount: number;
    lastErrorCode: OverridePocFailureCode | null;
    lastErrorMessage: string | null;
  } | null;
  indicators: {
    exactUrlMismatch: 'observed' | 'possible' | 'unlikely';
    cacheOrNoReload: 'observed' | 'possible' | 'unlikely';
    serviceWorkerInterference: 'observed' | 'possible' | 'unlikely';
    sriOrCspInterference: 'observed' | 'possible' | 'unlikely';
    tabSelectionIssue: 'observed' | 'possible' | 'unlikely';
    debuggerLifecycleIssue: 'observed' | 'possible' | 'unlikely';
  };
  observedAssets: OverridePocObservedAssetDiagnostics | null;
  issues: OverridePocDiagnosisIssue[];
}

interface OverrideRunRow {
  run_id: string;
  session_id: string;
  started_at: number;
  ended_at: number | null;
  run_status: OverridePocRunStatus;
  tab_id: number;
  selected_tab_id: number | null;
  target_asset_url: string;
  local_file_path: string;
  resolved_local_file_path: string;
  content_type: string;
  auto_reload: number;
  config_path: string;
  file_exists: number;
  file_size_bytes: number | null;
  matched_requests: number;
  fulfilled_requests: number;
  last_matched_at: number | null;
  last_fulfilled_at: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
}

interface OverrideRequestRow {
  request_log_id: string;
  run_id: string;
  session_id: string;
  request_id: string;
  ts: number;
  request_url: string;
  request_status: OverridePocRequestRecord['status'];
  failure_code: string | null;
  error_message: string | null;
  response_code: number | null;
}

interface ObservedAssetDiagnosticRow {
  asset_url: string;
  last_seen_at: number;
  integrity: string | null;
  service_worker_controlled: number;
  csp_meta_json: string | null;
}

function mapRunRow(row: OverrideRunRow): OverridePocRunRecord {
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    runStatus: row.run_status,
    tabId: row.tab_id,
    selectedTabId: row.selected_tab_id,
    targetAssetUrl: row.target_asset_url,
    localFilePath: row.local_file_path,
    resolvedLocalFilePath: row.resolved_local_file_path,
    contentType: row.content_type,
    autoReload: row.auto_reload === 1,
    configPath: row.config_path,
    fileExists: row.file_exists === 1,
    fileSizeBytes: row.file_size_bytes,
    matchedRequests: row.matched_requests,
    fulfilledRequests: row.fulfilled_requests,
    lastMatchedAt: row.last_matched_at,
    lastFulfilledAt: row.last_fulfilled_at,
    lastErrorCode: isOverridePocFailureCode(row.last_error_code) ? row.last_error_code : null,
    lastErrorMessage: row.last_error_message,
  };
}

function mapRequestRow(row: OverrideRequestRow): OverridePocRequestRecord {
  return {
    requestLogId: row.request_log_id,
    runId: row.run_id,
    sessionId: row.session_id,
    requestId: row.request_id,
    timestamp: row.ts,
    requestUrl: row.request_url,
    status: row.request_status,
    failureCode: isOverridePocFailureCode(row.failure_code) ? row.failure_code : null,
    errorMessage: row.error_message,
    responseCode: row.response_code,
  };
}

function parseCspMetaTags(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function getObservedAssetDiagnostics(
  db: Database,
  sessionId: string,
  targetAssetUrl: string,
): OverridePocObservedAssetDiagnostics {
  const rows = db.prepare(`
    SELECT asset_url, last_seen_at, integrity, service_worker_controlled, csp_meta_json
    FROM override_observed_assets
    WHERE session_id = ?
    ORDER BY last_seen_at DESC
    LIMIT 500
  `).all(sessionId) as ObservedAssetDiagnosticRow[];

  const target = rows.find((row) => row.asset_url === targetAssetUrl);
  const cspMetaTags = new Set<string>();
  for (const row of rows) {
    for (const tag of parseCspMetaTags(row.csp_meta_json)) {
      cspMetaTags.add(tag);
    }
  }

  return {
    observedAssetCount: rows.length,
    targetAssetObserved: target !== undefined,
    targetAssetIntegrity: target?.integrity ?? null,
    latestObservedAt: rows.reduce<number | null>((latest, row) => {
      return latest === null ? row.last_seen_at : Math.max(latest, row.last_seen_at);
    }, null),
    serviceWorkerControlled: rows.some((row) => row.service_worker_controlled === 1),
    cspMetaTagCount: cspMetaTags.size,
    sriAssetCount: rows.filter((row) => typeof row.integrity === 'string' && row.integrity.trim().length > 0).length,
  };
}

export function upsertOverridePocRun(db: Database, record: OverridePocRunRecord): OverridePocRunRecord {
  const now = Date.now();
  db.prepare(`
    INSERT INTO override_runs (
      run_id,
      session_id,
      started_at,
      ended_at,
      run_status,
      tab_id,
      selected_tab_id,
      target_asset_url,
      local_file_path,
      resolved_local_file_path,
      content_type,
      auto_reload,
      config_path,
      file_exists,
      file_size_bytes,
      matched_requests,
      fulfilled_requests,
      last_matched_at,
      last_fulfilled_at,
      last_error_code,
      last_error_message,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      ended_at = excluded.ended_at,
      run_status = excluded.run_status,
      tab_id = excluded.tab_id,
      selected_tab_id = excluded.selected_tab_id,
      target_asset_url = excluded.target_asset_url,
      local_file_path = excluded.local_file_path,
      resolved_local_file_path = excluded.resolved_local_file_path,
      content_type = excluded.content_type,
      auto_reload = excluded.auto_reload,
      config_path = excluded.config_path,
      file_exists = excluded.file_exists,
      file_size_bytes = excluded.file_size_bytes,
      matched_requests = excluded.matched_requests,
      fulfilled_requests = excluded.fulfilled_requests,
      last_matched_at = excluded.last_matched_at,
      last_fulfilled_at = excluded.last_fulfilled_at,
      last_error_code = excluded.last_error_code,
      last_error_message = excluded.last_error_message,
      updated_at = excluded.updated_at
  `).run(
    record.runId,
    record.sessionId,
    record.startedAt,
    record.endedAt ?? null,
    record.runStatus,
    record.tabId,
    record.selectedTabId ?? null,
    record.targetAssetUrl,
    record.localFilePath,
    record.resolvedLocalFilePath,
    record.contentType,
    record.autoReload ? 1 : 0,
    record.configPath,
    record.fileExists ? 1 : 0,
    record.fileSizeBytes ?? null,
    record.matchedRequests,
    record.fulfilledRequests,
    record.lastMatchedAt ?? null,
    record.lastFulfilledAt ?? null,
    record.lastErrorCode ?? null,
    record.lastErrorMessage ?? null,
    now,
    now,
  );

  return record;
}

export function upsertOverridePocRequest(db: Database, record: OverridePocRequestRecord): OverridePocRequestRecord {
  const now = Date.now();
  db.prepare(`
    INSERT INTO override_requests (
      request_log_id,
      run_id,
      session_id,
      request_id,
      ts,
      request_url,
      request_status,
      failure_code,
      error_message,
      response_code,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(request_log_id) DO UPDATE SET
      request_status = excluded.request_status,
      failure_code = excluded.failure_code,
      error_message = excluded.error_message,
      response_code = excluded.response_code,
      updated_at = excluded.updated_at
  `).run(
    record.requestLogId,
    record.runId,
    record.sessionId,
    record.requestId,
    record.timestamp,
    record.requestUrl,
    record.status,
    record.failureCode ?? null,
    record.errorMessage ?? null,
    record.responseCode ?? null,
    now,
    now,
  );

  return record;
}

export function listOverridePocRuns(
  db: Database,
  sessionId: string,
  limit: number,
  offset: number,
): OverridePocRunListResult {
  const rows = db.prepare(`
    SELECT
      run_id,
      session_id,
      started_at,
      ended_at,
      run_status,
      tab_id,
      selected_tab_id,
      target_asset_url,
      local_file_path,
      resolved_local_file_path,
      content_type,
      auto_reload,
      config_path,
      file_exists,
      file_size_bytes,
      matched_requests,
      fulfilled_requests,
      last_matched_at,
      last_fulfilled_at,
      last_error_code,
      last_error_message
    FROM override_runs
    WHERE session_id = ?
    ORDER BY started_at DESC, run_id DESC
    LIMIT ? OFFSET ?
  `).all(sessionId, limit + 1, offset) as OverrideRunRow[];

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map(mapRunRow);
  return {
    runs: page,
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
  };
}

export function listOverridePocRequests(
  db: Database,
  sessionId: string,
  limit: number,
  offset: number,
  runId?: string,
): OverridePocRequestListResult {
  const rows = (runId
    ? db.prepare(`
      SELECT
        request_log_id,
        run_id,
        session_id,
        request_id,
        ts,
        request_url,
        request_status,
        failure_code,
        error_message,
        response_code
      FROM override_requests
      WHERE session_id = ? AND run_id = ?
      ORDER BY ts DESC, request_log_id DESC
      LIMIT ? OFFSET ?
    `).all(sessionId, runId, limit + 1, offset)
    : db.prepare(`
      SELECT
        request_log_id,
        run_id,
        session_id,
        request_id,
        ts,
        request_url,
        request_status,
        failure_code,
        error_message,
        response_code
      FROM override_requests
      WHERE session_id = ?
      ORDER BY ts DESC, request_log_id DESC
      LIMIT ? OFFSET ?
    `).all(sessionId, limit + 1, offset)) as OverrideRequestRow[];

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map(mapRequestRow);
  return {
    requests: page,
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
  };
}

export function diagnoseOverridePoc(
  db: Database,
  sessionId: string,
  runId?: string,
): OverridePocDiagnosis {
  const runRow = (runId
    ? db.prepare(`
      SELECT
        run_id,
        session_id,
        started_at,
        ended_at,
        run_status,
        tab_id,
        selected_tab_id,
        target_asset_url,
        local_file_path,
        resolved_local_file_path,
        content_type,
        auto_reload,
        config_path,
        file_exists,
        file_size_bytes,
        matched_requests,
        fulfilled_requests,
        last_matched_at,
        last_fulfilled_at,
        last_error_code,
        last_error_message
      FROM override_runs
      WHERE session_id = ? AND run_id = ?
      LIMIT 1
    `).get(sessionId, runId)
    : db.prepare(`
      SELECT
        run_id,
        session_id,
        started_at,
        ended_at,
        run_status,
        tab_id,
        selected_tab_id,
        target_asset_url,
        local_file_path,
        resolved_local_file_path,
        content_type,
        auto_reload,
        config_path,
        file_exists,
        file_size_bytes,
        matched_requests,
        fulfilled_requests,
        last_matched_at,
        last_fulfilled_at,
        last_error_code,
        last_error_message
      FROM override_runs
      WHERE session_id = ?
      ORDER BY started_at DESC, run_id DESC
      LIMIT 1
    `).get(sessionId)) as OverrideRunRow | undefined;

  if (!runRow) {
    return {
      sessionId,
      runId: null,
      summary: null,
      indicators: {
        exactUrlMismatch: 'possible',
        cacheOrNoReload: 'possible',
        serviceWorkerInterference: 'possible',
        sriOrCspInterference: 'possible',
        tabSelectionIssue: 'possible',
        debuggerLifecycleIssue: 'possible',
      },
      observedAssets: null,
      issues: [{
        code: 'NO_OVERRIDE_RUNS',
        severity: 'warning',
        message: 'No override audit runs were recorded for this session.',
        suggestedActions: [
          'Enable the override once for the session before requesting a diagnosis.',
          'Confirm the extension is pointed at the same local server base URL as the MCP server.',
        ],
      }],
    };
  }

  const run = mapRunRow(runRow);
  const requestFailureRows = db.prepare(`
    SELECT failure_code
    FROM override_requests
    WHERE session_id = ? AND run_id = ? AND request_status = 'failed'
  `).all(sessionId, run.runId) as Array<{ failure_code: string | null }>;

  const requestFailureCount = requestFailureRows.length;
  const requestFailureCodes = new Set(
    requestFailureRows
      .map((row) => row.failure_code)
      .filter((value): value is OverridePocFailureCode => isOverridePocFailureCode(value)),
  );

  const issues: OverridePocDiagnosisIssue[] = [];
  const observedAssets = getObservedAssetDiagnostics(db, sessionId, run.targetAssetUrl);
  let exactUrlMismatch: OverridePocDiagnosis['indicators']['exactUrlMismatch'] = 'unlikely';
  let cacheOrNoReload: OverridePocDiagnosis['indicators']['cacheOrNoReload'] = 'unlikely';
  let serviceWorkerInterference: OverridePocDiagnosis['indicators']['serviceWorkerInterference'] = 'unlikely';
  let sriOrCspInterference: OverridePocDiagnosis['indicators']['sriOrCspInterference'] = 'unlikely';
  let tabSelectionIssue: OverridePocDiagnosis['indicators']['tabSelectionIssue'] = 'unlikely';
  let debuggerLifecycleIssue: OverridePocDiagnosis['indicators']['debuggerLifecycleIssue'] = 'unlikely';

  if (run.lastErrorCode === 'CONFIG_DISABLED') {
    issues.push({
      code: 'CONFIG_DISABLED',
      severity: 'error',
      message: 'The override config is disabled, so no replacement can occur.',
      suggestedActions: [
        'Set `enabled` to `true` in the selected override config file.',
        'Refresh override status before enabling again.',
      ],
    });
  }

  if (run.lastErrorCode === 'LOCAL_FILE_MISSING') {
    issues.push({
      code: 'LOCAL_FILE_MISSING',
      severity: 'error',
      message: 'The configured local override file was missing when the run started.',
      suggestedActions: [
        'Fix the local file path in the override config.',
        'Verify the file exists on disk for the machine running the extension.',
      ],
    });
  }

  if (run.lastErrorCode === 'DEBUGGER_ATTACH_FAILED' || run.lastErrorCode === 'DEBUGGER_SETUP_FAILED') {
    debuggerLifecycleIssue = 'observed';
    issues.push({
      code: run.lastErrorCode,
      severity: 'error',
      message: 'Chrome debugger attach/setup failed before the override could intercept requests.',
      suggestedActions: [
        'Retry after closing any other debugger attached to the same tab.',
        'Confirm the selected tab is still open and bound to the active session.',
      ],
    });
  }

  if (run.lastErrorCode === 'DEBUGGER_DETACHED') {
    debuggerLifecycleIssue = 'observed';
    issues.push({
      code: 'DEBUGGER_DETACHED',
      severity: 'error',
      message: 'The debugger detached unexpectedly while the override run was active.',
      suggestedActions: [
        'Retry the run and watch for tab reloads or extension restarts.',
        'Check whether another debugger client is stealing the tab attachment.',
      ],
    });
  }

  if (observedAssets.observedAssetCount > 0 && !observedAssets.targetAssetObserved) {
    exactUrlMismatch = 'observed';
    issues.push({
      code: 'TARGET_ASSET_NOT_OBSERVED',
      severity: 'warning',
      message: 'The configured target asset URL was not present in the persisted script/style observations for this session.',
      suggestedActions: [
        'Run `observe_override_assets` on the target route and compare the observed URLs with the override rule.',
        'Regenerate or update the profile from observed assets before enabling the override.',
      ],
    });
  }

  if (observedAssets.targetAssetIntegrity) {
    sriOrCspInterference = 'observed';
    issues.push({
      code: 'TARGET_ASSET_SRI_PRESENT',
      severity: 'error',
      message: 'The observed target asset has an integrity attribute, so replaced bytes can be rejected by the browser.',
      suggestedActions: [
        'Remove or rewrite the document integrity attribute before relying on this override.',
        'Use a target without SRI or keep this override blocked until SRI mitigation exists.',
      ],
    });
  } else if (observedAssets.sriAssetCount > 0) {
    sriOrCspInterference = 'possible';
    issues.push({
      code: 'OBSERVED_SRI_ASSETS',
      severity: 'info',
      message: 'Some observed assets use integrity attributes; verify the selected override target is not SRI-protected.',
      suggestedActions: ['Inspect `list_observed_override_assets` before selecting a target asset.'],
    });
  }

  if (observedAssets.cspMetaTagCount > 0) {
    sriOrCspInterference = sriOrCspInterference === 'observed' ? 'observed' : 'possible';
    issues.push({
      code: 'CSP_META_PRESENT',
      severity: 'warning',
      message: 'The page had CSP meta tags when assets were observed; strict policies can block replacement behavior.',
      suggestedActions: [
        'Review CSP console errors after enabling the override.',
        'Prefer exact script/style asset replacement over adding new script sources.',
      ],
    });
  }

  if (observedAssets.serviceWorkerControlled) {
    serviceWorkerInterference = 'possible';
    issues.push({
      code: 'SERVICE_WORKER_CONTROLLED_PAGE',
      severity: 'warning',
      message: 'The observed page was controlled by a service worker. Overrides attempt to bypass service workers, but stale registrations can still confuse reload behavior.',
      suggestedActions: [
        'Hard reload after enabling the override.',
        'Unregister the service worker in devtools if requests still do not reach the override path.',
      ],
    });
  }

  if (run.matchedRequests === 0) {
    exactUrlMismatch = 'possible';
    cacheOrNoReload = 'possible';
    serviceWorkerInterference = 'possible';
    tabSelectionIssue = 'possible';
    issues.push({
      code: 'NO_REQUEST_MATCHED',
      severity: 'warning',
      message: 'The run never saw a request for the configured target asset URL.',
      suggestedActions: [
        'Verify the configured URL exactly matches the asset requested by the live page.',
        'Confirm the selected tab is the one loading the target asset.',
        'Force a hard reload if the page may already have the asset cached or prefetched.',
      ],
    });
  }

  if (run.matchedRequests > 0 && run.fulfilledRequests === 0) {
    sriOrCspInterference = 'possible';
    issues.push({
      code: 'MATCHED_BUT_NOT_FULFILLED',
      severity: 'warning',
      message: 'The target asset was matched, but no fulfilled response was recorded.',
      suggestedActions: [
        'Inspect failed override request rows for `OVERRIDE_ASSET_FETCH_FAILED` or `FULFILL_FAILED`.',
        'Check the page for integrity or CSP restrictions if the fulfilled asset still does not execute.',
      ],
    });
  }

  if (requestFailureCodes.has('OVERRIDE_ASSET_FETCH_FAILED')) {
    issues.push({
      code: 'OVERRIDE_ASSET_FETCH_FAILED',
      severity: 'error',
      message: 'The extension matched the request but could not fetch local override bytes from the server.',
      suggestedActions: [
        'Confirm the extension server base URL points at the intended local server.',
        'Check the override config and local file path served by `/overrides/poc/asset`.',
      ],
    });
  }

  if (requestFailureCodes.has('FULFILL_FAILED')) {
    sriOrCspInterference = 'possible';
    issues.push({
      code: 'FULFILL_FAILED',
      severity: 'error',
      message: 'Chrome accepted the match but the request fulfill step failed.',
      suggestedActions: [
        'Review the failed request rows and browser console for blocking errors.',
        'Check for CSP, integrity, or page-specific script loading constraints.',
      ],
    });
  }

  return {
    sessionId,
    runId: run.runId,
    summary: {
      runStatus: run.runStatus,
      matchedRequests: run.matchedRequests,
      fulfilledRequests: run.fulfilledRequests,
      requestFailureCount,
      lastErrorCode: run.lastErrorCode ?? null,
      lastErrorMessage: run.lastErrorMessage ?? null,
    },
    indicators: {
      exactUrlMismatch,
      cacheOrNoReload,
      serviceWorkerInterference,
      sriOrCspInterference,
      tabSelectionIssue,
      debuggerLifecycleIssue,
    },
    observedAssets,
    issues,
  };
}
