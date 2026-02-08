# V3 Correlation Tools

## `explain_last_failure`

Returns a reasoned timeline linking:

- last meaningful user action
- nearby network failures
- correlated runtime/console errors

```json
{ "name": "explain_last_failure", "arguments": { "sessionId": "sess_123" } }
```

## `get_event_correlation`

Returns related entities for a specific event id with relationship scoring.

```json
{ "name": "get_event_correlation", "arguments": { "sessionId": "sess_123", "eventId": "evt_456" } }
```

Use this after V1/V2 evidence is gathered to explain likely causality, not just chronology.
