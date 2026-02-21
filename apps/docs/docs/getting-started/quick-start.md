# Quick Start

## Prerequisites

- Node.js 20+
- pnpm 9+
- Chrome with developer mode enabled

## Install and run

```bash
pnpm install
pnpm nx serve mcp-server
pnpm nx build chrome-extension --watch
```

For MCP client integration (Codex/Claude/Cursor/Windsurf), use the dedicated launcher:

```bash
node scripts/mcp-start.cjs
```

## Load extension build

1. Build once: `pnpm nx build chrome-extension`
2. Open `chrome://extensions`
3. Enable Developer mode
4. Load unpacked from `dist/apps/chrome-extension`

## Verify baseline health

- Server endpoint: `GET http://127.0.0.1:8065/health`
- Optional stats endpoint: `GET http://127.0.0.1:8065/stats`
- Confirm popup shows connected status after session start
- Confirm MCP client can run `list_sessions`

## Next steps

- Follow [Install + MCP Client Setup](./install-and-client-setup.md)
- Follow [Local Debug Session Workflow](./local-debug-session.md)
- Review [MCP Tools Overview](../mcp-tools/overview.md)
