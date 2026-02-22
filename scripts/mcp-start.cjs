#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { createRequire } = require('node:module');

const repoRoot = resolve(__dirname, '..');
const packageJson = join(repoRoot, 'package.json');
const mcpBridgeEntry = join(repoRoot, 'apps', 'mcp-server', 'src', 'mcp-bridge.ts');
const args = process.argv.slice(2);
const useTsx = args.includes('--mode=tsx');
const dryRun = args.includes('--dry-run');
const debug = args.includes('--debug');
const localRequire = createRequire(join(repoRoot, 'package.json'));

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

function logDebug(message) {
  if (!debug) return;
  process.stderr.write(`[mcp-start][debug] ${message}\n`);
}

if (!existsSync(packageJson)) {
  process.stderr.write(`[mcp-start] Invalid repository root: ${repoRoot}\n`);
  process.exit(1);
}

logDebug(`repoRoot=${repoRoot}`);
logDebug(`packageJsonExists=${existsSync(packageJson)}`);
logDebug(`nxBin=${nxBin || '<not found>'}`);
logDebug(`tsxCli=${tsxCli || '<not found>'}`);
logDebug(`mcpBridgeEntry=${mcpBridgeEntry} exists=${existsSync(mcpBridgeEntry)}`);

function spawnRuntime(runtime) {
  logDebug(`selectedRuntime=${runtime}`);
  if (dryRun) {
    process.stderr.write(`[mcp-start] Dry run mode. Selected runtime: ${runtime}\n`);
    if (runtime === 'nx') {
      process.stderr.write(`[mcp-start] Command: node ${nxBin} run mcp-server:serve-mcp\n`);
    } else {
      process.stderr.write(`[mcp-start] Command: node ${tsxCli} ${mcpBridgeEntry}\n`);
    }
    process.exit(0);
  }

  const child = runtime === 'nx'
    ? spawn(
        nxBin.endsWith('.cmd') ? nxBin : process.execPath,
        nxBin.endsWith('.cmd') ? ['run', 'mcp-server:serve-mcp'] : [nxBin, 'run', 'mcp-server:serve-mcp'],
        {
        cwd: repoRoot,
        env: { ...process.env },
        stdio: 'inherit',
      },
      )
    : spawn(
        tsxCli.endsWith('.cmd') ? tsxCli : process.execPath,
        tsxCli.endsWith('.cmd') ? [mcpBridgeEntry] : [tsxCli, mcpBridgeEntry],
        {
        cwd: repoRoot,
        env: { ...process.env },
        stdio: 'inherit',
      },
      );

  logDebug(`spawnCommand=${runtime === 'nx'
    ? `${nxBin.endsWith('.cmd') ? nxBin : `${process.execPath} ${nxBin}`} run mcp-server:serve-mcp`
    : `${tsxCli.endsWith('.cmd') ? tsxCli : `${process.execPath} ${tsxCli}`} ${mcpBridgeEntry}`}`);

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
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
