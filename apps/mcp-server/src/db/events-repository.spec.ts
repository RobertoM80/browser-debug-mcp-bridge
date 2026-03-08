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

  it('dual-writes automation lifecycle into dedicated run and step tables', () => {
    repository.insertEventsBatch([
      {
        type: 'event',
        sessionId: 'automation-session',
        eventType: 'automation_requested',
        timestamp: 2000,
        data: {
          eventType: 'automation_requested',
          action: 'click',
          traceId: 'trace-dual-write',
          selector: '#submit',
          status: 'requested',
          startedAt: 2000,
          target: {
            matched: true,
            selector: '#submit',
            tabId: 5,
          },
        },
        tabId: 5,
        origin: 'https://example.com',
      },
      {
        type: 'event',
        sessionId: 'automation-session',
        eventType: 'automation_succeeded',
        timestamp: 2075,
        data: {
          eventType: 'automation_succeeded',
          action: 'click',
          traceId: 'trace-dual-write',
          selector: '#submit',
          status: 'succeeded',
          startedAt: 2000,
          finishedAt: 2075,
          durationMs: 75,
          redaction: {
            inputValueRedacted: false,
            sensitiveTarget: false,
          },
          target: {
            matched: true,
            resolvedSelector: '#submit',
            tabId: 5,
          },
        },
        tabId: 5,
        origin: 'https://example.com',
      },
    ]);

    const run = db.prepare(`
      SELECT trace_id, action, tab_id, selector, status, started_at, completed_at
      FROM automation_runs
      WHERE session_id = ?
    `).get('automation-session') as {
      trace_id: string;
      action: string;
      tab_id: number;
      selector: string;
      status: string;
      started_at: number;
      completed_at: number;
    };
    const step = db.prepare(`
      SELECT trace_id, action, status, duration_ms, event_type, tab_id, input_metadata_json
      FROM automation_steps
      WHERE session_id = ?
    `).get('automation-session') as {
      trace_id: string;
      action: string;
      status: string;
      duration_ms: number;
      event_type: string;
      tab_id: number;
      input_metadata_json: string | null;
    };

    expect(run).toMatchObject({
      trace_id: 'trace-dual-write',
      action: 'click',
      tab_id: 5,
      selector: '#submit',
      status: 'succeeded',
      started_at: 2000,
      completed_at: 2075,
    });
    expect(step).toMatchObject({
      trace_id: 'trace-dual-write',
      action: 'click',
      status: 'succeeded',
      duration_ms: 75,
      event_type: 'automation_succeeded',
      tab_id: 5,
      input_metadata_json: null,
    });
  });

  it('records automation stop reasons in dedicated run rows', () => {
    repository.insertEventsBatch([
      {
        type: 'event',
        sessionId: 'automation-session',
        eventType: 'automation_started',
        timestamp: 3000,
        data: {
          eventType: 'automation_started',
          action: 'input',
          traceId: 'trace-stop',
          selector: '#email',
          status: 'started',
          startedAt: 3000,
          target: {
            matched: true,
            selector: '#email',
            tabId: 6,
          },
        },
        tabId: 6,
        origin: 'https://example.com',
      },
      {
        type: 'event',
        sessionId: 'automation-session',
        eventType: 'automation_stopped',
        timestamp: 3010,
        data: {
          eventType: 'automation_stopped',
          action: 'input',
          traceId: 'trace-stop',
          status: 'stopped',
          stopReason: 'emergency_stop',
          target: {
            matched: false,
            tabId: 6,
          },
        },
        tabId: 6,
        origin: 'https://example.com',
      },
    ]);

    const run = db.prepare(`
      SELECT status, stop_reason, completed_at
      FROM automation_runs
      WHERE trace_id = ?
    `).get('trace-stop') as {
      status: string;
      stop_reason: string;
      completed_at: number;
    };

    expect(run).toEqual({
      status: 'stopped',
      stop_reason: 'emergency_stop',
      completed_at: 3010,
    });
  });
});
