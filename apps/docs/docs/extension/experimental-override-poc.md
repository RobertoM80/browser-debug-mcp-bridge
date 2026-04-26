# Experimental Override POC

This repo includes a minimal proof of concept for replacing exact production asset requests with local files through Chrome's debugger protocol.

## Scope

- local repo mode only
- one active override profile with one or more exact URL/file rules
- one attached tab
- manual enable/disable from the extension popup or MCP tools

It is intentionally narrow. The goal is to prove that the bridge can intercept a real production request and fulfill it with local bytes.

## Config File

Keep the checked-in `override-poc.config.json` as the disabled placeholder.

Create `override-poc.local.json` in the repo root for real local values. If needed, you can also point the server at a different file with `OVERRIDE_POC_CONFIG_PATH`.

```json
{
  "enabled": false,
  "activeProfileId": "placeholder",
  "profiles": [
    {
      "profileId": "placeholder",
      "name": "Disabled placeholder override profile",
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

1. Each rule `targetAssetUrl` must be the exact production URL requested by the browser.
2. Each rule `localFilePath` can be relative to the config file directory or an absolute path.
3. `enabled` should stay `false` in the checked-in placeholder config.
4. `override-poc.local.json` is ignored by git and is preferred automatically when present.
5. Legacy single-rule configs with top-level `targetAssetUrl` and `localFilePath` still work.

## Profile Generation

You can generate a candidate profile through the MCP `create_override_profile` tool instead of hand-writing every rule.

Supported adapters:

1. `nextjs`: scans `.next` manifests plus `.next/static` assets and maps them under a production `/_next/` asset base URL.
2. `static`: scans any built asset directory, such as `dist/assets`, and maps files under the provided production asset base URL.

Architecture note: the override engine is framework-agnostic. Adapters only generate exact URL/file rules; request interception, validation, audit, and diagnosis use the same path for every framework.

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

The generated root config is disabled by default. Review the exact `targetAssetUrl` values against real production network requests before setting `enabled` to `true`.

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

You can also operate the same flow through MCP on a connected live session with `list_override_profiles`, `create_override_profile`, `validate_override_profile`, `enable_overrides`, `disable_overrides`, `get_override_status`, `get_override_request_log`, and `diagnose_overrides`.

## What It Does

When enabled, the background service worker:

1. attaches `chrome.debugger` to the session tab
2. enables CDP `Network` and `Fetch`
3. disables cache
4. bypasses the service worker
5. intercepts requests
6. fulfills only exact URLs from enabled rules in the active profile

The local bytes come from the server endpoint `GET /overrides/poc/asset`.

## Audit And Diagnosis APIs

The override backend now persists durable run and request records for the session.

Available HTTP endpoints:

1. `POST /sessions/:sessionId/overrides/runs`
2. `GET /sessions/:sessionId/overrides/runs`
3. `POST /sessions/:sessionId/overrides/requests`
4. `GET /sessions/:sessionId/overrides/requests`
5. `GET /sessions/:sessionId/overrides/diagnosis`

Available MCP tools:

1. `list_override_profiles`
2. `create_override_profile`
3. `validate_override_profile`
4. `observe_override_assets`
5. `list_observed_override_assets`
6. `map_next_override_assets`
7. `plan_next_source_override`
8. `enable_overrides`
9. `disable_overrides`
10. `get_override_status`
11. `get_override_request_log`
12. `diagnose_overrides`

What they currently give you:

1. per-run status with structured failure codes
2. per-request matched and fulfilled history for the configured target asset
3. a diagnosis response that ranks likely blockers such as exact URL mismatch, cache or reload issues, debugger lifecycle failures, persisted observed-asset mismatch, SRI, CSP, and service-worker interference
4. live production script/style asset observation from the selected browser tab with persisted per-session reuse
5. Next.js observed-asset to local chunk/source-path mapping with confidence reasons and optional bounded production/local drift checks
6. temp Next.js source-overlay planning that can write exact override profile rules without mutating the repo and cleans expired `tmp/bn` overlays

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
10. popup coverage renders profile/rule and compact diagnosis details
11. `plan_next_source_override` patches an observed Next.js chunk from source-level edits and blocks SRI-protected candidates before config writing

## Current Limits

This POC does not yet handle:

1. Angular, Vue, Vite, or other framework-specific manifest adapters beyond the generic `static` adapter
2. pattern or fuzzy URL matching
3. popup-level full request history UI
4. long-running multi-profile workflows across many tabs or sessions
5. arbitrary non-literal Next.js source transformations that require RSC/HTML/module-id rewrites
