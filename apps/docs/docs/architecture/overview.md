# Architecture Overview

The platform has three logical components:

1. **Chrome extension (MV3)**: captures light telemetry and executes heavy captures on demand.
2. **Local server**: ingests events over WebSocket, persists to SQLite, and exposes MCP tools.
3. **Optional viewer**: inspects stored sessions.

## Data flow

- Extension -> WebSocket -> Server -> SQLite
- MCP client -> Server -> SQLite query or extension capture command -> tool response

## Core design principle

Light telemetry is always-on and indexed. Heavy evidence is requested only when an investigation requires it.

Related docs:

- [Server docs](../server/overview.md)
- [Extension docs](../extension/overview.md)
- [Limits and redaction reference](../reference/limits-and-redaction.md)
