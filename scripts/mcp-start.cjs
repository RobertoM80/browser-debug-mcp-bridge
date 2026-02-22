#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

const repoRoot = resolve(__dirname, '..');
const packageJson = join(repoRoot, 'package.json');
const nxBin = join(repoRoot, 'node_modules', 'nx', 'bin', 'nx.js');
const tsxCli = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const mcpBridgeEntry = join(repoRoot, 'apps', 'mcp-server', 'src', 'mcp-bridge.ts');
const args = process.argv.slice(2);
const useTsx = args.includes('--mode=tsx');
const dryRun = args.includes('--dry-run');

if (!existsSync(packageJson)) {
  process.stderr.write(`[mcp-start] Invalid repository root: ${repoRoot}\n`);
  process.exit(1);
}

function spawnRuntime(runtime) {
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
    ? spawn(process.execPath, [nxBin, 'run', 'mcp-server:serve-mcp'], {
        cwd: repoRoot,
        env: { ...process.env },
        stdio: 'inherit',
      })
    : spawn(process.execPath, [tsxCli, mcpBridgeEntry], {
        cwd: repoRoot,
        env: { ...process.env },
        stdio: 'inherit',
      });

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
