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

export interface SessionImportResult {
  sessionId: string;
  requestedSessionId: string;
  remappedSessionId: boolean;
  events: number;
  network: number;
  fingerprints: number;
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

export function importSessionFromJson(db: Database, payload: unknown): SessionImportResult {
  const parsed = normalizeImportPayload(payload);
  const requestedSessionId = parsed.requestedSessionId;
  const sessionId = resolveImportedSessionId(db, requestedSessionId);
  const remappedSessionId = sessionId !== requestedSessionId;
  const importedAt = Date.now();

  const insertSession = db.prepare(
    `INSERT INTO sessions (
      session_id, created_at, ended_at, tab_id, window_id, url_start, url_last,
      user_agent, viewport_w, viewport_h, dpr, safe_mode, allowlist_hash, pinned
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const insertEvent = db.prepare(
    `INSERT INTO events (event_id, session_id, ts, type, payload_json)
     VALUES (?, ?, ?, ?, ?)`
  );

  const insertNetwork = db.prepare(
    `INSERT INTO network (
      request_id, session_id, ts_start, duration_ms, method, url, status, initiator, error_class, response_size_est
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const insertFingerprint = db.prepare(
    `INSERT INTO error_fingerprints (
      fingerprint, session_id, count, sample_message, sample_stack, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const runImport = db.transaction(() => {
    insertSession.run(
      sessionId,
      parsed.session.createdAt,
      parsed.session.endedAt,
      parsed.session.tabId,
      parsed.session.windowId,
      parsed.session.urlStart,
      parsed.session.urlLast,
      parsed.session.userAgent,
      parsed.session.viewportW,
      parsed.session.viewportH,
      parsed.session.dpr,
      parsed.session.safeMode,
      parsed.session.allowlistHash,
      parsed.session.pinned,
    );

    for (let i = 0; i < parsed.events.length; i += 1) {
      const row = parsed.events[i];
      const eventId = `${sessionId}-import-event-${importedAt}-${i}`;
      insertEvent.run(eventId, sessionId, row.ts, row.type, row.payloadJson);
    }

    for (let i = 0; i < parsed.network.length; i += 1) {
      const row = parsed.network[i];
      const requestId = `${sessionId}-import-network-${importedAt}-${i}`;
      insertNetwork.run(
        requestId,
        sessionId,
        row.tsStart,
        row.durationMs,
        row.method,
        row.url,
        row.status,
        row.initiator,
        row.errorClass,
        row.responseSizeEst,
      );
    }

    for (let i = 0; i < parsed.fingerprints.length; i += 1) {
      const row = parsed.fingerprints[i];
      const fingerprint = `${sessionId}::${row.fingerprint}`;
      insertFingerprint.run(
        fingerprint,
        sessionId,
        row.count,
        row.sampleMessage,
        row.sampleStack,
        row.firstSeenAt,
        row.lastSeenAt,
      );
    }
  });

  runImport();

  return {
    sessionId,
    requestedSessionId,
    remappedSessionId,
    events: parsed.events.length,
    network: parsed.network.length,
    fingerprints: parsed.fingerprints.length,
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

function normalizeImportPayload(payload: unknown): {
  requestedSessionId: string;
  session: {
    createdAt: number;
    endedAt: number | null;
    tabId: number | null;
    windowId: number | null;
    urlStart: string | null;
    urlLast: string | null;
    userAgent: string | null;
    viewportW: number | null;
    viewportH: number | null;
    dpr: number | null;
    safeMode: 0 | 1;
    allowlistHash: string | null;
    pinned: 0 | 1;
  };
  events: Array<{ ts: number; type: string; payloadJson: string }>;
  network: Array<{
    tsStart: number;
    durationMs: number | null;
    method: string;
    url: string;
    status: number | null;
    initiator: string | null;
    errorClass: string | null;
    responseSizeEst: number | null;
  }>;
  fingerprints: Array<{
    fingerprint: string;
    count: number;
    sampleMessage: string;
    sampleStack: string | null;
    firstSeenAt: number;
    lastSeenAt: number;
  }>;
} {
  const root = asObject(payload, 'Import payload must be an object');
  const sessionRoot = asObject(root.session, 'Import payload must include a session object');
  const requestedSessionId = asNonEmptyString(
    sessionRoot.session_id ?? sessionRoot.sessionId,
    'Import payload missing session_id'
  );

  const createdAt = asTimestamp(sessionRoot.created_at ?? sessionRoot.createdAt, Date.now());
  const endedAt = asNullableTimestamp(sessionRoot.ended_at ?? sessionRoot.endedAt);

  const rawEvents = asArray(root.events, 'Import payload events must be an array');
  const rawNetwork = asArray(root.network, 'Import payload network must be an array');
  const rawFingerprints = asArray(root.fingerprints, 'Import payload fingerprints must be an array');

  if (rawEvents.length > 100_000 || rawNetwork.length > 100_000 || rawFingerprints.length > 100_000) {
    throw new Error('Import payload exceeds record limit (100000 per section)');
  }

  const allowedEventTypes = new Set(['console', 'error', 'network', 'nav', 'ui', 'element_ref']);
  const allowedInitiators = new Set(['fetch', 'xhr', 'img', 'script', 'other']);
  const allowedErrorClasses = new Set(['timeout', 'cors', 'dns', 'blocked', 'http_error', 'unknown']);

  const events = rawEvents.map((entry, index) => {
    const event = asObject(entry, `Event at index ${index} must be an object`);
    const ts = asTimestamp(event.ts ?? event.timestamp, createdAt);
    const rawType = asString(event.type, 'ui');
    const type = allowedEventTypes.has(rawType) ? rawType : 'ui';
    const payloadJson = toJsonString(event.payload_json ?? event.payload ?? {});
    return { ts, type, payloadJson };
  });

  const network = rawNetwork.map((entry, index) => {
    const row = asObject(entry, `Network row at index ${index} must be an object`);
    const tsStart = asTimestamp(row.ts_start ?? row.tsStart ?? row.timestamp, createdAt);
    const method = asString(row.method, 'GET') || 'GET';
    const url = asString(row.url, '');
    const initiatorCandidate = asNullableString(row.initiator);
    const errorClassCandidate = asNullableString(row.error_class ?? row.errorClass);

    return {
      tsStart,
      durationMs: asNullableInteger(row.duration_ms ?? row.durationMs),
      method,
      url,
      status: asNullableInteger(row.status),
      initiator: initiatorCandidate && allowedInitiators.has(initiatorCandidate) ? initiatorCandidate : null,
      errorClass: errorClassCandidate && allowedErrorClasses.has(errorClassCandidate) ? errorClassCandidate : null,
      responseSizeEst: asNullableInteger(row.response_size_est ?? row.responseSizeEst),
    };
  });

  const fingerprints = rawFingerprints.map((entry, index) => {
    const row = asObject(entry, `Fingerprint row at index ${index} must be an object`);
    const rawFingerprint = asString(row.fingerprint, `imported-${index}`) || `imported-${index}`;
    return {
      fingerprint: rawFingerprint,
      count: Math.max(1, asInteger(row.count, 1)),
      sampleMessage: asString(row.sample_message ?? row.sampleMessage, 'Imported error fingerprint') || 'Imported error fingerprint',
      sampleStack: asNullableString(row.sample_stack ?? row.sampleStack),
      firstSeenAt: asTimestamp(row.first_seen_at ?? row.firstSeenAt, createdAt),
      lastSeenAt: asTimestamp(row.last_seen_at ?? row.lastSeenAt, createdAt),
    };
  });

  return {
    requestedSessionId,
    session: {
      createdAt,
      endedAt,
      tabId: asNullableInteger(sessionRoot.tab_id ?? sessionRoot.tabId),
      windowId: asNullableInteger(sessionRoot.window_id ?? sessionRoot.windowId),
      urlStart: asNullableString(sessionRoot.url_start ?? sessionRoot.urlStart),
      urlLast: asNullableString(sessionRoot.url_last ?? sessionRoot.urlLast),
      userAgent: asNullableString(sessionRoot.user_agent ?? sessionRoot.userAgent),
      viewportW: asNullableInteger(sessionRoot.viewport_w ?? sessionRoot.viewportW),
      viewportH: asNullableInteger(sessionRoot.viewport_h ?? sessionRoot.viewportH),
      dpr: asNullableNumber(sessionRoot.dpr),
      safeMode: asBooleanInt(sessionRoot.safe_mode ?? sessionRoot.safeMode),
      allowlistHash: asNullableString(sessionRoot.allowlist_hash ?? sessionRoot.allowlistHash),
      pinned: asBooleanInt(sessionRoot.pinned),
    },
    events,
    network,
    fingerprints,
  };
}

function resolveImportedSessionId(db: Database, requestedSessionId: string): string {
  const existing = db.prepare('SELECT 1 FROM sessions WHERE session_id = ?').get(requestedSessionId);
  if (!existing) {
    return requestedSessionId;
  }

  const safeId = requestedSessionId.replace(/[^a-zA-Z0-9-_]/g, '_');
  return `${safeId}-import-${Date.now()}`;
}

function asObject(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(error);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, error: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(error);
  }
  return value;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asNonEmptyString(value: unknown, error: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(error);
  }
  return value;
}

function asInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.floor(value);
}

function asNullableInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.floor(value);
}

function asNullableNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function asNullableString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  return value;
}

function asTimestamp(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.floor(value);
}

function asNullableTimestamp(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.floor(value);
}

function asBooleanInt(value: unknown): 0 | 1 {
  if (value === 1 || value === true) {
    return 1;
  }
  return 0;
}

function toJsonString(value: unknown): string {
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify({ value });
    }
  }

  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
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
