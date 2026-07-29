export const COPILOT_INSTRUCTIONS_FILENAME = 'browser-debug-cli.instructions.md';
export const BROWSER_DEBUG_CLI_SKILL_NAME = 'browser-debug-cli';

export const BROWSER_DEBUG_AGENT_INSTRUCTIONS = `---
applyTo: "**"
---

# Browser Debug CLI

When browser debugging evidence is needed and MCP tools are unavailable, use the packaged CLI instead of guessing from source alone.

First verify that the packaged CLI is installed:

\`\`\`bash
bdmcp --help
\`\`\`

If the command is not found, install the package that provides it:

\`\`\`bash
npm i -g browser-debug-mcp-bridge
\`\`\`

From a local repo clone without a global install, use \`node scripts/browser-debug-cli.cjs\`
in place of \`bdmcp\`.

Then start with:

\`\`\`bash
bdmcp health
bdmcp sessions --live
bdmcp summary @recommended
\`\`\`

Use session aliases:

- \`@recommended\` or \`@live\` for the best connected browser session
- \`@latest\` for the most recent persisted session
- \`@auto\` for connected session first, then latest

Useful commands:

\`\`\`bash
bdmcp console @recommended --level error
bdmcp live-console @recommended
bdmcp network @recommended --failures
bdmcp page-state @recommended
bdmcp snapshot @recommended --mode png
bdmcp tool run list_sessions --args-file browser-debug-args.json
\`\`\`

Prefer compact output unless raw JSON is required. Use \`--json\` for machine-readable output and \`--max-bytes\` to bound large responses.
`;

export const BROWSER_DEBUG_CLI_SKILL = `---
name: browser-debug-cli
description: Use when MCP tools are unavailable or blocked but terminal commands are allowed, and Codex needs browser debugging evidence from Browser Debug MCP Bridge. Provides workflows for using the packaged bdmcp CLI to inspect sessions, console logs, network failures, page state, snapshots, Lighthouse reports, and generic bridge tool calls.
---

# Browser Debug CLI

Use \`bdmcp\` when Browser Debug MCP Bridge evidence is needed and MCP tools are not available.

First verify that the packaged CLI is installed:

\`\`\`bash
bdmcp --help
\`\`\`

If the command is not found, install the package that provides it:

\`\`\`bash
npm i -g browser-debug-mcp-bridge
\`\`\`

From a local repo clone without a global install, use \`node scripts/browser-debug-cli.cjs\`
in place of \`bdmcp\`.

Then start with:

\`\`\`bash
bdmcp health
bdmcp sessions --live
bdmcp summary @recommended
\`\`\`

Session aliases:

- \`@recommended\`: prefer a connected live session
- \`@live\`: connected live session
- \`@latest\`: most recent persisted session
- \`@auto\`: connected first, latest fallback

Common commands:

\`\`\`bash
bdmcp console @recommended --level error
bdmcp live-console @recommended
bdmcp network @recommended --failures
bdmcp page-state @recommended
bdmcp snapshot @recommended --mode png
bdmcp tool list
bdmcp tool schema list_sessions
bdmcp tool run list_sessions --args-file browser-debug-args.json --json
\`\`\`

Prefer compact output first. Use \`--json\` only when structured output is needed. Use \`--max-bytes\` for large responses.

If \`bdmcp health\` cannot connect, ask the user to start the bridge:

\`\`\`bash
browser-debug-mcp-bridge --standalone
\`\`\`
`;

export function getAgentInstructions(): string {
  return BROWSER_DEBUG_AGENT_INSTRUCTIONS;
}

export function getSkillInstructions(): string {
  return BROWSER_DEBUG_CLI_SKILL;
}
