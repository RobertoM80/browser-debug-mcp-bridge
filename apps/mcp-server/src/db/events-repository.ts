import { Database } from 'better-sqlite3';
import type { EventMessage, SessionStartMessage, SessionEndMessage } from '../websocket/messages';
import { resolveErrorFingerprint } from './error-fingerprints';
import { getDatabasePath } from './connection';
import { writeSnapshot } from '../retention';

export interface SessionRecord {
  sessionId: string;
  createdAt: number;
  endedAt?: number;
  tabId?: number;
  windowId?: number;
  urlStart?: string;
  urlLast?: string;
  userAgent?: string;
  viewportW?: number;
  viewportH?: number;
  dpr?: number;
  safeMode: boolean;
  allowlistHash?: string;
}

export interface EventRecord {
  eventId: string;
  sessionId: string;
  timestamp: number;
  type: string;
  payload: Record<string, unknown>;
}

export class EventsRepository {
  constructor(private db: Database) {}

  insertEventsBatch(messages: EventMessage[]): void {
    if (messages.length === 0) {
      return;
    }

    const insert = this.db.prepare(`
      INSERT INTO events (event_id, session_id, ts, type, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `);

    const insertNetwork = this.db.prepare(`
      INSERT INTO network (
        request_id, session_id, ts_start, duration_ms, method, url, status, initiator, error_class, response_size_est
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const upsertFingerprint = this.db.prepare(`
      INSERT INTO error_fingerprints (
        fingerprint, session_id, count, sample_message, sample_stack, first_seen_at, last_seen_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(fingerprint) DO UPDATE SET
        count = count + 1,
        last_seen_at = excluded.last_seen_at,
        sample_message = COALESCE(error_fingerprints.sample_message, excluded.sample_message),
        sample_stack = COALESCE(error_fingerprints.sample_stack, excluded.sample_stack)
    `);

    const runBatch = this.db.transaction((batch: EventMessage[]) => {
      for (const message of batch) {
        const eventId = `${message.sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
        const dbEventType = this.mapEventType(message.eventType);

        insert.run(
          eventId,
          message.sessionId,
          message.timestamp ?? Date.now(),
          dbEventType,
          JSON.stringify(message.data)
        );

        if (message.eventType === 'error') {
          this.upsertErrorFingerprintPrepared(upsertFingerprint, message.sessionId, message.data);
        }

        if (message.eventType === 'network') {
          this.insertNetworkEventPrepared(insertNetwork, message.sessionId, message.data);
        }

        if (message.eventType === 'ui_snapshot') {
          this.insertSnapshotPrepared(message.sessionId, eventId, message.data);
        }
      }
    });

    runBatch(messages);
  }

  createSession(message: SessionStartMessage): void {
    const insert = this.db.prepare(`
      INSERT INTO sessions (
        session_id, created_at, tab_id, window_id, url_start, url_last,
        user_agent, viewport_w, viewport_h, dpr, safe_mode, allowlist_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = Date.now();
    insert.run(
      message.sessionId,
      now,
      message.tabId ?? null,
      message.windowId ?? null,
      message.url,
      message.url,
      message.userAgent ?? null,
      message.viewport?.width ?? null,
      message.viewport?.height ?? null,
      message.dpr ?? null,
      message.safeMode ? 1 : 0,
      null
    );
  }

  endSession(message: SessionEndMessage): void {
    const update = this.db.prepare(`
      UPDATE sessions 
      SET ended_at = ?
      WHERE session_id = ?
    `);

    update.run(Date.now(), message.sessionId);
  }

  insertEvent(message: EventMessage): void {
    this.insertEventsBatch([message]);
  }

  private mapEventType(eventType: string): string {
    const mapping: Record<string, string> = {
      'navigation': 'nav',
      'console': 'console',
      'error': 'error',
      'network': 'network',
      'click': 'ui',
      'ui_snapshot': 'ui',
      'custom': 'ui',
    };
    return mapping[eventType] || 'ui';
  }

  private upsertErrorFingerprintPrepared(
    statement: ReturnType<Database['prepare']>,
    sessionId: string,
    data: Record<string, unknown>
  ): void {
    const fingerprint = resolveErrorFingerprint(data);
    if (!fingerprint) return;

    const now = Date.now();
    (statement as { run: (...params: unknown[]) => unknown }).run(
      fingerprint,
      sessionId,
      (data.message as string) ?? 'Unknown error',
      (data.stack as string) ?? null,
      now,
      now
    );
  }

  private insertNetworkEventPrepared(
    statement: ReturnType<Database['prepare']>,
    sessionId: string,
    data: Record<string, unknown>
  ): void {
    const requestId = `${sessionId}-net-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

    (statement as { run: (...params: unknown[]) => unknown }).run(
      requestId,
      sessionId,
      data.timestamp as number ?? Date.now(),
      data.duration as number ?? null,
      data.method as string ?? 'GET',
      data.url as string ?? '',
      data.status as number ?? null,
      data.initiator as string ?? 'other',
      data.errorType as string ?? null,
      data.responseSize as number ?? null
    );
  }

  private insertSnapshotPrepared(
    sessionId: string,
    triggerEventId: string,
    data: Record<string, unknown>
  ): void {
    writeSnapshot(
      this.db,
      getDatabasePath(),
      sessionId,
      data,
      triggerEventId,
    );
  }

  sessionExists(sessionId: string): boolean {
    const result = this.db.prepare('SELECT 1 FROM sessions WHERE session_id = ?').get(sessionId);
    return !!result;
  }
}
