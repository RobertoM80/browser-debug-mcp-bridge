# Troubleshooting

## Server does not start

- Confirm Node 20+ is installed
- Prefer direct launch path in MCP config: `command = node`, `args = ["...\\scripts\\mcp-start.cjs"]`
- If using npm mode, run `npx -y browser-debug-mcp-bridge`
- If using local clone mode:
  - confirm pnpm is installed
  - run `pnpm install`
  - run `node scripts/mcp-start.cjs`
- Check for port collisions on `8065`

Note for Windows launcher behavior:

- `scripts/mcp-start.cjs` enforces a single-instance startup lock to prevent concurrent launch races
- `scripts/mcp-start.cjs` automatically tries to recover from stale bridge processes already bound to `8065`
- If launcher prints `MCP_STARTUP_PORT_IN_USE`, reserve/free MCP port `8065` for the bridge and start again
- If launcher prints `MCP_STARTUP_LOCKED`, another launcher process is still active
- If startup still fails on `8065`, the remaining listener is likely a non-bridge process and must be stopped manually

## MCP process stays running after host exits

Expected behavior:

- In `mcp-stdio` mode, bridge should stop when MCP host transport closes

Manual recovery:

- Run `node scripts/mcp-start.cjs --stop`
- If stop fails with `MCP_STOP_PORT_OCCUPIED_BY_OTHER_APP`, the listener on `8065` is not bridge and must be handled manually

## Extension cannot connect to server

- Ensure server is running locally before starting a session
- Open the extension popup and inspect `Bridge Health` first:
  - `Transport` should settle on `connected`
  - `Session` should show an active session id after start/resume
  - `Content script` should show `Ready` or `Ready via fallback injection`
- Use popup recovery actions before deeper manual recovery:
  - `Recover session` when capture is being rejected as inactive or the session is paused/stale
  - `Retry content script` when the bound tab lost the content script
  - `Open bound tab` when you need to jump back to the tab the session is attached to
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
- If a bridge/server restart happened, give the extension a moment to reconnect; active sessions now re-announce themselves automatically
- If the same browser tab still exists, the extension now prefers rebinding that remembered session tab before falling back to the currently active tab
- Remembered session-tab bindings are now persisted across extension service-worker reloads, so short extension/background restarts should not require re-picking the tab
- Use popup `Bridge Health` to distinguish the failure mode quickly:
  - `Transport` disconnected/reconnecting means bridge connectivity is still unstable
  - `Content script` unavailable means the tab needs reload or fallback reinjection
  - rising `allowlist`, `scope`, or `safe` reject counts indicate guardrail blocks rather than transport failure
- Prefer popup recovery actions before restarting the bridge:
  - `Recover session` to resume/start from the current popup state
  - `Retry content script` to re-arm the bound tab
  - `Open bound tab` to verify the correct page is still attached
- If none are connected after reconnect settles, then resume or restart the session from the extension popup and retry

## No events appear in MCP responses

- Confirm a session is started from the popup
- Verify current site matches allowlist configuration
- Keep safe mode enabled but ensure capture is not globally disabled
- Run `list_sessions` first, then query with the returned `sessionId`
- For live console investigation, call `get_live_console_logs` with `sessionId` and optional `contains` filter

## MCP context grows too fast during debugging

Use compact/byte-budget options on high-volume tools:

- `responseProfile: "compact"` on `get_recent_events`, `get_navigation_history`, `get_console_events`, `get_live_console_logs`
- `maxResponseBytes` (default `32768`) to enforce smaller pages
- `dedupeWindowMs` on `get_live_console_logs` to collapse repeated bursts

For PNG snapshots, prefer metadata-first mode:

- `capture_ui_snapshot` with `mode: "png"` (defaults to `includeDom=false`, `includeStyles=false`, `includePngDataUrl=false`)

## Live automation is rejected or stops unexpectedly

- If `execute_ui_action` returns `automation_disabled`, enable `Allow live automation` in the extension popup and save settings again
- If it returns `sensitive_field_opt_in_required`, leave the default block in place unless you are intentionally testing a sensitive field flow; then enable the second opt-in explicitly
- If it returns an unsupported iframe/top-document error, retarget the action to an element in the top document; V1 does not execute inside iframes
- Look for the red in-page automation indicator to confirm the tab is armed; use its stop button or the popup emergency stop to disarm immediately
- After any rejected/failed action, inspect `get_recent_events` for `automation_*` rows and use `capture_ui_snapshot` or `explain_last_failure` for follow-up evidence

## Tests fail locally

- Run `pnpm install` to ensure dependencies are synced
- Re-run all tests with `pnpm test`
- Run a single project test with `pnpm nx test mcp-server`
- If native module errors appear, rebuild dependencies with `pnpm rebuild`

## Build artifacts look stale

- Remove `dist/` and rerun build targets
- Rebuild extension with `pnpm nx build chrome-extension`
- Rebuild server with `pnpm nx build mcp-server`
- If popup UI changes do not appear in Chrome, reload the unpacked extension in `chrome://extensions` and reopen the popup

## Need more diagnostics

- Check `GET /health` for service and DB status
- Check `GET /stats` for event/session counts and connection activity
- Inspect structured logs for WebSocket and MCP tool activity

## Snapshot capture not behaving as expected

- Confirm snapshot settings in extension popup: snapshots enabled, required triggers active, and opt-in requirement satisfied
- PNG snapshots are captured as full-page (not only viewport), so tall pages naturally produce larger files
- If PNG capture is skipped, check `maxImagesPerSession` quota and `minCaptureIntervalMs` throttle policy in snapshot settings
- If PNG reports `max_bytes_exceeded`, increase `maxBytesPerImage` in extension snapshot settings
- If snapshots look incomplete, verify DOM/style truncation flags and configured payload limits
- For strict safe mode, PNG can be blocked by privacy profile and DOM/style values may be redacted before persistence/export
- Verify timeline flow with MCP: `get_snapshot_for_event` for click link, then `explain_last_failure` for downstream analysis
