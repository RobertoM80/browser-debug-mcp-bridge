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

You can target by `elementRef` instead of `selector` when the ref came from `get_interactive_elements` or `get_page_state`. Frame-scoped refs carry their frame id plus frame URL/title metadata, so callers do not need to look up Chrome frame ids separately for same-origin iframe actions. If the stored frame id is stale but the encoded frame URL/title and selector still resolve uniquely, the native backend refreshes the frame id before acting. Open shadow-root refs use `host >> target` selectors, for example `#shadow-host >> #shadow-action`.

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

For explicit locator-style targeting, use `target.locator`. Direct live actions and workflow action steps pass locator targets to the extension's native DOM resolver, which evaluates the current document, open shadow roots, and accessible frames before CDP actionability checks. The MCP server still keeps compact page-state semantic matching for non-locator targets.

```json
{
  "name": "execute_ui_action",
  "arguments": {
    "sessionId": "sess_123",
    "action": "click",
    "target": {
      "locator": {
        "scope": "buttons",
        "frame": {
          "selector": "#settings-frame",
          "titleContains": "Account"
        },
        "steps": [
          {
            "kind": "role",
            "role": "button",
            "name": {
              "pattern": "^Save",
              "flags": "i"
            }
          },
          {
            "kind": "text",
            "value": "Save changes",
            "exact": true,
            "relation": "descendant"
          }
        ]
      }
    }
  }
}
```

Locator step kinds are `css`, `role`, `text`, `label`, `testId`, `placeholder`, and `altText`. `css` and `testId` steps match exactly by default; text-like steps match by containment unless `exact: true` is set. Regex matchers use `{ "pattern": "...", "flags": "i" }`. By default each step filters the current candidate set; set `relation: "descendant"` to search descendants of the previous matches or `relation: "ancestor"` to require a matching ancestor. `locator.frame.selector` can narrow locator execution to a same-origin frame path such as `#outer-frame => #inner-frame`.

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
- `actionResult.result.framePolicy`: frame URL/origin/sandbox/same-origin metadata when the native backend inspected a frame target
- `actionResult.result.actionability`: actionability and frame-coordinate diagnostics, including `frameCoordinateResolved` and stale-ref recovery markers when applicable
- `actionResult.result.frameResolution`: frame-selection diagnostics for frame-aware targets, including stale-frame recovery, ambiguity samples, matcher inputs, and whether the target frame was chosen by frame context or selector narrowing
- `actionResult.result.locatorResolution`: native locator diagnostics for `target.locator`, including strategy, matched candidate count, selected index, and sampled candidates on not-found or ambiguous failures
- `tabContext`: resolved `tabId`, `frameId`, and URL used for execution
- `postActionEvidence`: optional snapshot capture result when `captureOnFailure.enabled` is set and the action fails or is rejected
- `postActionState`: optional structured wait result when `waitForPageState` is provided and the action succeeds
- `supportedScopes`: current execution guarantees (`topDocumentOnly: false`, `opensNewBrowserSession: false`)
- `loopGuard`: optional warning/block metadata when repeated unchanged live-action failures are detected

### Agent loop protection

The MCP server records live automation attempts and blocks repeated unchanged failures before another browser action is sent to the extension. For example, repeated `execute_ui_action` calls against the same hidden, disabled, stale-frame, or not-found target will first return `loopGuard.status: "warning"`, then `blocked_next_attempt`, and then a blocked MCP response until the target input or page/session state changes.

When this happens, do not retry the same action. Inspect page state, refresh refs, change the selector/locator, reconnect the session, or capture failure evidence before attempting the action again.

### Operational limits

