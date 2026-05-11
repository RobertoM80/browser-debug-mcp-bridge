import {
  type OverridePocFailureCode,
  type OverridePocRequestRecord,
  type OverridePocRunRecord,
  type OverridePocRunStatus,
} from '../../../libs/shared/src';
import { applyRscFlightTextPatches as applyStructuredRscFlightTextPatches } from './rsc-flight-patch-safety';

interface OverridePocServerRuleConfig {
  ruleId: string;
  enabled: boolean;
  ruleType: 'asset' | 'document' | 'rsc-flight' | 'next-data' | 'api-response';
  requestMethod: string;
  matchMode: 'exact' | 'prefix';
  allowExperimentalRscFlightFulfillment: boolean;
  rscFlight?: OverridePocRscFlightRuleMetadata;
  targetAssetUrl: string;
  localFilePath: string;
  resolvedLocalFilePath: string;
  contentType: string;
  fileExists: boolean;
  fileSizeBytes: number | null;
}

interface OverridePocRscFlightRuleMetadata {
  productionMode: 'literal-response-v1' | 'structured-flight-v1';
  source: 'cdp-response' | 'extension-fetch';
  patchKind: 'literal-text' | 'string-value-text';
  textPatches: Array<{
    search: string;
    replacement: string;
    expectedCount: number;
  }>;
  originalSha256: string;
  patchedSha256: string;
  originalBytes: number;
  patchedBytes: number;
  contentType: string;
  requestHeaders?: Record<string, string>;
}

interface OverridePocServerConfig {
  enabled: boolean;
  activeProfileId?: string;
  profileId?: string;
  profileName?: string;
  rules: OverridePocServerRuleConfig[];
  ruleCount: number;
  enabledRuleCount: number;
  targetAssetUrl: string;
  localFilePath: string;
  resolvedLocalFilePath: string;
  contentType: string;
  autoReload: boolean;
  configPath: string;
  fileExists: boolean;
  fileSizeBytes: number | null;
}

export interface OverridePocStatus {
  active: boolean;
  configuredEnabled: boolean;
  runId?: string;
  sessionId?: string;
  runStatus?: OverridePocRunStatus;
  startedAt?: number;
  endedAt?: number;
  selectedTabId?: number;
  tabId?: number;
  activeProfileId?: string;
  profileId?: string;
  profileName?: string;
  ruleCount?: number;
  enabledRuleCount?: number;
  targetAssetUrl?: string;
  localFilePath?: string;
  resolvedLocalFilePath?: string;
  contentType?: string;
  autoReload?: boolean;
  configPath?: string;
  fileExists?: boolean;
  fileSizeBytes?: number | null;
  matchedRequests: number;
  fulfilledRequests: number;
  lastMatchedAt?: number;
  lastFulfilledAt?: number;
  lastErrorCode?: OverridePocFailureCode;
  lastError?: string;
  auditPendingRequests?: number;
  auditLastError?: string;
  auditLastErrorAt?: number;
}

interface ActiveOverridePocRun extends OverridePocStatus {
  active: true;
  configuredEnabled: true;
  runId: string;
  sessionId: string;
  runStatus: OverridePocRunStatus;
  startedAt: number;
  tabId: number;
  targetAssetUrl: string;
  localFilePath: string;
  resolvedLocalFilePath: string;
  contentType: string;
  autoReload: boolean;
  configPath: string;
  fileExists: boolean;
  rules: OverridePocServerRuleConfig[];
  ruleCount: number;
  enabledRuleCount: number;
}

interface RequestPausedPayload {
  requestId?: string;
  request?: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
  };
  responseStatusCode?: number;
  responseHeaders?: DebuggerHeader[];
}

interface DebuggerHeader {
  name: string;
  value: string;
}

interface FetchGetResponseBodyResult {
  body?: string;
  base64Encoded?: boolean;
}

interface AuditQueueEntry {
  path: string;
  body: unknown;
  attempts: number;
  nextAttemptAt: number;
}

interface PendingRscResponseFulfillment {
  rule: OverridePocServerRuleConfig;
  requestUrl: string;
  requestLogId: string;
  requestHeaders: Record<string, string>;
}

const AUDIT_RETRY_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000] as const;
const MAX_AUDIT_QUEUE_SIZE = 100;

class OverridePocControllerError extends Error {
  readonly code: OverridePocFailureCode;

