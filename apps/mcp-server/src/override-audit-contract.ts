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
  'OVERRIDE_ASSET_FETCH_FAILED',
  'FULFILL_FAILED',
  'DEBUGGER_DETACHED',
  'UNKNOWN',
] as const;

export type OverridePocFailureCode = typeof OVERRIDE_POC_FAILURE_CODES[number];

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
  status: OverridePocRequestStatus;
  failureCode?: OverridePocFailureCode | null;
  errorMessage?: string | null;
  responseCode?: number | null;
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
