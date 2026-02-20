import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeDatabase } from './db/migrations';
import { importSessionFromJson } from './retention';

describe('session import', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    initializeDatabase(db);
  });

  afterEach(() => {
    db.close();
  });

  it('imports an exported session payload', () => {
    const result = importSessionFromJson(db, {
      exportedAt: '2026-01-01T00:00:00.000Z',
      session: {
        session_id: 'session-import-1',
        created_at: 1700000000000,
        ended_at: 1700000001000,
        safe_mode: 1,
      },
      events: [
        {
          ts: 1700000000001,
          type: 'error',
          payload_json: '{"message":"boom"}',
        },
      ],
      network: [
        {
          ts_start: 1700000000002,
          method: 'GET',
          url: 'https://example.test/api',
          status: 500,
          error_class: 'http_error',
        },
      ],
      fingerprints: [
        {
          fingerprint: 'fp-1',
          count: 2,
          sample_message: 'boom',
          sample_stack: null,
          first_seen_at: 1700000000001,
          last_seen_at: 1700000000002,
        },
      ],
    });

    expect(result.sessionId).toBe('session-import-1');
    expect(result.remappedSessionId).toBe(false);
    expect(result.events).toBe(1);
    expect(result.network).toBe(1);
    expect(result.fingerprints).toBe(1);

    const sessions = (db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number }).count;
    const events = (db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number }).count;
    const network = (db.prepare('SELECT COUNT(*) as count FROM network').get() as { count: number }).count;
    const fingerprints = (db.prepare('SELECT COUNT(*) as count FROM error_fingerprints').get() as { count: number }).count;

    expect(sessions).toBe(1);
    expect(events).toBe(1);
    expect(network).toBe(1);
    expect(fingerprints).toBe(1);
  });

  it('remaps session id when importing duplicate session id', () => {
    const payload = {
      session: {
        session_id: 'duplicate-id',
        created_at: 1700000000000,
        safe_mode: 1,
      },
      events: [],
      network: [],
      fingerprints: [],
    };

    const first = importSessionFromJson(db, payload);
    const second = importSessionFromJson(db, payload);

    expect(first.sessionId).toBe('duplicate-id');
    expect(second.sessionId).not.toBe('duplicate-id');
    expect(second.remappedSessionId).toBe(true);

    const sessions = (db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number }).count;
    expect(sessions).toBe(2);
  });

  it('rejects invalid payloads', () => {
    expect(() => importSessionFromJson(db, { session: {}, events: [], network: [], fingerprints: [] })).toThrow(
      'Import payload missing session_id'
    );
  });
});
