# V6 Automation History Tools

Historical automation analysis now reads from dedicated `automation_runs` and `automation_steps` records instead of reconstructing everything from generic `ui` event breadcrumbs.

## `list_automation_runs`

Lists first-class automation runs for a session with optional status, action, and trace filters.

```json
{
  "name": "list_automation_runs",
  "arguments": {
    "sessionId": "sess_123",
    "status": "failed",
    "limit": 20
  }
}
```

### Response shape highlights

- `runs[*].runId`: stable run identifier used for step inspection
- `runs[*].stepCount`: number of persisted steps for the run
- `runs[*].failure`: run-level failure metadata when the run failed or was rejected
- `runs[*].source`: always `automation_runs` so callers can distinguish dedicated history rows from generic events

## `get_automation_run`

Returns one automation run plus bounded step details from `automation_steps`.

```json
{
  "name": "get_automation_run",
  "arguments": {
    "sessionId": "sess_123",
    "runId": "sess_123:trace-live-1",
    "stepLimit": 50,
    "stepOffset": 0
  }
}
```

### Response shape highlights

- `run`: run-level action, selector, timing, failure, and redaction metadata
- `steps[*]`: ordered step records with event linkage, target summary, failure metadata, and redacted input metadata
- `pagination`: step pagination metadata for larger runs

### Operational limits

- Both tools are session-scoped and require `sessionId`
- Step inspection is bounded by `stepLimit`, `stepOffset`, and `maxResponseBytes`
- Generic `ui` events remain useful as breadcrumbs, but dedicated automation tables are the default source of truth for historical automation debugging
