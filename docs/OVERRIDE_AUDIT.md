# Override Feature Audit

Date: 2026-05-11
Branch reviewed: `feat/add-overrides`
HEAD reviewed: current branch state before merge

## Executive Summary

The repo has a real override proof of concept, not a finished override product.

What exists today is a narrow but meaningful path:

1. the Chrome extension can attach `chrome.debugger` to one session tab
2. it can enable CDP `Network` and `Fetch`
3. it can disable cache, bypass the service worker, and optionally reload
4. it can fulfill exact production asset URLs with local files from the active override profile
5. the popup can enable, disable, and display basic override status

That proves the hardest single mechanism: runtime request replacement through CDP. It does not yet prove that overrides are reliable, diagnosable, safe, and operable as a normal debugging workflow.

Current assessment:

- Core interception mechanism: implemented
- Manual operator flow: implemented
- Lifecycle hardening: implemented for pause, stop, last-tab removal, active-tab unbind, and active-tab close
- Diagnostics and auditability: implemented baseline with retry visibility
- Mapping and profile system: exact multi-rule profiles, adapter-based candidate generation, live observed render-artifact ingestion, typed persisted observations, and Next.js source-overlay planning implemented for the current static-asset POC scope
- Response override path: bounded response patching now exists for supplied bodies, extension-fetch captures, and explicit CDP response-stage captures from a bound tab; parser-based document patches cover selector text/removal and `#__NEXT_DATA__` JSON rewrites, production RSC patches are guarded to Flight JSON string values through structured row parsing, JSON-like API/Next data bodies support existing-value JSON Pointer replacements, and non-GET replay paths are blocked with dedicated mutation/server-action errors
- MCP control plane: implemented for current POC scope
- Automated confidence: meaningful baseline, still incomplete
- Production readiness: not ready

## Current Capability Scorecard

| Area | Status | Notes |
| --- | --- | --- |
| Single-asset replacement through CDP | Implemented | Exact or prefix URL matching, exact local file only |
| Local config loading and validation | Implemented | Safe checked-in placeholder, automatic `override-poc.local.json` preference, optional `OVERRIDE_POC_CONFIG_PATH` |
| Asset serving from local file | Implemented | Server only serves when `assetUrl` exactly matches configured target |
| Popup controls | Implemented | Enable, disable, refresh, counters, last error |
| Cache and SW bypass before reload | Implemented | Done during enable flow |
| Stop/session cleanup integration | Implemented | Stop, last-tab removal, active target unbind, and active target close disable override |
| Pause lifecycle integration | Implemented | Pause now disables the active override before pausing the session |
| Explicit target-tab selection | Implemented | Popup lets the operator choose the bound override target tab and locks selection while active |
| Multi-asset profiles | Implemented baseline | Active profile can contain multiple exact URL/file rules |
| Profile generation | Implemented baseline | Adapter model with `nextjs` and generic `static`; live observed URL reuse exists for mapping, while generator-level confidence scoring still needs more work |
| Failure diagnosis | Implemented baseline | HTTP and MCP diagnosis exists with heuristic blockers and structured failure codes |
| Request audit log | Implemented | Durable `override_runs`, `override_requests`, and generated `override_plan_audits` history exists through HTTP JSON and MCP tools |
| MCP tools for overrides | Implemented | Current POC exposes profile, validation, planning, persisted plan log, enable, disable, status, request log, and diagnosis tools |
| Text response capture and patching | Implemented baseline | Safe `GET`/`HEAD`, text-like bodies only, exact text replacements, parser-based document patches, or JSON Pointer replacements for JSON-like API/Next data bodies and `#__NEXT_DATA__`, extension-fetch or explicit CDP response-stage capture; planner-generated RSC flight rules are supported for captured `text/x-component` responses with live response-stage patching guarded to parsed Flight JSON string values |
| Override-focused unit/e2e coverage | Strong baseline | Controller tests, popup tests, positive/negative Playwright flows, pause/stop lifecycle flows, active-tab unbind, and a real Next.js fixture flow now exist |

## Current Verification Ledger

Last updated: 2026-05-11 after the server-action and mutation safety slice.

Commands run successfully:

1. `pnpm nx run mcp-server:lint --skipNxCache`
2. `pnpm nx run chrome-extension:lint --skipNxCache`
3. `pnpm nx run mcp-server:test --skipNxCache` with 208 passing tests
4. `pnpm nx run chrome-extension:test --skipNxCache` with 84 passing tests
5. `pnpm nx run override-next-fixture:build --skipNxCache`
6. `pnpm nx run e2e-playwright:test --skipNxCache` with 34 passing browser tests, including CDP document response capture-to-plan-to-fulfill, parser-based document patching, Next.js `#__NEXT_DATA__` document rewrite coverage, dynamic Next.js API and `/_next/data` response override coverage, generated plan audit lookup, production RSC flight capture/planning/validation/fulfillment, RSC dynamic-route and search-param isolation, direct RSC replay probes, the experimental RSC opt-in proof, and negative fixture coverage for blocked Next.js server action and generic POST mutation planning
7. `pnpm nx run docs:ci --skipNxCache`
8. `git diff --check origin/main` with line-ending warnings only
9. `pnpm verify`
10. `pnpm exec markdownlint-cli2 docs/OVERRIDE_AUDIT.md docs/MCP_TOOLS.md apps/docs/docs/extension/experimental-override-poc.md`

## What The Repo Proves Today

### 1. Server-side override config and asset serving

Files:

- `apps/mcp-server/src/override-poc.ts`
- `apps/mcp-server/src/main.ts`
- `apps/mcp-server/src/override-poc.spec.ts`

Implemented behavior:

1. loads the checked-in placeholder config, a preferred `override-poc.local.json`, or an explicit `OVERRIDE_POC_CONFIG_PATH`
2. validates `enabled`, `targetAssetUrl`, `localFilePath`, `contentType`, and `autoReload`
3. resolves relative file paths against the config file directory
4. exposes `GET /overrides/poc/config`
5. exposes `GET /overrides/poc/asset?assetUrl=...`
6. serves local bytes only when the requested URL exactly matches the configured asset URL

What is actually proven by tests:

1. relative path resolution works
2. exact-match asset serving works
3. non-matching asset requests are rejected
4. local-config precedence works
5. environment override precedence works

### 2. Extension-side interception path

Files:

- `apps/chrome-extension/src/override-poc.ts`
- `apps/chrome-extension/src/background.ts`
- `apps/chrome-extension/public/manifest.json`

Implemented behavior:

1. extension has debugger-based override controller
2. enable flow attaches to one explicitly chosen bound tab
3. it enables `Network` and `Fetch`
4. it disables cache
5. it bypasses the service worker
6. it clears browser cache
7. it optionally reloads the tab
8. it fulfills only configured exact or prefix-matched rule URLs
9. it continues all non-matching requests
10. it tracks matched and fulfilled counters plus last error

Remaining risks not fully proven by tests:

1. that the service worker bypass holds on every real app architecture
2. that the disable path always restores cleanly after every debugger failure mode
3. that page-specific SRI/CSP behavior is diagnosed beyond heuristics

### 3. Popup operator flow

Files:

- `apps/chrome-extension/public/popup.html`
- `apps/chrome-extension/public/popup.css`
- `apps/chrome-extension/src/popup.ts`

Implemented behavior:

1. popup shows current target asset URL
2. popup shows local file and config path
3. popup shows selected and attached tab ids
4. popup shows matched and fulfilled counters
5. popup can choose the bound target tab
6. popup can enable, disable, and refresh status
7. popup shows audit sync/retry status
8. popup locks target selection while an override is active
9. popup shows recent request audit rows with failure codes and messages
10. popup shows recent generated override plan rows with warning and blocker counts

Current limitation:

1. popup only shows a compact recent history; full paginated request and plan inspection still lives in MCP tools and HTTP endpoints

### 4. Server-side audit and diagnosis

Files:

- `apps/mcp-server/src/override-audit.ts`
- `apps/mcp-server/src/main.ts`
- `apps/mcp-server/src/db/schema.ts`
- `apps/mcp-server/src/db/migrations.ts`

Implemented behavior:

