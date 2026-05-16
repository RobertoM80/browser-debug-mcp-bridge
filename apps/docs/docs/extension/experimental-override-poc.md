# Experimental Override POC

This repo includes a minimal proof of concept for replacing production asset requests with local files through Chrome's debugger protocol.

## Scope

- local repo mode only
- one active override profile with one or more exact or prefix URL/file rules
- one attached tab
- manual enable/disable from the extension popup or MCP tools

It is intentionally narrow. The goal is to prove that the bridge can intercept a real production request and fulfill it with local bytes.

## Config File

Keep the checked-in `override-poc.config.json` as a placeholder. It is valid by default, but points at example URLs and files, so it will not fulfill anything until you add real rules.

Create `override-poc.local.json` in the repo root for real local values. If needed, you can also point the server at a different file with `OVERRIDE_POC_CONFIG_PATH`.

```json
{
  "enabled": true,
  "activeProfileId": "placeholder",
  "profiles": [
    {
      "profileId": "placeholder",
      "name": "Placeholder override profile",
      "enabled": true,
      "autoReload": true,
      "rules": [
        {
          "ruleId": "placeholder-page",
          "targetAssetUrl": "https://example.com/_next/static/chunks/app/page-PLACEHOLDER.js",
          "localFilePath": ".next/static/chunks/app/page-PLACEHOLDER.js",
          "contentType": "application/javascript; charset=utf-8"
        }
      ]
    }
  ]
}
```

Notes:

1. Each rule `targetAssetUrl` must be the exact production URL requested by the browser, unless the rule explicitly uses `matchMode: "prefix"` for unstable response URLs.
2. Each rule `localFilePath` can be relative to the config file directory or an absolute path.
3. Root `enabled` is kept for backward compatibility, but the extension popup or MCP `enable_overrides`/`disable_overrides` controls the runtime state.
4. `override-poc.local.json` is ignored by git and is preferred automatically when present.
5. Legacy single-rule configs with top-level `targetAssetUrl` and `localFilePath` still work.

## Profile Generation

You can generate a candidate profile through the MCP `create_override_profile` tool instead of hand-writing every rule.

Supported adapters:

1. `nextjs`: scans `.next` manifests plus `.next/static` assets and maps them under a production `/_next/` asset base URL.
2. `static`: scans any built asset directory, such as `dist/assets`, and maps files under the provided production asset base URL.

Architecture note: the override engine is framework-agnostic. Adapters generate exact URL/file rules by default; request interception, validation, audit, and diagnosis use the same path for every framework, and prefix matching is available where the planner explicitly opts into it.

Planned adapter roadmap:

1. keep `static` as the universal fallback for any framework or no-framework build
2. add framework-specific manifest adapters only where they improve confidence
3. add observed production URL ingestion so generated profiles can be matched against real network requests
4. add dedicated adapters for Angular, Vue/Nuxt, Vite, SvelteKit, Remix, and other frameworks as needed

Example MCP arguments for Next.js:

```json
{
  "adapter": "nextjs",
  "projectRoot": "C:/path/to/app",
  "targetBaseUrl": "https://www.example.com/_next/",
  "writeConfig": true
}
```

Example MCP arguments for framework-neutral builds:

```json
{
  "adapter": "static",
  "projectRoot": "C:/path/to/app",
  "assetRoot": "dist/assets",
  "targetBaseUrl": "https://www.example.com/assets/",
  "writeConfig": true
}
```

Generated configs are usable by default. Review the `targetAssetUrl` values against real production network requests before enabling overrides from the extension popup or MCP tools.

## How To Run It

1. Build the local asset you want to test.
2. Update `override-poc.local.json`.
3. Rebuild the bridge pieces:

```bash
pnpm nx build mcp-server
pnpm nx build chrome-extension
```

Continue:

1. Reload the unpacked extension in `chrome://extensions`.
2. Start the MCP runtime.
3. Start or resume a live session on the target page.
4. Open the extension popup.
5. In `Override POC`, choose the bound target tab.
6. Click `Enable POC`.

If `autoReload` is `true`, the tab reloads after debugger attach so the first matching request can be intercepted with cache disabled and service worker bypass enabled.

You can also operate the same flow through MCP on a connected live session with `list_override_profiles`, `create_override_profile`, `validate_override_profile`, `preflight_overrides`, `observe_override_assets`, `capture_override_response_body`, `plan_override_response_patch`, `enable_overrides`, `disable_overrides`, `get_override_status`, `get_override_request_log`, `get_override_plan_log`, and `diagnose_overrides`.

## What It Does

When enabled, the background service worker:

1. attaches `chrome.debugger` to the session tab
2. enables CDP `Network` and `Fetch`
3. disables cache
4. bypasses the service worker
5. intercepts requests
6. fulfills only URLs that match enabled exact or prefix rules in the active profile

The local bytes come from the server endpoint `GET /overrides/poc/asset`.

## Audit And Diagnosis APIs

The override backend now persists durable run, request, and generated plan records for the session.

Available HTTP endpoints:

