# Quick Start

## Prerequisites

- Node.js `>=22.19`
- Chrome with developer mode enabled
- Chrome extension (release asset or local build)

## Fast path (no repo clone, recommended)

Studio or MCPS is not required for this path. Configure any MCP host that supports command/args stdio with the launcher below and it will expose the same Browser Debug MCP Bridge tools.

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

## Copilot without MCP

If Copilot MCP servers are disabled by organization policy but terminal commands are allowed, use the packaged CLI workflow:

```bash
browser-debug-mcp-bridge --standalone
bdmcp init-copilot
bdmcp health
bdmcp sessions --live
```

## Load extension build

1. Build once (local path only): `pnpm nx build chrome-extension`
2. Open `chrome://extensions`
3. Enable Developer mode
4. Load unpacked from `dist/apps/chrome-extension`
5. After later rebuilds, click the extension `Reload` action in `chrome://extensions` before reopening the popup

## Verify baseline health

- Server endpoint: `GET http://127.0.0.1:8065/health`
- Optional stats endpoint: `GET http://127.0.0.1:8065/stats`
- Confirm popup shows connected status after session start
- Confirm MCP client can run `list_sessions`
- For live tools, prefer a session where `liveConnection.recommendedForLiveCapture = true`
- If session choice is unclear, run `get_live_session_health`
- Session scope is tab-bound by default; use popup `Session Tabs` to add/remove tabs
- Verify live console path with `get_live_console_logs` on a connected `sessionId`

## Next steps

- Follow [Install + MCP Client Setup](./install-and-client-setup.md)
- Follow [Copilot CLI Workflow](./copilot-cli-workflow.md)
- Follow [Local Debug Session Workflow](./local-debug-session.md)
- Review [MCP Tools Overview](../mcp-tools/overview.md)