  constructor(code: OverridePocFailureCode, message: string) {
    super(message);
    this.code = code;
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return bytesToBase64(new Uint8Array(buffer));
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, Math.min(index + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function textToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function decodeFetchResponseBody(result: FetchGetResponseBodyResult): Uint8Array {
  const body = typeof result.body === 'string' ? result.body : '';
  return result.base64Encoded === true ? base64ToBytes(body) : textToBytes(body);
}

function applyConfiguredRscFlightTextPatches(
  body: string,
  patches: OverridePocRscFlightRuleMetadata['textPatches'],
  liveBodyMatchesCapture: boolean,
): string {
  const result = applyStructuredRscFlightTextPatches(body, patches);
  const blocker = result.blockers[0];
  if (blocker) {
    throw new OverridePocControllerError(
      blocker.code === 'RSC_PATCH_ANCHOR_MISMATCH' && !liveBodyMatchesCapture
        ? 'RSC_FLIGHT_STRUCTURAL_DRIFT'
        : blocker.code,
      blocker.message,
    );
  }
  return result.patchedBody;
}

function getDebuggerHeaderValue(headers: DebuggerHeader[] | undefined, name: string): string {
  if (!Array.isArray(headers)) {
    return '';
  }

  const normalizedName = name.toLowerCase();
  const match = headers.find((header) => header.name.toLowerCase() === normalizedName);
  return match?.value ?? '';
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asOverridePocError(error: unknown, fallbackCode: OverridePocFailureCode = 'UNKNOWN'): OverridePocControllerError {
  if (error instanceof OverridePocControllerError) {
    return error;
  }

  return new OverridePocControllerError(fallbackCode, asErrorMessage(error));
}

function createRunId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `override-run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRuleType(value: unknown): OverridePocServerRuleConfig['ruleType'] {
  return value === 'asset'
    || value === 'document'
    || value === 'rsc-flight'
    || value === 'next-data'
    || value === 'api-response'
    ? value
    : 'asset';
}

function normalizeRequestMethod(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().toUpperCase() : 'GET';
}

function normalizeMatchMode(value: unknown): OverridePocServerRuleConfig['matchMode'] {
  return value === 'prefix' ? 'prefix' : 'exact';
}

function parseRscFlightStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const headers: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(value)) {
    if (typeof rawValue === 'string') {
      headers[name.toLowerCase()] = rawValue;
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function parseRscFlightTextPatches(value: unknown): OverridePocRscFlightRuleMetadata['textPatches'] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const patches: OverridePocRscFlightRuleMetadata['textPatches'] = [];
  for (const entry of value) {
    if (
      !isRecord(entry)
      || typeof entry.search !== 'string'
      || entry.search.length === 0
      || typeof entry.replacement !== 'string'
      || typeof entry.expectedCount !== 'number'
      || !Number.isFinite(entry.expectedCount)
      || entry.expectedCount < 0
    ) {
      return undefined;
    }
    patches.push({
      search: entry.search,
      replacement: entry.replacement,
      expectedCount: Math.floor(entry.expectedCount),
    });
  }
  return patches;
}

function isSupportedRscFlightPatchMode(value: { productionMode?: unknown; patchKind?: unknown }): boolean {
  return (
    value.productionMode === 'structured-flight-v1'
    && value.patchKind === 'string-value-text'
  ) || (
    value.productionMode === 'literal-response-v1'
    && value.patchKind === 'literal-text'
  );
}

function parseRscFlightRuleMetadata(value: unknown): OverridePocRscFlightRuleMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const textPatches = parseRscFlightTextPatches(value.textPatches);
  const productionMode = value.productionMode;
  const patchKind = value.patchKind;
  if (
    !isSupportedRscFlightPatchMode(value)
    || value.source !== 'cdp-response' && value.source !== 'extension-fetch'
    || !textPatches
    || typeof value.originalSha256 !== 'string'
    || typeof value.patchedSha256 !== 'string'
    || typeof value.originalBytes !== 'number'
    || typeof value.patchedBytes !== 'number'
    || typeof value.contentType !== 'string'
  ) {
    return undefined;
  }

  return {
    productionMode: productionMode as OverridePocRscFlightRuleMetadata['productionMode'],
    source: value.source,
    patchKind: patchKind as OverridePocRscFlightRuleMetadata['patchKind'],
    textPatches,
    originalSha256: value.originalSha256,
    patchedSha256: value.patchedSha256,
    originalBytes: Math.floor(value.originalBytes),
    patchedBytes: Math.floor(value.patchedBytes),
    contentType: value.contentType,
    requestHeaders: parseRscFlightStringRecord(value.requestHeaders),
  };
}

function doesRuleMatchRequestUrl(rule: Pick<OverridePocServerRuleConfig, 'matchMode' | 'targetAssetUrl'>, requestUrl: string): boolean {
  if (rule.matchMode === 'prefix') {
    return requestUrl.startsWith(rule.targetAssetUrl);
  }

  return requestUrl === rule.targetAssetUrl;
}

function isProductionRscFlightRule(rule: OverridePocServerRuleConfig): boolean {
  return rule.ruleType === 'rsc-flight'
    && rule.rscFlight !== undefined
    && isSupportedRscFlightPatchMode(rule.rscFlight);
}

function toFetchUrlPattern(rule: Pick<OverridePocServerRuleConfig, 'matchMode' | 'targetAssetUrl'>): string {
  return rule.matchMode === 'prefix' ? `${rule.targetAssetUrl}*` : rule.targetAssetUrl;
}

function normalizeRequestHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (!headers) {
    return normalized;
  }

  for (const [name, value] of Object.entries(headers)) {
    normalized[name.toLowerCase()] = value;
  }
  return normalized;
}

function findRscContextMismatch(rule: OverridePocServerRuleConfig, requestHeaders: Record<string, string> | undefined): string | undefined {
  const expectedHeaders = rule.rscFlight?.requestHeaders;
  if (!expectedHeaders || Object.keys(expectedHeaders).length === 0) {
    return undefined;
  }

  const actualHeaders = normalizeRequestHeaders(requestHeaders);
  for (const [name, expectedValue] of Object.entries(expectedHeaders)) {
    if (actualHeaders[name] !== expectedValue) {
      return `RSC request header "${name}" did not match the captured override context.`;
    }
  }
  return undefined;
}

function isMetadataOnlyRscStateTree(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  if (value.includes('metadata-only')) {
    return true;
  }
  try {
    return decodeURIComponent(value).includes('metadata-only');
  } catch {
    return false;
  }
}

function isRscVariantAllowedToPassThrough(headers: Record<string, string> | undefined): boolean {
  if (!headers) {
    return false;
  }

  return headers['next-router-prefetch'] === '1'
    || headers.purpose?.toLowerCase() === 'prefetch'
    || typeof headers['next-router-segment-prefetch'] === 'string'
    || isMetadataOnlyRscStateTree(headers['next-router-state-tree']);
}

function parseOverridePocConfig(value: unknown): OverridePocServerConfig {
  if (!isRecord(value)) {
    throw new Error('Override POC config response must be an object');
  }

  const requiredString = (fieldName: keyof OverridePocServerConfig): string => {
    const fieldValue = value[fieldName];
    if (typeof fieldValue !== 'string' || fieldValue.trim().length === 0) {
      throw new Error(`Override POC config field "${String(fieldName)}" is missing`);
    }
    return fieldValue.trim();
  };

  const requiredBoolean = (fieldName: keyof OverridePocServerConfig): boolean => {
    const fieldValue = value[fieldName];
    if (typeof fieldValue !== 'boolean') {
      throw new Error(`Override POC config field "${String(fieldName)}" must be a boolean`);
    }
    return fieldValue;
  };

  const fileSizeBytesValue = value.fileSizeBytes;
  if (fileSizeBytesValue !== null && (typeof fileSizeBytesValue !== 'number' || !Number.isFinite(fileSizeBytesValue))) {
    throw new Error('Override POC config field "fileSizeBytes" must be a finite number or null');
  }

  const parseRule = (entry: unknown, index: number): OverridePocServerRuleConfig => {
    if (!isRecord(entry)) {
      throw new Error(`Override POC config rule at index ${index} must be an object`);
    }

    const ruleFileSizeBytes = entry.fileSizeBytes;
    if (ruleFileSizeBytes !== null && (typeof ruleFileSizeBytes !== 'number' || !Number.isFinite(ruleFileSizeBytes))) {
      throw new Error(`Override POC config rule at index ${index} field "fileSizeBytes" must be a finite number or null`);
    }

    const requiredRuleString = (fieldName: keyof OverridePocServerRuleConfig): string => {
      const fieldValue = entry[fieldName];
      if (typeof fieldValue !== 'string' || fieldValue.trim().length === 0) {
        throw new Error(`Override POC config rule at index ${index} field "${String(fieldName)}" is missing`);
      }
      return fieldValue.trim();
    };

    const enabledValue = entry.enabled;
    const fileExistsValue = entry.fileExists;
    if (typeof enabledValue !== 'boolean') {
      throw new Error(`Override POC config rule at index ${index} field "enabled" must be a boolean`);
    }
    if (typeof fileExistsValue !== 'boolean') {
      throw new Error(`Override POC config rule at index ${index} field "fileExists" must be a boolean`);
    }

    return {
      ruleId: requiredRuleString('ruleId'),
      enabled: enabledValue,
      ruleType: normalizeRuleType(entry.ruleType),
      requestMethod: normalizeRequestMethod(entry.requestMethod),
      matchMode: normalizeMatchMode(entry.matchMode),
      allowExperimentalRscFlightFulfillment: entry.allowExperimentalRscFlightFulfillment === true,
      rscFlight: parseRscFlightRuleMetadata(entry.rscFlight),
      targetAssetUrl: requiredRuleString('targetAssetUrl'),
      localFilePath: requiredRuleString('localFilePath'),
      resolvedLocalFilePath: requiredRuleString('resolvedLocalFilePath'),
      contentType: requiredRuleString('contentType'),
      fileExists: fileExistsValue,
      fileSizeBytes: ruleFileSizeBytes === null ? null : Math.floor(ruleFileSizeBytes),
    };
  };

  const rules = Array.isArray(value.rules)
    ? value.rules.map(parseRule)
    : [{
      ruleId: 'default',
      enabled: true,
      ruleType: normalizeRuleType(value.ruleType),
      requestMethod: normalizeRequestMethod(value.requestMethod),
      matchMode: normalizeMatchMode(value.matchMode),
      allowExperimentalRscFlightFulfillment: value.allowExperimentalRscFlightFulfillment === true,
      rscFlight: parseRscFlightRuleMetadata(value.rscFlight),
      targetAssetUrl: requiredString('targetAssetUrl'),
      localFilePath: requiredString('localFilePath'),
      resolvedLocalFilePath: requiredString('resolvedLocalFilePath'),
      contentType: requiredString('contentType'),
      fileExists: requiredBoolean('fileExists'),
      fileSizeBytes: fileSizeBytesValue === null ? null : Math.floor(fileSizeBytesValue),
    }];

  if (rules.length === 0) {
    throw new Error('Override POC config must define at least one rule');
  }

  return {
    enabled: requiredBoolean('enabled'),
    activeProfileId: typeof value.activeProfileId === 'string' ? value.activeProfileId.trim() : undefined,
    profileId: typeof value.profileId === 'string' ? value.profileId.trim() : undefined,
    profileName: typeof value.profileName === 'string' ? value.profileName.trim() : undefined,
    rules,
    ruleCount: typeof value.ruleCount === 'number' && Number.isFinite(value.ruleCount)
      ? Math.floor(value.ruleCount)
      : rules.length,
    enabledRuleCount: typeof value.enabledRuleCount === 'number' && Number.isFinite(value.enabledRuleCount)
      ? Math.floor(value.enabledRuleCount)
      : rules.filter((rule) => rule.enabled).length,
    targetAssetUrl: requiredString('targetAssetUrl'),
    localFilePath: requiredString('localFilePath'),
    resolvedLocalFilePath: requiredString('resolvedLocalFilePath'),
    contentType: requiredString('contentType'),
    autoReload: requiredBoolean('autoReload'),
    configPath: requiredString('configPath'),
    fileExists: requiredBoolean('fileExists'),
    fileSizeBytes: fileSizeBytesValue === null ? null : Math.floor(fileSizeBytesValue),
  };
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON response but received: ${text.slice(0, 200)}`);
  }
}

async function attachDebugger(source: chrome.debugger.Debuggee): Promise<void> {
  await chrome.debugger.attach(source, '1.3');
}

async function detachDebugger(source: chrome.debugger.Debuggee): Promise<void> {
  await chrome.debugger.detach(source);
}

async function sendDebuggerCommand<T = unknown>(
  source: chrome.debugger.Debuggee,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const result = await chrome.debugger.sendCommand(source, method, params);
  return result as T;
}

async function sendRequiredDebuggerCommand<T = unknown>(
  source: chrome.debugger.Debuggee,
  method: string,
  failureCode: OverridePocFailureCode,
  params?: Record<string, unknown>,
): Promise<T> {
  try {
    return await sendDebuggerCommand<T>(source, method, params);
  } catch (error) {
    throw new OverridePocControllerError(failureCode, `${method} failed: ${asErrorMessage(error)}`);
  }
}

async function reloadTab(tabId: number, bypassCache: boolean): Promise<void> {
  await chrome.tabs.reload(tabId, { bypassCache });
}

export class OverridePocController {
  private serverBaseUrl: string;
  private activeRun: ActiveOverridePocRun | null = null;
  private expectedDetachTabId: number | null = null;
  private auditQueue: AuditQueueEntry[] = [];
  private auditFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private auditLastError: string | undefined;
  private auditLastErrorAt: number | undefined;
  private pendingRscResponseFulfillments = new Map<string, PendingRscResponseFulfillment>();
  private skippedRscResponseRequests = new Set<string>();

