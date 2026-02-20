import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeDatabase } from './db/migrations';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, readFileSync, rmSync } from 'fs';
import JSZip from 'jszip';
import {
  exportSessionToJson,
  exportSessionToZip,
  importSessionFromJson,
  importSessionFromZipBase64,
  pruneOrphanedSnapshotAssets,
  writeSnapshot,
} from './retention';

describe('session import', () => {
  let db: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `retention-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    initializeDatabase(db);
  });

  afterEach(() => {
    db.close();
    if (existsSync(dbPath)) {
      rmSync(dbPath, { force: true });
    }
    const assetDir = join(tmpdir(), 'snapshot-assets');
    if (existsSync(assetDir)) {
      rmSync(assetDir, { recursive: true, force: true });
    }
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

  it('writes snapshot metadata and png assets', () => {
    importSessionFromJson(db, {
      session: {
        session_id: 'snapshot-persist-1',
        created_at: 1700000000000,
        safe_mode: 0,
      },
      events: [],
      network: [],
      fingerprints: [],
    });

    const result = writeSnapshot(db, dbPath, 'snapshot-persist-1', {
      timestamp: 1700000001111,
      trigger: 'manual',
      selector: '#app',
      mode: { dom: true, png: true, styleMode: 'computed-lite' },
      snapshot: {
        dom: { mode: 'html', html: '<div id="app">ok</div>' },
        styles: { nodes: [{ tag: 'DIV' }] },
      },
      png: {
        captured: true,
        format: 'png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z2akAAAAASUVORK5CYII=',
      },
      truncation: { dom: false, styles: false, png: false },
    });

    expect(result.snapshotId).toContain('snapshot-persist-1-snapshot-');

    const row = db.prepare('SELECT png_path, png_bytes, mode FROM snapshots WHERE snapshot_id = ?').get(result.snapshotId) as {
      png_path: string | null;
      png_bytes: number | null;
      mode: string;
    };

    expect(row.mode).toBe('both');
    expect(row.png_path).toBeTruthy();
    expect((row.png_bytes ?? 0) > 0).toBe(true);
    expect(existsSync(join(tmpdir(), row.png_path!))).toBe(true);
  });

  it('prunes orphaned snapshot png assets', () => {
    importSessionFromJson(db, {
      session: {
        session_id: 'snapshot-persist-2',
        created_at: 1700000000000,
        safe_mode: 0,
      },
      events: [],
      network: [],
      fingerprints: [],
    });

    const result = writeSnapshot(db, dbPath, 'snapshot-persist-2', {
      timestamp: 1700000002222,
      trigger: 'manual',
      mode: { dom: true, png: true, styleMode: 'computed-lite' },
      snapshot: { dom: { mode: 'html', html: '<div>ok</div>' } },
      png: {
        captured: true,
        format: 'png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z2akAAAAASUVORK5CYII=',
      },
    });

    const pngPath = (db.prepare('SELECT png_path FROM snapshots WHERE snapshot_id = ?').get(result.snapshotId) as { png_path: string }).png_path;
    const absolute = join(tmpdir(), pngPath);
    expect(existsSync(absolute)).toBe(true);

    db.prepare('DELETE FROM snapshots WHERE snapshot_id = ?').run(result.snapshotId);
    const removed = pruneOrphanedSnapshotAssets(db, dbPath);

    expect(removed).toBe(1);
    expect(existsSync(absolute)).toBe(false);
  });

  it('exports snapshots in json compatibility mode with optional png base64', () => {
    importSessionFromJson(db, {
      session: {
        session_id: 'snapshot-export-json',
        created_at: 1700000000000,
        safe_mode: 0,
      },
      events: [],
      network: [],
      fingerprints: [],
    });

    writeSnapshot(db, dbPath, 'snapshot-export-json', {
      timestamp: 1700000003333,
      trigger: 'manual',
      mode: { dom: true, png: true, styleMode: 'computed-lite' },
      snapshot: { dom: { mode: 'html', html: '<div>json</div>' } },
      png: {
        captured: true,
        format: 'png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z2akAAAAASUVORK5CYII=',
      },
    });

    const result = exportSessionToJson(db, dbPath, 'snapshot-export-json', process.cwd(), null, {
      compatibilityMode: true,
      includePngBase64: true,
    });

    expect(result.format).toBe('json');
    expect(result.snapshots).toBe(1);

    const payload = JSON.parse(readFileSync(result.filePath, 'utf-8')) as {
      snapshots: Array<{ png: { base64?: string } }>;
    };
    expect(payload.snapshots.length).toBe(1);
    expect(typeof payload.snapshots[0]?.png.base64).toBe('string');
  });

  it('exports and imports zip package with snapshot assets', async () => {
    importSessionFromJson(db, {
      session: {
        session_id: 'snapshot-zip-roundtrip',
        created_at: 1700000000000,
        safe_mode: 0,
      },
      events: [{ ts: 1700000000001, type: 'ui', payload_json: '{"eventType":"click"}' }],
      network: [],
      fingerprints: [],
    });

    writeSnapshot(db, dbPath, 'snapshot-zip-roundtrip', {
      timestamp: 1700000004444,
      trigger: 'click',
      selector: '#checkout',
      mode: { dom: true, png: true, styleMode: 'computed-lite' },
      snapshot: { dom: { mode: 'html', html: '<button id="checkout">Checkout</button>' } },
      png: {
        captured: true,
        format: 'png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z2akAAAAASUVORK5CYII=',
      },
    });

    const exported = await exportSessionToZip(db, dbPath, 'snapshot-zip-roundtrip', process.cwd(), null);
    const archiveBase64 = readFileSync(exported.filePath).toString('base64');
    const imported = await importSessionFromZipBase64(db, dbPath, archiveBase64);

    expect(exported.format).toBe('zip');
    expect(exported.snapshots).toBe(1);
    expect(imported.snapshots).toBe(1);
    expect(imported.remappedSessionId).toBe(true);
  });

  it('fails zip import when snapshot asset is missing', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({
      session: { session_id: 'zip-missing-asset', created_at: 1700000000000, safe_mode: 0 },
      events: [],
      network: [],
      fingerprints: [],
      snapshots: [
        {
          timestamp: 1700000005555,
          trigger: 'manual',
          mode: 'dom',
          styleMode: 'computed-lite',
          dom: { mode: 'html', html: '<div>x</div>' },
          truncation: { dom: false, styles: false, png: false },
          createdAt: 1700000005555,
          png: { assetPath: 'assets/missing.png' },
        },
      ],
    }));
    const archiveBase64 = (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64');

    await expect(importSessionFromZipBase64(db, dbPath, archiveBase64)).rejects.toThrow('missing PNG asset');
  });
});