- Native automation supports the top document, same-origin iframe targets, and translated pointer actions for cross-origin or sandboxed iframe targets when the frame-local point can be mapped into top-document coordinates
- `get_page_state` and `get_interactive_elements` merge frame buttons/links/inputs/modals and return frame-aware refs with `frameId`/`frameUrl`/`frameTitle` plus frame automation policy metadata
- Open shadow roots are traversed for page-state discovery and native actions. Closed shadow roots are not inspectable.
- `target.coordinates` support native click/hover in the top document and in frame-local coordinate spaces when the current frame can be translated through its selector chain.
- Nested same-origin iframe actions are covered when page-state returns a frame-aware `elementRef`
- Native pointer actions in cross-origin, sandboxed opaque-origin, or inaccessible frames return `unsupported_cross_origin_frame` or `coordinate_frame_translation_failed` when top-document coordinate translation is not possible
- Stale frame ids on frame-aware refs are re-resolved by encoded frame URL/title plus selector when possible. Invalid frame ids without enough metadata, or unresolved frame refs, return `target_frame_not_found`.
- `target.locator` now has native DOM resolution for direct/workflow actions and compact page-state semantics for server-side diagnostics. It supports chained structured filters, ancestor/descendant relations, regex matching, same-origin frame selector paths, and state filters for `visible`, `enabled`, `disabled`, `editable`, `checked`, `selected`, `pressed`, `expanded`, `readOnly`, and `requiredField`.
- Closed shadow-root selectors fail explicitly with `closed_shadow_root_unsupported`.
- Native actions inspect target actionability before dispatch and return structured failures for hidden, disabled, readonly input, non-editable input, unstable, outside-viewport, zero-size geometry, pointer-events none, hit-target mismatch, and detached-target cases. Offscreen targets now scroll into view before native pointer dispatch and return pre/post scroll diagnostics.
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

## `preflight_automation_flow`

Checks live-session readiness and production risk before a multi-step flow runs.

```json
{
  "name": "preflight_automation_flow",
  "arguments": {
    "sessionId": "sess_123",
    "expectedUrlContains": "/checkout",
    "plannedActions": ["click", "input"],
    "requireSensitiveAutomation": true
  }
}
```

Response highlights:

- `ready`: whether the flow should proceed
- `blockers`: stale/missing session, disconnected live extension, expected URL mismatch, iframe-noise session, or page-state capture failure
- `warnings`: remote/production-like origin, sensitive-looking fields, and cross-origin/inaccessible frame risks
- `checks`: compact booleans for session, live connection, expected URL, page-state capture, sensitive fields, and cross-origin frames
- `nextActions`: run guidance or blocker-specific recovery steps

Use this before running automation against remote or production-like URLs.

## First-class waits

These waits are available as standalone tools and as `run_ui_steps` `kind: "wait"` steps.

| Tool | Purpose |
| --- | --- |
| `wait_for_url` | Wait for `exactUrl`, `urlContains`, or `urlRegex`. |
| `wait_for_navigation` | Wait for a persisted navigation event by destination URL, source URL, trigger, or tab. |
| `wait_for_navigation_lifecycle` | Wait for live navigation lifecycle states such as `commit`, `same_document`, `domcontentloaded`, `load`, or `network_idle`. |
| `wait_for_load_state` | Wait for the live document readiness to reach `domcontentloaded` or `load`, optionally scoped by URL predicates. |
| `wait_for_selector_state` | Wait for a selector to become `attached`, `detached`, `visible`, or `hidden`. |
| `wait_for_console` | Wait for a live console log matching `levels` and/or `contains`. |
| `wait_for_dialog` | Wait for a native JavaScript `alert`, `confirm`, `prompt`, or `beforeunload` dialog and optionally accept or dismiss it. |
| `wait_for_stable_layout` | Wait until the page or a selector's layout snapshot stays unchanged for `stableMs`. |
| `wait_for_download` | Wait for a download to start or complete, filtered by URL or filename. |
| `wait_for_popup` | Wait for a popup tab/window opened by the bound session tab. |
| `wait_for_network_quiet` | Wait for persisted network activity to stay quiet for `quietMs`. |
| `wait_for_request` | Wait for a persisted request by URL, method, trace id, initiator, content type, or tab. |
| `wait_for_response` | Wait for a persisted response by request filters plus status, response content type, or error type. |

