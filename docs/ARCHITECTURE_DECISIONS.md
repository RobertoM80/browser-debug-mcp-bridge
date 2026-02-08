# Architecture Decisions

This document captures key design choices and tradeoffs.

## AD-001: Nx monorepo with pnpm

- Decision: Use Nx + pnpm workspace for apps and shared libraries.
- Why: Shared TypeScript code, consistent targets, and fast project-scoped tasks.
- Tradeoff: Some initial config overhead.

## AD-002: SQLite for local persistence

- Decision: Persist telemetry in SQLite (`better-sqlite3`).
- Why: Zero external infrastructure, predictable local performance, simple backups.
- Tradeoff: Single-node local storage only.

## AD-003: Light telemetry always-on, heavy capture on-demand

- Decision: Persist lightweight events continuously; run heavy DOM/style capture only via explicit MCP calls.
- Why: Keeps storage/query cost bounded while preserving deep debugging capability.
- Tradeoff: Some investigations require an extra capture step.

## AD-004: Privacy-first defaults

- Decision: Safe mode on by default, strict allowlist, and mandatory redaction pipeline.
- Why: Reduce accidental sensitive-data collection.
- Tradeoff: Some useful signals are unavailable unless explicitly enabled.

## AD-005: WebSocket bridge between extension and server

- Decision: Use WebSocket for both ingest and server-to-extension capture commands.
- Why: Bidirectional low-latency messaging matches event streaming and command workflows.
- Tradeoff: Connection lifecycle and backpressure handling increase complexity.

## AD-006: MCP server as query/control interface

- Decision: Expose persisted data and heavy-capture controls as MCP tools.
- Why: Gives LLMs structured, bounded access to debugging evidence.
- Tradeoff: Requires careful schema/version management for tool contracts.
