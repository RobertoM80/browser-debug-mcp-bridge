# Production Override Control Plan

## 1) Goal

Build a reliable way to test **local code changes** against a **real production URL** by replacing selected JS/CSS assets (for example Next.js chunks) in the browser at runtime, with strong diagnostics when overrides do not apply.

Primary outcomes:

1. Developer can map prod assets -> local built files.
2. Browser loads local bytes instead of prod bytes for selected assets.
3. System explains exactly why override failed (cache, service worker, SRI, mapping, etc.).

---

## 2) Why manual overrides often fail (root causes)

These are the most common breakpoints and likely explain current behavior:

1. Wrong URL-to-file mapping:
   - Prod URL is `https://cdn.example.com/_next/static/chunks/...`, but override path is built for `https://app.example.com/...`.
   - Hash changed between local build and deployed build.
2. Service Worker interception:
   - SW responds from CacheStorage before network/override path.
3. Cache layers still serving stale bytes:
   - memory cache, disk cache, preloaded module cache, BFCache.
4. Next.js build parity mismatch:
   - local runtime chunk not compatible with prod manifest/build id.
5. SRI integrity mismatch:
   - script tag has `integrity=...`, local bytes fail hash check, browser blocks execution.
6. Mixed origins:
   - app HTML on one origin, static assets on another CDN origin.
7. Wrong tab/process:
   - override applied to tab A, testing tab B.
8. Compression/content headers mismatch:
   - local response served with wrong `Content-Type` or stale `ETag` logic.

---

## 3) Recommended architecture

Use an **Override Control Plane** integrated with this repo (extension + MCP server), not raw DevTools manual mapping.

### 3.1 Components

1. Chrome extension override engine (network interception).
2. MCP server override manager (mapping, validation, diagnostics, file serving).
3. MCP tools for LLM/client control.
4. Local build manifest parser (Next.js first).

### 3.2 Why this architecture

1. Deterministic behavior (no manual clicking drift).
2. Full observability (why each request was/was not overridden).
3. Reproducible runbooks across machines.
4. Easier to test in CI and local integration tests.

---

## 4) Scope

### In scope (MVP+)

1. Chromium-based browsers.
2. JS chunk override for production URL.
3. Next.js support first.
4. Per-session/per-tab enable/disable.
5. Detailed diagnostics for cache/SW/mapping/security failures.

### Out of scope (initially)

1. Firefox/Safari.
2. General binary asset rewriting beyond JS/CSS/map.
3. Multi-user distributed remote override control.

---

## 5) Implementation phases (detailed)

## Phase 0: Baseline diagnostics (must do first)

Target: 3-5 days.

### 0.1 Add "Override Doctor" without changing network yet

Create MCP tool and HTTP endpoint to diagnose why overrides would fail.

Deliverables:

1. MCP tool: `diagnose_overrides`.
2. HTTP endpoint: `GET /overrides/diagnose?sessionId=...`.
3. JSON report including:
   - current server process id and uptime.
   - tab id + active URL + origin.
   - session exists check.
   - detected static asset origins.
   - service worker presence for origin.
   - cache status snapshot (if available).
   - SRI presence on loaded script tags (if detectable via content script).

Acceptance criteria:

1. Given a live session, tool returns one JSON with "probable blockers" ranked.
2. If no blockers, tool says "ready for override trial."

### 0.2 Add request audit schema in DB

New tables:

1. `override_runs`
   - `run_id`, `session_id`, `tab_id`, `origin`, `started_at`, `ended_at`, `status`.
2. `override_requests`
   - `run_id`, `url`, `method`, `resource_type`, `intercepted`, `matched_rule`,
   - `served_local`, `failure_code`, `failure_detail`,
   - `response_status`, `from_cache`, `from_service_worker`, `ts`.

Failure codes (enum):

1. `NO_RULE_MATCH`
2. `LOCAL_FILE_MISSING`
3. `PERMISSION_DENIED`
4. `SRI_BLOCKED`
5. `CSP_BLOCKED`
6. `SERVICE_WORKER_HIT`
7. `CACHE_HIT_STALE`
8. `PROTOCOL_ERROR`
9. `TAB_NOT_ATTACHED`
10. `ENGINE_DISABLED`

---

