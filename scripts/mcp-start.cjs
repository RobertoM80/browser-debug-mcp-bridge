#!/usr/bin/env node
const { spawn, spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, openSync, writeFileSync, closeSync, readFileSync, unlinkSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { createRequire } = require('node:module');
const net = require('node:net');
const http = require('node:http');

const repoRoot = resolve(__dirname, '..');
const packageJson = join(repoRoot, 'package.json');
const mcpBridgeDistEntry = join(repoRoot, 'apps', 'mcp-server', 'dist', 'mcp-bridge.js');
const mainServerDistEntry = join(repoRoot, 'apps', 'mcp-server', 'dist', 'main.js');
const mcpBridgeEntry = join(repoRoot, 'apps', 'mcp-server', 'src', 'mcp-bridge.ts');
const mainServerEntry = join(repoRoot, 'apps', 'mcp-server', 'src', 'main.ts');
const args = process.argv.slice(2);
const useTsx = args.includes('--mode=tsx');
const useDist = args.includes('--mode=dist');
const dryRun = args.includes('--dry-run');
const standalone = args.includes('--standalone');
const stopRequested = args.includes('--stop');
const localRequire = createRequire(join(repoRoot, 'package.json'));
const supportsColor = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
const greenBackground = '\x1b[42m\x1b[30m';
const ansiReset = '\x1b[0m';
const launchLockPath = join(process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(repoRoot, 'data'), '.mcp-start.lock');

let launchLockHeld = false;

function resolveRuntimePath(specifier) {
  try {
    return localRequire.resolve(specifier);
  } catch {
    return '';
  }
}

function resolveFromPackage(packageName, relativePath) {
  const packageJsonPath = resolveRuntimePath(`${packageName}/package.json`);
  if (!packageJsonPath) return '';
  const candidate = join(dirname(packageJsonPath), relativePath);
  return existsSync(candidate) ? candidate : '';
}

function resolveBinFallback(name) {
  const cmdSuffix = process.platform === 'win32' ? '.cmd' : '';
  const candidate = join(repoRoot, 'node_modules', '.bin', `${name}${cmdSuffix}`);
  return existsSync(candidate) ? candidate : '';
}

const nxBin =
  resolveRuntimePath('nx/bin/nx.js') ||
  resolveFromPackage('nx', 'bin/nx.js') ||
  resolveBinFallback('nx');

const tsxCli =
  resolveRuntimePath('tsx/dist/cli.mjs') ||
  resolveFromPackage('tsx', 'dist/cli.mjs') ||
  resolveBinFallback('tsx');

function isPortInUse(port, host = '127.0.0.1') {
  return new Promise((resolvePort) => {
    const server = net.createServer();
    server.once('error', (error) => {
      if (error && error.code === 'EADDRINUSE') {
        resolvePort(true);
        return;
      }
      resolvePort(false);
    });
    server.once('listening', () => {
      server.close(() => resolvePort(false));
    });
    server.listen(port, host);
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function parseLockPayload(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readLaunchLock(lockPath) {
  try {
    const raw = readFileSync(lockPath, 'utf8');
    return parseLockPayload(raw);
  } catch {
    return null;
  }
}

function acquireLaunchLock(lockPath) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const payload = JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
    command: process.argv.join(' '),
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeFileSync(fd, payload, 'utf8');
      } finally {
        closeSync(fd);
      }
      launchLockHeld = true;
      return;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw error;
      }

      const existing = readLaunchLock(lockPath);
      const lockPid = Number(existing && existing.pid);
      if (Number.isInteger(lockPid) && lockPid > 0 && lockPid !== process.pid && isProcessAlive(lockPid)) {
        process.stderr.write(
          `[mcp-start] MCP_STARTUP_LOCKED: another launcher instance (pid ${lockPid}) is already running.\n`,
        );
        process.stderr.write('[mcp-start] If startup appears stuck, run: node scripts/mcp-start.cjs --stop\n');
        process.exit(1);
      }

      try {
        unlinkSync(lockPath);
      } catch (unlinkError) {
        if (!unlinkError || unlinkError.code !== 'ENOENT') {
          process.stderr.write(
            `[mcp-start] MCP_STARTUP_LOCK_FAILED: unable to clear stale lock at ${lockPath}.\n`,
          );
          process.exit(1);
        }
      }
    }
  }

  process.stderr.write(`[mcp-start] MCP_STARTUP_LOCK_FAILED: unable to acquire startup lock at ${lockPath}.\n`);
  process.exit(1);
}