  constructor(serverBaseUrl: string) {
    this.serverBaseUrl = serverBaseUrl;

    chrome.debugger.onEvent.addListener((source, method, params) => {
      void this.handleDebuggerEvent(source, method, params).catch((error) => {
        this.recordError(asErrorMessage(error));
      });
    });

    chrome.debugger.onDetach.addListener((source, reason) => {
      this.handleDebuggerDetach(source, reason);
    });
  }

  setServerBaseUrl(serverBaseUrl: string): void {
    const trimmed = serverBaseUrl.trim();
    if (!trimmed || trimmed === this.serverBaseUrl) {
      return;
    }

    this.serverBaseUrl = trimmed;
  }

  getActiveTabId(): number | undefined {
    return this.activeRun?.tabId;
  }

  isActiveForTab(tabId: number): boolean {
    return this.activeRun?.tabId === tabId;
  }

  async getStatus(): Promise<OverridePocStatus> {
    this.scheduleAuditFlush(0);

    try {
      const config = await this.fetchConfig();
      return this.composeStatus(config);
    } catch (error) {
      const fallback = this.activeRun;
      return {
        active: fallback !== null,
        configuredEnabled: fallback?.configuredEnabled ?? false,
        runId: fallback?.runId,
        sessionId: fallback?.sessionId,
        runStatus: fallback?.runStatus,
        startedAt: fallback?.startedAt,
        endedAt: fallback?.endedAt,
        tabId: fallback?.tabId,
        activeProfileId: fallback?.activeProfileId,
        profileId: fallback?.profileId,
        profileName: fallback?.profileName,
        ruleCount: fallback?.ruleCount,
        enabledRuleCount: fallback?.enabledRuleCount,
        targetAssetUrl: fallback?.targetAssetUrl,
        localFilePath: fallback?.localFilePath,
        resolvedLocalFilePath: fallback?.resolvedLocalFilePath,
        contentType: fallback?.contentType,
        autoReload: fallback?.autoReload,
        configPath: fallback?.configPath,
        fileExists: fallback?.fileExists,
        fileSizeBytes: fallback?.fileSizeBytes,
        matchedRequests: fallback?.matchedRequests ?? 0,
        fulfilledRequests: fallback?.fulfilledRequests ?? 0,
        lastMatchedAt: fallback?.lastMatchedAt,
        lastFulfilledAt: fallback?.lastFulfilledAt,
        lastErrorCode: fallback?.lastErrorCode,
        lastError: asErrorMessage(error),
        ...this.getAuditStatusFields(),
      };
    }
  }

