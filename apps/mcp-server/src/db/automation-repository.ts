import type { Database } from 'better-sqlite3';

const AUTOMATION_EVENT_TYPES = new Set([
  'automation_requested',
  'automation_started',
  'automation_succeeded',
  'automation_failed',
  'automation_stopped',
]);

export interface AutomationLifecycleEventInput {
  eventId?: string;
  eventType: string;
  sessionId: string;
  timestamp: number;
  tabId?: number | null;
  payload: Record<string, unknown>;
}

export interface AutomationRunRow {
  run_id: string;
  session_id: string;
  trace_id: string | null;
  action: string | null;
  tab_id: number | null;
  selector: string | null;
  status: string;
  started_at: number;
  completed_at: number | null;
  stop_reason: string | null;
  target_summary_json: string | null;
  failure_json: string | null;
  redaction_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface AutomationStepRow {
  step_id: string;
  run_id: string;
  session_id: string;
  step_order: number;
  trace_id: string | null;
  action: string;
  selector: string | null;
  status: string;
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  tab_id: number | null;
  target_summary_json: string | null;
  redaction_json: string | null;
  failure_json: string | null;
  input_metadata_json: string | null;
  event_type: string;
  event_id: string | null;
  created_at: number;
  updated_at: number;
}

export function isAutomationLifecycleEventType(eventType: string): boolean {
  return AUTOMATION_EVENT_TYPES.has(eventType);
}

export class AutomationRepository {
  constructor(private readonly db: Database) {}

  upsertLifecycleEvent(input: AutomationLifecycleEventInput): void {
    if (!isAutomationLifecycleEventType(input.eventType)) {
      return;
    }

    const normalized = normalizeLifecycleEvent(input);
    const upsertRun = this.db.prepare(`
      INSERT INTO automation_runs (
        run_id,
        session_id,
        trace_id,
        action,
        tab_id,
        selector,
        status,
        started_at,
        completed_at,
        stop_reason,
        target_summary_json,
        failure_json,
        redaction_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        trace_id = COALESCE(excluded.trace_id, automation_runs.trace_id),
        action = COALESCE(excluded.action, automation_runs.action),
        tab_id = COALESCE(excluded.tab_id, automation_runs.tab_id),
        selector = COALESCE(excluded.selector, automation_runs.selector),
        status = excluded.status,
        started_at = MIN(automation_runs.started_at, excluded.started_at),
        completed_at = COALESCE(excluded.completed_at, automation_runs.completed_at),
        stop_reason = COALESCE(excluded.stop_reason, automation_runs.stop_reason),
        target_summary_json = COALESCE(excluded.target_summary_json, automation_runs.target_summary_json),
        failure_json = COALESCE(excluded.failure_json, automation_runs.failure_json),
        redaction_json = COALESCE(excluded.redaction_json, automation_runs.redaction_json),
        updated_at = excluded.updated_at
    `);

    const upsertStep = this.db.prepare(`
      INSERT INTO automation_steps (
        step_id,
        run_id,
        session_id,
        step_order,
        trace_id,
        action,
        selector,
        status,
        started_at,
        finished_at,
        duration_ms,
        tab_id,
        target_summary_json,
        redaction_json,
        failure_json,
        input_metadata_json,
        event_type,
        event_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, step_order) DO UPDATE SET
        trace_id = COALESCE(excluded.trace_id, automation_steps.trace_id),
        action = COALESCE(excluded.action, automation_steps.action),
        selector = COALESCE(excluded.selector, automation_steps.selector),
        status = excluded.status,
        started_at = COALESCE(automation_steps.started_at, excluded.started_at),
        finished_at = COALESCE(excluded.finished_at, automation_steps.finished_at),
        duration_ms = COALESCE(excluded.duration_ms, automation_steps.duration_ms),
        tab_id = COALESCE(excluded.tab_id, automation_steps.tab_id),
        target_summary_json = COALESCE(excluded.target_summary_json, automation_steps.target_summary_json),
        redaction_json = COALESCE(excluded.redaction_json, automation_steps.redaction_json),
        failure_json = COALESCE(excluded.failure_json, automation_steps.failure_json),
        input_metadata_json = COALESCE(excluded.input_metadata_json, automation_steps.input_metadata_json),
        event_type = excluded.event_type,
        event_id = COALESCE(excluded.event_id, automation_steps.event_id),
        updated_at = excluded.updated_at
    `);

    upsertRun.run(
      normalized.runId,
      input.sessionId,
      normalized.traceId,
      normalized.action,
      normalized.tabId,
      normalized.selector,
      normalized.status,
      normalized.startedAt,
      normalized.completedAt,
      normalized.stopReason,
      normalized.targetSummaryJson,
      normalized.failureJson,
      normalized.redactionJson,
      normalized.createdAt,
      normalized.updatedAt,
    );

    upsertStep.run(
      normalized.stepId,
      normalized.runId,
      input.sessionId,
      normalized.stepOrder,
      normalized.traceId,
      normalized.action ?? 'unknown',
      normalized.selector,
      normalized.status,
      normalized.startedAt,
      normalized.finishedAt,
      normalized.durationMs,
      normalized.tabId,
      normalized.targetSummaryJson,
      normalized.redactionJson,
      normalized.failureJson,
      normalized.inputMetadataJson,
      input.eventType,
      input.eventId ?? null,
      normalized.createdAt,
      normalized.updatedAt,
    );
  }

