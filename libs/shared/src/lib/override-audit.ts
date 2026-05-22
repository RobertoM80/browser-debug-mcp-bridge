export const OVERRIDE_POC_RUN_STATUSES = [
  'active',
  'disabled',
  'failed',
  'completed',
] as const;

export type OverridePocRunStatus = typeof OVERRIDE_POC_RUN_STATUSES[number];

export const OVERRIDE_POC_REQUEST_STATUSES = [
  'matched',
  'fulfilled',
  'failed',
] as const;

export type OverridePocRequestStatus = typeof OVERRIDE_POC_REQUEST_STATUSES[number];

export const OVERRIDE_POC_FAILURE_CODES = [
  'CONFIG_DISABLED',
  'LOCAL_FILE_MISSING',
  'DEBUGGER_ATTACH_FAILED',
  'DEBUGGER_SETUP_FAILED',
  'NETWORK_ENABLE_FAILED',
  'FETCH_ENABLE_FAILED',
  'CACHE_DISABLE_FAILED',
  'SERVICE_WORKER_BYPASS_FAILED',
  'BROWSER_CACHE_CLEAR_FAILED',
  'TAB_RELOAD_FAILED',
  'OVERRIDE_ASSET_FETCH_FAILED',
  'RESPONSE_BODY_READ_FAILED',
  'FULFILL_FAILED',
  'RSC_PATCH_UNSUPPORTED',
  'RSC_CONTENT_TYPE_MISMATCH',
  'RSC_FLIGHT_UNSUPPORTED_RECORD',
  'RSC_FLIGHT_STRUCTURAL_DRIFT',
  'RSC_PATCH_ANCHOR_MISMATCH',
  'RSC_PATCH_UNSAFE',
  'DEBUGGER_DETACHED',
  'UNKNOWN',
] as const;

export type OverridePocFailureCode = typeof OVERRIDE_POC_FAILURE_CODES[number];

export const OVERRIDE_PLAN_AUDIT_KINDS = [
  'response-patch',
  'next-source-overlay',
] as const;

export type OverridePlanAuditKind = typeof OVERRIDE_PLAN_AUDIT_KINDS[number];

export const SSR_MOCK_AUDIT_ACTIONS = [
  'discover',
  'apply-config',
  'remove-config',
] as const;

export type SsrMockAuditAction = typeof SSR_MOCK_AUDIT_ACTIONS[number];

export const SSR_MOCK_AUDIT_STATUSES = [
  'succeeded',
  'no_change',
  'not_mockable',
  'not_found',
] as const;

export type SsrMockAuditStatus = typeof SSR_MOCK_AUDIT_STATUSES[number];

export const MOCK_ROUTE_MODES = [
  'browser',
  'ssr',
  'both',
] as const;

export type MockRouteMode = typeof MOCK_ROUTE_MODES[number];

export const MOCK_ROUTE_MATCH_MODES = [
  'exact',
  'prefix',
] as const;

export type MockRouteMatchMode = typeof MOCK_ROUTE_MATCH_MODES[number];

export const MOCK_ROUTE_BODY_KINDS = [
  'json',
  'text',
  'base64',
  'file',
] as const;

export type MockRouteBodyKind = typeof MOCK_ROUTE_BODY_KINDS[number];

export const MOCK_ROUTE_SOURCE_KINDS = [
  'manual',
  'captured',
  'patched',
] as const;

export type MockRouteSourceKind = typeof MOCK_ROUTE_SOURCE_KINDS[number];

export const MOCK_RUN_STATUSES = [
  'active',
  'completed',
  'failed',
  'stopped',
] as const;

export type MockRunStatus = typeof MOCK_RUN_STATUSES[number];

export interface OverridePocRunRecord {
  runId: string;
  sessionId: string;
  startedAt: number;
  endedAt?: number | null;
  runStatus: OverridePocRunStatus;
  tabId: number;
  selectedTabId?: number | null;
  targetAssetUrl: string;
  localFilePath: string;
  resolvedLocalFilePath: string;
  contentType: string;
  autoReload: boolean;
  configPath: string;
  fileExists: boolean;
  fileSizeBytes?: number | null;
  matchedRequests: number;
  fulfilledRequests: number;
  lastMatchedAt?: number | null;
  lastFulfilledAt?: number | null;
  lastErrorCode?: OverridePocFailureCode | null;
  lastErrorMessage?: string | null;
}

export interface OverridePocRequestRecord {
  requestLogId: string;
  runId: string;
  sessionId: string;
  requestId: string;
  timestamp: number;
  requestUrl: string;
  requestMethod?: string | null;
  status: OverridePocRequestStatus;
  failureCode?: OverridePocFailureCode | null;
  errorMessage?: string | null;
  responseCode?: number | null;
}

