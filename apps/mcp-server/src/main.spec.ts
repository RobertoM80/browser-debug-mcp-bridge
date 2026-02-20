import { describe, it, expect } from 'vitest';
import { fastify } from './main.js';
import { getConnection, initializeDatabase } from './db';
import { readFileSync } from 'fs';

describe('MCP Server', () => {
  it('should have fastify instance', () => {
    expect(fastify).toBeDefined();
  });

  it('should return health status', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/health'
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();
  });

  it('should return server info on root', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/'
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.name).toBe('Browser Debug MCP Bridge Server');
    expect(body.version).toBe('1.0.0');
  });

  it('should return debug stats', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/stats'
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.timestamp).toBeDefined();
    expect(typeof body.uptimeMs).toBe('number');
    expect(body.database).toBeDefined();
    expect(body.websocket).toBeDefined();
  });

  it('should import a session payload', async () => {
    initializeDatabase(getConnection().db);

    const response = await fastify.inject({
      method: 'POST',
      url: '/sessions/import',
      payload: {
        session: {
          session_id: 'main-import-test',
          created_at: 1700000000000,
          safe_mode: 1,
        },
        events: [],
        network: [],
        fingerprints: [],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.ok).toBe(true);
    expect(body.sessionId).toBeDefined();
  });

  it('should reject invalid import payload', async () => {
    initializeDatabase(getConnection().db);

    const response = await fastify.inject({
      method: 'POST',
      url: '/sessions/import',
      payload: {
        session: {},
        events: [],
        network: [],
        fingerprints: [],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.ok).toBe(false);
    expect(body.error).toContain('session_id');
  });

  it('should persist and list snapshots through HTTP APIs', async () => {
    initializeDatabase(getConnection().db);

    await fastify.inject({
      method: 'POST',
      url: '/sessions/import',
      payload: {
        session: {
          session_id: 'snapshot-api-test',
          created_at: 1700000000000,
          safe_mode: 0,
        },
        events: [],
        network: [],
        fingerprints: [],
      },
    });

    const writeResponse = await fastify.inject({
      method: 'POST',
      url: '/sessions/snapshot-api-test/snapshots',
      payload: {
        timestamp: 1700000000500,
        trigger: 'click',
        selector: '#buy',
        url: 'https://example.test/cart',
        mode: {
          dom: true,
          png: false,
          styleMode: 'computed-lite',
        },
        snapshot: {
          dom: { mode: 'html', html: '<button id="buy">Buy</button>' },
          styles: { nodes: [{ tag: 'BUTTON', css: { display: 'inline-block' } }] },
        },
        truncation: {
          dom: false,
          styles: false,
          png: false,
        },
      },
    });

    const writeBody = JSON.parse(writeResponse.body);
    expect(writeResponse.statusCode).toBe(200);
    expect(writeBody.ok).toBe(true);
    expect(writeBody.snapshotId).toBeDefined();

    const listResponse = await fastify.inject({
      method: 'GET',
      url: '/sessions/snapshot-api-test/snapshots?limit=10&offset=0',
    });
    const listBody = JSON.parse(listResponse.body);

    expect(listResponse.statusCode).toBe(200);
    expect(listBody.ok).toBe(true);
    expect(listBody.snapshots.length).toBe(1);
    expect(listBody.snapshots[0].trigger).toBe('click');
    expect(listBody.snapshots[0].selector).toBe('#buy');
  });

  it('should reject oversized snapshot dom payloads', async () => {
    initializeDatabase(getConnection().db);

    await fastify.inject({
      method: 'POST',
      url: '/sessions/import',
      payload: {
        session: {
          session_id: 'snapshot-api-limit-test',
          created_at: 1700000000000,
          safe_mode: 0,
        },
        events: [],
        network: [],
        fingerprints: [],
      },
    });

    const oversizedHtml = 'x'.repeat(600 * 1024);
    const response = await fastify.inject({
      method: 'POST',
      url: '/sessions/snapshot-api-limit-test/snapshots',
      payload: {
        timestamp: 1700000000600,
        trigger: 'manual',
        mode: {
          dom: true,
          png: false,
          styleMode: 'computed-lite',
        },
        snapshot: {
          dom: { mode: 'html', html: oversizedHtml },
        },
      },
    });

    const body = JSON.parse(response.body);
    expect(response.statusCode).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Snapshot dom payload exceeds max bytes');
  });

  it('should export zip package and import it back', async () => {
    initializeDatabase(getConnection().db);

    await fastify.inject({
      method: 'POST',
      url: '/sessions/import',
      payload: {
        session: {
          session_id: 'snapshot-zip-api-test',
          created_at: 1700000000000,
          safe_mode: 0,
        },
        events: [],
        network: [],
        fingerprints: [],
      },
    });

    await fastify.inject({
      method: 'POST',
      url: '/sessions/snapshot-zip-api-test/snapshots',
      payload: {
        timestamp: 1700000000700,
        trigger: 'manual',
        mode: { dom: true, png: false, styleMode: 'computed-lite' },
        snapshot: {
          dom: { mode: 'html', html: '<div>zip-api</div>' },
        },
      },
    });

    const exportResponse = await fastify.inject({
      method: 'POST',
      url: '/sessions/snapshot-zip-api-test/export',
      payload: { format: 'zip' },
    });
    const exportBody = JSON.parse(exportResponse.body) as { ok: boolean; format: string; snapshots: number; filePath: string };

    expect(exportResponse.statusCode).toBe(200);
    expect(exportBody.ok).toBe(true);
    expect(exportBody.format).toBe('zip');
    expect(exportBody.snapshots).toBe(1);

    const zipBase64 = readFileSync(exportBody.filePath).toString('base64');

    const importResponse = await fastify.inject({
      method: 'POST',
      url: '/sessions/import',
      payload: {
        format: 'zip',
        archiveBase64: zipBase64,
      },
    });

    const importBody = JSON.parse(importResponse.body);
    expect(importResponse.statusCode).toBe(200);
    expect(importBody.ok).toBe(true);
    expect(importBody.snapshots).toBe(1);
  });
});
