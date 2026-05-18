import type { Database } from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';

export type ToolLoopGuardOutcome = 'success' | 'failed' | 'no_progress' | 'blocked';
export type ToolLoopGuardSeverity = 'warning' | 'blocked' | 'blocked_next_attempt';

export interface ToolLoopGuardCall {
  toolName: string;
  input: Record<string, unknown>;
  sessionId?: string;
  family: string;
  inputHash: string;
  inputSummary: Record<string, unknown>;
  startedAt: number;
}

export interface ToolLoopGuardDecision {
  status: ToolLoopGuardSeverity;
  reason: 'repeated_same_failure' | 'repeated_family_failure';
  scope: 'tool-input' | 'family-root-cause';
  attemptCount: number;
  recentWindowMs: number;
  rootCauseCode?: string;
  blockUntil?: number;
  message: string;
  requiredStateChange: string[];
}

export interface ToolLoopGuard {
  prepareCall: (toolName: string, input: Record<string, unknown>) => ToolLoopGuardCall;
  beforeCall: (call: ToolLoopGuardCall) => Promise<{ blocked: false } | { blocked: true; response: Record<string, unknown>; decision: ToolLoopGuardDecision }>;
  afterCall: (call: ToolLoopGuardCall, result: { response?: Record<string, unknown>; error?: unknown; durationMs: number }) => Promise<{ response?: Record<string, unknown>; decision?: ToolLoopGuardDecision }>;
}

interface ToolLoopGuardEvent {
  event: 'agent_loop_guard_warning' | 'agent_loop_guard_blocked' | 'agent_loop_guard_error';
  toolName: string;
  sessionId?: string;
  reason?: string;
  rootCauseCode?: string;
  attemptCount?: number;
  message: string;
}

interface ToolLoopGuardOptions {
  getDb: () => Database;
  enabled?: boolean;
  onEvent?: (event: ToolLoopGuardEvent) => void;
}

interface ClassifiedOutcome {
  outcomeType: ToolLoopGuardOutcome;
  rootCauseCode?: string;
  stateHash?: string;
  stateSummary: Record<string, unknown>;
}

const RECENT_WINDOW_MS = 5 * 60_000;
const TOOL_BLOCK_MS = 2 * 60_000;
const FAMILY_BLOCK_MS = 5 * 60_000;
const DEFAULT_WARN_THRESHOLD = 2;
const DEFAULT_BLOCK_THRESHOLD = 4;
const HIGH_RISK_WARN_THRESHOLD = 2;
const HIGH_RISK_BLOCK_THRESHOLD = 3;
const FAMILY_BLOCK_THRESHOLD = 4;

const HIGH_RISK_TOOLS = new Set([
  'enable_overrides',
  'disable_overrides',
  'observe_override_assets',
  'capture_override_response_body',
  'plan_override_response_patch',
  'plan_next_source_override',
  'map_next_override_assets',
  'execute_ui_action',
  'run_ui_steps',
]);

const FAMILY_BLOCKED_TOOLS = new Set([
  'enable_overrides',
  'observe_override_assets',
  'capture_override_response_body',
  'plan_override_response_patch',
  'plan_next_source_override',
  'map_next_override_assets',
]);

const LOOP_PRONE_NEXT_ACTIONS = new Set([
  'DIAGNOSE_OVERRIDES',
  'ENABLE_OVERRIDES',
  'GET_OVERRIDE_STATUS',
  'LOAD_ROUTE',
  'OBSERVE_ASSETS',
  'OBSERVE_OVERRIDE_ASSETS',
  'OBSERVE_TARGET_ROUTE',
  'PLAN_OVERRIDE',
  'PLAN_RESPONSE_PATCH',
  'RECONNECT_OR_RETRY_DISABLE',
  'RECONNECT_OR_RETRY_OVERRIDE_STATUS',
  'RECONNECT_SESSION',
  'RELOAD_OR_INTERACT',
  'RELOAD_TAB',
  'VERIFY_DISABLED',
  'WRITE_CONFIG',
  'WRITE_OVERRIDE_CONFIG',
  'WRITE_RESPONSE_BODY',
]);

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, nestedValue) => {
    if (typeof nestedValue === 'bigint') {
      return String(nestedValue);
    }
    return nestedValue;
  });
}

function normalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForHash);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, normalizeForHash(record[key])]),
  );
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.includes('authorization')
    || normalized.includes('cookie')
    || normalized.includes('password')
    || normalized.includes('secret')
    || normalized.includes('token');
}

function summarizeInput(value: unknown, depth = 0): unknown {
  if (depth > 4) {
    return '[depth-limit]';
  }
  if (typeof value === 'string') {
    return value.length > 240 ? `${value.slice(0, 240)}...[truncated ${value.length}]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => summarizeInput(entry, depth + 1));
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      result[key] = isSensitiveKey(key) ? '[redacted]' : summarizeInput(nestedValue, depth + 1);
    }
    return result;
  }
  return String(value);
}

function getSessionId(input: Record<string, unknown>): string | undefined {
  return typeof input.sessionId === 'string' ? input.sessionId : undefined;
}

function getToolFamily(toolName: string): string {
  if (toolName.includes('override')) {
    return 'override';
  }
  if (toolName.includes('automation') || toolName.includes('ui_') || toolName.includes('page_state')) {
    return 'automation';
  }
  return 'general';
}

function getRecentThresholds(toolName: string): { warn: number; block: number } {
  if (HIGH_RISK_TOOLS.has(toolName)) {
    return { warn: HIGH_RISK_WARN_THRESHOLD, block: HIGH_RISK_BLOCK_THRESHOLD };
  }
  return { warn: DEFAULT_WARN_THRESHOLD, block: DEFAULT_BLOCK_THRESHOLD };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectIssueCodes(value: unknown, codes: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectIssueCodes(entry, codes);
    }
    return codes;
  }
  if (!isRecord(value)) {
    return codes;
  }
  if (typeof value.code === 'string' && value.code.trim().length > 0) {
    codes.push(value.code.trim());
  }
  for (const nestedValue of Object.values(value)) {
    collectIssueCodes(nestedValue, codes);
  }
  return codes;
}

function collectNextActionCodes(response: Record<string, unknown>): string[] {
  const actions = Array.isArray(response.nextActions) ? response.nextActions : [];
  return actions
    .map((action) => isRecord(action) && typeof action.code === 'string' ? action.code : undefined)
    .filter((code): code is string => typeof code === 'string' && code.length > 0);
}

function extractRootCauseFromError(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const explicit = message.match(/\b([A-Z][A-Z0-9_]{2,})\b/u)?.[1];
  if (explicit) {
    return explicit;
  }
  if (/timed out|timeout/i.test(message)) {
    return 'TOOL_TIMEOUT';
  }
  return 'TOOL_ERROR';
}

function extractRootCauseFromResponse(response: Record<string, unknown>): string | undefined {
  const directCandidates = [
    response.code,
    response.failureCode,
    response.lastErrorCode,
    isRecord(response.write) ? response.write.failureCode : undefined,
    isRecord(response.liveStatus) ? response.liveStatus.code : undefined,
    isRecord(response.disableAttempt) ? response.disableAttempt.code : undefined,
    isRecord(response.latestRun) ? response.latestRun.lastErrorCode : undefined,
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }

  const codes = collectIssueCodes(response);
  return codes[0];
}

function isBadResponse(response: Record<string, unknown>): boolean {
  if (response.blocked === true) {
    return true;
  }
  if (response.valid === false || response.ready === false || response.ok === false) {
    return true;
  }
  if (Array.isArray(response.issues) && response.issues.length > 0) {
    return true;
  }
  if (Array.isArray(response.errors) && response.errors.length > 0) {
    return true;
  }
  if (Array.isArray(response.blockers) && response.blockers.length > 0) {
    return true;
  }
  if (isRecord(response.write) && typeof response.write.failureCode === 'string') {
    return true;
  }
  if (isRecord(response.liveStatus) && (response.liveStatus.ok === false || response.liveStatus.available === false)) {
    return true;
  }
  if (isRecord(response.disableAttempt) && response.disableAttempt.ok === false) {
    return true;
  }
  if (isRecord(response.latestRun) && typeof response.latestRun.lastErrorCode === 'string') {
    return true;
  }
  if (isRecord(response.preflight) && response.preflight.ready === false) {
    return true;
  }
  if (isRecord(response.diagnosis) && Array.isArray(response.diagnosis.issues) && response.diagnosis.issues.length > 0) {
    return true;
  }
  if (isRecord(response.diagnosis) && Array.isArray(response.diagnosis.blockers) && response.diagnosis.blockers.length > 0) {
    return true;
  }
  if (response.bodyCaptured === false) {
    return true;
  }
  return false;
}

function classifyResponse(response: Record<string, unknown>): ClassifiedOutcome {
  const rootCauseCode = extractRootCauseFromResponse(response);
  const nextActionCodes = collectNextActionCodes(response);
  const issueCodes = collectIssueCodes(response);
  const badResponse = isBadResponse(response);
  const loopProneNoProgress = !badResponse
    && nextActionCodes.length > 0
    && nextActionCodes.every((code) => LOOP_PRONE_NEXT_ACTIONS.has(code));
  const stateSummary = {
    valid: response.valid,
    ready: response.ready,
    preflightReady: isRecord(response.preflight) ? response.preflight.ready : undefined,
    ok: response.ok,
    active: response.active,
    statusSource: response.statusSource,
    rootCauseCode,
    issueCodes: issueCodes.slice(0, 8),
    nextActionCodes: nextActionCodes.slice(0, 8),
    latestRunError: isRecord(response.latestRun) ? response.latestRun.lastErrorCode : undefined,
    writeFailure: isRecord(response.write) ? response.write.failureCode : undefined,
    bodyCaptured: response.bodyCaptured,
  };
  const outcomeType: ToolLoopGuardOutcome = badResponse
    ? 'failed'
    : loopProneNoProgress
      ? 'no_progress'
      : 'success';
  return {
    outcomeType,
    rootCauseCode: rootCauseCode ?? (loopProneNoProgress ? nextActionCodes[0] : undefined),
    stateHash: hashText(safeStringify(normalizeForHash(stateSummary))),
    stateSummary,
  };
}

function classifyError(error: unknown): ClassifiedOutcome {
  const rootCauseCode = extractRootCauseFromError(error);
  const stateSummary = {
    rootCauseCode,
    message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
  };
  return {
    outcomeType: 'failed',
    rootCauseCode,
    stateHash: hashText(safeStringify(normalizeForHash(stateSummary))),
    stateSummary,
  };
}

function requiredStateChangeFor(rootCauseCode: string | undefined): string[] {
  switch (rootCauseCode) {
    case 'CONFIG_DISABLED':
      return ['override config/profile enabled state changes', 'override profile is regenerated or selected'];
    case 'PROFILE_DISABLED':
    case 'NO_ENABLED_RULES':
      return ['override profile enabled rules change'];
    case 'LIVE_SESSION_DISCONNECTED':
      return ['live extension connection becomes connected', 'sessionId changes'];
    case 'NO_OBSERVED_ASSETS':
    case 'TARGET_ASSET_NOT_OBSERVED':
    case 'TARGET_ASSET_NOT_OBSERVED_FOR_RULE':
      return ['target route is loaded or interacted with', 'observed asset inventory changes'];
    case 'SESSION_SCOPE_DRIFT':
      return ['bound tab selection changes', 'observed asset tab scope changes'];
    case 'LOCAL_FILE_MISSING':
      return ['local override file exists', 'override profile localFilePath changes'];
    case 'OVERRIDE_LIVE_COMMAND_TIMEOUT':
    case 'TOOL_TIMEOUT':
      return ['live extension returns a successful command result', 'session/tab state changes'];
    default:
      return ['tool input changes', 'session/page/override state changes'];
  }
}

function buildDecision(options: {
  severity: ToolLoopGuardSeverity;
  reason: ToolLoopGuardDecision['reason'];
  scope: ToolLoopGuardDecision['scope'];
  attemptCount: number;
  rootCauseCode?: string;
  blockUntil?: number;
  toolName: string;
}): ToolLoopGuardDecision {
  const rootCause = options.rootCauseCode ?? 'NO_PROGRESS';
  const message = options.severity === 'warning'
    ? `Repeated ${options.toolName} attempts are returning the same ${rootCause} result. Change state before continuing.`
    : `Blocked repeated ${options.toolName} attempts with unchanged ${rootCause} result before spending another tool call.`;
  return {
    status: options.severity,
    reason: options.reason,
    scope: options.scope,
    attemptCount: options.attemptCount,
    recentWindowMs: RECENT_WINDOW_MS,
    rootCauseCode: options.rootCauseCode,
    blockUntil: options.blockUntil,
    message,
    requiredStateChange: requiredStateChangeFor(options.rootCauseCode),
  };
}

function buildBlockedResponse(call: ToolLoopGuardCall, decision: ToolLoopGuardDecision): Record<string, unknown> {
  return {
    sessionId: call.sessionId,
    limitsApplied: {
      maxResults: 0,
      truncated: false,
    },
    redactionSummary: {
      totalFields: 0,
      redactedFields: 0,
      rulesApplied: [],
    },
    blocked: true,
    tool: call.toolName,
    loopGuard: decision,
    nextActions: [{
      code: 'CHANGE_STATE_BEFORE_RETRY',
      message: decision.message,
      requiredStateChange: decision.requiredStateChange,
      retryAfterMs: decision.blockUntil ? Math.max(0, decision.blockUntil - Date.now()) : undefined,
    }],
  };
}

function getOpenIncident(db: Database, call: ToolLoopGuardCall, now: number): {
  fingerprint: string;
  scope: 'tool-input' | 'family-root-cause';
  attempt_count: number;
  root_cause_code: string | null;
  blocked_until: number | null;
} | undefined {
  const sessionKey = call.sessionId ?? '';
  const rows = db.prepare(`
    SELECT fingerprint, scope, attempt_count, root_cause_code, blocked_until
    FROM mcp_loop_incidents
    WHERE status = 'open'
      AND blocked_until IS NOT NULL
      AND blocked_until > ?
      AND (
        (scope = 'tool-input' AND tool_name = ? AND input_hash = ? AND COALESCE(session_id, '') = ?)
        OR
        (scope = 'family-root-cause' AND family = ? AND COALESCE(session_id, '') = ?)
      )
    ORDER BY blocked_until DESC
    LIMIT 5
  `).all(now, call.toolName, call.inputHash, sessionKey, call.family, sessionKey) as Array<{
    fingerprint: string;
    scope: 'tool-input' | 'family-root-cause';
    attempt_count: number;
    root_cause_code: string | null;
    blocked_until: number | null;
  }>;

  const toolInputIncident = rows.find((row) => row.scope === 'tool-input');
  if (toolInputIncident) {
    return toolInputIncident;
  }

  return FAMILY_BLOCKED_TOOLS.has(call.toolName)
    ? rows.find((row) => row.scope === 'family-root-cause')
    : undefined;
}

function countRecentExactFailures(db: Database, call: ToolLoopGuardCall, outcome: ClassifiedOutcome, now: number): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM mcp_tool_invocations
    WHERE tool_name = ?
      AND input_hash = ?
      AND COALESCE(session_id, '') = ?
      AND outcome_type IN ('failed', 'no_progress')
      AND COALESCE(root_cause_code, '') = ?
      AND COALESCE(state_hash, '') = ?
      AND created_at >= ?
  `).get(
    call.toolName,
    call.inputHash,
    call.sessionId ?? '',
    outcome.rootCauseCode ?? '',
    outcome.stateHash ?? '',
    now - RECENT_WINDOW_MS,
  ) as { count: number };
  return row.count + 1;
}

