import { SessionManager, SessionState, CaptureCommandType } from './session-manager';
import { LiveConsoleBufferStore } from './live-console-buffer';
import {
  LiveUIActionRequest,
  LiveUIActionRequestSchema,
  LiveUIActionResult,
  createLiveUIActionTraceId,
} from '../../../libs/mcp-contracts/src';
import {
  applySafeModeRestrictions,
  canExecuteLiveAutomation,
  CaptureConfig,
  DEFAULT_CAPTURE_CONFIG,
  getSnapshotCaptureBlockReason,
  isUrlAllowed,
  loadCaptureConfig,
  requiresSensitiveAutomationOptIn,
  SnapshotStyleMode,
  saveCaptureConfig,
} from './capture-controls';
import { buildAutomationEventPayload, buildAutomationStoppedPayload } from './automation-events';
import {
  evaluatePngCapturePolicy,
  normalizeSnapshotMode,
  normalizeSnapshotStyleMode,
  normalizeSnapshotTrigger,
  resolveSnapshotStyleMode,
  registerPngCaptureSuccess,
  shouldCapturePng,
  SnapshotPngUsage,
} from './snapshot-capture';
import { OverridePocController, type OverridePocStatus } from './override-poc';
import {
  normalizeOverrideResponseCaptureBytes,
} from './override-response-capture-limits';
import { redactSnapshotRecord } from '../../../libs/redaction/src';
import {
  executeNativeBlurAction,
  executeNativeClickAction,
  executeNativeFocusAction,
  executeNativeHoverAction,
  executeNativeInputAction,
  executeNativePressKeyAction,
  executeNativeScrollAction,
  executeNativeSubmitAction,
} from './automation-native';
import {
  buildPreferredCaptureTabIds,
  hasExplicitCaptureFrameTarget,
  resolveCaptureFrameTarget,
  shouldRetryGenericCaptureResult,
  type GenericCaptureCommand,
} from './live-capture-routing';

type RuntimeRequest =
  | { type: 'SESSION_GET_STATE' }
  | { type: 'SESSION_START' }
  | { type: 'SESSION_PAUSE' }
  | { type: 'SESSION_RESUME_CURRENT' }
  | { type: 'SESSION_RESUME_BY_ID'; sessionId: string }
  | { type: 'SESSION_STOP' }
  | { type: 'SESSION_QUEUE_EVENT'; eventType: string; data: Record<string, unknown> }
  | { type: 'SESSION_GET_CONFIG' }
  | { type: 'SESSION_UPDATE_CONFIG'; config: CaptureConfig }
  | { type: 'RETENTION_GET_SETTINGS' }
  | {
      type: 'RETENTION_UPDATE_SETTINGS';
      settings: Partial<{
        retentionDays: number;
        maxDbMb: number;
        maxSessions: number;
        cleanupIntervalMinutes: number;
        exportPathOverride: string | null;
      }>;
    }
  | { type: 'RETENTION_RUN_CLEANUP' }
  | { type: 'SESSION_PIN'; sessionId: string; pinned: boolean }
  | {
      type: 'SESSION_EXPORT';
      sessionId: string;
      format?: 'json' | 'zip';
      compatibilityMode?: boolean;
      includePngBase64?: boolean;
    }
  | { type: 'SESSION_IMPORT'; payload: Record<string, unknown>; format?: 'json' | 'zip'; archiveBase64?: string }
  | { type: 'SESSION_GET_DB_ENTRIES'; sessionId: string; limit: number; offset: number }
  | { type: 'SESSION_GET_SNAPSHOTS'; sessionId: string; limit: number; offset: number }
  | { type: 'SESSION_LIST_RECENT'; limit: number; offset: number }
  | { type: 'SESSION_CAPTURE_DIAGNOSTICS' }
  | { type: 'TEST_SET_SERVER_BASE_URL'; serverBaseUrl?: string | null }
  | { type: 'SESSION_RECOVER_HEALTH'; sessionId?: string }
  | { type: 'SESSION_RETRY_CONTENT_SCRIPT'; sessionId?: string }
  | { type: 'SESSION_FOCUS_CAPTURE_TAB'; sessionId?: string }
  | { type: 'SESSION_GET_TAB_SCOPE' }
  | { type: 'SESSION_ADD_TAB_TO_SESSION'; tabId: number }
  | { type: 'SESSION_REMOVE_TAB_FROM_SESSION'; tabId: number }
  | { type: 'OVERRIDE_POC_GET_STATUS' }
  | { type: 'OVERRIDE_POC_SET_TARGET_TAB'; tabId: number | null }
  | { type: 'OVERRIDE_POC_ENABLE'; tabId?: number }
  | { type: 'OVERRIDE_POC_DISABLE' }
  | { type: 'AUTOMATION_EMERGENCY_STOP' }
  | { type: 'DB_RESET' };

type RuntimeResponse =
  | { ok: true; state: SessionState; accepted?: boolean }
  | { ok: true; config: CaptureConfig }
  | { ok: true; retention: unknown; lastCleanup?: unknown }
  | { ok: true; result: unknown }
  | { ok: false; error: string };

interface CaptureTabResponse {
  ok: boolean;
  result?: Record<string, unknown>;
  truncated?: boolean;
  error?: string;
}

interface CapturePingResponse {
  ok: boolean;
  type?: 'CAPTURE_PONG';
}

interface CaptureConfigUpdatePayload {
  captureEnabled: boolean;
  network: {
    captureBodies: boolean;
    maxBodyBytes: number;
  };
  automation: {
    enabled: boolean;
    allowSensitiveFields: boolean;
    status: 'idle' | 'armed' | 'executing';
    sessionId?: string;
    traceId?: string;
    action?: LiveUIActionRequest['action'];
  };
}

interface AutomationUiState {
  status: 'idle' | 'armed' | 'executing';
  sessionId?: string;
  traceId?: string;
  action?: LiveUIActionRequest['action'];
}

interface SessionTabScope {
  baseOrigin?: string;
  allowedTabIds: Set<number>;
}

interface RuntimeStorageAreaLike {
  get(keys: string | string[] | Record<string, unknown> | null, callback: (items: Record<string, unknown>) => void): void;
}

interface PersistedSessionBindingRecord {
  rememberedTab?: {
    tabId: number;
    windowId?: number;
  };
  scope?: {
    baseOrigin?: string;
    allowedTabIds: number[];
  };
}

type PersistedSessionBindings = Record<string, PersistedSessionBindingRecord>;

const snapshotPngUsageBySession = new Map<string, SnapshotPngUsage>();
const captureTabBySession = new Map<string, { tabId: number; windowId?: number }>();
const sessionTabScopeBySession = new Map<string, SessionTabScope>();
const overridePocTargetTabBySession = new Map<string, number>();
const sessionTabRecoveryTimers = new Map<number, ReturnType<typeof setTimeout>>();
const liveConsoleBufferStore = new LiveConsoleBufferStore();
let overridePocDiagnosisCache: {
  key: string;
  expiresAt: number;
  diagnosis: OverridePocUiDiagnosis | undefined;
} | null = null;
let automationUiState: AutomationUiState = { status: 'idle' };
const FULL_PAGE_CAPTURE_SCROLL_SETTLE_MS = 120;
const MAX_STITCHED_PNG_PIXELS = 40_000_000;
const DEFAULT_SERVER_BASE_URL = 'http://127.0.0.1:8065';
const SERVER_BASE_URL_STORAGE_KEY = 'serverBaseUrl';
const SESSION_BINDINGS_STORAGE_KEY = '__bdmcp_session_bindings_v1__';

interface FullPageCaptureMetrics {
  totalWidth: number;
  totalHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  originalScrollX: number;
  originalScrollY: number;
}

interface FullPageCaptureResult {
  dataUrl: string;
  byteLength: number;
  fullPage: boolean;
  pageWidth: number;
  pageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  tiles: number;
  downscaled: boolean;
}

interface ObservedOverrideAsset {
  url: string;
  kind: string;
  ruleType?: 'asset' | 'document' | 'rsc-flight' | 'next-data' | 'api-response';
  requestMethod?: string;
  resourceType?: string;
  contentType?: string;
  statusCode?: number;
  initiatorType?: string;
  rel?: string;
  as?: string;
  integrity?: string;
  crossOrigin?: string;
  nonce?: string;
  fromDom: boolean;
  fromPerformance: boolean;
  fromNavigation?: boolean;
  fromFetch?: boolean;
}

interface ObservedOverrideAssetsResult {
  pageUrl: string;
  baseUrl: string;
  title: string;
  serviceWorkerControlled: boolean;
  cspMetaTags: string[];
  assets: ObservedOverrideAsset[];
}

type OverrideRuleType = NonNullable<ObservedOverrideAsset['ruleType']>;

interface OverridePocUiDiagnosisIssue {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
}

interface OverridePocUiDiagnosis {
  issueCount: number;
  issues: OverridePocUiDiagnosisIssue[];
  observedAssets?: {
    observedAssetCount: number;
    targetAssetObserved: boolean;
    targetAssetIntegrity: string | null;
    serviceWorkerControlled: boolean;
    cspMetaTagCount: number;
    sriAssetCount: number;
  };
}

interface OverridePocUiRequestLogEntry {
  requestLogId: string;
  runId: string;
  requestId: string;
  timestamp: number;
  requestUrl: string;
  status: string;
  failureCode?: string | null;
  errorMessage?: string | null;
  responseCode?: number | null;
}

interface OverridePocUiPlanLogEntry {
  planId: string;
  createdAt: number;
  plannerKind: string;
  ruleId: string;
  ruleType: string;
  requestMethod: string;
  matchMode: string;
  targetAssetUrl: string;
  contentType: string;
  originalBytes?: number | null;
  patchedBytes?: number | null;
  warnings: string[];
  blockers: string[];
}

interface OverridePocStatusResult extends OverridePocStatus {
  diagnosis?: OverridePocUiDiagnosis;
  requestLog?: OverridePocUiRequestLogEntry[];
  requestLogError?: string;
  planLog?: OverridePocUiPlanLogEntry[];
  planLogError?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getSnapshotPngUsage(sessionId: string): SnapshotPngUsage {
  const existing = snapshotPngUsageBySession.get(sessionId);
  if (existing) {
    return existing;
  }

  const created: SnapshotPngUsage = {
    imageCount: 0,
    lastCaptureAt: 0,
  };
  snapshotPngUsageBySession.set(sessionId, created);
  return created;
}

function estimateDataUrlBytes(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex === -1) {
    return dataUrl.length;
  }

  const encoded = dataUrl.slice(commaIndex + 1);
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
}

function normalizeHttpOrigin(candidate: unknown): string | undefined {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function resolveSessionEventOrigin(senderUrl: string, payload: Record<string, unknown>): string | undefined {
  const candidates: unknown[] = [
    payload.origin,
    payload.url,
    payload.to,
    payload.href,
    payload.location,
    senderUrl,
  ];

  for (const candidate of candidates) {
    const origin = normalizeHttpOrigin(candidate);
    if (origin) {
      return origin;
    }
  }

  return undefined;
}

function resolveLiveConsoleTabId(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('tabId must be an integer');
  }

  const tabId = Math.floor(value);
  if (!Number.isInteger(tabId) || tabId < 0) {
    throw new Error('tabId must be an integer');
  }

  return tabId;
}

function resolveLiveConsoleSinceTs(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('sinceTs must be a finite number');
  }

  const sinceTs = Math.floor(value);
  if (sinceTs < 0) {
    throw new Error('sinceTs must be >= 0');
  }

  return sinceTs;
}

function resolveLiveConsoleContains(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveLiveConsoleLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 100;
  }

  const limit = Math.floor(value);
  if (limit < 1) {
    return 100;
  }

  return Math.min(limit, 500);
}

function resolveLiveConsoleDedupeWindowMs(value: unknown): number {
  if (value === undefined) {
    return 0;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('dedupeWindowMs must be a finite number');
  }

  const dedupeWindowMs = Math.floor(value);
  if (dedupeWindowMs < 0) {
    throw new Error('dedupeWindowMs must be >= 0');
  }

  return Math.min(dedupeWindowMs, 60_000);
}

function resolveLiveConsoleLevels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = Array.from(
    new Set(
      value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0),
    ),
  );

  return normalized.length > 0 ? normalized : undefined;
}

function buildRejectedLiveActionResult(
  request: LiveUIActionRequest,
  startedAt: number,
  code: string,
  message: string,
  targetOverrides: Partial<LiveUIActionResult['target']> = {},
): LiveUIActionResult {
  return {
    action: request.action,
    traceId: request.traceId ?? createLiveUIActionTraceId(),
    status: 'rejected',
    executionScope: 'top-document-v1',
    startedAt,
    finishedAt: Date.now(),
    target: {
      matched: false,
      selector: request.target?.selector,
      tabId: request.target?.tabId,
      frameId: request.target?.frameId ?? 0,
      url: request.target?.url,
      ...targetOverrides,
    },
    failureReason: {
      code,
      message,
    },
  };
}

function withLiveActionTabContext(
  result: Record<string, unknown>,
  request: LiveUIActionRequest,
  tab: chrome.tabs.Tab & { id: number },
): Record<string, unknown> {
  const target = result.target && typeof result.target === 'object'
    ? (result.target as Record<string, unknown>)
    : {};

  return {
    ...result,
    traceId:
      typeof result.traceId === 'string' && result.traceId.length > 0
        ? result.traceId
        : (request.traceId ?? createLiveUIActionTraceId()),
    target: {
      selector: request.target?.selector,
      tabId: tab.id,
      frameId: request.target?.frameId ?? 0,
      url: tab.url ?? request.target?.url,
      ...target,
    },
  };
}

function queueAutomationEvent(
  eventType: 'automation_requested' | 'automation_started' | 'automation_succeeded' | 'automation_failed',
  request: LiveUIActionRequest,
  options: { startedAt: number; result?: LiveUIActionResult; tab?: chrome.tabs.Tab & { id: number } },
): void {
  const payload = buildAutomationEventPayload({
    eventType,
    request,
    startedAt: options.startedAt,
    result: options.result,
    tabId: options.tab?.id,
    url: options.tab?.url ?? request.target?.url,
  });
  sessionManager.queueEvent(eventType, payload, {
    tabId: options.tab?.id,
    origin: normalizeHttpOrigin(options.tab?.url ?? request.target?.url) ?? sessionManager.getState().baseOrigin,
  });
}

function queueAutomationStoppedEvent(reason: string): void {
  const state = sessionManager.getState();
  if (!state.sessionId) {
    return;
  }

  const rememberedTab = captureTabBySession.get(state.sessionId);
  const payload = buildAutomationStoppedPayload({
    action: automationUiState.action,
    traceId: automationUiState.traceId,
    sessionId: state.sessionId,
    tabId: rememberedTab?.tabId,
    reason,
  });
  sessionManager.queueEvent('automation_stopped', payload, {
    tabId: rememberedTab?.tabId,
    origin: state.baseOrigin,
  });
}

async function reloadTab(tabId: number, ignoreCache: boolean): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    chrome.tabs.reload(tabId, { bypassCache: ignoreCache }, () => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve();
    });
  });
}

async function updateWindowViewport(windowId: number, width: number, height: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    chrome.windows.update(windowId, { width, height, focused: true }, () => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve();
    });
  });
}

function setSessionTabScope(sessionId: string, baseUrl: string, tabId?: number): void {
  const allowedTabIds = new Set<number>();
  if (typeof tabId === 'number') {
    allowedTabIds.add(tabId);
  }

  sessionTabScopeBySession.set(sessionId, {
    baseOrigin: normalizeHttpOrigin(baseUrl),
    allowedTabIds,
  });
  void persistSessionBindings(chrome.storage.local);
}

function addTabToSessionScope(sessionId: string, tab: chrome.tabs.Tab): void {
  if (typeof tab.id !== 'number') {
    return;
  }

  const existing = getSessionTabScope(sessionId);
  const allowedTabIds = new Set<number>(existing?.allowedTabIds ?? []);
  allowedTabIds.add(tab.id);
  const baseOrigin = normalizeHttpOrigin(tab.url ?? '') ?? existing?.baseOrigin;
  sessionTabScopeBySession.set(sessionId, {
    baseOrigin,
    allowedTabIds,
  });
  sessionManager.setSessionScope({
    baseOrigin,
    allowedTabIds: Array.from(allowedTabIds),
  });
  void persistSessionBindings(chrome.storage.local);
  void syncCaptureConfigToSessionTabs(sessionId);
}

function getSessionTabScope(sessionId: string): SessionTabScope | undefined {
  return sessionTabScopeBySession.get(sessionId);
}

function isTabAllowedForSession(sessionId: string, tabId?: number): boolean {
  const scope = getSessionTabScope(sessionId);
  if (!scope) {
    return true;
  }

  if (scope.allowedTabIds.size === 0 || typeof tabId !== 'number') {
    return false;
  }

  return scope.allowedTabIds.has(tabId);
}

function cleanupSessionLocalState(sessionId: string): void {
  snapshotPngUsageBySession.delete(sessionId);
  const remembered = captureTabBySession.get(sessionId);
  if (remembered) {
    clearSessionTabRecoveryTimer(remembered.tabId);
  }
  const scope = sessionTabScopeBySession.get(sessionId);
  if (scope) {
    for (const tabId of scope.allowedTabIds) {
      clearSessionTabRecoveryTimer(tabId);
    }
  }
  captureTabBySession.delete(sessionId);
  sessionTabScopeBySession.delete(sessionId);
  overridePocTargetTabBySession.delete(sessionId);
  void persistSessionBindings(chrome.storage.local);
  liveConsoleBufferStore.clearSession(sessionId);
  if (automationUiState.sessionId === sessionId) {
    automationUiState = { status: 'idle' };
  }
}

function serializeSessionBindings(): PersistedSessionBindings {
  const sessionIds = new Set<string>([
    ...captureTabBySession.keys(),
    ...sessionTabScopeBySession.keys(),
  ]);
  const records: PersistedSessionBindings = {};

  for (const sessionId of sessionIds) {
    const remembered = captureTabBySession.get(sessionId);
    const scope = sessionTabScopeBySession.get(sessionId);
    records[sessionId] = {
      rememberedTab: remembered
        ? {
            tabId: remembered.tabId,
            windowId: remembered.windowId,
          }
        : undefined,
      scope: scope
        ? {
            baseOrigin: scope.baseOrigin,
            allowedTabIds: Array.from(scope.allowedTabIds).sort((a, b) => a - b),
          }
        : undefined,
    };
  }

  return records;
}

function normalizePersistedSessionBindings(value: unknown): PersistedSessionBindings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result: PersistedSessionBindings = {};
  for (const [sessionId, rawRecord] of Object.entries(value as Record<string, unknown>)) {
    if (!rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) {
      continue;
    }

    const record = rawRecord as Record<string, unknown>;
    const rememberedRaw = record.rememberedTab;
    const scopeRaw = record.scope;
    const normalizedRecord: PersistedSessionBindingRecord = {};

    if (rememberedRaw && typeof rememberedRaw === 'object' && !Array.isArray(rememberedRaw)) {
      const remembered = rememberedRaw as Record<string, unknown>;
      if (typeof remembered.tabId === 'number' && Number.isInteger(remembered.tabId) && remembered.tabId >= 0) {
        normalizedRecord.rememberedTab = {
          tabId: remembered.tabId,
          windowId:
            typeof remembered.windowId === 'number' && Number.isInteger(remembered.windowId) && remembered.windowId >= 0
              ? remembered.windowId
              : undefined,
        };
      }
    }

    if (scopeRaw && typeof scopeRaw === 'object' && !Array.isArray(scopeRaw)) {
      const scope = scopeRaw as Record<string, unknown>;
      const allowedTabIds = Array.isArray(scope.allowedTabIds)
        ? Array.from(
            new Set(
              scope.allowedTabIds.filter(
                (tabId): tabId is number => typeof tabId === 'number' && Number.isInteger(tabId) && tabId >= 0,
              ),
            ),
          )
        : [];
      normalizedRecord.scope = {
        baseOrigin: normalizeHttpOrigin(scope.baseOrigin),
        allowedTabIds,
      };
    }

    if (normalizedRecord.rememberedTab || normalizedRecord.scope) {
      result[sessionId] = normalizedRecord;
    }
  }

  return result;
}

function loadPersistedSessionBindings(storageArea: chrome.storage.StorageArea): Promise<void> {
  return new Promise((resolve) => {
    storageArea.get(SESSION_BINDINGS_STORAGE_KEY, (items) => {
      const bindings = normalizePersistedSessionBindings(items[SESSION_BINDINGS_STORAGE_KEY]);
      for (const [sessionId, record] of Object.entries(bindings)) {
        if (record.rememberedTab) {
          captureTabBySession.set(sessionId, record.rememberedTab);
        }
        if (record.scope) {
          sessionTabScopeBySession.set(sessionId, {
            baseOrigin: record.scope.baseOrigin,
            allowedTabIds: new Set(record.scope.allowedTabIds),
          });
        }
      }
      resolve();
    });
  });
}

function persistSessionBindings(storageArea: chrome.storage.StorageArea): Promise<void> {
  const serialized = serializeSessionBindings();
  return new Promise((resolve) => {
    storageArea.set({ [SESSION_BINDINGS_STORAGE_KEY]: serialized }, () => resolve());
  });
}

function getAutomationStatus(): AutomationUiState['status'] {
  const sessionState = sessionManager.getState();
  if (automationUiState.status === 'executing' && captureConfig.automation.enabled) {
    return 'executing';
  }

  if (captureConfig.automation.enabled && sessionState.isActive && !sessionState.isPaused && sessionState.sessionId) {
    return 'armed';
  }

  return 'idle';
}

function syncAutomationBadge(): void {
  if (!chrome.action) {
    return;
  }

  const status = getAutomationStatus();
  const text = status === 'executing' ? 'RUN' : status === 'armed' ? 'AUTO' : '';
  const title = status === 'executing'
    ? 'Live automation executing'
    : status === 'armed'
      ? 'Live automation armed'
      : 'Live automation disabled';

  chrome.action.setBadgeText({ text });
  chrome.action.setTitle({ title });

  if (text) {
    chrome.action.setBadgeBackgroundColor({ color: status === 'executing' ? '#a12d22' : '#8a5a12' });
  }
}

function getSelectedOverridePocTabId(sessionId: string): number | undefined {
  const selectedTabId = overridePocTargetTabBySession.get(sessionId);
  if (typeof selectedTabId !== 'number' || !Number.isInteger(selectedTabId)) {
    return undefined;
  }

  const scope = getSessionTabScope(sessionId);
  if (scope && !scope.allowedTabIds.has(selectedTabId)) {
    overridePocTargetTabBySession.delete(sessionId);
    return undefined;
  }

  return selectedTabId;
}

async function getBoundSessionTab(sessionId: string, tabId: number): Promise<chrome.tabs.Tab> {
  const scope = getSessionTabScope(sessionId);
  if (!scope || !scope.allowedTabIds.has(tabId)) {
    throw new Error('Selected override tab is not bound to the active session.');
  }

  const tab = await chrome.tabs.get(tabId);
  if (!tab || typeof tab.id !== 'number') {
    throw new Error('Selected override tab is no longer available.');
  }

  return tab;
}

