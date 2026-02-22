# Install And MCP Client Setup

This page is the developer-focused setup reference for running Browser Debug MCP Bridge in real projects.

## 1) Clone and install

```bash
git clone https://github.com/<ORG_OR_USER>/browser-debug-mcp-bridge.git
cd browser-debug-mcp-bridge
pnpm install
```

## 2) Build extension and load in Chrome

```bash
pnpm nx build chrome-extension
```

Then:

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click **Load unpacked**
4. Select `dist/apps/chrome-extension`

## 3) Start runtime for MCP clients

For MCP hosts, run:

```bash
node scripts/mcp-start.cjs
```

This starts:

1. Ingest API/WebSocket on `http://127.0.0.1:8065`
2. MCP stdio tool runtime

Alternative (no local clone path in MCP config, GitHub over npx):

1. command: `npx`
2. args: `["-y", "github:RobertoM80/browser-debug-mcp-bridge"]`

Notes:

1. First run is slower because dependencies are downloaded.
2. For stable daily usage, prefer local clone + `node <repo>/scripts/mcp-start.cjs`.
3. You still need the Chrome extension loaded; this option only changes server startup.

## 4) Generate client config snippets

```bash
pnpm mcp:print-config
```

Use output snippets directly in:

1. Codex (`.codex/config.toml`)
2. Claude Desktop config JSON
3. Cursor/Windsurf/OpenCode MCP server JSON

## 5) Session bootstrap checklist

In extension popup:

1. Add target domain to allowlist
2. Start session
3. Enable snapshots if your workflow needs DOM/style/PNG evidence

In MCP client:

1. Call `list_sessions`
2. Select session id
3. Call `get_session_summary`, `get_recent_events`
4. Use `capture_ui_snapshot` and `list_snapshots` when visual state is needed

## 6) Common failure points

If tools return no data:

1. No active extension session
2. Domain missing in allowlist
3. MCP config points to wrong repository path
4. MCP host process cannot find `node` in PATH

## 7) One-command local setup (optional)

Windows:

```powershell
.\install.ps1
```

macOS/Linux:

```bash
bash ./install.sh
```
