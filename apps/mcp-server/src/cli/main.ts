#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { pathToFileURL } from 'url';
import { appendCliAuditEvent } from './audit-log.js';
import {
  BROWSER_DEBUG_CLI_SKILL_NAME,
  COPILOT_INSTRUCTIONS_FILENAME,
  getAgentInstructions,
  getSkillInstructions,
} from './agent-instructions.js';
import { CLI_TOKEN_HEADER, ensureCliToken } from './auth.js';

interface ParsedArgs {
  command: string[];
  options: Record<string, string | boolean>;
}

interface ToolRunResult {
  ok: boolean;
  toolName?: string;
  response?: Record<string, unknown>;
  error?: string;
}

class BridgeRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly pathname: string,
  ) {
    super(message);
    this.name = 'BridgeRequestError';
  }
}

const DEFAULT_PORT = 8065;
const DEFAULT_HOST = '127.0.0.1';
const VERSION = '1.0.0';

function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  const options: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg.startsWith('--')) {
      const withoutPrefix = arg.slice(2);
      const [rawKey, inlineValue] = withoutPrefix.split('=', 2);
      const key = rawKey.trim();
      if (!key) {
        continue;
      }
      if (inlineValue !== undefined) {
        options[key] = inlineValue;
        continue;
      }
      const next = argv[index + 1];
      if (next && !next.startsWith('-')) {
        options[key] = next;
        index += 1;
        continue;
      }
      options[key] = true;
      continue;
    }
    command.push(arg);
  }

  return { command, options };
}

function optionString(options: Record<string, string | boolean>, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' ? value : undefined;
}

