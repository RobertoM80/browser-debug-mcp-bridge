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
import { listObservedOverrideAssets, persistObservedOverrideAssets } from '../override-observed-assets';

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

    it('should create override audit tables', () => {
      initializeSchema(db);
      const runs = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='override_runs'").get();
      const requests = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='override_requests'").get();
      const plans = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='override_plan_audits'").get();
      expect(runs).toBeDefined();
      expect(requests).toBeDefined();
      expect(plans).toBeDefined();
    });

    it('should create network blocking audit tables', () => {
      initializeSchema(db);
      const runs = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='network_blocking_runs'").get();
      const requests = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='network_blocking_requests'").get();
      expect(runs).toBeDefined();
      expect(requests).toBeDefined();
    });

    it('should create observed override asset table', () => {
      initializeSchema(db);
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='override_observed_assets'").get();
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='override_observed_assets'").all() as { name: string }[];
      const columns = db.prepare("PRAGMA table_info('override_observed_assets')").all() as { name: string }[];
      expect(table).toBeDefined();
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'rule_type',
        'request_method',
        'resource_type',
        'content_type',
        'status_code',
        'from_navigation',
        'from_fetch',
      ]));
      expect(indexes.map((index) => index.name)).toContain('idx_override_observed_assets_session_method_url');
      expect(indexes.map((index) => index.name)).toContain('idx_override_observed_assets_session_seen');
      expect(indexes.map((index) => index.name)).toContain('idx_override_observed_assets_rule_type');
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

    it('should create indexes on override audit tables', () => {
      initializeSchema(db);
      const runIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='override_runs'").all() as { name: string }[];
      const requestIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='override_requests'").all() as { name: string }[];
      const planIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='override_plan_audits'").all() as { name: string }[];

      expect(runIndexes.map((index) => index.name)).toContain('idx_override_runs_session_started_at');
      expect(runIndexes.map((index) => index.name)).toContain('idx_override_runs_session_status_started_at');
      expect(requestIndexes.map((index) => index.name)).toContain('idx_override_requests_session_ts');
      expect(requestIndexes.map((index) => index.name)).toContain('idx_override_requests_run_ts');
      expect(requestIndexes.map((index) => index.name)).toContain('idx_override_requests_status_ts');
      expect(planIndexes.map((index) => index.name)).toContain('idx_override_plan_audits_session_created_at');
      expect(planIndexes.map((index) => index.name)).toContain('idx_override_plan_audits_target_url');
      expect(planIndexes.map((index) => index.name)).toContain('idx_override_plan_audits_planner_kind');
    });

    it('should create indexes on network blocking audit tables', () => {
      initializeSchema(db);
      const runIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='network_blocking_runs'").all() as { name: string }[];
      const requestIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='network_blocking_requests'").all() as { name: string }[];

      expect(runIndexes.map((index) => index.name)).toContain('idx_network_blocking_runs_session_started_at');
      expect(runIndexes.map((index) => index.name)).toContain('idx_network_blocking_runs_session_status_started_at');
      expect(requestIndexes.map((index) => index.name)).toContain('idx_network_blocking_requests_session_ts');
      expect(requestIndexes.map((index) => index.name)).toContain('idx_network_blocking_requests_run_ts');
      expect(requestIndexes.map((index) => index.name)).toContain('idx_network_blocking_requests_rule_ts');
    });

    it('should create indexes on automation tables', () => {
      initializeSchema(db);
      const runColumns = db.prepare("PRAGMA table_info('automation_runs')").all() as { name: string }[];
      const stepColumns = db.prepare("PRAGMA table_info('automation_steps')").all() as { name: string }[];
      const runIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='automation_runs'").all() as { name: string }[];
      const stepIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='automation_steps'").all() as { name: string }[];

      expect(runColumns.map((column) => column.name)).toContain('diagnostics_json');
      expect(stepColumns.map((column) => column.name)).toContain('diagnostics_json');
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
      expect(tableNames).toContain('override_runs');
      expect(tableNames).toContain('override_requests');
      expect(tableNames).toContain('override_plan_audits');
      expect(tableNames).toContain('override_observed_assets');
      expect(tableNames).toContain('network_blocking_runs');
      expect(tableNames).toContain('network_blocking_requests');
      expect(tableNames).toContain('mcp_tool_invocations');
      expect(tableNames).toContain('mcp_loop_incidents');
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
      expect(indexNames).toContain('idx_sessions_last_seen_at');
    });

    it('should include MCP loop guard tables and indexes after all migrations', () => {
      initializeDatabase(db);
      const invocationIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='mcp_tool_invocations'").all() as { name: string }[];
      const incidentIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='mcp_loop_incidents'").all() as { name: string }[];
      expect(invocationIndexes.map((index) => index.name)).toContain('idx_mcp_tool_invocations_tool_input_time');
      expect(invocationIndexes.map((index) => index.name)).toContain('idx_mcp_tool_invocations_family_root_time');
      expect(incidentIndexes.map((index) => index.name)).toContain('idx_mcp_loop_incidents_open_fingerprint');
      expect(incidentIndexes.map((index) => index.name)).toContain('idx_mcp_loop_incidents_session_family');
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
        diagnostics_json: string | null;
      };

      expect(run.trace_id).toBe('trace-legacy');
      expect(run.status).toBe('succeeded');
      expect(run.completed_at).toBe(2050);
      expect(step.status).toBe('succeeded');
      expect(step.duration_ms).toBe(50);
      expect(step.event_type).toBe('automation_succeeded');
      expect(step.diagnostics_json).toBeNull();
    });

    it('should add automation diagnostics columns to migrated databases', () => {
      initializeSchema(db);
      db.exec(`
        DELETE FROM schema_version;
        INSERT INTO schema_version (version, applied_at) VALUES (15, 999);
        CREATE TABLE automation_runs_v15 AS SELECT * FROM automation_runs;
        CREATE TABLE automation_steps_v15 AS SELECT * FROM automation_steps;
        DROP TABLE automation_steps;
        DROP TABLE automation_runs;
        ALTER TABLE automation_runs_v15 RENAME TO automation_runs;
        ALTER TABLE automation_steps_v15 RENAME TO automation_steps;
      `);

      const dropColumn = (tableName: string, columnName: string): void => {
        const columns = db.prepare(`PRAGMA table_info('${tableName}')`).all() as Array<{
          name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
        }>;
        const kept = columns.filter((column) => column.name !== columnName);
        db.exec(`ALTER TABLE ${tableName} RENAME TO ${tableName}_old;`);
        db.exec(`
          CREATE TABLE ${tableName} (
            ${kept.map((column) => `${column.name} ${column.type}${column.notnull ? ' NOT NULL' : ''}${column.dflt_value ? ` DEFAULT ${column.dflt_value}` : ''}`).join(', ')}
          );
          INSERT INTO ${tableName} (${kept.map((column) => column.name).join(', ')})
          SELECT ${kept.map((column) => column.name).join(', ')} FROM ${tableName}_old;
          DROP TABLE ${tableName}_old;
        `);
      };
      dropColumn('automation_runs', 'diagnostics_json');
      dropColumn('automation_steps', 'diagnostics_json');

      runMigrations(db);

      expect((db.prepare("PRAGMA table_info('automation_runs')").all() as { name: string }[])
        .map((column) => column.name)).toContain('diagnostics_json');
      expect((db.prepare("PRAGMA table_info('automation_steps')").all() as { name: string }[])
        .map((column) => column.name)).toContain('diagnostics_json');
      expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
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

    it('should enforce foreign key on override_runs.session_id', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO override_runs (
            run_id, session_id, started_at, run_status, tab_id, target_asset_url, local_file_path,
            resolved_local_file_path, content_type, auto_reload, config_path, file_exists, matched_requests,
            fulfilled_requests, created_at, updated_at
          )
          VALUES (
            'run-1', 'non-existent', 123456789, 'active', 1, 'https://example.com/app.js', './app.js',
            'C:/repo/app.js', 'application/javascript', 1, 'C:/repo/override-poc.local.json', 1, 0,
            0, 123456789, 123456789
          )
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
        INSERT INTO sessions (session_id, created_at, last_seen_at, ended_at, tab_id, window_id,
          url_start, url_last, user_agent, viewport_w, viewport_h, dpr, safe_mode, allowlist_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insert.run('sess-1', 123456789, 123456799, null, 1, 1, 'https://start.com', 'https://last.com',
        'Mozilla/5.0', 1920, 1080, 2.0, 1, 'hash123');
      
      const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get('sess-1') as {
        session_id: string;
        safe_mode: number;
        last_seen_at: number;
      };
      expect(session).toBeDefined();
      expect(session.session_id).toBe('sess-1');
      expect(session.safe_mode).toBe(1);
      expect(session.last_seen_at).toBe(123456799);
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

    it('should insert and retrieve override audit data', () => {
      db.prepare(`
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('sess-1', 123456789, 0)
      `).run();

      db.prepare(`
        INSERT INTO override_runs (
          run_id, session_id, started_at, run_status, tab_id, selected_tab_id, target_asset_url, local_file_path,
          resolved_local_file_path, content_type, auto_reload, config_path, file_exists, file_size_bytes,
          matched_requests, fulfilled_requests, created_at, updated_at
        )
        VALUES (
          'run-1', 'sess-1', 123456789, 'active', 7, 7, 'https://example.com/app.js', './app.js',
          'C:/repo/app.js', 'application/javascript', 1, 'C:/repo/override-poc.local.json', 1, 42,
          1, 1, 123456789, 123456790
        )
      `).run();

      db.prepare(`
        INSERT INTO override_requests (
          request_log_id, run_id, session_id, request_id, ts, request_url, request_status, response_code, created_at, updated_at
        )
        VALUES (
          'req-log-1', 'run-1', 'sess-1', 'request-1', 123456790, 'https://example.com/app.js', 'fulfilled', 200, 123456790, 123456791
        )
      `).run();

      const run = db.prepare('SELECT * FROM override_runs WHERE run_id = ?').get('run-1') as { matched_requests: number };
      const request = db.prepare('SELECT * FROM override_requests WHERE request_log_id = ?').get('req-log-1') as { request_status: string };

      expect(run).toBeDefined();
      expect(run.matched_requests).toBe(1);
      expect(request).toBeDefined();
      expect(request.request_status).toBe('fulfilled');
    });

    it('should insert and retrieve override plan audit metadata', () => {
      db.prepare(`
        INSERT INTO sessions (session_id, created_at, safe_mode)
        VALUES ('sess-1', 123456789, 0)
      `).run();

      db.prepare(`
        INSERT INTO override_plan_audits (
          plan_id, session_id, created_at, planner_kind, tool_name, profile_id, rule_id, rule_type,
          request_method, match_mode, target_asset_url, local_file_path, config_path, content_type,
          original_sha256, patched_sha256, original_bytes, patched_bytes, patch_summary_json,
          preview_json, warnings_json, blockers_json, captured_from_live_session_json, rollback_json, updated_at
        )
        VALUES (
          'plan-1', 'sess-1', 123456789, 'response-patch', 'plan_override_response_patch',
          'profile-1', 'rule-1', 'api-response', 'GET', 'exact', 'https://example.com/api',
          'C:/tmp/override.json', 'C:/tmp/override.config.json', 'application/json',
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          20, 22, '{"jsonPatches":[{"path":"/mode"}]}', '{"before":"a","after":"b"}',
          '["warning"]', '[]', '{"source":"cdp-response"}', '{"disableTool":"disable_overrides"}',
          123456790
        )
      `).run();

      const plan = db.prepare('SELECT * FROM override_plan_audits WHERE plan_id = ?').get('plan-1') as {
        planner_kind: string;
        patch_summary_json: string;
        rollback_json: string;
      };

      expect(plan).toBeDefined();
      expect(plan.planner_kind).toBe('response-patch');
      expect(JSON.parse(plan.patch_summary_json)).toMatchObject({ jsonPatches: [{ path: '/mode' }] });
      expect(JSON.parse(plan.rollback_json)).toMatchObject({ disableTool: 'disable_overrides' });
    });
  });

  describe('observed override assets', () => {
    it('persists and deduplicates observed assets by session and URL', () => {
      initializeSchema(db);
      db.prepare(`
        INSERT INTO sessions (session_id, created_at, last_seen_at, safe_mode)
        VALUES ('session-assets', 123456789, 123456789, 0)
      `).run();

      persistObservedOverrideAssets(db, {
        sessionId: 'session-assets',
        tabId: 7,
        pageUrl: 'https://example.test/products',
        baseUrl: 'https://example.test',
        title: 'Products',
        serviceWorkerControlled: true,
        cspMetaTags: ['default-src self'],
        assets: [{
          url: 'https://example.test/_next/static/chunks/app.js',
          kind: 'script',
          resourceType: 'script',
          contentType: 'application/javascript',
          statusCode: 200,
          fromDom: true,
        }],
        observedAt: 1000,
      });
      persistObservedOverrideAssets(db, {
        sessionId: 'session-assets',
        tabId: 7,
        pageUrl: 'https://example.test/products',
        assets: [{
          url: 'https://example.test/_next/static/chunks/app.js',
          kind: 'script',
          fromPerformance: true,
        }],
        observedAt: 2000,
      });

      const assets = listObservedOverrideAssets(db, { sessionId: 'session-assets' });
      expect(assets).toHaveLength(1);
      expect(assets[0]).toMatchObject({
        sessionId: 'session-assets',
        tabId: 7,
        lastSeenAt: 2000,
        pageUrl: 'https://example.test/products',
        url: 'https://example.test/_next/static/chunks/app.js',
        ruleType: 'asset',
        requestMethod: 'GET',
        resourceType: 'script',
        contentType: 'application/javascript',
        statusCode: 200,
        assetPath: 'static/chunks/app.js',
        fromDom: true,
        fromPerformance: true,
        fromNavigation: false,
        fromFetch: false,
      });
    });

    it('persists document and RSC observations as distinct request types', () => {
      initializeSchema(db);
      db.prepare(`
        INSERT INTO sessions (session_id, created_at, last_seen_at, safe_mode)
        VALUES ('session-render-artifacts', 123456789, 123456789, 0)
      `).run();

      persistObservedOverrideAssets(db, {
        sessionId: 'session-render-artifacts',
        assets: [
          {
            url: 'https://example.test/products',
            kind: 'document',
            resourceType: 'document',
            contentType: 'text/html; charset=utf-8',
            statusCode: 200,
            fromNavigation: true,
          },
          {
            url: 'https://example.test/products?_rsc=abc',
            kind: 'fetch',
            initiatorType: 'fetch',
            contentType: 'text/x-component',
            fromPerformance: true,
            fromFetch: true,
          },
        ],
        observedAt: 3000,
      });

      const assets = listObservedOverrideAssets(db, { sessionId: 'session-render-artifacts' });
      expect(assets.map((asset) => asset.ruleType).sort()).toEqual(['document', 'rsc-flight']);
      expect(assets.find((asset) => asset.ruleType === 'document')).toMatchObject({
        requestMethod: 'GET',
        resourceType: 'document',
        contentType: 'text/html; charset=utf-8',
        statusCode: 200,
        fromNavigation: true,
      });
      expect(assets.find((asset) => asset.ruleType === 'rsc-flight')).toMatchObject({
        initiatorType: 'fetch',
        fromFetch: true,
      });
    });
  });
});
