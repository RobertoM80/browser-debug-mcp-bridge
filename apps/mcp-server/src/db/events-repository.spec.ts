import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createConnection } from './connection';
import { initializeDatabase } from './migrations';
import { EventsRepository } from './events-repository';
import type { EventMessage, SessionStartMessage } from '../websocket/messages';

describe('EventsRepository automation persistence', () => {
  let dbPath: string;
  let db: Database.Database;
  let repository: EventsRepository;

  beforeEach(() => {
    dbPath = join(tmpdir(), `events-repository-test-${Date.now()}.db`);
    const conn = createConnection(dbPath);
    db = conn.db;
    initializeDatabase(db);
    repository = new EventsRepository(db);

    const sessionStart: SessionStartMessage = {
      type: 'session_start',
      sessionId: 'automation-session',
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
        // Ignore transient Windows locking.
      }
    }
  });

  it('stores automation lifecycle events in the existing ui bucket', () => {
    const message: EventMessage = {
      type: 'event',
      sessionId: 'automation-session',
      eventType: 'automation_succeeded',
      timestamp: 1234,
      data: {
        eventType: 'automation_succeeded',
        action: 'input',
        traceId: 'trace-123',
        selector: '#email',
        status: 'succeeded',
        startedAt: 1200,
        finishedAt: 1234,
        durationMs: 34,
        redaction: {
          inputValueRedacted: true,
          sensitiveTarget: true,
        },
        input: {
          fieldType: 'email',
          valueLength: 18,
          sensitive: true,
        },
      },
      tabId: 3,
      origin: 'https://example.com',
    };

    repository.insertEvent(message);

    const row = db.prepare('SELECT type, payload_json, tab_id, origin FROM events WHERE session_id = ?').get('automation-session') as {
      type: string;
      payload_json: string;
      tab_id: number;
      origin: string;
    };
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;

    expect(row.type).toBe('ui');
    expect(row.tab_id).toBe(3);
    expect(row.origin).toBe('https://example.com');
    expect(payload.eventType).toBe('automation_succeeded');
    expect(payload.action).toBe('input');
    expect(payload.traceId).toBe('trace-123');
    expect(payload.redaction).toEqual({
      inputValueRedacted: true,
      sensitiveTarget: true,
    });
    expect(payload.input).toEqual({
      fieldType: 'email',
      valueLength: 18,
      sensitive: true,
    });
    expect(JSON.stringify(payload)).not.toContain('secret@example.com');
  });
});