  async enableForTab(options: { sessionId: string; tabId: number; selectedTabId?: number }): Promise<OverridePocStatus> {
    const runId = createRunId();
    const startedAt = Date.now();
    const { sessionId, tabId, selectedTabId } = options;
    const config = await this.fetchConfig();
    if (!config.enabled) {
      const failure = new OverridePocControllerError('CONFIG_DISABLED', `Override POC is disabled in ${config.configPath}`);
      await this.persistTerminalRun({
        runId,
        sessionId,
        startedAt,
        tabId,
        selectedTabId,
        config,
        failure,
      });
      throw failure;
    }
    if (!config.fileExists) {
      const failure = new OverridePocControllerError('LOCAL_FILE_MISSING', `Configured local file does not exist: ${config.resolvedLocalFilePath}`);
      await this.persistTerminalRun({
        runId,
        sessionId,
        startedAt,
        tabId,
        selectedTabId,
        config,
        failure,
      });
      throw failure;
    }

    if (this.activeRun) {
      await this.disable();
    }

    const source: chrome.debugger.Debuggee = { tabId };

    try {
      try {
        await attachDebugger(source);
      } catch (error) {
        throw new OverridePocControllerError('DEBUGGER_ATTACH_FAILED', asErrorMessage(error));
      }

      await sendRequiredDebuggerCommand(source, 'Network.enable', 'NETWORK_ENABLE_FAILED');
      await sendRequiredDebuggerCommand(source, 'Fetch.enable', 'FETCH_ENABLE_FAILED', {
        patterns: this.buildFetchPatterns(config.rules),
      });
      await sendRequiredDebuggerCommand(source, 'Network.setCacheDisabled', 'CACHE_DISABLE_FAILED', { cacheDisabled: true });
      await sendRequiredDebuggerCommand(source, 'Network.setBypassServiceWorker', 'SERVICE_WORKER_BYPASS_FAILED', { bypass: true });
      await sendRequiredDebuggerCommand(source, 'Network.clearBrowserCache', 'BROWSER_CACHE_CLEAR_FAILED');

      this.pendingRscResponseFulfillments.clear();
      this.skippedRscResponseRequests.clear();
      this.activeRun = {
        active: true,
        configuredEnabled: true,
        runId,
        sessionId,
        runStatus: 'active',
        startedAt,
        selectedTabId,
        tabId,
        targetAssetUrl: config.targetAssetUrl,
        localFilePath: config.localFilePath,
        resolvedLocalFilePath: config.resolvedLocalFilePath,
        contentType: config.contentType,
        autoReload: config.autoReload,
        configPath: config.configPath,
        fileExists: config.fileExists,
        activeProfileId: config.activeProfileId,
        profileId: config.profileId,
        profileName: config.profileName,
        rules: config.rules,
        ruleCount: config.ruleCount,
        enabledRuleCount: config.enabledRuleCount,
        fileSizeBytes: config.fileSizeBytes,
        matchedRequests: 0,
        fulfilledRequests: 0,
      };

      await this.persistRun(this.activeRun);

      console.info('[mcpdbg][override-poc] debugger attached', {
        tabId,
        targetAssetUrl: config.targetAssetUrl,
        localFilePath: config.resolvedLocalFilePath,
      });

      if (config.autoReload) {
        try {
          await reloadTab(tabId, true);
        } catch (error) {
          throw new OverridePocControllerError('TAB_RELOAD_FAILED', asErrorMessage(error));
        }
      }

      return this.composeStatus(config);
    } catch (error) {
      const failure = asOverridePocError(error, 'DEBUGGER_SETUP_FAILED');
      this.recordError(failure.message, failure.code);

      await sendDebuggerCommand(source, 'Fetch.disable').catch(() => undefined);
      await sendDebuggerCommand(source, 'Network.setCacheDisabled', { cacheDisabled: false }).catch(() => undefined);
      await sendDebuggerCommand(source, 'Network.setBypassServiceWorker', { bypass: false }).catch(() => undefined);
      this.expectedDetachTabId = tabId;
      try {
        await detachDebugger(source);
      } catch {
        // Ignore cleanup errors after a failed attach/setup flow.
      }

      await this.persistTerminalRun({
        runId,
        sessionId,
        startedAt,
        tabId,
        selectedTabId,
        config,
        failure,
      });
      this.activeRun = null;
      this.pendingRscResponseFulfillments.clear();
      this.skippedRscResponseRequests.clear();
      throw failure;
    }
  }

