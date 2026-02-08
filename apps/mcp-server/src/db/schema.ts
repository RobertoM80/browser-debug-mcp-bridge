import { Database } from 'better-sqlite3';

export const SCHEMA_VERSION = 1;

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
  allowlist_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_ended_at ON sessions(ended_at);

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
    DELETE FROM events;
    DELETE FROM sessions;
    DELETE FROM schema_version;
  `);
}
