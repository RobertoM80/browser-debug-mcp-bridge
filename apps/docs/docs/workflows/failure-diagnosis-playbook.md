# Failure Diagnosis Playbook

## Goal

Produce a defensible explanation for a user-visible failure using captured evidence.

## Workflow

1. Identify candidate session with `list_sessions`
2. Pull scope with `get_session_summary`
3. Inspect recent telemetry via `get_recent_events`
4. Isolate failed requests with `get_network_failures`
5. Correlate timeline with `explain_last_failure`
6. Request targeted heavy evidence (`get_dom_subtree`, `get_layout_metrics`, `get_computed_styles`)

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
