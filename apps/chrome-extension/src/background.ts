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
  canCaptureSnapshot,
  CaptureConfig,
  DEFAULT_CAPTURE_CONFIG,
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

const snapshotPngUsageBySession = new Map<string, SnapshotPngUsage>();
const captureTabBySession = new Map<string, { tabId: number; windowId?: number }>();
const sessionTabScopeBySession = new Map<string, SessionTabScope>();
const liveConsoleBufferStore = new LiveConsoleBufferStore();
let automationUiState: AutomationUiState = { status: 'idle' };
const FULL_PAGE_CAPTURE_SCROLL_SETTLE_MS = 120;
const MAX_STITCHED_PNG_PIXELS = 40_000_000;

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
  liveConsoleBufferStore.clearSession(sessionId);
  if (automationUiState.sessionId === sessionId) {
    automationUiState = { status: 'idle' };
  }
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

function buildCaptureConfigUpdatePayload(sessionId?: string): CaptureConfigUpdatePayload {
  const automationStatus = getAutomationStatus();
  return {
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
  const payload = buildCaptureConfigUpdatePayload(sessionId);
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
      && requiresSensitiveAutomationOptIn({ selector: request.target?.selector, action: request.action })) {
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
        frameId: request.target?.frameId ?? 0,
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
});
const LOG_PREFIX = '[BrowserDebug][Background]';
let captureConfig: CaptureConfig = { ...DEFAULT_CAPTURE_CONFIG };
const SERVER_BASE_URL = 'http://127.0.0.1:8065';
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

void loadCaptureConfig(chrome.storage.local).then((loaded) => {
  captureConfig = loaded;
  syncAutomationBadge();
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

  const response = await fetch(`${SERVER_BASE_URL}${path}`, {
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

          syncAutomationBadge();

          return { ok: true as const, state: started };
        })
        .catch((error) => ({
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to start session',
        }));
    }

    case 'SESSION_PAUSE':
      return Promise.resolve().then(() => {
        const state = sessionManager.getState();
        if (!state.isActive || !state.sessionId) {
          throw new Error('No active session to pause');
        }
        if (state.isPaused) {
          return { ok: true as const, state };
        }

        const paused = sessionManager.pauseSession();
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

          syncAutomationBadge();

          return { ok: true as const, state: resumed };
        })
        .catch((error) => ({
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to resume session',
        }));

    case 'SESSION_STOP':
      return Promise.resolve().then(() => {
        const activeSessionId = sessionManager.getState().sessionId;
        if (activeSessionId) {
          cleanupSessionLocalState(activeSessionId);
        }
        const stopped = sessionManager.stopSession();
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

          if (scope.allowedTabIds.size === 0) {
            cleanupSessionLocalState(sessionState.sessionId);
            const stopped = sessionManager.stopSession();
            syncAutomationBadge();
            return { ok: true as const, state: stopped };
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

  if (scope.allowedTabIds.size > 0) {
    return;
  }

  if (state.isPaused) {
    captureTabBySession.delete(state.sessionId);
    return;
  }

  cleanupSessionLocalState(state.sessionId);
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