function releaseLaunchLock(lockPath) {
  if (!launchLockHeld) {
    return;
  }

  try {
    const existing = readLaunchLock(lockPath);
    const lockPid = Number(existing && existing.pid);
    if (Number.isInteger(lockPid) && lockPid > 0 && lockPid !== process.pid) {
      launchLockHeld = false;
      return;
    }
    unlinkSync(lockPath);
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      process.stderr.write(`[mcp-start] Warning: failed to release startup lock ${lockPath}.\n`);
    }
  } finally {
    launchLockHeld = false;
  }
}

function getStartupTimeoutMs() {
  const timeoutMs = Number(process.env.MCP_STARTUP_TIMEOUT_MS || '15000');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
    return 15000;
  }
  return Math.floor(timeoutMs);
}

function fetchJson(pathname, port, timeoutMs = 1000) {
  return new Promise((resolveJson) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'GET',
        timeout: timeoutMs,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolveJson(payload);
          } catch {
            resolveJson(null);
          }
        });
      },
    );
    request.on('error', () => resolveJson(null));
    request.on('timeout', () => {
      request.destroy();
      resolveJson(null);
    });
    request.end();
  });
}

async function isBridgeHttpEndpoint(port) {
  const root = await fetchJson('/', port);
  if (root && typeof root === 'object' && typeof root.name === 'string' && root.name.includes('Browser Debug MCP Bridge')) {
    return true;
  }

  const health = await fetchJson('/health', port);
  return Boolean(health && typeof health === 'object' && health.status === 'ok' && health.websocket);
}

function getWindowsListeningPids(port) {
  const result = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
  if (result.status !== 0) {
    return [];
  }

  const targetSuffix = `:${port}`;
  const pids = new Set();
  const lines = String(result.stdout || '').split(/\r?\n/u);

  for (const line of lines) {
    const parts = line.trim().split(/\s+/u);
    if (parts.length < 5) {
      continue;
    }

    const proto = String(parts[0] || '').toUpperCase();
    const localAddress = String(parts[1] || '');
    const state = String(parts[3] || '').toUpperCase();
    const pid = Number(parts[4]);

    if (proto === 'TCP' && state === 'LISTENING' && localAddress.endsWith(targetSuffix) && Number.isInteger(pid) && pid > 0) {
      pids.add(pid);
    }
  }

  return Array.from(pids);
}

