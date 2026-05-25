# Browser Debug CLI

`bdmcp` is the packaged command-line access path for Browser Debug MCP Bridge.

Use it when an AI environment cannot use MCP tools, for example when a Copilot organization disables MCP servers, but terminal commands are still allowed. This is not a policy bypass for environments that also disallow terminal execution.

## Install

```bash
npm i -g browser-debug-mcp-bridge
```

The package provides these commands:

- `browser-debug-mcp-bridge`: MCP stdio launcher
- `bdmcp`: browser-debug CLI
- `browser-debug-cli`: alias for `bdmcp`

Start the bridge in a terminal:

```bash
browser-debug-mcp-bridge --standalone
```

Then use the CLI from the target project:

```bash
bdmcp health
bdmcp sessions --live
bdmcp summary @recommended
```

## Agent Setup

Create Copilot repository instructions:

```bash
bdmcp init-copilot
```

This writes:

```text
.github/instructions/browser-debug-cli.instructions.md
```

Create a repo-local Codex-style skill:

```bash
bdmcp init-skill
```

This writes:

```text
.agents/skills/browser-debug-cli/SKILL.md
```

Use `--dry-run` to preview either file and `--force` to overwrite an existing file.

## Core Commands

```bash
bdmcp health
bdmcp tool list
bdmcp tool schema list_sessions
bdmcp tool run list_sessions --args-file browser-debug-args.json --json
```

Friendly commands:

```bash
bdmcp sessions --live
bdmcp summary @recommended
bdmcp events @recommended --limit 50
bdmcp console @recommended --level error
bdmcp live-console @recommended
bdmcp network @recommended --failures
bdmcp page-state @recommended
bdmcp snapshot @recommended --mode png
bdmcp steps @recommended --file flow.json
bdmcp lighthouse --url http://localhost:3000
```

Session aliases:

- `@recommended`: prefer a connected live session
- `@live`: connected live session
- `@latest`: most recent persisted session
- `@auto`: connected first, latest fallback

## Generic Tool Calls

Every bridge tool is available through the generic command:

```bash
bdmcp tool run <toolName> --args-file args.json --json
```

Prefer `--args-file` on Windows and in Copilot terminals because shell quoting for inline JSON is fragile.

Example `browser-debug-args.json`:

```json
{
  "sinceMinutes": 60,
  "limit": 10
}
```

## Security

The generic CLI tool gateway requires a local token stored in the Browser Debug MCP Bridge runtime data directory. The packaged CLI reads it automatically. The gateway is intended for local use on `127.0.0.1`.

The CLI appends command audit events to `cli-audit.ndjson` in the runtime data directory.
