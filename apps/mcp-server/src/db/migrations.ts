import { Database } from 'better-sqlite3';
import { initializeSchema, getSchemaVersion, clearDatabase, SCHEMA_VERSION } from './schema.js';
import { AutomationRepository, isAutomationLifecycleEventType } from './automation-repository.js';
import {
  OVERRIDE_POC_FAILURE_CODES,
  OVERRIDE_PLAN_AUDIT_KINDS,
  OVERRIDE_POC_REQUEST_STATUSES,
  OVERRIDE_POC_RUN_STATUSES,
  MOCK_ROUTE_BODY_KINDS,
  MOCK_ROUTE_MATCH_MODES,
  MOCK_ROUTE_MODES,
  MOCK_ROUTE_SOURCE_KINDS,
  MOCK_RUN_STATUSES,
  SSR_MOCK_AUDIT_ACTIONS,
  SSR_MOCK_AUDIT_STATUSES,
} from '../override-audit-contract.js';

export interface Migration {
  version: number;
  name: string;
  up: (db: Database) => void;
}

function getColumnNames(db: Database, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info('${tableName}')`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function tableExists(db: Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | undefined;
  return row !== undefined;
}

function getMaxTimestampBySession(db: Database, tableName: string, timestampColumn: string): Map<string, number> {
  if (!tableExists(db, tableName)) {
    return new Map();
  }

  const columns = getColumnNames(db, tableName);
  if (!columns.has('session_id') || !columns.has(timestampColumn)) {
    return new Map();
  }

  const rows = db
    .prepare(`
      SELECT session_id, MAX(${timestampColumn}) AS max_ts
      FROM ${tableName}
      GROUP BY session_id
    `)
    .all() as Array<{ session_id: string; max_ts: number | null }>;

  return new Map(
    rows
      .filter((row): row is { session_id: string; max_ts: number } => row.max_ts !== null)
      .map((row) => [row.session_id, row.max_ts]),
  );
}

function normalizeOriginCandidate(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function extractEventOrigin(payload: Record<string, unknown>): string | null {
  const candidates = [
    payload.origin,
    payload.url,
    payload.to,
    payload.href,
    payload.location,
    payload.requestUrl,
  ];

  for (const candidate of candidates) {
    const origin = normalizeOriginCandidate(candidate);
    if (origin) {
      return origin;
    }
  }

  return null;
}

const OVERRIDE_POC_RUN_STATUS_SQL = OVERRIDE_POC_RUN_STATUSES.map((value) => `'${value}'`).join(', ');
const OVERRIDE_POC_REQUEST_STATUS_SQL = OVERRIDE_POC_REQUEST_STATUSES.map((value) => `'${value}'`).join(', ');
const OVERRIDE_POC_FAILURE_CODE_SQL = OVERRIDE_POC_FAILURE_CODES.map((value) => `'${value}'`).join(', ');
const OVERRIDE_PLAN_AUDIT_KIND_SQL = OVERRIDE_PLAN_AUDIT_KINDS.map((value) => `'${value}'`).join(', ');
const MOCK_ROUTE_MODE_SQL = MOCK_ROUTE_MODES.map((value) => `'${value}'`).join(', ');
const MOCK_ROUTE_MATCH_MODE_SQL = MOCK_ROUTE_MATCH_MODES.map((value) => `'${value}'`).join(', ');
const MOCK_ROUTE_BODY_KIND_SQL = MOCK_ROUTE_BODY_KINDS.map((value) => `'${value}'`).join(', ');
const MOCK_ROUTE_SOURCE_KIND_SQL = MOCK_ROUTE_SOURCE_KINDS.map((value) => `'${value}'`).join(', ');
const MOCK_RUN_STATUS_SQL = MOCK_RUN_STATUSES.map((value) => `'${value}'`).join(', ');
const SSR_MOCK_AUDIT_ACTION_SQL = SSR_MOCK_AUDIT_ACTIONS.map((value) => `'${value}'`).join(', ');
const SSR_MOCK_AUDIT_STATUS_SQL = SSR_MOCK_AUDIT_STATUSES.map((value) => `'${value}'`).join(', ');

function ensureAutomationTablesAndBackfill(db: Database): void {
  db.exec(`
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
  `);

  ensureAutomationDiagnosticsColumns(db);

  const automationRepository = new AutomationRepository(db);
  const rows = db.prepare(`
    SELECT event_id, session_id, ts, payload_json, tab_id
    FROM events
    WHERE type = 'ui'
    ORDER BY ts ASC, rowid ASC
  `).all() as Array<{
    event_id: string;
    session_id: string;
    ts: number;
    payload_json: string;
    tab_id: number | null;
  }>;

  for (const row of rows) {
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.payload_json) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      payload = {};
    }

    const eventType = typeof payload.eventType === 'string' ? payload.eventType : '';
    if (!isAutomationLifecycleEventType(eventType)) {
      continue;
    }

    automationRepository.upsertLifecycleEvent({
      eventId: row.event_id,
      eventType,
      sessionId: row.session_id,
      timestamp: row.ts,
      tabId: row.tab_id,
      payload,
    });
  }
}

function ensureAutomationDiagnosticsColumns(db: Database): void {
  if (tableExists(db, 'automation_runs') && !getColumnNames(db, 'automation_runs').has('diagnostics_json')) {
    db.exec('ALTER TABLE automation_runs ADD COLUMN diagnostics_json TEXT;');
  }
  if (tableExists(db, 'automation_steps') && !getColumnNames(db, 'automation_steps').has('diagnostics_json')) {
    db.exec('ALTER TABLE automation_steps ADD COLUMN diagnostics_json TEXT;');
  }
}

function ensureMcpToolLoopGuardTables(db: Database): void {
  db.exec(`
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
  `);
}

function rebuildOverrideFailureCodeChecks(db: Database): void {
  db.exec(`
    PRAGMA foreign_keys=OFF;

    DROP INDEX IF EXISTS idx_override_requests_session_ts;
    DROP INDEX IF EXISTS idx_override_requests_run_ts;
    DROP INDEX IF EXISTS idx_override_requests_status_ts;
    DROP INDEX IF EXISTS idx_override_runs_session_started_at;
    DROP INDEX IF EXISTS idx_override_runs_session_status_started_at;

    ALTER TABLE override_requests RENAME TO override_requests_v11;
    ALTER TABLE override_runs RENAME TO override_runs_v11;

    CREATE TABLE override_runs (
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

    CREATE TABLE override_requests (
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
    )
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
      last_error_message,
      created_at,
      updated_at
    FROM override_runs_v11;

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
    )
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
      response_code,
      created_at,
      updated_at
    FROM override_requests_v11;

    DROP TABLE override_requests_v11;
    DROP TABLE override_runs_v11;

    CREATE INDEX IF NOT EXISTS idx_override_runs_session_started_at ON override_runs(session_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_override_runs_session_status_started_at ON override_runs(session_id, run_status, started_at);
    CREATE INDEX IF NOT EXISTS idx_override_requests_session_ts ON override_requests(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_override_requests_run_ts ON override_requests(run_id, ts);
    CREATE INDEX IF NOT EXISTS idx_override_requests_status_ts ON override_requests(request_status, ts);

    PRAGMA foreign_keys=ON;
  `);
}

const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: initializeSchema
  },
  {
    version: 2,
    name: 'retention_and_pinning',
    up: (db) => {
      const hasPinnedColumn = (db.prepare("PRAGMA table_info('sessions')").all() as Array<{ name: string }>).some(
        (column) => column.name === 'pinned',
      );
      if (!hasPinnedColumn) {
        db.exec(`
          ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
        `);
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_sessions_pinned_created_at ON sessions(pinned, created_at);
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS server_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          retention_days INTEGER NOT NULL DEFAULT 30,
          max_db_mb INTEGER NOT NULL DEFAULT 1024,
          max_sessions INTEGER NOT NULL DEFAULT 10000,
          cleanup_interval_minutes INTEGER NOT NULL DEFAULT 60,
          last_cleanup_at INTEGER,
          export_path_override TEXT
        );
      `);
      db.exec(`
        INSERT OR IGNORE INTO server_settings (
          id,
          retention_days,
          max_db_mb,
          max_sessions,
          cleanup_interval_minutes,
          last_cleanup_at,
          export_path_override
        ) VALUES (1, 30, 1024, 10000, 60, NULL, NULL);
      `);
    }
  },
  {
    version: 3,
    name: 'snapshots_storage',
    up: (db) => {
      db.exec(`
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
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_snapshots_session_ts ON snapshots(session_id, ts);
        CREATE INDEX IF NOT EXISTS idx_snapshots_session_trigger_ts ON snapshots(session_id, trigger, ts);
        CREATE INDEX IF NOT EXISTS idx_snapshots_png_path ON snapshots(png_path);
      `);
    },
  },
  {
    version: 4,
    name: 'event_origin_and_tab_scope',
    up: (db) => {
      const eventColumns = getColumnNames(db, 'events');
      if (!eventColumns.has('tab_id')) {
        db.exec('ALTER TABLE events ADD COLUMN tab_id INTEGER;');
      }
      if (!eventColumns.has('origin')) {
        db.exec('ALTER TABLE events ADD COLUMN origin TEXT;');
      }

      const networkColumns = getColumnNames(db, 'network');
      if (!networkColumns.has('origin')) {
        db.exec('ALTER TABLE network ADD COLUMN origin TEXT;');
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_events_tab_id ON events(tab_id);
        CREATE INDEX IF NOT EXISTS idx_events_origin ON events(origin);
        CREATE INDEX IF NOT EXISTS idx_events_session_origin_ts ON events(session_id, origin, ts);
        CREATE INDEX IF NOT EXISTS idx_network_origin ON network(origin);
        CREATE INDEX IF NOT EXISTS idx_network_session_origin_ts ON network(session_id, origin, ts_start);
      `);

      const updateEvent = db.prepare(`
        UPDATE events
        SET tab_id = COALESCE(?, tab_id), origin = COALESCE(?, origin)
        WHERE event_id = ?
      `);
      const updateNetwork = db.prepare('UPDATE network SET origin = ? WHERE request_id = ?');

      const runBackfill = db.transaction(() => {
        const eventRows = db.prepare(`
          SELECT event_id, payload_json, tab_id, origin
          FROM events
          WHERE tab_id IS NULL OR origin IS NULL
        `).all() as Array<{
          event_id: string;
          payload_json: string;
          tab_id: number | null;
          origin: string | null;
        }>;

        for (const row of eventRows) {
          let payload: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(row.payload_json) as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              payload = parsed as Record<string, unknown>;
            }
          } catch {
            payload = {};
          }

          const tabIdCandidate = payload.tabId;
          const tabId =
            typeof tabIdCandidate === 'number' && Number.isFinite(tabIdCandidate)
              ? Math.floor(tabIdCandidate)
              : null;
          const origin = extractEventOrigin(payload);

          updateEvent.run(tabId, origin, row.event_id);
        }

        const networkRows = db.prepare(`
          SELECT request_id, url
          FROM network
          WHERE origin IS NULL
        `).all() as Array<{ request_id: string; url: string | null }>;

        for (const row of networkRows) {
          const origin = normalizeOriginCandidate(row.url);
          if (origin) {
            updateNetwork.run(origin, row.request_id);
          }
        }
      });

      runBackfill();
    },
  },
  {
    version: 5,
    name: 'network_trace_and_body_capture',
    up: (db) => {
      const networkColumns = getColumnNames(db, 'network');
      if (!networkColumns.has('trace_id')) {
        db.exec('ALTER TABLE network ADD COLUMN trace_id TEXT;');
      }
      if (!networkColumns.has('tab_id')) {
        db.exec('ALTER TABLE network ADD COLUMN tab_id INTEGER;');
      }
      if (!networkColumns.has('request_content_type')) {
        db.exec('ALTER TABLE network ADD COLUMN request_content_type TEXT;');
      }
      if (!networkColumns.has('request_body_text')) {
        db.exec('ALTER TABLE network ADD COLUMN request_body_text TEXT;');
      }
      if (!networkColumns.has('request_body_json')) {
        db.exec('ALTER TABLE network ADD COLUMN request_body_json TEXT;');
      }
      if (!networkColumns.has('request_body_bytes')) {
        db.exec('ALTER TABLE network ADD COLUMN request_body_bytes INTEGER;');
      }
      if (!networkColumns.has('request_body_truncated')) {
        db.exec('ALTER TABLE network ADD COLUMN request_body_truncated INTEGER NOT NULL DEFAULT 0;');
      }
      if (!networkColumns.has('request_body_chunk_ref')) {
        db.exec('ALTER TABLE network ADD COLUMN request_body_chunk_ref TEXT;');
      }
      if (!networkColumns.has('response_content_type')) {
        db.exec('ALTER TABLE network ADD COLUMN response_content_type TEXT;');
      }
      if (!networkColumns.has('response_body_text')) {
        db.exec('ALTER TABLE network ADD COLUMN response_body_text TEXT;');
      }
      if (!networkColumns.has('response_body_json')) {
        db.exec('ALTER TABLE network ADD COLUMN response_body_json TEXT;');
      }
      if (!networkColumns.has('response_body_bytes')) {
        db.exec('ALTER TABLE network ADD COLUMN response_body_bytes INTEGER;');
      }
      if (!networkColumns.has('response_body_truncated')) {
        db.exec('ALTER TABLE network ADD COLUMN response_body_truncated INTEGER NOT NULL DEFAULT 0;');
      }
      if (!networkColumns.has('response_body_chunk_ref')) {
        db.exec('ALTER TABLE network ADD COLUMN response_body_chunk_ref TEXT;');
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_network_trace_id ON network(trace_id);
        CREATE INDEX IF NOT EXISTS idx_network_session_trace_ts ON network(session_id, trace_id, ts_start);
        CREATE INDEX IF NOT EXISTS idx_network_tab_id ON network(tab_id);
      `);

      db.exec(`
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
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_body_chunks_session_id ON body_chunks(session_id);
        CREATE INDEX IF NOT EXISTS idx_body_chunks_request_id ON body_chunks(request_id);
        CREATE INDEX IF NOT EXISTS idx_body_chunks_trace_id ON body_chunks(trace_id);
      `);
    },
  },
  {
    version: 6,
    name: 'session_pause_resume_state',
    up: (db) => {
      const sessionColumns = getColumnNames(db, 'sessions');
      if (!sessionColumns.has('paused_at')) {
        db.exec('ALTER TABLE sessions ADD COLUMN paused_at INTEGER;');
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_sessions_paused_at ON sessions(paused_at);
      `);
    },
  },
  {
    version: 7,
    name: 'automation_run_tables',
    up: ensureAutomationTablesAndBackfill,
  },
  {
    version: 8,
    name: 'session_last_seen_tracking',
    up: (db) => {
      const sessionColumns = getColumnNames(db, 'sessions');
      if (!sessionColumns.has('last_seen_at')) {
        db.exec('ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0;');
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_sessions_last_seen_at ON sessions(last_seen_at);
      `);

      const refreshedSessionColumns = getColumnNames(db, 'sessions');
      const pausedAtExpr = refreshedSessionColumns.has('paused_at') ? 's.paused_at' : 'NULL';
      const endedAtExpr = refreshedSessionColumns.has('ended_at') ? 's.ended_at' : 'NULL';
      const eventLastSeenBySession = getMaxTimestampBySession(db, 'events', 'ts');
      const networkLastSeenBySession = getMaxTimestampBySession(db, 'network', 'ts_start');
      const snapshotLastSeenBySession = getMaxTimestampBySession(db, 'snapshots', 'ts');
      const updateLastSeen = db.prepare('UPDATE sessions SET last_seen_at = ? WHERE session_id = ?');

      const runBackfill = db.transaction(() => {
        const rows = db.prepare(`
          SELECT
            s.session_id,
            s.created_at,
            ${pausedAtExpr} AS paused_at,
            ${endedAtExpr} AS ended_at
          FROM sessions s
        `).all() as Array<{
          session_id: string;
          created_at: number;
          paused_at: number | null;
          ended_at: number | null;
        }>;

        for (const row of rows) {
          const lastSeenAt = Math.max(
            row.created_at,
            row.paused_at ?? 0,
            row.ended_at ?? 0,
            eventLastSeenBySession.get(row.session_id) ?? 0,
            networkLastSeenBySession.get(row.session_id) ?? 0,
            snapshotLastSeenBySession.get(row.session_id) ?? 0,
          );
          updateLastSeen.run(lastSeenAt, row.session_id);
        }
      });

      runBackfill();
    },
  },
  {
    version: 9,
    name: 'override_audit_tables',
    up: (db) => {
      db.exec(`
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
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_override_runs_session_started_at ON override_runs(session_id, started_at);
        CREATE INDEX IF NOT EXISTS idx_override_runs_session_status_started_at ON override_runs(session_id, run_status, started_at);
      `);

      db.exec(`
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
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_override_requests_session_ts ON override_requests(session_id, ts);
        CREATE INDEX IF NOT EXISTS idx_override_requests_run_ts ON override_requests(run_id, ts);
        CREATE INDEX IF NOT EXISTS idx_override_requests_status_ts ON override_requests(request_status, ts);
      `);
    },
  },
  {
    version: 10,
    name: 'override_observed_assets',
    up: (db) => {
      db.exec(`
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
          asset_path TEXT,
          pathname TEXT,
          kind TEXT,
          initiator_type TEXT,
          rel TEXT,
          as_attr TEXT,
          integrity TEXT,
          from_dom INTEGER NOT NULL DEFAULT 0,
          from_performance INTEGER NOT NULL DEFAULT 0,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
        );
      `);

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_override_observed_assets_session_url ON override_observed_assets(session_id, asset_url);
        CREATE INDEX IF NOT EXISTS idx_override_observed_assets_session_seen ON override_observed_assets(session_id, last_seen_at);
        CREATE INDEX IF NOT EXISTS idx_override_observed_assets_asset_path ON override_observed_assets(asset_path);
      `);
    },
  },
  {
    version: 11,
    name: 'override_observed_request_metadata',
    up: (db) => {
      const columns = getColumnNames(db, 'override_observed_assets');
      const addColumn = (name: string, sql: string): void => {
        if (!columns.has(name)) {
          db.exec(`ALTER TABLE override_observed_assets ADD COLUMN ${sql};`);
        }
      };

      addColumn('rule_type', "rule_type TEXT NOT NULL DEFAULT 'asset'");
      addColumn('request_method', "request_method TEXT NOT NULL DEFAULT 'GET'");
      addColumn('resource_type', 'resource_type TEXT');
      addColumn('content_type', 'content_type TEXT');
      addColumn('status_code', 'status_code INTEGER');
      addColumn('from_navigation', 'from_navigation INTEGER NOT NULL DEFAULT 0');
      addColumn('from_fetch', 'from_fetch INTEGER NOT NULL DEFAULT 0');

      db.exec(`
        UPDATE override_observed_assets
        SET
          rule_type = COALESCE(NULLIF(rule_type, ''), 'asset'),
          request_method = COALESCE(NULLIF(request_method, ''), 'GET');

        DROP INDEX IF EXISTS idx_override_observed_assets_session_url;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_override_observed_assets_session_method_url
          ON override_observed_assets(session_id, request_method, asset_url);
        CREATE INDEX IF NOT EXISTS idx_override_observed_assets_rule_type
          ON override_observed_assets(rule_type);
      `);
    },
  },
  {
    version: 12,
    name: 'override_plan_audits',
    up: (db) => {
      db.exec(`
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

        CREATE INDEX IF NOT EXISTS idx_override_plan_audits_session_created_at
          ON override_plan_audits(session_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_override_plan_audits_target_url
          ON override_plan_audits(target_asset_url);
        CREATE INDEX IF NOT EXISTS idx_override_plan_audits_planner_kind
          ON override_plan_audits(planner_kind);
      `);
    },
  },
  {
    version: 13,
    name: 'override_failure_code_taxonomy',
    up: rebuildOverrideFailureCodeChecks,
  },
  {
    version: 14,
    name: 'merge_automation_tables_compatibility',
    up: ensureAutomationTablesAndBackfill,
  },
  {
    version: 15,
    name: 'mcp_tool_loop_guard',
    up: ensureMcpToolLoopGuardTables,
  },
  {
    version: 16,
    name: 'automation_diagnostics_json',
    up: ensureAutomationDiagnosticsColumns,
  },
  {
    version: 17,
    name: 'ssr_mock_audits',
    up: (db) => {
      db.exec(`
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

        CREATE INDEX IF NOT EXISTS idx_ssr_mock_audits_project_created_at
          ON ssr_mock_audits(project_root, created_at);
        CREATE INDEX IF NOT EXISTS idx_ssr_mock_audits_rollback_id
          ON ssr_mock_audits(rollback_id);
        CREATE INDEX IF NOT EXISTS idx_ssr_mock_audits_action_status_created_at
          ON ssr_mock_audits(action, status, created_at);
      `);
    },
  },
  {
    version: 18,
    name: 'mock_routes_runs_hits',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS mock_routes (
          route_id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          mode TEXT NOT NULL CHECK(mode IN (${MOCK_ROUTE_MODE_SQL})),
          method TEXT NOT NULL,
          match_mode TEXT NOT NULL CHECK(match_mode IN (${MOCK_ROUTE_MATCH_MODE_SQL})),
          target_url TEXT NOT NULL,
          status_code INTEGER NOT NULL,
          response_headers_json TEXT NOT NULL,
          body_kind TEXT NOT NULL CHECK(body_kind IN (${MOCK_ROUTE_BODY_KIND_SQL})),
          body_json TEXT,
          body_text TEXT,
          body_base64 TEXT,
          body_file_path TEXT,
          delay_ms INTEGER NOT NULL DEFAULT 0,
          source_kind TEXT NOT NULL CHECK(source_kind IN (${MOCK_ROUTE_SOURCE_KIND_SQL})),
          session_scope TEXT,
          project_root TEXT,
          ttl_ms INTEGER,
          expires_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_mock_routes_mode_enabled_created_at
          ON mock_routes(mode, enabled, created_at);
        CREATE INDEX IF NOT EXISTS idx_mock_routes_target_url_method
          ON mock_routes(target_url, method);
        CREATE INDEX IF NOT EXISTS idx_mock_routes_project_root
          ON mock_routes(project_root);

        CREATE TABLE IF NOT EXISTS mock_runs (
          run_id TEXT PRIMARY KEY,
          route_id TEXT NOT NULL,
          execution_mode TEXT NOT NULL CHECK(execution_mode IN (${MOCK_ROUTE_MODE_SQL})),
          session_id TEXT,
          tab_id INTEGER,
          project_root TEXT,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          status TEXT NOT NULL CHECK(status IN (${MOCK_RUN_STATUS_SQL})),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (route_id) REFERENCES mock_routes(route_id) ON DELETE CASCADE,
          FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_mock_runs_route_started_at
          ON mock_runs(route_id, started_at);
        CREATE INDEX IF NOT EXISTS idx_mock_runs_session_status_started_at
          ON mock_runs(session_id, status, started_at);
        CREATE INDEX IF NOT EXISTS idx_mock_runs_project_root_started_at
          ON mock_runs(project_root, started_at);

        CREATE TABLE IF NOT EXISTS mock_hits (
          hit_id TEXT PRIMARY KEY,
          run_id TEXT,
          route_id TEXT NOT NULL,
          ts INTEGER NOT NULL,
          request_url TEXT NOT NULL,
          request_method TEXT NOT NULL,
          matched INTEGER NOT NULL DEFAULT 0,
          fulfilled INTEGER NOT NULL DEFAULT 0,
          status_code INTEGER,
          response_source TEXT NOT NULL CHECK(response_source IN (${MOCK_ROUTE_SOURCE_KIND_SQL})),
          error_code TEXT,
          error_message TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (run_id) REFERENCES mock_runs(run_id) ON DELETE SET NULL,
          FOREIGN KEY (route_id) REFERENCES mock_routes(route_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_mock_hits_route_ts
          ON mock_hits(route_id, ts);
        CREATE INDEX IF NOT EXISTS idx_mock_hits_run_ts
          ON mock_hits(run_id, ts);
        CREATE INDEX IF NOT EXISTS idx_mock_hits_matched_fulfilled_ts
          ON mock_hits(matched, fulfilled, ts);
      `);
    },
  },
];

export function runMigrations(db: Database): void {
  const currentVersion = getSchemaVersion(db) || 0;

  const pendingMigrations = migrations.filter(m => m.version > currentVersion);

  for (const migration of pendingMigrations) {
    migration.up(db);

    const insertVersion = db.prepare(`
      INSERT INTO schema_version (version, applied_at)
      VALUES (?, ?)
    `);
    insertVersion.run(migration.version, Date.now());
  }
}

export function initializeDatabase(db: Database): void {
  runMigrations(db);
}

export function resetDatabase(db: Database): void {
  clearDatabase(db);
  initializeDatabase(db);
}

export { getSchemaVersion, clearDatabase, SCHEMA_VERSION };