1. persists durable `override_runs` rows keyed by session and run id
2. persists durable `override_requests` rows for matched target requests
3. persists durable `override_plan_audits` rows for generated response and Next source override rules, including hashes, patch summaries, optional previews, warnings, blockers, generated file paths, and rollback metadata
4. records structured failure codes such as `LOCAL_FILE_MISSING`, `DEBUGGER_ATTACH_FAILED`, `NETWORK_ENABLE_FAILED`, `FETCH_ENABLE_FAILED`, `CACHE_DISABLE_FAILED`, `SERVICE_WORKER_BYPASS_FAILED`, `BROWSER_CACHE_CLEAR_FAILED`, `TAB_RELOAD_FAILED`, `OVERRIDE_ASSET_FETCH_FAILED`, `RESPONSE_BODY_READ_FAILED`, `FULFILL_FAILED`, `RSC_PATCH_UNSUPPORTED`, `RSC_CONTENT_TYPE_MISMATCH`, `RSC_FLIGHT_UNSUPPORTED_RECORD`, `RSC_FLIGHT_STRUCTURAL_DRIFT`, `RSC_PATCH_ANCHOR_MISMATCH`, `RSC_PATCH_UNSAFE`, and `DEBUGGER_DETACHED`
5. exposes list endpoints for runs, requests, and generated plans
6. exposes a diagnosis endpoint that summarizes likely blockers and next actions

What is currently proven:

1. the extension writes run and request audit rows through real HTTP APIs
2. the server can return those rows through list endpoints
3. the server can produce a structured diagnosis for a failed run
4. MCP clients can retrieve status, request logs, and diagnosis
5. MCP clients can enable and disable the current POC on live connected sessions
6. generated response override plans are persisted and can be queried later through `get_override_plan_log`

## Findings

### Resolved on current branch: checked-in placeholder and user-local override config support

File:

- `override-poc.config.json`

Current state:

1. `override-poc.config.json` is now a placeholder with runtime enable/disable owned by the extension and MCP tools
2. live local values can move to ignored `override-poc.local.json`
3. `OVERRIDE_POC_CONFIG_PATH` can point at an explicit custom file

Why this is better:

1. fresh clones start without machine-local paths in the tracked file
2. local machine paths no longer need to live in the tracked file
3. operators can keep machine-local setup without patching the committed config

What still remains:

1. document the local-config flow everywhere the feature is mentioned
2. eventually add profile generation and richer profile management UI

### Resolved on current branch: there is now automated proof of the core override path

Files:

- `apps/mcp-server/src/override-poc.spec.ts`
- `apps/chrome-extension/src`
- `apps/e2e-playwright/tests`

Current state:

1. server parsing and asset-serving are tested
2. there are now override-focused controller unit tests
3. there are now popup interaction tests for target-tab selection
4. there are now positive and negative Playwright override scenarios
5. there are now Playwright lifecycle scenarios for pause-disable, stop-disable, and active-tab-unbind cleanup
6. there is now a real generated Next.js fixture app used by Playwright for adapter/runtime coverage
7. Next.js fixture coverage now exercises one runtime-generated browser override each on home, about, and products pages through MCP stdio calls
8. persisted live Next.js render-artifact observation and static source-path mapping exist as MCP tools
9. bounded production/local drift detection exists for observed Next.js assets
10. persisted observed assets feed diagnosis for target URL mismatch, SRI, CSP meta tags, and service-worker control
11. popup status surfaces compact profile/rule and diagnosis details
12. Next.js source-edit planning exists as an MCP tool with temp overlay build output, observed chunk patching, and overlay TTL cleanup
13. server-action-like and generic mutation replay attempts are classified separately across validation, preflight, capture, and planning, so unsupported Next.js POST flows fail with precise blocker codes instead of a generic GET-only error

Why it matters:

1. the riskiest behavior is the browser-side attach/intercept/fulfill flow
2. the repo no longer relies only on manual confidence for the most failure-prone part

What is now proven:

