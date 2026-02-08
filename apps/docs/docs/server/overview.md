# Server

The server is a Fastify app with:

- WebSocket ingestion endpoint
- SQLite persistence (sessions/events/network/error fingerprints)
- MCP stdio runtime and tool routing
- health and stats endpoints for development diagnostics

## Operational endpoints

- `GET /health`: process + DB + connection health
- `GET /stats`: development counters and runtime stats

## Logging

Structured logs cover WebSocket lifecycle, ingest parsing, and MCP tool durations.