## Phase 1: Mapping engine (prod URL -> local built files)

Target: 5-7 days.

### 1.1 Define override profile format

Add file format `.browser-debug-overrides.json`:

```json
{
  "profileName": "next-prod-debug",
  "targetOrigin": "https://app.example.com",
  "assetOrigins": ["https://app.example.com", "https://cdn.example.com"],
  "rules": [
    {
      "url": "https://cdn.example.com/_next/static/chunks/app/page-ABC123.js",
      "localFile": "C:/repo/.next/static/chunks/app/page-LOCAL123.js",
      "contentType": "application/javascript; charset=utf-8"
    }
  ]
}
```

### 1.2 Build a Next.js profile generator

CLI command:

1. `pnpm overrides:generate --framework next --repo <path> --prod-manifest <path-or-url>`

Generator responsibilities:

1. Parse local `.next` manifests.
2. Parse prod asset list (from live session network or provided manifest).
3. Propose mapping with confidence score.
4. Flag non-match items explicitly.

Confidence levels:

1. `high`: exact logical route + chunk group match.
2. `medium`: basename/function group match only.
3. `low`: heuristic only, needs manual confirm.

### 1.3 Guardrails

1. Reject mapping where local file is missing.
2. Warn when build id differs.
3. Warn when SRI likely present on target script.

---

## Phase 2: Override engine (actual request replacement)

Target: 10-15 days.

### 2.1 Extension permissions and attach model

Manifest updates likely required:

1. Add `"debugger"` permission.
2. Keep `"<all_urls>"` host permissions.

Runtime attach flow:

1. Attach debugger to selected tab.
2. Enable `Network` and `Fetch` domains.
3. Intercept requests that match override rules.

### 2.2 Request interception and fulfillment

For each matching request:

1. Read local file bytes.
2. Serve through CDP `Fetch.fulfillRequest`.
3. Set headers:
   - `Content-Type` from rule or inferred.
   - `Cache-Control: no-store, no-cache, must-revalidate`.
   - omit `ETag` and `Last-Modified` in overridden response.

If any step fails:

1. Record `failure_code`.
2. Continue original request to avoid page deadlock.

### 2.3 Cache and service worker controls (critical)

At run start:

1. `Network.setCacheDisabled(true)`.
2. `Network.setBypassServiceWorker(true)`.
3. `Network.clearBrowserCache`.
4. Optional "hard reload after attach."

Important behavior:

1. These controls must be applied **before** first navigation/request.
2. If tab already loaded, reload once with controls active.

### 2.4 SRI/CSP strategy

SRI:

1. Detect integrity attributes in script/link tags.
2. If SRI present and overridden bytes do not match hash:
   - fail fast with `SRI_BLOCKED`,
   - suggest adding HTML override for integrity attribute or disabling SRI in test environment.

CSP:

1. Detect console/network CSP violations.
2. Mark `CSP_BLOCKED` with violating directive.

---

## Phase 3: MCP tools and UX

Target: 5-7 days.

Add tools:

1. `list_override_profiles`
2. `create_override_profile`
3. `validate_override_profile`
4. `enable_overrides`
5. `disable_overrides`
6. `get_override_status`
7. `get_override_request_log`
8. `diagnose_overrides`

Required responses:

1. Always include structured `nextActions`.
2. Never return generic "failed" without failure code.

Example `nextActions`:

1. "Reload tab after bypassing service worker."
2. "Local file missing: rebuild project."
3. "SRI detected: cannot replace bytes unless integrity also changed."

---

## Phase 4: Test matrix and reliability hardening

Target: 7-10 days.

## 4.1 Integration tests

Cases:

1. No SW + no cache + matching file -> override works.
2. SW active -> bypass works.
3. Hash mismatch -> failure reported cleanly.
4. SRI script -> blocked and detected.
5. CDN static origin differs from app origin -> mapping still works.
6. Dynamic import chunk loaded after interaction -> overridden.
7. Two tabs, one attached -> only attached tab affected.
8. Override engine crash mid-run -> fallback request continues.

## 4.2 Performance safeguards

1. Max overridden file size (configurable).
2. Stream or chunk large payloads.
3. Prevent blocking main extension worker loop.

---

## 6) Full failure scenario catalog (what can go wrong)