1. a matching asset request is fulfilled by the override path in a real browser tab
2. a non-matching configured target leaves the original asset untouched
3. the explicit selected target tab is used by the enable flow
4. pausing a live session tears down the active override and records a terminal audit run
5. stopping a live session tears down the active override and preserves the final audit run
6. removing the active override tab from a multi-tab session disables the override and leaves the session active
7. the `nextjs` profile generator can map a real `.next/static` build and the extension-loaded Chromium runtime can fulfill real `/_next/static/...` chunk requests
8. home, about, and products page UI/functionality can be changed in the browser by temp override files without mutating fixture source files
9. observed browser `/_next/static/...` assets can be mapped back to local chunks and source-map source paths with confidence reasons
10. a source-level literal edit can be planned, written to config, enabled through MCP, and verified in the browser while fixture source files remain unchanged
11. SRI-protected source override candidates are blocked before config writing
12. observed assets are persisted per session and can be listed or reused when mapping without explicit observed asset input
13. fetched production chunks are compared against local chunks with candidate/concurrency/byte/time caps and produce `PRODUCTION_LOCAL_DRIFT` blockers on unsafe mismatch
14. diagnosis can report observed-asset mismatches and browser security blockers from persisted observation metadata
15. observations now preserve request method, inferred rule type, resource type, content type, status code, and navigation/fetch hints for document, static asset, RSC flight, Next data, and API response candidates
16. Next.js source-overlay planning now distinguishes direct source-map ownership from client-reference manifest membership, so shared manifest chunks are not remapped as page-owned chunks
17. real Next.js server action requests are blocked before response planning with `SERVER_ACTION_UNSUPPORTED`
18. real generic POST mutation requests are blocked before response planning with `MUTATION_REPLAY_UNSUPPORTED`
17. a live document response can be captured from the actual bound tab through CDP response-stage interception, patched through MCP, and fulfilled as an exact document override in Chromium
18. a dynamic Next.js App Router API response can be captured through CDP, patched through MCP, fulfilled by the override runtime, and verified through page UI
19. a real Next.js `/_next/data` response can be captured through CDP, patched through MCP, fulfilled by the override runtime, and kept isolated from a sibling data route
20. a Next.js App Router RSC flight response can be captured, planned with prefix matching, validated, fulfilled at CDP response stage, and reflected in page UI; unsafe manual RSC rules remain invalid
21. production RSC dynamic-route overrides stay isolated to the captured route across history navigation while sibling routes remain original
22. production RSC search-param overrides stay isolated to the captured query state while other query states remain original
23. matching RSC prefetch and metadata-only variants pass through unchanged when they do not contain captured patch anchors
24. preflight now treats missing live connection state, disconnected sessions, missing observed assets, no observed match for any enabled target, and observed assets recorded only for another tab as blocking readiness errors
25. `enable_overrides` now retries observed-asset readiness once by running a bounded live observation pass when asset readiness is the only blocker, then rebuilds preflight before enabling
26. preflight now matches exact and prefix target rules consistently with runtime fulfillment and allows generated multi-asset profiles when at least one enabled target was observed for the session
27. override live-command timeouts now surface structured diagnostics with command name, timeout, original bridge message, and session connection state when available
28. `get_override_status` and `disable_overrides` can fall back to persisted audit state on live timeout or disconnect, returning latest run/request/plan data, preflight, diagnosis, and reconnect/retry next actions

What still remains:

1. add one background-level lifecycle test for pause/disable symmetry

### Resolved on current branch: pause now disables the active override

Files:

- `apps/chrome-extension/src/background.ts`
- `apps/chrome-extension/src/override-poc.ts`

Current state:

1. enabling still requires an active non-paused session
2. stopping disables the override
3. removing the last bound tab disables the override
4. removing or closing the active override tab disables the override even when other tabs remain bound
5. pausing now disables the override before the session is paused

Why it matters:

1. "paused session" no longer leaves the override attached
2. lifecycle semantics are easier for operators to reason about

What still remains:

1. add direct background-level unit coverage for lifecycle contracts that are currently covered by e2e

### Resolved on current branch: target-tab selection is now explicit

Files:

- `apps/chrome-extension/src/background.ts`
- `apps/chrome-extension/src/popup.ts`

Current state:

The popup now exposes a dedicated override target select populated from bound session tabs, and the background stores that selection separately from generic capture heuristics.

Why it matters:

1. operators can choose the intended bound tab before enable
2. the selected tab remains visible in popup status

What still remains:

1. add request-level history and failure categories directly in the popup

### Resolved on current branch: exact multi-rule override profiles now exist

Files:

- `override-poc.config.json`
- `apps/mcp-server/src/override-poc.ts`
- `apps/chrome-extension/src/override-poc.ts`

Current state:

1. one active profile selected by `activeProfileId`
2. multiple exact URL/file rules per profile
3. per-rule content types and file validation
4. one attached tab

Why it matters:

1. this is enough for exact multi-asset replacement and generated candidate configs
2. real apps still need generator-level observed URL scoring and body-aware response planning for higher-confidence app-wide mappings

What still remains:

1. add origin mismatch and suspicious mapping warnings
2. add observed production URL scoring to improve generated mappings
3. add framework-specific adapters where they improve confidence beyond `static`
4. add popup profile/rule management instead of config-file editing only

### Resolved on current branch: adapter-based candidate profile generation exists

Files:

- `apps/mcp-server/src/override-profile-generator.ts`
- `apps/mcp-server/src/mcp/server.ts`
- `README.md`
- `apps/docs/docs/extension/experimental-override-poc.md`

Current state:

1. `create_override_profile` can generate reviewable profile JSON
2. `nextjs` scans `.next` manifests and `.next/static`
3. `static` scans any local asset directory and works for framework-neutral builds
4. generated configs are usable by default, with runtime activation still controlled by the extension or MCP tools
5. writing `override-poc.local.json` is explicit with `writeConfig=true`

Architecture guardrail:

The override runtime is framework-agnostic. Adapters generate exact URL/file rules by default, and prefix matching is available for planner-controlled unstable response URLs, so future Angular, Vue/Nuxt, Vite, SvelteKit, Remix, and no-framework support can reuse the same validation, serving, interception, audit, and diagnosis paths.

What still remains:

1. add generator-level scoring from persisted observed production network URLs
2. add framework-specific manifest adapters only when `static` is not enough
3. add SRI/CSP-aware warnings for generated rules

### Resolved on current branch: request audit and baseline diagnosis now exist

Files:

- `override_plan.md`
- `apps/chrome-extension/src/override-poc.ts`
- `apps/mcp-server/src/main.ts`

Current state:

The current POC now has:

1. durable `override_runs`
2. durable `override_requests`
3. a structured failure code taxonomy
4. HTTP list endpoints for audit retrieval
5. an HTTP diagnosis endpoint with likely blockers and next actions

What is missing:

1. popup request log UI
2. stronger proof for page-specific SRI/CSP detection beyond heuristics
3. richer browser-side signals for cache/service-worker attribution

Why it matters:

1. "override did not work" is the main failure mode
2. durable audit and diagnosis now give the team a concrete starting point instead of a free-form last error

What still remains:

1. lift request log and diagnosis details into popup
2. improve detection quality for SRI/CSP/cache-specific blockers

### Resolved on current branch: override control is exposed through MCP tools

Files:

- `override_plan.md`
- `apps/mcp-server/src/mcp/server.ts`

Current state:

1. overrides remain controllable through the popup and HTTP endpoints
2. MCP now exposes tools to validate, enable, disable, inspect, log, and diagnose the current POC

Why it matters:

1. the feature now fits the bridge's main control model for the current POC scope
2. LLM/client-driven workflows can operate it directly on connected live sessions

Implemented tool surface:

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

## Recommended Delivery Plan

## Phase 1: Harden the current POC into a usable internal feature

Target: 3 to 5 days

Deliverables:

1. safe default checked-in config
2. user-local override config support
3. override disabled automatically on pause
4. explicit target-tab selection in popup
5. clearer active-state and error messaging
6. controller unit tests
7. popup tests
8. one positive Playwright spec
9. one negative Playwright spec

Acceptance criteria:

1. a fresh clone does not expose a broken enabled config
2. operators can see and choose the target tab before enable
3. pausing a session always disables the override
4. one deterministic e2e test proves a local asset replaces a prod asset

Status on current branch:

1. delivered for the browser path
2. lifecycle coverage exists through Playwright; direct background-only regression tests are still missing

## Phase 2: Add diagnostics and request auditability

Target: 4 to 6 days

Deliverables:

1. `override_runs` table
2. `override_requests` table
3. failure code taxonomy
4. request log UI or at least retrievable JSON
5. diagnosis endpoint/tool for cache, SW, SRI, CSP, and tab-selection blockers

Acceptance criteria:

1. every override session has a durable run record
2. every matched request produces an audit row
3. failed runs return structured reasons instead of only free-form errors

Status on current branch:

1. backend delivery complete
2. MCP surface delivered for current POC scope
3. popup request-log and diagnosis details still missing

## Phase 3: Replace the hardcoded config with override profiles

Target: 5 to 7 days

Deliverables:

1. profile format with multiple rules
2. profile validation
3. multi-asset support
4. guardrails for missing files, invalid origins, and suspicious mappings

Acceptance criteria:

1. one profile can override multiple assets
2. invalid profiles fail fast with actionable validation output
3. the extension no longer depends on a single hardcoded config shape

