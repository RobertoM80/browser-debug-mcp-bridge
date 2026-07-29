# Install And MCP Client Setup

This page covers both fast no-repo setup and local development setup.

Studio or MCPS is optional. The package ships a first-class stdio launcher, so any MCP host with command/args server configuration can use Browser Debug MCP Bridge directly. Its compact catalog exposes `list_sessions` and the on-demand `browser_debug` entry point; `browser_debug` can find and execute every other tool. Set `MCP_TOOL_CATALOG=full` only for clients that require all tools to be advertised up front.

## 1) Quick setup (no repo clone, recommended)

Install runtime:

```bash
npm i -g browser-debug-mcp-bridge
```

This install provides both `browser-debug-mcp-bridge` and `bdmcp`. Verify the CLI before use:

```bash
bdmcp --help
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

A clone is not added to `PATH`. Build and invoke its CLI directly:

```bash
pnpm build:mcp-runtime
node scripts/browser-debug-cli.cjs health
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

If Copilot MCP servers are disabled by organization policy but terminal commands are allowed, use the packaged CLI workflow:

```bash
bdmcp --help
browser-debug-mcp-bridge --standalone
bdmcp init-copilot
bdmcp health
bdmcp sessions --live
```

See [Copilot CLI Workflow](./copilot-cli-workflow.md).

Notes:

1. Keep `-y` in `npx` MCP host configs. Without it, npm can wait for an interactive install confirmation that VS Code Copilot and other MCP hosts cannot answer.
2. First run is slower because dependencies are downloaded.
3. For stable daily usage, prefer local clone + `node <repo>/scripts/mcp-start.cjs`.
4. You still need the Chrome extension loaded; this option only changes server startup.
5. If npm reports `EPERM` under `npm-cache\\_cacache\\tmp\\git-clone...`, use local mode instead.
6. On Windows, launcher attempts automatic recovery when stale bridge processes still hold port `8065`.
7. In `mcp-stdio` mode, runtime should stop when the MCP host transport closes.
8. Runtime state now defaults to a user-local app-data directory instead of the repo/package root. Set `DATA_DIR` only if you want to override it.
9. If a standalone bridge is already running on `127.0.0.1:8065`, new MCP stdio launches now attach to it instead of killing and replacing it.

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
2. Prefer `sessionId` with `liveConnection.recommendedForLiveCapture = true` for live tools
3. If choice is unclear, call `get_live_session_health`
4. Call `get_session_summary`, `get_recent_events`
5. Use `get_live_console_logs` for in-memory logs and server-side `contains` filters
6. Optional origin scope: call query tools with `url` (example `http://localhost:3000`)
7. Use `capture_ui_snapshot` and `list_snapshots` when visual state is needed

## 7) Common failure points

If tools return no data:

1. No active extension session
2. Domain missing in allowlist
3. MCP config points to wrong repository path
4. MCP host process cannot find `node` in PATH
5. Session id is historical/stale or degraded (`liveConnection.status != "connected"`)
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
