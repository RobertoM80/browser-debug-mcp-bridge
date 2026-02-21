#!/usr/bin/env node
import { resolve } from 'path';

const repoPathArg = process.argv.find((arg) => arg.startsWith('--repo='))?.slice('--repo='.length);
const repoPath = resolve(repoPathArg ?? process.cwd()).replace(/\\/g, '\\\\');
const sharedArgs = [`${repoPath}\\\\scripts\\\\mcp-start.cjs`];

const codexToml = `[mcp_servers.browser_debug]
command = "node"
args = ["${sharedArgs[0]}"]`;

const jsonConfig = JSON.stringify(
  {
    mcpServers: {
      'browser-debug': {
        command: 'node',
        args: sharedArgs,
      },
    },
  },
  null,
  2,
);

console.log('=== Codex (.codex/config.toml) ===');
console.log(codexToml);
console.log('');
console.log('=== Claude/Cursor/Windsurf (JSON) ===');
console.log(jsonConfig);
console.log('');
console.log('Tip: pass --repo=<absolute path> to override detected repository path.');