async function resolveOverridePocTab(sessionId: string, preferredTabId?: number): Promise<chrome.tabs.Tab | undefined> {
  if (typeof preferredTabId === 'number') {
    const tab = await getBoundSessionTab(sessionId, preferredTabId);
    rememberCaptureTabForSession(sessionId, tab);
    return tab;
  }

  const selectedTabId = getSelectedOverridePocTabId(sessionId);
  if (typeof selectedTabId === 'number') {
    const tab = await getBoundSessionTab(sessionId, selectedTabId);
    rememberCaptureTabForSession(sessionId, tab);
    return tab;
  }

  return resolveCaptureTab(sessionId);
}

function parseOverridePocUiDiagnosis(payload: unknown): OverridePocUiDiagnosis | undefined {
  if (!isRecord(payload) || !isRecord(payload.diagnosis)) {
    return undefined;
  }

  const diagnosis = payload.diagnosis;
  const issueEntries = Array.isArray(diagnosis.issues) ? diagnosis.issues : [];
  const issues = issueEntries
    .map((entry): OverridePocUiDiagnosisIssue | null => {
      if (!isRecord(entry) || typeof entry.code !== 'string' || typeof entry.message !== 'string') {
        return null;
      }
      const severity = entry.severity === 'error' || entry.severity === 'warning' || entry.severity === 'info'
        ? entry.severity
        : 'info';
      return {
        code: entry.code,
        severity,
        message: entry.message,
      };
    })
    .filter((entry): entry is OverridePocUiDiagnosisIssue => entry !== null)
    .slice(0, 5);

  const observed = isRecord(diagnosis.observedAssets) ? diagnosis.observedAssets : undefined;
  const observedAssets = observed
    ? {
        observedAssetCount: typeof observed.observedAssetCount === 'number' ? Math.floor(observed.observedAssetCount) : 0,
        targetAssetObserved: observed.targetAssetObserved === true,
        targetAssetIntegrity: typeof observed.targetAssetIntegrity === 'string' ? observed.targetAssetIntegrity : null,
        serviceWorkerControlled: observed.serviceWorkerControlled === true,
        cspMetaTagCount: typeof observed.cspMetaTagCount === 'number' ? Math.floor(observed.cspMetaTagCount) : 0,
        sriAssetCount: typeof observed.sriAssetCount === 'number' ? Math.floor(observed.sriAssetCount) : 0,
      }
    : undefined;

  return {
    issueCount: issueEntries.length,
    issues,
    observedAssets,
  };
}

async function readOverridePocDiagnosis(
  sessionId: string,
  status: OverridePocStatus,
): Promise<OverridePocUiDiagnosis | undefined> {
  if (!status.runId) {
    return undefined;
  }

  const key = [sessionId, status.runId, status.matchedRequests, status.fulfilledRequests, status.lastErrorCode ?? ''].join(':');
  const now = Date.now();
  if (overridePocDiagnosisCache?.key === key && overridePocDiagnosisCache.expiresAt > now) {
    return overridePocDiagnosisCache.diagnosis;
  }

  try {
    const payload = await fetchServer(
      `/sessions/${encodeURIComponent(sessionId)}/overrides/diagnosis?runId=${encodeURIComponent(status.runId)}`,
    );
    const diagnosis = parseOverridePocUiDiagnosis(payload);
    overridePocDiagnosisCache = { key, expiresAt: now + 5_000, diagnosis };
    return diagnosis;
  } catch (error) {
    const diagnosis: OverridePocUiDiagnosis = {
      issueCount: 1,
      issues: [{
        code: 'DIAGNOSIS_UNAVAILABLE',
        severity: 'warning',
        message: error instanceof Error ? error.message : 'Unable to read override diagnosis.',
      }],
    };
    overridePocDiagnosisCache = { key, expiresAt: now + 5_000, diagnosis };
    return diagnosis;
  }
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function parseOverridePocRequestLogEntry(value: unknown): OverridePocUiRequestLogEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.requestLogId !== 'string'
    || typeof value.runId !== 'string'
    || typeof value.requestId !== 'string'
    || typeof value.requestUrl !== 'string'
    || typeof value.status !== 'string'
  ) {
    return null;
  }
  return {
    requestLogId: value.requestLogId,
    runId: value.runId,
    requestId: value.requestId,
    timestamp: typeof value.timestamp === 'number' && Number.isFinite(value.timestamp) ? Math.floor(value.timestamp) : 0,
    requestUrl: value.requestUrl,
    status: value.status,
    failureCode: typeof value.failureCode === 'string' ? value.failureCode : null,
    errorMessage: typeof value.errorMessage === 'string' ? value.errorMessage : null,
    responseCode: typeof value.responseCode === 'number' && Number.isFinite(value.responseCode) ? Math.floor(value.responseCode) : null,
  };
}

function parseOverridePocPlanLogEntry(value: unknown): OverridePocUiPlanLogEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.planId !== 'string'
    || typeof value.plannerKind !== 'string'
    || typeof value.ruleId !== 'string'
    || typeof value.ruleType !== 'string'
    || typeof value.requestMethod !== 'string'
    || typeof value.matchMode !== 'string'
    || typeof value.targetAssetUrl !== 'string'
    || typeof value.contentType !== 'string'
  ) {
    return null;
  }
  return {
    planId: value.planId,
    createdAt: typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? Math.floor(value.createdAt) : 0,
    plannerKind: value.plannerKind,
    ruleId: value.ruleId,
    ruleType: value.ruleType,
    requestMethod: value.requestMethod,
    matchMode: value.matchMode,
    targetAssetUrl: value.targetAssetUrl,
    contentType: value.contentType,
    originalBytes: typeof value.originalBytes === 'number' && Number.isFinite(value.originalBytes) ? Math.floor(value.originalBytes) : null,
    patchedBytes: typeof value.patchedBytes === 'number' && Number.isFinite(value.patchedBytes) ? Math.floor(value.patchedBytes) : null,
    warnings: parseStringArray(value.warnings),
    blockers: parseStringArray(value.blockers),
  };
}

async function readOverridePocRequestLog(
  sessionId: string,
  runId: string | undefined,
): Promise<{ entries: OverridePocUiRequestLogEntry[]; error?: string }> {
  try {
    const query = runId ? `?runId=${encodeURIComponent(runId)}&limit=5` : '?limit=5';
    const payload = await fetchServer(`/sessions/${encodeURIComponent(sessionId)}/overrides/requests${query}`);
    const entries = Array.isArray(payload.requests)
      ? payload.requests
        .map(parseOverridePocRequestLogEntry)
        .filter((entry): entry is OverridePocUiRequestLogEntry => entry !== null)
      : [];
    return { entries };
  } catch (error) {
    return {
      entries: [],
      error: error instanceof Error ? error.message : 'Unable to read override request log.',
    };
  }
}

async function readOverridePocPlanLog(sessionId: string): Promise<{ entries: OverridePocUiPlanLogEntry[]; error?: string }> {
  try {
    const payload = await fetchServer(`/sessions/${encodeURIComponent(sessionId)}/overrides/plans?limit=5`);
    const entries = Array.isArray(payload.plans)
      ? payload.plans
        .map(parseOverridePocPlanLogEntry)
        .filter((entry): entry is OverridePocUiPlanLogEntry => entry !== null)
      : [];
    return { entries };
  } catch (error) {
    return {
      entries: [],
      error: error instanceof Error ? error.message : 'Unable to read override plan log.',
    };
  }
}

async function buildOverridePocStatusResult(
  sessionId: string | null | undefined,
  status: OverridePocStatus,
): Promise<OverridePocStatusResult> {
  if (!sessionId) {
    return status;
  }

  const selectedTabId = getSelectedOverridePocTabId(sessionId);
  const [diagnosis, requestLog, planLog] = await Promise.all([
    readOverridePocDiagnosis(sessionId, status),
    readOverridePocRequestLog(sessionId, status.runId),
    readOverridePocPlanLog(sessionId),
  ]);
  return {
    ...status,
    selectedTabId: typeof selectedTabId === 'number' ? selectedTabId : status.selectedTabId,
    diagnosis,
    requestLog: requestLog.entries,
    requestLogError: requestLog.error,
    planLog: planLog.entries,
    planLogError: planLog.error,
  };
}

async function buildSessionTabScopeResult(sessionId: string): Promise<Record<string, unknown>> {
  const scope = getSessionTabScope(sessionId);
  const boundTabIds = scope ? Array.from(scope.allowedTabIds).sort((a, b) => a - b) : [];
  const allTabs = await chrome.tabs.query({ currentWindow: true });

  const tabs = allTabs
    .filter((tab): tab is chrome.tabs.Tab & { id: number } => typeof tab.id === 'number')
    .map((tab) => ({
      tabId: tab.id,
      title: tab.title ?? 'Untitled tab',
      url: tab.url ?? '',
      origin: normalizeHttpOrigin(tab.url),
      active: tab.active === true,
      bound: boundTabIds.includes(tab.id),
    }));

  return {
    sessionId,
    baseOrigin: scope?.baseOrigin,
    allowedTabIds: boundTabIds,
    tabs,
  };
}

async function captureVisibleTabPng(windowId?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const callback = (dataUrl?: string) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      if (!dataUrl) {
        reject(new Error('captureVisibleTab returned empty data'));
        return;
      }

      resolve(dataUrl);
    };

    if (typeof windowId === 'number') {
      chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, callback);
      return;
    }

    chrome.tabs.captureVisibleTab({ format: 'png' }, callback);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildCaptureOffsets(totalSize: number, viewportSize: number): number[] {
  const total = Math.max(1, Math.floor(totalSize));
  const viewport = Math.max(1, Math.floor(viewportSize));
  if (total <= viewport) {
    return [0];
  }

  const offsets: number[] = [];
  let cursor = 0;
  const maxStart = total - viewport;
  while (cursor < maxStart) {
    offsets.push(cursor);
    cursor += viewport;
  }

  offsets.push(maxStart);
  return Array.from(new Set(offsets));
}

async function executeScriptInTab<T>(
  tabId: number,
  func: (...args: unknown[]) => T | Promise<T>,
  args: unknown[] = [],
): Promise<T> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });

  const firstResult = results[0];
  if (!firstResult) {
    throw new Error('No executeScript result from target tab');
  }

  return firstResult.result as T;
}

const DEFAULT_OVERRIDE_RESPONSE_CAPTURE_TIMEOUT_MS = 10_000;
const MAX_OVERRIDE_RESPONSE_CAPTURE_TIMEOUT_MS = 60_000;
const BLOCKED_OVERRIDE_CAPTURE_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  'proxy-authorization',
  'set-cookie',
  'content-length',
]);

type OverrideResponseCaptureMode = 'extension-fetch' | 'cdp-response';
type OverrideResponseUrlMatchMode = 'exact' | 'prefix';

interface DebuggerHeader {
  name?: string;
  value?: string;
}

interface CdpResponseRequestPausedPayload {
  requestId?: string;
  request?: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
  };
  responseStatusCode?: number;
  responseHeaders?: DebuggerHeader[];
}

interface CdpGetResponseBodyResult {
  body?: string;
  base64Encoded?: boolean;
}

interface CdpJavascriptDialogOpeningPayload {
  url?: string;
  frameId?: string;
  message?: string;
  type?: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  defaultPrompt?: string;
}

interface CdpFrameNavigatedPayload {
  frame?: {
    id?: string;
    parentId?: string;
    url?: string;
    loaderId?: string;
  };
}

interface CdpNavigatedWithinDocumentPayload {
  frameId?: string;
  url?: string;
  navigationType?: string;
}

interface CdpLifecycleEventPayload {
  frameId?: string;
  loaderId?: string;
  name?: string;
  timestamp?: number;
}

interface CdpFrameTreeResult {
  frameTree?: {
    frame?: {
      id?: string;
      parentId?: string;
      url?: string;
    };
  };
}

interface CdpDownloadWillBeginPayload {
  frameId?: string;
  guid?: string;
  url?: string;
  suggestedFilename?: string;
}

interface CdpDownloadProgressPayload {
  guid?: string;
  totalBytes?: number;
  receivedBytes?: number;
  state?: 'inProgress' | 'completed' | 'canceled';
}

function normalizeOverrideResponseCaptureTimeoutMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_OVERRIDE_RESPONSE_CAPTURE_TIMEOUT_MS;
  }

  const floored = Math.floor(value);
  if (floored < 1_000) {
    return DEFAULT_OVERRIDE_RESPONSE_CAPTURE_TIMEOUT_MS;
  }
  return Math.min(floored, MAX_OVERRIDE_RESPONSE_CAPTURE_TIMEOUT_MS);
}

function normalizeOverrideResponseCaptureMode(value: unknown): OverrideResponseCaptureMode {
  if (value === undefined || value === null || value === '') {
    return 'extension-fetch';
  }

  if (value === 'extension-fetch' || value === 'cdp-response') {
    return value;
  }

  throw new Error('captureMode must be "extension-fetch" or "cdp-response"');
}

function normalizeOverrideResponseUrlMatchMode(value: unknown): OverrideResponseUrlMatchMode {
  if (value === undefined || value === null || value === '') {
    return 'exact';
  }

  if (value === 'exact' || value === 'prefix') {
    return value;
  }

  throw new Error('matchMode must be "exact" or "prefix"');
}

function normalizeOverrideResponseCaptureMethod(
  value: unknown,
  options: { allowPostRscFlight?: boolean } = {},
): 'GET' | 'HEAD' | 'POST' {
  const method = typeof value === 'string' && value.trim().length > 0 ? value.trim().toUpperCase() : 'GET';
  if (method === 'POST' && options.allowPostRscFlight === true) {
    return 'POST';
  }
  if (method !== 'GET' && method !== 'HEAD') {
    throw new Error('Response body capture only supports safe GET or HEAD requests.');
  }
  return method;
}

function normalizeOverrideResponseCaptureUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('targetUrl is required');
  }

  const parsed = new URL(value.trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('targetUrl must use http:// or https://');
  }
  return parsed.toString();
}

function doesOverrideResponseUrlMatch(requestUrl: string, targetUrl: string, matchMode: OverrideResponseUrlMatchMode): boolean {
  if (matchMode === 'prefix') {
    return requestUrl.startsWith(targetUrl);
  }

  return requestUrl === targetUrl;
}

function normalizeOverrideResponseTriggerReload(value: unknown): boolean {
  return value === true;
}

function normalizeOverrideResponseCaptureHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('requestHeaders must be an object when provided');
  }

  const headers: Record<string, string> = {};
  for (const [name, rawHeaderValue] of Object.entries(value as Record<string, unknown>)) {
    const normalizedName = name.trim().toLowerCase();
    if (!normalizedName) {
      continue;
    }
    if (BLOCKED_OVERRIDE_CAPTURE_HEADERS.has(normalizedName)) {
      throw new Error(`requestHeaders cannot include sensitive or controlled header "${name}"`);
    }
    if (typeof rawHeaderValue !== 'string') {
      throw new Error(`requestHeaders.${name} must be a string`);
    }
    headers[name] = rawHeaderValue;
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

function isTextualOverrideResponseContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase().split(';', 1)[0]?.trim() ?? '';
  return normalized.startsWith('text/')
    || normalized === 'application/json'
    || normalized.endsWith('+json')
    || normalized === 'application/javascript'
    || normalized === 'application/xml'
    || normalized.endsWith('+xml')
    || normalized === 'application/x-ndjson'
    || normalized === 'image/svg+xml';
}

function inferOverrideResponseRuleType(targetUrl: string, contentType: string): OverrideRuleType {
  const parsed = new URL(targetUrl);
  const normalizedContentType = contentType.toLowerCase();
  if (normalizedContentType.includes('text/x-component') || parsed.searchParams.has('_rsc')) {
    return 'rsc-flight';
  }
  if (parsed.pathname.includes('/_next/data/')) {
    return 'next-data';
  }
  if (normalizedContentType.includes('text/html')) {
    return 'document';
  }
  if (normalizedContentType.includes('json') || normalizedContentType.startsWith('text/')) {
    return 'api-response';
  }
  return 'asset';
}

function getDebuggerHeaderValue(headers: DebuggerHeader[] | undefined, name: string): string {
  if (!Array.isArray(headers)) {
    return '';
  }

  const normalizedName = name.toLowerCase();
  const match = headers.find((header) => {
    return typeof header.name === 'string' && header.name.toLowerCase() === normalizedName;
  });
  return typeof match?.value === 'string' ? match.value : '';
}

const NEXT_RSC_CONTEXT_HEADERS = new Set([
  'rsc',
  'next-router-state-tree',
  'next-router-prefetch',
  'next-router-segment-prefetch',
  'next-url',
  'purpose',
]);

function selectRscRequestContextHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  const selected: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    if (NEXT_RSC_CONTEXT_HEADERS.has(normalizedName) && typeof value === 'string' && value.length > 0) {
      selected[normalizedName] = value;
    }
  }
  return Object.keys(selected).length > 0 ? selected : undefined;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function decodeCdpResponseBody(body: CdpGetResponseBodyResult): { text: string; bytes: Uint8Array } {
  const rawBody = typeof body.body === 'string' ? body.body : '';
  if (body.base64Encoded === true) {
    const bytes = base64ToBytes(rawBody);
    return {
      bytes,
      text: new TextDecoder().decode(bytes),
    };
  }

  return {
    text: rawBody,
    bytes: new TextEncoder().encode(rawBody),
  };
}

function getMethodForPausedRequest(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().toUpperCase() : 'GET';
}

async function sendResponseCaptureDebuggerCommand<T = unknown>(
  source: chrome.debugger.Debuggee,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const result = await chrome.debugger.sendCommand(source, method, params);
  return result as T;
}

async function readTextResponseWithLimit(response: Response, maxBodyBytes: number): Promise<{
  bodyText: string;
  bodyBytes: number;
  capturedBytes: number;
  truncated: boolean;
}> {
  const contentLength = Number(response.headers.get('content-length'));
  const expectedBytes = Number.isFinite(contentLength) && contentLength >= 0 ? Math.floor(contentLength) : undefined;

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    const captured = bytes.slice(0, maxBodyBytes);
    return {
      bodyText: new TextDecoder().decode(captured),
      bodyBytes: expectedBytes ?? bytes.byteLength,
      capturedBytes: captured.byteLength,
      truncated: bytes.byteLength > maxBodyBytes,
    };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let capturedBytes = 0;
  let readBytes = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      readBytes += value.byteLength;
      const remaining = maxBodyBytes - capturedBytes;
      if (remaining > 0) {
        const captured = value.byteLength > remaining ? value.slice(0, remaining) : value;
        chunks.push(captured);
        capturedBytes += captured.byteLength;
      }
      if (readBytes > maxBodyBytes || capturedBytes >= maxBodyBytes) {
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  const bodyBytes = expectedBytes ?? readBytes;
  const combined = new Uint8Array(capturedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    bodyText: new TextDecoder().decode(combined),
    bodyBytes,
    capturedBytes,
    truncated: truncated || bodyBytes > capturedBytes,
  };
}

async function captureOverrideResponseBodyWithFetch(payload: Record<string, unknown>): Promise<{ payload: Record<string, unknown>; truncated?: boolean }> {
  const targetUrl = normalizeOverrideResponseCaptureUrl(payload.targetUrl ?? payload.targetAssetUrl);
  const requestMethod = normalizeOverrideResponseCaptureMethod(payload.requestMethod);
  const requestHeaders = normalizeOverrideResponseCaptureHeaders(payload.requestHeaders);
  const maxBodyBytes = normalizeOverrideResponseCaptureBytes(payload.maxBodyBytes);
  const includeBody = payload.includeBody === true;
  const matchMode = normalizeOverrideResponseUrlMatchMode(payload.matchMode);
  if (matchMode !== 'exact') {
    throw new Error('extension-fetch response capture only supports exact matchMode.');
  }

  const response = await fetch(targetUrl, {
    method: requestMethod,
    headers: requestHeaders,
    credentials: 'include',
    cache: 'no-store',
    redirect: 'follow',
  });
  const contentType = response.headers.get('content-type') ?? '';
  const ruleType = inferOverrideResponseRuleType(response.url || targetUrl, contentType);
  const basePayload: Record<string, unknown> = {
    targetUrl,
    finalUrl: response.url || targetUrl,
    requestMethod,
    matchMode,
    captureMode: 'extension-fetch',
    source: 'extension-fetch',
    statusCode: response.status,
    ok: response.ok,
    contentType: contentType || undefined,
    ruleType,
    requestHeaders: ruleType === 'rsc-flight' ? selectRscRequestContextHeaders(requestHeaders) : undefined,
    maxBodyBytes,
  };

  if (requestMethod === 'HEAD') {
    return {
      payload: {
        ...basePayload,
        bodyCaptured: false,
        bodyBytes: Number(response.headers.get('content-length')) || undefined,
        capturedBytes: 0,
        truncated: false,
      },
    };
  }

  if (!isTextualOverrideResponseContentType(contentType)) {
    const contentLength = Number(response.headers.get('content-length'));
    return {
      payload: {
        ...basePayload,
        bodyCaptured: false,
        bodyBytes: Number.isFinite(contentLength) && contentLength >= 0 ? Math.floor(contentLength) : undefined,
        capturedBytes: 0,
        truncated: false,
      },
    };
  }

  const body = await readTextResponseWithLimit(response, maxBodyBytes);
  return {
    payload: {
      ...basePayload,
      bodyCaptured: true,
      bodyBytes: body.bodyBytes,
      capturedBytes: body.capturedBytes,
      truncated: body.truncated,
      bodyPreview: body.bodyText.slice(0, 500),
      bodyText: includeBody ? body.bodyText : undefined,
    },
    truncated: body.truncated,
  };
}

async function captureOverrideResponseBodyWithCdp(options: {
  payload: Record<string, unknown>;
  tab: chrome.tabs.Tab;
}): Promise<{ payload: Record<string, unknown>; truncated?: boolean }> {
  const { payload, tab } = options;
  const tabId = tab.id;
  if (typeof tabId !== 'number') {
    throw new Error('No capture tab is available for response body capture.');
  }

  const targetUrl = normalizeOverrideResponseCaptureUrl(payload.targetUrl ?? payload.targetAssetUrl);
  const requestMethod = normalizeOverrideResponseCaptureMethod(payload.requestMethod, {
    allowPostRscFlight: payload.ruleType === 'rsc-flight',
  });
  const matchMode = normalizeOverrideResponseUrlMatchMode(payload.matchMode);
  const requestHeaders = normalizeOverrideResponseCaptureHeaders(payload.requestHeaders);
  if (requestHeaders) {
    throw new Error('requestHeaders are only supported by extension-fetch response capture.');
  }

  const maxBodyBytes = normalizeOverrideResponseCaptureBytes(payload.maxBodyBytes);
  const timeoutMs = normalizeOverrideResponseCaptureTimeoutMs(payload.timeoutMs);
  const includeBody = payload.includeBody === true;
  const triggerReload = normalizeOverrideResponseTriggerReload(payload.triggerReload);
  const debuggee: chrome.debugger.Debuggee = { tabId };
  let attached = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let listener: ((source: chrome.debugger.Debuggee, method: string, params?: unknown) => void) | undefined;

  const cleanup = async (): Promise<void> => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
    if (listener) {
      chrome.debugger.onEvent.removeListener(listener);
      listener = undefined;
    }
    if (!attached) {
      return;
    }

    await sendResponseCaptureDebuggerCommand(debuggee, 'Fetch.disable').catch(() => undefined);
    await sendResponseCaptureDebuggerCommand(debuggee, 'Network.setCacheDisabled', { cacheDisabled: false }).catch(() => undefined);
    await sendResponseCaptureDebuggerCommand(debuggee, 'Network.setBypassServiceWorker', { bypass: false }).catch(() => undefined);
    await chrome.debugger.detach(debuggee).catch(() => undefined);
    attached = false;
  };

  const resultPromise = new Promise<{ payload: Record<string, unknown>; truncated?: boolean }>((resolve, reject) => {
    const fail = (error: unknown): void => {
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    timeoutId = setTimeout(() => {
      fail(new Error(`Timed out waiting ${timeoutMs}ms for matching in-tab response: ${targetUrl}`));
    }, timeoutMs);

    listener = (source, method, params) => {
      if (method !== 'Fetch.requestPaused' || source.tabId !== tabId) {
        return;
      }

      void (async () => {
        const paused = params as CdpResponseRequestPausedPayload | undefined;
        if (!paused) {
          return;
        }

        const requestId = paused?.requestId;
        const requestUrl = paused?.request?.url;
        const pausedMethod = getMethodForPausedRequest(paused?.request?.method);
        if (typeof requestId !== 'string' || typeof requestUrl !== 'string') {
          return;
        }

        if (!doesOverrideResponseUrlMatch(requestUrl, targetUrl, matchMode) || pausedMethod !== requestMethod) {
          await sendResponseCaptureDebuggerCommand(debuggee, 'Fetch.continueRequest', { requestId }).catch(() => undefined);
          return;
        }

        const contentType = getDebuggerHeaderValue(paused.responseHeaders, 'content-type');
        const contentLength = Number(getDebuggerHeaderValue(paused.responseHeaders, 'content-length'));
        const responseStatusCode = typeof paused.responseStatusCode === 'number' ? paused.responseStatusCode : undefined;
        const ruleType = inferOverrideResponseRuleType(requestUrl, contentType);
        const requestContextHeaders = ruleType === 'rsc-flight'
          ? selectRscRequestContextHeaders(paused.request?.headers)
          : undefined;
        const basePayload: Record<string, unknown> = {
          targetUrl,
          finalUrl: requestUrl,
          requestMethod,
          matchMode,
          captureMode: 'cdp-response',
          source: 'cdp-response',
          tabId,
          triggerReload,
          statusCode: responseStatusCode,
          ok: typeof responseStatusCode === 'number' ? responseStatusCode >= 200 && responseStatusCode < 400 : undefined,
          contentType: contentType || undefined,
          ruleType,
          requestHeaders: requestContextHeaders,
          maxBodyBytes,
        };

        try {
          if (requestMethod === 'HEAD' || !isTextualOverrideResponseContentType(contentType)) {
            await sendResponseCaptureDebuggerCommand(debuggee, 'Fetch.continueRequest', { requestId });
            resolve({
              payload: {
                ...basePayload,
                bodyCaptured: false,
                bodyBytes: Number.isFinite(contentLength) && contentLength >= 0 ? Math.floor(contentLength) : undefined,
                capturedBytes: 0,
                truncated: false,
              },
            });
            return;
          }

          const cdpBody = await sendResponseCaptureDebuggerCommand<CdpGetResponseBodyResult>(
            debuggee,
            'Fetch.getResponseBody',
            { requestId },
          );
          await sendResponseCaptureDebuggerCommand(debuggee, 'Fetch.continueRequest', { requestId });

          const decoded = decodeCdpResponseBody(cdpBody);
          const capturedBytes = Math.min(decoded.bytes.byteLength, maxBodyBytes);
          const truncated = decoded.bytes.byteLength > capturedBytes;
          const bodyText = truncated
            ? new TextDecoder().decode(decoded.bytes.slice(0, capturedBytes))
            : decoded.text;

          resolve({
            payload: {
              ...basePayload,
              bodyCaptured: true,
              bodyBytes: decoded.bytes.byteLength,
              capturedBytes,
              truncated,
              bodyPreview: bodyText.slice(0, 500),
              bodyText: includeBody ? bodyText : undefined,
            },
            truncated,
          });
        } catch (error) {
          await sendResponseCaptureDebuggerCommand(debuggee, 'Fetch.continueRequest', { requestId }).catch(() => undefined);
          fail(error);
        }
      })().catch(fail);
    };

    chrome.debugger.onEvent.addListener(listener);
  });

  try {
    await chrome.debugger.attach(debuggee, '1.3');
    attached = true;
    await sendResponseCaptureDebuggerCommand(debuggee, 'Network.enable');
    await sendResponseCaptureDebuggerCommand(debuggee, 'Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Response' }],
    });
    await sendResponseCaptureDebuggerCommand(debuggee, 'Network.setCacheDisabled', { cacheDisabled: true });
    await sendResponseCaptureDebuggerCommand(debuggee, 'Network.setBypassServiceWorker', { bypass: true });

    if (triggerReload) {
      await chrome.tabs.reload(tabId, { bypassCache: true });
    }

    return await resultPromise;
  } finally {
    await cleanup();
  }
}

function normalizeDialogWaitTimeoutMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 5_000;
  }
  return Math.min(Math.max(Math.floor(value), 100), 120_000);
}

function normalizeWaitRegex(value: unknown, fieldName: string): RegExp | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }

  try {
    return new RegExp(value);
  } catch {
    throw new Error(`${fieldName} must be a valid regular expression`);
  }
}

function matchesWaitUrl(url: string | undefined, payload: Record<string, unknown>): boolean {
  const candidate = typeof url === 'string' ? url : '';
  if (typeof payload.exactUrl === 'string' && candidate !== payload.exactUrl) {
    return false;
  }
  if (typeof payload.urlContains === 'string' && !candidate.includes(payload.urlContains)) {
    return false;
  }
  const urlRegex = normalizeWaitRegex(payload.urlRegex, 'urlRegex');
  if (urlRegex && !urlRegex.test(candidate)) {
    return false;
  }
  return true;
}

function matchesWaitFilename(filename: string | undefined, payload: Record<string, unknown>): boolean {
  const candidate = typeof filename === 'string' ? filename : '';
  if (typeof payload.filenameContains === 'string' && !candidate.includes(payload.filenameContains)) {
    return false;
  }
  const filenameRegex = normalizeWaitRegex(payload.filenameRegex, 'filenameRegex');
  if (filenameRegex && !filenameRegex.test(candidate)) {
    return false;
  }
  return true;
}

function normalizeNavigationLifecycleWaitState(
  value: unknown,
): 'commit' | 'same_document' | 'domcontentloaded' | 'load' | 'network_idle' {
  if (
    value === 'commit'
    || value === 'same_document'
    || value === 'domcontentloaded'
    || value === 'load'
    || value === 'network_idle'
  ) {
    return value;
  }
  return 'load';
}

function normalizeDownloadWaitState(value: unknown): 'started' | 'completed' {
  return value === 'completed' ? 'completed' : 'started';
}

function normalizeDialogWaitAction(value: unknown): 'none' | 'accept' | 'dismiss' {
  return value === 'accept' || value === 'dismiss' ? value : 'none';
}

function normalizeDialogWaitPromptText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizeStableLayoutWaitTimeoutMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 5_000;
  }
  return Math.min(Math.max(Math.floor(value), 100), 120_000);
}

function normalizeStableLayoutWaitStableMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 500;
  }
  return Math.min(Math.max(Math.floor(value), 100), 10_000);
}

function normalizeStableLayoutWaitPollIntervalMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 100;
  }
  return Math.min(Math.max(Math.floor(value), 50), 5_000);
}

function isRetryableStableLayoutFrameError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Frame with ID 0 was removed')
    || /No frame with id/i.test(message)
    || /frame.*removed/i.test(message);
}

function dialogMatchesWaitPayload(
  dialog: CdpJavascriptDialogOpeningPayload,
  payload: Record<string, unknown>,
): boolean {
  if (typeof payload.type === 'string' && dialog.type !== payload.type) {
    return false;
  }
  if (typeof payload.messageContains === 'string' && !String(dialog.message ?? '').includes(payload.messageContains)) {
    return false;
  }
  if (typeof payload.urlContains === 'string' && !String(dialog.url ?? '').includes(payload.urlContains)) {
    return false;
  }
  return true;
}

function describeDialogWaitObservation(
  dialog: CdpJavascriptDialogOpeningPayload,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const mismatchReasons: string[] = [];
  if (typeof payload.type === 'string' && dialog.type !== payload.type) {
    mismatchReasons.push('type');
  }
  if (typeof payload.messageContains === 'string' && !String(dialog.message ?? '').includes(payload.messageContains)) {
    mismatchReasons.push('messageContains');
  }
  if (typeof payload.urlContains === 'string' && !String(dialog.url ?? '').includes(payload.urlContains)) {
    mismatchReasons.push('urlContains');
  }
  return {
    type: dialog.type,
    message: dialog.message,
    url: dialog.url,
    frameId: dialog.frameId,
    defaultPrompt: dialog.defaultPrompt,
    matched: mismatchReasons.length === 0,
    mismatchReasons,
  };
}

async function waitForJavascriptDialogInTab(options: {
  payload: Record<string, unknown>;
  tab: chrome.tabs.Tab & { id: number };
}): Promise<{ payload: Record<string, unknown>; truncated?: boolean }> {
  const { payload, tab } = options;
  const tabId = tab.id;
  const timeoutMs = normalizeDialogWaitTimeoutMs(payload.timeoutMs);
  const action = normalizeDialogWaitAction(payload.action);
  const promptText = normalizeDialogWaitPromptText(payload.promptText);
  const debuggee: chrome.debugger.Debuggee = { tabId };
  let attached = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let listener: ((source: chrome.debugger.Debuggee, method: string, params?: unknown) => void) | undefined;
  let lastObserved: Record<string, unknown> | undefined;
  let observedCount = 0;

  const cleanup = async (): Promise<void> => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
    if (listener) {
      chrome.debugger.onEvent.removeListener(listener);
      listener = undefined;
    }
    if (!attached) {
      return;
    }
    await sendResponseCaptureDebuggerCommand(debuggee, 'Page.disable').catch(() => undefined);
    await chrome.debugger.detach(debuggee).catch(() => undefined);
    attached = false;
  };

  const resultPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
    const fail = (error: unknown): void => {
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    timeoutId = setTimeout(() => {
      resolve({
        matched: false,
        timeoutMs,
        tabId,
        url: tab.url,
        observedCount,
        expected: {
          type: payload.type,
          messageContains: payload.messageContains,
          urlContains: payload.urlContains,
        },
        lastObserved,
      });
    }, timeoutMs);

    listener = (source, method, params) => {
      if (source.tabId !== tabId || method !== 'Page.javascriptDialogOpening') {
        return;
      }

      const dialog = params as CdpJavascriptDialogOpeningPayload | undefined;
      if (!dialog) {
        return;
      }
      observedCount += 1;
      lastObserved = describeDialogWaitObservation(dialog, payload);
      if (!dialogMatchesWaitPayload(dialog, payload)) {
        return;
      }

      void (async () => {
        if (action !== 'none') {
          await sendResponseCaptureDebuggerCommand(debuggee, 'Page.handleJavaScriptDialog', {
            accept: action === 'accept',
            promptText,
          }).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.includes('No dialog is showing')) {
              throw error;
            }
          });
        }

        resolve({
          matched: true,
          timeoutMs,
          tabId,
          url: dialog.url ?? tab.url,
          frameId: dialog.frameId,
          type: dialog.type,
          message: dialog.message,
          defaultPrompt: dialog.defaultPrompt,
          action,
        });
      })().catch(fail);
    };

    chrome.debugger.onEvent.addListener(listener);
  });

  try {
    await chrome.debugger.attach(debuggee, '1.3');
    attached = true;
    await sendResponseCaptureDebuggerCommand(debuggee, 'Page.enable');
    return {
      payload: await resultPromise,
      truncated: false,
    };
  } finally {
    await cleanup();
  }
}

async function waitForStableLayoutInTab(options: {
  payload: Record<string, unknown>;
  tab: chrome.tabs.Tab & { id: number };
}): Promise<{ payload: Record<string, unknown>; truncated?: boolean }> {
  const { payload, tab } = options;
  const selector = typeof payload.selector === 'string' ? payload.selector : undefined;
  const stableMs = normalizeStableLayoutWaitStableMs(payload.stableMs);
  const timeoutMs = normalizeStableLayoutWaitTimeoutMs(payload.timeoutMs);
  const pollIntervalMs = normalizeStableLayoutWaitPollIntervalMs(payload.pollIntervalMs);
  const runStableLayoutProbe = (): Promise<Record<string, unknown>> => executeScriptInTab<Record<string, unknown>>(
    tab.id,
    (selectorArg, stableMsArg, timeoutMsArg, pollIntervalMsArg) => {
      const selectorValue = typeof selectorArg === 'string' ? selectorArg : undefined;
      const stableWindowMs = typeof stableMsArg === 'number' ? stableMsArg : 500;
      const timeoutWindowMs = typeof timeoutMsArg === 'number' ? timeoutMsArg : 5_000;
      const pollWindowMs = typeof pollIntervalMsArg === 'number' ? pollIntervalMsArg : 100;

      return new Promise<Record<string, unknown>>((resolve) => {
        const startedAt = Date.now();
        const deadline = startedAt + timeoutWindowMs;
        let lastChangedAt = startedAt;
        let lastReason = 'initial';
        let lastFingerprint = '';
        let lastSnapshot: Record<string, unknown> = {};
        let attempts = 0;
        let layoutShiftCount = 0;
        let layoutShiftScore = 0;
        let intervalId: ReturnType<typeof setInterval> | undefined;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        let mutationObserver: MutationObserver | undefined;
        let performanceObserver: PerformanceObserver | undefined;

        const cleanup = (): void => {
          if (intervalId) {
            clearInterval(intervalId);
            intervalId = undefined;
          }
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = undefined;
          }
          mutationObserver?.disconnect();
          performanceObserver?.disconnect();
        };

        const captureSnapshot = (): Record<string, unknown> => {
          const root = document.documentElement;
          const body = document.body;
          const target = selectorValue ? document.querySelector(selectorValue) : undefined;
          const targetRect = target instanceof Element ? target.getBoundingClientRect() : undefined;
          return {
            url: window.location.href,
            readyState: document.readyState,
            viewport: {
              width: window.innerWidth,
              height: window.innerHeight,
              scrollX: Math.round(window.scrollX),
              scrollY: Math.round(window.scrollY),
            },
            document: {
              scrollWidth: root?.scrollWidth ?? body?.scrollWidth ?? 0,
              scrollHeight: root?.scrollHeight ?? body?.scrollHeight ?? 0,
              bodyWidth: body?.getBoundingClientRect().width ?? 0,
              bodyHeight: body?.getBoundingClientRect().height ?? 0,
            },
            target: selectorValue
              ? {
                  selector: selectorValue,
                  found: target instanceof Element,
                  rect: targetRect
                    ? {
                        x: Number(targetRect.x.toFixed(2)),
                        y: Number(targetRect.y.toFixed(2)),
                        width: Number(targetRect.width.toFixed(2)),
                        height: Number(targetRect.height.toFixed(2)),
                      }
                    : undefined,
                }
              : undefined,
          };
        };

        const finish = (matched: boolean): void => {
          cleanup();
          resolve({
            matched,
            selector: selectorValue,
            stableMs: stableWindowMs,
            timeoutMs: timeoutWindowMs,
            pollIntervalMs: pollWindowMs,
            waitedMs: Date.now() - startedAt,
            attempts,
            lastChangedAt,
            quietForMs: Math.max(0, Date.now() - lastChangedAt),
            lastReason,
            layoutShiftCount,
            layoutShiftScore: Number(layoutShiftScore.toFixed(4)),
            snapshot: lastSnapshot,
          });
        };

        const sample = (): void => {
          requestAnimationFrame(() => {
            attempts += 1;
            lastSnapshot = captureSnapshot();
            const target = lastSnapshot.target as { found?: boolean } | undefined;
            const fingerprint = JSON.stringify(lastSnapshot);
            if (selectorValue && target?.found !== true) {
              lastChangedAt = Date.now();
              lastReason = 'target_not_found';
            } else if (fingerprint !== lastFingerprint) {
              lastChangedAt = Date.now();
              lastReason = 'layout_snapshot_changed';
              lastFingerprint = fingerprint;
            }

            if (Date.now() - lastChangedAt >= stableWindowMs) {
              finish(true);
            } else if (Date.now() >= deadline) {
              finish(false);
            }
          });
        };

        mutationObserver = new MutationObserver(() => {
          lastChangedAt = Date.now();
          lastReason = 'dom_mutation';
        });
        mutationObserver.observe(document.documentElement, {
          attributes: true,
          childList: true,
          characterData: true,
          subtree: true,
        });

        if (typeof PerformanceObserver === 'function') {
          try {
            performanceObserver = new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                const layoutEntry = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
                if (layoutEntry.hadRecentInput === true) {
                  continue;
                }
                layoutShiftCount += 1;
                layoutShiftScore += typeof layoutEntry.value === 'number' ? layoutEntry.value : 0;
                lastChangedAt = Date.now();
                lastReason = 'layout_shift';
              }
            });
            performanceObserver.observe({ type: 'layout-shift', buffered: true });
          } catch {
            performanceObserver = undefined;
          }
        }

        sample();
        intervalId = setInterval(sample, pollWindowMs);
        timeoutId = setTimeout(() => finish(false), timeoutWindowMs);
      });
    },
    [selector, stableMs, timeoutMs, pollIntervalMs],
  );
  let result: Record<string, unknown>;
  try {
    result = await runStableLayoutProbe();
  } catch (error) {
    if (!isRetryableStableLayoutFrameError(error)) {
      throw error;
    }
    await sleep(100);
    result = await runStableLayoutProbe();
  }

  return {
    payload: {
      tabId: tab.id,
      url: tab.url,
      ...result,
    },
    truncated: false,
  };
}

async function waitForNavigationLifecycleInTab(options: {
  payload: Record<string, unknown>;
  tab: chrome.tabs.Tab & { id: number };
}): Promise<{ payload: Record<string, unknown>; truncated?: boolean }> {
  const { payload, tab } = options;
  normalizeWaitRegex(payload.urlRegex, 'urlRegex');
  const tabId = tab.id;
  const timeoutMs = normalizeDialogWaitTimeoutMs(payload.timeoutMs);
  const state = normalizeNavigationLifecycleWaitState(payload.state);
  const debuggee: chrome.debugger.Debuggee = { tabId };
  let attached = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let listener: ((source: chrome.debugger.Debuggee, method: string, params?: unknown) => void) | undefined;
  let mainFrameId: string | undefined;
  let lastObserved: Record<string, unknown> | undefined;
  let observedEventCount = 0;

  const cleanup = async (): Promise<void> => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
    if (listener) {
      chrome.debugger.onEvent.removeListener(listener);
      listener = undefined;
    }
    if (!attached) {
      return;
    }
    await sendResponseCaptureDebuggerCommand(debuggee, 'Page.disable').catch(() => undefined);
    await chrome.debugger.detach(debuggee).catch(() => undefined);
    attached = false;
  };

  const resolveMatch = async (
    resolve: (value: Record<string, unknown>) => void,
    event: Record<string, unknown>,
  ): Promise<void> => {
    const liveTab = await chrome.tabs.get(tabId).catch(() => undefined);
    const resolvedUrl = typeof event.url === 'string'
      ? event.url
      : liveTab?.pendingUrl ?? liveTab?.url ?? tab.url;
    lastObserved = {
      ...event,
      url: resolvedUrl,
      matched: matchesWaitUrl(resolvedUrl, payload),
    };
    if (!matchesWaitUrl(resolvedUrl, payload)) {
      return;
    }

    resolve({
      matched: true,
      state,
      timeoutMs,
      tabId,
      url: resolvedUrl,
      ...event,
    });
  };

  const resultPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
    const fail = (error: unknown): void => {
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    timeoutId = setTimeout(() => {
      resolve({
        matched: false,
        state,
        timeoutMs,
        tabId,
        url: tab.url,
        observedEventCount,
        expected: {
          state,
          urlContains: payload.urlContains,
          urlRegex: payload.urlRegex,
          exactUrl: payload.exactUrl,
        },
        lastObserved,
      });
    }, timeoutMs);

    listener = (source, method, params) => {
      if (source.tabId !== tabId) {
        return;
      }

      void (async () => {
        if (state === 'commit' && method === 'Page.frameNavigated') {
          const event = params as CdpFrameNavigatedPayload | undefined;
          const frame = event?.frame;
          if (!frame || frame.parentId) {
            return;
          }
          observedEventCount += 1;
          mainFrameId = frame.id ?? mainFrameId;
          await resolveMatch(resolve, {
            state,
            frameId: frame.id,
            loaderId: frame.loaderId,
            eventMethod: method,
            url: frame.url,
          });
          return;
        }

        if (state === 'same_document' && method === 'Page.navigatedWithinDocument') {
          const event = params as CdpNavigatedWithinDocumentPayload | undefined;
          if (!event) {
            return;
          }
          observedEventCount += 1;
          if (mainFrameId && event.frameId && event.frameId !== mainFrameId) {
            lastObserved = {
              state,
              frameId: event.frameId,
              navigationType: event.navigationType,
              eventMethod: method,
              url: event.url,
              matched: false,
              mismatchReasons: ['mainFrameId'],
            };
            return;
          }
          await resolveMatch(resolve, {
            state,
            frameId: event.frameId,
            navigationType: event.navigationType,
            eventMethod: method,
            url: event.url,
          });
          return;
        }

        if (state === 'domcontentloaded' && method === 'Page.domContentEventFired') {
          observedEventCount += 1;
          await resolveMatch(resolve, {
            state,
            eventMethod: method,
          });
          return;
        }

        if (state === 'load' && method === 'Page.loadEventFired') {
          observedEventCount += 1;
          await resolveMatch(resolve, {
            state,
            eventMethod: method,
          });
          return;
        }

        if (state === 'network_idle' && method === 'Page.lifecycleEvent') {
          const event = params as CdpLifecycleEventPayload | undefined;
          if (!event || event.name !== 'networkIdle') {
            return;
          }
          observedEventCount += 1;
          if (mainFrameId && event.frameId && event.frameId !== mainFrameId) {
            lastObserved = {
              state,
              frameId: event.frameId,
              loaderId: event.loaderId,
              lifecycleName: event.name,
              timestamp: event.timestamp,
              eventMethod: method,
              matched: false,
              mismatchReasons: ['mainFrameId'],
            };
            return;
          }
          await resolveMatch(resolve, {
            state,
            frameId: event.frameId,
            loaderId: event.loaderId,
            lifecycleName: event.name,
            timestamp: event.timestamp,
            eventMethod: method,
          });
        }
      })().catch(fail);
    };

    chrome.debugger.onEvent.addListener(listener);
  });

  try {
    await chrome.debugger.attach(debuggee, '1.3');
    attached = true;
    await sendResponseCaptureDebuggerCommand(debuggee, 'Page.enable');
    await sendResponseCaptureDebuggerCommand(debuggee, 'Page.setLifecycleEventsEnabled', { enabled: true }).catch(() => undefined);
    const frameTree = await sendResponseCaptureDebuggerCommand<CdpFrameTreeResult>(debuggee, 'Page.getFrameTree').catch(() => undefined);
    mainFrameId = frameTree?.frameTree?.frame?.id;
    return {
      payload: await resultPromise,
      truncated: false,
    };
  } finally {
    await cleanup();
  }
}

