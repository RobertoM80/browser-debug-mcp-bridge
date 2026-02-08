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

Useful workspace commands:

```bash
pnpm test
pnpm nx run-many -t lint
pnpm nx run-many -t build
```

## Load the extension

1. Build the extension: `pnpm nx build chrome-extension`
2. Open Chrome -> `chrome://extensions`
3. Enable Developer mode
4. Click **Load unpacked**
5. Select `dist/apps/chrome-extension`

## Main docs

- Project spec: `PROJECT_INFOS.md`
- MCP tools reference: `docs/MCP_TOOLS.md`
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