  async disable(): Promise<OverridePocStatus> {
    const previousRun = this.activeRun;
    if (!previousRun) {
      return this.getStatus();
    }

    const source: chrome.debugger.Debuggee = { tabId: previousRun.tabId };
    this.expectedDetachTabId = previousRun.tabId;

    try {
      await sendDebuggerCommand(source, 'Fetch.disable').catch(() => undefined);
      await sendDebuggerCommand(source, 'Network.setCacheDisabled', { cacheDisabled: false }).catch(() => undefined);
      await sendDebuggerCommand(source, 'Network.setBypassServiceWorker', { bypass: false }).catch(() => undefined);
      await detachDebugger(source).catch(() => undefined);

      console.info('[mcpdbg][override-poc] debugger detached', {
        tabId: previousRun.tabId,
      });
    } finally {
      this.activeRun = null;
      this.pendingRscResponseFulfillments.clear();
      this.skippedRscResponseRequests.clear();
      await this.persistRun({
        ...previousRun,
        endedAt: Date.now(),
        runStatus: previousRun.lastErrorCode ? 'failed' : 'disabled',
      });
    }

    return this.getStatus();
  }

  private composeStatus(config: OverridePocServerConfig): OverridePocStatus {
    return {
      active: this.activeRun !== null,
      configuredEnabled: config.enabled,
      runId: this.activeRun?.runId,
      sessionId: this.activeRun?.sessionId,
      runStatus: this.activeRun?.runStatus,
      startedAt: this.activeRun?.startedAt,
      endedAt: this.activeRun?.endedAt,
      selectedTabId: this.activeRun?.selectedTabId,
      tabId: this.activeRun?.tabId,
      activeProfileId: config.activeProfileId,
      profileId: config.profileId,
      profileName: config.profileName,
      ruleCount: config.ruleCount,
      enabledRuleCount: config.enabledRuleCount,
      targetAssetUrl: config.targetAssetUrl,
      localFilePath: config.localFilePath,
      resolvedLocalFilePath: config.resolvedLocalFilePath,
      contentType: config.contentType,
      autoReload: config.autoReload,
      configPath: config.configPath,
      fileExists: config.fileExists,
      fileSizeBytes: config.fileSizeBytes,
      matchedRequests: this.activeRun?.matchedRequests ?? 0,
      fulfilledRequests: this.activeRun?.fulfilledRequests ?? 0,
      lastMatchedAt: this.activeRun?.lastMatchedAt,
      lastFulfilledAt: this.activeRun?.lastFulfilledAt,
      lastErrorCode: this.activeRun?.lastErrorCode,
      lastError: this.activeRun?.lastError,
      ...this.getAuditStatusFields(),
    };
  }

  private getAuditStatusFields(): Pick<OverridePocStatus, 'auditPendingRequests' | 'auditLastError' | 'auditLastErrorAt'> {
    return {
      auditPendingRequests: this.auditQueue.length,
      auditLastError: this.auditLastError,
      auditLastErrorAt: this.auditLastErrorAt,
    };
  }

  private async fetchConfig(): Promise<OverridePocServerConfig> {
    const response = await fetch(`${this.serverBaseUrl}/overrides/poc/config`, {
      cache: 'no-store',
    });
    const payload = await readJsonResponse(response);
    if (!response.ok) {
      const errorMessage = isRecord(payload) && typeof payload.error === 'string'
        ? payload.error
        : `Override POC config request failed with ${response.status}`;
      throw new Error(errorMessage);
    }

    if (!isRecord(payload) || payload.ok !== true) {
      throw new Error('Override POC config endpoint returned an invalid payload');
    }

    return parseOverridePocConfig(payload);
  }

  private buildFetchPatterns(rules: OverridePocServerRuleConfig[]): Array<{ urlPattern: string; requestStage: 'Request' | 'Response' }> {
    const patterns: Array<{ urlPattern: string; requestStage: 'Request' | 'Response' }> = [
      { urlPattern: '*', requestStage: 'Request' },
    ];

    for (const rule of rules) {
      if (rule.enabled && isProductionRscFlightRule(rule)) {
        patterns.push({
          urlPattern: toFetchUrlPattern(rule),
          requestStage: 'Response',
        });
      }
    }

    return patterns;
  }

  private async fetchOverrideBody(rule: Pick<OverridePocServerRuleConfig, 'targetAssetUrl' | 'requestMethod'>): Promise<{
    bodyBase64: string;
    responseHeaders: DebuggerHeader[];
  }> {
    const response = await fetch(
      `${this.serverBaseUrl}/overrides/poc/asset?assetUrl=${encodeURIComponent(rule.targetAssetUrl)}&requestMethod=${encodeURIComponent(rule.requestMethod)}`,
      {
        cache: 'no-store',
      },
    );

    if (!response.ok) {
      const payload = await readJsonResponse(response).catch(() => ({}));
      const errorMessage = isRecord(payload) && typeof payload.error === 'string'
        ? payload.error
        : `Override asset request failed with ${response.status}`;
      throw new Error(errorMessage);
    }

    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get('Content-Type') ?? 'application/javascript; charset=utf-8';
    const responseHeaders: DebuggerHeader[] = [
      { name: 'Content-Type', value: contentType },
      { name: 'Cache-Control', value: 'no-store, no-cache, must-revalidate' },
      { name: 'X-BDMCP-Override-Poc', value: '1' },
    ];
    if (!contentType.toLowerCase().includes('text/x-component')) {
      responseHeaders.push({ name: 'Content-Length', value: String(buffer.byteLength) });
    }

    return {
      bodyBase64: arrayBufferToBase64(buffer),
      responseHeaders,
    };
  }

  private recordMatchedRequest(
    activeRun: ActiveOverridePocRun,
    requestId: string,
    requestUrl: string,
    rule: OverridePocServerRuleConfig,
  ): string {
    activeRun.matchedRequests += 1;
    activeRun.lastMatchedAt = Date.now();
    const requestLogId = `${activeRun.runId}:${requestId}`;
    void this.persistRequest({
      requestLogId,
      runId: activeRun.runId,
      sessionId: activeRun.sessionId,
      requestId,
      timestamp: activeRun.lastMatchedAt,
      requestUrl,
      status: 'matched',
    });
    void this.persistRun(activeRun);
    console.info('[mcpdbg][override-poc] matched request', {
      tabId: activeRun.tabId,
      ruleId: rule.ruleId,
      ruleType: rule.ruleType,
      requestMethod: rule.requestMethod,
      requestUrl,
      matchedRequests: activeRun.matchedRequests,
    });
    return requestLogId;
  }

