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

## Limits and fallback

- `maxBytes` and depth caps are always enforced.
- Timeout fallback may return outline-style output instead of full HTML.
- Redaction still applies before response is returned.
