# MCP Tools Reference

All tool responses include:

- `sessionId`
- `limitsApplied`
- `redactionSummary`
- `responseBytes` (serialized byte size estimate for observability)

High-volume query tools also support:

- `maxResponseBytes` input (soft byte budget, default `32768`)
- pagination metadata with `hasMore` and `nextOffset`

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

- `summary`: counts for buttons, inputs, and modals
- `buttons`: compact action targets with text, selector, disabled, and selected/pressed metadata
- `inputs`: field labels/placeholders with value length only, never raw typed values
- `modals`: open modal summaries with title, selector, and action counts

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

- `refs`: compact live element entries with `kind`, `elementRef`, selector/testId metadata, and visible text or labels
- `page`: current URL/title/language/viewport
- `pageSummary`: current button/input/modal counts

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
- `pageSummary`: current button/input/modal counts

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

You can target by `elementRef` instead of `selector`:

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

- V1 only supports the top document in the currently bound tab; iframe targets return an unsupported error
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
  - supported step kinds: `action`, `waitFor`, `assert`
  - action targets can use:
      - direct handles: `elementRef`, `selector`
      - semantic matchers: `testId`, `scope`, `textContains`, `labelContains`, `titleContains`
      - optional refinements: `tagName`, `type`, `disabled`, `selected`, `pressed`, `expanded`, `readOnly`, `requiredField`
  - the workflow stops on first failure by default and marks remaining steps as `skipped`
  - each step can set `onFailure.strategy` to `stop`, `continue`, or `retry_once`
  - each step can set `onFailure.capture` to collect a failure snapshot using the same snapshot options as `execute_ui_action.captureOnFailure`
  
  Response highlights:
  
  - `status`: overall workflow result
  - `steps`: per-step status, timing, and error details
  - `failedStepId`: first failed step when the workflow stops early
  - action-step failures include structured target diagnostics for not-found and ambiguous semantic matches
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

These tools read from the dedicated `automation_runs` and `automation_steps` tables, so historical automation analysis no longer depends on reconstructing flows from generic `ui` event breadcrumbs.

### list_automation_runs

Lists first-class automation runs for one session with optional status/action filters.

```json
{
  "name": "list_automation_runs",
  "arguments": {
    "sessionId": "sess_123",
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

- `run`: run-level status, selector, trace id, failure/redaction metadata, and step count
- `steps`: ordered step records with event linkage and redacted input metadata
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

The override runtime is framework-agnostic. Adapters currently generate `targetAssetUrl` to `localFilePath` rules with exact matching by default and prefix matching for unstable response URLs when explicitly requested; validation, serving, interception, audit, and diagnosis use the same path for every framework.

`preflight_overrides` is the production-safety gate before `enable_overrides`. It combines profile validation, live-session readiness, observed asset constraints, recent plan/variant context, and persisted diagnosis signals into a single readiness result. The production contract is GET-first for response overrides, with one narrow POST exception for planner-generated `rsc-flight` rules captured from `text/x-component` CDP response-stage traffic with RSC request context and no `next-action` server-action header. Generic non-GET replay attempts fail with `UNSAFE_REQUEST_METHOD` plus `MUTATION_REPLAY_UNSUPPORTED`, and Next.js server action flows fail with `UNSAFE_REQUEST_METHOD` plus `SERVER_ACTION_UNSUPPORTED`, instead of being enabled speculatively.

`observe_override_assets` uses the live extension connection to inspect the selected tab's document, script/style/link DOM nodes, Next.js URL hints such as `/_next/static`, `/_next/data`, and `_rsc=`, and fetch/XHR performance entries, then persists them per session with request metadata. Observed entries include `ruleType` values of `asset`, `document`, `rsc-flight`, `next-data`, or `api-response`, plus request method, resource type, content type, status, and navigation/fetch hints when available.

`list_observed_override_assets` returns the persisted entries. `map_next_override_assets` currently maps observed `asset` entries under `/_next/static/...` back to the local `.next` build, source maps when available, route manifests, and optional fetched production bytes. `plan_next_source_override` applies source edits in a temp Next.js overlay build, prefers safe literal patching of observed static chunks to preserve runtime/module identity, distinguishes direct source-map ownership from client-reference manifest membership, cleans expired `tmp/bn` overlays, and can write an override config.

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