  private recordFailedRequest(
    activeRun: ActiveOverridePocRun,
    requestLogId: string,
    requestId: string,
    requestUrl: string,
    failure: OverridePocControllerError,
  ): void {
    this.recordError(failure.message, failure.code);
    void this.persistRequest({
      requestLogId,
      runId: activeRun.runId,
      sessionId: activeRun.sessionId,
      requestId,
      timestamp: Date.now(),
      requestUrl,
      status: 'failed',
      failureCode: failure.code,
      errorMessage: failure.message,
    });
    void this.persistRun(activeRun);
  }

  private recordFulfilledRequest(
    activeRun: ActiveOverridePocRun,
    requestLogId: string,
    requestId: string,
    requestUrl: string,
    responseCode: number,
  ): void {
    activeRun.fulfilledRequests += 1;
    activeRun.lastFulfilledAt = Date.now();
    delete activeRun.lastError;
    delete activeRun.lastErrorCode;
    void this.persistRequest({
      requestLogId,
      runId: activeRun.runId,
      sessionId: activeRun.sessionId,
      requestId,
      timestamp: activeRun.lastFulfilledAt,
      requestUrl,
      status: 'fulfilled',
      responseCode,
    });
    void this.persistRun(activeRun);
  }

  private findEnabledRule(requestUrl: string, requestMethod: string): OverridePocServerRuleConfig | undefined {
    const activeRun = this.activeRun;
    return activeRun?.rules.find((rule) => {
      return rule.enabled
        && doesRuleMatchRequestUrl(rule, requestUrl)
        && normalizeRequestMethod(rule.requestMethod) === requestMethod;
    });
  }

  private async handleRscResponseStagePaused(
    activeRun: ActiveOverridePocRun,
    debuggee: chrome.debugger.Debuggee,
    requestId: string,
    requestUrl: string,
    requestMethod: string,
    payload: RequestPausedPayload,
  ): Promise<void> {
    if (this.skippedRscResponseRequests.delete(requestId)) {
      await sendDebuggerCommand(debuggee, 'Fetch.continueRequest', { requestId });
      return;
    }

    const pending = this.pendingRscResponseFulfillments.get(requestId);
    const matchedRule = pending?.rule ?? this.findEnabledRule(requestUrl, requestMethod);
    if (!matchedRule || !isProductionRscFlightRule(matchedRule)) {
      await sendDebuggerCommand(debuggee, 'Fetch.continueRequest', { requestId });
      return;
    }

    const requestLogId = pending?.requestLogId ?? this.recordMatchedRequest(activeRun, requestId, requestUrl, matchedRule);
    this.pendingRscResponseFulfillments.delete(requestId);

    try {
      const contentType = getDebuggerHeaderValue(payload.responseHeaders, 'content-type');
      if (!contentType.toLowerCase().includes('text/x-component')) {
        throw new OverridePocControllerError('RSC_CONTENT_TYPE_MISMATCH', 'RSC response content type no longer matches text/x-component.');
      }

      let originalBody: FetchGetResponseBodyResult;
      try {
        originalBody = await sendDebuggerCommand<FetchGetResponseBodyResult>(
          debuggee,
          'Fetch.getResponseBody',
          { requestId },
        );
      } catch (error) {
        throw new OverridePocControllerError('RESPONSE_BODY_READ_FAILED', asErrorMessage(error));
      }
      const originalBytes = decodeFetchResponseBody(originalBody);
      const originalSha256 = await sha256Hex(originalBytes);
      const originalText = new TextDecoder().decode(originalBytes);
      let patchedText: string;
      try {
        patchedText = applyConfiguredRscFlightTextPatches(
          originalText,
          matchedRule.rscFlight?.textPatches ?? [],
          originalSha256 === matchedRule.rscFlight?.originalSha256,
        );
      } catch (error) {
        const failure = asOverridePocError(error, 'FULFILL_FAILED');
        if (isRscVariantAllowedToPassThrough(pending?.requestHeaders)) {
          console.info('[mcpdbg][override-poc] RSC response variant did not contain captured patch anchors; continuing request', {
            tabId: activeRun.tabId,
            ruleId: matchedRule.ruleId,
            requestUrl,
            reason: failure.message,
          });
          await sendDebuggerCommand(debuggee, 'Fetch.continueRequest', { requestId });
          return;
        }
        throw failure;
      }
      const patchedBytes = textToBytes(patchedText);
      const patchedSha256 = await sha256Hex(patchedBytes);
      const responseHeaders: DebuggerHeader[] = [
        { name: 'Content-Type', value: matchedRule.contentType },
        { name: 'Cache-Control', value: 'no-store, no-cache, must-revalidate' },
        { name: 'X-BDMCP-Override-Poc', value: '1' },
        { name: 'X-BDMCP-RSC-Live-Patch', value: originalSha256 === matchedRule.rscFlight?.originalSha256 ? 'captured-hash' : 'live-drift' },
        { name: 'X-BDMCP-RSC-Patched-Sha256', value: patchedSha256 },
      ];
      const responseCode = typeof payload.responseStatusCode === 'number' ? payload.responseStatusCode : 200;
      await sendDebuggerCommand(debuggee, 'Fetch.fulfillRequest', {
        requestId,
        responseCode,
        responsePhrase: responseCode === 200 ? 'OK' : undefined,
        responseHeaders,
        body: bytesToBase64(patchedBytes),
      });
      this.recordFulfilledRequest(activeRun, requestLogId, requestId, requestUrl, responseCode);

      console.info('[mcpdbg][override-poc] fulfilled RSC response-stage request', {
        tabId: activeRun.tabId,
        ruleId: matchedRule.ruleId,
        requestUrl,
        fulfilledRequests: activeRun.fulfilledRequests,
      });
    } catch (error) {
      const failure = asOverridePocError(error, 'FULFILL_FAILED');
      this.recordFailedRequest(activeRun, requestLogId, requestId, requestUrl, failure);
      console.warn('[mcpdbg][override-poc] RSC response-stage fulfillment skipped', {
        tabId: activeRun.tabId,
        ruleId: matchedRule.ruleId,
        requestUrl,
        error: failure.message,
      });
      await sendDebuggerCommand(debuggee, 'Fetch.continueRequest', { requestId }).catch(() => undefined);
    }
  }

