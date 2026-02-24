# GitHub Actions Explained

This repository uses multiple GitHub Actions workflows.  
This page explains what each one does, when it runs, and why it exists.

## 1. CI (`.github/workflows/ci.yml`)

When it runs:
1. On every pull request
2. On every push to `main`
3. Manually (`workflow_dispatch`)

What it does:
1. Checks out repository code
2. Installs Node + pnpm
3. Installs dependencies
4. Runs `pnpm verify`

What `pnpm verify` includes:
1. Typecheck
2. Lint
3. Tests
4. Build
5. Docs CI checks
6. MCP stdio safety guard

Why it exists:
1. Prevent regressions before merge
2. Keep quality gates centralized in one command

## 2. Docs Pages (`.github/workflows/docs-pages.yml`)

When it runs:
1. On push to `main` only when docs or docs-build-related files changed
2. Manually

What it does:
1. Builds docs (`pnpm docs:build`)
2. Uploads docs artifact (`dist/apps/docs`)
3. Deploys to GitHub Pages

Why it exists:
1. Keep published docs always updated from `main`

## 3. Release Please (`.github/workflows/release-please.yml`)

When it runs:
1. On push to `main`
2. Manually

What it does:
1. Scans conventional commits
2. Opens or updates a release PR automatically
3. Proposes next semantic version and changelog updates

Why it exists:
1. Automate versioning/changelog workflow
2. Reduce manual release preparation

## 4. Release (`.github/workflows/release.yml`)

When it runs:
1. On tag push matching `v*` (example: `v1.2.0`)
2. Manually

What it does:
1. Runs `pnpm verify`
2. Packages release artifacts:
   - `mcp-server-dist.tgz`
   - `chrome-extension-dist.tgz`
   - setup docs
3. Publishes npm package automatically (if version not already published)
4. Publishes GitHub Release with generated notes + assets

Why it exists:
1. Create reproducible release artifacts automatically
2. Publish npm + GitHub release metadata without manual upload steps

Required repository secret for Release workflow:

1. `NPM_TOKEN`
2. Token must have permission to publish `browser-debug-mcp-bridge` on npm
3. Workflow fails fast if `NPM_TOKEN` is missing
4. If same package version is already on npm, npm publish step is skipped safely

## 5. Dependency Update (`.github/workflows/dependency-update.yml`)

When it runs:
1. Weekly (Monday 06:00 UTC)
2. Manually

What it does:
1. Updates dependencies (`pnpm up -r --latest`)
2. Refreshes lockfile
3. Runs `pnpm verify`
4. Opens/updates automated dependency PR

Why it exists:
1. Keep dependencies current
2. Catch upgrade breakages early through automation

## 6. Nightly Health (`.github/workflows/nightly-health.yml`)

When it runs:
1. Every night (02:00 UTC)
2. Manually

What it does:
1. Runs `pnpm verify`
2. Starts local `mcp-server`
3. Performs runtime smoke test on `GET /health`

Why it exists:
1. Detect environment/runtime breakages that static CI might miss

## 7. Typical automated flow

1. You push commits.
2. `CI` validates quality.
3. `Release Please` updates release PR automatically.
4. When you tag a version, `Release` publishes assets.
5. `Docs Pages` deploys docs on `main`.
6. Weekly dependencies and nightly health checks run automatically.

## 8. What you still do manually

1. Develop features/fixes.
2. Review and merge PRs.
3. Approve/review release PRs and create version tags when ready.

Everything else is automated by workflows.

Tag creation shortcut:

1. Run `pnpm release:tag`
2. The script suggests the next `vX.Y.Z` tag, asks confirmation, then runs:
   - `git checkout main`
   - `git pull --ff-only origin main`
   - `git tag <tag>`
   - `git push origin <tag>`

## 9. Run workflows locally with `act`

Install prerequisites:

1. Docker Desktop
2. `act` CLI

Quick commands from repo root:

1. List jobs:
   - `pnpm gha:list`
2. Dry run:
   - `pnpm gha:dry-run`
3. Run CI workflow locally:
   - `pnpm gha:ci`
4. Run docs workflow locally:
   - `pnpm gha:docs`
5. Run nightly workflow locally:
   - `pnpm gha:nightly`
6. Run release validation workflow locally:
   - `pnpm gha:release`
7. Run release-please workflow locally:
   - `pnpm gha:release-please`
8. Run dependency update workflow locally:
   - `pnpm gha:dependency-update`

Notes:

1. These use `catthehacker/ubuntu:full-latest` for local `act` compatibility.
2. Some GitHub-only operations (Pages deploy, release publish, PR/release API calls) are skipped in local `act` runs.
