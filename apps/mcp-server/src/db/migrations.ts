import { Database } from 'better-sqlite3';
import { initializeSchema, getSchemaVersion, clearDatabase, SCHEMA_VERSION } from './schema.js';
import {
  OVERRIDE_POC_FAILURE_CODES,
  OVERRIDE_POC_REQUEST_STATUSES,
  OVERRIDE_POC_RUN_STATUSES,
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
    name: 'session_last_seen_tracking',
    up: (db) => {
      const sessionColumns = getColumnNames(db, 'sessions');
      if (!sessionColumns.has('last_seen_at')) {
        db.exec('ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0;');
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_sessions_last_seen_at ON sessions(last_seen_at);
      `);

      const updateLastSeen = db.prepare('UPDATE sessions SET last_seen_at = ? WHERE session_id = ?');

      const runBackfill = db.transaction(() => {
        const rows = db.prepare(`
          SELECT
            s.session_id,
            s.created_at,
            s.paused_at,
            s.ended_at,
            (
              SELECT MAX(ts)
              FROM events
              WHERE session_id = s.session_id
            ) AS event_last_seen_at,
            (
              SELECT MAX(ts_start)
              FROM network
              WHERE session_id = s.session_id
            ) AS network_last_seen_at,
            (
              SELECT MAX(ts)
              FROM snapshots
              WHERE session_id = s.session_id
            ) AS snapshot_last_seen_at
          FROM sessions s
        `).all() as Array<{
          session_id: string;
          created_at: number;
          paused_at: number | null;
          ended_at: number | null;
          event_last_seen_at: number | null;
          network_last_seen_at: number | null;
          snapshot_last_seen_at: number | null;
        }>;

        for (const row of rows) {
          const lastSeenAt = Math.max(
            row.created_at,
            row.paused_at ?? 0,
            row.ended_at ?? 0,
            row.event_last_seen_at ?? 0,
            row.network_last_seen_at ?? 0,
            row.snapshot_last_seen_at ?? 0,
          );
          updateLastSeen.run(lastSeenAt, row.session_id);
        }
      });

      runBackfill();
    },
  },
  {
    version: 8,
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
    version: 9,
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
