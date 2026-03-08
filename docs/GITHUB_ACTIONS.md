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
4. Runs `validate` job (`pnpm verify`)
5. Runs Playwright `e2e-smoke` job
6. Runs Playwright `e2e-full` job

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
3. Validate user-facing extension + MCP wiring through browser-level E2E checks

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

## 3. PR Title (`.github/workflows/pr-title.yml`)

When it runs:
1. On pull request open, edit, reopen, and synchronize

What it does:
1. Validates that the pull request title follows Conventional Commits
2. Prevents non-conventional squash titles from reaching `main`

Why it exists:
1. Squash merge uses the pull request title as the merge commit title
2. `release-please` relies on conventional commit messages to decide version bumps and changelog entries

Valid examples:
1. `feat(mcp): add automation workflow tools`
2. `fix(ci): install playwright in release workflow`
3. `chore(main): release browser-debug-mcp-bridge 1.10.0`

## 4. Release Please (`.github/workflows/release-please.yml`)

When it runs:
1. After `CI` completes successfully for a push to `main`
2. Manually

What it does:
1. Scans conventional commits
2. Opens or updates a release PR automatically
3. Proposes next semantic version and changelog updates

Why it exists:
1. Automate versioning/changelog workflow
2. Reduce manual release preparation
3. Keep version bumps tied to validated `main` pushes instead of firing before CI finishes

Important notes:
1. For squash merges, the PR title is the commit message that `release-please` sees on `main`
2. If a merged PR used the wrong title, add a `BEGIN_COMMIT_OVERRIDE` / `END_COMMIT_OVERRIDE` block to the merged PR body, then rerun `Release Please`

## 5. Release (`.github/workflows/release.yml`)

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

## 6. Dependency Update (`.github/workflows/dependency-update.yml`)

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

## 7. Nightly Health (`.github/workflows/nightly-health.yml`)

When it runs:
1. Every night (02:00 UTC)
2. Manually

What it does:
1. Runs `pnpm verify`
2. Installs Playwright Chromium
3. Runs Playwright full E2E suite
4. Starts local `mcp-server`
5. Performs runtime smoke test on `GET /health`

Why it exists:
1. Detect environment/runtime breakages that static CI might miss
2. Catch browser-level regressions that can appear outside normal PR traffic

## 8. Typical automated flow

1. You push commits.
2. Open a PR with a conventional title.
3. `CI` validates quality and runs smoke/full browser E2E suites.
4. After the merge push to `main` passes `CI`, `Release Please` updates the release PR automatically.
5. When the release PR is merged and the tag is created, `Release` publishes assets.
6. `Docs Pages` deploys docs on `main`.
7. Weekly dependencies and nightly health checks run automatically.

## 9. What you still do manually

1. Develop features/fixes.
2. Review and merge PRs.
3. Approve/review release PRs.

Everything else is automated by workflows.

## 10. Run workflows locally with `act`

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
