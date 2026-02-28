import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import type { Database } from 'better-sqlite3';
import JSZip from 'jszip';

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
  snapshots: number;
}

export interface ExportSessionOptions {
  format?: 'json' | 'zip';
  compatibilityMode?: boolean;
  includePngBase64?: boolean;
}

export interface ExportSessionResult {
  filePath: string;
  format: 'json' | 'zip';
  compatibilityMode: boolean;
  events: number;
  network: number;
  fingerprints: number;
  snapshots: number;
}

type SnapshotExportRecord = {
  snapshotId: string;
  sessionId: string;
  triggerEventId: string | null;
  timestamp: number;
  trigger: string;
  selector: string | null;
  url: string | null;
  mode: string;
  styleMode: string | null;
  dom: unknown;
  styles: unknown;
  truncation: {
    dom: boolean;
    styles: boolean;
    png: boolean;
  };
  createdAt: number;
  png: {
    path: string | null;
    mime: string | null;
    bytes: number | null;
    base64?: string;
    assetPath?: string;
  };
};

type SessionExportPayload = {
  exportedAt: string;
  session: Record<string, unknown>;
  events: Record<string, unknown>[];
  network: Record<string, unknown>[];
  fingerprints: Record<string, unknown>[];
  snapshots: SnapshotExportRecord[];
};

export interface SnapshotWriteInput {
  timestamp?: number;
  trigger?: string;
  selector?: string | null;
  url?: string | null;
  mode?: unknown;
  truncation?: {
    dom?: unknown;
    styles?: unknown;
    png?: unknown;
  };
  snapshot?: {
    dom?: unknown;
    styles?: unknown;
  };
  png?: {
    captured?: unknown;
    format?: unknown;
    byteLength?: unknown;
    dataUrl?: unknown;
  };
}

export interface SnapshotListResult {
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
  snapshots: Array<{
    snapshotId: string;
    sessionId: string;
    timestamp: number;
    trigger: string;
    selector: string | null;
    url: string | null;
    mode: string;
    styleMode: string | null;
    dom: unknown;
    styles: unknown;
    pngPath: string | null;
    pngMime: string | null;
    pngBytes: number | null;
    truncation: {
      dom: boolean;
      styles: boolean;
      png: boolean;
    };
    createdAt: number;
  }>;
}

const DEFAULT_SETTINGS: RetentionSettings = {
  retentionDays: 30,
  maxDbMb: 1024,
  maxSessions: 10000,
  cleanupIntervalMinutes: 60,
  lastCleanupAt: null,
  exportPathOverride: null,
};

const MAX_SNAPSHOT_DOM_BYTES = 512 * 1024;
const MAX_SNAPSHOT_STYLES_BYTES = 512 * 1024;
const MAX_SNAPSHOT_PNG_BYTES = 5 * 1024 * 1024;
const SNAPSHOT_ASSET_DIR = 'snapshot-assets';

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

  pruneOrphanedSnapshotAssets(db, dbPath);

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

