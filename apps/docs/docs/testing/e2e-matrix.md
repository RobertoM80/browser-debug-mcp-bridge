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
5. Override POC positive, negative, lifecycle, and Next.js adapter/runtime flows.

Override coverage in `apps/e2e-playwright/tests/full.override-poc.spec.ts`:

1. exact multi-rule profile fulfills two live page scripts
2. exact URL mismatch leaves the original asset untouched
3. session pause disables the active override and records a terminal audit run
4. active-tab unbind disables the override while the session remains active
5. session stop disables the active override and preserves the final audit run
6. generated Next.js profile maps a real `.next/static` build and overrides real `/_next/static/...` chunk requests inside the Chromium context where the packaged extension is loaded
7. runtime-generated Next.js overrides cover one browser-only UI/functionality change each on home, about, and products pages through MCP stdio calls
8. live Next.js assets are observed, persisted, and mapped to local source paths before enabling override
9. bounded production/local drift checks fetch observed Next.js chunks and verify hash parity in the fixture path
10. popup coverage renders override profile/rule and compact diagnosis details
11. temp Next.js source-overlay planning patches an observed chunk, writes config, enables through MCP, and verifies fixture sources are not mutated
12. SRI-protected Next.js source override candidates are blocked before config writing
13. override target selector remains locked while active through popup coverage

Command:

```bash
pnpm test:e2e:full
```

Headless is the default mode for all E2E runs. Use `pnpm test:e2e:head` when you need a headed browser for local troubleshooting.

## CI usage

- Pull requests and pushes to `main`: smoke + full.
- Nightly: full + runtime health check.

## Linux runners

CI executes Playwright on Linux (`ubuntu-latest`) with Chromium and `xvfb-run`.
