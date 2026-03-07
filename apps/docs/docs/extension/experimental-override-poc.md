# Experimental Override POC

This repo includes a minimal proof of concept for replacing one production asset with one local file through Chrome's debugger protocol.

## Scope

- local repo mode only
- one exact production asset URL
- one exact local file
- one attached tab
- manual enable/disable from the extension popup

It is intentionally narrow. The goal is to prove that the bridge can intercept a real production request and fulfill it with local bytes.

## Config File

Edit the root file `override-poc.config.json`.

```json
{
  "enabled": false,
  "targetAssetUrl": "https://example.com/_next/static/chunks/app/page-PLACEHOLDER.js",
  "localFilePath": ".next/static/chunks/app/page-PLACEHOLDER.js",
  "contentType": "application/javascript; charset=utf-8",
  "autoReload": true
}
```

Notes:

1. `targetAssetUrl` must be the exact production URL requested by the browser.
2. `localFilePath` can be relative to the repo root or an absolute path.
3. `enabled` should stay `false` until the values are real.

## How To Run It

1. Build the local asset you want to test.
2. Update `override-poc.config.json`.
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
5. In `Override POC`, click `Enable POC`.

If `autoReload` is `true`, the tab reloads after debugger attach so the first matching request can be intercepted with cache disabled and service worker bypass enabled.

## What It Does

When enabled, the background service worker:

1. attaches `chrome.debugger` to the session tab
2. enables CDP `Network` and `Fetch`
3. disables cache
4. bypasses the service worker
5. intercepts requests
6. fulfills only the exact configured `targetAssetUrl`

The local bytes come from the server endpoint `GET /overrides/poc/asset`.

## Popup Status

The popup shows:

1. target asset URL
2. resolved local file path
3. config file path
4. attached tab id
5. matched request count
6. fulfilled request count

## Current Limits

This POC does not yet handle:

1. automatic Next.js chunk mapping
2. multiple assets
3. SRI/CSP diagnosis
4. request audit logs
5. long-running reliability across many tabs or sessions