function countRecentFamilyFailures(db: Database, call: ToolLoopGuardCall, outcome: ClassifiedOutcome, now: number): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM mcp_tool_invocations
    WHERE family = ?
      AND COALESCE(session_id, '') = ?
      AND outcome_type IN ('failed', 'no_progress')
      AND COALESCE(root_cause_code, '') = ?
      AND COALESCE(state_hash, '') = ?
      AND created_at >= ?
  `).get(
    call.family,
    call.sessionId ?? '',
    outcome.rootCauseCode ?? '',
    outcome.stateHash ?? '',
    now - RECENT_WINDOW_MS,
  ) as { count: number };
  return row.count + 1;
}

function insertInvocation(db: Database, options: {
  call: ToolLoopGuardCall;
  outcome: ClassifiedOutcome;
  durationMs: number;
  responseBytes?: number;
  blocked: boolean;
  warning: boolean;
  message?: string;
  now: number;
}): void {
  db.prepare(`
    INSERT INTO mcp_tool_invocations (
      invocation_id, tool_name, session_id, family, input_hash, input_summary_json,
      outcome_type, root_cause_code, state_hash, state_summary_json, response_bytes,
      duration_ms, blocked, warning, message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    options.call.toolName,
    options.call.sessionId ?? null,
    options.call.family,
    options.call.inputHash,
    safeStringify(options.call.inputSummary),
    options.outcome.outcomeType,
    options.outcome.rootCauseCode ?? null,
    options.outcome.stateHash ?? null,
    safeStringify(options.outcome.stateSummary),
    options.responseBytes ?? null,
    options.durationMs,
    options.blocked ? 1 : 0,
    options.warning ? 1 : 0,
    options.message ?? null,
    options.now,
  );
}

