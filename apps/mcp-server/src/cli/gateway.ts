import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getConnection } from '../db/index.js';
import type { WebSocketManager } from '../websocket/websocket-server.js';
import {
  createToolRegistry,
  createV1ToolHandlers,
  createV2ToolHandlers,
  routeToolCall,
  type CaptureCommandClient,
  type RegisteredTool,
  type SessionConnectionLookupResult,
} from '../mcp/server.js';
import { createToolLoopGuard } from '../mcp/tool-loop-guard.js';
import { getAgentInstructions } from './agent-instructions.js';
import { ensureCliToken, isAuthorizedCliRequest } from './auth.js';

interface CliGatewayOptions {
  getWebSocketManager: () => WebSocketManager | null;
}

function getHeaders(request: FastifyRequest): Record<string, unknown> {
  return request.headers as Record<string, unknown>;
}

function requireCliAuthorization(request: FastifyRequest, reply: FastifyReply): boolean {
  if (isAuthorizedCliRequest(getHeaders(request))) {
    return true;
  }
  void reply.code(401).send({
    ok: false,
    error: 'CLI authorization required',
    hint: 'Use the packaged bdmcp CLI so it can read the local CLI token automatically.',
  });
  return false;
}

function serializeTools(tools: RegisteredTool[]): Array<{ name: string; description: string; inputSchema: object }> {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

export function createCliToolRegistry(options: CliGatewayOptions): RegisteredTool[] {
  const captureClient: CaptureCommandClient = {
    execute: async (sessionId, command, payload, timeoutMs) => {
      const manager = options.getWebSocketManager();
      if (!manager) {
        return {
          ok: false,
          payload: {},
          error: 'WebSocket manager unavailable. Start the bridge runtime before using live CLI tools.',
        };
      }
      return manager.sendCaptureCommand(sessionId, command, payload, timeoutMs);
    },
  };

  const getSessionConnectionState = (sessionId: string): SessionConnectionLookupResult | undefined => {
    const manager = options.getWebSocketManager();
    const state = manager?.getSessionConnectionState(sessionId);
    if (!state) {
      return undefined;
    }
    return {
      connected: state.connected,
      connectedAt: state.connectedAt,
      lastHeartbeatAt: state.lastHeartbeatAt,
      disconnectedAt: state.disconnectedAt,
      disconnectReason: state.disconnectReason,
    };
  };

  return createToolRegistry({
    ...createV1ToolHandlers(() => getConnection().db, getSessionConnectionState),
    ...createV2ToolHandlers(captureClient, () => getConnection().db, getSessionConnectionState),
  });
}

export function registerCliGateway(fastify: FastifyInstance, options: CliGatewayOptions): void {
  ensureCliToken();

  const loopGuard = createToolLoopGuard({
    getDb: () => getConnection().db,
    onEvent: (event) => {
      fastify.log.info(
        {
          component: 'cli-gateway',
          ...event,
        },
        `[CLI][Gateway] ${event.event}`,
      );
    },
  });

  fastify.get('/cli/tools', async () => {
    const tools = createCliToolRegistry(options);
    return {
      ok: true,
      tools: serializeTools(tools),
    };
  });

  fastify.get('/cli/agent-instructions', async () => {
    return {
      ok: true,
      instructions: getAgentInstructions(),
    };
  });

  fastify.post('/cli/tools/:toolName', async (request, reply) => {
    if (!requireCliAuthorization(request, reply)) {
      return reply;
    }

    const params = request.params as { toolName?: string };
    const toolName = params.toolName;
    if (!toolName) {
      return reply.code(400).send({ ok: false, error: 'toolName is required' });
    }

    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? request.body as Record<string, unknown>
      : {};
    const input = body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments)
      ? body.arguments
      : body;

    try {
      const response = await routeToolCall(createCliToolRegistry(options), toolName, input, { loopGuard });
      return {
        ok: true,
        toolName,
        response,
      };
    } catch (error) {
      return reply.code(400).send({
        ok: false,
        toolName,
        error: error instanceof Error ? error.message : 'CLI tool call failed',
      });
    }
  });
}