```json
{
  "name": "wait_for_load_state",
  "arguments": {
    "sessionId": "sess_123",
    "state": "domcontentloaded",
    "urlContains": "/dashboard",
    "timeoutMs": 5000
  }
}
```

```json
{
  "name": "wait_for_selector_state",
  "arguments": {
    "sessionId": "sess_123",
    "selector": "#save-status",
    "frameId": 0,
    "state": "visible",
    "timeoutMs": 5000
  }
}
```

```json
{
  "name": "wait_for_dialog",
  "arguments": {
    "sessionId": "sess_123",
    "type": "alert",
    "messageContains": "Saved",
    "action": "accept",
    "timeoutMs": 5000
  }
}
```

```json
{
  "name": "wait_for_stable_layout",
  "arguments": {
    "sessionId": "sess_123",
    "selector": "#save-status",
    "stableMs": 500,
    "timeoutMs": 5000
  }
}
```

```json
{
  "name": "wait_for_response",
  "arguments": {
    "sessionId": "sess_123",
    "urlContains": "/api/checkout",
    "method": "POST",
    "statusGte": 200,
    "statusLt": 300,
    "timeoutMs": 10000
  }
}
```

Common response fields:

- `matched`, `waitKind`, `attempts`, `waitedMs`
- `evidence` with final page/selector/log/network context
- timeout error codes such as `url_wait_timeout`, `navigation_wait_timeout`, `load_state_wait_timeout`, `selector_state_wait_timeout`, `console_wait_timeout`, `dialog_wait_timeout`, `stable_layout_wait_timeout`, `network_quiet_timeout`, `request_wait_timeout`, or `response_wait_timeout`

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
- step kinds: `action`, `waitFor`, `wait`, `assert`
- `waitFor` polls compact page-state matchers
- `wait` runs first-class waits with `waitKind: "url" | "navigation" | "navigation_lifecycle" | "load_state" | "selector_state" | "console" | "dialog" | "stable_layout" | "download" | "popup" | "network_quiet" | "request" | "response"`
- action target matchers:
  - `elementRef`
  - `selector`
  - `testId`
  - `scope + textContains`
  - `scope + labelContains`
  - `scope + titleContains`
  - `scope + role/name`
  - optional refinements: `locator`, `exact`, `nth`, `first`, `last`, `strict`, `placeholder`, `altText`, `frameUrlContains`, `frameTitleContains`, `tagName`, `type`, `visible`, `enabled`, `disabled`, `editable`, `checked`, `selected`, `pressed`, `expanded`, `readOnly`, `requiredField`
- stop on first failure by default
- optional per-step `onFailure.strategy`: `stop`, `continue`, `retry_once`
- optional per-step `onFailure.capture`: collect failure evidence using UI snapshot settings

Response highlights:

- `status`, `requestedStepCount`, `completedStepCount`
- `failedStepId` and `stoppedEarly`
- `steps[]` with per-step duration, error info, execution attempts, failure policy, and optional failure evidence
- action-step target resolution includes ambiguity and not-found diagnostics with sampled candidates
- `wait` steps include `wait.matched`, `wait.waitKind`, `attempts`, `waitedMs`, and wait-specific evidence under `target`
- timed-out waits now include `evidence.timeoutDiagnostics` with matcher summary and the last observed candidate when the underlying wait can provide one
- step results can include `pageChangeSummary` describing compact state changes between steps
- `workflowDiagnostics` includes retry count, state capture count, and failure capture count
- `stepCounts`, `finalPageSummary`, and `finalPage`

## Automation history

`list_automation_runs` and `get_automation_run` read from dedicated `automation_runs` and `automation_steps` tables. Rows include run/step status, trace ids, target summaries, failure metadata, redaction metadata, and native diagnostics when available. Native diagnostics can include backend, actionability, frame policy, frame resolution, locator resolution, point metadata, `failureEvidence`, `linkedSnapshot`, and raw `cdpFailure` details from the real browser action.
