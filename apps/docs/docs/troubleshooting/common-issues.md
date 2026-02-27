# Troubleshooting

## Extension cannot connect to server

- Confirm server is running on `127.0.0.1:8065`
- Check popup connection state and background logs
- Verify extension has active allowlisted domain

## Live tools fail on a listed session

Symptoms:

- `list_sessions` returns a session id, but live tools fail
- Error starts with `LIVE_SESSION_DISCONNECTED`

Actions:

- Run `list_sessions` and select a session where `liveConnection.connected` is `true`
- If none are connected, restart session from extension popup and retry

## Server start fails with port conflict

- Launcher (`node scripts/mcp-start.cjs`) auto-recovers stale bridge processes on Windows when possible
- If startup still fails on port `8065`, stop non-bridge listener processes manually and retry

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
