#!/usr/bin/env node
import { access, readFile } from 'fs/promises';
import os from 'os';
import { resolve } from 'path';
import { spawn } from 'child_process';

const repoRoot = resolve(process.cwd());
const bridgeBaseUrl = process.env.BROWSER_DEBUG_BRIDGE_URL || 'http://127.0.0.1:8065';
const healthUrl = `${bridgeBaseUrl}/health`;
const statsUrl = `${bridgeBaseUrl}/stats`;
const sessionsUrl = `${bridgeBaseUrl}/sessions?limit=10&offset=0`;
const bridgePort = Number(new URL(bridgeBaseUrl).port || '8065');
const args = new Set(process.argv.slice(2));
const jsonMode = args.has('--json');
const smokeMode = args.has('--smoke');
const startupTimeoutMs = Number(process.env.MCP_DIAGNOSE_STARTUP_TIMEOUT_MS || '12000');

const codexConfigCandidates = [
  resolve(repoRoot, '.codex/config.toml'),
  resolve(os.homedir(), '.codex/config.toml'),
];

function color(text, code) {
  return process.stdout.isTTY && !jsonMode ? `\u001b[${code}m${text}\u001b[0m` : text;
}

function formatState(state) {
  if (state === 'OK') return color(state, '32');
  if (state === 'WARN') return color(state, '33');
  if (state === 'FAIL') return color(state, '31');
  return color(state, '36');
}

function printSection(title) {
  if (!jsonMode) {
    console.log(`\n${title}`);
  }
}

