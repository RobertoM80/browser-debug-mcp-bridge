import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync, existsSync } from 'fs';
import {
  createConnection,
  closeConnection,
  getConnection,
  isConnected,
  resetConnection
} from './connection';
import { initializeSchema, getSchemaVersion, clearDatabase, SCHEMA_VERSION } from './schema';
import { initializeDatabase, resetDatabase, runMigrations } from './migrations';
import { getDatabasePath } from '../runtime-paths';

describe('Database Connection', () => {
  let testDbPath: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    testDbPath = join(tmpdir(), `test-${Date.now()}.db`);
    resetConnection();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    closeConnection();
    process.env = { ...originalEnv };
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
  });

  describe('createConnection', () => {
    it('should create a new database connection', () => {
      const conn = createConnection(testDbPath);
      expect(conn).toBeDefined();
      expect(conn.db).toBeDefined();
      expect(conn.isConnected).toBe(true);
      conn.db.close();
    });

    it('should set WAL journal mode', () => {
      const conn = createConnection(testDbPath);
      const result = conn.db.pragma('journal_mode') as [{ journal_mode: string }];
      expect(result[0].journal_mode).toBe('wal');
      conn.db.close();
    });

    it('should enable foreign keys', () => {
      const conn = createConnection(testDbPath);
      const result = conn.db.pragma('foreign_keys') as [{ foreign_keys: number }];
      expect(result[0].foreign_keys).toBe(1);
      conn.db.close();
    });
  });

  describe('getConnection', () => {
    it('should return singleton connection', () => {
      process.env.DATA_DIR = tmpdir();
      const conn1 = getConnection();
      const conn2 = getConnection();
      expect(conn1).toBe(conn2);
      delete process.env.DATA_DIR;
    });
  });

  describe('isConnected', () => {
    it('should return false when not connected', () => {
      resetConnection();
      expect(isConnected()).toBe(false);
    });

    it('should return true when connected', () => {
      process.env.DATA_DIR = tmpdir();
      getConnection();
      expect(isConnected()).toBe(true);
      delete process.env.DATA_DIR;
    });
  });

  describe('getDatabasePath', () => {
    it('should use DATA_DIR env var when set', () => {
      const customDir = join(tmpdir(), 'custom-data');
      process.env.DATA_DIR = customDir;
      const path = getDatabasePath();
      expect(path).toContain(customDir);
      delete process.env.DATA_DIR;
    });

    it('should use a user-local runtime directory when DATA_DIR not set', () => {
      delete process.env.DATA_DIR;
      delete process.env.XDG_STATE_HOME;
      delete process.env.XDG_DATA_HOME;

      const homeRoot = join(tmpdir(), `runtime-home-${Date.now()}`);
      process.env.HOME = homeRoot;

      if (process.platform === 'win32') {
        process.env.LOCALAPPDATA = join(homeRoot, 'AppData', 'Local');
        process.env.APPDATA = join(homeRoot, 'AppData', 'Roaming');
      }

      const path = getDatabasePath();
      expect(path).toContain('browser-debug.db');
      expect(path).not.toContain(`${process.cwd()}\\data`);
      expect(path).not.toContain(`${process.cwd()}/data`);
    });
  });
});

