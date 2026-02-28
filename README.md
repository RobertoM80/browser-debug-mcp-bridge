# Browser Debug MCP Bridge

Chrome Extension + local Node.js MCP runtime for real-browser debugging.

It captures telemetry from an actual browser session (console, network, navigation, UI events), stores it locally, and exposes debugging tools through MCP to your AI client.

## What You Can Do

- Inspect real sessions instead of synthetic test runs
- Query recent errors, failed requests, and event timelines
- Run targeted live capture (DOM subtree/document, styles, layout)
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

2. Download the latest extension asset `chrome-extension-dist.tgz` from:

- `https://github.com/RobertoM80/browser-debug-mcp-bridge/releases/latest`

3. Extract the archive and load extension in Chrome:

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click **Load unpacked**
4. Select the extracted extension folder

4. Configure MCP host with direct Node launch (recommended):

1. Find npm global root: `npm root -g`
2. Use script path: `<NPM_GLOBAL_ROOT>/browser-debug-mcp-bridge/scripts/mcp-start.cjs`

5. Alternative quick runtime (secondary):

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
- Use live tools (`get_dom_document`, `capture_ui_snapshot`) only on connected sessions.

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
