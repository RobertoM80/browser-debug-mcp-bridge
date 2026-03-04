---
name: browser-debug-mcp
description: Scaffold skill for working on the Browser Debug MCP Bridge repository (Nx + pnpm monorepo with mcp-server and chrome-extension).
metadata:
  short-description: Browser Debug MCP repo workflow
---

# Browser Debug MCP Skill

Use this skill when a task targets this repository and needs consistent implementation workflow, validation, and safety checks.

## Scope

- Monorepo root: `browser-debug-mcp-bridge`
- Apps: `apps/mcp-server`, `apps/chrome-extension`, `apps/docs`
- Libs: `libs/shared`, `libs/redaction`, `libs/selectors`, `libs/mcp-contracts`

## Default Workflow

1. Read `AGENTS.md` and relevant docs under `docs/` before editing.
2. Locate impacted files with `rg`.
3. Implement minimal, focused changes.
4. Keep docs and defaults aligned with runtime behavior.
5. Validate with lint, tests, and typechecks before finishing.

## Validation Commands

Prefer these checks after changes:

- Lint: `pnpm nx run-many -t lint`
- Test: `pnpm nx run-many -t test`
- E2E smoke: `pnpm test:e2e:smoke`
- E2E full: `pnpm test:e2e:full`
- Build/type safety: `pnpm nx run-many -t build`
- Docs CI: `pnpm docs:ci`

Recommended order for broad changes:

1. `pnpm nx run-many -t lint`
2. `pnpm nx run-many -t test`
3. `pnpm test:e2e:smoke`
4. `pnpm test:e2e:full` (required for integration-sensitive work)
5. `pnpm nx run-many -t build`
6. `pnpm docs:ci`

If Nx daemon/worker is unstable in the environment:

- Disable daemon: `$env:NX_DAEMON='false'`
- Run per-project checks directly (tsc/vitest) for the touched projects.

## Change Guardrails

- Do not introduce unsafe capture defaults without updating privacy behavior.
- Keep extension and server contracts in sync (event types, payload keys, API routes).
- When changing default ports/endpoints, update both code and docs together.
- Avoid destructive git operations unless explicitly requested.

## Session and Log Semantics

- Sessions are tab-bound by default (single active tab on session start).
- Only explicitly bound tabs should contribute telemetry for a session.
- Query tools support optional origin filtering (`url` normalized to origin).
- Live console triage should use `get_live_console_logs` (non-persistent in-memory buffer).
- Persisted console history remains available via `get_console_events`.
- Prefer `responseProfile: "compact"` + `maxResponseBytes` on high-volume tools to control MCP context growth.
- Use `get_console_summary` / `get_event_summary` first for fast triage before opening raw timelines.

### `get_live_console_logs` usage

Required input:

- `sessionId`

Optional filters:

- `url` (absolute URL, normalized to origin)
- `tabId`
- `levels` (`log`, `info`, `warn`, `error`, `debug`, `trace`)
- `contains` (case-insensitive substring)
- `sinceTs`
- `limit`
- `dedupeWindowMs` (collapse repetitive bursts)
- `responseProfile` (`legacy` or `compact`)
- `includeArgs` (compact mode only)
- `maxResponseBytes`

Example:

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

### `capture_ui_snapshot` guidance

- For PNG-only workflows, use `mode: "png"` and keep metadata-first defaults:
  - `includeDom: false`
  - `includeStyles: false`
  - `includePngDataUrl: false`
- Enable those flags only when full payload sections are explicitly required.

## Completion Checklist

- Code compiles for affected projects.
- Tests pass for affected projects (or full suite when requested).
- Docs updated when behavior/config changed.
- Response includes file paths and what changed.