describe('Database Schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
  });

  describe('initializeSchema', () => {
    it('should create sessions table', () => {
      initializeSchema(db);
      const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get();
      expect(result).toBeDefined();
    });

    it('should create events table', () => {
      initializeSchema(db);
      const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get();
      expect(result).toBeDefined();
    });

    it('should create network table', () => {
      initializeSchema(db);
      const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='network'").get();
      expect(result).toBeDefined();
    });

    it('should create error_fingerprints table', () => {
      initializeSchema(db);
      const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='error_fingerprints'").get();
      expect(result).toBeDefined();
    });

    it('should create body_chunks table', () => {
      initializeSchema(db);
      const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='body_chunks'").get();
      expect(result).toBeDefined();
    });

    it('should create snapshots table', () => {
      initializeSchema(db);
      const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='snapshots'").get();
      expect(result).toBeDefined();
    });

    it('should create automation tables', () => {
      initializeSchema(db);
      const runs = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='automation_runs'").get();
      const steps = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='automation_steps'").get();
      expect(runs).toBeDefined();
      expect(steps).toBeDefined();
    });

    it('should create schema_version table', () => {
      initializeSchema(db);
      const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get();
      expect(result).toBeDefined();
    });

    it('should create indexes on sessions table', () => {
      initializeSchema(db);
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions'").all() as { name: string }[];
      const indexNames = indexes.map(i => i.name);
      expect(indexNames).toContain('idx_sessions_created_at');
      expect(indexNames).toContain('idx_sessions_ended_at');
    });

    it('should create indexes on events table', () => {
      initializeSchema(db);
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'").all() as { name: string }[];
      const indexNames = indexes.map(i => i.name);
      expect(indexNames).toContain('idx_events_session_id');
      expect(indexNames).toContain('idx_events_ts');
      expect(indexNames).toContain('idx_events_type');
      expect(indexNames).toContain('idx_events_session_type');
    });

    it('should create indexes on network table', () => {
      initializeSchema(db);
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='network'").all() as { name: string }[];
      const indexNames = indexes.map(i => i.name);
      expect(indexNames).toContain('idx_network_session_id');
      expect(indexNames).toContain('idx_network_url');
      expect(indexNames).toContain('idx_network_ts_start');
      expect(indexNames).toContain('idx_network_error_class');
      expect(indexNames).toContain('idx_network_session_error');
    });

    it('should create indexes on body_chunks table', () => {
      initializeSchema(db);
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='body_chunks'").all() as { name: string }[];
      const indexNames = indexes.map(i => i.name);
      expect(indexNames).toContain('idx_body_chunks_session_id');
      expect(indexNames).toContain('idx_body_chunks_request_id');
      expect(indexNames).toContain('idx_body_chunks_trace_id');
    });

    it('should create indexes on error_fingerprints table', () => {
      initializeSchema(db);
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='error_fingerprints'").all() as { name: string }[];
      const indexNames = indexes.map(i => i.name);
      expect(indexNames).toContain('idx_error_fingerprints_session_id');
      expect(indexNames).toContain('idx_error_fingerprints_count');
      expect(indexNames).toContain('idx_error_fingerprints_last_seen');
    });

    it('should create indexes on snapshots table', () => {
      initializeSchema(db);
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='snapshots'").all() as { name: string }[];
      const indexNames = indexes.map(i => i.name);
      expect(indexNames).toContain('idx_snapshots_session_ts');
      expect(indexNames).toContain('idx_snapshots_session_trigger_ts');
      expect(indexNames).toContain('idx_snapshots_png_path');
    });

    it('should create indexes on automation tables', () => {
      initializeSchema(db);
      const runIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='automation_runs'").all() as { name: string }[];
      const stepIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='automation_steps'").all() as { name: string }[];

      expect(runIndexes.map((index) => index.name)).toEqual(expect.arrayContaining([
        'idx_automation_runs_session_started',
        'idx_automation_runs_session_status',
        'idx_automation_runs_trace_id',
      ]));
      expect(stepIndexes.map((index) => index.name)).toEqual(expect.arrayContaining([
        'idx_automation_steps_run_order',
        'idx_automation_steps_session_started',
        'idx_automation_steps_trace_id',
      ]));
    });

    it('should record schema version when using migrations', () => {
      initializeDatabase(db);
      const version = getSchemaVersion(db);
      expect(version).toBe(SCHEMA_VERSION);
    });
  });

  describe('getSchemaVersion', () => {
    it('should return null when schema_version table does not exist', () => {
      const version = getSchemaVersion(db);
      expect(version).toBeNull();
    });

    it('should return version after migration', () => {
      initializeDatabase(db);
      const version = getSchemaVersion(db);
      expect(version).toBe(SCHEMA_VERSION);
    });
  });

  describe('clearDatabase', () => {
    it('should clear all data from tables', () => {
      initializeSchema(db);
      
      db.prepare(`
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('test-1', 123456789, 0)
      `).run();
      
      clearDatabase(db);
      
      const count = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
      expect(count.count).toBe(0);
    });
  });
});

