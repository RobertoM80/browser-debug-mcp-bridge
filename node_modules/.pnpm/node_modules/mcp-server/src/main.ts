import Fastify from 'fastify';

const fastify = Fastify({
  logger: true
});

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

fastify.get('/', async () => {
  return { 
    name: 'Browser Debug MCP Bridge Server',
    version: '1.0.0'
  };
});

export async function startServer(): Promise<void> {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    fastify.log.info(`Server listening on port ${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

export { fastify };

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
