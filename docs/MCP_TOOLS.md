# MCP Tools Reference

All tool responses include:

- `sessionId`
- `limitsApplied`
- `redactionSummary`
- `responseBytes` (serialized byte size estimate for observability)
- optional `loopGuard` when repeated unchanged failures are detected or blocked

High-volume query tools also support:

- `maxResponseBytes` input (soft byte budget, default `32768`)
- pagination metadata with `hasMore` and `nextOffset`

## Agent loop protection

The MCP server records recent tool attempts in `mcp_tool_invocations` and opens `mcp_loop_incidents` when an agent repeats the same failing call without changing the underlying state. High-risk live tools such as override enable/capture/planning and live automation warn on the second unchanged failure and block before the next repeated side-effecting attempt after the threshold is reached.

Blocked responses are normal MCP tool responses, not transport failures:

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

When `loopGuard.status` is `warning` or `blocked_next_attempt`, stop retrying the same tool/input and change real state first: reconnect the live session, load the route, observe assets, edit the override config, or change the target/session. The guard can be disabled only for controlled diagnostics with `MCP_LOOP_GUARD=0`.

## Session scope and URL filtering

Session capture is tab-bound by default:

- Starting a session binds capture to the active tab only
- Unbound tabs are rejected
- Additional tabs must be added explicitly from popup `Session Tabs`

For `get_recent_events`, `get_navigation_history`, `get_console_events`, `get_network_failures`, and `get_network_calls`:

- pass `sessionId`, `url`, or both
- `url` is normalized to origin (`scheme://host:port`)
- `sessionId + url` applies intersection filtering
- `url` without `sessionId` searches across sessions
- invalid/non-absolute URLs are rejected (use `http://localhost:3000`)

## V1 Query tools

### list_sessions

Lists recent sessions and includes live connection metadata so you can distinguish historical sessions from actively connected extension sessions.

Example:

```json
{ "name": "list_sessions", "arguments": { "sinceMinutes": 60 } }
```

Important response fields per session:

- `lastSeenAt`: best-known activity timestamp for the session
- `scope.kind`: quick URL-based hint (`top_level_page`, `likely_iframe_noise`, `unknown`)
- `liveConnection.connected`: `true` only when the extension session is currently reachable for live capture commands
- `liveConnection.lastHeartbeatAt`: latest websocket heartbeat/message timestamp seen by the server
- `liveConnection.status`: `connected`, `likely_stale`, `disconnected`, `paused`, or `ended`
- `liveConnection.disconnectReason`: best-known disconnect reason when no longer connected
- `liveConnection.recommendedForLiveCapture`: safest field to use when choosing a live session
- `status`: `active`, `paused`, or `ended`
- `pausedAt`: pause timestamp when `status` is `paused`

Use this rule for live tools (`get_dom_document`, `capture_ui_snapshot`, etc.):

- Prefer sessions where `liveConnection.recommendedForLiveCapture` is `true`

### get_live_session_health

Use this when `list_sessions` is ambiguous or a listed session still fails live tools.

```json
{ "name": "get_live_session_health", "arguments": { "sessionId": "sess_123" } }
```

### get_session_summary

Returns per-session counts and time range.

```json
{ "name": "get_session_summary", "arguments": { "sessionId": "sess_123" } }
```

### get_recent_events

Returns event stream entries with optional type filtering.

```json
{
  "name": "get_recent_events",
  "arguments": {
    "sessionId": "sess_123",
    "eventTypes": ["error", "network"],
    "limit": 50,
    "responseProfile": "compact",
    "maxResponseBytes": 32768
  }
}
```

Backward compatibility note: `types` is still accepted as an alias.
Compact note: `payload` is omitted by default; set `includePayload: true` to include full payload rows.

### get_navigation_history

Returns recent navigation events.

```json
{ "name": "get_navigation_history", "arguments": { "sessionId": "sess_123", "limit": 25 } }
```

### get_console_events

Returns console events filtered by level.

```json
{
  "name": "get_console_events",
  "arguments": {
    "sessionId": "sess_123",
    "level": "error",
    "limit": 25,
    "responseProfile": "compact",
    "maxResponseBytes": 32768
  }
}
```

Current capture source:

- captures page JavaScript console calls (`console.log`, `console.info`, `console.warn`, `console.error`, `console.debug`, `console.trace`)
- captures runtime JS errors via `window.onerror`/`unhandledrejection` as `error` events
- does not mirror every DevTools UI-only/browser-internal console row

### get_console_summary

