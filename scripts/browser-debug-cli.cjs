#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { createRequire } = require('node:module');

const repoRoot = resolve(__dirname, '..');
const distEntry = join(repoRoot, 'apps', 'mcp-server', 'dist', 'cli', 'main.js');
const sourceEntry = join(repoRoot, 'apps', 'mcp-server', 'src', 'cli', 'main.ts');
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

const tsxCli =
  resolveRuntimePath('tsx/dist/cli.mjs') ||
  resolveFromPackage('tsx', 'dist/cli.mjs') ||
  resolveBinFallback('tsx');

function spawnCli(runtime, entry, args) {
  const child =
    runtime === 'dist'
      ? spawn(process.execPath, [entry, ...args], {
          cwd: process.cwd(),
          env: process.env,
          stdio: 'inherit',
        })
      : spawn(
          tsxCli.endsWith('.cmd') ? tsxCli : process.execPath,
          tsxCli.endsWith('.cmd') ? [entry, ...args] : [tsxCli, entry, ...args],
          {
            cwd: process.cwd(),
            env: process.env,
            stdio: 'inherit',
          },
        );

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on('error', (error) => {
    process.stderr.write(`[bdmcp] Failed to launch CLI: ${error.message}\n`);
    process.exit(1);
  });
}

const args = process.argv.slice(2);

if (existsSync(distEntry)) {
  spawnCli('dist', distEntry, args);
} else if (existsSync(sourceEntry) && existsSync(tsxCli)) {
  spawnCli('tsx', sourceEntry, args);
} else {
  process.stderr.write('[bdmcp] Missing CLI runtime. Build mcp-server first or install package dependencies.\n');
  process.exit(1);
}
