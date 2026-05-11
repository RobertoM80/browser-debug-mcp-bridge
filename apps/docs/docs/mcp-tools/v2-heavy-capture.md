# V2 Heavy Capture Tools

Heavy capture is server-orchestrated and extension-executed through command/response messages.

## `get_dom_subtree`

```json
{
  "name": "get_dom_subtree",
  "arguments": { "sessionId": "sess_123", "selector": "#checkout-form", "maxDepth": 5, "maxBytes": 120000 }
}
```

## `get_dom_document`

```json
{ "name": "get_dom_document", "arguments": { "sessionId": "sess_123", "mode": "outline", "maxBytes": 200000 } }
```

## `get_computed_styles`

```json
{
  "name": "get_computed_styles",
  "arguments": { "sessionId": "sess_123", "selector": ".submit-button", "properties": ["display", "visibility", "opacity"] }
}
```

## `get_layout_metrics`

```json
{ "name": "get_layout_metrics", "arguments": { "sessionId": "sess_123", "selector": ".modal" } }
```

## `get_page_state`

Use this before raw DOM capture when you need a compact page model for buttons, fields, and open modals.

```json
{
  "name": "get_page_state",
  "arguments": {
    "sessionId": "sess_123",
    "maxItems": 40,
    "maxTextLength": 80,
    "includeButtons": true,
    "includeInputs": true,
    "includeModals": true
  }
}
```

Returned sections are intentionally compact:

- `summary`
- `buttons`
- `inputs`
- `modals`
- `viewport`

## `get_interactive_elements`

Returns compact live refs for interactive elements so later automation can target `elementRef` instead of rebuilding selectors.

```json
{
  "name": "get_interactive_elements",
  "arguments": {
    "sessionId": "sess_123",
    "kinds": ["buttons", "inputs", "focused"],
    "maxItems": 20
  }
}
```

## `set_viewport`

Resizes the live browser window for responsive QA and returns the resulting viewport metrics.

```json
{
  "name": "set_viewport",
  "arguments": {
    "sessionId": "sess_123",
    "width": 390,
    "height": 844
  }
}
```

## `get_live_console_logs`

Reads session-scoped live console logs from extension memory (non-persistent).

```json
{
  "name": "get_live_console_logs",
  "arguments": {
    "sessionId": "sess_123",
    "url": "http://localhost:3000",
    "levels": ["info", "error"],
    "contains": "[auth]",
    "dedupeWindowMs": 1000,
    "responseProfile": "compact",
    "maxResponseBytes": 32768,
    "sinceTs": 1730200000000,
    "limit": 100
  }
}
```

Compact profile returns minimal rows (`timestamp`, `level`, `message`) and supports optional `includeArgs`.

## `capture_ui_snapshot`

`mode: "png"` now defaults to metadata-first responses:

- `includeDom: false`
- `includeStyles: false`
- `includePngDataUrl: false`

Use those flags to opt in to heavier payload sections when needed.

## Limits and fallback

- `maxBytes` and depth caps are always enforced.
- `maxResponseBytes` is available for high-volume live log reads.
- Timeout fallback may return outline-style output instead of full HTML.
- Redaction still applies before response is returned.
- Live console logs are bounded by in-memory ring buffer size and `limit`.
- `get_page_state` is the preferred lower-token option for common QA/state inspection flows.