async function waitForDownloadInTab(options: {
  payload: Record<string, unknown>;
  tab: chrome.tabs.Tab & { id: number };
}): Promise<{ payload: Record<string, unknown>; truncated?: boolean }> {
  const { payload, tab } = options;
  normalizeWaitRegex(payload.urlRegex, 'urlRegex');
  normalizeWaitRegex(payload.filenameRegex, 'filenameRegex');
  const tabId = tab.id;
  const timeoutMs = normalizeDialogWaitTimeoutMs(payload.timeoutMs);
  const state = normalizeDownloadWaitState(payload.state);
  const debuggee: chrome.debugger.Debuggee = { tabId };
  let attached = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let listener: ((source: chrome.debugger.Debuggee, method: string, params?: unknown) => void) | undefined;
  let matchedDownload: Record<string, unknown> | undefined;
  let lastObserved: Record<string, unknown> | undefined;
  let observedEventCount = 0;

  const cleanup = async (): Promise<void> => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
    if (listener) {
      chrome.debugger.onEvent.removeListener(listener);
      listener = undefined;
    }
    if (!attached) {
      return;
    }
    await sendResponseCaptureDebuggerCommand(debuggee, 'Page.disable').catch(() => undefined);
    await chrome.debugger.detach(debuggee).catch(() => undefined);
    attached = false;
  };

  const resultPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
    const fail = (error: unknown): void => {
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    timeoutId = setTimeout(() => {
      resolve({
        matched: false,
        state,
        timeoutMs,
        tabId,
        url: tab.url,
        observedEventCount,
        expected: {
          state,
          urlContains: payload.urlContains,
          urlRegex: payload.urlRegex,
          exactUrl: payload.exactUrl,
          filenameContains: payload.filenameContains,
          filenameRegex: payload.filenameRegex,
        },
        lastObserved,
        lastMatchedDownload: matchedDownload,
      });
    }, timeoutMs);

    listener = (source, method, params) => {
      if (source.tabId !== tabId) {
        return;
      }

      void (async () => {
        if (method === 'Page.downloadWillBegin') {
          const event = params as CdpDownloadWillBeginPayload | undefined;
          if (!event) {
            return;
          }
          observedEventCount += 1;
          const urlMatched = matchesWaitUrl(event.url, payload);
          const filenameMatched = matchesWaitFilename(event.suggestedFilename, payload);
          lastObserved = {
            eventMethod: method,
            guid: event.guid,
            frameId: event.frameId,
            url: event.url,
            suggestedFilename: event.suggestedFilename,
            state: 'started',
            matched: urlMatched && filenameMatched,
            mismatchReasons: [
              ...(urlMatched ? [] : ['url']),
              ...(filenameMatched ? [] : ['filename']),
            ],
          };
          if (!urlMatched || !filenameMatched) {
            return;
          }

          matchedDownload = {
            guid: event.guid,
            frameId: event.frameId,
            url: event.url,
            suggestedFilename: event.suggestedFilename,
            state: 'started',
          };

          if (state === 'started') {
            resolve({
              matched: true,
              timeoutMs,
              tabId,
              ...matchedDownload,
            });
          }
          return;
        }

        if (method === 'Page.downloadProgress') {
          const event = params as CdpDownloadProgressPayload | undefined;
          if (!event || !matchedDownload || event.guid !== matchedDownload.guid || state !== 'completed') {
            return;
          }
          observedEventCount += 1;
          lastObserved = {
            eventMethod: method,
            guid: event.guid,
            state: event.state,
            totalBytes: event.totalBytes,
            receivedBytes: event.receivedBytes,
            matched: event.state === 'completed',
          };

          if (event.state === 'completed') {
            resolve({
              matched: true,
              timeoutMs,
              tabId,
              ...matchedDownload,
              state: 'completed',
              totalBytes: event.totalBytes,
              receivedBytes: event.receivedBytes,
            });
          }
        }
      })().catch(fail);
    };

    chrome.debugger.onEvent.addListener(listener);
  });

  try {
    await chrome.debugger.attach(debuggee, '1.3');
    attached = true;
    await sendResponseCaptureDebuggerCommand(debuggee, 'Page.enable');
    return {
      payload: await resultPromise,
      truncated: false,
    };
  } finally {
    await cleanup();
  }
}

async function waitForPopupFromTab(options: {
  payload: Record<string, unknown>;
  sessionId: string;
  tab: chrome.tabs.Tab & { id: number };
}): Promise<{ payload: Record<string, unknown>; truncated?: boolean }> {
  const { payload, sessionId, tab } = options;
  normalizeWaitRegex(payload.urlRegex, 'urlRegex');
  const openerTabId = typeof payload.openerTabId === 'number' ? payload.openerTabId : tab.id;
  const timeoutMs = normalizeDialogWaitTimeoutMs(payload.timeoutMs);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let createdListener: ((createdTab: chrome.tabs.Tab) => void) | undefined;
  let updatedListener: ((tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, updatedTab: chrome.tabs.Tab) => void) | undefined;
  const pendingTabs = new Set<number>();
  let lastObserved: Record<string, unknown> | undefined;
  let observedPopupCount = 0;

  const cleanup = (): void => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
    if (createdListener) {
      chrome.tabs.onCreated.removeListener(createdListener);
      createdListener = undefined;
    }
    if (updatedListener) {
      chrome.tabs.onUpdated.removeListener(updatedListener);
      updatedListener = undefined;
    }
  };

  const matchPopup = (resolve: (value: Record<string, unknown>) => void, popupTab: chrome.tabs.Tab): boolean => {
    if (popupTab.openerTabId !== openerTabId) {
      lastObserved = {
        tabId: popupTab.id,
        openerTabId: popupTab.openerTabId,
        windowId: popupTab.windowId,
        url: popupTab.pendingUrl ?? popupTab.url,
        matched: false,
        mismatchReasons: ['openerTabId'],
      };
      return false;
    }

    const url = popupTab.pendingUrl ?? popupTab.url;
    const hasUrlPredicate = typeof payload.exactUrl === 'string'
      || typeof payload.urlContains === 'string'
      || typeof payload.urlRegex === 'string';
    if (hasUrlPredicate && !matchesWaitUrl(url, payload)) {
      lastObserved = {
        tabId: popupTab.id,
        openerTabId,
        windowId: popupTab.windowId,
        url,
        matched: false,
        mismatchReasons: ['url'],
      };
      return false;
    }

    addTabToSessionScope(sessionId, popupTab);
    rememberCaptureTabForSession(sessionId, popupTab);
    resolve({
      matched: true,
      timeoutMs,
      tabId: popupTab.id,
      openerTabId,
      windowId: popupTab.windowId,
      url,
    });
    return true;
  };

  const resultPromise = new Promise<Record<string, unknown>>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve({
        matched: false,
        timeoutMs,
        openerTabId,
        observedPopupCount,
        pendingTabIds: Array.from(pendingTabs),
        expected: {
          urlContains: payload.urlContains,
          urlRegex: payload.urlRegex,
          exactUrl: payload.exactUrl,
          openerTabId,
        },
        lastObserved,
      });
    }, timeoutMs);

    createdListener = (createdTab) => {
      if (createdTab.openerTabId !== openerTabId || typeof createdTab.id !== 'number') {
        return;
      }
      observedPopupCount += 1;

      if (matchPopup(resolve, createdTab)) {
        return;
      }

      pendingTabs.add(createdTab.id);
    };

    updatedListener = (updatedTabId, _changeInfo, updatedTab) => {
      if (!pendingTabs.has(updatedTabId) && updatedTab.openerTabId !== openerTabId) {
        return;
      }
      observedPopupCount += 1;

      if (matchPopup(resolve, updatedTab)) {
        pendingTabs.delete(updatedTabId);
      }
    };

    chrome.tabs.onCreated.addListener(createdListener);
    chrome.tabs.onUpdated.addListener(updatedListener);
  });

  try {
    return {
      payload: await resultPromise,
      truncated: false,
    };
  } finally {
    cleanup();
  }
}

async function observeOverrideAssetsInTab(tabId: number, includePerformance = true): Promise<ObservedOverrideAssetsResult> {
  return executeScriptInTab<ObservedOverrideAssetsResult>(tabId, (includePerformanceArg) => {
    const shouldIncludePerformance = includePerformanceArg !== false;
    const assets = new Map<string, ObservedOverrideAsset>();

    const toAbsoluteUrl = (value: string | null): string | null => {
      if (!value) {
        return null;
      }
      try {
        return new URL(value, window.location.href).toString();
      } catch {
        return null;
      }
    };

    const addAsset = (asset: ObservedOverrideAsset): void => {
      const existing = assets.get(asset.url);
      if (existing) {
        existing.ruleType = existing.ruleType ?? asset.ruleType;
        existing.requestMethod = existing.requestMethod ?? asset.requestMethod;
        existing.resourceType = existing.resourceType ?? asset.resourceType;
        existing.contentType = existing.contentType ?? asset.contentType;
        existing.statusCode = existing.statusCode ?? asset.statusCode;
        existing.fromDom = existing.fromDom || asset.fromDom;
        existing.fromPerformance = existing.fromPerformance || asset.fromPerformance;
        existing.fromNavigation = existing.fromNavigation || asset.fromNavigation;
        existing.fromFetch = existing.fromFetch || asset.fromFetch;
        existing.integrity = existing.integrity ?? asset.integrity;
        existing.crossOrigin = existing.crossOrigin ?? asset.crossOrigin;
        existing.nonce = existing.nonce ?? asset.nonce;
        existing.rel = existing.rel ?? asset.rel;
        existing.as = existing.as ?? asset.as;
        existing.initiatorType = existing.initiatorType ?? asset.initiatorType;
        return;
      }

      assets.set(asset.url, asset);
    };

    const classifyRuleType = (
      url: string,
      kind: string,
      initiatorType?: string,
      contentType?: string,
    ): ObservedOverrideAsset['ruleType'] => {
      const parsed = new URL(url, window.location.href);
      const normalizedKind = kind.toLowerCase();
      const normalizedInitiator = (initiatorType ?? '').toLowerCase();
      const normalizedContentType = (contentType ?? '').toLowerCase();
      if (normalizedKind === 'document') {
        return 'document';
      }
      if (normalizedContentType.includes('text/x-component') || parsed.searchParams.has('_rsc')) {
        return 'rsc-flight';
      }
      if (parsed.pathname.includes('/_next/data/')) {
        return 'next-data';
      }
      if (parsed.pathname.includes('/_next/static/')) {
        return 'asset';
      }
      if (normalizedInitiator === 'fetch' || normalizedInitiator === 'xmlhttprequest' || normalizedKind === 'fetch') {
        return 'api-response';
      }
      return 'asset';
    };

    const navigationEntry = performance.getEntriesByType('navigation')[0] as (PerformanceNavigationTiming & { responseStatus?: number }) | undefined;
    addAsset({
      url: window.location.href,
      kind: 'document',
      ruleType: 'document',
      requestMethod: 'GET',
      resourceType: 'document',
      statusCode: typeof navigationEntry?.responseStatus === 'number' ? navigationEntry.responseStatus : undefined,
      fromDom: false,
      fromPerformance: true,
      fromNavigation: true,
      fromFetch: false,
    });

    for (const script of Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]'))) {
      const url = toAbsoluteUrl(script.getAttribute('src'));
      if (!url) {
        continue;
      }
      addAsset({
        url,
        kind: script.type === 'module' ? 'module-script' : 'script',
        ruleType: 'asset',
        requestMethod: 'GET',
        resourceType: 'script',
        integrity: script.integrity || undefined,
        crossOrigin: script.crossOrigin || undefined,
        nonce: script.nonce || undefined,
        fromDom: true,
        fromPerformance: false,
      });
    }

    for (const link of Array.from(document.querySelectorAll<HTMLLinkElement>('link[href]'))) {
      const rel = link.rel || link.getAttribute('rel') || '';
      const relTokens = rel.toLowerCase().split(/\s+/).filter(Boolean);
      if (!relTokens.some((entry) => ['stylesheet', 'preload', 'modulepreload'].includes(entry))) {
        continue;
      }

      const url = toAbsoluteUrl(link.getAttribute('href'));
      if (!url) {
        continue;
      }
      addAsset({
        url,
        kind: relTokens.includes('stylesheet') ? 'stylesheet' : relTokens.includes('modulepreload') ? 'modulepreload' : 'preload',
        ruleType: 'asset',
        requestMethod: 'GET',
        resourceType: relTokens.includes('stylesheet') ? 'style' : 'link',
        rel,
        as: link.as || undefined,
        integrity: link.integrity || undefined,
        crossOrigin: link.crossOrigin || undefined,
        nonce: link.nonce || undefined,
        fromDom: true,
        fromPerformance: false,
      });
    }

    if (shouldIncludePerformance) {
      for (const entry of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) {
        const url = toAbsoluteUrl(entry.name);
        if (!url) {
          continue;
        }
        const initiatorType = entry.initiatorType || undefined;
        const parsed = new URL(url, window.location.href);
        const isNextResource = parsed.pathname.includes('/_next/') || parsed.searchParams.has('_rsc');
        const isFetchLike = initiatorType === 'fetch' || initiatorType === 'xmlhttprequest';
        if (!isNextResource && !isFetchLike && !['script', 'link', 'css'].includes(entry.initiatorType)) {
          continue;
        }
        const ruleType = classifyRuleType(url, initiatorType || 'resource', initiatorType);
        addAsset({
          url,
          kind: initiatorType || 'resource',
          ruleType,
          requestMethod: 'GET',
          resourceType: initiatorType,
          statusCode: typeof (entry as { responseStatus?: number }).responseStatus === 'number'
            ? (entry as { responseStatus: number }).responseStatus
            : undefined,
          initiatorType,
          fromDom: false,
          fromPerformance: true,
          fromNavigation: false,
          fromFetch: isFetchLike,
        });
      }
    }

    const cspMetaTags = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[http-equiv]'))
      .filter((meta) => meta.httpEquiv.toLowerCase() === 'content-security-policy')
      .map((meta) => meta.content)
      .filter((content) => content.length > 0);

    return {
      pageUrl: window.location.href,
      baseUrl: window.location.origin,
      title: document.title,
      serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller),
      cspMetaTags,
      assets: Array.from(assets.values()).sort((first, second) => first.url.localeCompare(second.url)),
    };
  }, [includePerformance]);
}

async function getFullPageCaptureMetrics(tabId: number): Promise<FullPageCaptureMetrics> {
  return executeScriptInTab<FullPageCaptureMetrics>(tabId, () => {
    const doc = document.documentElement;
    const body = document.body;
    const scrolling = document.scrollingElement;

    const totalWidth = Math.max(
      window.innerWidth,
      doc?.scrollWidth ?? 0,
      doc?.clientWidth ?? 0,
      body?.scrollWidth ?? 0,
      body?.clientWidth ?? 0,
      scrolling?.scrollWidth ?? 0,
      scrolling?.clientWidth ?? 0,
    );

    const totalHeight = Math.max(
      window.innerHeight,
      doc?.scrollHeight ?? 0,
      doc?.clientHeight ?? 0,
      body?.scrollHeight ?? 0,
      body?.clientHeight ?? 0,
      scrolling?.scrollHeight ?? 0,
      scrolling?.clientHeight ?? 0,
    );

    return {
      totalWidth,
      totalHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      originalScrollX: window.scrollX,
      originalScrollY: window.scrollY,
    };
  });
}

async function scrollTabTo(tabId: number, left: number, top: number): Promise<{ x: number; y: number }> {
  return executeScriptInTab<{ x: number; y: number }>(tabId, (leftArg, topArg) => {
    const safeLeft = typeof leftArg === 'number' ? leftArg : 0;
    const safeTop = typeof topArg === 'number' ? topArg : 0;
    window.scrollTo(safeLeft, safeTop);
    return {
      x: window.scrollX,
      y: window.scrollY,
    };
  }, [left, top]);
}

async function dataUrlToImageBitmap(dataUrl: string): Promise<ImageBitmap> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return createImageBitmap(blob);
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

async function offscreenCanvasToPngDataUrl(canvas: OffscreenCanvas): Promise<string> {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const encoded = bytesToBase64(bytes);
  return `data:image/png;base64,${encoded}`;
}

function drawTileOnCanvas(
  context: OffscreenCanvasRenderingContext2D,
  bitmap: ImageBitmap,
  captureX: number,
  captureY: number,
  scaleX: number,
  scaleY: number,
  renderScale: number,
): void {
  const destinationX = Math.max(0, Math.round(captureX * scaleX * renderScale));
  const destinationY = Math.max(0, Math.round(captureY * scaleY * renderScale));
  const destinationWidth = Math.max(1, Math.round(bitmap.width * renderScale));
  const destinationHeight = Math.max(1, Math.round(bitmap.height * renderScale));
  context.drawImage(bitmap, destinationX, destinationY, destinationWidth, destinationHeight);
}

async function captureFullPageTabPng(tab: chrome.tabs.Tab): Promise<FullPageCaptureResult> {
  if (typeof tab.id !== 'number') {
    throw new Error('Tab id is required for PNG capture');
  }

  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') {
    const viewportDataUrl = await captureVisibleTabPng(tab.windowId);
    const viewportByteLength = estimateDataUrlBytes(viewportDataUrl);
    return {
      dataUrl: viewportDataUrl,
      byteLength: viewportByteLength,
      fullPage: false,
      pageWidth: tab.width ?? 0,
      pageHeight: tab.height ?? 0,
      viewportWidth: tab.width ?? 0,
      viewportHeight: tab.height ?? 0,
      tiles: 1,
      downscaled: false,
    };
  }

  const tabId = tab.id;
  const metrics = await getFullPageCaptureMetrics(tabId);
  const xOffsets = buildCaptureOffsets(metrics.totalWidth, metrics.viewportWidth);
  const yOffsets = buildCaptureOffsets(metrics.totalHeight, metrics.viewportHeight);

  let canvas: OffscreenCanvas | null = null;
  let context: OffscreenCanvasRenderingContext2D | null = null;
  let scaleX = 1;
  let scaleY = 1;
  let renderScale = 1;
  let downscaled = false;
  let tiles = 0;

  try {
    for (const y of yOffsets) {
      for (const x of xOffsets) {
        const scrolled = await scrollTabTo(tabId, x, y);
        await sleep(FULL_PAGE_CAPTURE_SCROLL_SETTLE_MS);

        const tileDataUrl = await captureVisibleTabPng(tab.windowId);
        const bitmap = await dataUrlToImageBitmap(tileDataUrl);
        tiles += 1;

        if (!canvas || !context) {
          scaleX = metrics.viewportWidth > 0 ? bitmap.width / metrics.viewportWidth : 1;
          scaleY = metrics.viewportHeight > 0 ? bitmap.height / metrics.viewportHeight : 1;
          if (!Number.isFinite(scaleX) || scaleX <= 0) {
            scaleX = 1;
          }
          if (!Number.isFinite(scaleY) || scaleY <= 0) {
            scaleY = 1;
          }

          const stitchedWidthRaw = Math.max(1, Math.round(metrics.totalWidth * scaleX));
          const stitchedHeightRaw = Math.max(1, Math.round(metrics.totalHeight * scaleY));
          const pixelCount = stitchedWidthRaw * stitchedHeightRaw;

          if (pixelCount > MAX_STITCHED_PNG_PIXELS) {
            renderScale = Math.sqrt(MAX_STITCHED_PNG_PIXELS / pixelCount);
            downscaled = true;
          }

          const stitchedWidth = Math.max(1, Math.round(stitchedWidthRaw * renderScale));
          const stitchedHeight = Math.max(1, Math.round(stitchedHeightRaw * renderScale));
          canvas = new OffscreenCanvas(stitchedWidth, stitchedHeight);
          context = canvas.getContext('2d');
          if (!context) {
            bitmap.close();
            throw new Error('Failed to initialize full-page PNG canvas');
          }
        }

        drawTileOnCanvas(context, bitmap, scrolled.x, scrolled.y, scaleX, scaleY, renderScale);
        bitmap.close();
      }
    }
  } finally {
    await scrollTabTo(tabId, metrics.originalScrollX, metrics.originalScrollY).catch(() => undefined);
  }

  if (!canvas) {
    throw new Error('Full-page capture produced no tiles');
  }

  const dataUrl = await offscreenCanvasToPngDataUrl(canvas);
  return {
    dataUrl,
    byteLength: estimateDataUrlBytes(dataUrl),
    fullPage: true,
    pageWidth: metrics.totalWidth,
    pageHeight: metrics.totalHeight,
    viewportWidth: metrics.viewportWidth,
    viewportHeight: metrics.viewportHeight,
    tiles,
    downscaled,
  };
}

function rememberCaptureTabForSession(sessionId: string, tab: chrome.tabs.Tab): void {
  if (typeof tab.id !== 'number') {
    return;
  }
  captureTabBySession.set(sessionId, {
    tabId: tab.id,
    windowId: typeof tab.windowId === 'number' ? tab.windowId : undefined,
  });
  void persistSessionBindings(chrome.storage.local);
}

async function resolveCaptureTab(sessionId: string): Promise<chrome.tabs.Tab | undefined> {
  await sessionBindingsReady;
  const scope = getSessionTabScope(sessionId);
  const allowedTabIds = scope ? Array.from(scope.allowedTabIds) : [];

  const active = await getActiveTab();
  const remembered = captureTabBySession.get(sessionId);
  const candidateTabIds = buildPreferredCaptureTabIds({
    activeTabId: typeof active?.id === 'number' ? active.id : undefined,
    rememberedTabId: remembered?.tabId,
    allowedTabIds,
    allowActiveTab: scope !== undefined,
  });

  for (const candidateTabId of candidateTabIds) {
    if (scope && !scope.allowedTabIds.has(candidateTabId)) {
      continue;
    }
    try {
      const tab = await chrome.tabs.get(candidateTabId);
      if (tab && typeof tab.id === 'number') {
        rememberCaptureTabForSession(sessionId, tab);
        return tab;
      }
    } catch {
      if (scope) {
        scope.allowedTabIds.delete(candidateTabId);
        void persistSessionBindings(chrome.storage.local);
      }
    }
  }

  return undefined;
}

function isMissingCaptureReceiverError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes('could not establish connection')
    || normalized.includes('receiving end does not exist');
}

async function sendCaptureCommandToTab(
  tabId: number,
  command: CaptureCommandType,
  payload: Record<string, unknown>,
  allowRetry: boolean = true,
  frameId?: number,
): Promise<{ payload: Record<string, unknown>; truncated?: boolean }> {
  const attempt = async (): Promise<{ payload: Record<string, unknown>; truncated?: boolean }> => {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(
        tabId,
        {
          type: 'CAPTURE_EXECUTE',
          command,
          payload,
        },
        typeof frameId === 'number' ? { frameId } : undefined,
        (response?: CaptureTabResponse) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message));
            return;
          }

          if (!response) {
            reject(new Error('No capture response from content script'));
            return;
          }

          if (!response.ok) {
            reject(new Error(response.error ?? 'Capture command failed'));
            return;
          }

          resolve({
            payload: response.result ?? {},
            truncated: response.truncated,
          });
        }
      );
    });
  };

  try {
    return await attempt();
  } catch (error) {
    if (!allowRetry || !isMissingCaptureReceiverError(error)) {
      throw error;
    }

    const recovered = await ensureContentScriptReady(tabId, frameId ?? 0);
    if (!recovered) {
      throw new Error('Extension target is unavailable after recovery attempt');
    }

    return attempt();
  }
}

