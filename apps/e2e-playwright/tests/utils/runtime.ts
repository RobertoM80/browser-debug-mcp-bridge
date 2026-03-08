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
const EXTENSION_BOOT_TIMEOUT_MS = 60_000;
const RUNTIME_MESSAGE_TIMEOUT_MS = 10_000;
const RUNTIME_MESSAGE_MAX_ATTEMPTS = 8;
const TRUE_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);

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

async function waitForPortAvailable(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortInUse(port))) {
      return true;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  return !(await isPortInUse(port));
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
    const becameAvailable = await waitForPortAvailable(port, 5_000);
    if (!becameAvailable) {
      throw new Error(`Cannot start test server on ${port}: port is still in use after waiting 5000ms`);
    }
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

export function getServerBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
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

function isIgnorablePlaywrightArtifactCloseError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes('ENOENT')
    && error.message.includes('playwright-artifacts');
}

function shouldRunHeaded(): boolean {
  const raw = process.env.BDMCP_E2E_HEADED;
  if (!raw) {
    return false;
  }
  return TRUE_ENV_VALUES.has(raw.toLowerCase());
}

export async function launchExtensionContext(): Promise<ExtensionContextHandle> {
  const userDataDir = createTempDataDir('bdmcp-playwright-profile-');

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !shouldRunHeaded(),
    args: [
      `--disable-extensions-except=${EXTENSION_DIST_DIR}`,
      `--load-extension=${EXTENSION_DIST_DIR}`,
    ],
  });

  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker', { timeout: EXTENSION_BOOT_TIMEOUT_MS });
  }

  const extensionId = new URL(serviceWorker.url()).host;

  return {
    context,
    extensionId,
    close: async () => {
      try {
        await context.close();
      } catch (error) {
        if (!isIgnorablePlaywrightArtifactCloseError(error)) {
          throw error;
        }
      }
    },
  };
}

export async function openExtensionPage(context: BrowserContext, extensionId: string, pagePath: 'popup.html' | 'db-viewer.html'): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${pagePath}`, { waitUntil: 'domcontentloaded' });
  if (pagePath === 'popup.html') {
    await page.locator('#start-session').waitFor({ state: 'visible', timeout: EXTENSION_BOOT_TIMEOUT_MS });
  } else {
    await page.locator('#entries-status').waitFor({ state: 'visible', timeout: EXTENSION_BOOT_TIMEOUT_MS });
  }
  return page;
}

export async function sendRuntimeMessage<T>(page: Page, message: unknown): Promise<T> {
  for (let attempt = 1; attempt <= RUNTIME_MESSAGE_MAX_ATTEMPTS; attempt += 1) {
    const envelope = await page.evaluate(
      async ({ payload, timeoutMs }) => {
        return await new Promise<{ response: unknown; runtimeError: string | null; timedOut: boolean }>((resolveResponse) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) {
              return;
            }
            settled = true;
            resolveResponse({ response: undefined, runtimeError: null, timedOut: true });
          }, timeoutMs);

          chrome.runtime.sendMessage(payload, (response) => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timer);
            resolveResponse({
              response,
              runtimeError: chrome.runtime.lastError?.message ?? null,
              timedOut: false,
            });
          });
        });
      },
      { payload: message, timeoutMs: RUNTIME_MESSAGE_TIMEOUT_MS },
    );

    if (!envelope.timedOut && !envelope.runtimeError) {
      return envelope.response as T;
    }

    const messageText = envelope.timedOut
      ? 'Timed out waiting for chrome.runtime.sendMessage response'
      : (envelope.runtimeError ?? 'Unknown runtime messaging error');
    const transient = /Receiving end does not exist|The message port closed before a response was received|Extension context invalidated/i
      .test(messageText);

    if (!transient || attempt === RUNTIME_MESSAGE_MAX_ATTEMPTS) {
      throw new Error(`Runtime message failed after ${attempt} attempt(s): ${messageText}`);
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250 * attempt));
  }

  throw new Error('Runtime message failed unexpectedly');
}

export async function setExtensionServerBaseUrl(page: Page, serverBaseUrl: string | null): Promise<void> {
  await sendRuntimeMessage(page, {
    type: 'TEST_SET_SERVER_BASE_URL',
    serverBaseUrl,
  });
}
