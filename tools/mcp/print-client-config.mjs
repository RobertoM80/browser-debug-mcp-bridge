#!/usr/bin/env node
import { resolve } from 'path';

const repoPathArg = process.argv.find((arg) => arg.startsWith('--repo='))?.slice('--repo='.length);
const repoPath = resolve(repoPathArg ?? process.cwd()).replace(/\\/g, '\\\\');
const sharedArgs = [`${repoPath}\\\\scripts\\\\mcp-start.cjs`];

const codexToml = `[mcp_servers.browser_debug]
command = "node"
args = ["${sharedArgs[0]}"]`;

const codexTomlNpxGithub = `[mcp_servers.browser_debug]
command = "npx"
args = ["-y", "github:RobertoM80/browser-debug-mcp-bridge"]`;

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

const jsonConfigNpxGithub = JSON.stringify(
  {
    mcpServers: {
      'browser-debug': {
        command: 'npx',
        args: ['-y', 'github:RobertoM80/browser-debug-mcp-bridge'],
      },
    },
  },
  null,
  2,
);

console.log('=== Codex (.codex/config.toml) ===');
console.log(codexToml);
console.log('');
console.log('=== Codex (.codex/config.toml) [GitHub npx quick mode] ===');
console.log(codexTomlNpxGithub);
console.log('');
console.log('=== Claude/Cursor/Windsurf (JSON) ===');
console.log(jsonConfig);
console.log('');
console.log('=== Claude/Cursor/Windsurf (JSON) [GitHub npx quick mode] ===');
console.log(jsonConfigNpxGithub);
console.log('');
console.log('Tip: pass --repo=<absolute path> to override detected repository path.');