interface FrameCaptureMetadata {
  frameId: number;
  url?: string;
  title?: string;
  frameSelector?: string;
  origin?: string;
  isOpaqueOrigin?: boolean;
  parentAccessible?: boolean;
  parentUrl?: string;
  topAccessible?: boolean;
  sameOriginWithTop?: boolean;
  sandboxFlags?: string[];
  automationSupport?: 'native' | 'diagnostic-only';
  automationUnsupportedReason?: string;
}

interface FrameElementMetadata {
  index: number;
  src?: string;
  resolvedUrl?: string;
  title?: string;
  name?: string;
  id?: string;
  selectorPath?: string;
  sandboxFlags?: string[];
  hasSrcdoc?: boolean;
}

function isFrameElementMetadata(value: unknown): value is FrameElementMetadata {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { index?: unknown }).index === 'number';
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => {
        return Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry);
      })
    : [];
}

function resolveFrameMetadataUrl(frame: FrameCaptureMetadata | undefined, fallback?: unknown): string | undefined {
  if (typeof frame?.url === 'string' && frame.url.length > 0) {
    return frame.url;
  }
  return typeof fallback === 'string' && fallback.length > 0 ? fallback : undefined;
}

function resolveFrameAutomationPolicy(frame: FrameCaptureMetadata): Pick<FrameCaptureMetadata, 'automationSupport' | 'automationUnsupportedReason'> {
  if (frame.frameId === 0) {
    return {
      automationSupport: 'native',
    };
  }

  const sandboxWithoutSameOrigin = frame.sandboxFlags !== undefined && !frame.sandboxFlags.includes('allow-same-origin');
  if (frame.isOpaqueOrigin === true || sandboxWithoutSameOrigin) {
    return {
      automationSupport: 'diagnostic-only',
      automationUnsupportedReason: 'sandboxed_opaque_origin',
    };
  }

  if (frame.sameOriginWithTop === false || frame.topAccessible === false) {
    return {
      automationSupport: 'diagnostic-only',
      automationUnsupportedReason: 'cross_origin_with_top',
    };
  }

  return {
    automationSupport: 'native',
  };
}

function withFrameAutomationPolicy(frame: FrameCaptureMetadata): FrameCaptureMetadata {
  return {
    ...frame,
    ...resolveFrameAutomationPolicy(frame),
  };
}

function decodeElementRefPayload(elementRef: unknown): Record<string, unknown> | undefined {
  if (typeof elementRef !== 'string' || !elementRef.startsWith('ref:')) {
    return undefined;
  }

  try {
    const decoded = JSON.parse(atob(elementRef.slice(4))) as unknown;
    return decoded && typeof decoded === 'object' && !Array.isArray(decoded)
      ? decoded as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveAutomationTargetSelector(target: LiveUIActionRequest['target']): string | undefined {
  if (typeof target?.selector === 'string' && target.selector.length > 0) {
    return target.selector;
  }

  const decoded = decodeElementRefPayload(target?.elementRef);
  return typeof decoded?.selector === 'string' && decoded.selector.length > 0 ? decoded.selector : undefined;
}

function augmentElementRef(elementRef: unknown, frame: FrameCaptureMetadata): string | undefined {
  if (typeof elementRef !== 'string' || !elementRef.startsWith('ref:')) {
    return typeof elementRef === 'string' ? elementRef : undefined;
  }

  try {
    const decoded = decodeElementRefPayload(elementRef);
    if (!decoded) {
      return elementRef;
    }
    return `ref:${btoa(JSON.stringify({
      ...decoded,
      frameId: frame.frameId,
      frameUrl: frame.url,
      frameTitle: frame.title,
      frameSelector: frame.frameSelector,
      frameSameOriginWithTop: frame.sameOriginWithTop,
      frameAutomationSupport: frame.automationSupport,
      frameAutomationUnsupportedReason: frame.automationUnsupportedReason,
    }))}`;
  } catch {
    return elementRef;
  }
}

function enrichFrameScopedItem(item: Record<string, unknown>, frame: FrameCaptureMetadata): Record<string, unknown> {
  return {
    ...item,
    frameId: frame.frameId,
    frameUrl: frame.url,
    frameTitle: frame.title,
    frameSelector: frame.frameSelector,
    frameSameOriginWithTop: frame.sameOriginWithTop,
    frameAutomationSupport: frame.automationSupport,
    frameAutomationUnsupportedReason: frame.automationUnsupportedReason,
    elementRef: augmentElementRef(item.elementRef, frame),
  };
}

async function listTopFrameElements(tabId: number): Promise<FrameElementMetadata[]> {
  const results = await chrome.scripting.executeScript({
    target: {
      tabId,
    },
    func: () => {
      const cssEscapeFallback = (value: string): string => {
        const cssApi = (globalThis as { CSS?: { escape?: (input: string) => string } }).CSS;
        if (cssApi?.escape) {
          return cssApi.escape(value);
        }
        return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
      };
      const elementSelectorPath = (element: Element): string => {
        if (element.id) {
          return `#${cssEscapeFallback(element.id)}`;
        }
        const testId = element.getAttribute('data-testid');
        if (testId) {
          return `[data-testid="${cssEscapeFallback(testId)}"]`;
        }
        const name = element.getAttribute('name');
        if (name) {
          return `${element.tagName.toLowerCase()}[name="${cssEscapeFallback(name)}"]`;
        }
        const siblings = element.parentElement
          ? Array.from(element.parentElement.children).filter((child) => child.tagName === element.tagName)
          : [element];
        const index = Math.max(0, siblings.indexOf(element)) + 1;
        return `${element.tagName.toLowerCase()}:nth-of-type(${index})`;
      };
      let frameIndex = 0;
      const entries: Array<Record<string, unknown>> = [];
      const visitWindow = (rootWindow: Window, parentPath?: string): void => {
        const frameElements = Array.from(rootWindow.document.querySelectorAll('iframe, frame')) as HTMLIFrameElement[];
        for (const frameElement of frameElements) {
          const sandbox = frameElement instanceof HTMLIFrameElement ? frameElement.getAttribute('sandbox') : null;
          const sandboxFlags = sandbox === null
            ? undefined
            : sandbox
              .split(/\s+/)
              .map((flag) => flag.trim())
              .filter((flag) => flag.length > 0);
          const selectorPath = parentPath
            ? `${parentPath} => ${elementSelectorPath(frameElement)}`
            : elementSelectorPath(frameElement);
          entries.push({
            index: frameIndex,
            src: frameElement.getAttribute('src') ?? undefined,
            resolvedUrl: frameElement.src || undefined,
            title: frameElement.getAttribute('title') ?? undefined,
            name: frameElement.getAttribute('name') ?? undefined,
            id: frameElement.id || undefined,
            selectorPath,
            sandboxFlags,
            hasSrcdoc: frameElement instanceof HTMLIFrameElement && frameElement.getAttribute('srcdoc') !== null,
          });
          frameIndex += 1;
          try {
            const childWindow = frameElement.contentWindow;
            const childDocument = frameElement.contentDocument;
            if (childWindow && childDocument) {
              visitWindow(childWindow, selectorPath);
            }
          } catch {
            // Cross-origin descendants cannot be traversed from the top document.
          }
        }
      };
      visitWindow(window);
      return entries;
    },
  });

  const firstResult = results[0]?.result;
  return Array.isArray(firstResult)
    ? firstResult.flatMap((entry) => isFrameElementMetadata(entry) ? [entry] : [])
    : [];
}

function mergeFrameElementMetadata(
  frames: FrameCaptureMetadata[],
  elements: FrameElementMetadata[],
): FrameCaptureMetadata[] {
  if (elements.length === 0) {
    return frames.map(withFrameAutomationPolicy);
  }

  const childFrames = frames.filter((frame) => frame.frameId !== 0);
  const srcdocFrames = childFrames.filter((frame) => frame.url === 'about:srcdoc');
  const sameSandboxFlags = (left: string[] | undefined, right: string[] | undefined): boolean => {
    if (left === undefined || right === undefined) {
      return false;
    }
    if (left.length !== right.length) {
      return false;
    }
    return left.every((flag, index) => flag === right[index]);
  };

  return frames.map((frame) => {
    if (frame.frameId === 0) {
      return withFrameAutomationPolicy(frame);
    }

    const exactUrlMatch = elements.find((element) => {
      return Boolean(element.resolvedUrl && frame.url && element.resolvedUrl === frame.url && (!frame.title || !element.title || element.title === frame.title));
    });
    const sandboxMatch = frame.sandboxFlags !== undefined
      ? elements.find((element) => {
          return sameSandboxFlags(frame.sandboxFlags, element.sandboxFlags)
            && (!frame.title || !element.title || element.title === frame.title);
        })
      : undefined;
    const srcdocMatch = frame.url === 'about:srcdoc' && srcdocFrames.length === elements.filter((element) => element.hasSrcdoc).length
      ? elements.filter((element) => element.hasSrcdoc)[srcdocFrames.findIndex((entry) => entry.frameId === frame.frameId)]
      : undefined;
    const matchedElement = exactUrlMatch ?? sandboxMatch ?? srcdocMatch;
    if (!matchedElement) {
      return withFrameAutomationPolicy(frame);
    }

    return withFrameAutomationPolicy({
      ...frame,
      frameSelector: matchedElement.selectorPath,
      sandboxFlags: frame.sandboxFlags ?? matchedElement.sandboxFlags,
      title: frame.title || matchedElement.title,
    });
  });
}

async function listTabFrames(tabId: number): Promise<FrameCaptureMetadata[]> {
  const [results, frameElements] = await Promise.all([
    chrome.scripting.executeScript({
      target: {
        tabId,
        allFrames: true,
      },
      func: () => {
        let parentAccessible = false;
        let parentUrl: string | undefined;
        let topAccessible = false;
        const isInspectableFromTop = (): boolean => {
          if (window === window.top) {
            return true;
          }

          try {
            let currentWindow: Window | null = window;
            while (currentWindow && currentWindow !== currentWindow.top) {
              const parentWindow: Window = currentWindow.parent;
              void parentWindow.document;
              currentWindow = parentWindow;
            }
            return true;
          } catch {
            return false;
          }
        };
        const sameOriginWithTop = isInspectableFromTop();
        let sandboxFlags: string[] | undefined;

        try {
          parentUrl = window.parent.location.href;
          parentAccessible = true;
        } catch {
          parentAccessible = false;
        }

        try {
          if (window.top) {
            topAccessible = true;
          }
        } catch {
          topAccessible = false;
        }

        try {
          const frameElement = window.frameElement;
          if (frameElement instanceof HTMLIFrameElement) {
            const sandbox = frameElement.getAttribute('sandbox');
            sandboxFlags = sandbox === null
              ? undefined
              : sandbox
                .split(/\s+/)
                .map((flag) => flag.trim())
                .filter((flag) => flag.length > 0);
          }
        } catch {
          sandboxFlags = undefined;
        }

        return {
          url: window.location.href,
          title: document.title,
          origin: window.location.origin,
          isOpaqueOrigin: window.location.origin === 'null' && !sameOriginWithTop,
          parentAccessible,
          parentUrl,
          topAccessible,
          sameOriginWithTop,
          sandboxFlags,
        };
      },
    }),
    listTopFrameElements(tabId).catch(() => []),
  ]);

  const frames = results
    .filter((entry) => typeof entry.frameId === 'number' && Boolean(entry.result))
    .map((entry) => ({
      frameId: entry.frameId ?? 0,
      url: entry.result?.url,
      title: entry.result?.title,
      origin: entry.result?.origin,
      isOpaqueOrigin: entry.result?.isOpaqueOrigin,
      parentAccessible: entry.result?.parentAccessible,
      parentUrl: entry.result?.parentUrl,
      topAccessible: entry.result?.topAccessible,
      sameOriginWithTop: entry.result?.sameOriginWithTop,
      sandboxFlags: entry.result?.sandboxFlags,
    }))
    .sort((a, b) => a.frameId - b.frameId);

  return mergeFrameElementMetadata(frames, frameElements);
}

async function resolveCaptureCommandFrame(
  tabId: number,
  payload: Record<string, unknown>,
  topFrame: FrameCaptureMetadata = { frameId: 0 },
): Promise<FrameCaptureMetadata> {
  if (!hasExplicitCaptureFrameTarget(payload)) {
    return topFrame;
  }

  const frames = await listTabFrames(tabId);
  return resolveCaptureFrameTarget(frames, payload);
}

function withResolvedFrame(
  capture: { payload: Record<string, unknown>; truncated?: boolean },
  frame: FrameCaptureMetadata,
): { payload: Record<string, unknown>; truncated?: boolean } {
  return {
    ...capture,
    payload: {
      ...capture.payload,
      resolvedFrame: {
        frameId: frame.frameId,
        url: resolveFrameMetadataUrl(frame),
      },
    },
  };
}

function mergeFramePageStates(
  captures: Array<{ frame: FrameCaptureMetadata; payload: Record<string, unknown>; truncated?: boolean }>,
  maxItems: number,
): { payload: Record<string, unknown>; truncated: boolean } {
  const topCapture = captures.find((entry) => entry.frame.frameId === 0) ?? captures[0];
  const topPayload = topCapture?.payload ?? {};
  const buttons: Array<Record<string, unknown>> = [];
  const links: Array<Record<string, unknown>> = [];
  const inputs: Array<Record<string, unknown>> = [];
  const modals: Array<Record<string, unknown>> = [];
  const frames: Array<Record<string, unknown>> = [];
  let totalButtons = 0;
  let totalLinks = 0;
  let totalInputs = 0;
  let totalModals = 0;
  let truncated = captures.some((entry) => entry.truncated === true);
  let focused: Record<string, unknown> | undefined;

  for (const capture of captures) {
    const frame = capture.frame;
    const payload = capture.payload;
    const frameButtons = asRecordArray(payload.buttons).map((item) => enrichFrameScopedItem(item, frame));
    const frameLinks = asRecordArray(payload.links).map((item) => enrichFrameScopedItem(item, frame));
    const frameInputs = asRecordArray(payload.inputs).map((item) => enrichFrameScopedItem(item, frame));
    const frameModals = asRecordArray(payload.modals).map((item) => enrichFrameScopedItem(item, frame));
    totalButtons += typeof (payload.summary as { buttons?: unknown } | undefined)?.buttons === 'number'
      ? (payload.summary as { buttons: number }).buttons
      : frameButtons.length;
    totalLinks += typeof (payload.summary as { links?: unknown } | undefined)?.links === 'number'
      ? (payload.summary as { links: number }).links
      : frameLinks.length;
    totalInputs += typeof (payload.summary as { inputs?: unknown } | undefined)?.inputs === 'number'
      ? (payload.summary as { inputs: number }).inputs
      : frameInputs.length;
    totalModals += typeof (payload.summary as { modals?: unknown } | undefined)?.modals === 'number'
      ? (payload.summary as { modals: number }).modals
      : frameModals.length;

    buttons.push(...frameButtons);
    links.push(...frameLinks);
    inputs.push(...frameInputs);
    modals.push(...frameModals);

    const frameFocused = payload.focused && typeof payload.focused === 'object' && !Array.isArray(payload.focused)
      ? enrichFrameScopedItem(payload.focused as Record<string, unknown>, frame)
      : undefined;
    if (!focused && frameFocused?.elementRef) {
      focused = frameFocused;
    }

    frames.push({
      frameId: frame.frameId,
      url: frame.url,
      title: frame.title,
      origin: frame.origin,
      isOpaqueOrigin: frame.isOpaqueOrigin,
      parentUrl: frame.parentUrl,
      parentAccessible: frame.parentAccessible,
      topAccessible: frame.topAccessible,
      sameOriginWithTop: frame.sameOriginWithTop,
      sandboxFlags: frame.sandboxFlags,
      automationSupport: frame.automationSupport,
      automationUnsupportedReason: frame.automationUnsupportedReason,
      frameCaptureError: payload.frameCaptureError,
      frameCaptureErrorCode: payload.frameCaptureErrorCode,
      summary: payload.summary,
      viewport: payload.viewport,
      truncation: payload.truncation,
    });
  }

  const slicedButtons = buttons.slice(0, maxItems);
  const slicedLinks = links.slice(0, maxItems);
  const slicedInputs = inputs.slice(0, maxItems);
  const slicedModals = modals.slice(0, maxItems);
  truncated = truncated
    || slicedButtons.length < buttons.length
    || slicedLinks.length < links.length
    || slicedInputs.length < inputs.length
    || slicedModals.length < modals.length;

  return {
    truncated,
    payload: {
      ...topPayload,
      focused,
      frames,
      summary: {
        buttons: totalButtons,
        links: totalLinks,
        inputs: totalInputs,
        modals: totalModals,
        frames: captures.length,
      },
      buttons: Array.isArray(topPayload.buttons) ? slicedButtons : undefined,
      links: Array.isArray(topPayload.links) ? slicedLinks : undefined,
      inputs: Array.isArray(topPayload.inputs) ? slicedInputs : undefined,
      modals: Array.isArray(topPayload.modals) ? slicedModals : undefined,
      truncation: {
        ...(topPayload.truncation && typeof topPayload.truncation === 'object' ? topPayload.truncation : {}),
        buttons: slicedButtons.length < buttons.length,
        links: slicedLinks.length < links.length,
        inputs: slicedInputs.length < inputs.length,
        modals: slicedModals.length < modals.length,
        frames: false,
      },
    },
  };
}

function classifyFrameCaptureError(frame: FrameCaptureMetadata, error: unknown): string {
  if (frame.automationUnsupportedReason === 'sandboxed_opaque_origin') {
    return 'sandboxed_frame_inaccessible';
  }

  if (frame.automationUnsupportedReason === 'cross_origin_with_top') {
    return 'cross_origin_frame_inaccessible';
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/receiving end|message port|content script/i.test(message)) {
    return 'content_script_unavailable';
  }

  return 'frame_capture_failed';
}

async function capturePageStateAcrossFrames(
  tabId: number,
  payload: Record<string, unknown>,
  targetFrame?: FrameCaptureMetadata,
): Promise<{ payload: Record<string, unknown>; truncated?: boolean }> {
  const frames = targetFrame ? [targetFrame] : await listTabFrames(tabId);
  const maxItems = typeof payload.maxItems === 'number' && Number.isFinite(payload.maxItems)
    ? Math.max(1, Math.floor(payload.maxItems))
    : 40;
  const captures: Array<{ frame: FrameCaptureMetadata; payload: Record<string, unknown>; truncated?: boolean }> = [];

  for (const frame of frames) {
    try {
      const captured = await sendCaptureCommandToTab(tabId, 'CAPTURE_PAGE_STATE', payload, true, frame.frameId);
      captures.push({
        frame,
        payload: captured.payload,
        truncated: captured.truncated,
      });
    } catch (error) {
      captures.push({
        frame,
        payload: {
          url: resolveFrameMetadataUrl(frame),
          title: frame.title,
          summary: {
            buttons: 0,
            links: 0,
            inputs: 0,
            modals: 0,
          },
          frameCaptureError: true,
          frameCaptureErrorCode: classifyFrameCaptureError(frame, error),
        },
        truncated: false,
      });
    }
  }

  if (captures.length === 0) {
    return sendCaptureCommandToTab(tabId, 'CAPTURE_PAGE_STATE', payload, true, 0);
  }

  return mergeFramePageStates(captures, maxItems);
}

async function executeRetriableGenericCapture(
  tabId: number,
  command: GenericCaptureCommand,
  payload: Record<string, unknown>,
  frame?: FrameCaptureMetadata,
): Promise<{ payload: Record<string, unknown>; truncated?: boolean }> {
  const captureOnce = (): Promise<{ payload: Record<string, unknown>; truncated?: boolean }> => {
    return command === 'CAPTURE_PAGE_STATE'
      ? capturePageStateAcrossFrames(tabId, payload, frame)
      : sendCaptureCommandToTab(tabId, command, payload, true, frame?.frameId);
  };
  let capture = await captureOnce();

  if (shouldRetryGenericCaptureResult(command, capture.payload)) {
    await sleep(150);
    const contentReady = await ensureContentScriptReady(tabId, frame?.frameId ?? 0);
    if (contentReady) {
      capture = await captureOnce();
    }
  }

  return frame ? withResolvedFrame(capture, frame) : capture;
}

function buildCaptureConfigUpdatePayload(sessionId?: string): CaptureConfigUpdatePayload {
  const automationStatus = getAutomationStatus();
  const sessionState = sessionManager.getState();
  return {
    captureEnabled: Boolean(
      sessionId
      && sessionState.sessionId === sessionId
      && sessionState.isActive
      && !sessionState.isPaused,
    ),
    network: {
      captureBodies: captureConfig.network.captureBodies === true,
      maxBodyBytes: captureConfig.network.maxBodyBytes,
    },
    automation: {
      enabled: captureConfig.automation.enabled,
      allowSensitiveFields: captureConfig.automation.allowSensitiveFields,
      status: automationStatus,
      sessionId: automationUiState.sessionId ?? sessionId,
      traceId: automationStatus === 'executing' ? automationUiState.traceId : undefined,
      action: automationStatus === 'executing' ? automationUiState.action : undefined,
    },
  };
}

async function sendCaptureConfigUpdateToTab(tabId: number, payload: CaptureConfigUpdatePayload): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    chrome.tabs.sendMessage(
      tabId,
      {
        type: 'CAPTURE_CONFIG_UPDATE',
        payload,
      },
      () => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        resolve();
      }
    );
  });
}

async function syncCaptureConfigToTab(sessionId: string, tabId: number): Promise<boolean> {
  const ready = await ensureContentScriptReady(tabId);
  if (!ready) {
    return false;
  }

  try {
    await sendCaptureConfigUpdateToTab(tabId, buildCaptureConfigUpdatePayload(sessionId));
    return true;
  } catch {
    return false;
  }
}

function getSessionBoundTabIds(sessionId: string): number[] {
  const scope = getSessionTabScope(sessionId);
  const tabIds = new Set<number>();

  if (scope) {
    for (const tabId of scope.allowedTabIds) {
      tabIds.add(tabId);
    }
  }

  const remembered = captureTabBySession.get(sessionId);
  if (remembered) {
    tabIds.add(remembered.tabId);
  }

  return Array.from(tabIds);
}

async function syncCaptureConfigToSessionTabs(sessionId: string): Promise<void> {
  const tabIds = getSessionBoundTabIds(sessionId);
  if (tabIds.length === 0) {
    return;
  }

  await Promise.all(
    tabIds.map(async (tabId) => {
      await syncCaptureConfigToTab(sessionId, tabId);
    }),
  );
}

function clearSessionTabRecoveryTimer(tabId: number): void {
  const existing = sessionTabRecoveryTimers.get(tabId);
  if (!existing) {
    return;
  }

  clearTimeout(existing);
  sessionTabRecoveryTimers.delete(tabId);
}