function getWindowsProcessCommandLine(pid) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`],
    { encoding: 'utf8' },
  );

  if (result.status !== 0) {
    return '';
  }

  return String(result.stdout || '').trim();
}

function isLikelyBridgeCommandLine(commandLine) {
  const normalized = String(commandLine || '').toLowerCase();
  return normalized.includes('scripts\\mcp-start.cjs')
    || normalized.includes('scripts/mcp-start.cjs')
    || normalized.includes('mcp-bridge.js')
    || normalized.includes('mcp-bridge.ts')
    || normalized.includes('mcp-server:serve-mcp')
    || normalized.includes('browser-debug-mcp-bridge.cmd');
}

function killWindowsProcess(pid) {
  const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' });
  return result.status === 0;
}

function getPosixListeningPids(port) {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return [];
  }

  return String(result.stdout || '')
    .split(/\r?\n/u)
    .map((value) => Number(value.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function getListeningPids(port) {
  return process.platform === 'win32' ? getWindowsListeningPids(port) : getPosixListeningPids(port);
}

function getPosixProcessCommandLine(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return '';
  }
  return String(result.stdout || '').trim();
}

function getProcessCommandLine(pid) {
  return process.platform === 'win32' ? getWindowsProcessCommandLine(pid) : getPosixProcessCommandLine(pid);
}

function terminateProcess(pid) {
  if (process.platform === 'win32') {
    return killWindowsProcess(pid);
  }

  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

async function tryRecoverStaleBridgeOnWindowsPort(port) {
  if (process.platform !== 'win32') {
    return false;
  }

  const endpointLooksLikeBridge = await isBridgeHttpEndpoint(port);
  const listenerPids = getWindowsListeningPids(port).filter((pid) => pid !== process.pid);
  if (listenerPids.length === 0) {
    return false;
  }

  let attemptedRestart = false;
  for (const pid of listenerPids) {
    const commandLine = getWindowsProcessCommandLine(pid);
    const looksLikeBridge = endpointLooksLikeBridge || isLikelyBridgeCommandLine(commandLine);
    if (!looksLikeBridge) {
      continue;
    }

    attemptedRestart = true;
    process.stderr.write(
      `[mcp-start] Port ${port} is occupied by stale bridge process (pid ${pid}). Restarting automatically.\n`,
    );

    if (!killWindowsProcess(pid)) {
      process.stderr.write(`[mcp-start] Failed to terminate stale process ${pid}.\n`);
    }
  }

  if (!attemptedRestart) {
    return false;
  }

  for (let attempt = 0; attempt < 12; attempt++) {
    await delay(200);
    const stillInUse = await isPortInUse(port);
    if (!stillInUse) {
      process.stderr.write(`[mcp-start] Recovered port ${port} from stale bridge instance.\n`);
      return true;
    }
  }

  return false;
}

async function waitForBridgeReady(port, child) {
  const timeoutMs = getStartupTimeoutMs();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      return {
        ok: false,
        reason: `MCP bridge exited during startup with code ${child.exitCode}.`,
      };
    }

    const health = await fetchJson('/health', port, 1000);
    if (health && typeof health === 'object' && health.status === 'ok' && health.websocket) {
      return { ok: true };
    }

    await delay(200);
  }

  return {
    ok: false,
    reason: `Timed out after ${timeoutMs}ms waiting for /health on 127.0.0.1:${port}.`,
  };
}

async function stopBridgeOnPort(port) {
  const listenerPids = getListeningPids(port).filter((pid) => pid !== process.pid);
  if (listenerPids.length === 0) {
    const inUse = await isPortInUse(port);
    if (!inUse) {
      process.stderr.write(`[mcp-start] MCP_STOP_NO_ACTIVE_PROCESS: no listener found on port ${port}.\n`);
      process.exit(0);
    }

    process.stderr.write(
      `[mcp-start] MCP_STOP_FAILED: port ${port} is in use but listener process could not be resolved on ${process.platform}.\n`,
    );
    process.exit(1);
  }

  const endpointLooksLikeBridge = await isBridgeHttpEndpoint(port);
  const bridgePids = [];
  const nonBridgePids = [];

  for (const pid of listenerPids) {
    const commandLine = getProcessCommandLine(pid);
    const looksLikeBridge = endpointLooksLikeBridge || isLikelyBridgeCommandLine(commandLine);
    if (looksLikeBridge) {
      bridgePids.push({ pid, commandLine });
      continue;
    }
    nonBridgePids.push({ pid, commandLine });
  }

  if (bridgePids.length === 0) {
    process.stderr.write(
      `[mcp-start] MCP_STOP_PORT_OCCUPIED_BY_OTHER_APP: port ${port} is not owned by Browser Debug MCP Bridge.\n`,
    );
    for (const proc of nonBridgePids) {
      process.stderr.write(
        `[mcp-start] Occupant pid=${proc.pid}${proc.commandLine ? ` cmd=${proc.commandLine}` : ''}\n`,
      );
    }
    process.exit(1);
  }

  let stopFailed = false;
  for (const proc of bridgePids) {
    process.stderr.write(`[mcp-start] Stopping Browser Debug MCP Bridge process ${proc.pid} on port ${port}.\n`);
    if (!terminateProcess(proc.pid)) {
      process.stderr.write(`[mcp-start] Failed to terminate process ${proc.pid}.\n`);
      stopFailed = true;
    }
  }

  if (stopFailed) {
    process.stderr.write('[mcp-start] MCP_STOP_FAILED: one or more processes could not be terminated.\n');
    process.exit(1);
  }

  for (let attempt = 0; attempt < 15; attempt++) {
    await delay(200);
    const remainingListeners = getListeningPids(port).filter((pid) => pid !== process.pid);
    if (remainingListeners.length === 0) {
      process.stderr.write(`[mcp-start] MCP_STOP_SUCCESS: Browser Debug MCP Bridge stopped on port ${port}.\n`);
      process.exit(0);
    }
  }

  process.stderr.write(
    `[mcp-start] MCP_STOP_FAILED: process termination requested but port ${port} is still in use.\n`,
  );
  process.exit(1);
}

if (!existsSync(packageJson)) {
  process.stderr.write(`[mcp-start] Invalid repository root: ${repoRoot}\n`);
  process.exit(1);
}

async function spawnRuntime(runtime, port) {
  const nxTarget = standalone ? 'mcp-server:serve' : 'mcp-server:serve-mcp';
  const entryScript =
    runtime === 'dist'
      ? standalone
        ? mainServerDistEntry
        : mcpBridgeDistEntry
      : standalone
        ? mainServerEntry
        : mcpBridgeEntry;

  if (dryRun) {
    process.stderr.write(`[mcp-start] Dry run mode. Selected runtime: ${runtime}\n`);
    if (runtime === 'nx') {
      process.stderr.write(`[mcp-start] Command: node ${nxBin} run ${nxTarget}\n`);
    } else if (runtime === 'dist') {
      process.stderr.write(`[mcp-start] Command: node ${entryScript}\n`);
    } else {
      process.stderr.write(`[mcp-start] Command: node ${tsxCli} ${entryScript}\n`);
    }
    process.exit(0);
  }

  const child =
    runtime === 'nx'
      ? spawn(
          nxBin.endsWith('.cmd') ? nxBin : process.execPath,
          nxBin.endsWith('.cmd') ? ['run', nxTarget] : [nxBin, 'run', nxTarget],
          {
            cwd: repoRoot,
            env: { ...process.env },
            stdio: 'inherit',
          },
        )
      : runtime === 'dist'
        ? spawn(process.execPath, [entryScript], {
            cwd: repoRoot,
            env: { ...process.env },
            stdio: 'inherit',
          })
        : spawn(
            tsxCli.endsWith('.cmd') ? tsxCli : process.execPath,
            tsxCli.endsWith('.cmd') ? [entryScript] : [tsxCli, entryScript],
            {
              cwd: repoRoot,
              env: { ...process.env },
              stdio: 'inherit',
            },
          );

  let startupFinished = false;

  const forwardSignalToChild = (signal) => {
    if (child.exitCode !== null || child.killed) {
      return;
    }

    try {
      child.kill(signal);
    } catch {
      // Ignore signal forwarding failures when child is already terminating.
    }
  };

  process.on('SIGINT', () => forwardSignalToChild('SIGINT'));
  process.on('SIGTERM', () => forwardSignalToChild('SIGTERM'));
  if (process.platform !== 'win32') {
    process.on('SIGHUP', () => forwardSignalToChild('SIGHUP'));
  }

  process.on('exit', () => {
    if (child.exitCode === null && !child.killed) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore failures during process exit.
      }
    }
  });

  if (!standalone) {
    const shutdownFromHostDisconnect = () => {
      process.stderr.write('[mcp-start] MCP host disconnected; stopping MCP bridge child process.\n');
      forwardSignalToChild('SIGTERM');
    };

    process.stdin.on('end', shutdownFromHostDisconnect);
    process.stdin.on('close', shutdownFromHostDisconnect);
    process.on('disconnect', shutdownFromHostDisconnect);
  }

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    if (!startupFinished) {
      process.stderr.write(
        `[mcp-start] MCP_STARTUP_FAILED: MCP bridge exited before readiness check completed (code ${code ?? 0}).\n`,
      );
    }
    if (!standalone && process.stdin.isTTY && (code ?? 0) === 0) {
      process.stderr.write(
        '[mcp-start] MCP stdio process exited (no MCP host attached). ' +
        'Use --standalone to keep the local server running in a terminal.\n',
      );
    }
    process.exit(code ?? 0);
  });

  child.on('error', (error) => {
    process.stderr.write(
      `[mcp-start] Failed to launch MCP bridge with ${runtime}. ` +
      `Ensure dependencies are installed. ${error.message}\n`,
    );
    process.exit(1);
  });

  const readiness = await waitForBridgeReady(port, child);
  if (!readiness.ok) {
    process.stderr.write(`[mcp-start] MCP_STARTUP_FAILED: ${readiness.reason}\n`);
    forwardSignalToChild('SIGTERM');
    process.exit(1);
  }

  startupFinished = true;
  const startedMessage = standalone
    ? `[mcp-start] Started Browser Debug MCP Bridge (runtime: ${runtime}, mode: standalone). Keep this terminal open.`
    : `[mcp-start] Started Browser Debug MCP Bridge (runtime: ${runtime}, mode: mcp-stdio).`;
  process.stderr.write(`${supportsColor ? `${greenBackground}${startedMessage}${ansiReset}` : startedMessage}\n`);
  if (!standalone && process.stdin.isTTY) {
    process.stderr.write(
      '[mcp-start] Running from interactive terminal without MCP host. ' +
      'Use --standalone for manual keep-alive testing.\n',
    );
  }
}

async function main() {
  const port = Number(process.env.PORT || '8065');
  if (!Number.isFinite(port) || port <= 0) {
    process.stderr.write(`[mcp-start] Invalid PORT value: ${String(process.env.PORT || '')}\n`);
    process.exit(1);
  }

  if (stopRequested) {
    await stopBridgeOnPort(port);
    return;
  }

  if (!dryRun) {
    acquireLaunchLock(launchLockPath);
    process.on('exit', () => releaseLaunchLock(launchLockPath));
  }

  if (Number.isFinite(port)) {
    let inUse = await isPortInUse(port);
    if (inUse) {
      const recovered = await tryRecoverStaleBridgeOnWindowsPort(port);
      if (recovered) {
        inUse = await isPortInUse(port);
      }
    }

    if (inUse) {
      process.stderr.write(
        `[mcp-start] MCP_STARTUP_PORT_IN_USE: required MCP port ${port} is already in use.\n`,
      );
      process.stderr.write(
        `[mcp-start] Reserve port ${port} for Browser Debug MCP Bridge: stop the process currently using it, then start the bridge again.\n`,
      );
      process.stderr.write(
        '[mcp-start] The bridge cannot start until the configured MCP port is free.\n',
      );
      if (process.platform === 'win32') {
        process.stderr.write(
          `[mcp-start] Windows help: netstat -ano | findstr :${port}\n`,
        );
      }
      process.exit(1);
    }
  }

  if (useDist) {
    if (!existsSync(mcpBridgeDistEntry) || !existsSync(mainServerDistEntry)) {
      process.stderr.write(
        '[mcp-start] Missing dist runtime. Build mcp-server first (pnpm nx build mcp-server).\n',
      );
      process.exit(1);
    }
    await spawnRuntime('dist', port);
    return;
  }

  if (useTsx) {
    if (!existsSync(tsxCli)) {
      process.stderr.write('[mcp-start] Missing tsx runtime. Run npm install/pnpm install first.\n');
      process.exit(1);
    }
    await spawnRuntime('tsx', port);
    return;
  }

  if (existsSync(mcpBridgeDistEntry) && existsSync(mainServerDistEntry)) {
    await spawnRuntime('dist', port);
    return;
  }

  if (existsSync(nxBin)) {
    await spawnRuntime('nx', port);
    return;
  }

  if (!existsSync(tsxCli)) {
    process.stderr.write(
      '[mcp-start] Missing both nx and tsx runtimes. ' +
      'Install dependencies first (npm install or pnpm install).\n',
    );
    process.exit(1);
  }

  process.stderr.write('[mcp-start] nx runtime not found, using tsx fallback runtime.\n');
  await spawnRuntime('tsx', port);
}

main().catch((error) => {
  process.stderr.write(`[mcp-start] Startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
