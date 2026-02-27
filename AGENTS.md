# Browser Debug MCP Bridge

Chrome Extension + Node.js MCP server for browser debugging. Nx monorepo with pnpm.

## Quick Start

```bash
# Install dependencies
pnpm install

# Dev server
pnpm nx serve mcp-server

# Dev extension (watch mode)
pnpm nx build chrome-extension --watch

# Test all
pnpm nx run-many -t test

# Lint all
pnpm nx run-many -t lint
```

## Tech Stack

- **Package manager**: pnpm (>=9) with Nx
- **Node**: >=20
- **Apps**: `mcp-server` (Fastify), `chrome-extension` (MV3), `viewer` (web UI)
- **Libs**: `shared`, `redaction`, `selectors`, `mcp-contracts`
- **Database**: SQLite (better-sqlite3)
- **Testing**: Vitest

## For Agents

- Plan Mode: Be extremely concise. Sacrifice grammar for the sake of concision.
- End plans with a list of unresolved questions (if any).
- Prefer reading configs before choosing new tools.
- If a command fails, report the error and stop for guidance.

## Reference Files

- [Project Spec](PROJECT_INFOS.md)
- [TypeScript Standards](docs/TYPESCRIPT.md)
- [Testing Guide](docs/TESTING.md)
- [Architecture & Nx](docs/ARCHITECTURE.md)
- [Code Conventions](docs/CONVENTIONS.md)
- [Security & Privacy](docs/SECURITY.md)


<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

## General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `pnpm nx build`, `npm exec nx test`) - avoids using globally installed CLI
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or calling MCP tools

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax


<!-- nx configuration end-->