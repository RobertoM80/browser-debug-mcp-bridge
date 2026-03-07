# V5 Live Automation Tools

Live automation reuses the existing MCP -> server -> WebSocket -> extension session channel. It never opens a new browser profile, Playwright session, or external automation runtime.

## `execute_ui_action`

Executes one action at a time in the currently bound top document for a connected session.

```json
{
  "name": "execute_ui_action",
  "arguments": {
    "sessionId": "sess_123",
    "action": "click",
    "target": {
      "selector": "#checkout-submit"
    },
    "input": {
      "clickCount": 1
    },
    "captureOnFailure": {
      "enabled": true,
      "mode": "dom",
      "styleMode": "computed-lite"
    }
  }
}
```

### Supported V1 actions

- `click`
- `input`
- `focus`
- `blur`
- `scroll`
- `press_key`
- `submit`
- `reload`

### Response shape highlights

- `actionResult`: raw extension execution result with `action`, `status`, `traceId`, timestamps, target summary, and failure reason
- `tabContext`: resolved `tabId`, `frameId`, and URL used for execution
- `postActionEvidence`: optional snapshot capture result when `captureOnFailure.enabled` is set and the action fails or is rejected
- `supportedScopes`: explicit V1 guarantees (`topDocumentOnly`, `opensNewBrowserSession: false`)

### Operational limits

- V1 supports only the top document in the currently bound tab; iframe targets return an unsupported error
- Only one action should be driven at a time per session
- Live automation still respects extension allowlist, pause/disconnect state, and sensitive-field opt-in policy

### Recommended follow-up tools

- `wait_for_network_call` after clicks/submits that should trigger network activity
- `get_live_console_logs` for immediate console/runtime feedback
- `capture_ui_snapshot` for manual evidence capture or richer retry evidence
- `get_dom_document` and `get_layout_metrics` when action targeting needs debugging
- `explain_last_failure` to correlate the action with later errors and failing calls