Status on current branch:

1. delivered for config-file based exact URL profiles
2. richer validation and popup profile management still remain

## Phase 4: Add adapter-based mapping generation

Target: 5 to 8 days

Deliverables:

1. adapter contract for framework-specific generators
2. local manifest parser
3. prod asset list ingestion
4. proposed mapping generator with confidence levels
5. explicit warnings for build-id mismatches and integrity risks

Acceptance criteria:

1. a developer can generate a candidate override profile instead of hand-writing exact URLs
2. `static` works as a universal fallback for framework-neutral builds
3. framework-specific adapters improve confidence without changing the runtime override engine
4. the system explains weak or risky mappings before enable

Status on current branch:

1. baseline adapter contract delivered through `create_override_profile`
2. `nextjs` and `static` adapters delivered
3. generator-level observed URL confidence scoring still missing

## Phase 5: Expose the feature through MCP

Target: 3 to 5 days

Deliverables:

1. MCP tool schemas
2. status and log responses
3. enable/disable flows
4. diagnosis tool
5. documentation and examples

Acceptance criteria:

1. popup and MCP use the same underlying status/diagnostic model
2. an MCP client can operate the feature without relying on the popup

Status on current branch:

1. delivered for the current exact-rule profile scope
2. future generated-profile work will need expanded validation and tool responses

## Next.js Production Response Plan

The current branch now has the typed observation foundation needed for production Next.js apps that are mostly or entirely RSC-driven. It can observe and persist candidate request classes for:

1. static assets and client chunks
2. document navigations
3. RSC flight responses
4. Next data responses
5. API/fetch responses

Current progress on that response path:

1. bounded live text response capture now exists for safe `GET`/`HEAD` requests through extension fetch or explicit CDP response-stage interception on a bound tab, and for planner-scoped POST RSC Flight response-stage captures through CDP, with byte caps and sensitive caller-supplied header blocking where caller-supplied headers are accepted
2. response patch planning now exists for supplied or live-captured bodies, with content-type checks, byte caps, exact text match counts, parser-based document patches, JSON Pointer existing-value replacements, JSON validity checks, generated body files, and exact or prefix override config writing for supported response types
3. planner-generated RSC flight rules validate patches against parsed Flight JSON string values and reject tagged records, React element type/key tokens, object keys, protocol/reference tokens, and content outside string payloads while allowing JSON-escaped replacements
4. the runtime can fulfill generated document/API/data response files through the request-stage rule path, with request-method matching; planner-generated RSC flight rules use a response-stage path that applies structured string-value patches to the live Flight body with the same RSC safety validation
5. Playwright coverage now proves an exact document response override can be planned through MCP and fulfilled in Chromium
6. Playwright coverage now proves CDP response-stage capture can capture the actual in-tab document response, feed it into parser-based `documentPatches`, and fulfill the generated document override
7. Playwright coverage now proves a Next.js Pages Router document can be captured through CDP, patched through `script#__NEXT_DATA__` JSON Pointer document patches, fulfilled through an exact override rule, and kept isolated from a sibling page
8. Playwright coverage now proves a dynamic Next.js App Router API JSON response can be captured through CDP, patched with structured JSON Pointer replacements, fulfilled through an exact override rule, and reflected in the page UI
9. Playwright coverage now proves a real Next.js `/_next/data` response can be captured through CDP, patched with structured JSON Pointer replacements, fulfilled through an exact override rule, and kept isolated from a sibling data route
10. Playwright and MCP unit coverage now prove generated response override plan metadata is persisted with hashes, patch summaries, generated file paths, and rollback instructions, then retrieved through `get_override_plan_log`
11. Playwright coverage now proves a Next.js App Router RSC flight response can be captured, planned with prefix URL matching, validated, fulfilled at CDP response stage, and reflected in the page UI
12. Playwright coverage now proves production RSC dynamic route and search-param overrides remain isolated to their captured route/query variants
13. Playwright coverage now proves matching RSC prefetch and metadata-only variants pass through unchanged when they do not contain captured patch anchors
14. Playwright investigation coverage still proves simple fixture RSC replay through direct CDP and through the explicit experimental opt-in path, while manual RSC configs without planner metadata remain invalid
15. planner, capture, validation, and preflight now classify real Next.js server action requests as `SERVER_ACTION_UNSUPPORTED`
16. planner, capture, validation, and preflight now classify generic POST mutation replay attempts as `MUTATION_REPLAY_UNSUPPORTED`
17. Playwright coverage now proves a real Next.js server action request is blocked before response planning with `SERVER_ACTION_UNSUPPORTED`
18. Playwright coverage now proves a real generic POST mutation request is blocked before response planning with `MUTATION_REPLAY_UNSUPPORTED`
19. preflight and MCP unit coverage now prove disconnected/no-connection sessions, missing observed assets, and wrong-tab observed assets block enablement with precise readiness codes
20. MCP unit coverage now proves `enable_overrides` observes assets before enabling when asset readiness is the only blocker, and fails without enabling when that observation times out
21. MCP unit coverage now proves prefix-match response rules count as observed and generated multi-target profiles are not blocked by unrelated unobserved chunks
22. MCP unit coverage now proves override enable, disable, live status, asset observation, and response-body capture return structured timeout diagnostics or persisted-audit fallback instead of opaque bridge timeouts

