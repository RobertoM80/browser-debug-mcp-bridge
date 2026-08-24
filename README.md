# Browser Debug MCP Bridge

Chrome extension plus local MCP runtime for debugging real browser sessions with an AI client.

It captures console logs, network calls, navigation, UI events, DOM snapshots, styles, layout, screenshots, and persisted failure context from an actual Chrome tab. The MCP server exposes that evidence as tools your AI client can call while you reproduce a bug.

## What It Does

- Debugs a real Chrome page instead of guessing from source code alone.
- Stores session telemetry locally in SQLite.
- Lets your AI client query recent events, console errors, failed requests, and API calls.
- Captures live DOM, styles, layout metrics, UI snapshots, and live console logs on demand.
- Correlates user actions, network failures, runtime errors, and snapshots into timelines.
- Keeps privacy controls local with safe mode, domain allowlists, redaction, and bounded payloads.
- Includes an experimental exact-asset override workflow for replacing production JS/CSS assets with local files during debugging.

## Requirements

- Node.js `>=22.19`
- Chrome or Chromium with extension Developer Mode enabled
- An MCP-capable AI client

## Install

Install the MCP runtime:

```bash
npm i -g browser-debug-mcp-bridge
```

Download the Chrome extension archive from the latest GitHub release:

```text
https://github.com/RobertoM80/browser-debug-mcp-bridge/releases/latest
```

Load the extension:

1. Extract `chrome-extension-dist.tgz`.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Click **Load unpacked**.
5. Select the extracted extension folder.

## Configure Your MCP Client

Recommended launch method: direct `node` command pointing at the installed package script.

Studio or MCPS is not required. The package launcher is a standard MCP stdio server entrypoint, so any MCP host that supports command/args server configuration can use it directly. By default it advertises only `list_sessions` and the on-demand `browser_debug` tool to avoid spending roughly 11k input tokens on the full catalog; `browser_debug` can discover and execute every tool. Set `MCP_TOOL_CATALOG=full` for the legacy all-tools catalog.

Find the global npm root:

```bash
npm root -g
```

Use this script path:

```text
<NPM_GLOBAL_ROOT>/browser-debug-mcp-bridge/scripts/mcp-start.cjs
```

OpenAI Codex CLI / Codex in VS Code example:

```toml
[mcp_servers.browser_debug]
command = "node"
args = ["C:\\Users\\<you>\\AppData\\Roaming\\npm\\node_modules\\browser-debug-mcp-bridge\\scripts\\mcp-start.cjs"]
```

OpenCode or JSON-style MCP host example:

```json
{
  "mcpServers": {
    "browser-debug": {
      "command": "node",
      "args": [
        "C:\\Users\\<you>\\AppData\\Roaming\\npm\\node_modules\\browser-debug-mcp-bridge\\scripts\\mcp-start.cjs"
      ]
    }
  }
}
```

Quick secondary option:

```json
{
  "mcpServers": {
    "browser-debug": {
      "command": "npx",
      "args": ["-y", "browser-debug-mcp-bridge"]
    }
  }
}
```

Keep `-y` in `npx` configs. Without it, npm can wait for an interactive install confirmation that MCP hosts such as VS Code Copilot cannot answer, so the server appears to start but no tools are registered.

## Copilot Without MCP

If a Copilot organization disables MCP servers but terminal commands are allowed, use the packaged CLI workflow instead:

```bash
bdmcp --help
browser-debug-mcp-bridge --standalone
bdmcp init-copilot
bdmcp health
bdmcp sessions --live
bdmcp summary @recommended
```

The global `npm i -g browser-debug-mcp-bridge` install above provides both
`browser-debug-mcp-bridge` and `bdmcp`. If `bdmcp --help` is not found, rerun that install.
From a local clone, use `node scripts/browser-debug-cli.cjs` in place of `bdmcp`.

If `bdmcp` reports that a healthy bridge does not expose the CLI API, stop the older bridge,
upgrade with `npm i -g browser-debug-mcp-bridge@latest`, and restart it. On Windows, stopping the
bridge first also prevents npm `EBUSY` errors caused by the running process locking the package.

The CLI exposes the same bridge tool handlers through local commands and a token-protected local gateway. See [Browser Debug CLI](docs/BROWSER_DEBUG_CLI.md).

## First Debug Session

