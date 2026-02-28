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
import { redactSnapshotRecord } from '../../../libs/redaction/src';

type RuntimeRequest =
  | { type: 'SESSION_GET_STATE' }
  | { type: 'SESSION_START' }
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

interface SessionTabScope {
  baseOrigin?: string;
  allowedTabIds: Set<number>;
}

const snapshotPngUsageBySession = new Map<string, SnapshotPngUsage>();
const captureTabBySession = new Map<string, { tabId: number; windowId?: number }>();
const sessionTabScopeBySession = new Map<string, SessionTabScope>();
const liveConsoleBufferStore = new LiveConsoleBufferStore();

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
  liveConsoleBufferStore.clearSession(sessionId);
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
    const queryResult = liveConsoleBufferStore.query(context.sessionId, {
      tabId: requestedTabId,
      origin: requestedOrigin,
      levels,
      contains,
      sinceTs,
      limit,
      includeRuntimeErrors,
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

    const contentPayload: Record<string, unknown> = {
      ...payload,
      trigger,
      styleMode,
      explicitStyleMode,
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
        dom: mode === 'dom' || mode === 'both',
        png: shouldCapturePng(mode),
        styleMode,
      },
      truncation: {
        dom: Boolean((basePayload as { truncation?: { dom?: unknown } }).truncation?.dom),
        styles: Boolean((basePayload as { truncation?: { styles?: unknown } }).truncation?.styles),
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
        const dataUrl = await captureVisibleTabPng(tab.windowId);
        const byteLength = estimateDataUrlBytes(dataUrl);

        if (byteLength > policy.maxBytesPerImage) {
          png = {
            captured: false,
            reason: 'max_bytes_exceeded',
            byteLength,
            maxBytesPerImage: policy.maxBytesPerImage,
          };
          (snapshotRecord.truncation as Record<string, unknown>).png = true;
        } else {
          registerPngCaptureSuccess(usage, now);
          png = {
            captured: true,
            format: 'png',
            byteLength,
            dataUrl,
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
    return {
      payload: redactedSnapshot.record,
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

function handleRequest(request: RuntimeRequest, sender: chrome.runtime.MessageSender): Promise<RuntimeResponse> {
  switch (request.type) {
    case 'SESSION_GET_STATE':
      return Promise.resolve({ ok: true, state: sessionManager.getState() });

    case 'SESSION_GET_CONFIG':
      return Promise.resolve({ ok: true, config: captureConfig });

    case 'SESSION_UPDATE_CONFIG':
      return saveCaptureConfig(chrome.storage.local, request.config)
        .then((saved) => {
          captureConfig = saved;
          return { ok: true as const, config: saved };
        })
        .catch((error) => ({
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to save capture config',
        }));

    case 'SESSION_START': {
      return getActiveTab()
        .then(async (tab) => {
          const screenWidth = tab?.width ?? globalThis.screen?.width ?? 0;
          const screenHeight = tab?.height ?? globalThis.screen?.height ?? 0;
          const devicePixelRatio = globalThis.devicePixelRatio ?? 1;
          const activeUrl = tab?.url ?? 'about:blank';
          const canCaptureActiveTab = isUrlAllowed(activeUrl, captureConfig.allowlist);

          if (!canCaptureActiveTab) {
            return {
              ok: false as const,
              error: 'Active tab is not in allowlist. Add a domain in popup settings.',
            };
          }

          const initialTabId = typeof tab?.id === 'number' ? tab.id : undefined;
          const baseOrigin = normalizeHttpOrigin(activeUrl);

          const started = sessionManager.startSession({
            url: activeUrl,
            tabId: tab?.id,
            windowId: tab?.windowId,
            baseOrigin,
            allowedTabIds: initialTabId !== undefined ? [initialTabId] : [],
            userAgent: navigator.userAgent,
            viewport: {
              width: screenWidth,
              height: screenHeight,
            },
            dpr: devicePixelRatio,
            safeMode: captureConfig.safeMode,
          });

          if (started.sessionId) {
            setSessionTabScope(started.sessionId, activeUrl, initialTabId);
            sessionManager.setSessionScope({
              baseOrigin,
              allowedTabIds: initialTabId !== undefined ? [initialTabId] : [],
            });
          }

          if (started.sessionId && typeof tab?.id === 'number') {
            rememberCaptureTabForSession(started.sessionId, tab);
            await ensureContentScriptReady(tab.id);
          } else if (started.sessionId) {
            captureTabBySession.delete(started.sessionId);
          }

          sessionManager.queueEvent('custom', {
            marker: 'session_started',
            url: activeUrl,
            timestamp: Date.now(),
          }, {
            tabId: initialTabId,
            origin: baseOrigin,
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

    case 'SESSION_STOP':
      return Promise.resolve().then(() => {
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
            return { ok: true as const, state: sessionManager.stopSession() };
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

  if (scope.allowedTabIds.size > 0) {
    return;
  }

  cleanupSessionLocalState(state.sessionId);
  sessionManager.stopSession();
});

console.log(`${LOG_PREFIX} Service worker started`);

chrome.runtime.onStartup.addListener(() => {
  console.log(`${LOG_PREFIX} Extension started`);
});

chrome.runtime.onInstalled.addListener(() => {
  console.log(`${LOG_PREFIX} Extension installed`);
});