Returns aggregated console diagnostics: total/level counters plus top repeated messages.

```json
{ "name": "get_console_summary", "arguments": { "sessionId": "sess_123", "sinceMinutes": 60, "limit": 10 } }
```

### get_event_summary

Returns aggregated event diagnostics: total count and type distribution.

```json
{ "name": "get_event_summary", "arguments": { "sessionId": "sess_123", "sinceMinutes": 60, "limit": 20 } }
```

### get_error_fingerprints

Returns grouped errors by fingerprint.

```json
{ "name": "get_error_fingerprints", "arguments": { "sessionId": "sess_123", "limit": 20, "offset": 0 } }
```

### get_network_failures

Returns failed network requests with optional grouping.

```json
{
  "name": "get_network_failures",
  "arguments": { "sessionId": "sess_123", "groupBy": "domain", "limit": 20, "offset": 0 }
}
```

### get_network_calls

Returns targeted network calls (not only failures), with optional request/response body metadata and sanitized inline JSON/text.

```json
{
  "name": "get_network_calls",
  "arguments": {
    "sessionId": "sess_123",
    "method": "POST",
    "urlContains": "/api/v1/messages",
    "includeBodies": true,
    "limit": 20
  }
}
```

### wait_for_network_call

Waits for the next matching call in a connected flow, avoiding manual polling loops.

```json
{
  "name": "wait_for_network_call",
  "arguments": {
    "sessionId": "sess_123",
    "urlPattern": "/api/v1/messages",
    "method": "POST",
    "timeoutMs": 15000,
    "includeBodies": true
  }
}
```

### get_request_trace

Returns request-trace correlation for one `requestId`/`traceId`, including related UI events and network chain.

```json
{
  "name": "get_request_trace",
  "arguments": { "sessionId": "sess_123", "requestId": "req_456", "includeBodies": true }
}
```

### get_body_chunk

Fetches chunked body payload for rows that expose `bodyChunkRef`.

```json
{
  "name": "get_body_chunk",
  "arguments": { "chunkRef": "req_456:response:...", "offset": 0, "limit": 65536 }
}
```

Tool boundaries:

- `get_recent_events`: broad timeline across event types.
- `get_network_failures`: failure-focused triage and grouping.
- `get_network_calls`: targeted request search with method/status/time filters and optional bodies.
- `wait_for_network_call`: deterministic "next matching call" for repro flows.
- `get_request_trace`: correlation chain for one request/trace across UI + network.

### get_element_refs

Returns selector references associated with captured UI events.

```json
{ "name": "get_element_refs", "arguments": { "sessionId": "sess_123", "limit": 30, "offset": 0 } }
```

## V2 Heavy on-demand tools

### get_dom_subtree

Captures a reduced DOM subtree for a selector.

```json
{
  "name": "get_dom_subtree",
  "arguments": {
    "sessionId": "sess_123",
    "selector": "#checkout-form",
    "maxDepth": 5,
    "maxBytes": 120000
  }
}
```

### get_dom_document

Captures full document in `outline` or `html` mode under strict limits.

```json
{ "name": "get_dom_document", "arguments": { "sessionId": "sess_123", "mode": "outline", "maxBytes": 200000 } }
```

### get_computed_styles

Returns only requested CSS properties.

```json
{
  "name": "get_computed_styles",
  "arguments": {
    "sessionId": "sess_123",
    "selector": ".submit-button",
    "properties": ["display", "visibility", "opacity", "z-index"]
  }
}
```

### get_layout_metrics

Returns layout and bounding-box metrics for a selector.

```json
{ "name": "get_layout_metrics", "arguments": { "sessionId": "sess_123", "selector": ".modal" } }
```

### get_page_state

Returns a compact structured page model so flows can avoid repeated large DOM captures.

```json
{
  "name": "get_page_state",
  "arguments": {
    "sessionId": "sess_123",
    "maxItems": 40,
    "maxTextLength": 80,
    "includeButtons": true,
    "includeInputs": true,
    "includeModals": true
  }
}
```

Response highlights:

- `summary`: counts for buttons, links, inputs, modals, and frames
- `buttons`: compact action targets with text, selector, disabled, and selected/pressed metadata
- `links`: compact link targets with text/name/href metadata
- `inputs`: field labels/placeholders with value length only, never raw typed values
- `modals`: open modal summaries with title, selector, and action counts
- `frames`: discovered frame metadata; frame entries include URL/title/origin, sandbox and same-origin policy fields, capture errors, and automation support diagnostics. Frame entries are merged into `buttons`, `links`, `inputs`, and `modals` with `frameId`, `frameUrl`, `frameTitle`, frame policy fields, and frame-aware `elementRef` values.
- Open shadow roots are traversed for page-state discovery. Shadow selectors use `host >> target` syntax, for example `#settings-host >> #save`.

