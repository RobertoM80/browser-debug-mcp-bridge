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

`preflight_overrides` is the production-safety gate before `enable_overrides`. It combines profile validation, live-session readiness, observed asset constraints, recent plan/variant context, and persisted diagnosis signals into a single readiness result. Today the production contract is GET-only for response overrides. Generic non-GET replay attempts fail with `UNSAFE_REQUEST_METHOD` plus `MUTATION_REPLAY_UNSUPPORTED`, and Next.js server action or POST RSC flows fail with `UNSAFE_REQUEST_METHOD` plus `SERVER_ACTION_UNSUPPORTED`, instead of being enabled speculatively.

`observe_override_assets` uses the live extension connection to inspect the selected tab's document, script/style/link DOM nodes, Next.js URL hints such as `/_next/static`, `/_next/data`, and `_rsc=`, and fetch/XHR performance entries, then persists them per session with request metadata. Observed entries include `ruleType` values of `asset`, `document`, `rsc-flight`, `next-data`, or `api-response`, plus request method, resource type, content type, status, and navigation/fetch hints when available.

`list_observed_override_assets` returns the persisted entries. `map_next_override_assets` currently maps observed `asset` entries under `/_next/static/...` back to the local `.next` build, source maps when available, route manifests, and optional fetched production bytes. `plan_next_source_override` applies source edits in a temp Next.js overlay build, prefers safe literal patching of observed static chunks to preserve runtime/module identity, distinguishes direct source-map ownership from client-reference manifest membership, cleans expired `tmp/bn` overlays, and can write an override config.

Document, RSC flight, Next data, and API response observations are persisted as production-readiness foundations. The runtime fulfills configured request URLs for supported response types. Planner-generated `rsc-flight` rules are supported for captured `text/x-component` `GET` responses with structured Flight string-value patches and `_rsc` target URLs.

`capture_override_response_body` captures a bounded text-like response body through the live extension session. By default it uses extension `fetch` with browser credentials and exact URL matching. With `captureMode: "cdp-response"`, `tabId`, optional `triggerReload: true`, and optional `matchMode: "prefix"`, it attaches CDP response-stage interception to the bound tab and captures the real in-tab response before continuing the request. Both modes are limited to safe `GET`/`HEAD` requests, reject sensitive caller-supplied headers such as `authorization` and `cookie` when headers are supplied, and do not return the full body unless `includeBody=true`. Non-GET capture attempts are rejected before the live bridge is called; Next.js server actions return `SERVER_ACTION_UNSUPPORTED`, and other mutation-style POST requests return `MUTATION_REPLAY_UNSUPPORTED`.

`plan_override_response_patch` applies exactly one patch family to a supplied or live-captured response body: literal `textPatches`, structured JSON Pointer `jsonPatches`, or structured HTML `documentPatches`. It validates text/JSON/document/RSC safety, writes a generated local response body when requested, and can write exact or prefix override config rules for supported `document`, `next-data`, `api-response`, and production-safe `rsc-flight` responses. `jsonPatches` support existing-value `replace` operations only, with optional `expectedValue` checks, and are limited to JSON-like Next data/API response bodies. `documentPatches` are parser-based and currently support selector-scoped `replaceText`, `removeElement`, and `replaceJsonValue` operations, including safe JSON Pointer edits inside `script#__NEXT_DATA__`. Planning stays GET-only: Next.js server action requests are blocked with `SERVER_ACTION_UNSUPPORTED`, and generic mutation replay attempts are blocked with `MUTATION_REPLAY_UNSUPPORTED`. If no body is supplied and `sessionId` is provided, the tool can use the same `captureMode`, `tabId`, `triggerReload`, `matchMode`, and `timeoutMs` controls as `capture_override_response_body` before planning. Planned response patches persist a normalized variant context as well, including pathname, search params, safe Next.js request headers, request method, and a stable `variantKey`.

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
