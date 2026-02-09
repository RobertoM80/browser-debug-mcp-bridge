import Fastify from 'fastify';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { pathToFileURL } from 'url';
import { WebSocketManager } from './websocket/websocket-server';
import { initializeDatabase, getConnection, getDatabasePath } from './db';
import {
  exportSessionToJson,
  getRetentionSettings,
  runRetentionCleanup,
  setSessionPinned,
  shouldRunCleanup,
  updateRetentionSettings,
} from './retention';

const fastify = Fastify({
  logger: true
});

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
let wsManager: WebSocketManager | null = null;
const startedAt = Date.now();
let cleanupInterval: NodeJS.Timeout | null = null;
let lastCleanupResult: ReturnType<typeof runRetentionCleanup> | null = null;

function getDbStats(): { status: 'connected' | 'disconnected'; sessions: number; events: number; network: number; fingerprints: number } {
  try {
    const db = getConnection().db;
    return {
      status: 'connected',
      sessions: (db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number }).count,
      events: (db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number }).count,
      network: (db.prepare('SELECT COUNT(*) as count FROM network').get() as { count: number }).count,
      fingerprints: (db.prepare('SELECT COUNT(*) as count FROM error_fingerprints').get() as { count: number }).count,
    };
  } catch {
    return {
      status: 'disconnected',
      sessions: 0,
      events: 0,
      network: 0,
      fingerprints: 0,
    };
  }
}

fastify.get('/health', async () => {
  const dbStats = getDbStats();
  
  const wsStats = wsManager?.getConnectionStats() ?? { total: 0, withSession: 0 };
  
  return { 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    database: dbStats.status,
    websocket: {
      connections: wsStats.total,
      activeSessions: wsStats.withSession
    }
  };
});

fastify.get('/stats', async () => {
  const dbStats = getDbStats();
  const wsStats = wsManager?.getConnectionStats() ?? { total: 0, withSession: 0 };
  const settings = getRetentionSettings(getConnection().db);

  return {
    timestamp: new Date().toISOString(),
    uptimeMs: Date.now() - startedAt,
    memory: process.memoryUsage(),
    database: dbStats,
    websocket: {
      connections: wsStats.total,
      activeSessions: wsStats.withSession,
    },
    retention: {
      settings,
      lastCleanup: lastCleanupResult,
    },
  };
});

fastify.get('/retention/settings', async () => {
  return {
    settings: getRetentionSettings(getConnection().db),
    lastCleanup: lastCleanupResult,
  };
});

fastify.post('/retention/settings', async (request) => {
  const body = (request.body ?? {}) as Partial<{
    retentionDays: number;
    maxDbMb: number;
    maxSessions: number;
    cleanupIntervalMinutes: number;
    exportPathOverride: string | null;
  }>;

  const settings = updateRetentionSettings(getConnection().db, {
    retentionDays: body.retentionDays,
    maxDbMb: body.maxDbMb,
    maxSessions: body.maxSessions,
    cleanupIntervalMinutes: body.cleanupIntervalMinutes,
    exportPathOverride: body.exportPathOverride,
  });

  return { ok: true, settings };
});

fastify.post('/retention/run-cleanup', async () => {
  const db = getConnection().db;
  const settings = getRetentionSettings(db);
  const result = runRetentionCleanup(db, getDatabasePath(), settings, 'manual');
  lastCleanupResult = result;

  fastify.log.warn(
    {
      component: 'retention',
      event: 'cleanup_executed',
      trigger: result.trigger,
      deletedSessions: result.deletedSessions,
      warning: result.warning,
      dbSizeBeforeMb: result.dbSizeBeforeMb,
      dbSizeAfterMb: result.dbSizeAfterMb,
    },
    'Auto cleanup removed old sessions to enforce limits',
  );

  return { ok: true, result };
});

fastify.post('/sessions/:sessionId/pin', async (request) => {
  const params = request.params as { sessionId: string };
  const body = (request.body ?? {}) as { pinned?: boolean };
  const pinned = body.pinned ?? true;
  const updated = setSessionPinned(getConnection().db, params.sessionId, pinned);
  if (!updated) {
    return { ok: false, error: 'Session not found' };
  }
  return { ok: true, sessionId: params.sessionId, pinned };
});

fastify.post('/sessions/:sessionId/export', async (request) => {
  const params = request.params as { sessionId: string };
  const settings = getRetentionSettings(getConnection().db);
  const result = exportSessionToJson(getConnection().db, params.sessionId, process.cwd(), settings.exportPathOverride);
  return { ok: true, sessionId: params.sessionId, ...result };
});

fastify.get('/sessions', async (request) => {
  const query = (request.query ?? {}) as { limit?: string | number; offset?: string | number };
  const db = getConnection().db;
  const rawLimit = typeof query.limit === 'number' ? query.limit : Number(query.limit ?? 0);
  const rawOffset = typeof query.offset === 'number' ? query.offset : Number(query.offset ?? 0);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 200) : 20;
  const offset = Number.isFinite(rawOffset) ? Math.max(Math.floor(rawOffset), 0) : 0;

  type SessionRow = {
    session_id: string;
    created_at: number;
    ended_at: number | null;
    url_last: string | null;
    pinned: number;
  };

  const rows = db.prepare(
    `
      SELECT session_id, created_at, ended_at, url_last, pinned
      FROM sessions
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `
  ).all(limit + 1, offset) as SessionRow[];

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  return {
    ok: true,
    limit,
    offset,
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
    sessions: page.map((row) => ({
      sessionId: row.session_id,
      createdAt: row.created_at,
      endedAt: row.ended_at,
      urlLast: row.url_last,
      pinned: row.pinned === 1,
    })),
  };
});

