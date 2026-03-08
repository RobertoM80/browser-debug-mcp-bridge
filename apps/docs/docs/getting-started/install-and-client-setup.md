# Install And MCP Client Setup

This page covers both fast no-repo setup and local development setup.

## 1) Quick setup (no repo clone, recommended)

Install runtime:

```bash
npm i -g browser-debug-mcp-bridge
```

Download extension asset `chrome-extension-dist.tgz` from latest release and load unpacked in Chrome:

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click **Load unpacked**
4. Select extracted extension folder

Configure MCP host with direct Node launch:

1. Resolve npm global root: `npm root -g`
2. Set:
   1. command: `node`
   2. args: `["<NPM_GLOBAL_ROOT>/browser-debug-mcp-bridge/scripts/mcp-start.cjs"]`

## 2) Local clone setup (contributors/customization)

```bash
git clone https://github.com/<ORG_OR_USER>/browser-debug-mcp-bridge.git
cd browser-debug-mcp-bridge
pnpm install
```

## 3) Build extension and load in Chrome

```bash
pnpm nx build chrome-extension
```

Then:

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click **Load unpacked**
4. Select `dist/apps/chrome-extension`
5. After later rebuilds, use the extension `Reload` action in `chrome://extensions` so popup changes actually appear

## 4) Start runtime for MCP clients

For MCP hosts, run:

```bash
node scripts/mcp-start.cjs
```

This starts:

1. Ingest API/WebSocket on `http://127.0.0.1:8065`
2. MCP stdio tool runtime

Alternative (secondary):

1. command: `npx`
2. args: `["-y", "browser-debug-mcp-bridge"]`

GitHub fallback (if registry package is not available):

1. command: `npx`
2. args: `["-y", "--package=github:RobertoM80/browser-debug-mcp-bridge", "browser-debug-mcp-bridge"]`

Notes:

1. First run is slower because dependencies are downloaded.
2. For stable daily usage, prefer local clone + `node <repo>/scripts/mcp-start.cjs`.
3. You still need the Chrome extension loaded; this option only changes server startup.
4. If npm reports `EPERM` under `npm-cache\\_cacache\\tmp\\git-clone...`, use local mode instead.
5. On Windows, launcher attempts automatic recovery when stale bridge processes still hold port `8065`.
6. In `mcp-stdio` mode, runtime should stop when the MCP host transport closes.
7. Runtime state now defaults to a user-local app-data directory instead of the repo/package root. Set `DATA_DIR` only if you want to override it.
8. If a standalone bridge is already running on `127.0.0.1:8065`, new MCP stdio launches now attach to it instead of killing and replacing it.

Recommended durable workflow:

```bash
node scripts/mcp-start.cjs --standalone
```

Then keep MCP host config pointing at the normal launcher:

```bash
node scripts/mcp-start.cjs
```

Each new Codex/MCP host session will attach to the existing bridge on `8065`.

Manual stop command (if stale process still occupies `8065`):

```bash
node scripts/mcp-start.cjs --stop
```

One-command diagnostics:

```bash
pnpm mcp:doctor
```

It actively tries a standalone startup, waits for `/health`, and prints status plus fix commands for bridge health, launcher/runtime viability, sessions API reachability, current live session state, and Codex config. Codex current-chat MCP transport remains a host-dependent manual check.

JSON output for automation:

```bash
pnpm mcp:doctor:json
```

## 5) Generate client config snippets

```bash
pnpm mcp:print-config
```

Use output snippets directly in:

1. Codex (`.codex/config.toml`)
2. Claude Desktop config JSON
3. Cursor/Windsurf/OpenCode MCP server JSON

## 6) Session bootstrap checklist

In extension popup:

1. Add target domain to allowlist
2. Start session
3. Session starts bound to current tab only
4. Use `Session Tabs` to add/remove tabs for this session explicitly
5. Enable snapshots if your workflow needs DOM/style/PNG evidence
6. PNG snapshots are captured as full-page images; raise `Max bytes/image` if large pages hit `max_bytes_exceeded`

In MCP client:

1. Call `list_sessions`
2. Pick `sessionId` with `liveConnection.connected = true` for live tools
3. Call `get_session_summary`, `get_recent_events`
4. Use `get_live_console_logs` for in-memory logs and server-side `contains` filters
5. Optional origin scope: call query tools with `url` (example `http://localhost:3000`)
6. Use `capture_ui_snapshot` and `list_snapshots` when visual state is needed

## 7) Common failure points

If tools return no data:

1. No active extension session
2. Domain missing in allowlist
3. MCP config points to wrong repository path
4. MCP host process cannot find `node` in PATH
5. Session id is historical/stale (`liveConnection.connected = false`)
6. Event came from a tab that is not bound to the active session
7. A manual `--standalone` launcher is still running from an older terminal and is blocking MCP stdio startup

If you want a compact local report before debugging manually, run `pnpm mcp:doctor`.

## 8) One-command local setup (optional)

Windows:

```powershell
.\install.ps1
```

macOS/Linux:

```bash
bash ./install.sh
```
