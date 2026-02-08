import { describe, expect, it } from 'vitest';
import {
  createMCPServer,
  createToolRegistry,
  routeToolCall,
  type ToolHandler,
} from './server.js';

describe('mcp/server foundation', () => {
  it('creates MCP runtime with stdio transport', () => {
    const runtime = createMCPServer();

    expect(runtime.server).toBeDefined();
    expect(runtime.transport).toBeDefined();
    expect(runtime.tools.length).toBeGreaterThan(0);
  });

  it('registers known tools with input schemas', () => {
    const tools = createToolRegistry();
    const listSessions = tools.find((tool) => tool.name === 'list_sessions');

    expect(listSessions).toBeDefined();
    expect(listSessions?.inputSchema).toMatchObject({ type: 'object' });
  });

  it('routes a tool call to custom handler', async () => {
    const handler: ToolHandler = async (input) => ({
      sessionId: typeof input.sessionId === 'string' ? input.sessionId : undefined,
      limitsApplied: {
        maxResults: 25,
        truncated: false,
      },
      redactionSummary: {
        totalFields: 2,
        redactedFields: 1,
        rulesApplied: ['token'],
      },
      ok: true,
    });
    const tools = createToolRegistry({ list_sessions: handler });

    const response = await routeToolCall(tools, 'list_sessions', { sessionId: 's-1' });

    expect(response.ok).toBe(true);
    expect(response.sessionId).toBe('s-1');
    expect(response.limitsApplied.maxResults).toBe(25);
    expect(response.redactionSummary.redactedFields).toBe(1);
  });

  it('returns default response contract for unimplemented tools', async () => {
    const tools = createToolRegistry();
    const response = await routeToolCall(tools, 'get_network_failures', { sessionId: 's-2' });

    expect(response.sessionId).toBe('s-2');
    expect(response.limitsApplied).toEqual({ maxResults: 0, truncated: false });
    expect(response.redactionSummary).toEqual({
      totalFields: 0,
      redactedFields: 0,
      rulesApplied: [],
    });
  });

  it('throws on unknown tools', async () => {
    const tools = createToolRegistry();

    await expect(routeToolCall(tools, 'does_not_exist', {})).rejects.toThrow('Unknown tool');
  });
});
