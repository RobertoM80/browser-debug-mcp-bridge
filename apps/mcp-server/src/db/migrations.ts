import { Database } from 'better-sqlite3';
import { initializeSchema, getSchemaVersion, clearDatabase, SCHEMA_VERSION } from './schema.js';

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
