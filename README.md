# Browser Debug MCP Bridge

Chrome Extension + local Node.js MCP server that captures browser debugging telemetry from a real user session and exposes it through MCP tools.

## Why this project exists

- Debug with real browser context (logged-in sessions, feature flags, extensions)
- Store lightweight telemetry continuously, request heavy DOM data on demand
- Keep privacy-first defaults with safe mode, allowlists, and redaction

## Prerequisites

- Node.js 20+
- pnpm 9+
- Chrome (for the extension)

## Quick start

```bash
pnpm install
pnpm nx serve mcp-server
pnpm nx build chrome-extension --watch
```

Run unified ingest + MCP stdio runtime (for external MCP clients):

```bash
pnpm install
node scripts/mcp-start.cjs
```

Quick npm MCP launch (marketplace-style, after publish):

```bash
npx -y browser-debug-mcp-bridge
```

Note: npm mode starts the MCP server runtime. The Chrome extension still needs to be built/loaded separately (see "Load the extension").

GitHub fallback launch (if npm package is not available yet):

```bash
npx -y --package=github:RobertoM80/browser-debug-mcp-bridge browser-debug-mcp-bridge
```

Optional one-step setup scripts:

```bash
# Windows (PowerShell)
./install.ps1

# macOS/Linux
bash ./install.sh
```

Useful workspace commands:

```bash
pnpm typecheck
pnpm test
pnpm nx run-many -t lint
pnpm nx run-many -t build
```

Enable local pre-commit checks (typecheck + lint + test before each commit):

```bash
pnpm hooks:install
```

## Load the extension

1. Build the extension: `pnpm nx build chrome-extension`
2. Open Chrome -> `chrome://extensions`
3. Enable Developer mode
4. Click **Load unpacked**
5. Select `dist/apps/chrome-extension`

## Main docs

- Project spec: `PROJECT_INFOS.md`
- Full beginner setup guide: `HOW_TO_USE_BROWSER_DEBUG_MCP_BRIDGE.md`
- MCP tools reference: `docs/MCP_TOOLS.md`
- MCP client setup (Codex/Claude/Cursor/Windsurf): `docs/MCP_CLIENT_SETUP.md`
- GitHub Actions explained: `docs/GITHUB_ACTIONS.md`
- Security and privacy controls: `SECURITY.md`
- Troubleshooting guide: `docs/TROUBLESHOOTING.md`
- Architecture overview: `docs/ARCHITECTURE.md`
- Architecture decisions: `docs/ARCHITECTURE_DECISIONS.md`

## Repository layout

```text
apps/
  mcp-server/         Fastify + WebSocket ingest + MCP server
  chrome-extension/   MV3 extension (background/content/injected)
  viewer/             Optional UI
libs/
  shared/             Shared schemas/types/utils
  redaction/          Privacy redaction engine
  selectors/          Robust selector generation
  mcp-contracts/      MCP tool contracts and schemas 
```