## A. Startup/config

1. MCP server starts, override engine disabled:
   - Cause: profile absent.
   - Fix: create profile + enable run.
2. Port conflict (8065 in use):
   - Cause: leftover standalone process.
   - Fix: stop old process or choose new port.
3. Permission denied for debugger attach:
   - Cause: missing manifest permission or denied prompt.
   - Fix: add permission, reload extension, re-consent.

## B. Mapping

1. Rule URL host mismatch:
   - Symptom: no requests matched.
2. Rule URL path mismatch by hash:
   - Symptom: still loading prod chunk.
3. Local file missing:
   - Symptom: fallback to prod + logged failure.
4. Wrong branch/build output:
   - Symptom: runtime errors after override.

## C. Cache/SW (highest risk)

1. Memory cache hit before interceptor:
   - Fix: apply controls before first navigation, reload.
2. Disk cache serving stale bytes:
   - Fix: disable cache + clear browser cache.
3. Service worker cache storage hit:
   - Fix: bypass SW or unregister SW for test scope.
4. BFCache restore after back/forward:
   - Fix: full reload before validating override.
5. Preloaded module from previous navigation:
   - Fix: clear cache + force reload.

## D. Browser security

1. SRI hash mismatch:
   - Symptom: script blocked, console integrity error.
2. CSP violation:
   - Symptom: blocked script/style eval.
3. CORP/COEP edge restrictions:
   - Symptom: resource blocked in strict isolation mode.

## E. Protocol/headers

1. Wrong content-type:
   - Symptom: script not executed as JS module.
2. Accidental 304 semantics:
   - Symptom: browser reuses old body.
3. Compression mismatch:
   - Symptom: decode/runtime parse errors.

## F. Framework/runtime coupling

1. Next runtime chunk mismatch with app chunk:
   - Symptom: hydration/runtime crash.
2. Build id mismatch:
   - Symptom: chunk graph incompatible.
3. RSC payload assumptions mismatch (App Router):
   - Symptom: client errors despite chunk replacement.

## G. Operational

1. Multiple override runs active:
   - Symptom: non-deterministic request handling.
2. Engine attached to wrong tab:
   - Symptom: no visible effect in target tab.
3. Race between navigation and attach:
   - Symptom: first critical chunks not overridden.

---

## 7) Runbook for "override did not work"

Strict sequence:

1. Verify profile active and tab attached.
2. Verify request log contains target chunk URL.
3. Check if request was intercepted.
4. If not intercepted:
   - inspect host/path mismatch.
5. If intercepted but not served:
   - inspect `failure_code`.
6. If served but page unchanged:
   - inspect cache/SW flags + force reload.
7. If served and page errors:
   - inspect SRI/CSP + build parity mismatch.

Minimal evidence bundle to collect:

1. override run id.
2. first 20 `override_requests` rows.
3. browser console errors.
4. `/stats` output.
5. active profile JSON.

---

## 8) Security and safety constraints

1. Default denylist for third-party domains.
2. Allow overrides only for configured target origins.
3. Read local files only under approved roots.
4. Log all overrides for auditability.
5. One-click disable emergency switch.

---

## 9) Delivery plan and effort estimate

1. Phase 0 (diagnostics): 3-5 days
2. Phase 1 (mapping generator): 5-7 days
3. Phase 2 (engine + cache/SW controls): 10-15 days
4. Phase 3 (MCP tool UX): 5-7 days
5. Phase 4 (integration hardening): 7-10 days

Total: 30-44 engineer-days for robust implementation.

---

## 10) Recommended immediate next steps (this week)

1. Implement Phase 0 first (no interception yet).
2. Reproduce your current failing prod override with diagnostics on.
3. Confirm top blocker category (likely SW/cache or mapping mismatch).
4. Only then implement interception path.

This ordering avoids building the wrong solution and gives fast clarity on your current manual failure.

---

## 11) Definition of done

Feature is done when all are true:

1. Given a target prod URL and valid profile, local chunk replacement is visible within one reload.
2. Failure cases always return deterministic error codes and fixes.
3. Cache/SW-related failures are auto-detected and surfaced clearly.
4. Next.js sample app test suite passes full matrix.
5. Safety controls prevent accidental third-party override.

