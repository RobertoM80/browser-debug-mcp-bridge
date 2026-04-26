import { SessionManager, SessionState, CaptureCommandType } from './session-manager';
import { LiveConsoleBufferStore } from './live-console-buffer';
import {
  applySafeModeRestrictions,
  canCaptureSnapshot,
  CaptureConfig,
  DEFAULT_CAPTURE_CONFIG,
  isUrlAllowed,
  loadCaptureConfig,
  SnapshotStyleMode,
  saveCaptureConfig,
} from './capture-controls';
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
import { redactSnapshotRecord } from '../../../libs/redaction/src';

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
  | { type: 'SESSION_GET_TAB_SCOPE' }
  | { type: 'SESSION_ADD_TAB_TO_SESSION'; tabId: number }
  | { type: 'SESSION_REMOVE_TAB_FROM_SESSION'; tabId: number }
  | { type: 'OVERRIDE_POC_GET_STATUS' }
  | { type: 'OVERRIDE_POC_SET_TARGET_TAB'; tabId: number | null }
  | { type: 'OVERRIDE_POC_ENABLE'; tabId?: number }
  | { type: 'OVERRIDE_POC_DISABLE' }
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
  network: {
    captureBodies: boolean;
    maxBodyBytes: number;
  };
}

interface SessionTabScope {
  baseOrigin?: string;
  allowedTabIds: Set<number>;
}

interface RuntimeStorageAreaLike {
  get(keys: string | string[] | Record<string, unknown> | null, callback: (items: Record<string, unknown>) => void): void;
}

const snapshotPngUsageBySession = new Map<string, SnapshotPngUsage>();
const captureTabBySession = new Map<string, { tabId: number; windowId?: number }>();
const sessionTabScopeBySession = new Map<string, SessionTabScope>();
const overridePocTargetTabBySession = new Map<string, number>();
const liveConsoleBufferStore = new LiveConsoleBufferStore();
let overridePocDiagnosisCache: {
  key: string;
  expiresAt: number;
  diagnosis: OverridePocUiDiagnosis | undefined;
} | null = null;
const FULL_PAGE_CAPTURE_SCROLL_SETTLE_MS = 120;
const MAX_STITCHED_PNG_PIXELS = 40_000_000;
const DEFAULT_SERVER_BASE_URL = 'http://127.0.0.1:8065';
const SERVER_BASE_URL_STORAGE_KEY = 'serverBaseUrl';

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
  initiatorType?: string;
  rel?: string;
  as?: string;
  integrity?: string;
  crossOrigin?: string;
  nonce?: string;
  fromDom: boolean;
  fromPerformance: boolean;
}

interface ObservedOverrideAssetsResult {
  pageUrl: string;
  baseUrl: string;
  title: string;
  serviceWorkerControlled: boolean;
  cspMetaTags: string[];
  assets: ObservedOverrideAsset[];
}

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

