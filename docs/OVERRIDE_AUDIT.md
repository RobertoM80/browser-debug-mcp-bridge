# Override Feature Audit

Date: 2026-04-25
Branch reviewed: `feat/add-overrides`
HEAD reviewed: `ce82bb0`

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
- Mapping and profile system: exact multi-rule profiles plus adapter-based candidate generation implemented; observed production URL ingestion absent
- MCP control plane: implemented for current POC scope
- Automated confidence: meaningful baseline, still incomplete
- Production readiness: not ready

## Current Capability Scorecard

| Area | Status | Notes |
| --- | --- | --- |
| Single-asset replacement through CDP | Implemented | Exact URL only, exact local file only |
| Local config loading and validation | Implemented | Safe checked-in placeholder, automatic `override-poc.local.json` preference, optional `OVERRIDE_POC_CONFIG_PATH` |
| Asset serving from local file | Implemented | Server only serves when `assetUrl` exactly matches configured target |
| Popup controls | Implemented | Enable, disable, refresh, counters, last error |
| Cache and SW bypass before reload | Implemented | Done during enable flow |
| Stop/session cleanup integration | Implemented | Stop, last-tab removal, active target unbind, and active target close disable override |
| Pause lifecycle integration | Implemented | Pause now disables the active override before pausing the session |
| Explicit target-tab selection | Implemented | Popup lets the operator choose the bound override target tab and locks selection while active |
| Multi-asset profiles | Implemented baseline | Active profile can contain multiple exact URL/file rules |
| Profile generation | Implemented baseline | Adapter model with `nextjs` and generic `static`; observed production URL ingestion still missing |
| Failure diagnosis | Implemented baseline | HTTP and MCP diagnosis exists with heuristic blockers and structured failure codes |
| Request audit log | Implemented | Durable `override_runs` and `override_requests` history exists through HTTP JSON and MCP tools |
| MCP tools for overrides | Implemented | Current POC exposes profile, validation, enable, disable, status, request log, and diagnosis tools |
| Override-focused unit/e2e coverage | Strong baseline | Controller tests, popup tests, positive/negative Playwright flows, pause/stop lifecycle flows, active-tab unbind, and a real Next.js fixture flow now exist |

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
8. it fulfills only the configured exact asset URL
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

Current limitation:

1. popup does not show request-level history or failure categories

### 4. Server-side audit and diagnosis

Files:

- `apps/mcp-server/src/override-audit.ts`
- `apps/mcp-server/src/main.ts`
- `apps/mcp-server/src/db/schema.ts`
- `apps/mcp-server/src/db/migrations.ts`

Implemented behavior:

1. persists durable `override_runs` rows keyed by session and run id
2. persists durable `override_requests` rows for matched target requests
3. records structured failure codes such as `CONFIG_DISABLED`, `LOCAL_FILE_MISSING`, `DEBUGGER_ATTACH_FAILED`, `OVERRIDE_ASSET_FETCH_FAILED`, `FULFILL_FAILED`, and `DEBUGGER_DETACHED`
4. exposes list endpoints for runs and requests
5. exposes a diagnosis endpoint that summarizes likely blockers and next actions

What is currently proven:

1. the extension writes run and request audit rows through real HTTP APIs
2. the server can return those rows through list endpoints
3. the server can produce a structured diagnosis for a failed run
4. MCP clients can retrieve status, request logs, and diagnosis
5. MCP clients can enable and disable the current POC on live connected sessions

## Findings

### Resolved on current branch: safe checked-in config and user-local override config support

File:

- `override-poc.config.json`

Current state:

1. `override-poc.config.json` is now a disabled placeholder
2. live local values can move to ignored `override-poc.local.json`
3. `OVERRIDE_POC_CONFIG_PATH` can point at an explicit custom file

Why this is better:

1. fresh clones start from a safe default
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
8. persisted live Next.js asset observation and source-path mapping exist as MCP tools
9. bounded production/local drift detection exists for observed Next.js assets
10. persisted observed assets feed diagnosis for target URL mismatch, SRI, CSP meta tags, and service-worker control
11. popup status surfaces compact profile/rule and diagnosis details
12. Next.js source-edit planning exists as an MCP tool with temp overlay build output, observed chunk patching, and overlay TTL cleanup

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
2. real apps still need observed production URL matching for higher-confidence app-wide mappings

What still remains:

1. add origin mismatch and suspicious mapping warnings
2. add observed production URL ingestion to improve generated mappings
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
4. generated configs are disabled by default unless explicitly requested
5. writing `override-poc.local.json` is explicit with `writeConfig=true`

Architecture guardrail:

The override runtime is framework-agnostic. Adapters only generate exact URL/file rules, so future Angular, Vue/Nuxt, Vite, SvelteKit, Remix, and no-framework support can reuse the same validation, serving, interception, audit, and diagnosis paths.

What still remains:

1. ingest observed production network URLs for confidence scoring
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
4. `enable_overrides`
5. `disable_overrides`
6. `get_override_status`
7. `get_override_request_log`
8. `diagnose_overrides`

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
3. observed production URL ingestion and confidence scoring still missing

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
