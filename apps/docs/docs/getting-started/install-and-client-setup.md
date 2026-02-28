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

Manual stop command (if stale process still occupies `8065`):

```bash
node scripts/mcp-start.cjs --stop
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

In MCP client:

1. Call `list_sessions`
2. Pick `sessionId` with `liveConnection.connected = true` for live tools
3. Call `get_session_summary`, `get_recent_events`
4. Optional origin scope: call query tools with `url` (example `http://localhost:3000`)
5. Use `capture_ui_snapshot` and `list_snapshots` when visual state is needed

## 7) Common failure points

If tools return no data:

1. No active extension session
2. Domain missing in allowlist
3. MCP config points to wrong repository path
4. MCP host process cannot find `node` in PATH
5. Session id is historical/stale (`liveConnection.connected = false`)
6. Event came from a tab that is not bound to the active session

## 8) One-command local setup (optional)

Windows:

```powershell
.\install.ps1
```

macOS/Linux:

```bash
bash ./install.sh
```