export interface OverridePlanAuditRecord {
  planId: string;
  sessionId?: string | null;
  createdAt: number;
  plannerKind: OverridePlanAuditKind;
  toolName: string;
  profileId?: string | null;
  ruleId: string;
  ruleType: string;
  requestMethod: string;
  matchMode: string;
  targetAssetUrl: string;
  localFilePath?: string | null;
  configPath?: string | null;
  contentType: string;
  originalSha256?: string | null;
  patchedSha256?: string | null;
  originalBytes?: number | null;
  patchedBytes?: number | null;
  patchSummary?: unknown;
  preview?: unknown;
  warnings: string[];
  blockers: string[];
  capturedFromLiveSession?: unknown;
  rollback: unknown;
}

export interface SsrMockAuditRecord {
  auditId: string;
  createdAt: number;
  action: SsrMockAuditAction;
  status: SsrMockAuditStatus;
  projectRoot: string;
  targetUrl?: string | null;
  apiHost?: string | null;
  envVarName?: string | null;
  envFilePath?: string | null;
  mockBaseUrl?: string | null;
  rollbackId?: string | null;
  summary?: unknown;
  result?: unknown;
}

export interface MockRouteRecord {
  routeId: string;
  createdAt: number;
  updatedAt: number;
  enabled: boolean;
  mode: MockRouteMode;
  method: string;
  matchMode: MockRouteMatchMode;
  targetUrl: string;
  statusCode: number;
  responseHeaders: Record<string, string>;
  bodyKind: MockRouteBodyKind;
  bodyJson?: unknown;
  bodyText?: string | null;
  bodyBase64?: string | null;
  bodyFilePath?: string | null;
  delayMs: number;
  sourceKind: MockRouteSourceKind;
  sessionScope?: string | null;
  projectRoot?: string | null;
  ttlMs?: number | null;
  expiresAt?: number | null;
}

export interface MockRunRecord {
  runId: string;
  routeId: string;
  executionMode: MockRouteMode;
  sessionId?: string | null;
  tabId?: number | null;
  projectRoot?: string | null;
  startedAt: number;
  endedAt?: number | null;
  status: MockRunStatus;
}

export interface MockHitRecord {
  hitId: string;
  runId?: string | null;
  routeId: string;
  timestamp: number;
  requestUrl: string;
  requestMethod: string;
  matched: boolean;
  fulfilled: boolean;
  statusCode?: number | null;
  responseSource: MockRouteSourceKind;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export function isOverridePocRunStatus(value: unknown): value is OverridePocRunStatus {
  return typeof value === 'string' && (OVERRIDE_POC_RUN_STATUSES as readonly string[]).includes(value);
}

export function isOverridePocRequestStatus(value: unknown): value is OverridePocRequestStatus {
  return typeof value === 'string' && (OVERRIDE_POC_REQUEST_STATUSES as readonly string[]).includes(value);
}

export function isOverridePocFailureCode(value: unknown): value is OverridePocFailureCode {
  return typeof value === 'string' && (OVERRIDE_POC_FAILURE_CODES as readonly string[]).includes(value);
}

export function isOverridePlanAuditKind(value: unknown): value is OverridePlanAuditKind {
  return typeof value === 'string' && (OVERRIDE_PLAN_AUDIT_KINDS as readonly string[]).includes(value);
}

export function isSsrMockAuditAction(value: unknown): value is SsrMockAuditAction {
  return typeof value === 'string' && (SSR_MOCK_AUDIT_ACTIONS as readonly string[]).includes(value);
}

export function isSsrMockAuditStatus(value: unknown): value is SsrMockAuditStatus {
  return typeof value === 'string' && (SSR_MOCK_AUDIT_STATUSES as readonly string[]).includes(value);
}

export function isMockRouteMode(value: unknown): value is MockRouteMode {
  return typeof value === 'string' && (MOCK_ROUTE_MODES as readonly string[]).includes(value);
}

export function isMockRouteMatchMode(value: unknown): value is MockRouteMatchMode {
  return typeof value === 'string' && (MOCK_ROUTE_MATCH_MODES as readonly string[]).includes(value);
}

export function isMockRouteBodyKind(value: unknown): value is MockRouteBodyKind {
  return typeof value === 'string' && (MOCK_ROUTE_BODY_KINDS as readonly string[]).includes(value);
}

export function isMockRouteSourceKind(value: unknown): value is MockRouteSourceKind {
  return typeof value === 'string' && (MOCK_ROUTE_SOURCE_KINDS as readonly string[]).includes(value);
}

export function isMockRunStatus(value: unknown): value is MockRunStatus {
  return typeof value === 'string' && (MOCK_RUN_STATUSES as readonly string[]).includes(value);
}