function optionNumber(options: Record<string, string | boolean>, key: string): number | undefined {
  const value = optionString(options, key);
  if (!value) {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function hasFlag(options: Record<string, string | boolean>, key: string): boolean {
  return options[key] === true;
}

function getBaseUrl(options: Record<string, string | boolean>): string {
  const explicit = optionString(options, 'base-url') ?? process.env.BDMCP_BASE_URL;
  if (explicit) {
    return explicit.replace(/\/$/u, '');
  }
  const port = optionNumber(options, 'port') ?? Number(process.env.PORT ?? DEFAULT_PORT);
  const host = optionString(options, 'host') ?? process.env.HOST ?? DEFAULT_HOST;
  return `http://${host}:${Number.isFinite(port) ? port : DEFAULT_PORT}`;
}

function parseJsonObject(value: string | undefined, label: string): Record<string, unknown> {
  if (!value) {
    return {};
  }
  const parsed = JSON.parse(value.replace(/^\uFEFF/u, '')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

async function fetchJson(baseUrl: string, pathname: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok || payload.ok === false) {
    throw new BridgeRequestError(
      typeof payload.error === 'string' ? payload.error : `Bridge request failed: ${pathname}`,
      response.status,
      pathname,
    );
  }
  return payload;
}

async function getCliErrorGuidance(baseUrl: string, error: unknown): Promise<string> {
  const startGuidance = 'If the bridge is not running, start it with: browser-debug-mcp-bridge --standalone';
  if (
    !(error instanceof BridgeRequestError)
    || error.statusCode !== 404
    || !error.pathname.startsWith('/cli/')
  ) {
    return startGuidance;
  }

  try {
    const health = await fetchJson(baseUrl, '/health');
    if (health.status !== 'ok') {
      return startGuidance;
    }
  } catch {
    return startGuidance;
  }

  return 'The running bridge is healthy but does not expose the CLI API. '
    + 'Stop the older bridge, upgrade it with `npm i -g browser-debug-mcp-bridge@latest`, '
    + 'then restart the bridge.';
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp(): void {
  process.stdout.write(`Browser Debug MCP Bridge CLI ${VERSION}

Usage:
  bdmcp health
  bdmcp sessions [--live] [--json]
  bdmcp summary <sessionId|@latest|@live|@recommended|@auto>
  bdmcp console <session> [--level error] [--limit 50]
  bdmcp live-console <session> [--level error] [--contains text]
  bdmcp network <session> [--failures]
  bdmcp page-state <session>
  bdmcp snapshot <session> [--selector body] [--mode dom|png|both]
  bdmcp steps <session> --file flow.json
  bdmcp lighthouse --url http://localhost:3000
  bdmcp tool list
  bdmcp tool schema <toolName>
  bdmcp tool run <toolName> --json-args '{"limit":10}'
  bdmcp tool run <toolName> --args-file args.json
  bdmcp init-copilot [--force|--dry-run]
  bdmcp init-skill [--path .agents/skills] [--force|--dry-run]
  bdmcp help --agent

Global options:
  --base-url <url>   Bridge base URL. Defaults to http://127.0.0.1:8065
  --port <port>      Bridge port when --base-url is not set
  --json             Print raw JSON
  --max-bytes <n>    Bound tool response size when the tool supports it
`);
}

function printAgentHelp(): void {
  process.stdout.write(getAgentInstructions());
  if (!getAgentInstructions().endsWith('\n')) {
    process.stdout.write('\n');
  }
}

function parseToolArguments(options: Record<string, string | boolean>): Record<string, unknown> {
  const argsFile = optionString(options, 'args-file');
  if (argsFile) {
    return parseJsonObject(readFileSync(resolve(argsFile), 'utf8'), 'tool arguments file');
  }
  return parseJsonObject(optionString(options, 'json-args') ?? optionString(options, 'args'), 'tool arguments');
}

async function callTool(
  baseUrl: string,
  toolName: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const token = ensureCliToken();
  const payload = await fetchJson(baseUrl, `/cli/tools/${encodeURIComponent(toolName)}`, {
    method: 'POST',
    headers: {
      [CLI_TOKEN_HEADER]: token,
    },
    body: JSON.stringify({ arguments: input }),
  }) as unknown as ToolRunResult;
  return (payload.response ?? {}) as Record<string, unknown>;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

function isLiveSession(session: Record<string, unknown>): boolean {
  const liveConnection = session.liveConnection;
  return Boolean(
    liveConnection
    && typeof liveConnection === 'object'
    && !Array.isArray(liveConnection)
    && (liveConnection as { connected?: unknown }).connected === true,
  );
}

async function resolveSessionAlias(baseUrl: string, value: string): Promise<string> {
  if (!value.startsWith('@')) {
    return value;
  }

  const response = await callTool(baseUrl, 'list_sessions', {
    sinceMinutes: 240,
    limit: 25,
    maxResponseBytes: 65_536,
  });
  const sessions = asRecordArray(response.sessions);
  if (sessions.length === 0) {
    throw new Error(`No sessions available for alias ${value}`);
  }

  const connected = sessions.find(isLiveSession);
  if (value === '@live' || value === '@recommended') {
    const candidate = connected ?? sessions[0];
    const sessionId = candidate?.sessionId;
    if (typeof sessionId !== 'string') {
      throw new Error(`Unable to resolve session alias ${value}`);
    }
    return sessionId;
  }

  if (value === '@auto') {
    const candidate = connected ?? sessions[0];
    const sessionId = candidate?.sessionId;
    if (typeof sessionId !== 'string') {
      throw new Error(`Unable to resolve session alias ${value}`);
    }
    return sessionId;
  }

  if (value === '@latest') {
    const sessionId = sessions[0]?.sessionId;
    if (typeof sessionId !== 'string') {
      throw new Error(`Unable to resolve session alias ${value}`);
    }
    return sessionId;
  }

  throw new Error(`Unknown session alias: ${value}`);
}

function withCommonLimits(input: Record<string, unknown>, options: Record<string, string | boolean>): Record<string, unknown> {
  const limit = optionNumber(options, 'limit');
  const maxResponseBytes = optionNumber(options, 'max-bytes');
  return {
    ...input,
    ...(limit ? { limit } : {}),
    ...(maxResponseBytes ? { maxResponseBytes } : {}),
  };
}

function printCompactToolResponse(toolName: string, response: Record<string, unknown>): void {
  if (toolName === 'list_sessions') {
    const sessions = asRecordArray(response.sessions);
    if (sessions.length === 0) {
      process.stdout.write('No sessions found.\n');
      return;
    }
    for (const session of sessions) {
      const live = session.liveConnection as Record<string, unknown> | undefined;
      const connected = live?.connected === true ? 'live' : 'offline';
      process.stdout.write(
        `${String(session.sessionId)} ${connected} ${String(session.status ?? '')} ${String(session.lastUrl ?? session.urlLast ?? '')}\n`,
      );
    }
    return;
  }

  if (toolName === 'get_session_summary') {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return;
  }

  if (toolName === 'get_recent_events') {
    const events = asRecordArray(response.events);
    for (const event of events) {
      process.stdout.write(`${String(event.ts ?? event.timestamp ?? '')} ${String(event.type ?? '')} ${String(event.summary ?? '')}\n`);
    }
    return;
  }

  if (toolName === 'get_console_events' || toolName === 'get_live_console_logs') {
    const logs = asRecordArray(response.logs ?? response.events);
    for (const log of logs) {
      process.stdout.write(`${String(log.level ?? log.type ?? '')} ${String(log.message ?? log.text ?? log.summary ?? '')}\n`);
    }
    return;
  }

  if (toolName === 'get_network_failures' || toolName === 'get_network_calls') {
    const rows = asRecordArray(response.failures ?? response.calls ?? response.network);
    for (const row of rows) {
      process.stdout.write(`${String(row.method ?? '')} ${String(row.status ?? row.statusCode ?? '')} ${String(row.url ?? '')}\n`);
    }
    return;
  }

  printJson(response);
}

async function handleToolCommand(baseUrl: string, parsed: ParsedArgs): Promise<void> {
  const [, subcommand, toolName] = parsed.command;
  if (subcommand === 'list') {
    const response = await fetchJson(baseUrl, '/cli/tools');
    if (hasFlag(parsed.options, 'json')) {
      printJson(response);
      return;
    }
    for (const tool of asRecordArray(response.tools)) {
      process.stdout.write(`${String(tool.name)} - ${String(tool.description)}\n`);
    }
    return;
  }

  if (subcommand === 'schema') {
    if (!toolName) {
      throw new Error('tool schema requires a tool name');
    }
    const response = await fetchJson(baseUrl, '/cli/tools');
    const tool = asRecordArray(response.tools).find((entry) => entry.name === toolName);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}`);
    }
    printJson(tool.inputSchema);
    return;
  }

  if (subcommand === 'run') {
    if (!toolName) {
      throw new Error('tool run requires a tool name');
    }
    const input = parseToolArguments(parsed.options);
    const session = optionString(parsed.options, 'session');
    const response = await callTool(
      baseUrl,
      toolName,
      withCommonLimits({
        ...input,
        ...(session ? { sessionId: await resolveSessionAlias(baseUrl, session) } : {}),
      }, parsed.options),
    );
    if (hasFlag(parsed.options, 'json')) {
      printJson(response);
      return;
    }
    printCompactToolResponse(toolName, response);
    return;
  }

  throw new Error('Unknown tool command. Use `bdmcp tool list`, `bdmcp tool schema`, or `bdmcp tool run`.');
}

async function handleFriendlyTool(baseUrl: string, parsed: ParsedArgs): Promise<void> {
  const command = parsed.command[0] ?? '';
  const sessionArg = parsed.command[1];
  let toolName = '';
  let input: Record<string, unknown> = {};

  if (command === 'sessions') {
    toolName = 'list_sessions';
    input = withCommonLimits({
      sinceMinutes: optionNumber(parsed.options, 'since-minutes') ?? 240,
      limit: optionNumber(parsed.options, 'limit') ?? 25,
    }, parsed.options);
  } else {
    if (!sessionArg && command !== 'lighthouse') {
      throw new Error(`${command} requires a session id or alias`);
    }
    const sessionId = sessionArg ? await resolveSessionAlias(baseUrl, sessionArg) : undefined;
    switch (command) {
      case 'summary':
        toolName = 'get_session_summary';
        input = { sessionId };
        break;
      case 'events':
        toolName = 'get_recent_events';
        input = withCommonLimits({ sessionId, responseProfile: 'compact' }, parsed.options);
        break;
      case 'console':
        toolName = 'get_console_events';
        input = withCommonLimits({ sessionId, level: optionString(parsed.options, 'level') }, parsed.options);
        break;
      case 'live-console':
        toolName = 'get_live_console_logs';
        input = withCommonLimits({
          sessionId,
          responseProfile: 'compact',
          levels: optionString(parsed.options, 'level') ? [optionString(parsed.options, 'level')] : undefined,
          contains: optionString(parsed.options, 'contains'),
        }, parsed.options);
        break;
      case 'network':
        toolName = hasFlag(parsed.options, 'failures') ? 'get_network_failures' : 'get_network_calls';
        input = withCommonLimits({ sessionId }, parsed.options);
        break;
      case 'page-state':
        toolName = 'get_page_state';
        input = withCommonLimits({ sessionId }, parsed.options);
        break;
      case 'snapshot':
        toolName = 'capture_ui_snapshot';
        input = withCommonLimits({
          sessionId,
          selector: optionString(parsed.options, 'selector'),
          mode: optionString(parsed.options, 'mode') ?? 'dom',
        }, parsed.options);
        break;
      case 'steps': {
        const file = optionString(parsed.options, 'file');
        if (!file) {
          throw new Error('steps requires --file <flow.json>');
        }
        const parsedFile = JSON.parse(readFileSync(resolve(file), 'utf8')) as unknown;
        if (!parsedFile || typeof parsedFile !== 'object' || Array.isArray(parsedFile)) {
          throw new Error('steps file must contain a JSON object');
        }
        toolName = 'run_ui_steps';
        input = { ...(parsedFile as Record<string, unknown>), sessionId };
        break;
      }
      case 'lighthouse':
        toolName = 'run_lighthouse_report';
        input = {
          url: optionString(parsed.options, 'url'),
          sessionId,
          formFactor: optionString(parsed.options, 'form-factor'),
        };
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  const response = await callTool(baseUrl, toolName, input);
  if (command === 'sessions' && hasFlag(parsed.options, 'live')) {
    response.sessions = asRecordArray(response.sessions).filter(isLiveSession);
  }
  if (hasFlag(parsed.options, 'json')) {
    printJson(response);
    return;
  }
  printCompactToolResponse(toolName, response);
}

async function handleHealth(baseUrl: string, json: boolean): Promise<void> {
  const health = await fetchJson(baseUrl, '/health');
  if (json) {
    printJson(health);
    return;
  }
  const websocket = health.websocket as Record<string, unknown> | undefined;
  process.stdout.write(`Bridge: ${String(health.status)}\n`);
  process.stdout.write(`Database: ${String(health.database)}\n`);
  process.stdout.write(`WebSocket connections: ${String(websocket?.connections ?? 0)}\n`);
  process.stdout.write(`Active sessions: ${String(websocket?.activeSessions ?? 0)}\n`);
}

function initCopilot(options: Record<string, string | boolean>): void {
  const targetPath = resolve('.github', 'instructions', COPILOT_INSTRUCTIONS_FILENAME);
  const content = getAgentInstructions();
  if (hasFlag(options, 'dry-run')) {
    process.stdout.write(`# Would write ${targetPath}\n\n${content}`);
    return;
  }
  if (existsSync(targetPath) && !hasFlag(options, 'force')) {
    throw new Error(`${targetPath} already exists. Pass --force to overwrite.`);
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, content, 'utf8');
  process.stdout.write(`Wrote ${targetPath}\n`);
}

function initSkill(options: Record<string, string | boolean>): void {
  const root = optionString(options, 'path') ?? resolve('.agents', 'skills');
  const targetPath = resolve(root, BROWSER_DEBUG_CLI_SKILL_NAME, 'SKILL.md');
  const content = getSkillInstructions();
  if (hasFlag(options, 'dry-run')) {
    process.stdout.write(`# Would write ${targetPath}\n\n${content}`);
    return;
  }
  if (existsSync(targetPath) && !hasFlag(options, 'force')) {
    throw new Error(`${targetPath} already exists. Pass --force to overwrite.`);
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, content, 'utf8');
  process.stdout.write(`Wrote ${targetPath}\n`);
}

async function run(parsed: ParsedArgs): Promise<void> {
  const baseUrl = getBaseUrl(parsed.options);
  const command = parsed.command[0] ?? 'help';

  if (command === 'help' || hasFlag(parsed.options, 'help')) {
    if (hasFlag(parsed.options, 'agent')) {
      printAgentHelp();
      return;
    }
    printHelp();
    return;
  }

  if (command === 'agent-instructions') {
    printAgentHelp();
    return;
  }

  if (command === 'init-copilot') {
    initCopilot(parsed.options);
    return;
  }

  if (command === 'init-skill') {
    initSkill(parsed.options);
    return;
  }

  if (command === 'health') {
    await handleHealth(baseUrl, hasFlag(parsed.options, 'json'));
    return;
  }

  if (command === 'tool') {
    await handleToolCommand(baseUrl, parsed);
    return;
  }

  await handleFriendlyTool(baseUrl, parsed);
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;

if (entryUrl && import.meta.url === entryUrl) {
  const startedAt = Date.now();
  const parsed = parseArgs(process.argv.slice(2));
  run(parsed)
    .then(() => {
      appendCliAuditEvent({
        command: parsed.command.join(' ') || 'help',
        args: process.argv.slice(2),
        ok: true,
        durationMs: Date.now() - startedAt,
      });
    })
    .catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      appendCliAuditEvent({
        command: parsed.command.join(' ') || 'help',
        args: process.argv.slice(2),
        ok: false,
        durationMs: Date.now() - startedAt,
        error: message,
      });
      process.stderr.write(`[bdmcp] ${message}\n`);
      process.stderr.write(`[bdmcp] ${await getCliErrorGuidance(getBaseUrl(parsed.options), error)}\n`);
      process.exitCode = 1;
    });
}

export {
  getBaseUrl,
  getCliErrorGuidance,
  isLiveSession,
  parseArgs,
  parseJsonObject,
  parseToolArguments,
  resolveSessionAlias,
  run,
  withCommonLimits,
};
