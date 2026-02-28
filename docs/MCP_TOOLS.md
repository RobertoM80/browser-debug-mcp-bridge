# MCP Tools Reference

All tool responses include:

- `sessionId`
- `limitsApplied`
- `redactionSummary`

## Session scope and URL filtering

Session capture is tab-bound by default:

- Starting a session binds capture to the active tab only
- Unbound tabs are rejected
- Additional tabs must be added explicitly from popup `Session Tabs`

For `get_recent_events`, `get_navigation_history`, `get_console_events`, and `get_network_failures`:

- pass `sessionId`, `url`, or both
- `url` is normalized to origin (`scheme://host:port`)
- `sessionId + url` applies intersection filtering
- `url` without `sessionId` searches across sessions
- invalid/non-absolute URLs are rejected (use `http://localhost:3000`)

## V1 Query tools

### list_sessions

Lists recent sessions and includes live connection metadata so you can distinguish historical sessions from actively connected extension sessions.

Example:

```json
{ "name": "list_sessions", "arguments": { "sinceMinutes": 60 } }
```

Important response fields per session:

- `liveConnection.connected`: `true` only when the extension session is currently reachable for live capture commands
- `liveConnection.lastHeartbeatAt`: latest websocket heartbeat/message timestamp seen by the server
- `liveConnection.disconnectReason`: best-known disconnect reason when no longer connected

Use this rule for live tools (`get_dom_document`, `capture_ui_snapshot`, etc.):

- Prefer sessions where `liveConnection.connected` is `true`

### get_session_summary

Returns per-session counts and time range.

```json
{ "name": "get_session_summary", "arguments": { "sessionId": "sess_123" } }
```

### get_recent_events

Returns event stream entries with optional type filtering.

```json
{
  "name": "get_recent_events",
  "arguments": { "sessionId": "sess_123", "eventTypes": ["error", "network"], "limit": 50 }
}
```

Backward compatibility note: `types` is still accepted as an alias.

### get_navigation_history

Returns recent navigation events.

```json
{ "name": "get_navigation_history", "arguments": { "sessionId": "sess_123", "limit": 25 } }
```

### get_console_events

Returns console events filtered by level.

```json
{ "name": "get_console_events", "arguments": { "sessionId": "sess_123", "level": "error", "limit": 25 } }
```

Current capture source:

- captures page JavaScript console calls (`console.log`, `console.warn`, `console.error`)
- captures runtime JS errors via `window.onerror`/`unhandledrejection` as `error` events
- does not mirror every DevTools UI-only/browser-internal console row

### get_error_fingerprints

Returns grouped errors by fingerprint.

```json
{ "name": "get_error_fingerprints", "arguments": { "sessionId": "sess_123", "limit": 20, "offset": 0 } }
```

### get_network_failures

Returns failed network requests with optional grouping.

```json
{
  "name": "get_network_failures",
  "arguments": { "sessionId": "sess_123", "groupBy": "domain", "limit": 20, "offset": 0 }
}
```

### get_element_refs

Returns selector references associated with captured UI events.

```json
{ "name": "get_element_refs", "arguments": { "sessionId": "sess_123", "limit": 30, "offset": 0 } }
```

## V2 Heavy on-demand tools

### get_dom_subtree

Captures a reduced DOM subtree for a selector.

```json
{
  "name": "get_dom_subtree",
  "arguments": {
    "sessionId": "sess_123",
    "selector": "#checkout-form",
    "maxDepth": 5,
    "maxBytes": 120000
  }
}
```

### get_dom_document

Captures full document in `outline` or `html` mode under strict limits.

```json
{ "name": "get_dom_document", "arguments": { "sessionId": "sess_123", "mode": "outline", "maxBytes": 200000 } }
```

### get_computed_styles

Returns only requested CSS properties.

```json
{
  "name": "get_computed_styles",
  "arguments": {
    "sessionId": "sess_123",
    "selector": ".submit-button",
    "properties": ["display", "visibility", "opacity", "z-index"]
  }
}
```

### get_layout_metrics

Returns layout and bounding-box metrics for a selector.

```json
{ "name": "get_layout_metrics", "arguments": { "sessionId": "sess_123", "selector": ".modal" } }
```

### Live capture disconnection behavior

When a listed session is not currently connected, live tools return a normalized disconnection error that starts with:

- `LIVE_SESSION_DISCONNECTED`

This indicates the session is historical/stale or transport was dropped. Start/reconnect a live session in the extension and retry with a session id where `liveConnection.connected` is `true`.

## V3 Correlation tools

### explain_last_failure

Builds a timeline linking user actions, network failures, and runtime errors.

```json
{ "name": "explain_last_failure", "arguments": { "sessionId": "sess_123" } }
```

### get_event_correlation

Returns correlated entities for a specific event id.

```json
{ "name": "get_event_correlation", "arguments": { "sessionId": "sess_123", "eventId": "evt_456" } }
```
