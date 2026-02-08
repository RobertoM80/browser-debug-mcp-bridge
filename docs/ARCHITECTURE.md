# Architecture & Nx

## Monorepo Structure

```
apps/
  mcp-server/      # Node.js/Fastify MCP server
  chrome-extension/# Chrome MV3 extension
  viewer/          # Optional web UI

libs/
  shared/          # Shared utilities
  redaction/       # Data redaction logic
  selectors/       # DOM selector utilities
  mcp-contracts/   # MCP protocol contracts
```

## Module Boundaries

- Apps can depend on libs
- Libs can depend on other libs but not apps
- Maintain tags in `project.json` for apps/libs

## Key Files

- `nx.json` - Nx workspace configuration
- `tsconfig.base.json` - Shared TypeScript configuration
- Root `package.json` - Workspace scripts and dependencies

## Build Output

- Extension: `dist/apps/chrome-extension/`
- Server: `dist/apps/mcp-server/`

## Repo Hygiene

- Do not commit `.env` or build artifacts