export function writeSnapshot(
  db: Database,
  dbPath: string,
  sessionId: string,
  input: SnapshotWriteInput,
  triggerEventId: string | null = null,
): { snapshotId: string } {
  const session = db.prepare('SELECT 1 FROM sessions WHERE session_id = ?').get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const timestamp = asTimestamp(input.timestamp, Date.now());
  const createdAt = Date.now();
  const snapshotId = `${sessionId}-snapshot-${timestamp}-${Math.random().toString(36).slice(2, 10)}`;

  const trigger = normalizeSnapshotTrigger(input.trigger);
  const selector = typeof input.selector === 'string' ? input.selector : null;
  const url = typeof input.url === 'string' ? input.url : null;

  const mode = normalizeSnapshotMode(input.mode);
  const styleMode = normalizeStyleMode(input.mode);

  const domJson = serializeBounded(input.snapshot?.dom, MAX_SNAPSHOT_DOM_BYTES, 'dom');
  const stylesJson = serializeBounded(input.snapshot?.styles, MAX_SNAPSHOT_STYLES_BYTES, 'styles');

  const domTruncated = Boolean(input.truncation?.dom);
  const stylesTruncated = Boolean(input.truncation?.styles);
  const pngTruncated = Boolean(input.truncation?.png);

  const pngWrite = maybePersistPng(dbPath, sessionId, snapshotId, input.png);

  db.prepare(
    `INSERT INTO snapshots (
      snapshot_id, session_id, trigger_event_id, ts, trigger, selector, url, mode, style_mode,
      dom_json, styles_json, png_path, png_mime, png_bytes,
      dom_truncated, styles_truncated, png_truncated, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    snapshotId,
    sessionId,
    triggerEventId,
    timestamp,
    trigger,
    selector,
    url,
    mode,
    styleMode,
    domJson,
    stylesJson,
    pngWrite.relativePath,
    pngWrite.mime,
    pngWrite.byteLength,
    domTruncated ? 1 : 0,
    stylesTruncated ? 1 : 0,
    pngTruncated ? 1 : 0,
    createdAt,
  );

  return { snapshotId };
}

export function listSnapshots(
  db: Database,
  sessionId: string,
  limitInput?: number,
  offsetInput?: number,
): SnapshotListResult {
  const limit = normalizePositiveInt(limitInput, 50, 1, 200);
  const offset = normalizePositiveInt(offsetInput, 0, 0, 1_000_000);

  type SnapshotRow = {
    snapshot_id: string;
    session_id: string;
    ts: number;
    trigger: string;
    selector: string | null;
    url: string | null;
    mode: string;
    style_mode: string | null;
    dom_json: string | null;
    styles_json: string | null;
    png_path: string | null;
    png_mime: string | null;
    png_bytes: number | null;
    dom_truncated: number;
    styles_truncated: number;
    png_truncated: number;
    created_at: number;
  };

  const rows = db.prepare(
    `SELECT
      snapshot_id, session_id, ts, trigger, selector, url, mode, style_mode,
      dom_json, styles_json, png_path, png_mime, png_bytes,
      dom_truncated, styles_truncated, png_truncated, created_at
     FROM snapshots
     WHERE session_id = ?
     ORDER BY ts DESC
     LIMIT ? OFFSET ?`
  ).all(sessionId, limit + 1, offset) as SnapshotRow[];

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  return {
    limit,
    offset,
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
    snapshots: page.map((row) => ({
      snapshotId: row.snapshot_id,
      sessionId: row.session_id,
      timestamp: row.ts,
      trigger: row.trigger,
      selector: row.selector,
      url: row.url,
      mode: row.mode,
      styleMode: row.style_mode,
      dom: parseJsonOrNull(row.dom_json),
      styles: parseJsonOrNull(row.styles_json),
      pngPath: row.png_path,
      pngMime: row.png_mime,
      pngBytes: row.png_bytes,
      truncation: {
        dom: row.dom_truncated === 1,
        styles: row.styles_truncated === 1,
        png: row.png_truncated === 1,
      },
      createdAt: row.created_at,
    })),
  };
}

export function pruneOrphanedSnapshotAssets(db: Database, dbPath: string): number {
  const assetRoot = getSnapshotAssetsRoot(dbPath);
  if (!existsSync(assetRoot)) {
    return 0;
  }

  const referencedPaths = new Set(
    (db.prepare('SELECT png_path FROM snapshots WHERE png_path IS NOT NULL').all() as Array<{ png_path: string }>).map((row) =>
      normalizeAssetPath(row.png_path)
    )
  );

  const files = collectFiles(assetRoot);
  let removed = 0;
  for (const filePath of files) {
    const relativePath = normalizeAssetPath(filePath.slice(assetRoot.length + 1));
    if (referencedPaths.has(relativePath)) {
      continue;
    }
    rmSync(filePath, { force: true });
    removed += 1;
  }
  return removed;
}

export function setSessionPinned(db: Database, sessionId: string, pinned: boolean): boolean {
  const result = db.prepare('UPDATE sessions SET pinned = ? WHERE session_id = ?').run(pinned ? 1 : 0, sessionId);
  return result.changes > 0;
}

export function exportSessionToJson(
  db: Database,
  dbPath: string,
  sessionId: string,
  projectRoot: string,
  exportPathOverride: string | null,
  options: ExportSessionOptions = {},
): ExportSessionResult {
  const compatibilityMode = options.compatibilityMode !== false;
  const payload = buildSessionExportPayload(db, sessionId, dbPath, {
    compatibilityMode,
    includePngBase64: options.includePngBase64 === true,
  });

  const baseDir = exportPathOverride && exportPathOverride.trim().length > 0
    ? resolve(exportPathOverride)
    : resolve(join(projectRoot, 'exports'));
  mkdirSync(baseDir, { recursive: true });

  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9-_]/g, '_');
  const filePath = join(baseDir, `${safeSessionId}.json`);
  writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');

  return {
    filePath,
    format: 'json',
    compatibilityMode,
    events: payload.events.length,
    network: payload.network.length,
    fingerprints: payload.fingerprints.length,
    snapshots: payload.snapshots.length,
  };
}

export async function exportSessionToZip(
  db: Database,
  dbPath: string,
  sessionId: string,
  projectRoot: string,
  exportPathOverride: string | null,
): Promise<ExportSessionResult> {
  const payload = buildSessionExportPayload(db, sessionId, dbPath, {
    compatibilityMode: false,
    includePngBase64: false,
  });

  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(payload, null, 2));

  for (const snapshot of payload.snapshots) {
    const assetPath = snapshot.png.assetPath;
    if (!assetPath) {
      continue;
    }

    const absolutePath = resolve(join(resolve(dbPath, '..'), assetPath));
    if (!existsSync(absolutePath)) {
      throw new Error(`Snapshot export failed: missing asset file ${assetPath}.`);
    }

    const buffer = readFileSync(absolutePath);
    assertPngBuffer(buffer, `Snapshot export failed: corrupt PNG asset ${assetPath}.`);
    zip.file(assetPath, buffer);
  }

  const baseDir = exportPathOverride && exportPathOverride.trim().length > 0
    ? resolve(exportPathOverride)
    : resolve(join(projectRoot, 'exports'));
  mkdirSync(baseDir, { recursive: true });

  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9-_]/g, '_');
  const filePath = join(baseDir, `${safeSessionId}.zip`);
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  writeFileSync(filePath, zipBuffer);

  return {
    filePath,
    format: 'zip',
    compatibilityMode: false,
    events: payload.events.length,
    network: payload.network.length,
    fingerprints: payload.fingerprints.length,
    snapshots: payload.snapshots.length,
  };
}

export async function importSessionFromZipBase64(
  db: Database,
  dbPath: string,
  archiveBase64: string,
): Promise<SessionImportResult> {
  const archive = Buffer.from(archiveBase64, 'base64');
  if (archive.byteLength === 0) {
    throw new Error('Import archive is empty or invalid base64.');
  }

  const zip = await JSZip.loadAsync(archive);
  const manifestEntry = zip.file('manifest.json');
  if (!manifestEntry) {
    throw new Error('Import archive missing manifest.json.');
  }

  const manifestText = await manifestEntry.async('text');
  let payload: unknown;
  try {
    payload = JSON.parse(manifestText);
  } catch {
    throw new Error('Import archive manifest.json is invalid JSON.');
  }

  const snapshotAssets = new Map<string, Buffer>();
  const root = asObject(payload, 'Import payload must be an object');
  const snapshotsValue = root.snapshots;
  if (Array.isArray(snapshotsValue)) {
    for (let i = 0; i < snapshotsValue.length; i += 1) {
      const snapshot = asObject(snapshotsValue[i], `Snapshot at index ${i} must be an object`);
      const png = snapshot.png;
      if (!png || typeof png !== 'object' || Array.isArray(png)) {
        continue;
      }

      const assetPath = asNullableString((png as Record<string, unknown>).assetPath);
      if (!assetPath) {
        continue;
      }

      const normalizedPath = normalizeAssetPath(assetPath);
      const assetEntry = zip.file(normalizedPath);
      if (!assetEntry) {
        throw new Error(`Import archive missing PNG asset ${normalizedPath}.`);
      }

      const buffer = await assetEntry.async('nodebuffer');
      assertPngBuffer(buffer, `Import archive contains corrupt PNG asset ${normalizedPath}.`);
      snapshotAssets.set(normalizedPath, buffer);
    }
  }

  return importSessionFromJson(db, payload, { dbPath, snapshotAssets });
}

export function importSessionFromJson(
  db: Database,
  payload: unknown,
  options: { dbPath?: string; snapshotAssets?: Map<string, Buffer> } = {},
): SessionImportResult {
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
    `INSERT INTO events (event_id, session_id, ts, type, payload_json, tab_id, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const insertNetwork = db.prepare(
    `INSERT INTO network (
      request_id, session_id, ts_start, duration_ms, method, url, origin, status, initiator, error_class, response_size_est
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const insertFingerprint = db.prepare(
    `INSERT INTO error_fingerprints (
      fingerprint, session_id, count, sample_message, sample_stack, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const insertSnapshot = db.prepare(
    `INSERT INTO snapshots (
      snapshot_id, session_id, trigger_event_id, ts, trigger, selector, url, mode, style_mode,
      dom_json, styles_json, png_path, png_mime, png_bytes,
      dom_truncated, styles_truncated, png_truncated, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      insertEvent.run(eventId, sessionId, row.ts, row.type, row.payloadJson, row.tabId, row.origin);
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
        row.origin,
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

    const sortedSnapshots = [...parsed.snapshots].sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 0; i < sortedSnapshots.length; i += 1) {
      const row = sortedSnapshots[i];
      const snapshotId = `${sessionId}-import-snapshot-${importedAt}-${i}`;

      let pngPath: string | null = null;
      let pngMime: string | null = null;
      let pngBytes: number | null = null;

      if (row.png.assetPath || row.png.base64) {
        if (!options.dbPath) {
          throw new Error('Snapshot import requires dbPath when snapshot PNG data is present.');
        }

        let pngBuffer: Buffer | null = null;
        if (row.png.assetPath) {
          const normalizedPath = normalizeAssetPath(row.png.assetPath);
          const fromArchive = options.snapshotAssets?.get(normalizedPath);
          if (!fromArchive) {
            throw new Error(`Import payload references missing PNG asset ${normalizedPath}.`);
          }
          pngBuffer = fromArchive;
        } else if (row.png.base64) {
          pngBuffer = Buffer.from(row.png.base64, 'base64');
        }

        if (!pngBuffer || pngBuffer.byteLength === 0) {
          throw new Error('Snapshot PNG payload is missing or invalid.');
        }
        assertPngBuffer(pngBuffer, 'Snapshot PNG payload is corrupt.');
        const persisted = persistSnapshotPngBuffer(options.dbPath, sessionId, snapshotId, pngBuffer);
        pngPath = persisted.relativePath;
        pngMime = persisted.mime;
        pngBytes = persisted.byteLength;
      }

      insertSnapshot.run(
        snapshotId,
        sessionId,
        null,
        row.timestamp,
        row.trigger,
        row.selector,
        row.url,
        row.mode,
        row.styleMode,
        row.domJson,
        row.stylesJson,
        pngPath,
        pngMime,
        pngBytes,
        row.truncation.dom ? 1 : 0,
        row.truncation.styles ? 1 : 0,
        row.truncation.png ? 1 : 0,
        row.createdAt,
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
    snapshots: parsed.snapshots.length,
  };
}

function buildSessionExportPayload(
  db: Database,
  sessionId: string,
  dbPath: string,
  options: { compatibilityMode: boolean; includePngBase64: boolean },
): SessionExportPayload {
  const session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as Record<string, unknown> | undefined;
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const events = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY ts ASC').all(sessionId) as Record<string, unknown>[];
  const network = db.prepare('SELECT * FROM network WHERE session_id = ? ORDER BY ts_start ASC').all(sessionId) as Record<string, unknown>[];
  const fingerprints = db
    .prepare('SELECT * FROM error_fingerprints WHERE session_id = ? ORDER BY count DESC, last_seen_at DESC')
    .all(sessionId) as Record<string, unknown>[];

  type SnapshotRow = {
    snapshot_id: string;
    session_id: string;
    trigger_event_id: string | null;
    ts: number;
    trigger: string;
    selector: string | null;
    url: string | null;
    mode: string;
    style_mode: string | null;
    dom_json: string | null;
    styles_json: string | null;
    png_path: string | null;
    png_mime: string | null;
    png_bytes: number | null;
    dom_truncated: number;
    styles_truncated: number;
    png_truncated: number;
    created_at: number;
  };

  const rows = db.prepare(
    `SELECT
      snapshot_id, session_id, trigger_event_id, ts, trigger, selector, url, mode, style_mode,
      dom_json, styles_json, png_path, png_mime, png_bytes,
      dom_truncated, styles_truncated, png_truncated, created_at
     FROM snapshots
     WHERE session_id = ?
     ORDER BY ts ASC, created_at ASC`
  ).all(sessionId) as SnapshotRow[];

  const snapshots = rows.map((row) => {
    let pngBase64: string | undefined;
    if (options.includePngBase64 && row.png_path) {
      const absolutePath = resolve(join(resolve(dbPath, '..'), row.png_path));
      if (!existsSync(absolutePath)) {
        throw new Error(`Snapshot export failed: missing asset file ${row.png_path}.`);
      }
      const pngBuffer = readFileSync(absolutePath);
      assertPngBuffer(pngBuffer, `Snapshot export failed: corrupt PNG asset ${row.png_path}.`);
      pngBase64 = pngBuffer.toString('base64');
    }

    const png: SnapshotExportRecord['png'] = {
      path: row.png_path,
      mime: row.png_mime,
      bytes: row.png_bytes,
    };

    if (options.compatibilityMode) {
      if (pngBase64) {
        png.base64 = pngBase64;
      }
    } else if (row.png_path) {
      png.assetPath = normalizeAssetPath(row.png_path);
    }

    return {
      snapshotId: row.snapshot_id,
      sessionId: row.session_id,
      triggerEventId: row.trigger_event_id,
      timestamp: row.ts,
      trigger: row.trigger,
      selector: row.selector,
      url: row.url,
      mode: row.mode,
      styleMode: row.style_mode,
      dom: parseJsonOrNull(row.dom_json),
      styles: parseJsonOrNull(row.styles_json),
      truncation: {
        dom: row.dom_truncated === 1,
        styles: row.styles_truncated === 1,
        png: row.png_truncated === 1,
      },
      createdAt: row.created_at,
      png,
    };
  });

  return {
    exportedAt: new Date().toISOString(),
    session,
    events,
    network,
    fingerprints,
    snapshots,
  };
}

function assertPngBuffer(buffer: Buffer, errorPrefix: string): void {
  if (buffer.byteLength === 0) {
    throw new Error(errorPrefix);
  }
  if (buffer.byteLength > MAX_SNAPSHOT_PNG_BYTES) {
    throw new Error(`${errorPrefix} PNG exceeds ${MAX_SNAPSHOT_PNG_BYTES} bytes.`);
  }
  const pngSignature = '89504e470d0a1a0a';
  if (buffer.subarray(0, 8).toString('hex') !== pngSignature) {
    throw new Error(errorPrefix);
  }
}

function persistSnapshotPngBuffer(
  dbPath: string,
  sessionId: string,
  snapshotId: string,
  buffer: Buffer,
): { relativePath: string; mime: string; byteLength: number } {
  if (buffer.byteLength > MAX_SNAPSHOT_PNG_BYTES) {
    throw new Error(`Snapshot png payload exceeds max bytes (${buffer.byteLength} > ${MAX_SNAPSHOT_PNG_BYTES}).`);
  }

  const safeSession = sessionId.replace(/[^a-zA-Z0-9-_]/g, '_');
  const relativePath = normalizeAssetPath(join(SNAPSHOT_ASSET_DIR, safeSession, `${snapshotId}.png`));
  const absolutePath = resolve(join(resolve(dbPath, '..'), relativePath));
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, buffer);

  return {
    relativePath,
    mime: 'image/png',
    byteLength: buffer.byteLength,
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

function normalizeSnapshotTrigger(value: unknown): string {
  if (value === 'click' || value === 'manual' || value === 'navigation' || value === 'error') {
    return value;
  }
  return 'manual';
}

function normalizeSnapshotMode(value: unknown): string {
  const mode = value as { dom?: unknown; png?: unknown } | undefined;
  const dom = Boolean(mode?.dom);
  const png = Boolean(mode?.png);
  if (dom && png) {
    return 'both';
  }
  if (png) {
    return 'png';
  }
  return 'dom';
}

function normalizeStyleMode(value: unknown): string {
  const mode = value as { styleMode?: unknown } | undefined;
  return mode?.styleMode === 'computed-full' ? 'computed-full' : 'computed-lite';
}

function serializeBounded(value: unknown, maxBytes: number, label: 'dom' | 'styles'): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const text = JSON.stringify(value);
  const bytes = Buffer.byteLength(text, 'utf-8');
  if (bytes > maxBytes) {
    throw new Error(`Snapshot ${label} payload exceeds max bytes (${bytes} > ${maxBytes}).`);
  }
  return text;
}

function maybePersistPng(
  dbPath: string,
  sessionId: string,
  snapshotId: string,
  input: SnapshotWriteInput['png'],
): { relativePath: string | null; mime: string | null; byteLength: number | null } {
  if (!input || input.captured !== true || typeof input.dataUrl !== 'string') {
    return { relativePath: null, mime: null, byteLength: null };
  }

  const match = /^data:(image\/png);base64,(.+)$/u.exec(input.dataUrl);
  if (!match) {
    throw new Error('Snapshot png payload must be a PNG data URL.');
  }

  const mime = match[1] ?? 'image/png';
  const base64 = match[2] ?? '';
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.byteLength > MAX_SNAPSHOT_PNG_BYTES) {
    throw new Error(
      `Snapshot png payload exceeds max bytes (${buffer.byteLength} > ${MAX_SNAPSHOT_PNG_BYTES}).`
    );
  }

  const safeSession = sessionId.replace(/[^a-zA-Z0-9-_]/g, '_');
  const relativePath = normalizeAssetPath(join(SNAPSHOT_ASSET_DIR, safeSession, `${snapshotId}.png`));
  const absolutePath = resolve(join(resolve(dbPath, '..'), relativePath));
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, buffer);

  return {
    relativePath,
    mime,
    byteLength: buffer.byteLength,
  };
}

function parseJsonOrNull(value: string | null): unknown {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getSnapshotAssetsRoot(dbPath: string): string {
  return resolve(join(resolve(dbPath, '..'), SNAPSHOT_ASSET_DIR));
}

function normalizeAssetPath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/');
}

function collectFiles(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
      continue;
    }
    files.push(fullPath);
  }
  return files;
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
  events: Array<{ ts: number; type: string; payloadJson: string; tabId: number | null; origin: string | null }>;
  network: Array<{
    tsStart: number;
    durationMs: number | null;
    method: string;
    url: string;
    origin: string | null;
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
  snapshots: Array<{
    timestamp: number;
    trigger: string;
    selector: string | null;
    url: string | null;
    mode: string;
    styleMode: string;
    domJson: string | null;
    stylesJson: string | null;
    truncation: {
      dom: boolean;
      styles: boolean;
      png: boolean;
    };
    createdAt: number;
    png: {
      assetPath: string | null;
      base64: string | null;
    };
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
  const rawSnapshots = root.snapshots === undefined ? [] : asArray(root.snapshots, 'Import payload snapshots must be an array');

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
    const rawPayload = event.payload_json ?? event.payload ?? {};
    const payloadJson = toJsonString(rawPayload);
    const payload =
      rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
        ? (rawPayload as Record<string, unknown>)
        : {};
    return {
      ts,
      type,
      payloadJson,
      tabId: asNullableInteger(event.tab_id ?? event.tabId ?? payload.tabId),
      origin: normalizeHttpOrigin(
        event.origin ?? payload.origin ?? payload.url ?? payload.to ?? payload.href ?? payload.location
      ),
    };
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
      origin: normalizeHttpOrigin(row.origin ?? url),
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

  const snapshots = rawSnapshots.map((entry, index) => {
    const row = asObject(entry, `Snapshot at index ${index} must be an object`);
    const timestamp = asTimestamp(row.ts ?? row.timestamp, createdAt);
    const trigger = normalizeSnapshotTrigger(row.trigger);
    const selector = asNullableString(row.selector);
    const url = asNullableString(row.url);
    const mode = normalizeSnapshotMode(row.mode);
    const styleMode = normalizeStyleMode({ styleMode: row.style_mode ?? row.styleMode });
    const domJson = toNullableJsonString(row.dom_json ?? row.dom);
    const stylesJson = toNullableJsonString(row.styles_json ?? row.styles);

    const pngRoot = row.png && typeof row.png === 'object' && !Array.isArray(row.png)
      ? row.png as Record<string, unknown>
      : {};

    const assetPath = asNullableString(pngRoot.assetPath ?? row.png_asset_path);
    const base64 = asNullableString(pngRoot.base64 ?? row.png_base64);

    return {
      timestamp,
      trigger,
      selector,
      url,
      mode,
      styleMode,
      domJson,
      stylesJson,
      truncation: {
        dom: Boolean(row.dom_truncated ?? (row.truncation as Record<string, unknown> | undefined)?.dom),
        styles: Boolean(row.styles_truncated ?? (row.truncation as Record<string, unknown> | undefined)?.styles),
        png: Boolean(row.png_truncated ?? (row.truncation as Record<string, unknown> | undefined)?.png),
      },
      createdAt: asTimestamp(row.created_at ?? row.createdAt, createdAt),
      png: {
        assetPath,
        base64,
      },
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
    snapshots,
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

function normalizeHttpOrigin(value: unknown): string | null {
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

function toNullableJsonString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return toJsonString(value);
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
