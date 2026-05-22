import { Database } from 'better-sqlite3';
import {
  OVERRIDE_POC_FAILURE_CODES,
  OVERRIDE_PLAN_AUDIT_KINDS,
  OVERRIDE_POC_REQUEST_STATUSES,
  OVERRIDE_POC_RUN_STATUSES,
  SSR_MOCK_AUDIT_ACTIONS,
  SSR_MOCK_AUDIT_STATUSES,
} from '../override-audit-contract.js';

export const SCHEMA_VERSION = 17;

const OVERRIDE_POC_RUN_STATUS_SQL = OVERRIDE_POC_RUN_STATUSES.map((value) => `'${value}'`).join(', ');
const OVERRIDE_POC_REQUEST_STATUS_SQL = OVERRIDE_POC_REQUEST_STATUSES.map((value) => `'${value}'`).join(', ');
const OVERRIDE_POC_FAILURE_CODE_SQL = OVERRIDE_POC_FAILURE_CODES.map((value) => `'${value}'`).join(', ');
const OVERRIDE_PLAN_AUDIT_KIND_SQL = OVERRIDE_PLAN_AUDIT_KINDS.map((value) => `'${value}'`).join(', ');
const SSR_MOCK_AUDIT_ACTION_SQL = SSR_MOCK_AUDIT_ACTIONS.map((value) => `'${value}'`).join(', ');
const SSR_MOCK_AUDIT_STATUS_SQL = SSR_MOCK_AUDIT_STATUSES.map((value) => `'${value}'`).join(', ');

