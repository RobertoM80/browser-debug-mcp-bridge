export const NETWORK_BLOCKING_RUN_STATUSES = [
  'active',
  'disabled',
  'failed',
] as const;

export type NetworkBlockingRunStatus = typeof NETWORK_BLOCKING_RUN_STATUSES[number];

export const NETWORK_BLOCKING_FAILURE_CODES = [
  'DEBUGGER_ATTACH_FAILED',
  'DEBUGGER_SETUP_FAILED',
  'NETWORK_ENABLE_FAILED',
  'FETCH_ENABLE_FAILED',
  'CACHE_DISABLE_FAILED',
  'SERVICE_WORKER_BYPASS_FAILED',
  'TAB_RELOAD_FAILED',
  'BLOCK_FAILED',
  'DEBUGGER_DETACHED',
  'OVERRIDE_ACTIVE',
  'UNKNOWN',
] as const;

export type NetworkBlockingFailureCode = typeof NETWORK_BLOCKING_FAILURE_CODES[number];

export const NETWORK_BLOCKING_ERROR_REASONS = [
  'BlockedByClient',
  'Failed',
  'Aborted',
  'TimedOut',
] as const;

export type NetworkBlockingErrorReason = typeof NETWORK_BLOCKING_ERROR_REASONS[number];

export const NETWORK_BLOCKING_RESOURCE_TYPES = [
  'document',
  'script',
  'xhr',
  'fetch',
  'image',
  'stylesheet',
  'font',
  'media',
  'websocket',
  'other',
] as const;

export type NetworkBlockingResourceType = typeof NETWORK_BLOCKING_RESOURCE_TYPES[number];

export interface NetworkBlockingRule {
  ruleId: string;
  enabled: boolean;
  exactUrl?: string;
  urlContains?: string;
  urlRegex?: string;
  method?: string;
  resourceTypes?: NetworkBlockingResourceType[];
  errorReason: NetworkBlockingErrorReason;
  note?: string;
}

export interface NetworkBlockingRunRecord {
  runId: string;
  sessionId: string;
  startedAt: number;
  endedAt?: number | null;
  runStatus: NetworkBlockingRunStatus;
  tabId: number;
  selectedTabId?: number | null;
  ruleCount: number;
  blockedRequests: number;
  lastBlockedAt?: number | null;
  lastErrorCode?: NetworkBlockingFailureCode | null;
  lastErrorMessage?: string | null;
  rules: NetworkBlockingRule[];
}

export interface NetworkBlockingRequestRecord {
  requestLogId: string;
  runId: string;
  sessionId: string;
  requestId: string;
  timestamp: number;
  tabId: number;
  frameId?: number | null;
  requestUrl: string;
  requestMethod: string;
  resourceType: NetworkBlockingResourceType;
  ruleId: string;
  errorReason: NetworkBlockingErrorReason;
}

export function isNetworkBlockingRunStatus(value: unknown): value is NetworkBlockingRunStatus {
  return typeof value === 'string' && (NETWORK_BLOCKING_RUN_STATUSES as readonly string[]).includes(value);
}

export function isNetworkBlockingFailureCode(value: unknown): value is NetworkBlockingFailureCode {
  return typeof value === 'string' && (NETWORK_BLOCKING_FAILURE_CODES as readonly string[]).includes(value);
}

export function isNetworkBlockingErrorReason(value: unknown): value is NetworkBlockingErrorReason {
  return typeof value === 'string' && (NETWORK_BLOCKING_ERROR_REASONS as readonly string[]).includes(value);
}

export function isNetworkBlockingResourceType(value: unknown): value is NetworkBlockingResourceType {
  return typeof value === 'string' && (NETWORK_BLOCKING_RESOURCE_TYPES as readonly string[]).includes(value);
}
