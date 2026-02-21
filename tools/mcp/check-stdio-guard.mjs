#!/usr/bin/env node
import { readFileSync } from 'fs';
import { resolve } from 'path';

const repoRoot = resolve(process.cwd());

const checks = [
  {
    file: 'apps/mcp-server/src/main.ts',
    mustInclude: "process.env.MCP_STDIO_MODE === '1' ? false : true",
    description: 'Fastify logger must be disabled in MCP stdio mode',
  },
  {
    file: 'apps/mcp-server/src/mcp-bridge.ts',
    mustNotIncludeAny: ['console.log(', 'console.info(', 'console.debug('],
    description: 'Bridge must not write normal logs to stdout',
  },
  {
    file: 'apps/mcp-server/src/mcp/server.ts',
    mustInclude: 'process.stderr.write(',
    description: 'MCP logger should write to stderr',
  },
];

let failed = false;

for (const check of checks) {
  const filePath = resolve(repoRoot, check.file);
  const source = readFileSync(filePath, 'utf8');

  if (check.mustInclude && !source.includes(check.mustInclude)) {
    console.error(`[FAIL] ${check.description} (${check.file})`);
    failed = true;
  }

  if (check.mustNotIncludeAny) {
    for (const token of check.mustNotIncludeAny) {
      if (source.includes(token)) {
        console.error(`[FAIL] Found forbidden stdout token "${token}" in ${check.file}`);
        failed = true;
      }
    }
  }
}

if (failed) {
  process.exit(1);
}

console.log('[PASS] MCP stdio safety guards are present.');