describe('Database Migrations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
  });

  describe('runMigrations', () => {
    it('should apply pending migrations', () => {
      runMigrations(db);
      const version = getSchemaVersion(db);
      expect(version).toBeGreaterThanOrEqual(1);
    });

    it('should be idempotent', () => {
      runMigrations(db);
      runMigrations(db);
      const version = getSchemaVersion(db);
      expect(version).toBe(SCHEMA_VERSION);
    });
  });

  describe('initializeDatabase', () => {
    it('should create all tables and indexes', () => {
      initializeDatabase(db);
      
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      const tableNames = tables.map(t => t.name);
      
      expect(tableNames).toContain('sessions');
      expect(tableNames).toContain('events');
      expect(tableNames).toContain('network');
      expect(tableNames).toContain('body_chunks');
      expect(tableNames).toContain('error_fingerprints');
      expect(tableNames).toContain('snapshots');
      expect(tableNames).toContain('automation_runs');
      expect(tableNames).toContain('automation_steps');
      expect(tableNames).toContain('schema_version');
    });

    it('should include trace indexes after all migrations', () => {
      initializeDatabase(db);
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='network'").all() as { name: string }[];
      const indexNames = indexes.map((index) => index.name);
      expect(indexNames).toContain('idx_network_trace_id');
      expect(indexNames).toContain('idx_network_session_trace_ts');
      expect(indexNames).toContain('idx_network_tab_id');
    });

    it('should include paused session index after all migrations', () => {
      initializeDatabase(db);
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions'").all() as { name: string }[];
      const indexNames = indexes.map((index) => index.name);
      expect(indexNames).toContain('idx_sessions_paused_at');
    });

    it('should backfill automation tables from existing lifecycle events during migration', () => {
      db.exec(`
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          safe_mode INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE events (
          event_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          ts INTEGER NOT NULL,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          tab_id INTEGER,
          origin TEXT,
          FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
        );

        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          applied_at INTEGER NOT NULL
        );
      `);

      db.prepare(`INSERT INTO sessions (session_id, created_at, safe_mode) VALUES (?, ?, ?)`)
        .run('sess-legacy', 1000, 0);
      db.prepare(`INSERT INTO events (event_id, session_id, ts, type, payload_json, tab_id) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(
          'evt-1',
          'sess-legacy',
          2000,
          'ui',
          JSON.stringify({
            eventType: 'automation_requested',
            action: 'click',
            traceId: 'trace-legacy',
            selector: '#submit',
            status: 'requested',
            startedAt: 2000,
            target: { matched: true, selector: '#submit', tabId: 7 },
          }),
          7,
        );
      db.prepare(`INSERT INTO events (event_id, session_id, ts, type, payload_json, tab_id) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(
          'evt-2',
          'sess-legacy',
          2050,
          'ui',
          JSON.stringify({
            eventType: 'automation_succeeded',
            action: 'click',
            traceId: 'trace-legacy',
            selector: '#submit',
            status: 'succeeded',
            startedAt: 2000,
            finishedAt: 2050,
            durationMs: 50,
            redaction: { inputValueRedacted: false, sensitiveTarget: false },
            target: { matched: true, selector: '#submit', tabId: 7 },
          }),
          7,
        );
      db.prepare(`INSERT INTO schema_version (version, applied_at) VALUES (?, ?)`)
        .run(6, 999);

      runMigrations(db);

      const run = db.prepare(`SELECT * FROM automation_runs WHERE session_id = ?`).get('sess-legacy') as {
        run_id: string;
        trace_id: string;
        status: string;
        completed_at: number;
      };
      const step = db.prepare(`SELECT * FROM automation_steps WHERE run_id = ?`).get(run.run_id) as {
        status: string;
        duration_ms: number;
        event_type: string;
      };

      expect(run.trace_id).toBe('trace-legacy');
      expect(run.status).toBe('succeeded');
      expect(run.completed_at).toBe(2050);
      expect(step.status).toBe('succeeded');
      expect(step.duration_ms).toBe(50);
      expect(step.event_type).toBe('automation_succeeded');
    });
  });

  describe('resetDatabase', () => {
    it('should clear and reinitialize database', () => {
      initializeDatabase(db);
      
      db.prepare(`
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('test-1', 123456789, 0)
      `).run();
      
      resetDatabase(db);
      
      const count = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
      expect(count.count).toBe(0);
      
      const version = getSchemaVersion(db);
      expect(version).toBe(SCHEMA_VERSION);
    });
  });
});

