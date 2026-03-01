# Testing Guide

## Test Layers

This repository uses two test layers:

1. Unit and integration tests with Vitest (workspace-wide).
2. End-to-end tests with Playwright (`apps/e2e-playwright`).

## Local Commands

```bash
# Unit + integration (all projects)
pnpm test

# One project (unit/integration)
pnpm nx test <project>

# E2E smoke suite (fast lane)
pnpm test:e2e:smoke

# E2E full suite (deeper coverage)
pnpm test:e2e:full

# All E2E tests
pnpm test:e2e
```

## CI Mapping

- PR and push to `main`:
  1. `validate` job runs `pnpm verify`
  2. `e2e-smoke` job runs Playwright smoke suite
  3. `e2e-full` job runs Playwright full suite
- Nightly:
  1. Runs `pnpm verify`
  2. Runs Playwright full suite
  3. Runs runtime `/health` smoke check

## Scope Expectations

- Use unit/integration tests for contracts, schemas, persistence, and core logic.
- Use E2E smoke tests for extension popup wiring and MCP connectivity sanity.
- Use E2E full tests for extension-to-server-to-DB data flow and tool outputs.