function upsertIncident(db: Database, options: {
  call: ToolLoopGuardCall;
  outcome: ClassifiedOutcome;
  scope: 'tool-input' | 'family-root-cause';
  attemptCount: number;
  severity: 'warning' | 'blocked';
  message: string;
  blockUntil?: number;
  now: number;
}): void {
  const fingerprint = hashText(safeStringify([
    options.scope,
    options.scope === 'tool-input' ? options.call.toolName : options.call.family,
    options.call.sessionId ?? '',
    options.scope === 'tool-input' ? options.call.inputHash : '',
    options.outcome.rootCauseCode ?? '',
    options.outcome.stateHash ?? '',
  ]));
  const existing = db.prepare(`
    SELECT incident_id
    FROM mcp_loop_incidents
    WHERE fingerprint = ? AND status = 'open'
    LIMIT 1
  `).get(fingerprint) as { incident_id: string } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE mcp_loop_incidents
      SET last_seen_at = ?,
          attempt_count = ?,
          severity = ?,
          blocked_until = COALESCE(?, blocked_until),
          message = ?,
          updated_at = ?
      WHERE incident_id = ?
    `).run(
      options.now,
      options.attemptCount,
      options.severity,
      options.blockUntil ?? null,
      options.message,
      options.now,
      existing.incident_id,
    );
    return;
  }

  db.prepare(`
    INSERT INTO mcp_loop_incidents (
      incident_id, fingerprint, scope, status, tool_name, session_id, family, input_hash,
      root_cause_code, state_hash, first_seen_at, last_seen_at, attempt_count,
      blocked_until, severity, message, created_at, updated_at
    ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    fingerprint,
    options.scope,
    options.scope === 'tool-input' ? options.call.toolName : null,
    options.call.sessionId ?? null,
    options.call.family,
    options.scope === 'tool-input' ? options.call.inputHash : null,
    options.outcome.rootCauseCode ?? null,
    options.outcome.stateHash ?? null,
    options.now,
    options.now,
    options.attemptCount,
    options.blockUntil ?? null,
    options.severity,
    options.message,
    options.now,
    options.now,
  );
}

