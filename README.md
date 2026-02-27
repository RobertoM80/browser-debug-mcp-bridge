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
- pnpm `>=9` (for local repo mode)
- Chrome (Developer Mode to load unpacked extension)

## Setup Modes

### Recommended: Full Local Setup (MCP + Extension)

Use this when you want the full product (including extension).

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

### Quick Runtime (MCP server launcher only)

If you already have extension/runtime assets aligned, you can launch from npm:

```bash
npx -y browser-debug-mcp-bridge
```

GitHub fallback (if npm registry package is unavailable):

```bash
npx -y --package=github:RobertoM80/browser-debug-mcp-bridge browser-debug-mcp-bridge
```

Important:

- This only starts the runtime.
- You still need a compatible extension connected to `127.0.0.1:8065`.

## MCP Client Configuration

Generate ready-to-paste snippets:

```bash
pnpm mcp:print-config
```

### OpenAI (Codex CLI / Codex in VS Code)

Edit `~/.codex/config.toml` (Windows: `C:\Users\<you>\.codex\config.toml`) and add:

```toml
[mcp_servers.browser_debug]
command = "node"
args = ["C:\\ABSOLUTE\\PATH\\TO\\browser-debug-mcp-bridge\\scripts\\mcp-start.cjs"]
```

npm quick mode:

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
        "C:\\ABSOLUTE\\PATH\\TO\\browser-debug-mcp-bridge\\scripts\\mcp-start.cjs"
      ]
    }
  }
}
```

### VS Code (any MCP host expecting command/args)

Use the same values:

- `command`: `node`
- `args`: `[
  "<ABSOLUTE_PATH>/scripts/mcp-start.cjs"
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

- On Windows, launcher tries automatic stale bridge recovery first.
- If port is still occupied, startup fails with `MCP_STARTUP_PORT_IN_USE`.
- In that case, free/reserve port `8065` for this bridge and restart.
- In `mcp-stdio` mode, bridge lifecycle is tied to the host and should stop when host transport closes.
- If a stale process still remains, stop it explicitly with `node scripts/mcp-start.cjs --stop`.

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
