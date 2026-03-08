# Troubleshooting

## Extension cannot connect to server

- Confirm server is running on `127.0.0.1:8065`
- Check popup `Bridge Health` first:
  - `Transport` should be connected
  - `Session` should show the active session after start/resume
  - `Content script` should be ready
- Try the popup recovery actions before deeper debugging:
  - `Recover session`
  - `Retry content script`
  - `Open bound tab`
- Then check background logs if the health panel still looks wrong
- Verify extension has active allowlisted domain

## Live tools fail on a listed session

Symptoms:

- `list_sessions` returns a session id, but live tools fail
- Error starts with `LIVE_SESSION_DISCONNECTED`

Actions:

- Run `list_sessions` and select a session where `liveConnection.connected` is `true`
- If the MCP bridge/server was restarted, wait briefly for the extension to reconnect; active sessions now re-announce themselves automatically
- Resume now prefers the remembered session tab when it still exists, instead of forcing the current active tab
- Remembered session-tab bindings are persisted across extension service-worker reloads, reducing the need to recreate the tab/session after a background restart
- Use popup `Bridge Health` to separate transport issues from guardrail issues:
  - disconnected/reconnecting transport means wait or resume
  - unavailable content script means reload/reinject path
  - growing reject counts point to allowlist, safe-mode, inactive-session, or tab-scope blocks
- Prefer the popup recovery actions first:
  - `Recover session` for inactive or paused capture state
  - `Retry content script` for the reinjection path
  - `Open bound tab` to jump back to the session tab
- If none are connected after reconnect settles, restart or resume the session from the extension popup and retry

## Server start fails with port conflict

- Launcher (`node scripts/mcp-start.cjs`) auto-recovers stale bridge processes on Windows when possible
- If launcher prints `MCP_STARTUP_PORT_IN_USE`, reserve/free MCP port `8065` for the bridge and retry
- If startup still fails on port `8065`, stop non-bridge listener processes manually and retry
- If Codex or another MCP host logs `MCP_STARTUP_LOCKED`, an older `--standalone` launcher still owns the bridge lock. Stop it with `node scripts/mcp-start.cjs --stop` or restart the MCP host after the launcher auto-replaces it.

## MCP process remains alive after host closes

- In `mcp-stdio` mode, process should stop when host transport closes
- If a stale bridge process remains, run `node scripts/mcp-start.cjs --stop`
- If stop reports `MCP_STOP_PORT_OCCUPIED_BY_OTHER_APP`, the listener is not bridge and must be stopped manually

## Runtime files appear in a repo or host app root

- Current launcher defaults should keep runtime state in a user-local app-data directory instead
- If you still see repo-local state, check whether `DATA_DIR` is set explicitly by your MCP host or shell profile
- Root `*.log` files are usually manual shell redirections from debugging sessions, not files created by the bridge itself

## No events in session summary

- Ensure session is started before reproducing issue
- Confirm page is allowlisted
- Check server logs for schema validation errors

## Heavy capture returns outline instead of html

- Payload exceeded max byte limit
- Capture timed out and fallback mode applied
- Narrow selector scope and retry

## Useful diagnostics

- `GET /health`
- `GET /stats`
- MCP `get_recent_events` and `get_network_failures`
- MCP `get_live_console_logs` (supports `contains` and `levels` filters for live console triage)