function printStatus(item) {
  if (jsonMode) {
    return;
  }
  console.log(`- ${item.name}: ${formatState(item.state)}`);
  console.log(`  ${item.summary}`);
  if (item.evidence?.length) {
    console.log('  Evidence:');
    for (const line of item.evidence) {
      console.log(`  - ${line}`);
    }
  }
  if (item.fixes?.length) {
    console.log('  Fix commands:');
    for (const fix of item.fixes) {
      console.log(`  - ${fix}`);
    }
  }
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function runNodeScript(nodeArgs, timeoutMs = 15000) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, nodeArgs, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      resolvePromise({
        ok: false,
        code: null,
        stdout,
        stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`.trim(),
        timedOut,
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({
        ok: code === 0 && !timedOut,
        code,
        signal,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

async function fetchJson(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      text,
      json,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      text: '',
      json: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function detectCodexConfig() {
  let firstConfig = null;
  for (const candidate of codexConfigCandidates) {
    if (!(await fileExists(candidate))) {
      continue;
    }
    const content = await readFile(candidate, 'utf8');
    const hasServerBlock = /\[mcp_servers\.browser_debug\]/.test(content);
    const hasLauncher = /scripts[\\/]+mcp-start\.cjs/.test(content) || /browser-debug-mcp-bridge/.test(content);
    const result = {
      path: candidate,
      hasServerBlock,
      hasLauncher,
    };
    if (hasServerBlock) {
      return result;
    }
    if (!firstConfig) {
      firstConfig = result;
    }
  }
  return firstConfig;
}

function getWebsocketActiveSessions(payload) {
  const value = payload?.websocket?.activeSessions;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return null;
}

function summarizeLiveSessions(sessionsPayload, healthPayload, statsPayload) {
  const sessionRows = Array.isArray(sessionsPayload?.sessions) ? sessionsPayload.sessions : [];
  const liveSessions = sessionRows.filter((session) => session?.liveConnection?.connected === true);
  const activeSessionsFromHealth = getWebsocketActiveSessions(healthPayload);
  const activeSessionsFromStats = getWebsocketActiveSessions(statsPayload);
  const fallbackActiveSessions = Math.max(activeSessionsFromHealth ?? 0, activeSessionsFromStats ?? 0);

  return {
    total: sessionRows.length,
    live: liveSessions.length,
    fallbackLive: liveSessions.length === 0 && fallbackActiveSessions > 0,
    fallbackActiveSessions,
    activeSessionsFromHealth,
    activeSessionsFromStats,
    firstLiveUrl: liveSessions[0]?.url ?? liveSessions[0]?.urlLast ?? sessionRows[0]?.url ?? sessionRows[0]?.urlLast ?? null,
  };
}

async function getPortListeners(port) {
  const command = process.platform === 'win32'
    ? `netstat -ano | findstr :${port}`
    : `sh -lc "netstat -an 2>/dev/null | grep :${port} || ss -ltnp 2>/dev/null | grep :${port} || lsof -iTCP:${port} -sTCP:LISTEN 2>/dev/null"`;
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'sh';
  const shellArgs = process.platform === 'win32'
    ? ['-NoProfile', '-Command', command]
    : ['-lc', command];

  return new Promise((resolvePromise) => {
    const child = spawn(shell, shellArgs, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => {
      const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      resolvePromise({
        ok: code === 0,
        lines,
        stderr: stderr.trim(),
      });
    });
    child.on('error', (error) => {
      resolvePromise({
        ok: false,
        lines: [],
        stderr: error instanceof Error ? error.message : String(error),
      });
    });
  });
}

async function runStandaloneSmokeCheck() {
  const beforeHealth = await fetchJson(healthUrl, 1500);
  if (beforeHealth.ok && beforeHealth.json?.status === 'ok') {
    return {
      mode: 'already-running',
      startedByDoctor: false,
      readiness: true,
      health: beforeHealth,
      stderr: '',
      stdout: '',
      exit: null,
      durationMs: 0,
      child: null,
      exitPromise: Promise.resolve(null),
    };
  }

  const child = spawn(process.execPath, ['scripts/mcp-start.cjs', '--standalone'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MCP_STARTUP_TIMEOUT_MS: String(startupTimeoutMs),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let exit = null;
  const startedAt = Date.now();

  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  const exitPromise = new Promise((resolvePromise) => {
    child.on('close', (code, signal) => {
      exit = { code, signal };
      resolvePromise(exit);
    });
    child.on('error', (error) => {
      stderr += `\n${error instanceof Error ? error.message : String(error)}`;
      exit = { code: null, signal: 'spawn-error' };
      resolvePromise(exit);
    });
  });

  let readyHealth = null;
  while (Date.now() - startedAt < startupTimeoutMs + 2500) {
    const health = await fetchJson(healthUrl, 1200);
    if (health.ok && health.json?.status === 'ok') {
      readyHealth = health;
      break;
    }

    if (exit) {
      break;
    }

    await sleep(400);
  }

  if (readyHealth) {
    await sleep(250);
  } else if (!exit) {
    child.kill();
    await Promise.race([exitPromise, sleep(2000)]);
  }

  return {
    mode: 'spawned',
    startedByDoctor: true,
    readiness: Boolean(readyHealth),
    health: readyHealth,
    stderr: stderr.trim(),
    stdout: stdout.trim(),
    exit,
    durationMs: Date.now() - startedAt,
    child,
    exitPromise,
  };
}

const dryRun = await runNodeScript(['scripts/mcp-start.cjs', '--dry-run']);
const distExists = await fileExists(resolve(repoRoot, 'apps/mcp-server/dist/mcp-bridge.js'));
const codexConfig = await detectCodexConfig();
const listenersBefore = await getPortListeners(bridgePort);
const smoke = await runStandaloneSmokeCheck();
const health = smoke.health ?? await fetchJson(healthUrl);
const stats = health.ok ? await fetchJson(statsUrl) : null;
const sessions = health.ok ? await fetchJson(sessionsUrl) : null;
const liveSessions = summarizeLiveSessions(sessions?.json, health?.json, stats?.json);
let stopResult = null;
if (smoke.startedByDoctor && smoke.readiness) {
  stopResult = await runNodeScript(['scripts/mcp-start.cjs', '--stop'], 15000);
  await Promise.race([smoke.exitPromise, sleep(5000)]);
  if (!smoke.exit && smoke.child?.exitCode === null) {
    smoke.child.kill();
    await Promise.race([smoke.exitPromise, sleep(2000)]);
  }
}
const listenersAfter = await getPortListeners(bridgePort);

const items = [];
const unstableAfterStartup = Boolean(
  smoke.startedByDoctor
  && smoke.readiness
  && ((!stats?.ok) || (!sessions?.ok))
);

if (health.ok && health.json?.status === 'ok' && !unstableAfterStartup) {
  const evidence = [];
  evidence.push(`Health endpoint responded on ${healthUrl}.`);
  if (smoke.mode === 'already-running') {
    evidence.push('Bridge was already running before doctor started.');
  } else if (smoke.readiness) {
    evidence.push(`Doctor started the bridge successfully in ${smoke.durationMs}ms.`);
  }
  items.push({
    key: 'backendBridge',
    name: 'Backend bridge',
    state: 'OK',
    summary: 'HTTP bridge is reachable.',
    evidence,
    fixes: ['curl.exe http://127.0.0.1:8065/health'],
  });
} else if (health.ok && health.json?.status === 'ok' && unstableAfterStartup) {
  const evidence = [
    `Health endpoint responded on ${healthUrl}.`,
    `Doctor started the bridge successfully in ${smoke.durationMs}ms.`,
    stats?.error ? `/stats error after startup: ${stats.error}` : `/stats status after startup: ${String(stats?.status)}`,
    sessions?.error ? `/sessions error after startup: ${sessions.error}` : `/sessions status after startup: ${String(sessions?.status)}`,
  ];
  if (smoke.exit) {
    evidence.push(`Standalone process exit observed: code=${String(smoke.exit.code)} signal=${String(smoke.exit.signal)}.`);
  }
  items.push({
    key: 'backendBridge',
    name: 'Backend bridge',
    state: 'WARN',
    summary: 'Bridge starts and reaches /health, but does not stay stable for follow-up API checks.',
    evidence,
    fixes: [
      'node scripts/mcp-start.cjs --standalone',
      'curl.exe http://127.0.0.1:8065/health',
      'curl.exe http://127.0.0.1:8065/stats',
      `netstat -ano | findstr :${bridgePort}`,
    ],
  });
} else {
  const evidence = [];
  if (smoke.mode === 'spawned') {
    evidence.push(`Doctor tried to start --standalone for ${smoke.durationMs}ms and did not reach /health.`);
  }
  if (smoke.exit) {
    evidence.push(`Standalone process exited with code=${String(smoke.exit.code)} signal=${String(smoke.exit.signal)}.`);
  }
  if (smoke.stderr) {
    evidence.push(`stderr: ${smoke.stderr.split(/\r?\n/).slice(-3).join(' | ')}`);
  } else if (health.error) {
    evidence.push(`fetch error: ${health.error}`);
  }
  if (listenersAfter.lines.length > 0) {
    evidence.push(`Port ${bridgePort} activity: ${listenersAfter.lines.join(' | ')}`);
  } else {
    evidence.push(`No LISTENING socket detected on port ${bridgePort}.`);
  }
  items.push({
    key: 'backendBridge',
    name: 'Backend bridge',
    state: 'FAIL',
    summary: 'HTTP bridge is not reachable.',
    evidence,
    fixes: [
      'node scripts/mcp-start.cjs --standalone',
      'node scripts/mcp-start.cjs --stop',
      'pnpm nx build mcp-server',
      `netstat -ano | findstr :${bridgePort}`,
    ],
  });
}

if (dryRun.ok && distExists) {
  items.push({
    key: 'mcpImplementation',
    name: 'MCP server implementation',
    state: 'OK',
    summary: 'Launcher dry-run succeeded and dist runtime exists.',
    evidence: [
      `dry-run stderr: ${dryRun.stderr.trim() || '(none)'}`,
      'apps/mcp-server/dist/mcp-bridge.js exists.',
    ],
    fixes: ['node scripts/mcp-start.cjs --dry-run'],
  });
} else {
  const evidence = [];
  if (!dryRun.ok) {
    evidence.push(`dry-run failed${dryRun.stderr ? `: ${dryRun.stderr.trim()}` : ''}`);
  }
  if (!distExists) {
    evidence.push('apps/mcp-server/dist/mcp-bridge.js is missing.');
  }
  items.push({
    key: 'mcpImplementation',
    name: 'MCP server implementation',
    state: 'FAIL',
    summary: 'Launcher/runtime is not ready.',
    evidence,
    fixes: ['pnpm nx build mcp-server', 'pnpm install', 'node scripts/mcp-start.cjs --dry-run'],
  });
}

if (health.ok && stats?.ok && sessions?.ok) {
  items.push({
    key: 'sessionsApi',
    name: 'Sessions API',
    state: 'OK',
    summary: 'Stats and sessions endpoints responded.',
    evidence: [
      typeof stats.json?.sessions === 'number'
        ? `Persisted sessions reported by /stats: ${stats.json.sessions}.`
        : '/stats responded without a numeric sessions counter.',
      `Fetched ${Array.isArray(sessions.json?.sessions) ? sessions.json.sessions.length : 0} session rows from /sessions.`,
    ],
    fixes: ['curl.exe http://127.0.0.1:8065/stats', 'curl.exe "http://127.0.0.1:8065/sessions?limit=10&offset=0"'],
  });
} else if (health.ok) {
  items.push({
    key: 'sessionsApi',
    name: 'Sessions API',
    state: 'WARN',
    summary: unstableAfterStartup
      ? 'Bridge reached /health, but stats or sessions failed immediately afterward.'
      : 'Bridge is up, but stats or sessions did not respond cleanly.',
    evidence: [
      stats?.error ? `/stats error: ${stats.error}` : `/stats status: ${String(stats?.status)}`,
      sessions?.error ? `/sessions error: ${sessions.error}` : `/sessions status: ${String(sessions?.status)}`,
    ],
    fixes: ['curl.exe http://127.0.0.1:8065/stats', 'curl.exe "http://127.0.0.1:8065/sessions?limit=10&offset=0"'],
  });
} else {
  items.push({
    key: 'sessionsApi',
    name: 'Sessions API',
    state: 'WARN',
    summary: 'Skipped because backend bridge is down.',
    evidence: ['Sessions API depends on the bridge health endpoint.'],
    fixes: ['node scripts/mcp-start.cjs --standalone'],
  });
}

if (!health.ok) {
  items.push({
    key: 'liveBrowserSession',
    name: 'Current browser session live connection',
    state: 'WARN',
    summary: 'Cannot evaluate live sessions while backend bridge is down.',
    evidence: ['Start the bridge first, then rerun doctor.'],
    fixes: ['node scripts/mcp-start.cjs --standalone'],
  });
} else if (liveSessions.live > 0 || liveSessions.fallbackLive) {
  items.push({
    key: 'liveBrowserSession',
    name: 'Current browser session live connection',
    state: 'OK',
    summary: liveSessions.live > 0
      ? `Found ${liveSessions.live} live session(s).`
      : `Bridge reports ${liveSessions.fallbackActiveSessions} active live session(s) even though /sessions does not expose liveConnection details.`,
    evidence: [
      `Total sessions returned: ${liveSessions.total}.`,
      liveSessions.activeSessionsFromHealth !== null
        ? `/health websocket.activeSessions: ${liveSessions.activeSessionsFromHealth}.`
        : '/health did not expose websocket.activeSessions.',
      liveSessions.activeSessionsFromStats !== null
        ? `/stats websocket.activeSessions: ${liveSessions.activeSessionsFromStats}.`
        : '/stats did not expose websocket.activeSessions.',
      liveSessions.firstLiveUrl ? `First live URL: ${liveSessions.firstLiveUrl}` : 'Live session URL not present in response.',
    ],
    fixes: [
      'curl.exe http://127.0.0.1:8065/health',
      'curl.exe http://127.0.0.1:8065/stats',
      'curl.exe "http://127.0.0.1:8065/sessions?limit=10&offset=0"',
    ],
  });
} else if (liveSessions.total > 0) {
  items.push({
    key: 'liveBrowserSession',
    name: 'Current browser session live connection',
    state: 'FAIL',
    summary: `Found ${liveSessions.total} session(s), but none are connected right now.`,
    evidence: [
      'Historical sessions exist, but liveConnection.connected is false for all returned rows.',
      liveSessions.activeSessionsFromHealth !== null
        ? `/health websocket.activeSessions: ${liveSessions.activeSessionsFromHealth}.`
        : '/health did not expose websocket.activeSessions.',
      liveSessions.activeSessionsFromStats !== null
        ? `/stats websocket.activeSessions: ${liveSessions.activeSessionsFromStats}.`
        : '/stats did not expose websocket.activeSessions.',
    ],
    fixes: [
      'Open Chrome extension popup and click Start session',
      'Reload the target tab after the session starts',
      'Bind the tab in Session Tabs if needed',
    ],
  });
} else {
  items.push({
    key: 'liveBrowserSession',
    name: 'Current browser session live connection',
    state: 'FAIL',
    summary: 'No sessions were returned by the backend.',
    evidence: ['No capture session has been stored yet, or the extension is not connected.'],
    fixes: [
      'Open Chrome extension popup and add the target origin to the allowlist',
      'Click Start session in the extension popup',
      'Reload the target page',
    ],
  });
}

if (codexConfig?.hasServerBlock && codexConfig.hasLauncher) {
  items.push({
    key: 'codexConfig',
    name: 'Codex MCP config',
    state: 'OK',
    summary: 'Found browser_debug config with a launcher reference.',
    evidence: [`Config path: ${codexConfig.path}`],
    fixes: ['pnpm mcp:print-config'],
  });
} else if (codexConfig?.hasServerBlock) {
  items.push({
    key: 'codexConfig',
    name: 'Codex MCP config',
    state: 'WARN',
    summary: 'Found browser_debug config, but launcher path was not validated.',
    evidence: [`Config path: ${codexConfig.path}`],
    fixes: ['pnpm mcp:print-config'],
  });
} else {
  items.push({
    key: 'codexConfig',
    name: 'Codex MCP config',
    state: 'FAIL',
    summary: 'No browser_debug MCP config was found in project or user Codex config.',
    evidence: codexConfigCandidates.map((candidate) => `Checked: ${candidate}`),
    fixes: ['pnpm mcp:print-config'],
  });
}

items.push({
  key: 'codexTransport',
  name: 'Codex built-in MCP transport',
  state: 'INFO',
  summary: 'Current-chat MCP attachment cannot be verified by a repo-local script.',
  evidence: [
    'This depends on the Codex client process that opened the current chat.',
    'A healthy bridge plus a valid config still does not prove that this chat reattached the transport.',
  ],
  fixes: [
    'Restart Codex after the bridge is already running',
    'Start a new chat/session after restarting Codex',
    'If needed, run node scripts/mcp-start.cjs --stop before restarting Codex',
  ],
});

const report = {
  bridgeBaseUrl,
  checkedAt: new Date().toISOString(),
  smokeTest: {
    mode: smoke.mode,
    startedByDoctor: smoke.startedByDoctor,
    readiness: smoke.readiness,
    durationMs: smoke.durationMs,
    exit: smoke.exit,
    stderr: smoke.stderr || null,
    stdout: smoke.stdout || null,
    stopResult: stopResult
      ? {
          ok: stopResult.ok,
          code: stopResult.code,
          stderr: stopResult.stderr || null,
        }
      : null,
  },
  portCheck: {
    before: listenersBefore.lines,
    after: listenersAfter.lines,
  },
  items,
};

if (jsonMode) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

printSection(smokeMode ? 'Browser Debug MCP Bridge Smoke Check' : 'Browser Debug MCP Bridge Doctor');
console.log(`Target bridge URL: ${bridgeBaseUrl}`);
console.log(`Standalone smoke mode: ${smoke.mode}`);

printSection('Status');
for (const item of items) {
  printStatus(item);
}

if (smoke.stderr) {
  printSection('Standalone stderr');
  console.log(smoke.stderr);
}
