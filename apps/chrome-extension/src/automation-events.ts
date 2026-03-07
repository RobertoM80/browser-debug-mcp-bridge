import type { LiveUIActionRequest, LiveUIActionResult } from '../../../libs/mcp-contracts/src';
import { requiresSensitiveAutomationOptIn } from './capture-controls';

export const AUTOMATION_EVENT_TYPES = [
  'automation_requested',
  'automation_started',
  'automation_succeeded',
  'automation_failed',
  'automation_stopped',
] as const;

export type AutomationEventType = typeof AUTOMATION_EVENT_TYPES[number];

interface BuildAutomationEventPayloadOptions {
  eventType: Exclude<AutomationEventType, 'automation_stopped'>;
  request: LiveUIActionRequest;
  startedAt: number;
  result?: LiveUIActionResult;
  tabId?: number;
  url?: string;
  timestamp?: number;
}

interface BuildAutomationStoppedPayloadOptions {
  action?: LiveUIActionRequest['action'];
  traceId?: string;
  sessionId?: string;
  tabId?: number;
  url?: string;
  reason: string;
  timestamp?: number;
}

function resolveSelector(request: LiveUIActionRequest, result?: LiveUIActionResult): string | undefined {
  const target = result?.target;
  return target?.resolvedSelector ?? target?.selector ?? request.target?.selector;
}

function resolveTargetSummary(
  request: LiveUIActionRequest,
  result: LiveUIActionResult | undefined,
  tabId: number | undefined,
  url: string | undefined,
): Record<string, unknown> {
  return {
    matched: result?.target?.matched ?? false,
    selector: request.target?.selector,
    resolvedSelector: result?.target?.resolvedSelector,
    tagName: result?.target?.tagName,
    textPreview: result?.target?.textPreview,
    tabId: result?.target?.tabId ?? tabId,
    frameId: result?.target?.frameId ?? request.target?.frameId ?? 0,
    url: result?.target?.url ?? url ?? request.target?.url,
  };
}

function resolveInputMetadata(
  request: LiveUIActionRequest,
  result: LiveUIActionResult | undefined,
  sensitive: boolean,
): Record<string, unknown> | undefined {
  if (request.action !== 'input') {
    return undefined;
  }

  const resultPayload = result?.result;
  const fieldType = typeof resultPayload?.fieldType === 'string' ? resultPayload.fieldType : undefined;
  const resultValueLength = typeof resultPayload?.valueLength === 'number' ? resultPayload.valueLength : undefined;
  const requestValueLength = typeof request.input?.value === 'string' ? request.input.value.length : undefined;

  return {
    fieldType,
    valueLength: resultValueLength ?? requestValueLength ?? 0,
    sensitive,
  };
}

export function buildAutomationEventPayload(options: BuildAutomationEventPayloadOptions): Record<string, unknown> {
  const now = options.timestamp ?? Date.now();
  const traceId = options.result?.traceId ?? options.request.traceId ?? 'unknown-trace';
  const selector = resolveSelector(options.request, options.result);
  const sensitive = requiresSensitiveAutomationOptIn({
    selector,
    action: options.request.action,
  });
  const finishedAt = options.result?.finishedAt;

  return {
    eventType: options.eventType,
    category: 'automation',
    action: options.request.action,
    status:
      options.eventType === 'automation_requested'
        ? 'requested'
        : options.eventType === 'automation_started'
          ? 'started'
          : options.result?.status ?? 'failed',
    traceId,
    selector,
    startedAt: options.startedAt,
    finishedAt,
    durationMs:
      typeof finishedAt === 'number'
        ? Math.max(0, finishedAt - options.startedAt)
        : Math.max(0, now - options.startedAt),
    timestamp: now,
    target: resolveTargetSummary(options.request, options.result, options.tabId, options.url),
    input:
      resolveInputMetadata(options.request, options.result, sensitive),
    failureReason: options.result?.failureReason,
    redaction: {
      inputValueRedacted: options.request.action === 'input',
      sensitiveTarget: sensitive,
    },
  };
}

export function buildAutomationStoppedPayload(options: BuildAutomationStoppedPayloadOptions): Record<string, unknown> {
  return {
    eventType: 'automation_stopped',
    category: 'automation',
    action: options.action,
    status: 'stopped',
    traceId: options.traceId,
    sessionId: options.sessionId,
    timestamp: options.timestamp ?? Date.now(),
    target: {
      matched: false,
      tabId: options.tabId,
      frameId: 0,
      url: options.url,
    },
    stopReason: options.reason,
  };
}
