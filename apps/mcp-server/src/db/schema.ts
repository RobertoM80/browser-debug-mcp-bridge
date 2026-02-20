import { Database } from 'better-sqlite3';

export const SCHEMA_VERSION = 3;

export const CREATE_TABLES_SQL = `
-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
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
  ts_start INTEGER NOT NULL,
  duration_ms INTEGER,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  status INTEGER,
  initiator TEXT CHECK(initiator IN ('fetch', 'xhr', 'img', 'script', 'other')),
  error_class TEXT CHECK(error_class IN ('timeout', 'cors', 'dns', 'blocked', 'http_error', 'unknown')),
  response_size_est INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_network_session_id ON network(session_id);
CREATE INDEX IF NOT EXISTS idx_network_url ON network(url);
CREATE INDEX IF NOT EXISTS idx_network_ts_start ON network(ts_start);
CREATE INDEX IF NOT EXISTS idx_network_error_class ON network(error_class);
CREATE INDEX IF NOT EXISTS idx_network_session_error ON network(session_id, error_class);

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
    DELETE FROM network;
    DELETE FROM snapshots;
    DELETE FROM events;
    DELETE FROM sessions;
    DELETE FROM server_settings;
    DELETE FROM schema_version;
  `);
}