export const CREATE_TABLES_SQL = `
-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  paused_at INTEGER,
  ended_at INTEGER,
  tab_id INTEGER,
  window_id INTEGER,
  url_start TEXT,
  url_last TEXT,
  user_agent TEXT,
  viewport_w INTEGER,
  viewport_h INTEGER,
  dpr REAL,
  safe_mode INTEGER NOT NULL DEFAULT 0,
  allowlist_hash TEXT,
  pinned INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_ended_at ON sessions(ended_at);
CREATE INDEX IF NOT EXISTS idx_sessions_pinned_created_at ON sessions(pinned, created_at);

-- Server settings table
CREATE TABLE IF NOT EXISTS server_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  retention_days INTEGER NOT NULL DEFAULT 30,
  max_db_mb INTEGER NOT NULL DEFAULT 1024,
  max_sessions INTEGER NOT NULL DEFAULT 10000,
  cleanup_interval_minutes INTEGER NOT NULL DEFAULT 60,
  last_cleanup_at INTEGER,
  export_path_override TEXT
);

INSERT OR IGNORE INTO server_settings (
  id,
  retention_days,
  max_db_mb,
  max_sessions,
  cleanup_interval_minutes,
  last_cleanup_at,
  export_path_override
) VALUES (1, 30, 1024, 10000, 60, NULL, NULL);

-- Events table
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('console', 'error', 'network', 'nav', 'ui', 'element_ref')),
  payload_json TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_session_type ON events(session_id, type);

-- Network table
CREATE TABLE IF NOT EXISTS network (
  request_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  trace_id TEXT,
  tab_id INTEGER,
  ts_start INTEGER NOT NULL,
  duration_ms INTEGER,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  status INTEGER,
  initiator TEXT CHECK(initiator IN ('fetch', 'xhr', 'img', 'script', 'other')),
  error_class TEXT CHECK(error_class IN ('timeout', 'cors', 'dns', 'blocked', 'http_error', 'unknown')),
  response_size_est INTEGER,
  request_content_type TEXT,
  request_body_text TEXT,
  request_body_json TEXT,
  request_body_bytes INTEGER,
  request_body_truncated INTEGER NOT NULL DEFAULT 0,
  request_body_chunk_ref TEXT,
  response_content_type TEXT,
  response_body_text TEXT,
  response_body_json TEXT,
  response_body_bytes INTEGER,
  response_body_truncated INTEGER NOT NULL DEFAULT 0,
  response_body_chunk_ref TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_network_session_id ON network(session_id);
CREATE INDEX IF NOT EXISTS idx_network_url ON network(url);
CREATE INDEX IF NOT EXISTS idx_network_ts_start ON network(ts_start);
CREATE INDEX IF NOT EXISTS idx_network_error_class ON network(error_class);
CREATE INDEX IF NOT EXISTS idx_network_session_error ON network(session_id, error_class);

CREATE TABLE IF NOT EXISTS body_chunks (
  chunk_ref TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  request_id TEXT,
  trace_id TEXT,
  body_kind TEXT NOT NULL CHECK(body_kind IN ('request', 'response')),
  content_type TEXT,
  body_text TEXT NOT NULL,
  body_bytes INTEGER NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_body_chunks_session_id ON body_chunks(session_id);
CREATE INDEX IF NOT EXISTS idx_body_chunks_request_id ON body_chunks(request_id);
CREATE INDEX IF NOT EXISTS idx_body_chunks_trace_id ON body_chunks(trace_id);

-- Error fingerprints table
CREATE TABLE IF NOT EXISTS error_fingerprints (
  fingerprint TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  sample_message TEXT NOT NULL,
  sample_stack TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_error_fingerprints_session_id ON error_fingerprints(session_id);
CREATE INDEX IF NOT EXISTS idx_error_fingerprints_count ON error_fingerprints(count);
CREATE INDEX IF NOT EXISTS idx_error_fingerprints_last_seen ON error_fingerprints(last_seen_at);

-- UI snapshots table
CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  trigger_event_id TEXT,
  ts INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  selector TEXT,
  url TEXT,
  mode TEXT NOT NULL,
  style_mode TEXT,
  dom_json TEXT,
  styles_json TEXT,
  png_path TEXT,
  png_mime TEXT,
  png_bytes INTEGER,
  dom_truncated INTEGER NOT NULL DEFAULT 0,
  styles_truncated INTEGER NOT NULL DEFAULT 0,
  png_truncated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
  FOREIGN KEY (trigger_event_id) REFERENCES events(event_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_session_ts ON snapshots(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_snapshots_session_trigger_ts ON snapshots(session_id, trigger, ts);
CREATE INDEX IF NOT EXISTS idx_snapshots_png_path ON snapshots(png_path);

-- Automation runs table
CREATE TABLE IF NOT EXISTS automation_runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  trace_id TEXT,
  action TEXT,
  tab_id INTEGER,
  selector TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  stop_reason TEXT,
  target_summary_json TEXT,
  diagnostics_json TEXT,
  failure_json TEXT,
  redaction_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_automation_runs_session_started ON automation_runs(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_automation_runs_session_status ON automation_runs(session_id, status);
CREATE INDEX IF NOT EXISTS idx_automation_runs_trace_id ON automation_runs(trace_id);

-- Automation steps table
CREATE TABLE IF NOT EXISTS automation_steps (
  step_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  step_order INTEGER NOT NULL,
  trace_id TEXT,
  action TEXT NOT NULL,
  selector TEXT,
  status TEXT NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  duration_ms INTEGER,
  tab_id INTEGER,
  target_summary_json TEXT,
  diagnostics_json TEXT,
  redaction_json TEXT,
  failure_json TEXT,
  input_metadata_json TEXT,
  event_type TEXT NOT NULL,
  event_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (run_id) REFERENCES automation_runs(run_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE SET NULL,
  UNIQUE(run_id, step_order)
);

CREATE INDEX IF NOT EXISTS idx_automation_steps_run_order ON automation_steps(run_id, step_order);
CREATE INDEX IF NOT EXISTS idx_automation_steps_session_started ON automation_steps(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_automation_steps_trace_id ON automation_steps(trace_id);

CREATE TABLE IF NOT EXISTS override_runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  run_status TEXT NOT NULL CHECK(run_status IN (${OVERRIDE_POC_RUN_STATUS_SQL})),
  tab_id INTEGER NOT NULL,
  selected_tab_id INTEGER,
  target_asset_url TEXT NOT NULL,
  local_file_path TEXT NOT NULL,
  resolved_local_file_path TEXT NOT NULL,
  content_type TEXT NOT NULL,
  auto_reload INTEGER NOT NULL DEFAULT 0,
  config_path TEXT NOT NULL,
  file_exists INTEGER NOT NULL DEFAULT 0,
  file_size_bytes INTEGER,
  matched_requests INTEGER NOT NULL DEFAULT 0,
  fulfilled_requests INTEGER NOT NULL DEFAULT 0,
  last_matched_at INTEGER,
  last_fulfilled_at INTEGER,
  last_error_code TEXT CHECK(last_error_code IN (${OVERRIDE_POC_FAILURE_CODE_SQL})),
  last_error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_override_runs_session_started_at ON override_runs(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_override_runs_session_status_started_at ON override_runs(session_id, run_status, started_at);

CREATE TABLE IF NOT EXISTS override_requests (
  request_log_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  request_url TEXT NOT NULL,
  request_status TEXT NOT NULL CHECK(request_status IN (${OVERRIDE_POC_REQUEST_STATUS_SQL})),
  failure_code TEXT CHECK(failure_code IN (${OVERRIDE_POC_FAILURE_CODE_SQL})),
  error_message TEXT,
  response_code INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (run_id) REFERENCES override_runs(run_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_override_requests_session_ts ON override_requests(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_override_requests_run_ts ON override_requests(run_id, ts);
CREATE INDEX IF NOT EXISTS idx_override_requests_status_ts ON override_requests(request_status, ts);

CREATE TABLE IF NOT EXISTS override_plan_audits (
  plan_id TEXT PRIMARY KEY,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  planner_kind TEXT NOT NULL CHECK(planner_kind IN (${OVERRIDE_PLAN_AUDIT_KIND_SQL})),
  tool_name TEXT NOT NULL,
  profile_id TEXT,
  rule_id TEXT NOT NULL,
  rule_type TEXT NOT NULL,
  request_method TEXT NOT NULL,
  match_mode TEXT NOT NULL,
  target_asset_url TEXT NOT NULL,
  local_file_path TEXT,
  config_path TEXT,
  content_type TEXT NOT NULL,
  original_sha256 TEXT,
  patched_sha256 TEXT,
  original_bytes INTEGER,
  patched_bytes INTEGER,
  patch_summary_json TEXT NOT NULL,
  preview_json TEXT,
  warnings_json TEXT NOT NULL,
  blockers_json TEXT NOT NULL,
  captured_from_live_session_json TEXT,
  rollback_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_override_plan_audits_session_created_at ON override_plan_audits(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_override_plan_audits_target_url ON override_plan_audits(target_asset_url);
CREATE INDEX IF NOT EXISTS idx_override_plan_audits_planner_kind ON override_plan_audits(planner_kind);

CREATE TABLE IF NOT EXISTS ssr_mock_audits (
  audit_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN (${SSR_MOCK_AUDIT_ACTION_SQL})),
  status TEXT NOT NULL CHECK(status IN (${SSR_MOCK_AUDIT_STATUS_SQL})),
  project_root TEXT NOT NULL,
  target_url TEXT,
  api_host TEXT,
  env_var_name TEXT,
  env_file_path TEXT,
  mock_base_url TEXT,
  rollback_id TEXT,
  summary_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ssr_mock_audits_project_created_at ON ssr_mock_audits(project_root, created_at);
CREATE INDEX IF NOT EXISTS idx_ssr_mock_audits_rollback_id ON ssr_mock_audits(rollback_id);
CREATE INDEX IF NOT EXISTS idx_ssr_mock_audits_action_status_created_at ON ssr_mock_audits(action, status, created_at);

CREATE TABLE IF NOT EXISTS override_observed_assets (
  observed_asset_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  tab_id INTEGER,
  page_url TEXT,
  base_url TEXT,
  page_title TEXT,
  service_worker_controlled INTEGER NOT NULL DEFAULT 0,
  csp_meta_json TEXT,
  asset_url TEXT NOT NULL,
  rule_type TEXT NOT NULL DEFAULT 'asset',
  request_method TEXT NOT NULL DEFAULT 'GET',
  resource_type TEXT,
  content_type TEXT,
  status_code INTEGER,
  asset_path TEXT,
  pathname TEXT,
  kind TEXT,
  initiator_type TEXT,
  rel TEXT,
  as_attr TEXT,
  integrity TEXT,
  from_dom INTEGER NOT NULL DEFAULT 0,
  from_performance INTEGER NOT NULL DEFAULT 0,
  from_navigation INTEGER NOT NULL DEFAULT 0,
  from_fetch INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_override_observed_assets_session_method_url ON override_observed_assets(session_id, request_method, asset_url);
CREATE INDEX IF NOT EXISTS idx_override_observed_assets_session_seen ON override_observed_assets(session_id, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_override_observed_assets_asset_path ON override_observed_assets(asset_path);
CREATE INDEX IF NOT EXISTS idx_override_observed_assets_rule_type ON override_observed_assets(rule_type);

CREATE TABLE IF NOT EXISTS mcp_tool_invocations (
  invocation_id TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  session_id TEXT,
  family TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  input_summary_json TEXT NOT NULL,
  outcome_type TEXT NOT NULL CHECK(outcome_type IN ('success', 'failed', 'no_progress', 'blocked')),
  root_cause_code TEXT,
  state_hash TEXT,
  state_summary_json TEXT NOT NULL,
  response_bytes INTEGER,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  warning INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_tool_invocations_tool_input_time
  ON mcp_tool_invocations(tool_name, session_id, input_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_mcp_tool_invocations_family_root_time
  ON mcp_tool_invocations(family, session_id, root_cause_code, state_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_mcp_tool_invocations_created_at
  ON mcp_tool_invocations(created_at);

CREATE TABLE IF NOT EXISTS mcp_loop_incidents (
  incident_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('tool-input', 'family-root-cause')),
  status TEXT NOT NULL CHECK(status IN ('open', 'resolved', 'expired')),
  tool_name TEXT,
  session_id TEXT,
  family TEXT NOT NULL,
  input_hash TEXT,
  root_cause_code TEXT,
  state_hash TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  blocked_until INTEGER,
  severity TEXT NOT NULL CHECK(severity IN ('warning', 'blocked')),
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_loop_incidents_open_fingerprint
  ON mcp_loop_incidents(fingerprint)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_mcp_loop_incidents_status_blocked
  ON mcp_loop_incidents(status, blocked_until);
CREATE INDEX IF NOT EXISTS idx_mcp_loop_incidents_session_family
  ON mcp_loop_incidents(session_id, family, status);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`;

export function initializeSchema(db: Database): void {
  db.exec(CREATE_TABLES_SQL);
}

export function getSchemaVersion(db: Database): number | null {
  const tableExists = db.prepare(`
    SELECT name FROM sqlite_master 
    WHERE type='table' AND name='schema_version'
  `).get();
  
  if (!tableExists) {
    return null;
  }
  
  const result = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number } | undefined;
  return result?.version ?? null;
}

export function clearDatabase(db: Database): void {
  db.exec(`
    DELETE FROM error_fingerprints;
    DELETE FROM body_chunks;
    DELETE FROM network;
    DELETE FROM snapshots;
    DELETE FROM automation_steps;
    DELETE FROM automation_runs;
    DELETE FROM override_observed_assets;
    DELETE FROM override_plan_audits;
    DELETE FROM ssr_mock_audits;
    DELETE FROM override_requests;
    DELETE FROM override_runs;
    DELETE FROM mcp_loop_incidents;
    DELETE FROM mcp_tool_invocations;
    DELETE FROM events;
    DELETE FROM sessions;
    DELETE FROM server_settings;
    DELETE FROM schema_version;
  `);
}
