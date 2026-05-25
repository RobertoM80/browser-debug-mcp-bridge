---
name: browser-debug-cli
description: Use when MCP tools are unavailable or blocked but terminal commands are allowed, and Codex needs browser debugging evidence from Browser Debug MCP Bridge. Provides workflows for using the packaged bdmcp CLI to inspect sessions, console logs, network failures, page state, snapshots, Lighthouse reports, and generic bridge tool calls.
---

# Browser Debug CLI

Use `bdmcp` when Browser Debug MCP Bridge evidence is needed and MCP tools are not available.

Start with:

```bash
bdmcp health
bdmcp sessions --live
bdmcp summary @recommended
```

Session aliases:

- `@recommended`: prefer a connected live session
- `@live`: connected live session
- `@latest`: most recent persisted session
- `@auto`: connected first, latest fallback

Common commands:

```bash
bdmcp console @recommended --level error
bdmcp live-console @recommended
bdmcp network @recommended --failures
bdmcp page-state @recommended
bdmcp snapshot @recommended --mode png
bdmcp tool list
bdmcp tool schema list_sessions
bdmcp tool run list_sessions --args-file browser-debug-args.json --json
```

Prefer compact output first. Use `--json` only when structured output is needed. Use `--max-bytes` for large responses.

If `bdmcp health` cannot connect, ask the user to start the bridge:

```bash
browser-debug-mcp-bridge --standalone
```
