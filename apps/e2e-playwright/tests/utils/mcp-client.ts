import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Stream } from 'node:stream';
import { MCP_BRIDGE_MAIN, REPO_ROOT } from './runtime';

export interface MCPClientHandle {
  client: Client;
  transport: StdioClientTransport;
  stderrLogs: string[];
  close(): Promise<void>;
}

function makeStringEnv(base: NodeJS.ProcessEnv, overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(base)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }

  return {
    ...env,
    ...overrides,
  };
}

export async function connectMcpClient(
  dataDir: string,
  options: { port?: number } = {},
): Promise<MCPClientHandle> {
  const port = options.port ?? 8065;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_BRIDGE_MAIN],
    cwd: REPO_ROOT,
    env: makeStringEnv(process.env, {
      DATA_DIR: dataDir,
      PORT: String(port),
      HOST: '127.0.0.1',
      MCP_STARTUP_TIMEOUT_MS: '30000',
    }),
    stderr: 'pipe',
  });

  const stderrLogs: string[] = [];
  const stderr = transport.stderr as Stream | null;
  if (stderr) {
    stderr.on('data', (chunk) => {
      stderrLogs.push(chunk.toString());
    });
  }

  const client = new Client({
    name: 'browser-debug-mcp-e2e',
    version: '1.0.0',
  });

  await client.connect(transport);

  return {
    client,
    transport,
    stderrLogs,
    close: async () => {
      await transport.close();
    },
  };
}

export interface ToolCallResult {
  isError: boolean;
  text: string;
}

export async function callToolText(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const result = await client.callTool({
    name,
    arguments: args,
  });

  const content = Array.isArray(result.content) ? result.content : [];
  const textPart = content.find((entry): entry is { type: 'text'; text: string } => {
    return Boolean(entry) && typeof entry === 'object' && entry.type === 'text' && typeof entry.text === 'string';
  });

  return {
    isError: result.isError === true,
    text: textPart?.text ?? '',
  };
}

export async function callToolJson<T = Record<string, unknown>>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await callToolText(client, name, args);
  if (result.isError) {
    throw new Error(`Tool ${name} failed: ${result.text}`);
  }

  try {
    return JSON.parse(result.text) as T;
  } catch {
    throw new Error(`Tool ${name} returned non-JSON payload: ${result.text}`);
  }
}

export const EXPECTED_TOOL_NAMES = [
  'list_sessions',
  'get_session_summary',
  'get_recent_events',
  'get_navigation_history',
  'get_console_events',
  'get_console_summary',
  'get_event_summary',
  'get_error_fingerprints',
  'get_network_failures',
  'get_network_calls',
  'wait_for_network_call',
  'get_request_trace',
  'get_body_chunk',
  'get_element_refs',
  'get_dom_subtree',
  'get_dom_document',
  'get_computed_styles',
  'get_layout_metrics',
  'capture_ui_snapshot',
  'get_live_console_logs',
  'explain_last_failure',
  'get_event_correlation',
  'list_snapshots',
  'get_snapshot_for_event',
  'get_snapshot_asset',
] as const;
