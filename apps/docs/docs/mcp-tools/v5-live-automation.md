# V5 Live Automation Tools

Live automation reuses the existing MCP -> server -> WebSocket -> extension session channel. It never opens a new browser profile, Playwright session, or external automation runtime.

## `execute_ui_action`

Executes one action at a time in the currently bound tab for a connected session. `click`, `hover`, `input`, `press_key`, `focus`, `blur`, `scroll`, and `submit` use the CDP-backed native automation backend (`cdp-native-v2`) for the top document, open shadow roots, and same-origin iframe targets. `reload` uses the extension tab API.

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

You can target by `elementRef` instead of `selector` when the ref came from `get_interactive_elements` or `get_page_state`. Frame-scoped refs carry their frame id, so callers do not need to look up Chrome frame ids separately for same-origin iframe actions. Open shadow-root refs use `host >> target` selectors, for example `#shadow-host >> #shadow-action`.

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

You can also use semantic matchers directly. The server resolves them against compact page state, including same-origin iframe refs and open shadow-root refs.

```json
{
  "name": "execute_ui_action",
  "arguments": {
    "sessionId": "sess_123",
    "action": "click",
    "target": {
      "scope": "buttons",
      "textContains": "Confirm"
    }
  }
}
```

Semantic targets support `scope: "buttons" | "links" | "inputs" | "modals" | "focused"`, text/label/title matching, role/name/placeholder/alt matching, frame filters (`frameUrlContains`, `frameTitleContains`), `exact: true`, and deliberate disambiguation with `nth`, `first`, `last`, or `strict: false`.

```json
{
  "name": "execute_ui_action",
  "arguments": {
    "sessionId": "sess_123",
    "action": "hover",
    "target": {
      "scope": "links",
      "role": "link",
      "name": "Docs",
      "exact": true,
      "last": true
    }
  }
}
```

### Supported actions

- `click`
- `hover`
- `input`
- `focus`
- `blur`
- `scroll`
- `press_key`
- `submit`
- `reload`

### Response shape highlights

- `actionResult`: raw extension execution result with `action`, `status`, `traceId`, timestamps, target summary, and failure reason
- `actionResult.result.backend`: execution backend, currently `cdp-native-v2` for native click/hover/input/key/focus/blur/scroll/submit actions
- `tabContext`: resolved `tabId`, `frameId`, and URL used for execution
- `postActionEvidence`: optional snapshot capture result when `captureOnFailure.enabled` is set and the action fails or is rejected
- `postActionState`: optional structured wait result when `waitForPageState` is provided and the action succeeds
- `supportedScopes`: current execution guarantees (`topDocumentOnly: false`, `opensNewBrowserSession: false`)

### Operational limits

- Native automation supports the top document and same-origin iframe targets in the currently bound tab
- `get_page_state` and `get_interactive_elements` merge frame buttons/links/inputs/modals and return frame-aware refs with `frameId`/`frameUrl`/`frameTitle`
- Open shadow roots are traversed for page-state discovery and native actions. Closed shadow roots are not inspectable.
- Nested same-origin iframe actions are covered when page-state returns a frame-aware `elementRef`
- Native pointer actions in cross-origin or inaccessible frames return `unsupported_cross_origin_frame` when top-document coordinate translation is not possible
- Invalid or stale frame ids return `target_frame_not_found`
- Native actions inspect target actionability before dispatch and return structured failures for hidden, disabled, readonly input, non-editable input, unstable, outside-viewport, pointer-events none, and hit-target mismatch cases
- Page-state assertions and waits can match `visible: true` or `visible: false`, role/name fields, and frame URL/title filters on structured buttons, links, inputs, modals, and focused refs
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

- after `execute_ui_action` when the expected result is a visible button/link/input/modal state change
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
  - `scope + role/name`
  - optional refinements: `exact`, `nth`, `first`, `last`, `strict`, `placeholder`, `altText`, `frameUrlContains`, `frameTitleContains`, `tagName`, `type`, `disabled`, `selected`, `pressed`, `expanded`, `readOnly`, `requiredField`
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
