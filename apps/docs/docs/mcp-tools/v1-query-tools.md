# V1 Query Tools

## Session and URL Filters

For `get_recent_events`, `get_navigation_history`, `get_console_events`, and `get_network_failures`:

- You can pass `sessionId`, `url`, or both.
- `url` is normalized to origin (`scheme://host:port`).
- `sessionId + url` applies intersection filtering.
- `url` without `sessionId` searches across sessions.
- Invalid/non-absolute URLs are rejected. Use full values like `http://localhost:3000`.

## `list_sessions`

```json
{ "name": "list_sessions", "arguments": { "sinceMinutes": 60 } }
```

Response guidance:

- `liveConnection.connected` tells you whether a session is currently usable for live capture tools
- `liveConnection.lastHeartbeatAt` helps identify stale session ids
- Prefer session ids with `liveConnection.connected = true` before calling live tools

## `get_session_summary`

```json
{ "name": "get_session_summary", "arguments": { "sessionId": "sess_123" } }
```

## `get_recent_events`

```json
{
  "name": "get_recent_events",
  "arguments": { "sessionId": "sess_123", "eventTypes": ["error", "network"], "limit": 50 }
}
```

Backward compatibility note: `types` is still accepted as an alias.

URL-only example:

```json
{
  "name": "get_recent_events",
  "arguments": { "url": "http://localhost:3000", "eventTypes": ["error", "network"], "limit": 50 }
}
```

## `get_navigation_history`

```json
{ "name": "get_navigation_history", "arguments": { "sessionId": "sess_123", "limit": 25 } }
```

```json
{ "name": "get_navigation_history", "arguments": { "url": "http://localhost:3000", "limit": 25 } }
```

## `get_console_events`

```json
{ "name": "get_console_events", "arguments": { "sessionId": "sess_123", "level": "error", "limit": 25 } }
```

Capture notes:

- Typical levels emitted from page console hooks are `log`, `info`, `warn`, `error`, `debug`, `trace`.
- Runtime exceptions are available as `error` events (query via `get_recent_events` with `eventTypes: ["error"]`).
- DevTools UI-only/browser-internal messages are not guaranteed to be present.
- For server-side substring filtering (for example `"[auth]"`), use `get_live_console_logs`.

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
