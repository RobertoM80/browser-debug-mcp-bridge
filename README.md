# Browser Debug MCP Bridge

Chrome Extension + local Node.js MCP runtime for real-browser debugging.

It captures telemetry from an actual browser session (console, network, navigation, UI events), stores it locally, and exposes debugging tools through MCP to your AI client.

## What You Can Do

- Inspect real sessions instead of synthetic test runs
- Query recent errors, failed requests, and event timelines
- Run targeted live capture (DOM subtree/document, styles, layout)
- Pull live in-memory console logs with server-side filters (`url`, `tabId`, `levels`, `contains`)
- Correlate user actions with network/runtime failures
- Keep privacy controls enabled (safe mode, allowlist, redaction)

## How It Works

1. Chrome extension captures session telemetry.
2. Local server ingests via HTTP/WebSocket on `127.0.0.1:8065`.
3. Data is persisted in local SQLite.
4. MCP stdio server exposes tools to your AI client.

## Requirements

- Node.js `>=20`
- npm (for no-repo quick mode)
- pnpm `>=9` (for local repo mode)
- Chrome (Developer Mode to load unpacked extension)

## Setup Modes

### Recommended for Most Users: No-Repo Quick Setup

Use this when you want to install and run quickly without cloning this repository.

1. Install runtime globally:

```bash
npm i -g browser-debug-mcp-bridge
```

1. Download the latest extension asset `chrome-extension-dist.tgz` from:

- `https://github.com/RobertoM80/browser-debug-mcp-bridge/releases/latest`

1. Extract the archive and load extension in Chrome:

1. Open `chrome://extensions`
1. Enable Developer mode
1. Click **Load unpacked**
1. Select the extracted extension folder

1. Configure MCP host with direct Node launch (recommended):

1. Find npm global root: `npm root -g`
1. Use script path: `<NPM_GLOBAL_ROOT>/browser-debug-mcp-bridge/scripts/mcp-start.cjs`

1. Alternative quick runtime (secondary):

```bash
npx -y browser-debug-mcp-bridge
```

### Local Repo Setup (Contributors/Customization)

Use this when you need local development, customization, or source-level debugging.

```bash
git clone https://github.com/RobertoM80/browser-debug-mcp-bridge.git
cd browser-debug-mcp-bridge
pnpm install
pnpm nx build mcp-server
pnpm nx build chrome-extension
```

Load extension:

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click **Load unpacked**
4. Select `dist/apps/chrome-extension`

Start MCP runtime:

```bash
node scripts/mcp-start.cjs
```

## MCP Client Configuration

If you are using local repo mode, generate ready-to-paste snippets:

```bash
pnpm mcp:print-config
```

### OpenAI (Codex CLI / Codex in VS Code)

Best-practice launch path: use direct `node` launch to the installed script path.

Edit `~/.codex/config.toml` (Windows: `C:\Users\<you>\.codex\config.toml`) and add:

```toml
[mcp_servers.browser_debug]
command = "node"
args = ["C:\\Users\\<you>\\AppData\\Roaming\\npm\\node_modules\\browser-debug-mcp-bridge\\scripts\\mcp-start.cjs"]
```

local repo mode alternative:

```toml
[mcp_servers.browser_debug]
command = "node"
args = ["C:\\ABSOLUTE\\PATH\\TO\\browser-debug-mcp-bridge\\scripts\\mcp-start.cjs"]
```

npm quick mode (secondary):

```toml
[mcp_servers.browser_debug]
command = "npx"
args = ["-y", "browser-debug-mcp-bridge"]
```

### OpenCode

Use JSON MCP config:

```json
{
  "mcpServers": {
    "browser-debug": {
      "command": "node",
      "args": [
        "C:\\Users\\<you>\\AppData\\Roaming\\npm\\node_modules\\browser-debug-mcp-bridge\\scripts\\mcp-start.cjs"
      ]
    }
  }
}
```

### VS Code (any MCP host expecting command/args)

Use the same values:

- `command`: `node`
- `args`: `[
  "<NPM_GLOBAL_ROOT>/browser-debug-mcp-bridge/scripts/mcp-start.cjs"
]`

If your VS Code MCP host uses JSON, reuse the OpenCode JSON block above.

## First End-to-End Check

- Start MCP host/client (so it launches this server).
- Open extension popup, allowlist domain, start a session.
- Ask your AI client to run:

```json
{ "name": "list_sessions", "arguments": { "sinceMinutes": 60 } }
```

- Pick a session where `liveConnection.connected` is `true`.
- Run query tools first (`get_session_summary`, `get_recent_events`, `get_network_failures`).
- Use live tools (`get_dom_document`, `capture_ui_snapshot`, `get_live_console_logs`) only on connected sessions.

