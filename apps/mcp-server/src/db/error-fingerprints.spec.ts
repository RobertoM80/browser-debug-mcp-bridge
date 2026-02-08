import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createConnection } from './connection';
import { initializeDatabase } from './migrations';
import { EventsRepository } from './events-repository';
import { createErrorFingerprint } from './error-fingerprints';
import type { EventMessage, SessionStartMessage } from '../websocket/messages';

describe('Error fingerprinting', () => {
  let dbPath: string;
  let db: Database.Database;
  let repository: EventsRepository;

  beforeEach(() => {
    dbPath = join(tmpdir(), `fingerprints-test-${Date.now()}.db`);
    const conn = createConnection(dbPath);
    db = conn.db;
    initializeDatabase(db);
    repository = new EventsRepository(db);

    const sessionStart: SessionStartMessage = {
      type: 'session_start',
      sessionId: 'fp-test-session',
      url: 'https://example.com',
      safeMode: false,
      timestamp: Date.now(),
    };

    repository.createSession(sessionStart);
  });

  afterEach(() => {
    db.close();
    if (existsSync(dbPath)) {
      try {
        unlinkSync(dbPath);
      } catch {
        // Ignore transient Windows file locking.
      }
    }
  });

  it('creates stable fingerprints from message and stack', () => {
    const first = createErrorFingerprint('TypeError: bad', 'at app.js:10:4');
    const second = createErrorFingerprint(' TypeError: bad ', 'at app.js:10:4');

    expect(first).toBe(second);
    expect(first.startsWith('fp-')).toBe(true);
  });

  it('changes fingerprint when stack changes', () => {
    const first = createErrorFingerprint('TypeError: bad', 'at app.js:10:4');
    const second = createErrorFingerprint('TypeError: bad', 'at app.js:11:7');

    expect(first).not.toBe(second);
  });

  it('aggregates repeated errors with computed fingerprint', () => {
    const firstEvent: EventMessage = {
      type: 'event',
      sessionId: 'fp-test-session',
      eventType: 'error',
      data: {
        message: 'TypeError: undefined is not a function',
        stack: 'at bundle.js:10:5',
      },
      timestamp: Date.now(),
    };

    const secondEvent: EventMessage = {
      ...firstEvent,
      timestamp: Date.now() + 1,
    };

    repository.insertEvent(firstEvent);
    repository.insertEvent(secondEvent);

    const rows = db.prepare('SELECT * FROM error_fingerprints').all() as Array<{
      fingerprint: string;
      count: number;
      sample_message: string;
      sample_stack: string | null;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(2);
    expect(rows[0].sample_message).toBe('TypeError: undefined is not a function');
    expect(rows[0].sample_stack).toBe('at bundle.js:10:5');
  });
});
