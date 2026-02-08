# PROJECT_OVERVIEW.md

## Browser Debug MCP Bridge

A system that captures real context from a user's Chrome browser during debugging sessions and makes it queryable on-demand by an LLM through MCP (Model Context Protocol).

### Key Concept
The LLM shouldn't guess. It requests concrete evidence only when needed (console errors, failed requests, DOM subtree, computed styles, layout metrics, etc.) from the real browser with the user's session, extensions, and internal environments.

### Architecture
- **Chrome Extension (MV3)**: Captures telemetry, executes heavy captures on demand
- **Local Server (Node.js/TS)**: Ingests events, persists to SQLite, exposes MCP server
- **Security First**: Safe mode by default, domain allowlist, redaction, tool limits

### Tech Stack
- TypeScript monorepo with Nx
- pnpm workspace
- SQLite with better-sqlite3
- Fastify (HTTP) + ws (WebSocket)
- Vitest for testing
- Vite for extension build

### Development Phases
1. Phase 0: Nx bootstrap and workspace setup
2. Phase 1: End-to-end light telemetry
3. Phase 2: Robust network metadata
4. Phase 3: Heavy capture on-demand
5. Phase 4: Correlation engine
6. Phase 5: Export and viewer (optional)

See PROJECT_INFOS.md for full specifications.
