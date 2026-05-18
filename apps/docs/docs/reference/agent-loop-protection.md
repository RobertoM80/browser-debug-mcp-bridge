# Agent Loop Protection

The MCP server includes a loop guard for repeated agent tool calls. It is designed to stop credit-draining loops where an agent keeps calling the same failing tool with unchanged inputs and unchanged browser or override state.

## What Is Tracked

Every guarded tool attempt is stored in `mcp_tool_invocations` with a redacted input summary, normalized input hash, session id, tool family, outcome, root-cause code, state hash, duration, response size, and warning/block marker.

When repeated attempts cross the threshold, the server opens a row in `mcp_loop_incidents`. Incidents are scoped either to:

1. the same tool plus same normalized input, or
2. the same tool family plus same root cause for high-risk override workflows.

Successful calls resolve matching open incidents.

## Guarded Workflows

The guard is strongest around tools that can spend repeated live browser or planning calls:

- `enable_overrides`
- `disable_overrides`
- `observe_override_assets`
- `capture_override_response_body`
- `plan_override_response_patch`
- `plan_next_source_override`
- `map_next_override_assets`
- `execute_ui_action`
- `run_ui_steps`

High-risk tools warn on the second unchanged failure and block before another repeated side-effecting attempt after the block threshold is reached.

## Response Contract

Warnings are attached to the original tool response as `loopGuard`. Blocks are returned as normal MCP tool responses:

```json
{
  "blocked": true,
  "tool": "enable_overrides",
  "loopGuard": {
    "status": "blocked",
    "reason": "repeated_same_failure",
    "scope": "tool-input",
    "rootCauseCode": "TARGET_ASSET_NOT_OBSERVED",
    "requiredStateChange": ["target route is loaded or interacted with", "observed asset inventory changes"]
  },
  "nextActions": [
    {
      "code": "CHANGE_STATE_BEFORE_RETRY",
      "message": "Blocked repeated enable_overrides attempts with unchanged TARGET_ASSET_NOT_OBSERVED result before spending another tool call."
    }
  ]
}
```

Blocked responses are intentional safety responses. They do not mean the MCP transport failed.

## Recovery

When `loopGuard` appears, change real state before retrying:

- reconnect or rebind the live session
- load or interact with the target route
- observe assets again after navigation
- edit or regenerate the override profile
- change the target tab, session, selector, locator, or config path
- inspect diagnostics with `get_live_session_health`, `preflight_overrides`, `diagnose_overrides`, or page-state tools

The guard can be disabled for controlled diagnostics with `MCP_LOOP_GUARD=0`.
