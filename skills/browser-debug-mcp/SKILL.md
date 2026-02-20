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
- Build/type safety: `pnpm nx run-many -t build`

If Nx daemon/worker is unstable in the environment:

- Disable daemon: `$env:NX_DAEMON='false'`
- Run per-project checks directly (tsc/vitest) for the touched projects.

## Change Guardrails

- Do not introduce unsafe capture defaults without updating privacy behavior.
- Keep extension and server contracts in sync (event types, payload keys, API routes).
- When changing default ports/endpoints, update both code and docs together.
- Avoid destructive git operations unless explicitly requested.

## Completion Checklist

- Code compiles for affected projects.
- Tests pass for affected projects (or full suite when requested).
- Docs updated when behavior/config changed.
- Response includes file paths and what changed.
