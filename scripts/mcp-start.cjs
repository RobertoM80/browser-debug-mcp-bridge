#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { createRequire } = require('node:module');

const repoRoot = resolve(__dirname, '..');
const packageJson = join(repoRoot, 'package.json');
const mcpBridgeEntry = join(repoRoot, 'apps', 'mcp-server', 'src', 'mcp-bridge.ts');
const mainServerEntry = join(repoRoot, 'apps', 'mcp-server', 'src', 'main.ts');
const args = process.argv.slice(2);
const useTsx = args.includes('--mode=tsx');
const dryRun = args.includes('--dry-run');
const standalone = args.includes('--standalone');
const localRequire = createRequire(join(repoRoot, 'package.json'));
const supportsColor = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
const greenBackground = '\x1b[42m\x1b[30m';
const ansiReset = '\x1b[0m';

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

if (!existsSync(packageJson)) {
  process.stderr.write(`[mcp-start] Invalid repository root: ${repoRoot}\n`);
  process.exit(1);
}

function spawnRuntime(runtime) {
  const nxTarget = standalone ? 'mcp-server:serve' : 'mcp-server:serve-mcp';
  const entryScript = standalone ? mainServerEntry : mcpBridgeEntry;

  if (dryRun) {
    process.stderr.write(`[mcp-start] Dry run mode. Selected runtime: ${runtime}\n`);
    if (runtime === 'nx') {
      process.stderr.write(`[mcp-start] Command: node ${nxBin} run ${nxTarget}\n`);
    } else {
      process.stderr.write(`[mcp-start] Command: node ${tsxCli} ${entryScript}\n`);
    }
    process.exit(0);
  }

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

  const child = runtime === 'nx'
    ? spawn(
        nxBin.endsWith('.cmd') ? nxBin : process.execPath,
        nxBin.endsWith('.cmd') ? ['run', nxTarget] : [nxBin, 'run', nxTarget],
        {
        cwd: repoRoot,
        env: { ...process.env },
        stdio: 'inherit',
      },
      )
    : spawn(
        tsxCli.endsWith('.cmd') ? tsxCli : process.execPath,
        tsxCli.endsWith('.cmd') ? [entryScript] : [tsxCli, entryScript],
        {
        cwd: repoRoot,
        env: { ...process.env },
        stdio: 'inherit',
      },
      );

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
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
}

async function main() {
  if (useTsx) {
    if (!existsSync(tsxCli)) {
      process.stderr.write('[mcp-start] Missing tsx runtime. Run npm install/pnpm install first.\n');
      process.exit(1);
    }
    spawnRuntime('tsx');
    return;
  }

  if (existsSync(nxBin)) {
    spawnRuntime('nx');
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
  spawnRuntime('tsx');
}

main().catch((error) => {
  process.stderr.write(`[mcp-start] Startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
