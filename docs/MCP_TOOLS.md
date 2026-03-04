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

For `get_recent_events`, `get_navigation_history`, `get_console_events`, `get_network_failures`, and `get_network_calls`:

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

- captures page JavaScript console calls (`console.log`, `console.info`, `console.warn`, `console.error`, `console.debug`, `console.trace`)
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

### get_network_calls

Returns targeted network calls (not only failures), with optional request/response body metadata and sanitized inline JSON/text.

```json
{
  "name": "get_network_calls",
  "arguments": {
    "sessionId": "sess_123",
    "method": "POST",
    "urlContains": "/api/v1/messages",
    "includeBodies": true,
    "limit": 20
  }
}
```

### wait_for_network_call

Waits for the next matching call in a connected flow, avoiding manual polling loops.

```json
{
  "name": "wait_for_network_call",
  "arguments": {
    "sessionId": "sess_123",
    "urlPattern": "/api/v1/messages",
    "method": "POST",
    "timeoutMs": 15000,
    "includeBodies": true
  }
}
```

### get_request_trace

Returns request-trace correlation for one `requestId`/`traceId`, including related UI events and network chain.

```json
{
  "name": "get_request_trace",
  "arguments": { "sessionId": "sess_123", "requestId": "req_456", "includeBodies": true }
}
```

### get_body_chunk

Fetches chunked body payload for rows that expose `bodyChunkRef`.

```json
{
  "name": "get_body_chunk",
  "arguments": { "chunkRef": "req_456:response:...", "offset": 0, "limit": 65536 }
}
```

Tool boundaries:
- `get_recent_events`: broad timeline across event types.
- `get_network_failures`: failure-focused triage and grouping.
- `get_network_calls`: targeted request search with method/status/time filters and optional bodies.
- `wait_for_network_call`: deterministic "next matching call" for repro flows.
- `get_request_trace`: correlation chain for one request/trace across UI + network.

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

### get_live_console_logs

Reads session-scoped live console logs from extension memory (non-persistent buffer).

Filters:

- required: `sessionId`
- optional: `url` (origin), `tabId`, `levels`, `contains`, `sinceTs`, `limit`

```json
{
  "name": "get_live_console_logs",
  "arguments": {
    "sessionId": "sess_123",
    "url": "http://localhost:3000",
    "levels": ["info", "error"],
    "contains": "[auth]",
    "limit": 100
  }
}
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