function setSessionTabScope(sessionId: string, baseUrl: string, tabId?: number): void {
  const allowedTabIds = new Set<number>();
  if (typeof tabId === 'number') {
    allowedTabIds.add(tabId);
  }

  sessionTabScopeBySession.set(sessionId, {
    baseOrigin: normalizeHttpOrigin(baseUrl),
    allowedTabIds,
  });
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
  captureTabBySession.delete(sessionId);
  sessionTabScopeBySession.delete(sessionId);
  overridePocTargetTabBySession.delete(sessionId);
  liveConsoleBufferStore.clearSession(sessionId);
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

async function buildOverridePocStatusResult(
  sessionId: string | null | undefined,
  status: OverridePocStatus,
): Promise<OverridePocStatus & { diagnosis?: OverridePocUiDiagnosis }> {
  if (!sessionId) {
    return status;
  }

  const selectedTabId = getSelectedOverridePocTabId(sessionId);
  const diagnosis = await readOverridePocDiagnosis(sessionId, status);
  return {
    ...status,
    selectedTabId: typeof selectedTabId === 'number' ? selectedTabId : status.selectedTabId,
    diagnosis,
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

async function executeScriptInTab<T>(tabId: number, func: (...args: unknown[]) => T, args: unknown[] = []): Promise<T> {
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
        existing.fromDom = existing.fromDom || asset.fromDom;
        existing.fromPerformance = existing.fromPerformance || asset.fromPerformance;
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

    for (const script of Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]'))) {
      const url = toAbsoluteUrl(script.getAttribute('src'));
      if (!url) {
        continue;
      }
      addAsset({
        url,
        kind: script.type === 'module' ? 'module-script' : 'script',
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
        if (!url.includes('/_next/') && !['script', 'link', 'css'].includes(entry.initiatorType)) {
          continue;
        }
        addAsset({
          url,
          kind: entry.initiatorType || 'resource',
          initiatorType: entry.initiatorType || undefined,
          fromDom: false,
          fromPerformance: true,
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
}

async function resolveCaptureTab(sessionId: string): Promise<chrome.tabs.Tab | undefined> {
  const scope = getSessionTabScope(sessionId);
  const allowedTabIds = scope ? Array.from(scope.allowedTabIds) : [];

  const remembered = captureTabBySession.get(sessionId);
  if (remembered && (!scope || scope.allowedTabIds.has(remembered.tabId))) {
    try {
      const tab = await chrome.tabs.get(remembered.tabId);
      if (tab && typeof tab.id === 'number') {
        rememberCaptureTabForSession(sessionId, tab);
        return tab;
      }
    } catch {
      captureTabBySession.delete(sessionId);
    }
  }

  for (const candidateTabId of allowedTabIds) {
    try {
      const tab = await chrome.tabs.get(candidateTabId);
      if (tab && typeof tab.id === 'number') {
        rememberCaptureTabForSession(sessionId, tab);
        return tab;
      }
    } catch {
      if (scope) {
        scope.allowedTabIds.delete(candidateTabId);
      }
    }
  }

  const active = await getActiveTab();
  if (active && typeof active.id === 'number' && (!scope || scope.allowedTabIds.has(active.id))) {
    rememberCaptureTabForSession(sessionId, active);
    return active;
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

    const recovered = await ensureContentScriptReady(tabId);
    if (!recovered) {
      throw new Error('Extension target is unavailable after recovery attempt');
    }

    return attempt();
  }
}

function buildCaptureConfigUpdatePayload(): CaptureConfigUpdatePayload {
  return {
    network: {
      captureBodies: captureConfig.network.captureBodies === true,
      maxBodyBytes: captureConfig.network.maxBodyBytes,
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
  const payload = buildCaptureConfigUpdatePayload();
  const tabIds = getSessionBoundTabIds(sessionId);
  if (tabIds.length === 0) {
    return;
  }

  await Promise.all(
    tabIds.map(async (tabId) => {
      const ready = await ensureContentScriptReady(tabId);
      if (!ready) {
        return;
      }

      try {
        await sendCaptureConfigUpdateToTab(tabId, payload);
      } catch {
        // Ignore per-tab config update failures; tab may have navigated/disconnected.
      }
    }),
  );
}

async function executeCaptureCommand(
  command: CaptureCommandType,
  payload: Record<string, unknown>,
  context: { sessionId: string; commandId: string }
): Promise<{ payload: Record<string, unknown>; truncated?: boolean }> {
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

  const tab = await resolveCaptureTab(context.sessionId);
  if (!tab || tab.id === undefined) {
    throw new Error('No tab available for this session capture');
  }

  rememberCaptureTabForSession(context.sessionId, tab);

  const tabId = tab.id;
  const contentReady = await ensureContentScriptReady(tabId);
  if (!contentReady) {
    throw new Error('Target tab for this session is unavailable for live capture');
  }

  try {
    await sendCaptureConfigUpdateToTab(tabId, buildCaptureConfigUpdatePayload());
  } catch {
    // Best effort; capture can continue with injected defaults.
  }

  if (command === 'CAPTURE_UI_SNAPSHOT') {
    const llmRequested = payload.llmRequested === true;
    if (!canCaptureSnapshot(captureConfig, { llmRequested })) {
      throw new Error('Snapshot capture is disabled or requires request opt-in');
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

    const captured = await sendCaptureCommandToTab(tabId, 'CAPTURE_UI_SNAPSHOT', contentPayload);

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

  return sendCaptureCommandToTab(tabId, command, payload);
}

const sessionManager = new SessionManager({
  handleCaptureCommand: executeCaptureCommand,
  wsUrl: 'ws://127.0.0.1:8065/ws',
});
const LOG_PREFIX = '[BrowserDebug][Background]';
let captureConfig: CaptureConfig = { ...DEFAULT_CAPTURE_CONFIG };
let serverBaseUrl = DEFAULT_SERVER_BASE_URL;
const overridePocController = new OverridePocController(serverBaseUrl);
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

function normalizeServerBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return DEFAULT_SERVER_BASE_URL;
  }

  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return DEFAULT_SERVER_BASE_URL;
    }

    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return DEFAULT_SERVER_BASE_URL;
  }
}

function toWebSocketUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.pathname = '/ws';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function applyServerBaseUrl(nextBaseUrl: unknown): void {
  serverBaseUrl = normalizeServerBaseUrl(nextBaseUrl);
  sessionManager.setWsUrl(toWebSocketUrl(serverBaseUrl));
  overridePocController.setServerBaseUrl(serverBaseUrl);
}

function loadServerBaseUrl(storageArea: RuntimeStorageAreaLike): Promise<string> {
  return new Promise((resolve) => {
    storageArea.get(SERVER_BASE_URL_STORAGE_KEY, (items) => {
      resolve(normalizeServerBaseUrl(items[SERVER_BASE_URL_STORAGE_KEY]));
    });
  });
}

void loadCaptureConfig(chrome.storage.local).then((loaded) => {
  captureConfig = loaded;
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

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function pingContentScript(tabId: number): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_PING' }, (response?: CapturePingResponse) => {
      if (chrome.runtime.lastError) {
        resolve(false);
        return;
      }

      resolve(Boolean(response?.ok));
    });
  });
}

async function injectContentScriptFallback(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
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

async function ensureContentScriptReady(tabId: number): Promise<boolean> {
  const initial = await pingContentScript(tabId);
  if (initial) {
    captureDiagnostics.contentScriptReady = true;
    return true;
  }

  const injected = await injectContentScriptFallback(tabId);
  if (!injected) {
    captureDiagnostics.contentScriptReady = false;
    return false;
  }

  const afterInject = await pingContentScript(tabId);
  captureDiagnostics.contentScriptReady = afterInject;
  return afterInject;
}

async function fetchServer(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const headers = new Headers(init?.headers ?? {});
  if (init?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

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
            await ensureContentScriptReady(activeContext.tab.id);
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
        return { ok: true as const, state: sessionManager.pauseSession() };
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
            const allowlisted = await resolveAllowlistedSessionContext();
            baseOrigin = allowlisted.baseOrigin;
            allowedTabIds = allowlisted.tabId !== undefined ? [allowlisted.tabId] : [];
            setSessionTabScope(sessionId, allowlisted.activeUrl, allowlisted.tabId);
            sessionManager.setSessionScope({
              baseOrigin,
              allowedTabIds,
            });
            resumeTab = allowlisted.tab;
          }

          if (resumeTab && typeof resumeTab.id === 'number') {
            rememberCaptureTabForSession(sessionId, resumeTab);
            await ensureContentScriptReady(resumeTab.id);
            await syncCaptureConfigToSessionTabs(sessionId);
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

          sessionManager.queueEvent('custom', {
            marker: 'session_resumed',
            sessionId,
            timestamp: Date.now(),
          }, {
            tabId: typeof resumeTab?.id === 'number' ? resumeTab.id : undefined,
            origin: baseOrigin,
          });

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

          const allowlisted = await resolveAllowlistedSessionContext();
          setSessionTabScope(requestedSessionId, allowlisted.activeUrl, allowlisted.tabId);
          sessionManager.setSessionScope({
            baseOrigin: allowlisted.baseOrigin,
            allowedTabIds: allowlisted.tabId !== undefined ? [allowlisted.tabId] : [],
          });

          const resumed = sessionManager.resumeSession({
            sessionId: requestedSessionId,
            url: allowlisted.activeUrl,
            tabId: allowlisted.tabId,
            windowId: allowlisted.windowId,
            baseOrigin: allowlisted.baseOrigin,
            allowedTabIds: allowlisted.tabId !== undefined ? [allowlisted.tabId] : [],
            userAgent: navigator.userAgent,
            viewport: allowlisted.viewport,
            dpr: allowlisted.dpr,
            safeMode: captureConfig.safeMode,
          });

          if (resumed.sessionId && typeof allowlisted.tab?.id === 'number') {
            rememberCaptureTabForSession(resumed.sessionId, allowlisted.tab);
            await ensureContentScriptReady(allowlisted.tab.id);
            await syncCaptureConfigToSessionTabs(resumed.sessionId);
          }

          sessionManager.queueEvent('custom', {
            marker: 'session_resumed',
            sessionId: requestedSessionId,
            timestamp: Date.now(),
          }, {
            tabId: allowlisted.tabId,
            origin: allowlisted.baseOrigin,
          });

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
        if (activeSessionId) {
          cleanupSessionLocalState(activeSessionId);
        }
        return { ok: true as const, state: sessionManager.stopSession() };
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
          sessionManager.setSessionScope({
            baseOrigin: scope.baseOrigin,
            allowedTabIds: Array.from(scope.allowedTabIds),
          });
          const remembered = captureTabBySession.get(sessionState.sessionId);
          if (remembered?.tabId === requestedTabId) {
            captureTabBySession.delete(sessionState.sessionId);
          }
          if (overridePocTargetTabBySession.get(sessionState.sessionId) === requestedTabId) {
            overridePocTargetTabBySession.delete(sessionState.sessionId);
          }

          if (scope.allowedTabIds.size === 0) {
            cleanupSessionLocalState(sessionState.sessionId);
            await overridePocController.disable().catch(() => undefined);
            return { ok: true as const, state: sessionManager.stopSession() };
          }

          if (overridePocController.isActiveForTab(requestedTabId)) {
            await overridePocController.disable().catch(() => undefined);
          }

          const result = await buildSessionTabScopeResult(sessionState.sessionId);
          return { ok: true as const, result: { isActive: true, ...result } };
        })
        .catch((error) => ({ ok: false as const, error: error instanceof Error ? error.message : 'Failed to remove tab from session' }));

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

chrome.tabs.onRemoved.addListener((tabId) => {
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
});

console.log(`${LOG_PREFIX} Service worker started`);

chrome.runtime.onStartup.addListener(() => {
  console.log(`${LOG_PREFIX} Extension started`);
});

chrome.runtime.onInstalled.addListener(() => {
  console.log(`${LOG_PREFIX} Extension installed`);
});
