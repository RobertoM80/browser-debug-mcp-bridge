import { Database } from 'better-sqlite3';
import { initializeSchema, getSchemaVersion, clearDatabase, SCHEMA_VERSION } from './schema.js';

export interface Migration {
  version: number;
  name: string;
  up: (db: Database) => void;
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
  }
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