Prefer this tool before `get_dom_document` or `get_dom_subtree` when the goal is understanding current page state rather than reading raw markup.

### get_interactive_elements

Returns compact live refs for interactive elements so automation can reuse `elementRef` instead of rebuilding selectors.

```json
{
  "name": "get_interactive_elements",
  "arguments": {
    "sessionId": "sess_123",
    "kinds": ["buttons", "inputs", "focused"],
    "maxItems": 20
  }
}
```

Response highlights:

- `refs`: compact live element entries with `kind`, `elementRef`, selector/testId metadata, role/name metadata, and visible text or labels
- `refs[].frameId`, `refs[].frameUrl`, and `refs[].frameTitle`: present for refs discovered inside child frames; pass the returned `elementRef` back to `execute_ui_action` to keep frame targeting intact. Frame refs also carry enough URL/title metadata for the native backend to recover from a stale frame id when the selector still resolves uniquely.
- Open shadow-root refs use shadow selectors such as `#shadow-host >> #shadow-action`
- `page`: current URL/title/language/viewport
- `pageSummary`: current button/link/input/modal/frame counts

### set_viewport

Resizes the live browser window for the current session and returns the resulting viewport metrics.

```json
{
  "name": "set_viewport",
  "arguments": {
    "sessionId": "sess_123",
    "width": 390,
    "height": 844
  }
}
```

Use this for responsive checks before querying layout or opening modals.

### assert_page_state

Runs a one-shot assertion against compact structured page state.

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
- `matchCount`: how many structured items matched
- `sampledMatches`: up to 5 matching items for quick debugging
- `pageSummary`: current button/link/input/modal/frame counts

Use this before large DOM captures when the goal is simply to verify UI state.

### wait_for_page_state

Polls compact structured page state until a matcher succeeds or the timeout expires.

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

- `matched`: final result
- `attempts`: number of page-state polls performed
- `waitedMs`: total wait duration
- `sampledMatches`: matched items when successful

### preflight_automation_flow

Checks whether a live session is ready for a bounded automation flow before the agent starts clicking or typing.

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

- `ready`: whether the flow can proceed
- `blockers`: session, connection, URL, or page-state problems that should stop the flow
- `warnings`: production-like origin, sensitive-field, or cross-origin frame risks
- `checks`: compact readiness booleans for session, live connection, expected URL, page capture, and detected risks
- `nextActions`: concrete guidance to run the flow or resolve blockers

Run this before production or remote-origin flows so agents do not repeatedly try actions against the wrong tab, stale session, iframe noise, or sensitive surfaces.

### URL, navigation, load-state, selector, console, and network waits

These tools provide first-class waits beyond compact page-state polling:

- `wait_for_url`: waits for `exactUrl`, `urlContains`, or `urlRegex`
- `wait_for_navigation`: waits for a persisted navigation event by destination URL, source URL, trigger, or tab
- `wait_for_load_state`: waits for the live document `readyState` to reach `domcontentloaded` or `load`, optionally scoped by URL predicates
- `wait_for_selector_state`: waits for a selector to be `attached`, `detached`, `visible`, or `hidden`
- `wait_for_console`: waits for a live console log matching `levels` and/or `contains`
- `wait_for_network_quiet`: waits until persisted network activity has been quiet for a bounded window
- `wait_for_request`: waits for a persisted request by URL, method, trace id, initiator, content type, or tab
- `wait_for_response`: waits for a persisted response by request filters plus status, response content type, or error type