function scheduleBoundTabRecovery(tabId: number, tab?: chrome.tabs.Tab): void {
  const state = sessionManager.getState();
  if (!state.sessionId || !state.isActive || state.isPaused) {
    clearSessionTabRecoveryTimer(tabId);
    return;
  }

  if (!isTabAllowedForSession(state.sessionId, tabId)) {
    clearSessionTabRecoveryTimer(tabId);
    return;
  }

  const tabUrl = tab?.url ?? '';
  if (tabUrl && !isUrlAllowed(tabUrl, captureConfig.allowlist)) {
    clearSessionTabRecoveryTimer(tabId);
    return;
  }

  clearSessionTabRecoveryTimer(tabId);
  const timer = setTimeout(() => {
    sessionTabRecoveryTimers.delete(tabId);
    void (async () => {
      const latestState = sessionManager.getState();
      if (!latestState.sessionId || !latestState.isActive || latestState.isPaused) {
        return;
      }

      if (!isTabAllowedForSession(latestState.sessionId, tabId)) {
        return;
      }

      try {
        const latestTab = await chrome.tabs.get(tabId);
        if (!latestTab || typeof latestTab.id !== 'number') {
          return;
        }

        if (!isUrlAllowed(latestTab.url ?? '', captureConfig.allowlist)) {
          return;
        }

        rememberCaptureTabForSession(latestState.sessionId, latestTab);
        await syncCaptureConfigToTab(latestState.sessionId, tabId);
      } catch {
        // Tab may have navigated away or been closed while recovery was pending.
      }
    })();
  }, 250);

  sessionTabRecoveryTimers.set(tabId, timer);
}

