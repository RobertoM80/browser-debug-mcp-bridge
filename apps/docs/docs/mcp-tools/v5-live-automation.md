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

You can target by `elementRef` instead of `selector` when the ref came from `get_interactive_elements` or `get_page_state`.

```json
{
  "name": "execute_ui_action",
  "arguments": {
    "sessionId": "sess_123",
    "action": "click",
    "target": {
      "elementRef": "ref:..."
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
- `postActionState`: optional structured wait result when `waitForPageState` is provided and the action succeeds
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

### Combined action + wait

```json
{
  "name": "execute_ui_action",
  "arguments": {
    "sessionId": "sess_123",
    "action": "click",
    "target": {
      "selector": "#open-day"
    },
    "waitForPageState": {
      "scope": "modals",
      "titleContains": "Day plan",
      "timeoutMs": 5000,
      "pollIntervalMs": 200
    }
  }
}
```

Prefer this for common QA steps where one action should produce one visible page-state change.

## `assert_page_state`

Runs a one-shot assertion against the compact structured page model exposed by `get_page_state`.

```json
{
  "name": "assert_page_state",
  "arguments": {
    "sessionId": "sess_123",
    "scope": "buttons",
    "textContains": "Week",
    "disabled": true
  }
}
```

Response highlights:

- `matched`: whether the assertion passed
- `matchCount`: number of matching structured items
- `sampledMatches`: up to 5 matching items for quick debugging

Use this when the goal is to verify state, not inspect raw DOM.

## `wait_for_page_state`

Polls compact page state until a matcher succeeds or the timeout expires.

```json
{
  "name": "wait_for_page_state",
  "arguments": {
    "sessionId": "sess_123",
    "scope": "modals",
    "titleContains": "Day plan",
    "timeoutMs": 5000,
    "pollIntervalMs": 200
  }
}
```

Response highlights:

- `matched`: final assertion result
- `attempts`: number of polls performed
- `waitedMs`: total time spent waiting

Recommended use:

- after `execute_ui_action` when the expected result is a visible button/input/modal state change
- before falling back to `capture_ui_snapshot` or raw DOM queries

## `run_ui_steps`

Runs a small generic workflow locally in the bridge so the caller does not need one tool round trip per action.

```json
{
  "name": "run_ui_steps",
  "arguments": {
    "sessionId": "sess_123",
    "mode": "safe",
    "steps": [
      {
        "kind": "action",
        "id": "build",
        "action": "click",
        "target": {
          "scope": "buttons",
          "textContains": "Build targets"
        }
      },
      {
        "kind": "waitFor",
        "id": "wait-week",
        "matcher": {
          "scope": "buttons",
          "textContains": "Generate 7-day plan",
          "timeoutMs": 5000
        }
      },
      {
        "kind": "assert",
        "id": "assert-week",
        "matcher": {
          "scope": "buttons",
          "textContains": "Generate 7-day plan"
        }
      }
    ]
  }
}
```

Milestone 4 scope:

- modes:
  - `safe`: fuller verification and broader state capture
  - `fast`: smaller page-state captures, cached state reuse between steps, and lighter summaries
- step kinds: `action`, `waitFor`, `assert`
- action target matchers:
  - `elementRef`
  - `selector`
  - `testId`
  - `scope + textContains`
  - `scope + labelContains`
  - `scope + titleContains`
  - optional refinements: `tagName`, `type`, `disabled`, `selected`, `pressed`, `expanded`, `readOnly`, `requiredField`
- stop on first failure by default
- optional per-step `onFailure.strategy`: `stop`, `continue`, `retry_once`
- optional per-step `onFailure.capture`: collect failure evidence using UI snapshot settings

Response highlights:

- `status`, `requestedStepCount`, `completedStepCount`
- `failedStepId` and `stoppedEarly`
- `steps[]` with per-step duration, error info, execution attempts, failure policy, and optional failure evidence
- action-step target resolution includes ambiguity and not-found diagnostics with sampled candidates
- step results can include `pageChangeSummary` describing compact state changes between steps
- `workflowDiagnostics` includes retry count, state capture count, and failure capture count
- `stepCounts`, `finalPageSummary`, and `finalPage`
