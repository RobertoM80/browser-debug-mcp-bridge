import { describe, it, expect } from 'vitest';
import { fastify } from './main.js';

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
});