1. `POST /sessions/:sessionId/overrides/runs`
2. `GET /sessions/:sessionId/overrides/runs`
3. `POST /sessions/:sessionId/overrides/requests`
4. `GET /sessions/:sessionId/overrides/requests`
5. `POST /sessions/:sessionId/overrides/plans`
6. `GET /sessions/:sessionId/overrides/plans`
7. `GET /sessions/:sessionId/overrides/diagnosis`

Available MCP tools:

1. `list_override_profiles`
2. `create_override_profile`
3. `validate_override_profile`
4. `preflight_overrides`
5. `observe_override_assets`
6. `capture_override_response_body`
7. `list_observed_override_assets`
8. `map_next_override_assets`
9. `plan_override_response_patch`
10. `plan_next_source_override`
11. `enable_overrides`
12. `disable_overrides`
13. `get_override_status`
14. `get_override_request_log`
15. `get_override_plan_log`
16. `diagnose_overrides`

What they currently give you:

1. per-run status with structured failure codes
2. per-request matched and fulfilled history for the configured target asset
3. a diagnosis response that ranks likely blockers such as exact URL mismatch, cache or reload issues, precise debugger setup failures, persisted observed-asset mismatch, SRI, CSP, service-worker interference, and guarded RSC patch drift or unsafe-patch cases
4. live production render-artifact observation from the selected browser tab with persisted per-session reuse, including document, static asset, Next data/RSC URL hints, and fetch/XHR metadata
5. preflight readiness checks before enablement, including profile validity, session readiness, observed browser constraints, and recent captured variant context
6. bounded live text response-body capture for safe `GET`/`HEAD` requests, plus explicit CDP response-stage capture for planner-scoped POST RSC Flight responses from the bound tab
7. response patch planning that can generate local document, Next data, API response, or supported Next.js RSC flight override files from exact text patches, JSON Pointer replacements, or parser-based document patches, with prefix matching available for unstable response URLs
8. Next.js observed static asset to local chunk/source-path mapping with confidence reasons and optional bounded production/local drift checks
9. temp Next.js source-overlay planning that can write exact static asset override profile rules without mutating the repo, avoids remapping manifest-only shared chunks, and cleans expired `tmp/bn` overlays
10. generated plan audit records with rule metadata, hashes, patch summaries, variant context, generated files, warnings/blockers, and rollback instructions

For production Next.js routes, prefer `captureMode: "cdp-response"` with an explicit bound `tabId`. Add `triggerReload: true` for document navigations and `matchMode: "prefix"` for unstable URLs such as `_rsc=` requests. CDP capture reads the real browser response and then continues it unchanged; it refuses to run while overrides are already active on the same tab.

`enable_overrides` now uses the same preflight checks. Missing live connection state, disconnected sessions, missing observed assets, no observed match for any enabled target, and observed assets recorded only for another tab are blocking readiness errors. Exact and prefix rules use the same matching semantics as the runtime. Generated multi-asset profiles are capture-ready when at least one enabled target was observed for the selected session; unobserved enabled targets remain visible as readiness warnings and counts. If observed-asset readiness is the only blocker, `enable_overrides` first runs a bounded observation pass against the selected tab, persists the result, rebuilds preflight, and only then enables. If profile validation or request-safety errors are already present, it fails before touching the live bridge enable path.

Override live-command timeouts are surfaced as structured MCP diagnostics. `enable_overrides`, `observe_override_assets`, `capture_override_response_body`, and live capture inside `plan_override_response_patch` report codes such as `OVERRIDE_LIVE_COMMAND_TIMEOUT`, command name, timeout, original message, and session connection state when available. If `get_override_status` or `disable_overrides` cannot get live extension state but persisted audit state exists, the response falls back to `statusSource: "persisted-audit"` with `liveStatus` or `disableAttempt`, latest run/request/plan records, preflight, diagnosis, and reconnect/retry next actions.

Production response overrides remain GET-first, with one narrow POST exception: planner-generated `rsc-flight` rules for captured `text/x-component` POST responses that include RSC request context and no `next-action` server-action header. Generic non-GET replay attempts are still blocked with `UNSAFE_REQUEST_METHOD` and `MUTATION_REPLAY_UNSUPPORTED`; Next.js server action flows are still blocked with `UNSAFE_REQUEST_METHOD` and `SERVER_ACTION_UNSUPPORTED`. SRI-protected targets, ended/paused sessions, and disconnected live bridges are also surfaced as blocking preflight errors instead of being enabled speculatively.

