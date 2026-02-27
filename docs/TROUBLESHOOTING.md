# Troubleshooting

## Server does not start

- Confirm Node 20+ is installed
- If using npm mode, run `npx -y browser-debug-mcp-bridge`
- If using local clone mode:
  - confirm pnpm is installed
  - run `pnpm install`
  - run `node scripts/mcp-start.cjs`
- Check for port collisions on `8065`

Note for Windows launcher behavior:

- `scripts/mcp-start.cjs` automatically tries to recover from stale bridge processes already bound to `8065`
- If startup still fails on `8065`, the remaining listener is likely a non-bridge process and must be stopped manually

## Extension cannot connect to server

- Ensure server is running locally before starting a session
- Verify background logs in extension service worker console
- Confirm WebSocket endpoint is reachable at `ws://127.0.0.1:8065/ws`

## Live MCP command fails on a listed session

Symptoms:

- Live tools fail even though `list_sessions` returns the session
- Error starts with `LIVE_SESSION_DISCONNECTED`

Why this happens:

- `list_sessions` includes historical sessions from DB
- Live tools require an active extension connection for that session id

What to do:

- Run `list_sessions` and pick a session where `liveConnection.connected` is `true`
- If none are connected, start/restart session from extension popup and retry

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

## Snapshot capture not behaving as expected

- Confirm snapshot settings in extension popup: snapshots enabled, required triggers active, and opt-in requirement satisfied
- If PNG capture is skipped, check `maxImagesPerSession` quota and `minCaptureIntervalMs` throttle policy in snapshot settings
- If snapshots look incomplete, verify DOM/style truncation flags and configured payload limits
- For strict safe mode, PNG can be blocked by privacy profile and DOM/style values may be redacted before persistence/export
- Verify timeline flow with MCP: `get_snapshot_for_event` for click link, then `explain_last_failure` for downstream analysis