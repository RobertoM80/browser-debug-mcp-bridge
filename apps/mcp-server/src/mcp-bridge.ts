import { pathToFileURL } from 'url';
import { createMCPServer, CaptureClientResult } from './mcp/server.js';
import type { WebSocketManager } from './websocket/websocket-server.js';

let stopServerFn: (() => void) | null = null;
let getWebSocketManager: (() => WebSocketManager | null) | null = null;
let isShuttingDown = false;

function ensureWebSocketManager(): WebSocketManager {
  if (!getWebSocketManager) {
    throw new Error('WebSocket manager resolver is not initialized yet.');
  }
  const manager = getWebSocketManager();
  if (!manager) {
    throw new Error('WebSocket manager is not initialized yet.');
  }
  return manager;
}

async function bootstrapMainRuntime(): Promise<void> {
  process.env.MCP_STDIO_MODE = '1';
  const mainRuntime = await import('./main.js');
  await mainRuntime.startServer();
  stopServerFn = mainRuntime.stopServer;
  getWebSocketManager = () => mainRuntime.wsManager;
}

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

function shutdown(code = 0, reason?: string): void {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  if (reason) {
    writeStderr(`[MCPServer][Bridge] ${reason}`);
  }
  stopServerFn?.();
  process.exit(code);
}

function registerLifecycleGuards(): void {
  process.on('SIGINT', () => shutdown(0, 'Received SIGINT.'));
  process.on('SIGTERM', () => shutdown(0, 'Received SIGTERM.'));
  if (process.platform !== 'win32') {
    process.on('SIGHUP', () => shutdown(0, 'Received SIGHUP.'));
  }

  const shutdownFromHostDisconnect = (source: string): void => {
    shutdown(0, `Host transport closed (${source}); stopping MCP bridge.`);
  };

  process.stdin.on('end', () => shutdownFromHostDisconnect('stdin-end'));
  process.stdin.on('close', () => shutdownFromHostDisconnect('stdin-close'));
  process.on('disconnect', () => shutdownFromHostDisconnect('parent-disconnect'));
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
      getSessionConnectionState: (sessionId) => {
        const manager = ensureWebSocketManager();
        const state = manager.getSessionConnectionState(sessionId);
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
      },
    },
  );

  await runtime.start();
  writeStderr('[MCPServer][Bridge] Ready: MCP stdio connected and HTTP/WebSocket ingest is active.');
  writeStderr('[MCPServer][Bridge] Health check: http://127.0.0.1:8065/health');
  writeStderr('[MCPServer][Bridge] Next steps:');
  writeStderr('[MCPServer][Bridge] 1) Start a session in the Chrome extension');
  writeStderr('[MCPServer][Bridge] 2) Ask your MCP client to call list_sessions');
}

registerLifecycleGuards();

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;

if (entryUrl && import.meta.url === entryUrl) {
  startBridge().catch((error) => {
    process.stderr.write(`[MCPServer][Bridge] Failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
    shutdown(1);
  });
}
