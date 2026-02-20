# MCP Tools Overview

All tool responses include:

- `sessionId`
- `limitsApplied`
- `redactionSummary`

## Tool families

- **V1 query tools** for recent sessions, events, and persisted diagnostics
- **V2 heavy capture tools** for targeted DOM/styles/layout evidence
- **V3 correlation tools** for reasoned timelines across events
- **V4 snapshot tools** for snapshot timelines and bounded asset retrieval

## Request/response conventions

- Inputs validated with Zod schemas
- Pagination available on high-cardinality tools
- Size/depth/time limits applied to heavy captures

Continue with:

- [V1 query tools](./v1-query-tools.md)
- [V2 heavy capture tools](./v2-heavy-capture.md)
- [V3 correlation tools](./v3-correlation.md)
- [V4 snapshot tools](./v4-snapshot-tools.md)