  private async handleDebuggerEvent(
    source: chrome.debugger.Debuggee,
    method: string,
    params: unknown,
  ): Promise<void> {
    const activeRun = this.activeRun;
    if (!activeRun || method !== 'Fetch.requestPaused' || source.tabId !== activeRun.tabId) {
      return;
    }

    const payload = params as RequestPausedPayload | undefined;
    const requestId = payload?.requestId;
    const requestUrl = payload?.request?.url;
    const requestMethod = normalizeRequestMethod(payload?.request?.method);
    if (typeof requestId !== 'string' || typeof requestUrl !== 'string') {
      return;
    }

    const debuggee: chrome.debugger.Debuggee = { tabId: activeRun.tabId };
    const isResponseStage = typeof payload?.responseStatusCode === 'number' || Array.isArray(payload?.responseHeaders);
    if (isResponseStage) {
      await this.handleRscResponseStagePaused(activeRun, debuggee, requestId, requestUrl, requestMethod, payload ?? {});
      return;
    }

    const matchedRule = this.findEnabledRule(requestUrl, requestMethod);
    if (!matchedRule) {
      await sendDebuggerCommand(debuggee, 'Fetch.continueRequest', { requestId });
      return;
    }

    const requestLogId = this.recordMatchedRequest(activeRun, requestId, requestUrl, matchedRule);

    try {
      if (isProductionRscFlightRule(matchedRule)) {
        const mismatch = findRscContextMismatch(matchedRule, payload?.request?.headers);
        if (mismatch) {
          this.skippedRscResponseRequests.add(requestId);
          console.info('[mcpdbg][override-poc] RSC request context did not match captured patch context; continuing request', {
            tabId: activeRun.tabId,
            ruleId: matchedRule.ruleId,
            requestUrl,
            reason: mismatch,
          });
          await sendDebuggerCommand(debuggee, 'Fetch.continueRequest', { requestId });
          return;
        }

        this.pendingRscResponseFulfillments.set(requestId, {
          rule: matchedRule,
          requestUrl,
          requestLogId,
          requestHeaders: normalizeRequestHeaders(payload?.request?.headers),
        });
        await sendDebuggerCommand(debuggee, 'Fetch.continueRequest', { requestId });
        return;
      }

      if (matchedRule.ruleType === 'rsc-flight' && !matchedRule.allowExperimentalRscFlightFulfillment) {
        const message = 'RSC flight response fulfillment is not supported until Next.js Flight stream replay is implemented.';
        this.recordFailedRequest(
          activeRun,
          requestLogId,
          requestId,
          requestUrl,
          new OverridePocControllerError('RSC_PATCH_UNSUPPORTED', message),
        );
        console.warn('[mcpdbg][override-poc] unsupported RSC flight override skipped', {
          tabId: activeRun.tabId,
          ruleId: matchedRule.ruleId,
          requestUrl,
        });
        await sendDebuggerCommand(debuggee, 'Fetch.continueRequest', { requestId });
        return;
      }

      let overrideBody: Awaited<ReturnType<OverridePocController['fetchOverrideBody']>>;
      try {
        overrideBody = await this.fetchOverrideBody(matchedRule);
      } catch (error) {
        const failure = asOverridePocError(error, 'OVERRIDE_ASSET_FETCH_FAILED');
        this.recordFailedRequest(activeRun, requestLogId, requestId, requestUrl, failure);
        throw failure;
      }

      await sendDebuggerCommand(debuggee, 'Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responsePhrase: 'OK',
        responseHeaders: overrideBody.responseHeaders,
        body: overrideBody.bodyBase64,
      });
      this.recordFulfilledRequest(activeRun, requestLogId, requestId, requestUrl, 200);

      console.info('[mcpdbg][override-poc] fulfilled request', {
        tabId: activeRun.tabId,
        ruleId: matchedRule.ruleId,
        ruleType: matchedRule.ruleType,
        requestMethod: matchedRule.requestMethod,
        requestUrl,
        fulfilledRequests: activeRun.fulfilledRequests,
      });
    } catch (error) {
      const failure = asOverridePocError(error, 'FULFILL_FAILED');
      this.recordFailedRequest(activeRun, requestLogId, requestId, requestUrl, failure);
      console.error('[mcpdbg][override-poc] fulfill failed', {
        tabId: activeRun.tabId,
        requestUrl,
        error: failure.message,
      });
      await sendDebuggerCommand(debuggee, 'Fetch.continueRequest', { requestId }).catch(() => undefined);
    }
  }

  private handleDebuggerDetach(source: chrome.debugger.Debuggee, reason: string): void {
    if (typeof source.tabId !== 'number') {
      return;
    }

    if (this.expectedDetachTabId === source.tabId) {
      this.expectedDetachTabId = null;
      return;
    }

    if (!this.activeRun || this.activeRun.tabId !== source.tabId) {
      return;
    }

    this.recordError(`Debugger detached unexpectedly: ${reason}`, 'DEBUGGER_DETACHED');
    console.warn('[mcpdbg][override-poc] debugger detached unexpectedly', {
      tabId: source.tabId,
      reason,
    });
    const endedRun = {
      ...this.activeRun,
      active: false as const,
      endedAt: Date.now(),
      runStatus: 'failed' as const,
    };
    this.activeRun = null;
    this.pendingRscResponseFulfillments.clear();
    this.skippedRscResponseRequests.clear();
    void this.persistRun(endedRun);
  }

  private recordError(message: string, code: OverridePocFailureCode = 'UNKNOWN'): void {
    if (this.activeRun) {
      this.activeRun.lastError = message;
      this.activeRun.lastErrorCode = code;
    }
  }

  private toRunRecord(run: Pick<
    ActiveOverridePocRun,
    'runId'
    | 'sessionId'
    | 'startedAt'
    | 'endedAt'
    | 'runStatus'
    | 'tabId'
    | 'selectedTabId'
    | 'targetAssetUrl'
    | 'localFilePath'
    | 'resolvedLocalFilePath'
    | 'contentType'
    | 'autoReload'
    | 'configPath'
    | 'fileExists'
    | 'fileSizeBytes'
    | 'matchedRequests'
    | 'fulfilledRequests'
    | 'lastMatchedAt'
    | 'lastFulfilledAt'
    | 'lastErrorCode'
    | 'lastError'
  >): OverridePocRunRecord {
    return {
      runId: run.runId,
      sessionId: run.sessionId,
      startedAt: run.startedAt,
      endedAt: run.endedAt ?? null,
      runStatus: run.runStatus,
      tabId: run.tabId,
      selectedTabId: run.selectedTabId ?? null,
      targetAssetUrl: run.targetAssetUrl,
      localFilePath: run.localFilePath,
      resolvedLocalFilePath: run.resolvedLocalFilePath,
      contentType: run.contentType,
      autoReload: run.autoReload,
      configPath: run.configPath,
      fileExists: run.fileExists,
      fileSizeBytes: run.fileSizeBytes,
      matchedRequests: run.matchedRequests,
      fulfilledRequests: run.fulfilledRequests,
      lastMatchedAt: run.lastMatchedAt ?? null,
      lastFulfilledAt: run.lastFulfilledAt ?? null,
      lastErrorCode: run.lastErrorCode ?? null,
      lastErrorMessage: run.lastError ?? null,
    };
  }

