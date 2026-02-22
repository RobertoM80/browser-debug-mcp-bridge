# MCP Client Setup (Universal)

This repository now exposes a single universal launcher that starts:
- HTTP/WebSocket ingest server on `http://127.0.0.1:8065`
- MCP stdio runtime (tool server for LLM clients)

## Prerequisites

- `pnpm install`
- Chrome extension loaded from `dist/apps/chrome-extension`

## Universal command

From any MCP host, use this command:

- command: `node`
- args: `["<ABSOLUTE_PATH_TO_REPO>\\scripts\\mcp-start.cjs"]`

Quick no-clone option (GitHub via npx, slower cold start):

- command: `npx`
- args: `["-y", "--package=github:RobertoM80/browser-debug-mcp-bridge", "browser-debug-mcp-bridge"]`

Important:
- This only changes how the MCP server is started.
- You still need the Chrome extension loaded and connected to `127.0.0.1:8065`.

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
1. Run `pnpm install`
2. Add block above to `.codex/config.toml`
3. Restart Codex client
4. Confirm tools like `list_sessions` are visible

Optional Codex GitHub npx config:

```toml
[mcp_servers.browser_debug]
command = "npx"
args = ["-y", "--package=github:RobertoM80/browser-debug-mcp-bridge", "browser-debug-mcp-bridge"]
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
1. Run `pnpm install`
2. Paste JSON block in `%APPDATA%\\Claude\\claude_desktop_config.json`
3. Restart Claude Desktop
4. Confirm MCP server `browser-debug` is connected

## Cursor / Windsurf / other MCP hosts

Use the same `command` + `args` values in that client's MCP server config UI/JSON.

Quick checklist:
1. Run `pnpm install`
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

1. Start MCP host (it will spawn `node <repo>\\scripts\\mcp-start.cjs`).
2. Open extension popup, set allowlist, start session.
3. Ask LLM to call `list_sessions`.
4. Ask LLM to call `capture_ui_snapshot` with `sessionId`.
5. Verify with `list_snapshots` or extension DB Viewer snapshots table.

## CI safety check (stdio guard)

To verify the stdio safety guards are still present in source:

```bash
pnpm mcp:check-stdio-guard
```
