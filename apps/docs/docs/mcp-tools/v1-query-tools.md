# V1 Query Tools

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
  "arguments": { "sessionId": "sess_123", "types": ["error", "network"], "limit": 50 }
}
```

## `get_navigation_history`

```json
{ "name": "get_navigation_history", "arguments": { "sessionId": "sess_123", "limit": 25 } }
```

## `get_console_events`

```json
{ "name": "get_console_events", "arguments": { "sessionId": "sess_123", "level": "error", "limit": 25 } }
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

## `get_element_refs`

```json
{ "name": "get_element_refs", "arguments": { "sessionId": "sess_123", "limit": 30, "offset": 0 } }
```

See [limits and redaction behavior](../reference/limits-and-redaction.md).
