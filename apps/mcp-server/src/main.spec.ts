import { describe, it, expect } from 'vitest';
import { fastify } from './main.js';
import { getConnection, initializeDatabase } from './db';

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
});
