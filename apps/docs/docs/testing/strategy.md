# Testing Strategy

## Test stack

- Vitest for unit/integration tests across apps/libs.
- Playwright for browser-level E2E coverage (`apps/e2e-playwright`).
- Nx targets to run each lane consistently in local and CI.

## Test lanes

1. Unit + integration:
   - command: `pnpm test`
2. E2E smoke:
   - command: `pnpm test:e2e:smoke`
   - intent: fast checks for extension UI wiring and MCP connectivity
3. E2E full:
   - command: `pnpm test:e2e:full`
   - intent: deeper checks for extension -> bridge -> DB -> MCP tool behavior

## CI behavior

- CI workflow (`.github/workflows/ci.yml`) runs:
  1. `validate` (`pnpm verify`)
  2. `e2e-smoke`
  3. `e2e-full`
- Nightly workflow (`.github/workflows/nightly-health.yml`) runs:
  1. `pnpm verify`
  2. `e2e-full`
  3. runtime `/health` smoke check

Both CI and nightly install Chromium and execute E2E through `xvfb-run` on Linux runners.

## Coverage goals

- Extension:
  - popup controls, session lifecycle, tab-binding behavior
  - event capture gating and transport
- Server:
  - ingest paths, persistence, query filters, error handling
- MCP:
  - tool input validation and response contract stability
  - session and URL-origin filter semantics

## Docs quality gates

- `pnpm docs:lint` checks docs lint rules.
- `pnpm docs:build` verifies static site build.
- `pnpm docs:ci` is the docs CI verification target.

See also: [E2E Matrix](./e2e-matrix.md).
