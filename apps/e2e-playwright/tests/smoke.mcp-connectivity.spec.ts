import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { createTempDataDir, getFreePort, REPO_ROOT } from './utils/runtime';
import { connectMcpClient, callToolJson } from './utils/mcp-client';

test.describe('@smoke mcp stdio connectivity', () => {
  test('initializes stdio bridge, exposes tools, and responds to query calls', async () => {
    const dataDir = createTempDataDir('bdmcp-e2e-smoke-mcp-data-');
    const port = await getFreePort();
    const mcp = await connectMcpClient(dataDir, { port });

    try {
      const tools = await mcp.client.listTools();
      const toolNames = tools.tools.map((tool) => tool.name).sort();
      expect(toolNames).toEqual(['browser_debug', 'list_sessions']);

      const discovery = await callToolJson<{
        tools: Array<{ name: string; inputSchema: object }>;
      }>(mcp.client, 'browser_debug', { query: 'page state' });

      expect(discovery.tools.some((tool) => tool.name === 'get_page_state')).toBe(true);

      const sessions = await callToolJson<{
        sessions: Array<{ sessionId: string }>;
        limitsApplied: { maxResults: number; truncated: boolean };
      }>(mcp.client, 'list_sessions', { limit: 10 });

      expect(Array.isArray(sessions.sessions)).toBe(true);
      expect(sessions.limitsApplied.maxResults).toBeGreaterThan(0);

      const cliEnv = {
        ...process.env,
        DATA_DIR: dataDir,
        PORT: String(port),
        HOST: '127.0.0.1',
      };
      const cliHealth = spawnSync(process.execPath, ['scripts/browser-debug-cli.cjs', 'health'], {
        cwd: REPO_ROOT,
        env: cliEnv,
        encoding: 'utf8',
      });
      expect(cliHealth.status, cliHealth.stderr).toBe(0);
      expect(cliHealth.stdout).toContain('Bridge: ok');

      const argsPath = join(dataDir, 'list-sessions-args.json');
      writeFileSync(argsPath, JSON.stringify({ limit: 10 }), 'utf8');
      const cliToolRun = spawnSync(
        process.execPath,
        ['scripts/browser-debug-cli.cjs', 'tool', 'run', 'list_sessions', '--args-file', argsPath, '--json'],
        {
          cwd: REPO_ROOT,
          env: cliEnv,
          encoding: 'utf8',
        },
      );
      expect(cliToolRun.status, cliToolRun.stderr).toBe(0);
      expect(JSON.parse(cliToolRun.stdout).sessions).toEqual([]);
    } finally {
      await mcp.close();
    }
  });
});
