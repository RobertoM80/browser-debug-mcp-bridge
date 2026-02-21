# GitHub Actions Automation

This project uses automated GitHub workflows so day-to-day development focuses on features, not release operations.

## CI (`.github/workflows/ci.yml`)

Triggers:

1. Pull requests
1. Push to `main`
1. Manual run

Runs:

1. Checkout + Node + pnpm setup
1. Dependency install (`pnpm install --frozen-lockfile`)
1. Full validation via `pnpm verify`

`pnpm verify` includes:

1. Typecheck
1. Lint
1. Tests
1. Build
1. Docs CI
1. MCP stdio guard check

## Docs Pages (`.github/workflows/docs-pages.yml`)

Triggers:

1. Push to `main`
1. Manual run

Runs:

1. Build docs (`pnpm docs:build`)
1. Upload docs artifact
1. Deploy to GitHub Pages

## Release Please (`.github/workflows/release-please.yml`)

Triggers:

1. Push to `main`
1. Manual run

Runs:

1. Opens/updates release PR from commit history
1. Proposes version bump and changelog updates

## Release (`.github/workflows/release.yml`)

Triggers:

1. Push tag matching `v*` (example `v1.4.0`)
1. Manual run

Runs:

1. `pnpm verify`
1. Packages release artifacts
1. Publishes GitHub Release with assets

## Dependency Update (`.github/workflows/dependency-update.yml`)

Triggers:

1. Weekly schedule (Monday, 06:00 UTC)
1. Manual run

Runs:

1. Upgrades dependencies (`pnpm up -r --latest`)
1. Regenerates lockfile
1. Runs `pnpm verify`
1. Opens/updates dependency PR

## Nightly Health (`.github/workflows/nightly-health.yml`)

Triggers:

1. Nightly schedule (02:00 UTC)
1. Manual run

Runs:

1. `pnpm verify`
1. Starts `mcp-server`
1. Smoke-checks `GET /health`

## Local guardrails before commit

This repo also enforces local checks with git hooks:

1. Install hooks once:

```bash
pnpm hooks:install
```

1. Every commit runs:

   - `pnpm typecheck`
   - `pnpm lint`
   - `pnpm test`