RSC flight overrides are supported for a narrow production subset: captured `text/x-component` `GET` responses with `_rsc` target URLs, plus captured POST `text/x-component` response-stage patches with RSC request context and no `next-action` header. Planner-generated `rsc-flight` rules use `structured-flight-v1` metadata with `string-value-text` patch operations, hashes, byte counts, and stable RSC request headers. The planner and live runtime parse Flight rows, patch only JSON string values, and preserve the row framing. Patches that hit tagged Flight records, React element type/key tokens, Flight protocol/reference tokens, object keys, or content outside string payloads are rejected or continued unchanged with a structured failure. JSON escaping in replacements is supported because patched values are serialized through JSON. The extension handles supported rules at CDP response stage and applies the structured patch to the live Flight body for the captured request variant. For POST rules, the original browser request is continued to the server and only the returned response body is fulfilled; the override engine does not replay the POST. Matching prefetch or metadata-only Flight variants that do not contain the captured patch anchors are continued unchanged; other anchor mismatches are continued and recorded as `RSC_PATCH_ANCHOR_MISMATCH` or `RSC_FLIGHT_STRUCTURAL_DRIFT` instead of serving stale content.

Manual `rsc-flight` rules without planner metadata remain invalid and fail production preflight. The investigation-only rule flag, `allowExperimentalRscFlightFulfillment: true`, still exists for controlled fixture probes and can bypass the enable gate, but it is not the production support contract.

## Popup Status

The popup shows:

1. target asset URL
2. resolved local file path
3. config file path
4. selected tab id
5. attached tab id
6. matched request count
7. fulfilled request count
8. audit sync/retry status
9. profile/rule summary
10. compact diagnosis details from persisted observed assets and override audit rows
11. recent request audit rows with failure codes and messages
12. recent generated override plan rows with warning and blocker counts

The target selector is locked while an override is active. Disable the override before changing the selected tab.

## E2E Coverage

The full Playwright suite includes override-specific browser coverage:

1. exact multi-rule replacement for two live page scripts
2. exact URL mismatch leaves original assets untouched
3. pause, stop, and active-tab-unbind lifecycle cleanup
4. durable terminal audit runs for lifecycle teardown
5. a generated Next.js fixture app where `create_override_profile` maps `.next/static` output and the override engine fulfills real `/_next/static/...` chunk requests in a Chromium context with the packaged extension loaded
6. one browser-only runtime-generated override per Next fixture page: home, about, and products
7. MCP stdio control flow for the Next fixture path: list live session, validate profile, enable override, read status, request log, and diagnosis
8. observed live Next.js assets are persisted and mapped back to local source paths before the override is enabled
9. bounded production/local drift checks verify fetched asset hashes in the Next fixture path
10. popup coverage renders profile/rule, compact diagnosis details, recent request rows, and recent plan rows
11. `plan_next_source_override` patches an observed Next.js chunk from source-level edits and blocks SRI-protected candidates before config writing
12. `plan_override_response_patch` writes and fulfills an exact document response override in Chromium through MCP
13. CDP response-stage capture can capture the real in-tab document response, feed it into parser-based `documentPatches`, and fulfill the generated document override in Chromium
14. a Next.js Pages Router document can be captured through CDP, patched through `script#__NEXT_DATA__` JSON Pointer document patches, fulfilled by the override runtime, and kept isolated from a sibling page
15. a dynamic Next.js App Router API response can be captured through CDP, patched with structured JSON Pointer replacements through MCP, fulfilled by the override runtime, and reflected in page UI
16. a real Next.js `/_next/data` response can be captured through CDP, patched with structured JSON Pointer replacements through MCP, fulfilled by the override runtime, and kept isolated from a sibling data route
17. generated response override plan metadata is persisted with hashes, patch summaries, variant context, generated file paths, and rollback instructions, then retrieved through `get_override_plan_log`
18. a Next.js App Router RSC flight response can be captured, planned with prefix matching, validated, fulfilled at CDP response stage, and reflected in page UI
19. a POST `text/x-component` response can be captured through CDP, planned as a structured `rsc-flight` rule, validated, fulfilled at response stage without replaying the POST, and reflected in page UI
20. production RSC dynamic-route overrides stay scoped to the captured route across back/forward navigation while sibling routes remain original
21. production RSC search-param overrides apply only to the captured query state while other query states remain original
22. matching RSC prefetch and metadata-only variants are continued unchanged when they do not contain captured patch anchors
23. direct CDP RSC replay probes verify unmodified, structured string-value patched, response-stage, and request-stage replay against the fixture
24. real Next.js server action requests are observed in the fixture and blocked before response planning with `SERVER_ACTION_UNSUPPORTED`
25. real Next.js POST mutation requests are observed in the fixture and blocked before response planning with `MUTATION_REPLAY_UNSUPPORTED`
26. manual RSC configs without planner metadata remain invalid, while the explicit experimental opt-in remains covered separately for investigation probes

## Current Limits

This POC does not yet handle:

1. Angular, Vue, Vite, or other framework-specific manifest adapters beyond the generic `static` adapter
2. regex or fuzzy URL matching beyond exact and prefix modes
3. popup-level full request history UI
4. long-running multi-profile workflows across many tabs or sessions
5. arbitrary non-literal Next.js source transformations that require module-id, route-boundary, or server-only rewrites
6. response patching for non-text bodies, unsafe HTTP methods, streaming responses, or server actions
7. structured RSC flight patch planning beyond guarded exact string-value replacement
8. server actions, route/module boundary rewrites, and arbitrary server-side behavior changes
