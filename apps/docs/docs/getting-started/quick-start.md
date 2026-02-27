# Quick Start

## Prerequisites

- Node.js 20+
- Chrome with developer mode enabled
- Local extension build (from this repository)

## Install and run

```bash
pnpm install
pnpm nx serve mcp-server
pnpm nx build chrome-extension --watch
```

For MCP client integration (Codex/Claude/Cursor/Windsurf), you can use:

1. npm mode:

```bash
npx -y browser-debug-mcp-bridge
```

1. local clone mode:

```bash
node scripts/mcp-start.cjs
```

On Windows, launcher attempts automatic stale-process recovery if bridge port `8065` is occupied.

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
- For live tools, use a session with `liveConnection.connected = true`

## Next steps

- Follow [Install + MCP Client Setup](./install-and-client-setup.md)
- Follow [Local Debug Session Workflow](./local-debug-session.md)
- Review [MCP Tools Overview](../mcp-tools/overview.md)
