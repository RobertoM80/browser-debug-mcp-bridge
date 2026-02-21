import { pathToFileURL } from 'url';
import { createMCPServer, CaptureClientResult } from './mcp/server';
import type { WebSocketManager } from './websocket/websocket-server';

let stopServerFn: (() => void) | null = null;
let getWebSocketManager: (() => WebSocketManager | null) | null = null;

function ensureWebSocketManager() {
  if (!getWebSocketManager) {
    throw new Error('WebSocket manager resolver is not initialized yet.');
  }
  const manager = getWebSocketManager();
  if (!manager) {
    throw new Error('WebSocket manager is not initialized yet.');
  }
  return manager as {
    sendCaptureCommand: (
      sessionId: string,
      command: 'CAPTURE_DOM_SUBTREE' | 'CAPTURE_DOM_DOCUMENT' | 'CAPTURE_COMPUTED_STYLES' | 'CAPTURE_LAYOUT_METRICS' | 'CAPTURE_UI_SNAPSHOT',
      payload: Record<string, unknown>,
      timeoutMs?: number
    ) => Promise<CaptureClientResult>;
  };
}

async function bootstrapMainRuntime(): Promise<void> {
  process.env.MCP_STDIO_MODE = '1';
  const mainRuntime = await import('./main');
  await mainRuntime.startServer();
  stopServerFn = mainRuntime.stopServer;
  getWebSocketManager = () => mainRuntime.wsManager;
}

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

function shutdown(code = 0): void {
  stopServerFn?.();
  process.exit(code);
}

async function startBridge(): Promise<void> {
  await bootstrapMainRuntime();

  const runtime = createMCPServer(
    {},
    {
      captureClient: {
        execute: async (sessionId, command, payload, timeoutMs): Promise<CaptureClientResult> => {
          const manager = ensureWebSocketManager();
          return manager.sendCaptureCommand(sessionId, command, payload, timeoutMs);
        },
      },
    },
  );

  await runtime.start();
  writeStderr('[MCPServer][Bridge] MCP stdio connected; HTTP/WebSocket ingest active.');
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;

if (entryUrl && import.meta.url === entryUrl) {
  startBridge().catch((error) => {
    process.stderr.write(`[MCPServer][Bridge] Failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
    shutdown(1);
  });
}
