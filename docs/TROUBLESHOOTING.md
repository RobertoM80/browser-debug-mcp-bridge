# Troubleshooting

## Server does not start

- Confirm Node 20+ and pnpm are installed
- Run `pnpm install`
- Run `pnpm nx serve mcp-server`
- Check for port collisions on `3000`

## Extension cannot connect to server

- Ensure server is running locally before starting a session
- Verify background logs in extension service worker console
- Confirm WebSocket endpoint is reachable at `ws://127.0.0.1:3000/ws`

## No events appear in MCP responses

- Confirm a session is started from the popup
- Verify current site matches allowlist configuration
- Keep safe mode enabled but ensure capture is not globally disabled
- Run `list_sessions` first, then query with the returned `sessionId`

## Tests fail locally

- Run `pnpm install` to ensure dependencies are synced
- Re-run all tests with `pnpm test`
- Run a single project test with `pnpm nx test mcp-server`
- If native module errors appear, rebuild dependencies with `pnpm rebuild`

## Build artifacts look stale

- Remove `dist/` and rerun build targets
- Rebuild extension with `pnpm nx build chrome-extension`
- Rebuild server with `pnpm nx build mcp-server`

## Need more diagnostics

- Check `GET /health` for service and DB status
- Check `GET /stats` for event/session counts and connection activity
- Inspect structured logs for WebSocket and MCP tool activity