function resolveOpenIncidentsForSuccess(db: Database, call: ToolLoopGuardCall, now: number): void {
  db.prepare(`
    UPDATE mcp_loop_incidents
    SET status = 'resolved', updated_at = ?
    WHERE status = 'open'
      AND (
        (scope = 'tool-input' AND tool_name = ? AND input_hash = ? AND COALESCE(session_id, '') = ?)
        OR
        (scope = 'family-root-cause' AND family = ? AND COALESCE(session_id, '') = ?)
      )
  `).run(now, call.toolName, call.inputHash, call.sessionId ?? '', call.family, call.sessionId ?? '');
}

function responseBytes(response: Record<string, unknown>): number | undefined {
  return typeof response.responseBytes === 'number' && Number.isFinite(response.responseBytes)
    ? Math.floor(response.responseBytes)
    : undefined;
}

function emit(options: ToolLoopGuardOptions, event: ToolLoopGuardEvent): void {
  try {
    options.onEvent?.(event);
  } catch {
    // Loop-guard notifications must never break tool execution.
  }
}

function withGuardWarning(response: Record<string, unknown>, decision: ToolLoopGuardDecision): Record<string, unknown> {
  return {
    ...response,
    loopGuard: decision,
  };
}

export function createToolLoopGuard(options: ToolLoopGuardOptions): ToolLoopGuard {
  const enabled = options.enabled !== false && process.env.MCP_LOOP_GUARD !== '0';

  const safeDb = (): Database | undefined => {
    if (!enabled) {
      return undefined;
    }
    try {
      return options.getDb();
    } catch (error) {
      emit(options, {
        event: 'agent_loop_guard_error',
        toolName: 'unknown',
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  };

  return {
    prepareCall: (toolName, input) => {
      const normalizedInput = normalizeForHash(input);
      return {
        toolName,
        input,
        sessionId: getSessionId(input),
        family: getToolFamily(toolName),
        inputHash: hashText(safeStringify(normalizedInput)),
        inputSummary: summarizeInput(input) as Record<string, unknown>,
        startedAt: Date.now(),
      };
    },

    beforeCall: async (call) => {
      const db = safeDb();
      if (!db) {
        return { blocked: false };
      }

      try {
        const now = Date.now();
        const incident = getOpenIncident(db, call, now);
        if (!incident) {
          return { blocked: false };
        }
        const decision = buildDecision({
          severity: 'blocked',
          reason: incident.scope === 'family-root-cause' ? 'repeated_family_failure' : 'repeated_same_failure',
          scope: incident.scope,
          attemptCount: incident.attempt_count,
          rootCauseCode: incident.root_cause_code ?? undefined,
          blockUntil: incident.blocked_until ?? undefined,
          toolName: call.toolName,
        });
        insertInvocation(db, {
          call,
          outcome: {
            outcomeType: 'blocked',
            rootCauseCode: incident.root_cause_code ?? undefined,
            stateHash: undefined,
            stateSummary: { blockedByIncident: incident.fingerprint },
          },
          durationMs: 0,
          blocked: true,
          warning: false,
          message: decision.message,
          now,
        });
        emit(options, {
          event: 'agent_loop_guard_blocked',
          toolName: call.toolName,
          sessionId: call.sessionId,
          reason: decision.reason,
          rootCauseCode: decision.rootCauseCode,
          attemptCount: decision.attemptCount,
          message: decision.message,
        });
        return {
          blocked: true,
          response: buildBlockedResponse(call, decision),
          decision,
        };
      } catch (error) {
        emit(options, {
          event: 'agent_loop_guard_error',
          toolName: call.toolName,
          sessionId: call.sessionId,
          message: error instanceof Error ? error.message : String(error),
        });
        return { blocked: false };
      }
    },

    afterCall: async (call, result) => {
      const db = safeDb();
      if (!db) {
        return { response: result.response };
      }

      try {
        const now = Date.now();
        const outcome = result.error ? classifyError(result.error) : classifyResponse(result.response ?? {});
        if (outcome.outcomeType === 'success') {
          resolveOpenIncidentsForSuccess(db, call, now);
          insertInvocation(db, {
            call,
            outcome,
            durationMs: result.durationMs,
            responseBytes: result.response ? responseBytes(result.response) : undefined,
            blocked: false,
            warning: false,
            now,
          });
          return { response: result.response };
        }

        const exactCount = countRecentExactFailures(db, call, outcome, now);
        const familyCount = countRecentFamilyFailures(db, call, outcome, now);
        const thresholds = getRecentThresholds(call.toolName);
        const shouldBlockExact = exactCount >= thresholds.block;
        const shouldWarnExact = exactCount >= thresholds.warn;
        const shouldBlockFamily = call.family !== 'general' && familyCount >= FAMILY_BLOCK_THRESHOLD;
        const blockUntil = now + (shouldBlockFamily ? FAMILY_BLOCK_MS : TOOL_BLOCK_MS);
        const decision = shouldBlockExact || shouldBlockFamily
          ? buildDecision({
              severity: 'blocked_next_attempt',
              reason: shouldBlockFamily ? 'repeated_family_failure' : 'repeated_same_failure',
              scope: shouldBlockFamily ? 'family-root-cause' : 'tool-input',
              attemptCount: shouldBlockFamily ? familyCount : exactCount,
              rootCauseCode: outcome.rootCauseCode,
              blockUntil,
              toolName: call.toolName,
            })
          : shouldWarnExact
            ? buildDecision({
                severity: 'warning',
                reason: 'repeated_same_failure',
                scope: 'tool-input',
                attemptCount: exactCount,
                rootCauseCode: outcome.rootCauseCode,
                toolName: call.toolName,
              })
            : undefined;

        insertInvocation(db, {
          call,
          outcome,
          durationMs: result.durationMs,
          responseBytes: result.response ? responseBytes(result.response) : undefined,
          blocked: false,
          warning: decision !== undefined,
          message: decision?.message,
          now,
        });

        if (decision?.status === 'blocked_next_attempt') {
          upsertIncident(db, {
            call,
            outcome,
            scope: decision.scope,
            attemptCount: decision.attemptCount,
            severity: 'blocked',
            message: decision.message,
            blockUntil,
            now,
          });
        } else if (decision?.status === 'warning') {
          upsertIncident(db, {
            call,
            outcome,
            scope: 'tool-input',
            attemptCount: exactCount,
            severity: 'warning',
            message: decision.message,
            now,
          });
        }

        if (decision) {
          emit(options, {
            event: decision.status === 'warning' ? 'agent_loop_guard_warning' : 'agent_loop_guard_blocked',
            toolName: call.toolName,
            sessionId: call.sessionId,
            reason: decision.reason,
            rootCauseCode: decision.rootCauseCode,
            attemptCount: decision.attemptCount,
            message: decision.message,
          });
        }

        return {
          response: result.response && decision ? withGuardWarning(result.response, decision) : result.response,
          decision,
        };
      } catch (error) {
        emit(options, {
          event: 'agent_loop_guard_error',
          toolName: call.toolName,
          sessionId: call.sessionId,
          message: error instanceof Error ? error.message : String(error),
        });
        return { response: result.response };
      }
    },
  };
}
