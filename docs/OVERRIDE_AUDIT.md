# Override Functionality Audit

Date: 2026-03-19
Branch reviewed: `feat/add-overrides`
Primary implementation commit: `3658c4c` (`test: add poc overrides`)

## Executive Summary

What was added is a real, working override proof of concept, not the full override control plane described in `override_plan.md`.

The POC currently proves this narrow path:

1. the Chrome extension can attach `chrome.debugger` to a selected session tab
2. the extension can enable CDP `Fetch` and `Network`
3. cache can be disabled and service worker bypass can be turned on before reload
4. one exact production asset URL can be fulfilled with local bytes served by the local MCP server
5. the popup can show basic status for the attached tab and match/fulfill counters

That is useful progress. It validates the hardest single mechanism. But it is still far from "finished" if the target is reliable production override workflows for everyday debugging.

My assessment:

- Core POC mechanism: good
- Docs and operator flow: good enough for internal use
- Lifecycle hardening: incomplete
- Diagnostics and auditability: weak
- Automated coverage: weak
- Production readiness: not ready

## What We Recently Added

The recent override work spans four areas.

### 1. Chrome extension interception path

Files:

- `apps/chrome-extension/src/override-poc.ts`
- `apps/chrome-extension/src/background.ts`
- `apps/chrome-extension/public/manifest.json`

What it does:

1. adds the `"debugger"` permission
2. adds an `OverridePocController`
3. fetches override config from the local server
4. attaches CDP to one tab
5. enables `Network` and `Fetch`
6. disables cache, bypasses service workers, clears browser cache
7. listens for `Fetch.requestPaused`
8. fulfills only the exact configured `targetAssetUrl`
9. continues every non-matching request normally
10. detaches on stop and on some tab/session cleanup paths

### 2. Local server config and asset serving

Files:

- `apps/mcp-server/src/override-poc.ts`
- `apps/mcp-server/src/main.ts`

What it does:

1. loads `override-poc.config.json`
2. resolves relative local file paths against the config directory
3. validates `enabled`, `targetAssetUrl`, `localFilePath`, `contentType`, and `autoReload`
4. exposes `GET /overrides/poc/config`
5. exposes `GET /overrides/poc/asset?assetUrl=...`
6. serves the configured local bytes only when the requested URL is an exact match

### 3. Popup controls and status

Files:

- `apps/chrome-extension/public/popup.html`
- `apps/chrome-extension/public/popup.css`
- `apps/chrome-extension/src/popup.ts`

What it does:

1. adds an `Override POC` panel to the popup
2. adds `Enable POC`, `Disable POC`, and `Refresh override status`
3. shows target asset URL, local file path, config path, attached tab id, matched count, fulfilled count
4. surfaces server/config/file errors in popup status text

### 4. Docs and a minimal server-side test

Files:

- `README.md`
- `HOW_TO_USE_BROWSER_DEBUG_MCP_BRIDGE.md`
- `apps/docs/docs/extension/experimental-override-poc.md`
- `apps/mcp-server/src/override-poc.spec.ts`

What it does:

1. documents the local-only setup and manual flow
2. adds unit coverage for config resolution and exact-match asset serving on the server side

## What Is Actually Proven Today

Based on the code currently in the repo, these claims are well supported:

1. The server can load and validate a POC config file.
2. The server can resolve relative local paths from the config file directory.
3. The server will only serve bytes for the exact configured asset URL.
4. The extension can attach a debugger session and attempt request fulfillment through CDP.
5. The extension will disable cache and bypass service workers before reloading when `autoReload` is `true`.
6. The popup can read and display override state.

These are not yet strongly proven by automated tests in this repo:

1. that a real browser request is successfully overridden end-to-end
2. that service worker bypass works reliably across real app setups
3. that pause/resume/stop lifecycle is correct in every state
4. that multi-tab behavior is predictable
5. that cross-origin CDN assets work
6. that SRI/CSP/CORS edge cases are handled

## Audit Findings

### High: checked-in config is not safe as a shared default

File:

- `override-poc.config.json`

Current state:

1. `enabled` is checked in as `true`
2. `localFilePath` is a machine-specific absolute path
3. docs show a disabled placeholder config, but the actual file does not match that

Why it matters:

1. fresh clones will present the feature as enabled but broken
2. it leaks local machine path structure into the repo
3. it makes the default operator experience noisy and misleading

Recommendation:

1. check in a disabled placeholder config
2. move real local config to ignored user-local config later if this feature stays

Effort:

- about 30 minutes

### High: there is no automated proof that the override works end-to-end

Files:

- `apps/mcp-server/src/override-poc.spec.ts`
- `apps/e2e-playwright/tests/*`
- `apps/chrome-extension/src/**/*.spec.ts` does not currently contain override specs

Current state:

1. server-side parsing and exact-match asset serving are tested
2. extension interception and popup control flow are not override-tested
3. Playwright suites do not currently cover override behavior

Why it matters:

1. the riskiest part is the browser/CDP path, and that is the untested part
2. regressions in attach, fulfill, reload timing, or popup wiring can slip through easily

Recommendation:

1. add one deterministic Playwright test for the positive path
2. add one negative-path Playwright test
3. add unit tests around `OverridePocController` with mocked `chrome.debugger`

Effort:

- 2 to 4 engineer-days for useful coverage

### Medium: pause lifecycle is inconsistent with override lifecycle

Files:

- `apps/chrome-extension/src/background.ts`
- `apps/chrome-extension/src/override-poc.ts`

Current state:

1. `OVERRIDE_POC_ENABLE` requires an active, non-paused session
2. `SESSION_STOP` disables the override
3. removing the last bound tab disables the override
4. `SESSION_PAUSE` does not disable the override

Why it matters:

1. pausing a session does not actually stop the override attachment
2. users can reasonably assume "paused" means the runtime is no longer mutating requests
3. the debugger can stay attached longer than expected

Recommendation:

1. either disable override automatically on pause
2. or document clearly that pause does not affect overrides and show that state explicitly

Effort:

- about 0.5 to 1 day including tests

### Medium: tab selection for the override is implicit, not explicit

Files:

- `apps/chrome-extension/src/background.ts`

Current state:

`resolveCaptureTab()` prefers the remembered session tab and otherwise uses the first available bound tab. The popup does not let the user explicitly choose the override target tab.

Why it matters:

1. in a multi-tab session, the override may attach to a different tab than the user expects
2. this makes "it did not work" harder to diagnose

Recommendation:

1. add an explicit "attach override to current active tab" or selected tab control
2. show the chosen tab before enable, not only after enable

Effort:

- about 0.5 to 1.5 days

### Medium: diagnostics are still much thinner than the original plan

Files:

- `override_plan.md`
- `apps/chrome-extension/src/override-poc.ts`
- `apps/mcp-server/src/main.ts`

Current state:

The current POC exposes only:

1. active/inactive
2. attached tab id
3. matched count
4. fulfilled count
5. last error

What is missing relative to the plan:

1. request audit log
2. failure codes
3. service worker/cache diagnosis
4. SRI/CSP diagnosis
5. structured next actions

Why it matters:

1. when the override does not apply, there is very little evidence about why
2. the current POC can prove success, but it cannot explain failure very well

Recommendation:

1. implement the "Override Doctor" style diagnostics before broadening scope further
2. persist at least a small in-memory or DB-backed request log per run

Effort:

- 3 to 5 engineer-days for a meaningful first pass

### Medium: header parity is incomplete for cross-origin and security-sensitive cases

Files:

- `apps/chrome-extension/src/override-poc.ts`

Current state:

The fulfilled response only sets:

1. `Content-Type`
2. `Cache-Control`
3. `Content-Length`
4. `X-BDMCP-Override-Poc`

Inference from code:

This may be insufficient for some CDN, module, or security-sensitive asset loads because original response headers are not preserved or emulated. That can matter for CORS, CSP-related behavior, or other resource policy checks.

Why it matters:

1. same-origin script replacement can still work
2. cross-origin and more locked-down setups are more likely to fail

Recommendation:

1. test same-origin and CDN-origin paths separately
2. decide whether to preserve selected original headers or explicitly synthesize safe ones

Effort:

- 1 to 3 engineer-days depending on desired scope

### Low to Medium: every request is intercepted even though only one URL matters

Files:

- `apps/chrome-extension/src/override-poc.ts`

Current state:

`Fetch.enable` is configured with `urlPattern: '*'`, so all requests pause and non-matches are continued immediately.

Why it matters:

1. acceptable for a narrow POC
2. unnecessary overhead for busy pages
3. increases the blast radius if interception logic regresses

Recommendation:

1. narrow the pattern if CDP matching works reliably for the target URL
2. otherwise keep this as-is until diagnostics and tests improve

Effort:

- less than 0.5 day

### Medium: override control is not exposed as MCP tools yet

Files:

- `override_plan.md`
- `apps/mcp-server/src/mcp/server.ts`

Current state:

The POC is controlled from the extension popup, not from MCP tools.

Why it matters:

1. it proves the browser mechanism
2. it does not yet satisfy the broader "bridge-controlled override" vision
3. LLM-driven flows cannot enable, inspect, or diagnose overrides directly

Recommendation:

1. keep popup control for manual recovery
2. add MCP tools only after status, diagnostics, and lifecycle are more stable

Effort:

- 2 to 4 engineer-days for a first useful MCP surface

## Was This Implemented Well?

Short answer: yes for a POC, no for a finished feature.

What was done well:

1. The feature was kept intentionally narrow.
2. The exact-match rule reduces accidental overrides.
3. The server and extension responsibilities are separated cleanly.
4. Cache disable and service worker bypass were included from the start, which was the right call.
5. The popup includes enough visible state to operate the POC without digging through code.

What can be improved materially:

1. default config hygiene
2. lifecycle consistency on pause/resume
3. diagnostics and request-level evidence
4. automated coverage of the actual browser path
5. tab targeting clarity
6. cross-origin/security/header handling

## Status Against `override_plan.md`

The current work does not follow the plan sequence exactly.

What the plan said to do first:

1. Phase 0 diagnostics
2. then mapping/profile work
3. then a robust override engine

What actually happened:

1. a minimal slice of Phase 2 was implemented first
2. enough UI and server support was added to prove the mechanism
3. most of Phase 0, Phase 1, Phase 3, and Phase 4 are still missing

That was not necessarily a bad decision. It answered the key question, "can we replace a real production asset with local bytes through this bridge?" The answer is now effectively "yes, in a narrow manually configured case." The cost is that failure analysis and production hardening are still mostly ahead of us.

## Remaining Work

### To finish the current POC into a reliable internal MVP

Recommended order:

1. sanitize the checked-in config default
2. fix pause/override lifecycle semantics
3. add explicit override target tab selection
4. add request log and failure reasons
5. add one positive and one negative Playwright override test
6. add controller unit tests in the extension

Estimated effort:

- about 6 to 10 engineer-days

### To reach the broader "production override control plane" vision

Still missing:

1. profile format for multiple assets
2. mapping generation for Next.js assets
3. diagnostics for cache, service worker, SRI, CSP, and origin mismatches
4. persisted audit logs
5. MCP tool surface
6. stronger safety guardrails
7. wider integration and failure-matrix coverage

Estimated effort beyond the current POC:

- about 20 to 30 engineer-days

That is consistent with the earlier `override_plan.md` estimate once the already-completed POC slice is subtracted.

## Manual Tests To Confirm It Works

These are the highest-value manual checks.

### Positive path

1. Configure one same-origin JS asset with a clear visible code change.
2. Start or resume a session on the target tab.
3. Enable the POC with `autoReload: true`.
4. Confirm the page behavior changes as expected.
5. Confirm popup counters show at least `matched = 1` and `fulfilled = 1`.

### Disabled config

