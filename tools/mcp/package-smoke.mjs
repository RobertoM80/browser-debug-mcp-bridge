#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import net from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = resolve(process.cwd());
const keepTemp = process.env.KEEP_MCP_PACKAGE_SMOKE === '1';
const smokeRoot = mkdtempSync(join(tmpdir(), 'bdmcp-package-smoke-'));
const packDir = join(smokeRoot, 'pack');
const installDir = join(smokeRoot, 'install');

function log(message) {
  process.stderr.write(`[package-smoke] ${message}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: process.env,
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
  });

  if (result.status !== 0) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}`);
  }

  return result.stdout;
}

function runNpm(args, options = {}) {
  if (process.platform === 'win32') {
    return run('cmd.exe', ['/d', '/s', '/c', 'npm', ...args], options);
  }
  return run('npm', args, options);
}

function makeEnv(overrides) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  return { ...env, ...overrides };
}

function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => {
        if (typeof port === 'number') {
          resolvePort(port);
          return;
        }
        reject(new Error('Unable to allocate a free TCP port.'));
      });
    });
  });
}

async function main() {
  const distBridge = join(repoRoot, 'apps', 'mcp-server', 'dist', 'mcp-bridge.js');
  const distMain = join(repoRoot, 'apps', 'mcp-server', 'dist', 'main.js');
  if (!existsSync(distBridge) || !existsSync(distMain)) {
    throw new Error('Missing built MCP runtime. Run `pnpm nx build mcp-server` before package smoke.');
  }

  mkdirSync(packDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });

  log('Packing npm package from current workspace.');
  const packJson = runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', packDir]);
  const packed = JSON.parse(packJson);
  const tarballName = packed?.[0]?.filename;
  if (typeof tarballName !== 'string' || tarballName.length === 0) {
    throw new Error('npm pack did not report a tarball filename.');
  }
  const tarballPath = join(packDir, tarballName);

  log('Installing packed tarball into a clean temp project.');
  runNpm(['init', '-y'], { cwd: installDir });
  runNpm(['install', '--omit=dev', tarballPath], { cwd: installDir, timeout: 240_000 });

  const installedPackageRoot = join(installDir, 'node_modules', 'browser-debug-mcp-bridge');
  const launcher = join(installedPackageRoot, 'scripts', 'mcp-start.cjs');
  const cliLauncher = join(installedPackageRoot, 'scripts', 'browser-debug-cli.cjs');
  if (!existsSync(launcher)) {
    throw new Error(`Installed launcher missing: ${launcher}`);
  }
  if (!existsSync(cliLauncher)) {
    throw new Error(`Installed CLI launcher missing: ${cliLauncher}`);
  }
  const packagedSkill = join(installedPackageRoot, '.agents', 'skills', 'browser-debug-cli', 'SKILL.md');
  if (!existsSync(packagedSkill)) {
    throw new Error(`Packaged browser-debug-cli skill missing: ${packagedSkill}`);
  }

  log('Verifying mandatory runtime dependencies resolve from the installed package.');
  const installedRequire = createRequire(join(installedPackageRoot, 'package.json'));
  installedRequire.resolve('lighthouse');
  installedRequire.resolve('chrome-launcher');

  log('Verifying installed launcher dry-run selects packaged dist runtime.');
  const dryRun = spawnSync(process.execPath, [launcher, '--dry-run'], {
    cwd: installDir,
    env: makeEnv({ NO_COLOR: '1' }),
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (dryRun.status !== 0) {
    process.stderr.write(dryRun.stdout || '');
    process.stderr.write(dryRun.stderr || '');
    throw new Error(`Installed launcher dry-run failed with exit code ${dryRun.status ?? 'unknown'}`);
  }
  if (!String(dryRun.stderr).includes('Selected runtime: dist')) {
    throw new Error(`Installed launcher did not select dist runtime:\n${dryRun.stderr}`);
  }

  log('Verifying installed CLI help and agent instructions.');
  const cliHelp = spawnSync(process.execPath, [cliLauncher, 'help', '--agent'], {
    cwd: installDir,
    env: makeEnv({ NO_COLOR: '1' }),
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (cliHelp.status !== 0 || !String(cliHelp.stdout).includes('Browser Debug CLI')) {
    process.stderr.write(cliHelp.stdout || '');
    process.stderr.write(cliHelp.stderr || '');
    throw new Error(`Installed CLI help failed with exit code ${cliHelp.status ?? 'unknown'}`);
  }

  log('Connecting to installed package through MCP stdio.');
  const dataDir = mkdtempSync(join(tmpdir(), 'bdmcp-package-smoke-data-'));
  const port = await getFreePort();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [launcher],
    cwd: installDir,
    env: makeEnv({
      DATA_DIR: dataDir,
      PORT: String(port),
      HOST: '127.0.0.1',
      MCP_STARTUP_TIMEOUT_MS: '30000',
    }),
    stderr: 'pipe',
  });
  const stderrLogs = [];
  transport.stderr?.on('data', (chunk) => {
    stderrLogs.push(chunk.toString());
  });

  const client = new Client({ name: 'browser-debug-package-smoke', version: '1.0.0' });
  try {
    await client.connect(transport);
    const cliHealth = spawnSync(process.execPath, [cliLauncher, 'health'], {
      cwd: installDir,
      env: makeEnv({
        DATA_DIR: dataDir,
        PORT: String(port),
        HOST: '127.0.0.1',
      }),
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (cliHealth.status !== 0 || !String(cliHealth.stdout).includes('Bridge: ok')) {
      process.stderr.write(cliHealth.stdout || '');
      process.stderr.write(cliHealth.stderr || '');
      throw new Error(`Installed CLI health failed with exit code ${cliHealth.status ?? 'unknown'}`);
    }

    const cliArgsPath = join(dataDir, 'list-sessions-args.json');
    writeFileSync(cliArgsPath, JSON.stringify({ limit: 10 }), 'utf8');
    const cliToolRun = spawnSync(process.execPath, [cliLauncher, 'tool', 'run', 'list_sessions', '--args-file', cliArgsPath, '--json'], {
      cwd: installDir,
      env: makeEnv({
        DATA_DIR: dataDir,
        PORT: String(port),
        HOST: '127.0.0.1',
      }),
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (cliToolRun.status !== 0 || !String(cliToolRun.stdout).includes('"sessions"')) {
      process.stderr.write(cliToolRun.stdout || '');
      process.stderr.write(cliToolRun.stderr || '');
      throw new Error(`Installed CLI generic tool run failed with exit code ${cliToolRun.status ?? 'unknown'}`);
    }

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    const requiredTools = ['list_sessions', 'run_lighthouse_report', 'get_live_console_logs', 'run_ui_steps'];
    for (const toolName of requiredTools) {
      if (!toolNames.includes(toolName)) {
        throw new Error(`Installed package did not expose required MCP tool: ${toolName}`);
      }
    }
    if (toolNames.length < 70) {
      throw new Error(`Installed package exposed too few MCP tools: ${toolNames.length}`);
    }

    const sessionsResult = await client.callTool({
      name: 'list_sessions',
      arguments: { limit: 10 },
    });
    if (sessionsResult.isError === true) {
      throw new Error(`list_sessions returned MCP error: ${JSON.stringify(sessionsResult.content)}`);
    }
    const text = sessionsResult.content.find((entry) => entry.type === 'text')?.text;
    const sessions = JSON.parse(text ?? '{}');
    if (!Array.isArray(sessions.sessions)) {
      throw new Error(`list_sessions returned unexpected payload: ${text}`);
    }
  } catch (error) {
    process.stderr.write(stderrLogs.join(''));
    throw error;
  } finally {
    await transport.close();
    if (!keepTemp) {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }

  log('Package smoke passed.');
}

main()
  .catch((error) => {
    process.stderr.write(`[package-smoke] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (!keepTemp) {
      rmSync(smokeRoot, { recursive: true, force: true });
    } else {
      log(`Kept temp directory: ${smokeRoot}`);
    }
  });
