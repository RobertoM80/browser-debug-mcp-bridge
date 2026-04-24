# V1 Query Tools

## Session and URL Filters

For `get_recent_events`, `get_navigation_history`, `get_console_events`, `get_network_failures`, and `get_network_calls`:

- You can pass `sessionId`, `url`, or both.
- `url` is normalized to origin (`scheme://host:port`).
- `sessionId + url` applies intersection filtering.
- `url` without `sessionId` searches across sessions.
- Invalid/non-absolute URLs are rejected. Use full values like `http://localhost:3000`.

High-volume queries support `maxResponseBytes` (default `32768`) and return pagination metadata with `hasMore` and `nextOffset`.

## `list_sessions`

```json
{ "name": "list_sessions", "arguments": { "sinceMinutes": 60 } }
```

Response guidance:

- `lastSeenAt` is the server's best session activity timestamp; ordering/filtering now prefers this over raw `createdAt`
- `scope.kind` helps distinguish app pages from likely third-party iframe/ad noise
- `liveConnection.connected` is the strongest positive signal for live capture tools, but it is not the only health signal
- `liveConnection.status` can be `connected`, `likely_stale`, `disconnected`, `paused`, or `ended`
- `liveConnection.recommendedForLiveCapture` is the safest field to follow when choosing a live session

## `get_live_session_health`

```json
{ "name": "get_live_session_health", "arguments": { "sessionId": "sess_123" } }
```

Use this when `list_sessions` is ambiguous. It combines persisted activity, websocket heartbeats, and URL scope assessment into one health record with `nextAction`.

## `get_session_summary`

```json
{ "name": "get_session_summary", "arguments": { "sessionId": "sess_123" } }
```

## `get_recent_events`

```json
{
  "name": "get_recent_events",
  "arguments": {
    "sessionId": "sess_123",
    "eventTypes": ["error", "network"],
    "limit": 50,
    "responseProfile": "compact",
    "maxResponseBytes": 32768
  }
}
```

Backward compatibility note: `types` is still accepted as an alias.
Compact profile note: by default compact rows omit full `payload`; set `includePayload: true` to include it.

URL-only example:

```json
{
  "name": "get_recent_events",
  "arguments": { "url": "http://localhost:3000", "eventTypes": ["error", "network"], "limit": 50 }
}
```

## `get_navigation_history`

```json
{
  "name": "get_navigation_history",
  "arguments": { "sessionId": "sess_123", "limit": 25, "responseProfile": "compact", "maxResponseBytes": 32768 }
}
```

```json
{ "name": "get_navigation_history", "arguments": { "url": "http://localhost:3000", "limit": 25 } }
```

## `get_console_events`

```json
{
  "name": "get_console_events",
  "arguments": { "sessionId": "sess_123", "level": "error", "limit": 25, "responseProfile": "compact", "maxResponseBytes": 32768 }
}
```

Capture notes:

- Typical levels emitted from page console hooks are `log`, `info`, `warn`, `error`, `debug`, `trace`.
- Runtime exceptions are available as `error` events (query via `get_recent_events` with `eventTypes: ["error"]`).
- DevTools UI-only/browser-internal messages are not guaranteed to be present.
- For server-side substring filtering (for example `"[auth]"`), use `get_live_console_logs`.

## `get_console_summary`

```json
{
  "name": "get_console_summary",
  "arguments": { "sessionId": "sess_123", "sinceMinutes": 60, "limit": 10 }
}
```

Returns aggregated console diagnostics: total count, per-level counters, and top repeated messages.

## `get_event_summary`

```json
{
  "name": "get_event_summary",
  "arguments": { "sessionId": "sess_123", "sinceMinutes": 60, "limit": 20 }
}
```

Returns aggregate event volume and grouped type distribution.

```json
{
  "name": "get_console_events",
  "arguments": { "sessionId": "sess_123", "url": "http://localhost:3000", "level": "error", "limit": 25 }
}
```

## `get_error_fingerprints`

```json
{ "name": "get_error_fingerprints", "arguments": { "sessionId": "sess_123", "limit": 20, "offset": 0 } }
```

## `get_network_failures`

```json
{
  "name": "get_network_failures",
  "arguments": { "sessionId": "sess_123", "groupBy": "domain", "limit": 20, "offset": 0 }
}
```

## `get_network_calls`

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

## `wait_for_network_call`

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

## `get_request_trace`

```json
{
  "name": "get_request_trace",
  "arguments": { "sessionId": "sess_123", "requestId": "req_456", "includeBodies": true }
}
```

## `get_body_chunk`

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

Origin-only network failure query (no session filter):

```json
{
  "name": "get_network_failures",
  "arguments": { "url": "http://localhost:3000", "groupBy": "domain", "limit": 20, "offset": 0 }
}
```

## `get_element_refs`

```json
{ "name": "get_element_refs", "arguments": { "sessionId": "sess_123", "limit": 30, "offset": 0 } }
```

See [limits and redaction behavior](../reference/limits-and-redaction.md).
