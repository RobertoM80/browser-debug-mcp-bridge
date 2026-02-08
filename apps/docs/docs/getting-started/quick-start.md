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

## Load extension build

1. Build once: `pnpm nx build chrome-extension`
2. Open `chrome://extensions`
3. Enable Developer mode
4. Load unpacked from `dist/apps/chrome-extension`

## Verify baseline health

- Server endpoint: `GET http://127.0.0.1:3000/health`
- Optional stats endpoint: `GET http://127.0.0.1:3000/stats`
- Confirm popup shows connected status after session start

## Next steps

- Follow [Local Debug Session Workflow](./local-debug-session.md)
- Review [MCP Tools Overview](../mcp-tools/overview.md)
