import { mkdirSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import type { Database } from 'better-sqlite3';

export interface RetentionSettings {
  retentionDays: number;
  maxDbMb: number;
  maxSessions: number;
  cleanupIntervalMinutes: number;
  lastCleanupAt: number | null;
  exportPathOverride: string | null;
}

export interface CleanupResult {
  trigger: 'startup' | 'scheduled' | 'manual';
  deletedSessions: number;
  deletedByAge: number;
  deletedByMaxSessions: number;
  deletedByDbSize: number;
  pinnedProtected: boolean;
  dbSizeBeforeMb: number;
  dbSizeAfterMb: number;
  warning: string | null;
  ranAt: number;
}

const DEFAULT_SETTINGS: RetentionSettings = {
  retentionDays: 30,
  maxDbMb: 1024,
  maxSessions: 10000,
  cleanupIntervalMinutes: 60,
  lastCleanupAt: null,
  exportPathOverride: null,
};

export function getRetentionSettings(db: Database): RetentionSettings {
  let row:
    | {
        retention_days: number;
        max_db_mb: number;
        max_sessions: number;
        cleanup_interval_minutes: number;
        last_cleanup_at: number | null;
        export_path_override: string | null;
      }
    | undefined;

  try {
    row = db
      .prepare(
        `SELECT retention_days, max_db_mb, max_sessions, cleanup_interval_minutes, last_cleanup_at, export_path_override
         FROM server_settings
         WHERE id = 1`,
      )
      .get() as
      | {
          retention_days: number;
          max_db_mb: number;
          max_sessions: number;
          cleanup_interval_minutes: number;
          last_cleanup_at: number | null;
          export_path_override: string | null;
        }
      | undefined;
  } catch {
    return DEFAULT_SETTINGS;
  }

  if (!row) {
    return DEFAULT_SETTINGS;
  }

  return {
    retentionDays: row.retention_days,
    maxDbMb: row.max_db_mb,
    maxSessions: row.max_sessions,
    cleanupIntervalMinutes: row.cleanup_interval_minutes,
    lastCleanupAt: row.last_cleanup_at,
    exportPathOverride: row.export_path_override,
  };
}

export function updateRetentionSettings(db: Database, input: Partial<RetentionSettings>): RetentionSettings {
  const current = getRetentionSettings(db);
  const next: RetentionSettings = {
    ...current,
    retentionDays: normalizePositiveInt(input.retentionDays, current.retentionDays, 1, 3650),
    maxDbMb: normalizePositiveInt(input.maxDbMb, current.maxDbMb, 50, 102400),
    maxSessions: normalizePositiveInt(input.maxSessions, current.maxSessions, 100, 1000000),
    cleanupIntervalMinutes: normalizePositiveInt(input.cleanupIntervalMinutes, current.cleanupIntervalMinutes, 5, 1440),
    exportPathOverride: normalizeExportPath(input.exportPathOverride, current.exportPathOverride),
  };

  db.prepare(
    `UPDATE server_settings
     SET retention_days = ?, max_db_mb = ?, max_sessions = ?, cleanup_interval_minutes = ?, export_path_override = ?
     WHERE id = 1`,
  ).run(next.retentionDays, next.maxDbMb, next.maxSessions, next.cleanupIntervalMinutes, next.exportPathOverride);

  return getRetentionSettings(db);
}

export function shouldRunCleanup(settings: RetentionSettings, now = Date.now()): boolean {
  if (settings.lastCleanupAt === null) {
    return true;
  }
  return now - settings.lastCleanupAt >= settings.cleanupIntervalMinutes * 60_000;
}

export function runRetentionCleanup(
  db: Database,
  dbPath: string,
  settings: RetentionSettings,
  trigger: CleanupResult['trigger'],
): CleanupResult {
  const beforeMb = getDbSizeMb(dbPath);
  let deletedByAge = 0;
  let deletedByMaxSessions = 0;
  let deletedByDbSize = 0;
  let warning: string | null = null;

  const ageThreshold = Date.now() - settings.retentionDays * 24 * 60 * 60 * 1000;
  while (true) {
    const sessionId = getOldestUnpinnedSession(db, 'created_at < ?', [ageThreshold]);
    if (!sessionId) {
      break;
    }
    deleteSession(db, sessionId);
    deletedByAge += 1;
  }

  while (getSessionCount(db) > settings.maxSessions) {
    const sessionId = getOldestUnpinnedSession(db);
    if (!sessionId) {
      warning = 'Cleanup skipped some records because only pinned sessions remain.';
      break;
    }
    deleteSession(db, sessionId);
    deletedByMaxSessions += 1;
  }

  let capSafety = 0;
  while (getDbSizeMb(dbPath) > settings.maxDbMb) {
    const sessionId = getOldestUnpinnedSession(db);
    if (!sessionId) {
      warning = 'Cleanup skipped some records because only pinned sessions remain.';
      break;
    }
    deleteSession(db, sessionId);
    deletedByDbSize += 1;
    capSafety += 1;
    if (capSafety > 5000) {
      warning = 'Cleanup reached safety stop while enforcing max DB size.';
      break;
    }
  }

  if (deletedByDbSize > 0) {
    db.exec('VACUUM');
  }

  const ranAt = Date.now();
  db.prepare('UPDATE server_settings SET last_cleanup_at = ? WHERE id = 1').run(ranAt);

  const afterMb = getDbSizeMb(dbPath);
  return {
    trigger,
    deletedSessions: deletedByAge + deletedByMaxSessions + deletedByDbSize,
    deletedByAge,
    deletedByMaxSessions,
    deletedByDbSize,
    pinnedProtected: warning !== null,
    dbSizeBeforeMb: beforeMb,
    dbSizeAfterMb: afterMb,
    warning,
    ranAt,
  };
}

export function setSessionPinned(db: Database, sessionId: string, pinned: boolean): boolean {
  const result = db.prepare('UPDATE sessions SET pinned = ? WHERE session_id = ?').run(pinned ? 1 : 0, sessionId);
  return result.changes > 0;
}

export function exportSessionToJson(
  db: Database,
  sessionId: string,
  projectRoot: string,
  exportPathOverride: string | null,
): { filePath: string; events: number; network: number; fingerprints: number } {
  const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as Record<string, unknown> | undefined;
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const events = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY ts ASC').all(sessionId) as Record<string, unknown>[];
  const network = db.prepare('SELECT * FROM network WHERE session_id = ? ORDER BY ts_start ASC').all(sessionId) as Record<string, unknown>[];
  const fingerprints = db
    .prepare('SELECT * FROM error_fingerprints WHERE session_id = ? ORDER BY count DESC, last_seen_at DESC')
    .all(sessionId) as Record<string, unknown>[];

  const baseDir = exportPathOverride && exportPathOverride.trim().length > 0
    ? resolve(exportPathOverride)
    : resolve(join(projectRoot, 'exports'));
  mkdirSync(baseDir, { recursive: true });

  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9-_]/g, '_');
  const filePath = join(baseDir, `${safeSessionId}.json`);

  writeFileSync(
    filePath,
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        session,
        events,
        network,
        fingerprints,
      },
      null,
      2,
    ),
    'utf-8',
  );

  return {
    filePath,
    events: events.length,
    network: network.length,
    fingerprints: fingerprints.length,
  };
}

function normalizePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const num = Math.floor(value);
  if (num < min) {
    return min;
  }
  if (num > max) {
    return max;
  }
  return num;
}

function normalizeExportPath(value: unknown, fallback: string | null): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getDbSizeMb(dbPath: string): number {
  try {
    const bytes = statSync(dbPath).size;
    return Number((bytes / (1024 * 1024)).toFixed(2));
  } catch {
    return 0;
  }
}

function getSessionCount(db: Database): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count;
}

function getOldestUnpinnedSession(db: Database, clause?: string, params: unknown[] = []): string | null {
  const whereClause = clause ? `AND ${clause}` : '';
  const row = db
    .prepare(`SELECT session_id FROM sessions WHERE pinned = 0 ${whereClause} ORDER BY created_at ASC LIMIT 1`)
    .get(...params) as { session_id: string } | undefined;
  return row?.session_id ?? null;
}

function deleteSession(db: Database, sessionId: string): void {
  db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
}
