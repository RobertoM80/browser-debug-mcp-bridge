# Failure Diagnosis Playbook

## Goal

Produce a defensible explanation for a user-visible failure using captured evidence.

## Workflow

1. Identify candidate session with `list_sessions`
2. Prefer session ids where `liveConnection.connected` is `true` for live capture tools
3. Pull scope with `get_session_summary`
4. Inspect recent telemetry via `get_recent_events`
5. Isolate failed requests with `get_network_failures`
6. Inspect live logs with `get_live_console_logs` (optional filters: `url`, `levels`, `contains`)
7. Correlate timeline with `explain_last_failure`
8. Request targeted heavy evidence (`get_dom_subtree`, `get_layout_metrics`, `get_computed_styles`)

If a live tool returns `LIVE_SESSION_DISCONNECTED`, restart/reconnect extension session and pick a currently connected session id from `list_sessions`.

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
