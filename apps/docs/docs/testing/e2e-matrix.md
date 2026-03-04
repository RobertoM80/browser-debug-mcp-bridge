# E2E Matrix

## Purpose

Define what is covered by smoke vs full Playwright suites.

## Smoke suite (`@smoke`)

Primary goal: fail fast on wiring regressions.

Covered areas:

1. Extension popup opens and core controls render.
2. MCP stdio runtime starts and basic tools respond.
3. Baseline bridge connectivity checks.

Command:

```bash
pnpm test:e2e:smoke
```

## Full suite (`@full`)

Primary goal: verify end-to-end behavior across extension, server, DB, and MCP tools.

Covered areas:

1. Extension session flow with real tab interactions.
2. Session isolation and data persistence paths.
3. MCP query tools and response shape checks.
4. Extension UI controls and lifecycle behavior.

Command:

```bash
pnpm test:e2e:full
```

## CI usage

- Pull requests and pushes to `main`: smoke + full.
- Nightly: full + runtime health check.

## Linux runners

CI executes Playwright on Linux (`ubuntu-latest`) with Chromium and `xvfb-run`.
