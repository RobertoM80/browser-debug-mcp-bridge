# Copilot CLI Workflow

Use `bdmcp` when Copilot cannot use MCP servers but terminal commands are allowed.

This workflow is not a workaround for organizations that disallow terminal execution. It is a non-MCP command-line workflow for environments where MCP tools are unavailable.

## Setup

Install the package:

```bash
npm i -g browser-debug-mcp-bridge
```

Start the bridge:

```bash
browser-debug-mcp-bridge --standalone
```

Generate Copilot instructions in the target repo:

```bash
bdmcp init-copilot
```

Optional: generate a repo-local skill for agents that support skills:

```bash
bdmcp init-skill
```

## Commands For Agents

Start every investigation with:

```bash
bdmcp health
bdmcp sessions --live
bdmcp summary @recommended
```

Then inspect targeted evidence:

```bash
bdmcp console @recommended --level error
bdmcp live-console @recommended
bdmcp network @recommended --failures
bdmcp page-state @recommended
bdmcp snapshot @recommended --mode png
```

Use generic tool access for anything not covered by a friendly command:

```bash
bdmcp tool list
bdmcp tool schema list_sessions
bdmcp tool run list_sessions --args-file browser-debug-args.json --json
```

Prefer `--args-file` for generic calls in Windows and Copilot terminals.