Future broadening work outside the current production contract:

1. expand RSC support beyond the current structured string-value replacement subset
2. add rule-specific patch planners beyond guarded string-value replacement, especially structured RSC flight segment edits and advanced JSON operations for Next data/API bodies
3. keep unsupported mutations blocked, especially changes that require server code execution, route/module boundary changes, server action behavior changes, or module-id/payload protocol rewrites
4. add remaining Next.js fixture coverage for loading/error boundaries, cache behavior, and service-worker/security blockers
5. add production-like e2e coverage against a built Next.js app with cache and service-worker blockers diagnosed, then document the exact supported/unsupported matrix

## RSC Support Investigation Result

The RSC investigation against `apps/override-next-fixture` changed the risk picture:

1. direct Chrome CDP can read and continue an RSC flight response without breaking App Router navigation
2. direct Chrome CDP can replay unmodified RSC bodies at response stage
3. direct Chrome CDP can replay structured string-value patched RSC bodies at response stage and request stage
4. the extension/MCP override path can fulfill a patched RSC flight body through a planner-generated production rule
5. the production runtime can apply structured string-value RSC patches to the live response body at CDP response stage, so harmless per-request Flight drift does not force stale-body replay
6. the runtime applies captured structured patches to dynamic RSC route and search-param variants without leaking them to sibling routes or other query states
7. the runtime passes through matching prefetch and metadata-only Flight variants when they do not contain the captured patch anchors
8. ordinary matching RSC responses that miss expected anchors still continue the original response and record a structured failure

That means RSC support is no longer only an investigation path. The supported production subset is intentionally narrow: captured `text/x-component` `GET` responses with `_rsc` URLs, captured POST `text/x-component` response-stage patches with RSC request context and no `next-action` header, planner-generated `structured-flight-v1` metadata, and exact text replacements that stay inside parsed Flight JSON string values. Tagged Flight records, React element type/key tokens, object keys, Flight protocol/reference tokens, and content outside string payloads are blocked; replacements that require JSON escaping are supported through JSON serialization.

Future RSC broadening outside the current production contract:

1. expand beyond guarded string-value replacement only after there is structured Flight segment and value-path patching
2. broaden fixture coverage for loading/error boundaries, cache behavior, and service-worker/security blockers before claiming support for those specific edge classes

## Minimum Practical Target

If the goal is "make overrides genuinely usable for internal debugging", stop after Phases 1 and 2.

That would produce:

1. safe setup
2. correct lifecycle behavior
3. explicit target selection
4. basic automated confidence
5. request-level diagnosis

If the goal is "make overrides a first-class Browser Debug MCP capability", Phases 3 through 5 are also required.

## Recommended Priority Order

1. Lift request log and diagnosis into popup UX.
2. Build the Next.js profile generator.
3. Add richer profile validation and popup profile/rule management.
4. Add the optional direct background-only lifecycle regression test.

## Bottom Line

The project is past "idea" and past "toy". The repo already contains a meaningful POC that can validate exact multi-asset replacement manually.

But it is still before the point where the team should trust it as a standard production-debug workflow.

To make it happen for real, the next step is not more interception cleverness. The next step is hardening:

1. safe defaults
2. lifecycle correctness
3. explicit operator control
4. tests
5. diagnostics

After that, the real product work starts: generated mappings and richer profile management.