1. Set `enabled` to `false`.
2. Refresh popup status.
3. Confirm the popup says the POC is disabled.
4. Confirm `Enable POC` is disabled.

### Missing file

1. Point `localFilePath` to a missing file.
2. Refresh popup status.
3. Confirm the popup reports the missing file.
4. Confirm `Enable POC` is disabled.

### URL mismatch

1. Configure the wrong production asset URL.
2. Enable the POC.
3. Reload the page.
4. Confirm `matched = 0`, `fulfilled = 0`, and the page still runs the production asset.

### Service worker bypass

1. Use a page that normally serves the asset through a service worker.
2. Enable the POC with `autoReload: true`.
3. Confirm the override still applies after reload.
4. Repeat after a second reload to confirm it is not just a one-time lucky path.

### Stop and tab-close cleanup

1. Enable the POC successfully.
2. Stop the session.
3. Confirm the popup returns to inactive state.
4. Repeat with closing the attached tab instead of stopping the session.

### Pause behavior

1. Enable the POC successfully.
2. Pause the session.
3. Reload the page.
4. Observe whether the override still applies.

This test is especially important because the code suggests pause does not currently disable the override.

### Multi-tab behavior

1. Bind two tabs to the same session.
2. Enable the POC.
3. Confirm which tab was actually attached.
4. Reload both tabs and confirm only the attached tab is affected.

### Cross-origin CDN asset

1. Use a target asset hosted on a different origin than the page HTML.
2. Enable the POC.
3. Confirm whether the asset executes successfully after override.
4. Inspect console/network for CORS or policy failures if it does not.

### SRI-sensitive page

1. Use a page with script integrity enabled if available.
2. Override the target script with modified local bytes.
3. Confirm whether the browser blocks execution.
4. Capture the exact browser error for later diagnostics work.

## Automated Tests To Add

### Server-side Vitest

File suggestion:

- `apps/mcp-server/src/override-poc.spec.ts`

Add coverage for:

1. disabled config returns the expected error
2. missing local file returns the expected error
3. invalid JSON and invalid field types return clear validation errors
4. `contentType` defaulting works when omitted
5. absolute local paths are handled correctly

### Extension/controller Vitest

File suggestion:

- `apps/chrome-extension/src/override-poc.spec.ts`

Mock:

1. `chrome.debugger`
2. `chrome.tabs`
3. `fetch`

Add coverage for:

1. `enableForTab()` attaches debugger and enables `Network`/`Fetch`
2. `enableForTab()` reloads when `autoReload` is true
3. non-matching requests are continued
4. matching requests are fulfilled
5. fulfill failures fall back to `Fetch.continueRequest`
6. `disable()` detaches cleanly
7. unexpected detach clears active state

### Popup wiring Vitest or E2E

There is value in a small unit test for `parseOverridePocStatus()` and `renderOverridePocStatus()`, but the higher-value investment is Playwright because the real risk is runtime integration, not DOM formatting.

### Playwright E2E

File suggestion:

- `apps/e2e-playwright/tests/full.override-poc.spec.ts`

Recommended scenarios:

1. Positive path:
   - launch extension and local server
   - serve a fixture page that loads a known JS asset
   - point `override-poc.config.json` at a local modified asset
   - enable the POC
   - assert the modified runtime behavior appears in the page
   - assert popup shows `fulfilled >= 1`
2. Negative path:
   - configure a wrong target URL
   - enable the POC
   - assert the page behavior stays unchanged
   - assert popup shows no fulfillments
3. Lifecycle path:
   - enable the POC
   - stop the session
   - reload
   - assert the override no longer applies

### Stretch automated tests

Only after the basic positive/negative path is stable:

1. service worker fixture
2. cross-origin asset fixture
3. multi-tab attachment behavior
4. SRI failure fixture

## Recommended Next Step

Do not broaden this into multi-asset mapping yet.

The best next move is:

1. clean up the default config
2. fix pause lifecycle
3. add one deterministic Playwright override spec
4. add lightweight request diagnostics

That gets the feature from "useful proof" to "reliable enough to iterate on safely."