describe('Database Integration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
  });

  describe('Foreign Key Constraints', () => {
    it('should enforce foreign key on events.session_id', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO events (event_id, session_id, ts, type, payload_json)
          VALUES ('evt-1', 'non-existent', 123456789, 'console', '{}')
        `).run();
      }).toThrow();
    });

    it('should cascade delete events when session is deleted', () => {
      db.prepare(`
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('sess-1', 123456789, 0)
      `).run();
      
      db.prepare(`
        INSERT INTO events (event_id, session_id, ts, type, payload_json)
        VALUES ('evt-1', 'sess-1', 123456789, 'console', '{}')
      `).run();
      
      db.prepare("DELETE FROM sessions WHERE session_id = 'sess-1'").run();
      
      const count = db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number };
      expect(count.count).toBe(0);
    });

    it('should enforce foreign key on network.session_id', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO network (request_id, session_id, ts_start, method, url)
          VALUES ('req-1', 'non-existent', 123456789, 'GET', 'https://example.com')
        `).run();
      }).toThrow();
    });

    it('should enforce foreign key on error_fingerprints.session_id', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO error_fingerprints (fingerprint, session_id, count, sample_message, first_seen_at, last_seen_at)
          VALUES ('fp-1', 'non-existent', 1, 'error', 123456789, 123456789)
        `).run();
      }).toThrow();
    });

    it('should enforce foreign key on snapshots.session_id', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO snapshots (snapshot_id, session_id, ts, trigger, mode, created_at)
          VALUES ('snap-1', 'non-existent', 123456789, 'manual', 'dom', 123456789)
        `).run();
      }).toThrow();
    });

    it('should enforce foreign key on automation_runs.session_id', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO automation_runs (run_id, session_id, status, started_at, created_at, updated_at)
          VALUES ('run-1', 'non-existent', 'requested', 123456789, 123456789, 123456789)
        `).run();
      }).toThrow();
    });

    it('should enforce foreign key on automation_steps.run_id', () => {
      db.prepare(`
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('sess-1', 123456789, 0)
      `).run();

      expect(() => {
        db.prepare(`
          INSERT INTO automation_steps (
            step_id, run_id, session_id, step_order, action, status, event_type, created_at, updated_at
          ) VALUES ('step-1', 'missing-run', 'sess-1', 1, 'click', 'requested', 'automation_requested', 123456789, 123456789)
        `).run();
      }).toThrow();
    });
  });

  describe('Data Insertion', () => {
    it('should insert and retrieve session data', () => {
      const insert = db.prepare(`
        INSERT INTO sessions (session_id, created_at, ended_at, tab_id, window_id, 
          url_start, url_last, user_agent, viewport_w, viewport_h, dpr, safe_mode, allowlist_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      insert.run('sess-1', 123456789, null, 1, 1, 'https://start.com', 'https://last.com',
        'Mozilla/5.0', 1920, 1080, 2.0, 1, 'hash123');
      
      const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get('sess-1') as { session_id: string; safe_mode: number };
      expect(session).toBeDefined();
      expect(session.session_id).toBe('sess-1');
      expect(session.safe_mode).toBe(1);
    });

    it('should insert and retrieve event data', () => {
      db.prepare(`
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('sess-1', 123456789, 0)
      `).run();
      
      const insert = db.prepare(`
        INSERT INTO events (event_id, session_id, ts, type, payload_json)
        VALUES (?, ?, ?, ?, ?)
      `);
      
      insert.run('evt-1', 'sess-1', 123456789, 'console', '{"level": "error", "message": "test"}');
      
      const event = db.prepare('SELECT * FROM events WHERE event_id = ?').get('evt-1') as { type: string };
      expect(event).toBeDefined();
      expect(event.type).toBe('console');
    });

    it('should reject invalid event types', () => {
      db.prepare(`
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('sess-1', 123456789, 0)
      `).run();
      
      expect(() => {
        db.prepare(`
          INSERT INTO events (event_id, session_id, ts, type, payload_json)
          VALUES ('evt-1', 'sess-1', 123456789, 'invalid_type', '{}')
        `).run();
      }).toThrow();
    });

    it('should insert and retrieve network data', () => {
      db.prepare(`
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('sess-1', 123456789, 0)
      `).run();
      
      const insert = db.prepare(`
        INSERT INTO network (request_id, session_id, ts_start, duration_ms, method, url, status, initiator, error_class, response_size_est)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      insert.run('req-1', 'sess-1', 123456789, 100, 'GET', 'https://api.example.com/data', 200, 'fetch', null, 1024);
      
      const request = db.prepare('SELECT * FROM network WHERE request_id = ?').get('req-1') as { method: string; status: number };
      expect(request).toBeDefined();
      expect(request.method).toBe('GET');
      expect(request.status).toBe(200);
    });

    it('should reject invalid network initiator values', () => {
      db.prepare(`
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('sess-1', 123456789, 0)
      `).run();
      
      expect(() => {
        db.prepare(`
          INSERT INTO network (request_id, session_id, ts_start, method, url, initiator)
          VALUES ('req-1', 'sess-1', 123456789, 'GET', 'https://example.com', 'invalid')
        `).run();
      }).toThrow();
    });

    it('should insert and retrieve error fingerprint data', () => {
      db.prepare(`
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('sess-1', 123456789, 0)
      `).run();
      
      const insert = db.prepare(`
        INSERT INTO error_fingerprints (fingerprint, session_id, count, sample_message, sample_stack, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      
      insert.run('fp-abc123', 'sess-1', 5, 'TypeError: undefined is not a function', 'at line 10', 123456789, 123456799);
      
      const fp = db.prepare('SELECT * FROM error_fingerprints WHERE fingerprint = ?').get('fp-abc123') as { count: number };
      expect(fp).toBeDefined();
      expect(fp.count).toBe(5);
    });
  });
});
