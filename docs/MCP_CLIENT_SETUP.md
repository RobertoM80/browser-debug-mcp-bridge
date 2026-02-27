# MCP Client Setup (Universal)

This repository now exposes a single universal launcher that starts:

- HTTP/WebSocket ingest server on `http://127.0.0.1:8065`
- MCP stdio runtime (tool server for LLM clients)

## Prerequisites

- Node.js 20+
- Chrome extension loaded and connected to `127.0.0.1:8065`
- For local clone mode only:
  - `pnpm install`

## Universal command

From any MCP host, use this command:

- command: `node`
- args: `["<ABSOLUTE_PATH_TO_REPO>\\scripts\\mcp-start.cjs"]`

Quick npm registry option (recommended once published):

- command: `npx`
- args: `["-y", "browser-debug-mcp-bridge"]`

Quick GitHub fallback option (if registry package is not available):

- command: `npx`
- args: `["-y", "--package=github:RobertoM80/browser-debug-mcp-bridge", "browser-debug-mcp-bridge"]`

Important:

- This only changes how the MCP server is started.
- You still need the Chrome extension loaded and connected to `127.0.0.1:8065`.
- In `mcp-stdio` mode, runtime should stop when the MCP host process/transport closes.

Launcher behavior on Windows:

- If port `8065` is held by a stale bridge process, launcher tries automatic recovery and restart.
- If `8065` is still blocked after recovery, check for non-bridge processes bound to that port.

Manual stop command:

```bash
node scripts/mcp-start.cjs --stop
```

Use this when a stale bridge process is still occupying port `8065`.

Example Windows path:

- `C:\\Users\\your-user\\Documents\\progetti\\browser-debug-mcp-bridge`
- full args example:
  - `["C:\\Users\\your-user\\Documents\\progetti\\browser-debug-mcp-bridge\\scripts\\mcp-start.cjs"]`

Generate copy-paste config snippets automatically:

```bash
pnpm mcp:print-config
```

Optional override:

```bash
pnpm mcp:print-config -- --repo=C:\\absolute\\path\\to\\browser-debug-mcp-bridge
```

## Codex (VS Code / CLI)

Edit:

- Global: `C:\Users\<you>\.codex\config.toml`
- Or project: `<repo>\.codex\config.toml`

Example:

```toml
[mcp_servers.browser_debug]
command = "node"
args = ["C:\\Users\\your-user\\Documents\\progetti\\browser-debug-mcp-bridge\\scripts\\mcp-start.cjs"]
```

Quick checklist:

1. Run `pnpm install` (local clone mode only)
2. Add block above to `.codex/config.toml`
3. Restart Codex client
4. Confirm tools like `list_sessions` are visible

Optional Codex GitHub npx config:

```toml
[mcp_servers.browser_debug]
command = "npx"
args = ["-y", "--package=github:RobertoM80/browser-debug-mcp-bridge", "browser-debug-mcp-bridge"]
```

Optional Codex npm registry config:

```toml
[mcp_servers.browser_debug]
command = "npx"
args = ["-y", "browser-debug-mcp-bridge"]
```

If this mode fails with npm cache permission errors (for example `EPERM ... npm-cache\\_cacache\\tmp\\git-clone...`), switch to local mode:

- command: `node`
- args: `["<ABSOLUTE_PATH_TO_REPO>\\scripts\\mcp-start.cjs"]`

## Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "browser-debug": {
      "command": "node",
      "args": [
        "C:\\Users\\your-user\\Documents\\progetti\\browser-debug-mcp-bridge\\scripts\\mcp-start.cjs"
      ]
    }
  }
}
```

Quick checklist:

1. Run `pnpm install` (local clone mode only)
2. Paste JSON block in `%APPDATA%\\Claude\\claude_desktop_config.json`
3. Restart Claude Desktop
4. Confirm MCP server `browser-debug` is connected

## Cursor / Windsurf / other MCP hosts

Use the same `command` + `args` values in that client's MCP server config UI/JSON.

Quick checklist:

1. Run `pnpm install` (local clone mode only)
2. Add MCP server with:
   - command: `node`
   - args: `["<repo>\\scripts\\mcp-start.cjs"]`
3. Restart client
4. Confirm tools list includes browser-debug tools

## OpenCode / custom MCP hosts

If the host accepts JSON-style MCP server entries, use:

```json
{
  "mcpServers": {
    "browser-debug": {
      "command": "node",
      "args": [
        "C:\\path\\to\\browser-debug-mcp-bridge\\scripts\\mcp-start.cjs"
      ]
    }
  }
}
```

## Runtime flow check

1. Start MCP host.
2. Ensure it spawns either:
   - `node <repo>\\scripts\\mcp-start.cjs` (local clone mode), or
   - `npx -y browser-debug-mcp-bridge` (npm mode).
3. Open extension popup, set allowlist, start session.
4. Ask LLM to call `list_sessions`.
5. Use a `sessionId` with `liveConnection.connected = true` for live tools.
6. Ask LLM to call `capture_ui_snapshot` with that `sessionId`.
7. Verify with `list_snapshots` or extension DB Viewer snapshots table.

## CI safety check (stdio guard)

To verify the stdio safety guards are still present in source:

```bash
pnpm mcp:check-stdio-guard
```
