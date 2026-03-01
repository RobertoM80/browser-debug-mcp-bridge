import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface ManagedServerProcess {
  readonly dataDir: string;
  readonly logs: string[];
  readonly port: number;
  stop(): Promise<void>;
}

export const REPO_ROOT = resolve(__dirname, '../../../../');
export const MCP_SERVER_MAIN = resolve(REPO_ROOT, 'apps/mcp-server/dist/main.js');
export const MCP_BRIDGE_MAIN = resolve(REPO_ROOT, 'apps/mcp-server/dist/mcp-bridge.js');
export const EXTENSION_DIST_DIR = resolve(REPO_ROOT, 'dist/apps/chrome-extension');

export function createTempDataDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export async function getFreePort(): Promise<number> {
  return await new Promise((resolvePort, rejectPort) => {
    const server = net.createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        rejectPort(new Error('Unable to allocate dynamic port'));
        return;
      }

      const port = address.port;
      server.close((error) => {
        if (error) {
          rejectPort(error);
          return;
        }
        resolvePort(port);
      });
    });
  });
}

async function isPortInUse(port: number): Promise<boolean> {
  return await new Promise((resolveInUse) => {
    const server = net.createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      resolveInUse(error.code === 'EADDRINUSE');
    });
    server.once('listening', () => {
      server.close(() => resolveInUse(false));
    });
    server.listen(port, '127.0.0.1');
  });
}

export async function waitForHealth(port = 8065, timeoutMs = 20_000): Promise<void> {
  const startedAt = Date.now();
  let lastError = 'health endpoint unavailable';

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        const payload = (await response.json()) as { status?: string };
        if (payload.status === 'ok') {
          return;
        }
      }
      lastError = `health status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }

  throw new Error(`Timed out waiting for health endpoint: ${lastError}`);
}

export async function startHttpServer(dataDir: string, port = 8065): Promise<ManagedServerProcess> {
  const logs: string[] = [];

  if (await isPortInUse(port)) {
    throw new Error(`Cannot start test server on ${port}: port already in use`);
  }

  const child = spawn(process.execPath, [MCP_SERVER_MAIN], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  pipeLogs(child, logs, '[mcp-server]');
  await waitForHealth(port);

  return {
    dataDir,
    logs,
    port,
    stop: () => stopChildProcess(child),
  };
}

function pipeLogs(child: ChildProcessWithoutNullStreams, logs: string[], prefix: string): void {
  const append = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
    logs.push(`${prefix}:${stream} ${chunk.toString('utf8')}`);
  };

  child.stdout.on('data', (chunk: Buffer) => append(chunk, 'stdout'));
  child.stderr.on('data', (chunk: Buffer) => append(chunk, 'stderr'));
}

async function stopChildProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  child.kill('SIGTERM');

  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
      resolveStop();
    }, 5_000);

    child.once('exit', () => {
      clearTimeout(timer);
      resolveStop();
    });
  });
}

export interface ExtensionContextHandle {
  context: BrowserContext;
  extensionId: string;
  close(): Promise<void>;
}

export async function launchExtensionContext(): Promise<ExtensionContextHandle> {
  const userDataDir = createTempDataDir('bdmcp-playwright-profile-');

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_DIST_DIR}`,
      `--load-extension=${EXTENSION_DIST_DIR}`,
    ],
  });

  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  }

  const extensionId = new URL(serviceWorker.url()).host;

  return {
    context,
    extensionId,
    close: async () => {
      await context.close();
    },
  };
}

export async function openExtensionPage(context: BrowserContext, extensionId: string, pagePath: 'popup.html' | 'db-viewer.html'): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${pagePath}`);
  return page;
}

export async function sendRuntimeMessage<T>(page: Page, message: unknown): Promise<T> {
  return page.evaluate(async (payload) => {
    return await new Promise((resolveResponse) => {
      chrome.runtime.sendMessage(payload, (response) => {
        resolveResponse(response);
      });
    });
  }, message) as Promise<T>;
}