  listRuns(sessionId: string): AutomationRunRow[] {
    return this.db.prepare(`
      SELECT *
      FROM automation_runs
      WHERE session_id = ?
      ORDER BY started_at ASC, run_id ASC
    `).all(sessionId) as AutomationRunRow[];
  }

  listSteps(runId: string): AutomationStepRow[] {
    return this.db.prepare(`
      SELECT *
      FROM automation_steps
      WHERE run_id = ?
      ORDER BY step_order ASC, created_at ASC
    `).all(runId) as AutomationStepRow[];
  }
}

function normalizeLifecycleEvent(input: AutomationLifecycleEventInput) {
  const traceId = asNonEmptyString(input.payload.traceId);
  const runId = asNonEmptyString(input.payload.runId)
    ?? (traceId ? `${input.sessionId}:${traceId}` : `${input.sessionId}:event:${input.eventId ?? input.timestamp}`);
  const stepOrder = asInteger(input.payload.stepOrder) ?? 1;
  const action = asNonEmptyString(input.payload.action);
  const startedAt = asInteger(input.payload.startedAt) ?? input.timestamp;
  const finishedAt = asInteger(input.payload.finishedAt);
  const durationMs = asInteger(input.payload.durationMs)
    ?? (finishedAt !== null ? Math.max(0, finishedAt - startedAt) : null);
  const target = asRecord(input.payload.target);
  const selector = asNonEmptyString(input.payload.selector)
    ?? asNonEmptyString(target?.resolvedSelector)
    ?? asNonEmptyString(target?.selector);
  const tabId = asInteger(target?.tabId) ?? input.tabId ?? null;
  const stopReason = asNonEmptyString(input.payload.stopReason)
    ?? asNonEmptyString(asRecord(input.payload.failureReason)?.message);
  const status = resolveStatus(input.eventType, input.payload);
  const completedAt = isTerminalStatus(status) ? (finishedAt ?? input.timestamp) : null;

  return {
    runId,
    stepId: `${runId}:${stepOrder}`,
    stepOrder,
    traceId,
    action,
    tabId,
    selector,
    status,
    startedAt,
    finishedAt: completedAt,
    completedAt,
    durationMs,
    stopReason,
    targetSummaryJson: stringifyJson(target),
    failureJson: stringifyJson(asRecord(input.payload.failureReason)),
    redactionJson: stringifyJson(asRecord(input.payload.redaction)),
    inputMetadataJson: stringifyJson(asRecord(input.payload.input)),
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  };
}

function resolveStatus(eventType: string, payload: Record<string, unknown>): string {
  const payloadStatus = asNonEmptyString(payload.status);
  if (payloadStatus) {
    return payloadStatus;
  }

  switch (eventType) {
    case 'automation_requested':
      return 'requested';
    case 'automation_started':
      return 'started';
    case 'automation_succeeded':
      return 'succeeded';
    case 'automation_failed':
      return 'failed';
    case 'automation_stopped':
      return 'stopped';
    default:
      return 'unknown';
  }
}

function isTerminalStatus(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'rejected' || status === 'stopped';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.floor(value);
}

function stringifyJson(value: Record<string, unknown> | null): string | null {
  return value ? JSON.stringify(value) : null;
}