async function executeCaptureCommand(
  command: CaptureCommandType,
  payload: Record<string, unknown>,
  context: { sessionId: string; commandId: string }
): Promise<{ payload: Record<string, unknown>; truncated?: boolean }> {
  if (command === 'EXECUTE_UI_ACTION') {
    const parsed = LiveUIActionRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid live UI action payload: ${parsed.error.issues[0]?.message ?? 'unknown error'}`);
    }

    const request = parsed.data;
    const startedAt = Date.now();

    if (!canExecuteLiveAutomation(captureConfig)) {
      queueAutomationEvent('automation_requested', request, { startedAt });
      const rejectedResult = buildRejectedLiveActionResult(
        request,
        startedAt,
        'automation_disabled',
        'Live automation is disabled in extension settings.',
      );
      queueAutomationEvent('automation_failed', request, {
        startedAt,
        result: rejectedResult,
      });
      return {
        payload: rejectedResult as unknown as Record<string, unknown>,
      };
    }

    if (!captureConfig.automation.allowSensitiveFields
      && requiresSensitiveAutomationOptIn({
        selector: resolveAutomationTargetSelector(request.target),
        action: request.action,
      })) {
      queueAutomationEvent('automation_requested', request, { startedAt });
      const rejectedResult = buildRejectedLiveActionResult(
        request,
        startedAt,
        'sensitive_field_opt_in_required',
        'Sensitive field automation is blocked until the second opt-in is enabled.',
      );
      queueAutomationEvent('automation_failed', request, {
        startedAt,
        result: rejectedResult,
      });
      return {
        payload: rejectedResult as unknown as Record<string, unknown>,
      };
    }

    const requestedTabId = request.target?.tabId;
    const sessionScope = getSessionTabScope(context.sessionId);

    if (requestedTabId !== undefined && sessionScope && !sessionScope.allowedTabIds.has(requestedTabId)) {
      queueAutomationEvent('automation_requested', request, { startedAt });
      const rejectedResult = buildRejectedLiveActionResult(
        request,
        startedAt,
        'tab_not_bound',
        `tabId ${requestedTabId} is not bound to this session`,
        { tabId: requestedTabId },
      );
      queueAutomationEvent('automation_failed', request, {
        startedAt,
        result: rejectedResult,
      });
      return {
        payload: rejectedResult as unknown as Record<string, unknown>,
      };
    }

    let tab: chrome.tabs.Tab | undefined;
    if (requestedTabId !== undefined) {
      try {
        tab = await chrome.tabs.get(requestedTabId);
      } catch {
        tab = undefined;
      }
    } else {
      tab = await resolveCaptureTab(context.sessionId);
    }

    if (!tab || typeof tab.id !== 'number') {
      throw new Error('No tab available for this session action');
    }

    const resolvedTab = tab as chrome.tabs.Tab & { id: number };

    if (!isTabAllowedForSession(context.sessionId, resolvedTab.id)) {
      queueAutomationEvent('automation_requested', request, { startedAt, tab: resolvedTab });
      const rejectedResult = buildRejectedLiveActionResult(
        request,
        startedAt,
        'tab_not_bound',
        `tabId ${resolvedTab.id} is not bound to this session`,
        { tabId: resolvedTab.id, url: resolvedTab.url ?? request.target?.url },
      );
      queueAutomationEvent('automation_failed', request, {
        startedAt,
        result: rejectedResult,
        tab: resolvedTab,
      });
      return {
        payload: rejectedResult as unknown as Record<string, unknown>,
      };
    }

    if (!isUrlAllowed(resolvedTab.url ?? '', captureConfig.allowlist)) {
      queueAutomationEvent('automation_requested', request, { startedAt, tab: resolvedTab });
      const rejectedResult = buildRejectedLiveActionResult(
        request,
        startedAt,
        'target_not_allowlisted',
        'Live UI actions are blocked because the target tab is no longer allowlisted.',
        { tabId: resolvedTab.id, url: resolvedTab.url ?? request.target?.url },
      );
      queueAutomationEvent('automation_failed', request, {
        startedAt,
        result: rejectedResult,
        tab: resolvedTab,
      });
      return {
        payload: rejectedResult as unknown as Record<string, unknown>,
      };
    }

    rememberCaptureTabForSession(context.sessionId, resolvedTab);

    const contentReady = await ensureContentScriptReady(resolvedTab.id);
    if (!contentReady) {
      throw new Error('Target tab for this session is unavailable for live action execution');
    }

    const actionPayload: Record<string, unknown> = {
      ...request,
      traceId: request.traceId ?? createLiveUIActionTraceId(),
      target: {
        ...request.target,
        tabId: resolvedTab.id,
        frameId: request.target?.frameId,
        url: resolvedTab.url ?? request.target?.url,
      },
    };
    const requestWithResolvedTarget = actionPayload as unknown as LiveUIActionRequest;

    queueAutomationEvent('automation_requested', requestWithResolvedTarget, {
      startedAt,
      tab: resolvedTab,
    });

    if (request.action === 'reload') {
      const traceId = String(actionPayload.traceId);
      automationUiState = {
        status: 'executing',
        sessionId: context.sessionId,
        traceId,
        action: request.action,
      };
      syncAutomationBadge();
      await syncCaptureConfigToSessionTabs(context.sessionId);

      try {
        queueAutomationEvent('automation_started', requestWithResolvedTarget, {
          startedAt,
          tab: resolvedTab,
        });
        await reloadTab(resolvedTab.id, request.input?.ignoreCache === true);
        const successResult: LiveUIActionResult = {
          action: 'reload',
          traceId,
          status: 'succeeded',
          executionScope: 'top-document-v1',
          startedAt,
          finishedAt: Date.now(),
          target: {
            matched: true,
            selector: request.target?.selector,
            tabId: resolvedTab.id,
            frameId: request.target?.frameId ?? 0,
            url: resolvedTab.url ?? request.target?.url,
          },
          result: {
            reloaded: true,
            ignoreCache: request.input?.ignoreCache === true,
          },
        };
        queueAutomationEvent('automation_succeeded', requestWithResolvedTarget, {
          startedAt,
          result: successResult,
          tab: resolvedTab,
        });
        return {
          payload: successResult,
        };
      } catch (error) {
        queueAutomationEvent('automation_failed', requestWithResolvedTarget, {
          startedAt,
          result: {
            action: 'reload',
            traceId,
            status: 'failed',
            executionScope: 'top-document-v1',
            startedAt,
            finishedAt: Date.now(),
            target: {
              matched: true,
              selector: request.target?.selector,
              tabId: resolvedTab.id,
              frameId: request.target?.frameId ?? 0,
              url: resolvedTab.url ?? request.target?.url,
            },
            failureReason: {
              code: 'action_execution_failed',
              message: error instanceof Error ? error.message : 'Live UI action execution failed.',
            },
          },
          tab: resolvedTab,
        });
        throw error;
      } finally {
        automationUiState = {
          status: canExecuteLiveAutomation(captureConfig) ? 'armed' : 'idle',
          sessionId: context.sessionId,
        };
        syncAutomationBadge();
        await syncCaptureConfigToSessionTabs(context.sessionId);
      }
    }

    automationUiState = {
      status: 'executing',
      sessionId: context.sessionId,
      traceId: String(actionPayload.traceId),
      action: request.action,
    };
    syncAutomationBadge();
    await syncCaptureConfigToSessionTabs(context.sessionId);

    try {
      queueAutomationEvent('automation_started', requestWithResolvedTarget, {
        startedAt,
        tab: resolvedTab,
      });
      if (
        requestWithResolvedTarget.action === 'click'
        || requestWithResolvedTarget.action === 'hover'
        || requestWithResolvedTarget.action === 'input'
        || requestWithResolvedTarget.action === 'press_key'
        || requestWithResolvedTarget.action === 'focus'
        || requestWithResolvedTarget.action === 'blur'
        || requestWithResolvedTarget.action === 'scroll'
        || requestWithResolvedTarget.action === 'submit'
      ) {
        let nativeResult: LiveUIActionResult;
        if (requestWithResolvedTarget.action === 'click') {
          nativeResult = await executeNativeClickAction({
            request: requestWithResolvedTarget,
            tab: resolvedTab,
            startedAt,
            traceId: String(actionPayload.traceId),
          });
        } else if (requestWithResolvedTarget.action === 'hover') {
          nativeResult = await executeNativeHoverAction({
            request: requestWithResolvedTarget,
            tab: resolvedTab,
            startedAt,
            traceId: String(actionPayload.traceId),
          });
        } else if (requestWithResolvedTarget.action === 'input') {
          nativeResult = await executeNativeInputAction({
            request: requestWithResolvedTarget,
            tab: resolvedTab,
            startedAt,
            traceId: String(actionPayload.traceId),
          });
        } else if (requestWithResolvedTarget.action === 'press_key') {
          nativeResult = await executeNativePressKeyAction({
            request: requestWithResolvedTarget,
            tab: resolvedTab,
            startedAt,
            traceId: String(actionPayload.traceId),
          });
        } else if (requestWithResolvedTarget.action === 'focus') {
          nativeResult = await executeNativeFocusAction({
            request: requestWithResolvedTarget,
            tab: resolvedTab,
            startedAt,
            traceId: String(actionPayload.traceId),
          });
        } else if (requestWithResolvedTarget.action === 'blur') {
          nativeResult = await executeNativeBlurAction({
            request: requestWithResolvedTarget,
            tab: resolvedTab,
            startedAt,
            traceId: String(actionPayload.traceId),
          });
        } else if (requestWithResolvedTarget.action === 'scroll') {
          nativeResult = await executeNativeScrollAction({
            request: requestWithResolvedTarget,
            tab: resolvedTab,
            startedAt,
            traceId: String(actionPayload.traceId),
          });
        } else {
          nativeResult = await executeNativeSubmitAction({
            request: requestWithResolvedTarget,
            tab: resolvedTab,
            startedAt,
            traceId: String(actionPayload.traceId),
          });
        }
        queueAutomationEvent(
          nativeResult.status === 'succeeded' ? 'automation_succeeded' : 'automation_failed',
          requestWithResolvedTarget,
          {
            startedAt,
            result: nativeResult,
            tab: resolvedTab,
          },
        );
        return {
          payload: nativeResult as unknown as Record<string, unknown>,
          truncated: false,
        };
      }

      const actionResult = await sendCaptureCommandToTab(resolvedTab.id, 'EXECUTE_UI_ACTION', actionPayload);
      const liveResult = withLiveActionTabContext(actionResult.payload, request, resolvedTab) as LiveUIActionResult;
      queueAutomationEvent(
        liveResult.status === 'succeeded' ? 'automation_succeeded' : 'automation_failed',
        requestWithResolvedTarget,
        {
          startedAt,
          result: liveResult,
          tab: resolvedTab,
        },
      );
      return {
        payload: liveResult,
        truncated: actionResult.truncated,
      };
    } catch (error) {
      queueAutomationEvent('automation_failed', requestWithResolvedTarget, {
        startedAt,
        result: {
          action: request.action,
          traceId: requestWithResolvedTarget.traceId ?? createLiveUIActionTraceId(),
          status: 'failed',
          executionScope: 'top-document-v1',
          startedAt,
          finishedAt: Date.now(),
          target: {
            matched: false,
            selector: request.target?.selector,
            tabId: resolvedTab.id,
            frameId: request.target?.frameId ?? 0,
            url: resolvedTab.url ?? request.target?.url,
          },
          failureReason: {
            code: 'action_execution_failed',
            message: error instanceof Error ? error.message : 'Live UI action execution failed.',
          },
        },
        tab: resolvedTab,
      });
      throw error;
    } finally {
      automationUiState = {
        status: canExecuteLiveAutomation(captureConfig) ? 'armed' : 'idle',
        sessionId: context.sessionId,
      };
      syncAutomationBadge();
      await syncCaptureConfigToSessionTabs(context.sessionId);
    }
  }

  if (command === 'CAPTURE_GET_LIVE_CONSOLE_LOGS') {
    const requestedTabId = resolveLiveConsoleTabId(payload.tabId);
    const requestedOrigin = normalizeHttpOrigin(payload.origin ?? payload.url);
    if ((payload.origin !== undefined || payload.url !== undefined) && !requestedOrigin) {
      throw new Error('origin/url must be a valid absolute http(s) URL');
    }

    const sessionScope = getSessionTabScope(context.sessionId);
    if (requestedTabId !== undefined && sessionScope && !sessionScope.allowedTabIds.has(requestedTabId)) {
      throw new Error(`tabId ${requestedTabId} is not bound to this session`);
    }

    const limit = resolveLiveConsoleLimit(payload.limit);
    const levels = resolveLiveConsoleLevels(payload.levels);
    const contains = resolveLiveConsoleContains(payload.contains);
    const sinceTs = resolveLiveConsoleSinceTs(payload.sinceTs);
    const includeRuntimeErrors = payload.includeRuntimeErrors !== false;
    const dedupeWindowMs = resolveLiveConsoleDedupeWindowMs(payload.dedupeWindowMs);
    const queryResult = liveConsoleBufferStore.query(context.sessionId, {
      tabId: requestedTabId,
      origin: requestedOrigin,
      levels,
      contains,
      sinceTs,
      limit,
      includeRuntimeErrors,
      dedupeWindowMs,
    });

    return {
      payload: {
        sessionId: context.sessionId,
        logs: queryResult.logs,
        pagination: {
          returned: queryResult.logs.length,
          matched: queryResult.matched,
        },
        filtersApplied: {
          tabId: requestedTabId,
          origin: requestedOrigin,
          levels: levels ?? [],
          contains,
          sinceTs,
          includeRuntimeErrors,
          dedupeWindowMs,
        },
        bufferStats: {
          buffered: queryResult.buffered,
          dropped: queryResult.dropped,
        },
      },
      truncated: queryResult.truncated,
    };
  }

  if (command === 'CAPTURE_WAIT_FOR_NAVIGATION_LIFECYCLE') {
    const requestedTabId = resolveLiveConsoleTabId(payload.tabId);
    const sessionScope = getSessionTabScope(context.sessionId);
    if (requestedTabId !== undefined && sessionScope && !sessionScope.allowedTabIds.has(requestedTabId)) {
      throw new Error(`tabId ${requestedTabId} is not bound to this session`);
    }

    const tab = requestedTabId !== undefined
      ? await chrome.tabs.get(requestedTabId).catch(() => undefined)
      : await resolveCaptureTab(context.sessionId);
    if (!tab || typeof tab.id !== 'number') {
      throw new Error('No capture tab is available for navigation lifecycle wait.');
    }
    if (!isTabAllowedForSession(context.sessionId, tab.id)) {
      throw new Error(`tabId ${tab.id} is not bound to this session`);
    }
    if (!isUrlAllowed(tab.url ?? '', captureConfig.allowlist)) {
      throw new Error('Navigation lifecycle waits are blocked because the target tab is no longer allowlisted.');
    }

    rememberCaptureTabForSession(context.sessionId, tab);
    return waitForNavigationLifecycleInTab({
      payload,
      tab: tab as chrome.tabs.Tab & { id: number },
    });
  }

  if (command === 'CAPTURE_WAIT_FOR_DIALOG') {
    const requestedTabId = resolveLiveConsoleTabId(payload.tabId);
    const sessionScope = getSessionTabScope(context.sessionId);
    if (requestedTabId !== undefined && sessionScope && !sessionScope.allowedTabIds.has(requestedTabId)) {
      throw new Error(`tabId ${requestedTabId} is not bound to this session`);
    }

    const tab = requestedTabId !== undefined
      ? await chrome.tabs.get(requestedTabId).catch(() => undefined)
      : await resolveCaptureTab(context.sessionId);
    if (!tab || typeof tab.id !== 'number') {
      throw new Error('No capture tab is available for dialog wait.');
    }
    if (!isTabAllowedForSession(context.sessionId, tab.id)) {
      throw new Error(`tabId ${tab.id} is not bound to this session`);
    }
    if (!isUrlAllowed(tab.url ?? '', captureConfig.allowlist)) {
      throw new Error('Dialog waits are blocked because the target tab is no longer allowlisted.');
    }

    rememberCaptureTabForSession(context.sessionId, tab);
    return waitForJavascriptDialogInTab({
      payload,
      tab: tab as chrome.tabs.Tab & { id: number },
    });
  }

  if (command === 'CAPTURE_WAIT_FOR_STABLE_LAYOUT') {
    const requestedTabId = resolveLiveConsoleTabId(payload.tabId);
    const sessionScope = getSessionTabScope(context.sessionId);
    if (requestedTabId !== undefined && sessionScope && !sessionScope.allowedTabIds.has(requestedTabId)) {
      throw new Error(`tabId ${requestedTabId} is not bound to this session`);
    }

    const tab = requestedTabId !== undefined
      ? await chrome.tabs.get(requestedTabId).catch(() => undefined)
      : await resolveCaptureTab(context.sessionId);
    if (!tab || typeof tab.id !== 'number') {
      throw new Error('No capture tab is available for stable layout wait.');
    }
    if (!isTabAllowedForSession(context.sessionId, tab.id)) {
      throw new Error(`tabId ${tab.id} is not bound to this session`);
    }
    if (!isUrlAllowed(tab.url ?? '', captureConfig.allowlist)) {
      throw new Error('Stable layout waits are blocked because the target tab is no longer allowlisted.');
    }

    rememberCaptureTabForSession(context.sessionId, tab);
    return waitForStableLayoutInTab({
      payload,
      tab: tab as chrome.tabs.Tab & { id: number },
    });
  }

  if (command === 'CAPTURE_WAIT_FOR_DOWNLOAD') {
    const requestedTabId = resolveLiveConsoleTabId(payload.tabId);
    const sessionScope = getSessionTabScope(context.sessionId);
    if (requestedTabId !== undefined && sessionScope && !sessionScope.allowedTabIds.has(requestedTabId)) {
      throw new Error(`tabId ${requestedTabId} is not bound to this session`);
    }

    const tab = requestedTabId !== undefined
      ? await chrome.tabs.get(requestedTabId).catch(() => undefined)
      : await resolveCaptureTab(context.sessionId);
    if (!tab || typeof tab.id !== 'number') {
      throw new Error('No capture tab is available for download wait.');
    }
    if (!isTabAllowedForSession(context.sessionId, tab.id)) {
      throw new Error(`tabId ${tab.id} is not bound to this session`);
    }
    if (!isUrlAllowed(tab.url ?? '', captureConfig.allowlist)) {
      throw new Error('Download waits are blocked because the target tab is no longer allowlisted.');
    }

    rememberCaptureTabForSession(context.sessionId, tab);
    return waitForDownloadInTab({
      payload,
      tab: tab as chrome.tabs.Tab & { id: number },
    });
  }

  if (command === 'CAPTURE_WAIT_FOR_POPUP') {
    const requestedTabId = resolveLiveConsoleTabId(payload.openerTabId);
    const sessionScope = getSessionTabScope(context.sessionId);
    if (requestedTabId !== undefined && sessionScope && !sessionScope.allowedTabIds.has(requestedTabId)) {
      throw new Error(`tabId ${requestedTabId} is not bound to this session`);
    }

    const tab = requestedTabId !== undefined
      ? await chrome.tabs.get(requestedTabId).catch(() => undefined)
      : await resolveCaptureTab(context.sessionId);
    if (!tab || typeof tab.id !== 'number') {
      throw new Error('No capture tab is available for popup wait.');
    }
    if (!isTabAllowedForSession(context.sessionId, tab.id)) {
      throw new Error(`tabId ${tab.id} is not bound to this session`);
    }
    if (!isUrlAllowed(tab.url ?? '', captureConfig.allowlist)) {
      throw new Error('Popup waits are blocked because the opener tab is no longer allowlisted.');
    }

    rememberCaptureTabForSession(context.sessionId, tab);
    return waitForPopupFromTab({
      payload,
      sessionId: context.sessionId,
      tab: tab as chrome.tabs.Tab & { id: number },
    });
  }

  if (command === 'CAPTURE_OVERRIDE_OBSERVE_ASSETS') {
    const requestedTabId = resolveLiveConsoleTabId(payload.tabId);
    const sessionScope = getSessionTabScope(context.sessionId);
    if (requestedTabId !== undefined && sessionScope && !sessionScope.allowedTabIds.has(requestedTabId)) {
      throw new Error(`tabId ${requestedTabId} is not bound to this session`);
    }

    const tab = await resolveOverridePocTab(context.sessionId, requestedTabId);
    if (!tab || typeof tab.id !== 'number') {
      throw new Error('No capture tab is available for the active session.');
    }

    rememberCaptureTabForSession(context.sessionId, tab);
    const observed = await observeOverrideAssetsInTab(tab.id, payload.includePerformance !== false);
    return {
      payload: {
        sessionId: context.sessionId,
        tabId: tab.id,
        ...observed,
      },
    };
  }

  if (command === 'CAPTURE_OVERRIDE_RESPONSE_BODY') {
    const captureMode = normalizeOverrideResponseCaptureMode(payload.captureMode);
    if (captureMode === 'extension-fetch') {
      return captureOverrideResponseBodyWithFetch(payload);
    }

    const requestedTabId = resolveLiveConsoleTabId(payload.tabId);
    const sessionScope = getSessionTabScope(context.sessionId);
    if (requestedTabId !== undefined && sessionScope && !sessionScope.allowedTabIds.has(requestedTabId)) {
      throw new Error(`tabId ${requestedTabId} is not bound to this session`);
    }

    const tab = await resolveOverridePocTab(context.sessionId, requestedTabId);
    if (!tab || typeof tab.id !== 'number') {
      throw new Error('No capture tab is available for response body capture.');
    }
    if (overridePocController.isActiveForTab(tab.id)) {
      throw new Error('Disable active overrides on the target tab before CDP response body capture.');
    }

    rememberCaptureTabForSession(context.sessionId, tab);
    return captureOverrideResponseBodyWithCdp({ payload, tab });
  }

  if (command === 'CAPTURE_OVERRIDE_POC_GET_STATUS') {
    return {
      payload: await buildOverridePocStatusResult(
        context.sessionId,
        await overridePocController.getStatus(),
      ) as unknown as Record<string, unknown>,
    };
  }

  if (command === 'CAPTURE_OVERRIDE_POC_ENABLE') {
    const requestedTabId = resolveLiveConsoleTabId(payload.tabId);
    const tab = await resolveOverridePocTab(context.sessionId, requestedTabId);
    if (!tab || typeof tab.id !== 'number') {
      throw new Error('No capture tab is available for the active session.');
    }

    overridePocTargetTabBySession.set(context.sessionId, tab.id);
    const status = await overridePocController.enableForTab({
      sessionId: context.sessionId,
      tabId: tab.id,
      selectedTabId: requestedTabId ?? getSelectedOverridePocTabId(context.sessionId),
    });

    return {
      payload: await buildOverridePocStatusResult(context.sessionId, status) as unknown as Record<string, unknown>,
    };
  }

  if (command === 'CAPTURE_OVERRIDE_POC_DISABLE') {
    return {
      payload: await overridePocController.disable() as unknown as Record<string, unknown>,
    };
  }

  const requestedTabId = resolveLiveConsoleTabId(payload.tabId);
  const sessionScope = getSessionTabScope(context.sessionId);
  if (requestedTabId !== undefined && sessionScope && !sessionScope.allowedTabIds.has(requestedTabId)) {
    throw new Error(`tabId ${requestedTabId} is not bound to this session`);
  }

  const tab = requestedTabId !== undefined
    ? await chrome.tabs.get(requestedTabId).catch(() => undefined)
    : await resolveCaptureTab(context.sessionId);
  if (!tab || tab.id === undefined) {
    throw new Error('No tab available for this session capture');
  }

  if (!isTabAllowedForSession(context.sessionId, tab.id)) {
    throw new Error(`tabId ${tab.id} is not bound to this session`);
  }

  if (!isUrlAllowed(tab.url ?? '', captureConfig.allowlist)) {
    throw new Error('Live capture is blocked because the target tab is no longer allowlisted.');
  }

  rememberCaptureTabForSession(context.sessionId, tab);

  const tabId = tab.id;
  const topFrame: FrameCaptureMetadata = {
    frameId: 0,
    url: tab.url,
    title: tab.title,
    origin: normalizeHttpOrigin(tab.url),
  };
  const contentReady = await ensureContentScriptReady(tabId);
  if (!contentReady) {
    throw new Error('Target tab for this session is unavailable for live capture');
  }

  try {
    await sendCaptureConfigUpdateToTab(tabId, buildCaptureConfigUpdatePayload(context.sessionId));
  } catch {
    // Best effort; capture can continue with injected defaults.
  }

  if (command === 'SET_VIEWPORT') {
    if (typeof tab.windowId !== 'number') {
      throw new Error('Target browser window is unavailable for viewport resize');
    }

    const rawWidth = payload.width;
    const rawHeight = payload.height;
    if (typeof rawWidth !== 'number' || !Number.isFinite(rawWidth)) {
      throw new Error('width must be a finite number');
    }
    if (typeof rawHeight !== 'number' || !Number.isFinite(rawHeight)) {
      throw new Error('height must be a finite number');
    }

    const width = Math.floor(rawWidth);
    const height = Math.floor(rawHeight);
    await updateWindowViewport(tab.windowId, width, height);
    await sleep(150);
    const metrics = await sendCaptureCommandToTab(tabId, 'CAPTURE_LAYOUT_METRICS', {}, false, 0);

    return {
      payload: {
        requested: {
          width,
          height,
        },
        windowId: tab.windowId,
        tabId,
        ...metrics.payload,
      },
      truncated: metrics.truncated,
    };
  }

  if (command === 'CAPTURE_PAGE_STATE') {
    const frame = hasExplicitCaptureFrameTarget(payload)
      ? await resolveCaptureCommandFrame(tabId, payload, topFrame)
      : undefined;
    return executeRetriableGenericCapture(tabId, 'CAPTURE_PAGE_STATE', payload, frame);
  }

  if (command === 'CAPTURE_UI_SNAPSHOT') {
    const llmRequested = payload.llmRequested === true;
    const blockReason = getSnapshotCaptureBlockReason(captureConfig, { llmRequested });
    if (blockReason === 'snapshots_disabled') {
      throw new Error(
        'Snapshot capture is disabled in extension settings. Open the extension popup, enable '
        + 'Capture Settings > Snapshot capture > Enable snapshots (manual), then save settings.',
      );
    }
    if (blockReason === 'request_opt_in_required') {
      throw new Error(
        'Snapshot capture requires request opt-in. Set llmRequested: true in the CAPTURE_UI_SNAPSHOT '
        + 'payload, or use capture_ui_snapshot/bdmcp snapshot, which opts in automatically.',
      );
    }

    const trigger = normalizeSnapshotTrigger(payload.trigger);
    if (!captureConfig.snapshots.triggers.includes(trigger)) {
      throw new Error(`Snapshot trigger "${trigger}" is disabled in extension settings`);
    }

    const mode = normalizeSnapshotMode(payload.mode, captureConfig.snapshots.mode);
    const requestedStyleMode = normalizeSnapshotStyleMode(payload.styleMode, captureConfig.snapshots.styleMode);
    const explicitStyleMode = payload.explicitStyleMode === true;
    const styleMode: SnapshotStyleMode = resolveSnapshotStyleMode(requestedStyleMode, explicitStyleMode);
    const includeDom = typeof payload.includeDom === 'boolean' ? payload.includeDom : mode !== 'png';
    const includeStyles = typeof payload.includeStyles === 'boolean' ? payload.includeStyles : mode !== 'png';
    const includePngDataUrl = typeof payload.includePngDataUrl === 'boolean' ? payload.includePngDataUrl : mode !== 'png';

    const contentPayload: Record<string, unknown> = {
      ...payload,
      trigger,
      styleMode,
      explicitStyleMode,
      includeDom,
      includeStyles,
    };

    const captured = await sendCaptureCommandToTab(tabId, 'CAPTURE_UI_SNAPSHOT', contentPayload, true, 0);

    const basePayload = captured.payload;
    const now = Date.now();
    const snapshotRecord: Record<string, unknown> = {
      ...basePayload,
      commandId: context.commandId,
      sessionId: context.sessionId,
      timestamp: typeof basePayload.timestamp === 'number' ? basePayload.timestamp : now,
      trigger,
      selector: typeof basePayload.selector === 'string' ? basePayload.selector : null,
      url: typeof basePayload.url === 'string' ? basePayload.url : tab.url ?? '',
      mode: {
        dom: includeDom,
        png: shouldCapturePng(mode),
        styleMode,
      },
      truncation: {
        dom: includeDom
          ? Boolean((basePayload as { truncation?: { dom?: unknown } }).truncation?.dom)
          : false,
        styles: includeStyles
          ? Boolean((basePayload as { truncation?: { styles?: unknown } }).truncation?.styles)
          : false,
        png: false,
      },
    };

    if (shouldCapturePng(mode)) {
      const usage = getSnapshotPngUsage(context.sessionId);
      const policy = captureConfig.snapshots.pngPolicy;
      let png: Record<string, unknown>;
      const captureDecision = evaluatePngCapturePolicy(usage, policy, now);

      if (!captureDecision.allowed && captureDecision.reason === 'quota_exceeded') {
        png = {
          captured: false,
          reason: 'quota_exceeded',
          maxImagesPerSession: policy.maxImagesPerSession,
        };
      } else if (!captureDecision.allowed && captureDecision.reason === 'throttled') {
        png = {
          captured: false,
          reason: 'throttled',
          minCaptureIntervalMs: policy.minCaptureIntervalMs,
          retryAfterMs: captureDecision.retryAfterMs,
        };
      } else {
        const pngCapture = await captureFullPageTabPng(tab);
        const byteLength = pngCapture.byteLength;
        const dataUrl = pngCapture.dataUrl;

        if (byteLength > policy.maxBytesPerImage) {
          png = {
            captured: false,
            reason: 'max_bytes_exceeded',
            byteLength,
            maxBytesPerImage: policy.maxBytesPerImage,
            fullPage: pngCapture.fullPage,
            pageWidth: pngCapture.pageWidth,
            pageHeight: pngCapture.pageHeight,
            viewportWidth: pngCapture.viewportWidth,
            viewportHeight: pngCapture.viewportHeight,
            tiles: pngCapture.tiles,
            downscaled: pngCapture.downscaled,
          };
          (snapshotRecord.truncation as Record<string, unknown>).png = true;
        } else {
          registerPngCaptureSuccess(usage, now);
          png = {
            captured: true,
            format: 'png',
            byteLength,
            dataUrl,
            fullPage: pngCapture.fullPage,
            pageWidth: pngCapture.pageWidth,
            pageHeight: pngCapture.pageHeight,
            viewportWidth: pngCapture.viewportWidth,
            viewportHeight: pngCapture.viewportHeight,
            tiles: pngCapture.tiles,
            downscaled: pngCapture.downscaled,
          };
        }
      }

      snapshotRecord.png = png;
    }

    const truncated =
      Boolean((snapshotRecord.truncation as Record<string, unknown>).dom)
      || Boolean((snapshotRecord.truncation as Record<string, unknown>).styles)
      || Boolean((snapshotRecord.truncation as Record<string, unknown>).png);

    const redactedSnapshot = redactSnapshotRecord(snapshotRecord, {
      safeMode: captureConfig.safeMode,
      profile: captureConfig.snapshots.privacy.profile,
    });

    sessionManager.queueEvent('ui_snapshot', redactedSnapshot.record, {
      tabId,
      origin: normalizeHttpOrigin(snapshotRecord.url),
    });

    const responseSnapshot = structuredClone(redactedSnapshot.record);
    const responseSnapshotRoot = responseSnapshot.snapshot;
    if (responseSnapshotRoot && typeof responseSnapshotRoot === 'object') {
      const snapshotRootRecord = responseSnapshotRoot as Record<string, unknown>;
      if (!includeDom) {
        delete snapshotRootRecord.dom;
      }
      if (!includeStyles) {
        delete snapshotRootRecord.styles;
      }
    }

    if (!includePngDataUrl && responseSnapshot.png && typeof responseSnapshot.png === 'object') {
      delete (responseSnapshot.png as Record<string, unknown>).dataUrl;
    }

    return {
      payload: responseSnapshot,
      truncated: truncated || redactedSnapshot.metadata.blockedPng,
    };
  }

  if (command === 'CAPTURE_DOM_DOCUMENT' || command === 'CAPTURE_DOM_SUBTREE') {
    const frame = await resolveCaptureCommandFrame(tabId, payload, topFrame);
    return executeRetriableGenericCapture(tabId, command, payload, frame);
  }

  const frame = await resolveCaptureCommandFrame(tabId, payload, topFrame);
  return withResolvedFrame(
    await sendCaptureCommandToTab(tabId, command, payload, true, frame.frameId),
    frame,
  );
}

const sessionManager = new SessionManager({
  handleCaptureCommand: executeCaptureCommand,
  wsUrl: 'ws://127.0.0.1:8065/ws',
});
const LOG_PREFIX = '[BrowserDebug][Background]';
let captureConfig: CaptureConfig = { ...DEFAULT_CAPTURE_CONFIG };
let serverBaseUrlOverride: string | null = null;
const overridePocController = new OverridePocController(getServerBaseUrl());
const sessionBindingsReady = loadPersistedSessionBindings(chrome.storage.local).catch(() => undefined);
const captureDiagnostics = {
  received: 0,
  accepted: 0,
  rejectedAllowlist: 0,
  rejectedSafeMode: 0,
  rejectedTabScope: 0,
  rejectedInactive: 0,
  lastEventType: '',
  lastSenderUrl: '',
  lastUpdatedAt: 0,
  contentScriptReady: false,
  fallbackInjected: false,
  lastInjectError: '',
};

void Promise.all([
  loadCaptureConfig(chrome.storage.local),
  sessionBindingsReady,
]).then(([loaded]) => {
  captureConfig = loaded;
  syncAutomationBadge();
});
void loadServerBaseUrl(chrome.storage.local).then((loaded) => {
  applyServerBaseUrl(loaded);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[SERVER_BASE_URL_STORAGE_KEY]) {
    return;
  }

  applyServerBaseUrl(changes[SERVER_BASE_URL_STORAGE_KEY].newValue);
});

function normalizeServerBaseUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }

  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function getServerBaseUrl(): string {
  return serverBaseUrlOverride ?? DEFAULT_SERVER_BASE_URL;
}

function toWebSocketUrl(serverBaseUrl: string): string {
  const parsed = new URL(serverBaseUrl);
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.pathname = '/ws';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function updateSessionManagerServerBaseUrl(serverBaseUrl: string): void {
  sessionManager.setWsUrl(toWebSocketUrl(serverBaseUrl));
}

function applyServerBaseUrl(nextBaseUrl: unknown): void {
  serverBaseUrlOverride = normalizeServerBaseUrl(
    typeof nextBaseUrl === 'string' ? nextBaseUrl : null,
  );
  const serverBaseUrl = getServerBaseUrl();
  updateSessionManagerServerBaseUrl(serverBaseUrl);
  overridePocController.setServerBaseUrl(serverBaseUrl);
}

function loadServerBaseUrl(storageArea: RuntimeStorageAreaLike): Promise<string | null> {
  return new Promise((resolve) => {
    storageArea.get(SERVER_BASE_URL_STORAGE_KEY, (items) => {
      resolve(normalizeServerBaseUrl(items[SERVER_BASE_URL_STORAGE_KEY] as string | null | undefined));
    });
  });
}

function persistServerBaseUrl(value: string | null): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [SERVER_BASE_URL_STORAGE_KEY]: value }, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

updateSessionManagerServerBaseUrl(getServerBaseUrl());

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const preferred = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const preferredHttpTab = preferred.find((tab) => {
    const url = tab.url ?? '';
    return url.startsWith('http://') || url.startsWith('https://');
  });
  if (preferredHttpTab) {
    return preferredHttpTab;
  }

  const currentWindowTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const currentHttpTab = currentWindowTabs.find((tab) => {
    const url = tab.url ?? '';
    return url.startsWith('http://') || url.startsWith('https://');
  });
  if (currentHttpTab) {
    return currentHttpTab;
  }

  return preferred[0] ?? currentWindowTabs[0];
}

async function pingContentScript(tabId: number, frameId: number = 0): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tabId,
      { type: 'CAPTURE_PING' },
      { frameId },
      (response?: CapturePingResponse) => {
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }

        resolve(Boolean(response?.ok));
      },
    );
  });
}

async function injectContentScriptFallback(tabId: number, frameId: number = 0): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ['content-script.js'],
      world: 'ISOLATED',
    });
    captureDiagnostics.fallbackInjected = true;
    captureDiagnostics.lastInjectError = '';
    return true;
  } catch (error) {
    captureDiagnostics.lastInjectError = error instanceof Error ? error.message : String(error);
    console.warn(`${LOG_PREFIX} Failed fallback content-script injection`, error);
    return false;
  }
}

async function ensureContentScriptReady(tabId: number, frameId: number = 0): Promise<boolean> {
  const initial = await pingContentScript(tabId, frameId);
  if (initial) {
    captureDiagnostics.contentScriptReady = true;
    return true;
  }

  const injected = await injectContentScriptFallback(tabId, frameId);
  if (!injected) {
    captureDiagnostics.contentScriptReady = false;
    return false;
  }

  const afterInject = await pingContentScript(tabId, frameId);
  captureDiagnostics.contentScriptReady = afterInject;
  return afterInject;
}

async function fetchServer(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const headers = new Headers(init?.headers ?? {});
  if (init?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const serverBaseUrl = getServerBaseUrl();
  const response = await fetch(`${serverBaseUrl}${path}`, {
    ...init,
    headers,
  });

  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error((payload.error as string) ?? `Server error (${response.status})`);
  }
  return payload;
}

function buildSessionContextFromTab(tab: chrome.tabs.Tab | undefined): {
  activeUrl: string;
  baseOrigin?: string;
  tabId?: number;
  windowId?: number;
  viewport: {
    width: number;
    height: number;
  };
  dpr: number;
} {
  const screenWidth = tab?.width ?? globalThis.screen?.width ?? 0;
  const screenHeight = tab?.height ?? globalThis.screen?.height ?? 0;
  const activeUrl = tab?.url ?? 'about:blank';
  return {
    activeUrl,
    baseOrigin: normalizeHttpOrigin(activeUrl),
    tabId: typeof tab?.id === 'number' ? tab.id : undefined,
    windowId: typeof tab?.windowId === 'number' ? tab.windowId : undefined,
    viewport: {
      width: screenWidth,
      height: screenHeight,
    },
    dpr: globalThis.devicePixelRatio ?? 1,
  };
}

async function resolveAllowlistedSessionContext(): Promise<{
  tab: chrome.tabs.Tab | undefined;
  activeUrl: string;
  baseOrigin?: string;
  tabId?: number;
  windowId?: number;
  viewport: {
    width: number;
    height: number;
  };
  dpr: number;
}> {
  const tab = await getActiveTab();
  const context = buildSessionContextFromTab(tab);
  if (!isUrlAllowed(context.activeUrl, captureConfig.allowlist)) {
    throw new Error('Active tab is not in allowlist. Add a domain in popup settings.');
  }
  return {
    tab,
    ...context,
  };
}

async function resolveResumeSessionContext(sessionId: string): Promise<{
  tab: chrome.tabs.Tab | undefined;
  activeUrl: string;
  baseOrigin?: string;
  tabId?: number;
  windowId?: number;
  viewport: {
    width: number;
    height: number;
  };
  dpr: number;
}> {
  await sessionBindingsReady;
  const rememberedTab = await resolveCaptureTab(sessionId);
  if (rememberedTab) {
    const rememberedContext = buildSessionContextFromTab(rememberedTab);
    if (isUrlAllowed(rememberedContext.activeUrl, captureConfig.allowlist)) {
      return {
        tab: rememberedTab,
        ...rememberedContext,
      };
    }
  }

  return resolveAllowlistedSessionContext();
}

function resolveRequestedSessionId(requestedSessionId: string | undefined, state: SessionState): string | null {
  if (typeof requestedSessionId === 'string' && requestedSessionId.trim().length > 0) {
    return requestedSessionId.trim();
  }

  if (typeof state.sessionId === 'string' && state.sessionId.trim().length > 0) {
    return state.sessionId;
  }

  return null;
}

async function focusCaptureTabForSession(sessionId: string): Promise<chrome.tabs.Tab> {
  const tab = await resolveCaptureTab(sessionId);
  if (!tab || typeof tab.id !== 'number') {
    throw new Error('No bound tab is available for this session');
  }

  const updatedTab = await chrome.tabs.update(tab.id, { active: true });
  if (!updatedTab || typeof updatedTab.id !== 'number') {
    throw new Error('Bound tab could not be focused');
  }
  if (typeof updatedTab.windowId === 'number') {
    await chrome.windows.update(updatedTab.windowId, { focused: true }).catch(() => undefined);
  }
  rememberCaptureTabForSession(sessionId, updatedTab);
  return updatedTab;
}

async function retryContentScriptForSession(sessionId: string): Promise<{ tab: chrome.tabs.Tab; ready: boolean }> {
  const tab = await resolveCaptureTab(sessionId);
  if (!tab || typeof tab.id !== 'number') {
    throw new Error('No bound tab is available for this session');
  }

  const ready = await ensureContentScriptReady(tab.id);
  rememberCaptureTabForSession(sessionId, tab);
  if (!ready) {
    throw new Error('Content script is still unavailable on the bound tab');
  }

  await syncCaptureConfigToSessionTabs(sessionId).catch(() => undefined);
  return { tab, ready };
}

function handleRequest(request: RuntimeRequest, sender: chrome.runtime.MessageSender): Promise<RuntimeResponse> {
  switch (request.type) {
    case 'SESSION_GET_STATE':
      return Promise.resolve({ ok: true, state: sessionManager.getState() });

    case 'SESSION_GET_CONFIG':
      return Promise.resolve({ ok: true, config: captureConfig });

    case 'SESSION_UPDATE_CONFIG':
      return saveCaptureConfig(chrome.storage.local, request.config)
        .then(async (saved) => {
          captureConfig = saved;
          if (!saved.automation.enabled) {
            automationUiState = { status: 'idle' };
          }
          syncAutomationBadge();
          const sessionId = sessionManager.getState().sessionId;
          if (sessionId) {
            await syncCaptureConfigToSessionTabs(sessionId);
          }
          return { ok: true as const, config: saved };
        })
        .catch((error) => ({
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to save capture config',
        }));

    case 'SESSION_START': {
      return resolveAllowlistedSessionContext()
        .then(async (activeContext) => {
          if (typeof activeContext.tab?.id === 'number') {
            const contentReady = await ensureContentScriptReady(activeContext.tab.id);
            if (!contentReady) {
              throw new Error('Content script is not available on the active tab. Reload the page and retry.');
            }
          }

          const started = sessionManager.startSession({
            url: activeContext.activeUrl,
            tabId: activeContext.tabId,
            windowId: activeContext.windowId,
            baseOrigin: activeContext.baseOrigin,
            allowedTabIds: activeContext.tabId !== undefined ? [activeContext.tabId] : [],
            userAgent: navigator.userAgent,
            viewport: activeContext.viewport,
            dpr: activeContext.dpr,
            safeMode: captureConfig.safeMode,
          });

          if (started.sessionId) {
            setSessionTabScope(started.sessionId, activeContext.activeUrl, activeContext.tabId);
            sessionManager.setSessionScope({
              baseOrigin: activeContext.baseOrigin,
              allowedTabIds: activeContext.tabId !== undefined ? [activeContext.tabId] : [],
            });
          }

          if (started.sessionId && typeof activeContext.tab?.id === 'number') {
            rememberCaptureTabForSession(started.sessionId, activeContext.tab);
            await syncCaptureConfigToSessionTabs(started.sessionId);
          } else if (started.sessionId) {
            captureTabBySession.delete(started.sessionId);
          }

          sessionManager.queueEvent('custom', {
            marker: 'session_started',
            url: activeContext.activeUrl,
            timestamp: Date.now(),
          }, {
            tabId: activeContext.tabId,
            origin: activeContext.baseOrigin,
          });

          if (started.sessionId) {
            snapshotPngUsageBySession.delete(started.sessionId);
          }

          syncAutomationBadge();

          return { ok: true as const, state: started };
        })
        .catch((error) => ({
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to start session',
        }));
    }

    case 'SESSION_PAUSE':
      return Promise.resolve().then(async () => {
        const state = sessionManager.getState();
        if (!state.isActive || !state.sessionId) {
          throw new Error('No active session to pause');
        }
        if (state.isPaused) {
          return { ok: true as const, state };
        }

        await overridePocController.disable().catch(() => undefined);
        const paused = sessionManager.pauseSession();
        await syncCaptureConfigToSessionTabs(state.sessionId).catch(() => undefined);
        syncAutomationBadge();
        return { ok: true as const, state: paused };
      }).catch((error) => ({
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to pause session',
      }));

    case 'SESSION_RESUME_CURRENT':
      return Promise.resolve()
        .then(async () => {
          const state = sessionManager.getState();
          if (!state.isActive || !state.sessionId) {
            throw new Error('No active session to resume');
          }
          if (!state.isPaused) {
            return { ok: true as const, state };
          }

          const sessionId = state.sessionId;
          const existingScope = getSessionTabScope(sessionId);
          let baseOrigin = existingScope?.baseOrigin ?? state.baseOrigin;
          let allowedTabIds = existingScope
            ? Array.from(existingScope.allowedTabIds)
            : (state.allowedTabIds ?? []);
          let resumeTab = await resolveCaptureTab(sessionId);

          if (!resumeTab || allowedTabIds.length === 0) {
            const resumedContext = await resolveResumeSessionContext(sessionId);
            baseOrigin = resumedContext.baseOrigin;
            allowedTabIds = resumedContext.tabId !== undefined ? [resumedContext.tabId] : [];
            if (typeof resumedContext.tab?.id === 'number') {
              const contentReady = await ensureContentScriptReady(resumedContext.tab.id);
              if (!contentReady) {
                throw new Error('Content script is not available on the active tab. Reload the page and retry.');
              }
            }
            setSessionTabScope(sessionId, resumedContext.activeUrl, resumedContext.tabId);
            sessionManager.setSessionScope({
              baseOrigin,
              allowedTabIds,
            });
            resumeTab = resumedContext.tab;
          }

          if (resumeTab && typeof resumeTab.id === 'number') {
            rememberCaptureTabForSession(sessionId, resumeTab);
            const contentReady = await ensureContentScriptReady(resumeTab.id);
            if (!contentReady) {
              throw new Error('Content script is not available on the active tab. Reload the page and retry.');
            }
          }

          const resumeTabContext = buildSessionContextFromTab(resumeTab);

          const resumed = sessionManager.resumeSession({
            sessionId,
            url: resumeTab?.url ?? state.baseOrigin ?? 'about:blank',
            tabId: typeof resumeTab?.id === 'number' ? resumeTab.id : undefined,
            windowId: typeof resumeTab?.windowId === 'number' ? resumeTab.windowId : undefined,
            baseOrigin,
            allowedTabIds,
            userAgent: navigator.userAgent,
            viewport: resumeTabContext.viewport,
            dpr: resumeTabContext.dpr,
            safeMode: captureConfig.safeMode,
          });
          await syncCaptureConfigToSessionTabs(sessionId);

          sessionManager.queueEvent('custom', {
            marker: 'session_resumed',
            sessionId,
            timestamp: Date.now(),
          }, {
            tabId: typeof resumeTab?.id === 'number' ? resumeTab.id : undefined,
            origin: baseOrigin,
          });

          syncAutomationBadge();

          return { ok: true as const, state: resumed };
        })
        .catch((error) => ({
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to resume session',
        }));

    case 'SESSION_RESUME_BY_ID':
      return Promise.resolve()
        .then(async () => {
          const requestedSessionId = request.sessionId.trim();
          if (!requestedSessionId) {
            throw new Error('sessionId is required');
          }

          const state = sessionManager.getState();
          if (state.isActive && state.sessionId && state.sessionId !== requestedSessionId) {
            throw new Error('Stop or resume the current session before resuming a different session.');
          }

          if (state.isActive && state.sessionId === requestedSessionId) {
            if (state.isPaused) {
              return handleRequest({ type: 'SESSION_RESUME_CURRENT' }, sender);
            }
            return { ok: true as const, state };
          }

          const resumedContext = await resolveResumeSessionContext(requestedSessionId);
          if (typeof resumedContext.tab?.id === 'number') {
            const contentReady = await ensureContentScriptReady(resumedContext.tab.id);
            if (!contentReady) {
              throw new Error('Content script is not available on the active tab. Reload the page and retry.');
            }
          }
          setSessionTabScope(requestedSessionId, resumedContext.activeUrl, resumedContext.tabId);
          sessionManager.setSessionScope({
            baseOrigin: resumedContext.baseOrigin,
            allowedTabIds: resumedContext.tabId !== undefined ? [resumedContext.tabId] : [],
          });

          const resumed = sessionManager.resumeSession({
            sessionId: requestedSessionId,
            url: resumedContext.activeUrl,
            tabId: resumedContext.tabId,
            windowId: resumedContext.windowId,
            baseOrigin: resumedContext.baseOrigin,
            allowedTabIds: resumedContext.tabId !== undefined ? [resumedContext.tabId] : [],
            userAgent: navigator.userAgent,
            viewport: resumedContext.viewport,
            dpr: resumedContext.dpr,
            safeMode: captureConfig.safeMode,
          });

          if (resumed.sessionId && typeof resumedContext.tab?.id === 'number') {
            rememberCaptureTabForSession(resumed.sessionId, resumedContext.tab);
            await syncCaptureConfigToSessionTabs(resumed.sessionId);
          }

          sessionManager.queueEvent('custom', {
            marker: 'session_resumed',
            sessionId: requestedSessionId,
            timestamp: Date.now(),
          }, {
            tabId: resumedContext.tabId,
            origin: resumedContext.baseOrigin,
          });

          syncAutomationBadge();

          return { ok: true as const, state: resumed };
        })
        .catch((error) => ({
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to resume session',
        }));

    case 'SESSION_STOP':
      return Promise.resolve().then(async () => {
        await overridePocController.disable().catch(() => undefined);
        const activeSessionId = sessionManager.getState().sessionId;
        const stopped = sessionManager.stopSession();
        if (activeSessionId) {
          await syncCaptureConfigToSessionTabs(activeSessionId).catch(() => undefined);
          cleanupSessionLocalState(activeSessionId);
        }
        syncAutomationBadge();
        return { ok: true as const, state: stopped };
      });

    case 'SESSION_QUEUE_EVENT': {
      const senderUrl = sender.tab?.url ?? sender.url ?? '';
      const senderTabId = typeof sender.tab?.id === 'number' ? sender.tab.id : undefined;
      captureDiagnostics.received += 1;
      captureDiagnostics.lastEventType = request.eventType;
      captureDiagnostics.lastSenderUrl = senderUrl;
      captureDiagnostics.lastUpdatedAt = Date.now();

      const activeSessionId = sessionManager.getState().sessionId;
      if (!activeSessionId) {
        captureDiagnostics.rejectedInactive += 1;
        return Promise.resolve({ ok: true, state: sessionManager.getState(), accepted: false });
      }

      if (!isTabAllowedForSession(activeSessionId, senderTabId)) {
        captureDiagnostics.rejectedTabScope += 1;
        return Promise.resolve({ ok: true, state: sessionManager.getState(), accepted: false });
      }

      const shouldValidateByAllowlist = senderUrl.startsWith('http://') || senderUrl.startsWith('https://');
      if (shouldValidateByAllowlist && !isUrlAllowed(senderUrl, captureConfig.allowlist)) {
        captureDiagnostics.rejectedAllowlist += 1;
        return Promise.resolve({ ok: true, state: sessionManager.getState(), accepted: false });
      }

      let payload = request.data;
      if (captureConfig.safeMode) {
        const restricted = applySafeModeRestrictions(request.eventType, request.data);
        if (!restricted) {
          captureDiagnostics.rejectedSafeMode += 1;
          return Promise.resolve({ ok: true, state: sessionManager.getState(), accepted: false });
        }
        payload = restricted;
      }

      const eventOrigin = resolveSessionEventOrigin(senderUrl, payload);
      const accepted = sessionManager.queueEvent(request.eventType, payload, {
        tabId: senderTabId,
        origin: eventOrigin,
      });
      if (accepted) {
        captureDiagnostics.accepted += 1;
        liveConsoleBufferStore.append(activeSessionId, request.eventType, payload, {
          tabId: senderTabId,
          origin: eventOrigin,
          now: Date.now(),
        });
      } else {
        captureDiagnostics.rejectedInactive += 1;
      }
      return Promise.resolve({ ok: true, state: sessionManager.getState(), accepted });
    }

    case 'SESSION_CAPTURE_DIAGNOSTICS':
      return Promise.resolve({
        ok: true,
        result: {
          ...captureDiagnostics,
          sessionState: sessionManager.getState(),
          allowlist: captureConfig.allowlist,
          safeMode: captureConfig.safeMode,
        },
      });

    case 'TEST_SET_SERVER_BASE_URL':
      return Promise.resolve().then(async () => {
        const nextBaseUrl = normalizeServerBaseUrl(request.serverBaseUrl ?? null);
        await persistServerBaseUrl(nextBaseUrl);
        applyServerBaseUrl(nextBaseUrl);
        return {
          ok: true as const,
          result: {
            serverBaseUrl: getServerBaseUrl(),
            overrideActive: serverBaseUrlOverride !== null,
          },
        };
      });

    case 'SESSION_RECOVER_HEALTH':
      return Promise.resolve()
        .then(async () => {
          const state = sessionManager.getState();
          if (state.isActive) {
            if (state.isPaused) {
              return handleRequest({ type: 'SESSION_RESUME_CURRENT' }, sender);
            }
            return { ok: true as const, state };
          }

          const targetSessionId = resolveRequestedSessionId(request.sessionId, state);
          if (targetSessionId) {
            return handleRequest({ type: 'SESSION_RESUME_BY_ID', sessionId: targetSessionId }, sender);
          }

          return handleRequest({ type: 'SESSION_START' }, sender);
        })
        .catch((error) => ({
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to recover session',
        }));

    case 'SESSION_RETRY_CONTENT_SCRIPT':
      return Promise.resolve()
        .then(async () => {
          const state = sessionManager.getState();
          const targetSessionId = resolveRequestedSessionId(request.sessionId, state);
          if (!targetSessionId) {
            throw new Error('No session is available for content-script recovery');
          }

          const result = await retryContentScriptForSession(targetSessionId);
          return {
            ok: true as const,
            result: {
              sessionId: targetSessionId,
              tabId: result.tab.id,
              windowId: result.tab.windowId,
              url: result.tab.url ?? '',
              ready: result.ready,
            },
          };
        })
        .catch((error) => ({
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to retry content script',
        }));

    case 'SESSION_FOCUS_CAPTURE_TAB':
      return Promise.resolve()
        .then(async () => {
          const state = sessionManager.getState();
          const targetSessionId = resolveRequestedSessionId(request.sessionId, state);
          if (!targetSessionId) {
            throw new Error('No session is available to focus');
          }

          const tab = await focusCaptureTabForSession(targetSessionId);
          return {
            ok: true as const,
            result: {
              sessionId: targetSessionId,
              tabId: tab.id,
              windowId: tab.windowId,
              url: tab.url ?? '',
            },
          };
        })
        .catch((error) => ({
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to focus capture tab',
        }));

    case 'SESSION_GET_TAB_SCOPE':
      return Promise.resolve()
        .then(async () => {
          const sessionState = sessionManager.getState();
          if (!sessionState.sessionId || !sessionState.isActive) {
            return {
              ok: true as const,
              result: {
                isActive: false,
                sessionId: null,
                baseOrigin: undefined,
                allowedTabIds: [],
                tabs: [],
              },
            };
          }

          const scope = await buildSessionTabScopeResult(sessionState.sessionId);
          return {
            ok: true as const,
            result: {
              isActive: true,
              ...scope,
            },
          };
        })
        .catch((error) => ({ ok: false as const, error: error instanceof Error ? error.message : 'Failed to read tab scope' }));

    case 'OVERRIDE_POC_GET_STATUS':
      return Promise.resolve()
        .then(async () => ({
          ok: true as const,
          result: await buildOverridePocStatusResult(
            sessionManager.getState().sessionId,
            await overridePocController.getStatus(),
          ),
        }))
        .catch((error) => ({ ok: false as const, error: error instanceof Error ? error.message : 'Failed to read override POC status' }));

    case 'OVERRIDE_POC_SET_TARGET_TAB':
      return Promise.resolve()
        .then(async () => {
          const sessionState = sessionManager.getState();
          if (!sessionState.sessionId || !sessionState.isActive) {
            throw new Error('Start or resume a session before selecting an override target tab.');
          }

          const activeOverrideTabId = overridePocController.getActiveTabId();
          if (typeof activeOverrideTabId === 'number' && request.tabId !== activeOverrideTabId) {
            throw new Error('Disable the active override before changing the target tab.');
          }

          if (request.tabId === null) {
            overridePocTargetTabBySession.delete(sessionState.sessionId);
          } else {
            const tab = await getBoundSessionTab(sessionState.sessionId, request.tabId);
            overridePocTargetTabBySession.set(sessionState.sessionId, tab.id as number);
          }

          const status = await overridePocController.getStatus();
          return {
            ok: true as const,
            result: await buildOverridePocStatusResult(sessionState.sessionId, status),
          };
        })
        .catch((error) => ({ ok: false as const, error: error instanceof Error ? error.message : 'Failed to set override target tab' }));

    case 'OVERRIDE_POC_ENABLE':
      return Promise.resolve()
        .then(async () => {
          const sessionState = sessionManager.getState();
          if (!sessionState.sessionId || !sessionState.isActive || sessionState.isPaused) {
            throw new Error('Start or resume an active session before enabling the override POC.');
          }

          const requestedTabId = typeof request.tabId === 'number' && Number.isFinite(request.tabId)
            ? Math.floor(request.tabId)
            : undefined;
          const tab = await resolveOverridePocTab(sessionState.sessionId, requestedTabId);
          if (!tab || typeof tab.id !== 'number') {
            throw new Error('No capture tab is available for the active session.');
          }

          overridePocTargetTabBySession.set(sessionState.sessionId, tab.id);
          const status = await overridePocController.enableForTab({
            sessionId: sessionState.sessionId,
            tabId: tab.id,
            selectedTabId: requestedTabId ?? getSelectedOverridePocTabId(sessionState.sessionId),
          });
          return {
            ok: true as const,
            result: await buildOverridePocStatusResult(sessionState.sessionId, status),
          };
        })
        .catch((error) => ({ ok: false as const, error: error instanceof Error ? error.message : 'Failed to enable override POC' }));

    case 'OVERRIDE_POC_DISABLE':
      return Promise.resolve()
        .then(async () => ({
          ok: true as const,
          result: await overridePocController.disable(),
        }))
        .catch((error) => ({ ok: false as const, error: error instanceof Error ? error.message : 'Failed to disable override POC' }));

    case 'SESSION_ADD_TAB_TO_SESSION':
      return Promise.resolve()
        .then(async () => {
          const sessionState = sessionManager.getState();
          if (!sessionState.sessionId || !sessionState.isActive) {
            throw new Error('No active session to bind tab');
          }

          const requestedTabId = Number(request.tabId);
          if (!Number.isInteger(requestedTabId)) {
            throw new Error('tabId must be an integer');
          }

          const tab = await chrome.tabs.get(requestedTabId);
          if (!tab || typeof tab.id !== 'number') {
            throw new Error('Tab not found: ' + requestedTabId);
          }

          let scope = getSessionTabScope(sessionState.sessionId);
          if (!scope) {
            scope = {
              baseOrigin: sessionState.baseOrigin,
              allowedTabIds: new Set<number>(),
            };
            sessionTabScopeBySession.set(sessionState.sessionId, scope);
          }

          scope.allowedTabIds.add(tab.id);
          void persistSessionBindings(chrome.storage.local);
          sessionManager.setSessionScope({
            baseOrigin: scope.baseOrigin,
            allowedTabIds: Array.from(scope.allowedTabIds),
          });

          if (!captureTabBySession.has(sessionState.sessionId)) {
            rememberCaptureTabForSession(sessionState.sessionId, tab);
          }

          await syncCaptureConfigToSessionTabs(sessionState.sessionId);

          const result = await buildSessionTabScopeResult(sessionState.sessionId);
          return { ok: true as const, result: { isActive: true, ...result } };
        })
        .catch((error) => ({ ok: false as const, error: error instanceof Error ? error.message : 'Failed to add tab to session' }));

    case 'SESSION_REMOVE_TAB_FROM_SESSION':
      return Promise.resolve()
        .then(async () => {
          const sessionState = sessionManager.getState();
          if (!sessionState.sessionId || !sessionState.isActive) {
            throw new Error('No active session to update');
          }

          const requestedTabId = Number(request.tabId);
          if (!Number.isInteger(requestedTabId)) {
            throw new Error('tabId must be an integer');
          }

          const scope = getSessionTabScope(sessionState.sessionId);
          if (!scope) {
            throw new Error('Session tab scope is unavailable');
          }

          scope.allowedTabIds.delete(requestedTabId);
          void persistSessionBindings(chrome.storage.local);
          sessionManager.setSessionScope({
            baseOrigin: scope.baseOrigin,
            allowedTabIds: Array.from(scope.allowedTabIds),
          });
          await sendCaptureConfigUpdateToTab(requestedTabId, {
            ...buildCaptureConfigUpdatePayload(sessionState.sessionId),
            captureEnabled: false,
          }).catch(() => undefined);
          const remembered = captureTabBySession.get(sessionState.sessionId);
          if (remembered?.tabId === requestedTabId) {
            captureTabBySession.delete(sessionState.sessionId);
            void persistSessionBindings(chrome.storage.local);
          }
          if (overridePocTargetTabBySession.get(sessionState.sessionId) === requestedTabId) {
            overridePocTargetTabBySession.delete(sessionState.sessionId);
          }

          if (scope.allowedTabIds.size === 0) {
            cleanupSessionLocalState(sessionState.sessionId);
            await overridePocController.disable().catch(() => undefined);
            const stopped = sessionManager.stopSession();
            syncAutomationBadge();
            return { ok: true as const, state: stopped };
          }

          if (overridePocController.isActiveForTab(requestedTabId)) {
            await overridePocController.disable().catch(() => undefined);
          }

          const result = await buildSessionTabScopeResult(sessionState.sessionId);
          return { ok: true as const, result: { isActive: true, ...result } };
        })
        .catch((error) => ({ ok: false as const, error: error instanceof Error ? error.message : 'Failed to remove tab from session' }));

    case 'AUTOMATION_EMERGENCY_STOP':
      return saveCaptureConfig(chrome.storage.local, {
        ...captureConfig,
        automation: {
          ...captureConfig.automation,
          enabled: false,
        },
      })
        .then(async (saved) => {
          captureConfig = saved;
          queueAutomationStoppedEvent('emergency_stop');
          automationUiState = { status: 'idle' };
          syncAutomationBadge();
          const sessionId = sessionManager.getState().sessionId;
          if (sessionId) {
            await syncCaptureConfigToSessionTabs(sessionId);
          }
          return { ok: true as const, config: saved };
        })
        .catch((error) => ({ ok: false as const, error: error instanceof Error ? error.message : 'Failed to stop automation' }));

    case 'RETENTION_GET_SETTINGS':
      return fetchServer('/retention/settings')
        .then((response) => ({
          ok: true as const,
          retention: response.settings,
          lastCleanup: response.lastCleanup,
        }))
        .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : 'Failed to load settings' }));

    case 'RETENTION_UPDATE_SETTINGS':
      return fetchServer('/retention/settings', {
        method: 'POST',
        body: JSON.stringify(request.settings),
      })
        .then((response) => ({
          ok: true as const,
          retention: response.settings,
        }))
        .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : 'Failed to update settings' }));

    case 'RETENTION_RUN_CLEANUP':
      return fetchServer('/retention/run-cleanup', {
        method: 'POST',
      })
        .then((response) => ({ ok: true as const, result: response.result }))
        .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : 'Failed to run cleanup' }));

    case 'SESSION_PIN':
      return fetchServer(`/sessions/${encodeURIComponent(request.sessionId)}/pin`, {
        method: 'POST',
        body: JSON.stringify({ pinned: request.pinned }),
      })
        .then((response) => {
          if (response.ok !== true) {
            throw new Error((response.error as string) ?? 'Failed to pin session');
          }
          return { ok: true as const, result: response };
        })
        .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : 'Failed to pin session' }));

    case 'SESSION_EXPORT':
      return fetchServer(`/sessions/${encodeURIComponent(request.sessionId)}/export`, {
        method: 'POST',
        body: JSON.stringify({
          format: request.format,
          compatibilityMode: request.compatibilityMode,
          includePngBase64: request.includePngBase64,
        }),
      })
        .then((response) => ({ ok: true as const, result: response }))
        .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : 'Failed to export session' }));

    case 'SESSION_IMPORT':
      return fetchServer('/sessions/import', {
        method: 'POST',
        body: JSON.stringify(
          request.format === 'zip'
            ? { format: 'zip', archiveBase64: request.archiveBase64 ?? '' }
            : request.payload
        ),
      })
        .then((response) => ({ ok: true as const, result: response }))
        .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : 'Failed to import session' }));

    case 'SESSION_GET_DB_ENTRIES':
      return fetchServer(
        `/sessions/${encodeURIComponent(request.sessionId)}/entries?limit=${encodeURIComponent(String(request.limit))}&offset=${encodeURIComponent(String(request.offset))}`
      )
        .then((response) => ({ ok: true as const, result: response }))
        .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : 'Failed to load DB entries' }));

    case 'SESSION_GET_SNAPSHOTS':
      return fetchServer(
        `/sessions/${encodeURIComponent(request.sessionId)}/snapshots?limit=${encodeURIComponent(String(request.limit))}&offset=${encodeURIComponent(String(request.offset))}`
      )
        .then((response) => ({ ok: true as const, result: response }))
        .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : 'Failed to load snapshots' }));

    case 'SESSION_LIST_RECENT':
      return fetchServer(
        `/sessions?limit=${encodeURIComponent(String(request.limit))}&offset=${encodeURIComponent(String(request.offset))}`
      )
        .then((response) => ({ ok: true as const, result: response }))
        .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : 'Failed to load sessions' }));

    case 'DB_RESET':
      return fetchServer('/db/reset', { method: 'POST' })
        .then((response) => ({ ok: true as const, result: response }))
        .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : 'Failed to reset database' }));

    default:
      return Promise.resolve({ ok: false, error: 'Unsupported message type' });
  }
}

chrome.runtime.onMessage.addListener((request: RuntimeRequest, _sender, sendResponse) => {
  handleRequest(request, _sender)
    .then((response) => {
      sendResponse(response);
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : 'Unexpected background error',
      });
    });

  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') {
    return;
  }

  scheduleBoundTabRecovery(tabId, tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearSessionTabRecoveryTimer(tabId);
  const state = sessionManager.getState();
  if (!state.sessionId || !state.isActive) {
    return;
  }

  const scope = getSessionTabScope(state.sessionId);
  if (!scope || !scope.allowedTabIds.has(tabId)) {
    return;
  }

  scope.allowedTabIds.delete(tabId);
  sessionManager.setSessionScope({
    baseOrigin: scope.baseOrigin,
    allowedTabIds: Array.from(scope.allowedTabIds),
  });
  const remembered = captureTabBySession.get(state.sessionId);
  if (remembered?.tabId === tabId) {
    captureTabBySession.delete(state.sessionId);
  }
  if (overridePocTargetTabBySession.get(state.sessionId) === tabId) {
    overridePocTargetTabBySession.delete(state.sessionId);
  }

  if (scope.allowedTabIds.size > 0) {
    if (overridePocController.isActiveForTab(tabId)) {
      void overridePocController.disable().catch(() => undefined);
    }
    return;
  }

  if (state.isPaused) {
    captureTabBySession.delete(state.sessionId);
    return;
  }

  cleanupSessionLocalState(state.sessionId);
  void overridePocController.disable().catch(() => undefined);
  sessionManager.stopSession();
  syncAutomationBadge();
});

console.log(`${LOG_PREFIX} Service worker started`);

chrome.runtime.onStartup.addListener(() => {
  console.log(`${LOG_PREFIX} Extension started`);
});

chrome.runtime.onInstalled.addListener(() => {
  console.log(`${LOG_PREFIX} Extension installed`);
});
