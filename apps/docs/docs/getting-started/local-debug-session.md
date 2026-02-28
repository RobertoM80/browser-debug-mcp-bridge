# Local Debug Session Workflow

## Typical flow

1. Start server: `pnpm nx serve mcp-server`
2. Load extension build and open target page
3. Start session from popup (safe mode enabled, tab-bound by default)
4. Optional: add extra tabs from `Session Tabs` panel only when needed
5. Reproduce issue in the browser
6. Query evidence through MCP tools

## First MCP queries

```json
{ "name": "list_sessions", "arguments": { "sinceMinutes": 60 } }
```

Pick a session where `liveConnection.connected` is `true` before running live capture tools.

```json
{ "name": "get_session_summary", "arguments": { "sessionId": "sess_123" } }
```

Origin-scoped example:

```json
{ "name": "get_recent_events", "arguments": { "url": "http://localhost:3000", "limit": 50 } }
```

Live console example:

```json
{ "name": "get_live_console_logs", "arguments": { "sessionId": "sess_123", "contains": "[auth]", "limit": 100 } }
```

## Escalate only when needed

- Use V1 query tools for telemetry first
- Use V2 heavy capture tools only for focused selectors/pages
- Use V3 correlation tools to connect user action to error/network causes

If live tools fail with `LIVE_SESSION_DISCONNECTED`, restart/reconnect extension session and retry with a currently connected session id from `list_sessions`.

For deeper triage patterns, use [Troubleshooting](../troubleshooting/common-issues.md) and the correlation/snapshot MCP tools.
