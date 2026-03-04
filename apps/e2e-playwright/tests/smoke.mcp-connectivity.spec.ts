import { expect, test } from '@playwright/test';
import { createTempDataDir, getFreePort } from './utils/runtime';
import { connectMcpClient, EXPECTED_TOOL_NAMES, callToolJson } from './utils/mcp-client';

test.describe('@smoke mcp stdio connectivity', () => {
  test('initializes stdio bridge, exposes tools, and responds to query calls', async () => {
    const dataDir = createTempDataDir('bdmcp-e2e-smoke-mcp-data-');
    const port = await getFreePort();
    const mcp = await connectMcpClient(dataDir, { port });

    try {
      const tools = await mcp.client.listTools();
      const toolNames = tools.tools.map((tool) => tool.name).sort();
      expect(toolNames).toEqual([...EXPECTED_TOOL_NAMES].sort());

      const sessions = await callToolJson<{
        sessions: Array<{ sessionId: string }>;
        limitsApplied: { maxResults: number; truncated: boolean };
      }>(mcp.client, 'list_sessions', { limit: 10 });

      expect(Array.isArray(sessions.sessions)).toBe(true);
      expect(sessions.limitsApplied.maxResults).toBeGreaterThan(0);
    } finally {
      await mcp.close();
    }
  });
});