1. Start your MCP client so it launches the bridge.
2. Open the target page in Chrome.
3. Open the Browser Debug extension popup.
4. Add the page origin to the allowlist.
5. Click **Start session**.
6. Ask your AI client to call `list_sessions`.
7. Pick a session where `liveConnection.connected` is `true`.

Useful first tool call:

```json
{ "name": "list_sessions", "arguments": { "sinceMinutes": 60 } }
```

Then query persisted evidence first with `get_session_summary`, `get_recent_events`, `get_console_events`, `get_network_failures`, and `get_network_calls`.

Use live capture tools only on connected sessions: `get_dom_document`, `get_dom_subtree`, `get_computed_styles`, `get_layout_metrics`, `capture_ui_snapshot`, and `get_live_console_logs`.

## Tool List

Session and health:

- `list_sessions`
- `get_live_session_health`
- `get_session_summary`

Events, console, and navigation:

- `get_recent_events`
- `get_navigation_history`
- `get_console_events`
- `get_console_summary`
- `get_event_summary`
- `get_live_console_logs`

Network and API debugging:

- `get_network_failures`
- `get_network_calls`
- `wait_for_network_call`
- `get_request_trace`
- `get_body_chunk`

Live UI capture:

- `get_element_refs`
- `get_dom_subtree`
- `get_dom_document`
- `get_computed_styles`
- `get_layout_metrics`
- `capture_ui_snapshot`

Failure analysis and snapshots:

- `explain_last_failure`
- `get_event_correlation`
- `list_snapshots`
- `get_snapshot_for_event`
- `get_snapshot_asset`

Experimental overrides:

- `list_override_profiles`
- `create_override_profile`
- `validate_override_profile`
- `observe_override_assets`
- `list_observed_override_assets`
- `map_next_override_assets`
- `plan_next_source_override`
- `enable_overrides`
- `disable_overrides`
- `get_override_status`
- `get_override_request_log`
- `diagnose_overrides`

## Session Scope

Sessions are tab-bound by default.

- The active tab is bound when you start a session.
- Telemetry from unbound tabs is rejected to avoid cross-tab contamination.
- Use the popup `Session Tabs` panel to add or remove tabs from the active session.
- If all bound tabs are removed or closed, the session auto-stops.

Query tools accept `sessionId`, `url`, or both.

- `sessionId`: only that session.
- `url`: that origin across sessions, for example `http://localhost:3000`.
- `sessionId` plus `url`: intersection of both filters.

Example URL-only query:

```json
{
  "name": "get_recent_events",
  "arguments": { "url": "http://localhost:3000", "limit": 50 }
}
```

Example session and URL query:

```json
{
  "name": "get_network_failures",
  "arguments": { "sessionId": "sess_123", "url": "http://localhost:3000", "limit": 20 }
}
```

## Live Console Logs

`get_live_console_logs` reads from extension memory, not the SQLite event log. It is useful for current-page console debugging with server-side filters.

Supported filters:

- `sessionId`
- `url`
- `tabId`
- `levels`
- `contains`
- `sinceTs`
- `dedupeWindowMs`
- `responseProfile`
- `includeArgs`
- `maxResponseBytes`
- `limit`

Example:

```json
{
  "name": "get_live_console_logs",
  "arguments": {
    "sessionId": "sess_123",
    "url": "http://localhost:3000",
    "levels": ["info", "error"],
    "contains": "[auth]",
    "responseProfile": "compact",
    "limit": 100
  }
}
```

## Experimental Asset Overrides

Overrides let you test local JS/CSS files against a real production page by intercepting exact asset URLs in one selected tab.

Current scope:

- One active profile with one or more exact URL-to-file rules.
- One explicitly selected bound tab.
- Cache disable and service-worker bypass through Chrome debugger protocol.
- Durable run and request logs.
- MCP control, status, request log, and diagnosis tools.
- Candidate profile generation through adapters.
- Live production asset observation, persistence, and Next.js source-to-chunk candidate mapping.
- Optional production/local drift checks with fetched asset hashes and normalized signatures.
- Next.js source-edit planning with temp overlay builds and safe literal patching of observed chunks.

Supported generator adapters:

| Adapter | Use case | Main inputs |
| --- | --- | --- |
| `nextjs` | Next.js apps built into `.next` | `targetBaseUrl`, optional `projectRoot`, optional `nextDir` |
| `static` | Any built asset directory, including Vite, Angular, Vue, SvelteKit, Remix, or no framework | `targetBaseUrl`, optional `projectRoot`, optional `assetRoot` |

The override runtime is framework-agnostic. Adapters only generate exact `targetAssetUrl` to `localFilePath` rules. The same browser replacement, validation, audit, and diagnosis path is used for every framework.

Observe production assets from a live session:

```json
{
  "name": "observe_override_assets",
  "arguments": { "sessionId": "sess_123" }
}
```

Observed assets are persisted per session and can be reused when the live tab is no longer connected:

```json
{
  "name": "list_observed_override_assets",
  "arguments": { "sessionId": "sess_123" }
}
```

Map observed Next.js assets back to local build chunks and source paths:

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

`fetchProductionAssets` reports whether observed production bytes match the local build. Hash/signature drift lowers confidence and adds a `PRODUCTION_LOCAL_DRIFT` blocker. Drift checks are opt-in and bounded by `maxDriftCandidates` (default 20), `productionFetchConcurrency` (default 4), `productionFetchTimeoutMs`, and `maxProductionAssetBytes` so normal mapping stays fast.

Plan a browser-only source edit for an observed Next.js route:

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

Temp overlay builds are created under `tmp/bn/<id>`. Expired overlays are cleaned automatically when `plan_next_source_override` runs.

`diagnose_overrides` also uses persisted observations to report target URL mismatches, SRI, CSP meta tags, and service-worker control. The extension popup surfaces the same compact blocker summary.

Generate a Next.js candidate profile:

```json
{
  "name": "create_override_profile",
  "arguments": {
    "adapter": "nextjs",
    "projectRoot": "C:/path/to/app",
    "targetBaseUrl": "https://www.example.com/_next/",
    "writeConfig": true
  }
}
```

Generate a generic static-assets profile:

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

Generated configs are usable by default. Review exact production URLs before enabling overrides from the extension popup or MCP tools.

To make the runtime load your config, set `OVERRIDE_POC_CONFIG_PATH` in your MCP server environment to the generated config file path, then restart the MCP server.

Planned adapter direction:

1. Keep `static` as the universal fallback.
2. Add framework-specific manifest adapters only when they improve mapping confidence.
3. Add observed production URL ingestion for stronger generated mappings.
4. Add dedicated Angular, Vue/Nuxt, Vite, SvelteKit, Remix, and other adapters as needed.

Known current limits:

- Exact URL matching only.
- No pattern or fuzzy matching yet.
- No robust SRI/CSP rewrite flow yet.
- Generated profiles do not yet ingest observed production network URLs.

## Runtime Storage

Runtime data is local to your machine.

- Windows: `%LOCALAPPDATA%\browser-debug-mcp-bridge`
- macOS: `~/Library/Application Support/browser-debug-mcp-bridge`
- Linux: `$XDG_STATE_HOME/browser-debug-mcp-bridge` or `$XDG_DATA_HOME/browser-debug-mcp-bridge`
- Fallback: `~/.local/share/browser-debug-mcp-bridge`

Set `DATA_DIR` only if you want to override the default local storage path.

## Port And Startup

Default local port: `8065`.

- The launcher uses a single-instance lock.
- Startup reports ready only after `/health` responds on `127.0.0.1:8065`.
- `MCP_STARTUP_PORT_IN_USE` means another process is using the port.
- `LIVE_SESSION_DISCONNECTED` means the session is historical or no extension is currently connected.

Stop a stale bridge process:

```bash
node <NPM_GLOBAL_ROOT>/browser-debug-mcp-bridge/scripts/mcp-start.cjs --stop
```

## Docs

- [MCP tools reference](https://github.com/RobertoM80/browser-debug-mcp-bridge/blob/main/docs/MCP_TOOLS.md)
- [MCP client setup](https://github.com/RobertoM80/browser-debug-mcp-bridge/blob/main/docs/MCP_CLIENT_SETUP.md)
- [Troubleshooting](https://github.com/RobertoM80/browser-debug-mcp-bridge/blob/main/docs/TROUBLESHOOTING.md)
- [Security and privacy](https://github.com/RobertoM80/browser-debug-mcp-bridge/blob/main/SECURITY.md)