  private async postJson(path: string, body: unknown): Promise<void> {
    const response = await fetch(`${this.serverBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const payload = await readJsonResponse(response).catch(() => ({}));
      const errorMessage = isRecord(payload) && typeof payload.error === 'string'
        ? payload.error
        : `Override audit request failed with ${response.status}`;
      throw new Error(errorMessage);
    }
  }

  private recordAuditError(error: unknown): void {
    this.auditLastError = asErrorMessage(error);
    this.auditLastErrorAt = Date.now();
  }

  private clearAuditErrorIfRecovered(): void {
    if (this.auditQueue.length > 0) {
      return;
    }

    this.auditLastError = undefined;
    this.auditLastErrorAt = undefined;
  }

  private enqueueAuditPost(path: string, body: unknown, error: unknown): void {
    this.recordAuditError(error);

    if (this.auditQueue.length >= MAX_AUDIT_QUEUE_SIZE) {
      this.auditQueue.shift();
    }

    this.auditQueue.push({
      path,
      body,
      attempts: 0,
      nextAttemptAt: Date.now() + AUDIT_RETRY_DELAYS_MS[0],
    });
    this.scheduleAuditFlush(AUDIT_RETRY_DELAYS_MS[0]);
  }

  private scheduleAuditFlush(delayMs: number): void {
    if (this.auditFlushTimer) {
      return;
    }

    this.auditFlushTimer = setTimeout(() => {
      this.auditFlushTimer = null;
      void this.flushAuditQueue();
    }, Math.max(0, delayMs));
  }

  private scheduleNextAuditFlush(): void {
    if (this.auditQueue.length === 0) {
      this.clearAuditErrorIfRecovered();
      return;
    }

    const nextAttemptAt = Math.min(...this.auditQueue.map((entry) => entry.nextAttemptAt));
    this.scheduleAuditFlush(Math.max(0, nextAttemptAt - Date.now()));
  }

  private async flushAuditQueue(): Promise<void> {
    if (this.auditQueue.length === 0) {
      this.clearAuditErrorIfRecovered();
      return;
    }

    const now = Date.now();
    const entries = this.auditQueue;
    this.auditQueue = [];

    for (const entry of entries) {
      if (entry.nextAttemptAt > now) {
        this.auditQueue.push(entry);
        continue;
      }

      try {
        await this.postJson(entry.path, entry.body);
      } catch (error) {
        const attempts = entry.attempts + 1;
        this.recordAuditError(error);

        if (attempts < AUDIT_RETRY_DELAYS_MS.length) {
          this.auditQueue.push({
            ...entry,
            attempts,
            nextAttemptAt: Date.now() + AUDIT_RETRY_DELAYS_MS[attempts],
          });
        } else {
          console.warn('[mcpdbg][override-poc] dropping audit record after retries', {
            path: entry.path,
            error: asErrorMessage(error),
          });
        }
      }
    }

    this.scheduleNextAuditFlush();
  }

  private async persistAuditPost(path: string, body: unknown): Promise<void> {
    try {
      await this.postJson(path, body);
      this.clearAuditErrorIfRecovered();
    } catch (error) {
      this.enqueueAuditPost(path, body, error);
      throw error;
    }
  }

  private async persistRun(run: Pick<
    ActiveOverridePocRun,
    'runId'
    | 'sessionId'
    | 'startedAt'
    | 'endedAt'
    | 'runStatus'
    | 'tabId'
    | 'selectedTabId'
    | 'targetAssetUrl'
    | 'localFilePath'
    | 'resolvedLocalFilePath'
    | 'contentType'
    | 'autoReload'
    | 'configPath'
    | 'fileExists'
    | 'fileSizeBytes'
    | 'matchedRequests'
    | 'fulfilledRequests'
    | 'lastMatchedAt'
    | 'lastFulfilledAt'
    | 'lastErrorCode'
    | 'lastError'
  >): Promise<void> {
    try {
      await this.persistAuditPost(
        `/sessions/${encodeURIComponent(run.sessionId)}/overrides/runs`,
        this.toRunRecord(run),
      );
    } catch (error) {
      console.warn('[mcpdbg][override-poc] failed to persist run audit', {
        runId: run.runId,
        error: asErrorMessage(error),
      });
    }
  }

  private async persistRequest(record: OverridePocRequestRecord): Promise<void> {
    try {
      await this.persistAuditPost(
        `/sessions/${encodeURIComponent(record.sessionId)}/overrides/requests`,
        record,
      );
    } catch (error) {
      console.warn('[mcpdbg][override-poc] failed to persist request audit', {
        runId: record.runId,
        requestLogId: record.requestLogId,
        error: asErrorMessage(error),
      });
    }
  }

  private async persistTerminalRun(options: {
    runId: string;
    sessionId: string;
    startedAt: number;
    tabId: number;
    selectedTabId?: number;
    config: OverridePocServerConfig;
    failure: OverridePocControllerError;
  }): Promise<void> {
    await this.persistRun({
      runId: options.runId,
      sessionId: options.sessionId,
      runStatus: 'failed',
      startedAt: options.startedAt,
      endedAt: Date.now(),
      selectedTabId: options.selectedTabId,
      tabId: options.tabId,
      targetAssetUrl: options.config.targetAssetUrl,
      localFilePath: options.config.localFilePath,
      resolvedLocalFilePath: options.config.resolvedLocalFilePath,
      contentType: options.config.contentType,
      autoReload: options.config.autoReload,
      configPath: options.config.configPath,
      fileExists: options.config.fileExists,
      fileSizeBytes: options.config.fileSizeBytes,
      matchedRequests: 0,
      fulfilledRequests: 0,
      lastErrorCode: options.failure.code,
      lastError: options.failure.message,
    });
  }
}
