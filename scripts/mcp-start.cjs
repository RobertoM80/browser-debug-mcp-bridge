#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

const repoRoot = resolve(__dirname, '..');
const packageJson = join(repoRoot, 'package.json');

if (!existsSync(packageJson)) {
  process.stderr.write(`[mcp-start] Invalid repository root: ${repoRoot}\n`);
  process.exit(1);
}

const command = 'pnpm nx run mcp-server:serve-mcp';
const child = spawn(command, {
  cwd: repoRoot,
  env: { ...process.env },
  stdio: 'inherit',
  shell: true,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  process.stderr.write(`[mcp-start] Failed to launch MCP bridge. Ensure pnpm is installed and available in PATH. ${error.message}\n`);
  process.exit(1);
});
