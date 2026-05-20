# Network Blocking Tools

Network blocking tools let an MCP client temporarily fail matching browser requests in a live extension session. Use them to test what happens when an API, script, image, or other endpoint is unavailable.

These tools are state-changing. Keep runs short and always disable blocking when the diagnostic step is complete.

## Tool Set

- `enable_network_blocking`
- `disable_network_blocking`
- `get_network_blocking_status`
- `get_network_block_log`

## Runtime Behavior

- Blocking is scoped to one live extension session and selected tab.
- The extension uses Chrome Debugger Protocol request interception and fails matching `Fetch.requestPaused` requests with `Fetch.failRequest`.
- The default Chrome failure reason is `BlockedByClient`.
- Blocked requests are persisted in `network_blocking_requests`.
- A synthetic persisted network event is also recorded with `errorType: "blocked"` so existing network failure tools can show the failure.
- V1 does not run at the same time as the override POC on the same tab. Disable overrides before enabling network blocking, and disable network blocking before enabling overrides or CDP response-body capture.
- Active blocking is disabled when the session stops, pauses, loses its final bound tab, or the extension service worker suspends.

## Enable Blocking

```json
{
  "name": "enable_network_blocking",
  "arguments": {
    "sessionId": "sess_123",
    "tabId": 7,
    "rules": [
      {
        "ruleId": "checkout-api",
        "urlContains": "/api/checkout",
        "method": "POST",
        "resourceTypes": ["fetch"],
        "errorReason": "BlockedByClient"
      }
    ],
    "reload": false,
    "clearCache": true,
    "bypassServiceWorker": true
  }
}
```

Each rule requires one matcher:

- `exactUrl`: absolute HTTP(S) URL
- `urlContains`: case-sensitive URL substring
- `urlRegex`: JavaScript regular expression

Optional filters:

- `method`
- `resourceTypes`: `document`, `script`, `xhr`, `fetch`, `image`, `stylesheet`, `font`, `media`, `websocket`, or `other`
- `errorReason`: `BlockedByClient`, `Failed`, `Aborted`, or `TimedOut`

## Inspect Status

```json
{
  "name": "get_network_blocking_status",
  "arguments": {
    "sessionId": "sess_123"
  }
}
```

When the live extension is connected, status comes from the active controller. If live status is unavailable and persisted audit data exists, the response uses `statusSource: "persisted-audit"` and includes `latestRun`.

## Inspect Blocked Requests

```json
{
  "name": "get_network_block_log",
  "arguments": {
    "sessionId": "sess_123",
    "ruleId": "checkout-api",
    "method": "POST",
    "limit": 20
  }
}
```

Filters:

- `runId`
- `ruleId`
- `urlContains`
- `method`
- `limit`
- `offset`
- `maxResponseBytes`

Use `get_network_failures` after a run if you want to group the resulting `blocked` network failures with other failures.

## Disable Blocking

```json
{
  "name": "disable_network_blocking",
  "arguments": {
    "sessionId": "sess_123"
  }
}
```

Run this even when the test page already shows the expected failure. It detaches the debugger, restores cache/service-worker settings, and persists a terminal audit run.
