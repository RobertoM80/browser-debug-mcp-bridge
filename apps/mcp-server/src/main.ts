import Fastify from 'fastify';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { WebSocketManager } from './websocket/websocket-server';
import { initializeDatabase, getConnection, getDatabasePath } from './db';

const fastify = Fastify({
  logger: true
});

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
let wsManager: WebSocketManager | null = null;

fastify.get('/health', async () => {
  let dbStatus = 'disconnected';
  try {
    dbStatus = getConnection().isConnected ? 'connected' : 'disconnected';
  } catch {
    // Database not initialized
  }
  
  const wsStats = wsManager?.getConnectionStats() ?? { total: 0, withSession: 0 };
  
  return { 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    database: dbStatus,
    websocket: {
      connections: wsStats.total,
      activeSessions: wsStats.withSession
    }
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
  wsManager?.close();
  getConnection().db.close();
}

export { fastify, wsManager };

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