```json
{
  "name": "wait_for_url",
  "arguments": {
    "sessionId": "sess_123",
    "urlContains": "/dashboard",
    "timeoutMs": 5000,
    "pollIntervalMs": 200
  }
}
```

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
  "name": "wait_for_navigation",
  "arguments": {
    "sessionId": "sess_123",
    "urlContains": "/dashboard",
    "fromUrlContains": "/login",
    "trigger": "pushState",
    "timeoutMs": 5000
  }
}
```

```json
{
  "name": "wait_for_console",
  "arguments": {
    "sessionId": "sess_123",
    "levels": ["error"],
    "contains": "checkout",
    "timeoutMs": 5000
  }
}
```

```json
{
  "name": "wait_for_network_quiet",
  "arguments": {
    "sessionId": "sess_123",
    "quietMs": 500,
    "urlContains": "/api/checkout",
    "method": "POST",
    "timeoutMs": 10000
  }
}
```

```json
{
  "name": "wait_for_request",
  "arguments": {
    "sessionId": "sess_123",
    "urlContains": "/api/checkout",
    "method": "POST",
    "initiator": "fetch",
    "timeoutMs": 10000
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

Response highlights:

- `matched`, `waitKind`, `attempts`, `waitedMs`
- `evidence` with the final URL/page, selector state, sampled console logs, or sampled network calls
- structured timeout error codes such as `url_wait_timeout`, `navigation_wait_timeout`, `selector_state_wait_timeout`, `console_wait_timeout`, `network_quiet_timeout`, `request_wait_timeout`, and `response_wait_timeout`

### get_live_console_logs

Reads session-scoped live console logs from extension memory (non-persistent buffer).

Filters:

- required: `sessionId`
- optional: `url` (origin), `tabId`, `levels`, `contains`, `sinceTs`, `limit`
- optional: `dedupeWindowMs` to collapse repeated bursts
- optional: `responseProfile: "compact"` for minimal rows (`timestamp`, `level`, `message`)
- optional: `includeArgs` (compact mode only), `maxResponseBytes`

```json
{
  "name": "get_live_console_logs",
  "arguments": {
    "sessionId": "sess_123",
    "url": "http://localhost:3000",
    "levels": ["info", "error"],
    "contains": "[auth]",
    "dedupeWindowMs": 1000,
    "responseProfile": "compact",
    "maxResponseBytes": 32768,
    "limit": 100
  }
}
```

### capture_ui_snapshot (PNG metadata-first defaults)

When `mode: "png"` is used, defaults are metadata-first:

- `includeDom: false`
- `includeStyles: false`
- `includePngDataUrl: false`

Override these only when full payloads are explicitly needed.

### execute_ui_action

Executes one live UI action in the already bound extension session without creating a new browser runtime.
`click`, `hover`, `input`, `press_key`, `focus`, `blur`, `scroll`, and `submit` currently use the CDP-backed native automation backend (`cdp-native-v2`) for the top document, open shadow roots, and same-origin iframe targets. `reload` uses the extension tab API.

```json
{
  "name": "execute_ui_action",
  "arguments": {
    "sessionId": "sess_123",
    "action": "click",
    "target": { "selector": "#checkout-submit" }
  }
}
```

You can target by `elementRef` instead of `selector`. Frame-scoped refs encode `frameId`, `frameUrl`, and `frameTitle`; if the stored frame id is stale but the frame URL/title and selector still resolve uniquely, the native backend refreshes the frame id before acting.

```json
{
  "name": "execute_ui_action",
  "arguments": {
    "sessionId": "sess_123",
    "action": "click",
    "target": { "elementRef": "ref:..." }
  }
}
```

You can also use compact semantic target matchers. The server resolves these through `get_page_state`, then sends the resulting frame-aware `elementRef` to the extension:

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

Semantic targets support `scope: "buttons" | "links" | "inputs" | "modals" | "focused"`, text/label/title matching, role/name/placeholder/alt matching, frame filters (`frameUrlContains`, `frameTitleContains`), `exact: true`, and deliberate disambiguation with `nth`, `first`, `last`, or `strict: false`:

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

For more explicit locator-style targeting, use `target.locator`. Direct live actions and workflow action steps pass locator targets to the extension's native DOM resolver, which evaluates the current document, open shadow roots, and accessible frames before CDP actionability checks. The MCP server still keeps compact page-state semantic matching for non-locator targets.

```json
{
  "name": "execute_ui_action",
  "arguments": {
    "sessionId": "sess_123",
    "action": "click",
    "target": {
      "locator": {
        "scope": "buttons",
        "frame": { "titleContains": "Account" },
        "steps": [
          { "kind": "role", "role": "button", "name": { "pattern": "^Save", "flags": "i" } },
          { "kind": "text", "value": "Save changes", "exact": true, "relation": "descendant" }
        ]
      }
    }
  }
}
```

Locator step kinds are `css`, `role`, `text`, `label`, `testId`, `placeholder`, and `altText`. `css` and `testId` steps match exactly by default; text-like steps match by containment unless `exact: true` is set. Regex matchers use `{ "pattern": "...", "flags": "i" }`. By default each step filters the current candidate set; set `relation: "descendant"` on a later step to search descendants of the previous step's matches.

Combined action + wait example:

```json
{
  "name": "execute_ui_action",
  "arguments": {
    "sessionId": "sess_123",
    "action": "click",
    "target": { "selector": "#open-day" },
    "waitForPageState": {
      "scope": "modals",
      "titleContains": "Day plan",
      "timeoutMs": 5000,
      "pollIntervalMs": 200
    }
  }
}
```

Important limits and safeguards:

- Native automation supports the top document and same-origin iframe targets in the currently bound tab
- Native actions and page-state discovery support open shadow roots with `host >> target` selectors. Closed shadow roots are not inspectable.
- Nested same-origin iframe actions are covered when page-state returns a frame-aware `elementRef`
- Native pointer actions in cross-origin, sandboxed opaque-origin, or inaccessible frames return `unsupported_cross_origin_frame` when top-document coordinate translation is not possible. The response includes `actionResult.result.framePolicy` and `actionability.frameCoordinateResolved`.
- Stale frame ids on frame-aware refs are re-resolved by encoded frame URL/title plus selector when possible. Invalid frame ids without enough metadata, or unresolved frame refs, return `target_frame_not_found`.
- `target.locator` now has native DOM resolution for direct/workflow actions and compact page-state semantics for server-side diagnostics. It supports chained structured filters, explicit descendant relations, and regex matching, but it is not yet a full Playwright/Cypress locator engine for ancestor relations, closed shadow DOM, coordinate targeting, or arbitrary selector state.
- `actionResult.result.backend` identifies the execution backend (`cdp-native-v2` for migrated native actions)
- Native actions perform target inspection/actionability checks before dispatch, including visibility, disabled state, readonly/editable state for input, stable layout, pointer-events, viewport intersection, and hit-target mismatch diagnostics
- Page-state assertions and waits support `visible: true/false`, `role`, `name`, `placeholder`, `altText`, `frameUrlContains`, `frameTitleContains`, and `exact` for structured refs where available
- `Allow live automation` must be enabled in the extension popup before any action can run
- Sensitive selectors and input-like actions require the second `Allow sensitive field automation` opt-in
- The extension shows a red in-page automation indicator while armed/executing and exposes an emergency stop in both the page overlay and popup
- Failures return structured `failureDetails`, `traceId`, `tabContext`, and optional `postActionEvidence` when `captureOnFailure` is enabled
- When `waitForPageState` is provided and the action succeeds, the response includes `postActionState` with structured wait results

### run_ui_steps

Runs a small generic UI workflow locally in the bridge using sequential action, wait, and assert steps.

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

  Milestone 4 notes:
  
  - modes:
    - `safe`: fuller verification and broader state capture
    - `fast`: smaller page-state captures, cached state reuse between steps, and lighter summaries
  - supported step kinds: `action`, `waitFor`, `wait`, `assert`
  - `waitFor` polls compact page-state matchers
  - `wait` runs the first-class wait engine with `waitKind: "url" | "navigation" | "load_state" | "selector_state" | "console" | "network_quiet" | "request" | "response"`
  - action targets can use:
      - direct handles: `elementRef`, `selector`
      - semantic matchers: `testId`, `scope`, `locator`, `textContains`, `labelContains`, `titleContains`, `role`, `name`, `placeholder`, `altText`, `frameUrlContains`, `frameTitleContains`
      - optional refinements: `exact`, `nth`, `first`, `last`, `strict`, `tagName`, `type`, `disabled`, `selected`, `pressed`, `expanded`, `readOnly`, `requiredField`
  - the workflow stops on first failure by default and marks remaining steps as `skipped`
  - each step can set `onFailure.strategy` to `stop`, `continue`, or `retry_once`
  - each step can set `onFailure.capture` to collect a failure snapshot using the same snapshot options as `execute_ui_action.captureOnFailure`
  
  Response highlights:
  
  - `status`: overall workflow result
  - `steps`: per-step status, timing, and error details
  - `failedStepId`: first failed step when the workflow stops early
  - action-step failures include structured target diagnostics for not-found and ambiguous semantic matches
  - `wait` step results include `wait.matched`, `wait.waitKind`, `attempts`, `waitedMs`, and wait-specific evidence under `target`
  - step results include `executionAttempts`, resolved `failurePolicy`, optional `failureEvidence`, and optional `recommendedAction`
  - step results can include `pageChangeSummary` with compact state diffs between workflow steps
  - `workflowDiagnostics` reports retry count, page-state capture count, failure-capture count, and whether cached state was used
  - `stepCounts`, `finalPageSummary`, and `finalPage` provide compact end-state diagnostics

### get_live_session_health

Returns one session's persisted binding metadata plus current live transport state.

```json
{ "name": "get_live_session_health", "arguments": { "sessionId": "sess_123" } }
```

Use this before long live flows to distinguish:

- healthy connected sessions
- reconnectable sessions where transport dropped
- ended sessions that require starting a fresh live session

## V6 Automation history tools

These tools read from the dedicated `automation_runs` and `automation_steps` tables, so historical automation analysis no longer depends on reconstructing flows from generic `ui` event breadcrumbs. Native action diagnostics are persisted with the history rows, including backend, actionability, frame policy, locator resolution, and point metadata when the live action returned them.

### list_automation_runs

Lists first-class automation runs for one session with optional status/action/trace filters.

```json
{
  "name": "list_automation_runs",
  "arguments": {
    "sessionId": "sess_123",
    "traceId": "uiaction-...",
    "status": "failed",
    "limit": 20,
    "offset": 0
  }
}
```

### get_automation_run

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

Response highlights:

- `run`: run-level status, selector, trace id, failure/redaction metadata, diagnostics, and step count
- `steps`: ordered step records with event linkage, diagnostics, and redacted input metadata
- `pagination`: step pagination metadata for larger runs

### Live capture disconnection behavior

When a listed session is not currently connected, live tools return a normalized disconnection error that starts with:

- `LIVE_SESSION_DISCONNECTED`

This indicates the session is historical/stale or transport was dropped. Start/reconnect a live session in the extension and retry with a session id whose health response shows `liveConnection.status = "connected"` and `recommendedForLiveCapture = true`.

## Experimental Override tools

These tools manage the response override POC for local repo mode.

Available tools:

- `list_override_profiles`
- `create_override_profile`
- `validate_override_profile`
- `preflight_overrides`
- `observe_override_assets`
- `capture_override_response_body`
- `list_observed_override_assets`
- `map_next_override_assets`
- `plan_override_response_patch`
- `plan_next_source_override`
- `enable_overrides`
- `disable_overrides`
- `get_override_status`
- `get_override_request_log`
- `get_override_plan_log`
- `diagnose_overrides`

`create_override_profile` generates reviewable config JSON from local build assets. Current adapters are `nextjs` for `.next` output and `static` for framework-neutral asset directories such as `dist/assets`.

Override profile and observed-asset listing tools default to compact responses to avoid large agent context loops. Use `responseProfile: "full"` only when the caller needs every rule or persisted asset field. `create_override_profile` also omits the generated `configJson` by default in compact mode; pass `includeConfigJson: true` or `responseProfile: "full"` when the raw JSON is needed.

The override runtime is framework-agnostic. Adapters currently generate `targetAssetUrl` to `localFilePath` rules with exact matching by default and prefix matching for unstable response URLs when explicitly requested; validation, serving, interception, audit, and diagnosis use the same path for every framework.

`preflight_overrides` is the production-safety gate before `enable_overrides`. It combines profile validation, live-session readiness, observed asset constraints, recent plan/variant context, and persisted diagnosis signals into a single readiness result. Missing live connection state, disconnected sessions, missing observed assets, no observed match for any enabled target, and observed assets recorded only for a different tab are blocking readiness errors. Exact and prefix profile rules use the same matching semantics as the runtime. Generated multi-asset profiles are considered capture-ready when at least one enabled target was observed for the selected session; unobserved enabled targets are reported as warnings and counts rather than blocking the route under test. The response includes `checks.captureReady`, `checks.topLevelScopeLikely`, `checks.observedAssetTabs`, `checks.matchedTargetAssetCount`, `checks.unobservedTargetAssetCount`, and `observedAssets.targetAssetObserved` so callers can distinguish profile problems from session/capture readiness problems.

`enable_overrides` uses the same preflight contract. If the only blockers are observed-asset readiness problems, it first runs a bounded `CAPTURE_OVERRIDE_OBSERVE_ASSETS` pass against the selected tab, persists the result, rebuilds preflight, and only then enables. If profile validation or request-safety errors are already present, it does not spend time observing assets and fails before touching the live bridge enable path.

Override-specific live command failures are reported with structured diagnostics instead of raw bridge timeouts. `enable_overrides`, `observe_override_assets`, `capture_override_response_body`, and live capture inside `plan_override_response_patch` throw errors with codes such as `OVERRIDE_LIVE_COMMAND_TIMEOUT`, `OVERRIDE_LIVE_COMMAND_FAILED`, or `LIVE_SESSION_DISCONNECTED`, plus command name, timeout, original message, and session connection state when available. If live `get_override_status` or `disable_overrides` times out or disconnects while database state is available, the tools return `statusSource: "persisted-audit"` with `liveStatus` or `disableAttempt`, latest persisted run/request/plan data, preflight, diagnosis, and reconnect/retry next actions.

The production contract is GET-first for response overrides, with one narrow POST exception for planner-generated `rsc-flight` rules captured from `text/x-component` CDP response-stage traffic with RSC request context and no `next-action` server-action header. Generic non-GET replay attempts fail with `UNSAFE_REQUEST_METHOD` plus `MUTATION_REPLAY_UNSUPPORTED`, and Next.js server action flows fail with `UNSAFE_REQUEST_METHOD` plus `SERVER_ACTION_UNSUPPORTED`, instead of being enabled speculatively.

`observe_override_assets` uses the live extension connection to inspect the selected tab's document, script/style/link DOM nodes, Next.js URL hints such as `/_next/static`, `/_next/data`, and `_rsc=`, and fetch/XHR performance entries, then persists them per session with request metadata. Observed entries include `ruleType` values of `asset`, `document`, `rsc-flight`, `next-data`, or `api-response`, plus request method, resource type, content type, status, and navigation/fetch hints when available.

`list_observed_override_assets` returns persisted entries with a default limit of 50 and compact rows by default. `map_next_override_assets` currently maps observed `asset` entries under `/_next/static/...` back to the local `.next` build, source maps when available, route manifests, and optional fetched production bytes. `plan_next_source_override` applies source edits in a temp Next.js overlay build, prefers safe literal patching of observed static chunks to preserve runtime/module identity, distinguishes direct source-map ownership from client-reference manifest membership, cleans expired `tmp/bn` overlays, and can write an override config.

Document, RSC flight, Next data, and API response observations are persisted as production-readiness foundations. The runtime fulfills configured request URLs for supported response types. Planner-generated `rsc-flight` rules are supported for captured `text/x-component` `GET` responses with structured Flight string-value patches and `_rsc` target URLs, and for captured POST `text/x-component` response-stage patches with RSC request context and no `next-action` header.

`capture_override_response_body` captures a bounded text-like response body through the live extension session. By default it uses extension `fetch` with browser credentials and exact URL matching. With `captureMode: "cdp-response"`, `tabId`, optional `triggerReload: true`, and optional `matchMode: "prefix"`, it attaches CDP response-stage interception to the bound tab and captures the real in-tab response before continuing the request. Extension-fetch capture remains limited to safe `GET`/`HEAD` requests. CDP capture also allows explicit `ruleType: "rsc-flight"` POST captures for `text/x-component` response-stage planning; those captures continue the original browser POST rather than replaying it. Caller-supplied headers such as `authorization` and `cookie` are rejected where headers are accepted, and the full body is not returned unless `includeBody=true`. Unsupported non-GET capture attempts are rejected before the live bridge is called; Next.js server actions return `SERVER_ACTION_UNSUPPORTED`, and other mutation-style POST requests return `MUTATION_REPLAY_UNSUPPORTED`.

`plan_override_response_patch` applies exactly one patch family to a supplied or live-captured response body: literal `textPatches`, structured JSON Pointer `jsonPatches`, or structured HTML `documentPatches`. It validates text/JSON/document/RSC safety, writes a generated local response body when requested, and can write exact or prefix override config rules for supported `document`, `next-data`, `api-response`, and production-safe `rsc-flight` responses. `jsonPatches` support existing-value `replace` operations only, with optional `expectedValue` checks, and are limited to JSON-like Next data/API response bodies. `documentPatches` are parser-based and currently support selector-scoped `replaceText`, `removeElement`, and `replaceJsonValue` operations, including safe JSON Pointer edits inside `script#__NEXT_DATA__`. Planning remains GET-first, but captured POST `rsc-flight` response-stage patches are supported when the captured request context includes `rsc: "1"` and no `next-action` header. Next.js server action requests are blocked with `SERVER_ACTION_UNSUPPORTED`, and generic mutation replay attempts are blocked with `MUTATION_REPLAY_UNSUPPORTED`. If no body is supplied and `sessionId` is provided, the tool can use the same `captureMode`, `tabId`, `triggerReload`, `matchMode`, and `timeoutMs` controls as `capture_override_response_body` before planning. Planned response patches persist a normalized variant context as well, including pathname, search params, safe Next.js request headers, request method, and a stable `variantKey`.

When `sessionId` is supplied and a generated rule is produced, `plan_override_response_patch` and `plan_next_source_override` also persist an `override_plan_audits` row per generated rule. `get_override_plan_log` returns these records later with rule type, target URL, config path, generated files, original/patched hashes when available, patch summaries, optional previews, planner warnings/blockers, live-capture provenance, captured variant context, and rollback instructions.

Production RSC rules include planner metadata: patch operations, original/patched hashes, byte counts, content type, and stable RSC request headers. The planner emits `structured-flight-v1` / `string-value-text` metadata and the live runtime validates that RSC patches only target parsed Flight JSON string values. Patches that hit tagged records, React element type/key tokens, Flight protocol/reference tokens, object keys, or content outside string payloads are rejected or continued unchanged with a structured failure. Replacements that need JSON escaping are supported through JSON serialization. The extension handles supported rules at CDP response stage and applies the structured patch to the live Flight body for the captured navigation variant. Next.js can also issue matching prefetch or metadata-only Flight requests for the same `_rsc` URL; those variants are continued unchanged when they do not contain the captured patch anchors. Other matching live responses that miss the expected anchors are continued and recorded as structured failures instead of serving stale content.

Manual `rsc-flight` rules without planner metadata remain invalid and `preflight_overrides` reports them as not production-ready. An investigation-only rule field, `allowExperimentalRscFlightFulfillment: true`, can still be used in controlled tests to bypass the production enable gate, but it is not the supported contract.

Current browser e2e coverage includes document responses, parser-based document patches, a Next.js Pages Router `#__NEXT_DATA__` document rewrite, a dynamic Next.js App Router API JSON response, and a real Next.js `/_next/data` response captured through CDP, patched through MCP, persisted into the generated plan audit log, and fulfilled by the override runtime. It also covers Next.js RSC flight capture/planning with prefix matching, production validation, CDP response-stage live patching, dynamic route isolation, search-param isolation, history navigation, prefetch/metadata pass-through behavior, direct RSC replay probes, the explicit experimental RSC opt-in path on the fixture, and negative fixture coverage showing that real Next.js server action requests and generic POST mutation requests are blocked before planning.

```json
{
  "name": "map_next_override_assets",
  "arguments": {
    "sessionId": "sess_123",
    "projectRoot": "C:/path/to/app",
    "route": "/products",
    "sourcePaths": ["src/app/products/page.tsx"],
    "fetchProductionAssets": true
  }
}
```

When `fetchProductionAssets` is true, each checked candidate includes `drift`. Different production/local hashes add `PRODUCTION_LOCAL_DRIFT` unless normalized signatures still match. The check is bounded by `maxDriftCandidates` (default 20), `productionFetchConcurrency` (default 4), `productionFetchTimeoutMs`, and `maxProductionAssetBytes`.

`diagnose_overrides` incorporates persisted observed assets when available. It can report `TARGET_ASSET_NOT_OBSERVED`, `TARGET_ASSET_SRI_PRESENT`, `CSP_META_PRESENT`, and `SERVICE_WORKER_CONTROLLED_PAGE` alongside audit failures.

```json
{
  "name": "plan_next_source_override",
  "arguments": {
    "sessionId": "sess_123",
    "projectRoot": "C:/path/to/app",
    "route": "/products",
    "sourceEdits": [
      {
        "filePath": "src/app/products/page.tsx",
        "search": "Original headline",
        "replacement": "Override headline"
      }
    ],
    "configPath": "C:/path/to/app/override-poc.local.json",
    "writeConfig": true,
    "overlayTtlMs": 86400000
  }
}
```

```json
{
  "name": "create_override_profile",
  "arguments": {
    "adapter": "static",
    "projectRoot": "C:/path/to/app",
    "assetRoot": "dist/assets",
    "targetBaseUrl": "https://www.example.com/assets/",
    "writeConfig": true
  }
}
```

## V3 Correlation tools

### explain_last_failure

Builds a timeline linking user actions, network failures, and runtime errors.

```json
{ "name": "explain_last_failure", "arguments": { "sessionId": "sess_123" } }
```

### get_event_correlation

Returns correlated entities for a specific event id.

```json
{ "name": "get_event_correlation", "arguments": { "sessionId": "sess_123", "eventId": "evt_456" } }
```