## Session Scope and URL Filtering

- Sessions start bound to the active tab only.
- Telemetry from unbound tabs is rejected to avoid cross-tab contamination.
- Use the popup `Session Tabs` panel to explicitly add/remove tabs from the active session.
- If all bound tabs are removed/closed, the session auto-stops.

MCP query tools support `sessionId`, `url`, or both:

- `sessionId` only: filter by session
- `url` only: filter by URL origin across sessions (for example `http://localhost:3000`)
- `sessionId + url`: intersection (only rows matching both)

Supported tools:

- `get_recent_events`
- `get_navigation_history`
- `get_console_events`
- `get_network_failures`

Example: URL-only query

```json
{
  "name": "get_recent_events",
  "arguments": { "url": "http://localhost:3000", "limit": 50 }
}
```

Example: session + URL intersection

```json
{
  "name": "get_network_failures",
  "arguments": { "sessionId": "sess_123", "url": "http://localhost:3000", "limit": 20 }
}
```

## Live Console Logs (Non-Persistent)

`get_live_console_logs` reads from extension in-memory ring buffers (session-scoped), so this live stream can be filtered without DB scanning.

- `sessionId` is required
- optional filters: `url` (origin), `tabId`, `levels`, `contains`, `sinceTs`
- supports substring filters like `"[auth]"` directly server-side
- results are bounded by `limit` and buffer capacity

Capture scope:

- Captured from page context: `console.log`, `console.info`, `console.warn`, `console.error`, `console.debug`, `console.trace`
- Runtime JS exceptions are included as `error`-level live entries
- Browser-internal/DevTools UI-only rows are not guaranteed

Example:

```json
{
  "name": "get_live_console_logs",
  "arguments": {
    "sessionId": "sess_123",
    "url": "http://localhost:3000",
    "levels": ["info", "error"],
    "contains": "[auth]",
    "limit": 100
  }
}
```

## Port and Startup Behavior

Default port is `8065`.

- Launcher enforces a single-instance startup lock to avoid concurrent launch races.
- On Windows, launcher tries automatic stale bridge recovery first.
- If port is still occupied, startup fails with `MCP_STARTUP_PORT_IN_USE`.
- In that case, free/reserve port `8065` for this bridge and restart.
- Launcher reports `Started` only after `/health` becomes reachable on `127.0.0.1:8065`.
- In `mcp-stdio` mode, bridge lifecycle is tied to the host and should stop when host transport closes.
- If a stale process still remains, stop it explicitly with `node scripts/mcp-start.cjs --stop`.
- Optional: set `MCP_STARTUP_TIMEOUT_MS` (default `15000`) for slower machines.

Useful Windows command:

```powershell
netstat -ano | findstr :8065
```

Stop command:

```bash
node scripts/mcp-start.cjs --stop
```

## Common Failure Signals

- `LIVE_SESSION_DISCONNECTED`: session exists in DB but no active extension transport. Fix: restart/reconnect extension session, then use a `liveConnection.connected = true` session id.
- `MCP_STARTUP_PORT_IN_USE`: required MCP port is blocked. Fix: stop the process using that port and restart bridge.

## Useful Commands

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm docs:ci
pnpm verify
node scripts/mcp-start.cjs --stop
```

Optional one-shot local setup:

```powershell
# Windows
./install.ps1
```

```bash
# macOS/Linux
bash ./install.sh
```

## Tooling Docs

- [MCP tools reference](https://github.com/RobertoM80/browser-debug-mcp-bridge/blob/main/docs/MCP_TOOLS.md)
- [MCP client setup](https://github.com/RobertoM80/browser-debug-mcp-bridge/blob/main/docs/MCP_CLIENT_SETUP.md)
- [Troubleshooting](https://github.com/RobertoM80/browser-debug-mcp-bridge/blob/main/docs/TROUBLESHOOTING.md)
- [Architecture](https://github.com/RobertoM80/browser-debug-mcp-bridge/blob/main/docs/ARCHITECTURE.md)
- [Security and privacy](https://github.com/RobertoM80/browser-debug-mcp-bridge/blob/main/SECURITY.md)

## Repository Layout

```text
apps/
  mcp-server/         Fastify + WebSocket ingest + MCP server
  chrome-extension/   MV3 extension (background/content/injected)
  viewer/             Optional UI
libs/
  shared/             Shared schemas/types/utils
  redaction/          Privacy redaction engine
  selectors/          Selector generation
  mcp-contracts/      MCP tool contracts and schemas
```