fastify.get('/sessions/:sessionId/entries', async (request) => {
  const params = request.params as { sessionId: string };
  const query = (request.query ?? {}) as { limit?: string | number; offset?: string | number };
  const db = getConnection().db;

  const rawLimit = typeof query.limit === 'number' ? query.limit : Number(query.limit ?? 0);
  const rawOffset = typeof query.offset === 'number' ? query.offset : Number(query.offset ?? 0);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 10), 500) : 50;
  const offset = Number.isFinite(rawOffset) ? Math.max(Math.floor(rawOffset), 0) : 0;

  const exists = db.prepare('SELECT 1 FROM sessions WHERE session_id = ?').get(params.sessionId);
  if (!exists) {
    return { ok: false, error: 'Session not found' };
  }

  type EntryRow = {
    entry_id: string;
    source: 'event' | 'network';
    ts: number;
    kind: string;
    summary: string;
    raw_json: string;
  };

  const rows = db.prepare(
    `
      SELECT entry_id, source, ts, kind, summary, raw_json
      FROM (
        SELECT
          event_id AS entry_id,
          'event' AS source,
          ts,
          type AS kind,
          REPLACE(REPLACE(payload_json, CHAR(10), ' '), CHAR(13), ' ') AS summary,
          payload_json AS raw_json
        FROM events
        WHERE session_id = ?

        UNION ALL

        SELECT
          request_id AS entry_id,
          'network' AS source,
          ts_start AS ts,
          TRIM(method || ' ' || COALESCE(CAST(status AS TEXT), '-')) AS kind,
          REPLACE(REPLACE(
            TRIM(
              method
              || ' '
              || url
              || CASE WHEN status IS NOT NULL THEN ' (' || status || ')' ELSE '' END
              || CASE WHEN error_class IS NOT NULL THEN ' [' || error_class || ']' ELSE '' END
            ),
            CHAR(10),
            ' '
          ), CHAR(13), ' ') AS summary,
          json_object(
            'requestId', request_id,
            'timestamp', ts_start,
            'durationMs', duration_ms,
            'method', method,
            'url', url,
            'status', status,
            'initiator', initiator,
            'errorClass', error_class,
            'responseSizeEst', response_size_est
          ) AS raw_json
        FROM network
        WHERE session_id = ?
      ) entries
      ORDER BY ts DESC
      LIMIT ? OFFSET ?
    `
  ).all(params.sessionId, params.sessionId, limit + 1, offset) as EntryRow[];

  const eventsCount = (db.prepare('SELECT COUNT(*) as count FROM events WHERE session_id = ?').get(params.sessionId) as { count: number }).count;
  const networkCount = (db.prepare('SELECT COUNT(*) as count FROM network WHERE session_id = ?').get(params.sessionId) as { count: number }).count;
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  return {
    ok: true,
    sessionId: params.sessionId,
    limit,
    offset,
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
    totalApprox: eventsCount + networkCount,
    rows: page.map((row) => {
      let raw: unknown;
      try {
        raw = JSON.parse(row.raw_json);
      } catch {
        raw = { parseError: 'Unable to parse row JSON', raw: row.raw_json };
      }

      return {
        id: row.entry_id,
        source: row.source,
        timestamp: row.ts,
        kind: row.kind,
        summary: row.summary,
        raw,
      };
    }),
  };
});

fastify.get('/', async () => {
  return { 
    name: 'Browser Debug MCP Bridge Server',
    version: '1.0.0',
    websocket: '/ws'
  };
});

export async function startServer(): Promise<void> {
  try {
    const dbPath = getDatabasePath();
    mkdirSync(dirname(dbPath), { recursive: true });
    
    initializeDatabase(getConnection().db);
    fastify.log.info('Database initialized');

    const db = getConnection().db;
    const settings = getRetentionSettings(db);
    if (shouldRunCleanup(settings)) {
      lastCleanupResult = runRetentionCleanup(db, getDatabasePath(), settings, 'startup');
      fastify.log.warn(
        {
          component: 'retention',
          event: 'cleanup_executed',
          trigger: lastCleanupResult.trigger,
          deletedSessions: lastCleanupResult.deletedSessions,
          warning: lastCleanupResult.warning,
          dbSizeBeforeMb: lastCleanupResult.dbSizeBeforeMb,
          dbSizeAfterMb: lastCleanupResult.dbSizeAfterMb,
        },
        'Auto cleanup removed old sessions to enforce limits',
      );
    }

    cleanupInterval = setInterval(() => {
      const localDb = getConnection().db;
      const currentSettings = getRetentionSettings(localDb);
      lastCleanupResult = runRetentionCleanup(localDb, getDatabasePath(), currentSettings, 'scheduled');
      if (lastCleanupResult.deletedSessions > 0 || lastCleanupResult.warning) {
        fastify.log.warn(
          {
            component: 'retention',
            event: 'cleanup_executed',
            trigger: lastCleanupResult.trigger,
            deletedSessions: lastCleanupResult.deletedSessions,
            warning: lastCleanupResult.warning,
            dbSizeBeforeMb: lastCleanupResult.dbSizeBeforeMb,
            dbSizeAfterMb: lastCleanupResult.dbSizeAfterMb,
          },
          'Auto cleanup removed old sessions to enforce limits',
        );
      }
    }, settings.cleanupIntervalMinutes * 60_000);

    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    fastify.log.info(`Server listening on port ${PORT}`);

    wsManager = new WebSocketManager();
    wsManager.initialize(fastify);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

export function stopServer(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  wsManager?.close();
  getConnection().db.close();
}

export { fastify, wsManager };

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;

if (entryUrl && import.meta.url === entryUrl) {
  void startServer();
}
