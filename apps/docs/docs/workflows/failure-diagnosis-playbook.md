# Failure Diagnosis Playbook

## Goal

Produce a defensible explanation for a user-visible failure using captured evidence.

## Workflow

1. Identify candidate session with `list_sessions`
2. Prefer session ids where `liveConnection.recommendedForLiveCapture` is `true`
3. If choice is unclear, inspect `get_live_session_health`
4. Pull scope with `get_session_summary`
5. Inspect recent telemetry via `get_recent_events`
6. Isolate failed requests with `get_network_failures`
7. Inspect live logs with `get_live_console_logs` (optional filters: `url`, `levels`, `contains`)
8. Correlate timeline with `explain_last_failure`
9. Request targeted heavy evidence (`get_dom_subtree`, `get_layout_metrics`, `get_computed_styles`)

If a live tool returns `LIVE_SESSION_DISCONNECTED`, restart/reconnect extension session and re-check `get_live_session_health` before retrying.

## Output format

Provide:

- observed failure
- likely cause
- confidence level
- next tool call for confirmation

## Guardrails

- Keep captures scoped to minimal selectors
- Respect safe mode and allowlist policies
- Avoid repeated full-document captures unless required
