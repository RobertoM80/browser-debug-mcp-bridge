# Quick Start

## Prerequisites

- Node.js 20+
- Chrome with developer mode enabled
- Chrome extension (release asset or local build)

## Fast path (no repo clone, recommended)

```bash
npm i -g browser-debug-mcp-bridge
npm root -g
```

Then:

1. Download latest `chrome-extension-dist.tgz` release asset and extract it
2. Load unpacked extension from `chrome://extensions`
3. Configure MCP host:
   1. command: `node`
   2. args: `["<NPM_GLOBAL_ROOT>/browser-debug-mcp-bridge/scripts/mcp-start.cjs"]`

## Local dev path (repo clone)

```bash
pnpm install
pnpm nx serve mcp-server
pnpm nx build chrome-extension --watch
```

For MCP client integration, local path mode is:

```bash
node scripts/mcp-start.cjs
```

On Windows, launcher attempts automatic stale-process recovery if bridge port `8065` is occupied.

In `mcp-stdio` mode, bridge should stop when host transport closes. If a stale process remains, run:

```bash
node scripts/mcp-start.cjs --stop
```

## Load extension build

1. Build once (local path only): `pnpm nx build chrome-extension`
2. Open `chrome://extensions`
3. Enable Developer mode
4. Load unpacked from `dist/apps/chrome-extension`

## Verify baseline health

- Server endpoint: `GET http://127.0.0.1:8065/health`
- Optional stats endpoint: `GET http://127.0.0.1:8065/stats`
- Confirm popup shows connected status after session start
- Confirm MCP client can run `list_sessions`
- For live tools, use a session with `liveConnection.connected = true`
- Session scope is tab-bound by default; use popup `Session Tabs` to add/remove tabs
- Verify live console path with `get_live_console_logs` on a connected `sessionId`

## Next steps

- Follow [Install + MCP Client Setup](./install-and-client-setup.md)
- Follow [Local Debug Session Workflow](./local-debug-session.md)
- Review [MCP Tools Overview](../mcp-tools/overview.md)
