# Testing

## Test stack

- Vitest for unit and integration coverage
- Project-level Nx test targets
- Workspace command: `pnpm test`

## What to cover

- extension capture and transport behavior
- server ingest and persistence paths
- MCP tool input validation and response contracts
- guardrails (limits + redaction) and fallback behavior

## Verification commands

```bash
pnpm test
pnpm nx run-many -t lint
pnpm nx run-many -t build
```

## Docs quality gates

- `nx lint docs` checks markdown style and internal links
- `nx build docs` verifies static generation
- `nx run docs:ci` is the docs CI verification command
