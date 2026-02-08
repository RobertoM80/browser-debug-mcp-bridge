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
