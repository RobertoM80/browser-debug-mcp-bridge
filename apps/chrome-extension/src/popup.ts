type SessionState = {
  isActive: boolean;
  isPaused: boolean;
  sessionId: string | null;
  baseOrigin?: string;
  allowedTabIds?: number[];
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
  queuedEvents: number;
  droppedEvents: number;
  reconnectAttempts: number;
};

type CaptureConfig = {
  safeMode: boolean;
  allowlist: string[];
  snapshots: {
    enabled: boolean;
    requireOptIn: boolean;
    mode: 'dom' | 'png' | 'both';
    styleMode: 'computed-lite' | 'computed-full';
    triggers: Array<'click' | 'manual' | 'navigation' | 'error'>;
    pngPolicy: {
      maxImagesPerSession: number;
      maxBytesPerImage: number;
      minCaptureIntervalMs: number;
    };
  };
  network: {
    captureBodies: boolean;
    maxBodyBytes: number;
  };
  automation: {
    enabled: boolean;
    allowSensitiveFields: boolean;
  };
};

type SessionResponse =
  | { ok: true; state: SessionState; accepted?: boolean }
  | { ok: true; config: CaptureConfig }
  | { ok: true; retention: RetentionSettings; lastCleanup?: CleanupResult }
  | { ok: true; result: unknown }
  | { ok: false; error: string };

type RetentionSettings = {
  retentionDays: number;
  maxDbMb: number;
  maxSessions: number;
  cleanupIntervalMinutes: number;
  lastCleanupAt: number | null;
  exportPathOverride: string | null;
};

type CleanupResult = {
  deletedSessions: number;
  warning: string | null;
};

type SessionScopeTab = {
  tabId: number;
  title: string;
  url: string;
  origin?: string;
  active: boolean;
  bound: boolean;
};

type SessionTabScope = {
  isActive: boolean;
  sessionId: string | null;
  baseOrigin?: string;
  allowedTabIds: number[];
  tabs: SessionScopeTab[];
};

type SessionImportResult = {
  sessionId: string;
  requestedSessionId: string;
  remappedSessionId: boolean;
  events: number;
  network: number;
  fingerprints: number;
  snapshots: number;
};

type RecentSession = {
  sessionId: string;
  createdAt?: number;
  endedAt?: number | null;
  pausedAt?: number | null;
  status?: string;
};

type CaptureDiagnostics = {
  received: number;
  accepted: number;
  rejectedAllowlist: number;
  rejectedSafeMode: number;
  rejectedTabScope: number;
  rejectedInactive: number;
  lastEventType: string;
  lastSenderUrl: string;
  lastUpdatedAt: number;
  contentScriptReady: boolean;
  fallbackInjected: boolean;
  lastInjectError: string;
  allowlist: string[];
  safeMode: boolean;
  sessionState: SessionState;
};

type StatusTone = 'info' | 'success' | 'warning' | 'error';

let statePollTimer: number | null = null;
let latestSessionState: SessionState | null = null;
let latestCaptureConfig: CaptureConfig | null = null;
let latestCaptureDiagnostics: CaptureDiagnostics | null = null;
const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;
const STATUS_LABELS: Record<StatusTone, string> = {
  info: 'INFO',
  success: 'OK',
  warning: 'NOTE',
  error: 'ERROR',
};

function setStatusMessage(element: HTMLElement | null, message: string, tone: StatusTone): void {
  if (!element) {
    return;
  }

  const trimmed = message.trim();
  element.textContent = trimmed;
  if (!trimmed) {
    delete element.dataset.status;
    delete element.dataset.statusLabel;
    element.removeAttribute('aria-label');
    return;
  }

  element.dataset.status = tone;
  element.dataset.statusLabel = STATUS_LABELS[tone];
  element.setAttribute('aria-label', `${STATUS_LABELS[tone]}: ${trimmed}`);
}

function toneForSessionState(state: SessionState): StatusTone {
  if (state.isActive && state.isPaused) {
    return 'warning';
  }
  if (state.isActive && state.connectionStatus === 'connected') {
    return 'success';
  }
  if (state.connectionStatus === 'connecting' || state.connectionStatus === 'reconnecting') {
    return 'warning';
  }
  if (state.isActive && state.connectionStatus === 'disconnected') {
    return 'error';
  }
  return 'info';
}

function sendRuntimeMessage(message: unknown): Promise<SessionResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response: SessionResponse) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message ?? 'Unknown runtime error' });
        return;
      }
      resolve(response);
    });
  });
}

function renderSessionState(state: SessionState): void {
  latestSessionState = state;
  const statusEl = document.getElementById('status');
  const sessionIdEl = document.getElementById('session-id');
  const queueEl = document.getElementById('queue-size');
  const droppedEl = document.getElementById('dropped-events');
  const startButton = document.getElementById('start-session') as HTMLButtonElement | null;
  const pauseButton = document.getElementById('pause-session') as HTMLButtonElement | null;
  const resumeCurrentButton = document.getElementById('resume-session') as HTMLButtonElement | null;
  const stopButton = document.getElementById('stop-session') as HTMLButtonElement | null;
  const resumeByIdButton = document.getElementById('resume-selected-session') as HTMLButtonElement | null;
  const resumeByIdSelect = document.getElementById('resume-session-id') as HTMLSelectElement | null;

  if (statusEl) {
    const statusLabel = state.connectionStatus === 'reconnecting'
      ? `reconnecting, attempt ${state.reconnectAttempts}`
      : state.connectionStatus;
    const message = state.isActive
      ? state.isPaused
        ? `Session paused (${statusLabel})`
        : `Session active (${statusLabel})`
      : `No active session (${statusLabel})`;
    setStatusMessage(statusEl, message, toneForSessionState(state));
  }
  if (sessionIdEl) {
    sessionIdEl.textContent = state.sessionId ?? '-';
  }
  if (queueEl) {
    queueEl.textContent = String(state.queuedEvents);
  }
  if (droppedEl) {
    droppedEl.textContent = String(state.droppedEvents);
  }
  if (startButton) {
    startButton.disabled = state.isActive;
  }
  if (pauseButton) {
    pauseButton.disabled = !state.isActive || state.isPaused;
  }
  if (resumeCurrentButton) {
    resumeCurrentButton.disabled = !state.isActive || !state.isPaused;
  }
  if (stopButton) {
    stopButton.disabled = !state.isActive;
  }
  if (resumeByIdSelect) {
    resumeByIdSelect.disabled = state.isActive;
  }
  if (resumeByIdButton) {
    resumeByIdButton.disabled = state.isActive;
  }

  renderAutomationStatus();
}

function renderConfig(config: CaptureConfig): void {
  latestCaptureConfig = config;
  const safeModeCheckbox = document.getElementById('safe-mode') as HTMLInputElement | null;
  const allowlistInput = document.getElementById('allowlist-domains') as HTMLTextAreaElement | null;
  const snapshotsEnabled = document.getElementById('snapshots-enabled') as HTMLInputElement | null;
  const snapshotsOptIn = document.getElementById('snapshots-opt-in') as HTMLInputElement | null;
  const snapshotMode = document.getElementById('snapshot-mode') as HTMLSelectElement | null;
  const snapshotStyleMode = document.getElementById('snapshot-style-mode') as HTMLSelectElement | null;
  const triggerClick = document.getElementById('snapshot-trigger-click') as HTMLInputElement | null;
  const triggerManual = document.getElementById('snapshot-trigger-manual') as HTMLInputElement | null;
  const triggerNavigation = document.getElementById('snapshot-trigger-navigation') as HTMLInputElement | null;
  const triggerError = document.getElementById('snapshot-trigger-error') as HTMLInputElement | null;
  const maxImagesPerSession = document.getElementById('snapshot-max-images') as HTMLInputElement | null;
  const maxBytesPerImage = document.getElementById('snapshot-max-bytes') as HTMLInputElement | null;
  const minCaptureIntervalMs = document.getElementById('snapshot-min-interval') as HTMLInputElement | null;
  const networkCaptureBodies = document.getElementById('network-capture-bodies') as HTMLInputElement | null;
  const networkMaxBodyBytes = document.getElementById('network-max-body-bytes') as HTMLInputElement | null;
  const automationEnabled = document.getElementById('automation-enabled') as HTMLInputElement | null;
  const automationSensitive = document.getElementById('automation-sensitive-fields') as HTMLInputElement | null;

  if (safeModeCheckbox) {
    safeModeCheckbox.checked = config.safeMode;
  }

  if (allowlistInput) {
    allowlistInput.value = config.allowlist.join('\n');
  }

  if (snapshotsEnabled) snapshotsEnabled.checked = config.snapshots.enabled;
  if (snapshotsOptIn) snapshotsOptIn.checked = config.snapshots.requireOptIn;
  if (snapshotMode) snapshotMode.value = config.snapshots.mode;
  if (snapshotStyleMode) snapshotStyleMode.value = config.snapshots.styleMode;
  if (triggerClick) triggerClick.checked = config.snapshots.triggers.includes('click');
  if (triggerManual) triggerManual.checked = config.snapshots.triggers.includes('manual');
  if (triggerNavigation) triggerNavigation.checked = config.snapshots.triggers.includes('navigation');
  if (triggerError) triggerError.checked = config.snapshots.triggers.includes('error');
  if (maxImagesPerSession) maxImagesPerSession.value = String(config.snapshots.pngPolicy.maxImagesPerSession);
  if (maxBytesPerImage) maxBytesPerImage.value = String(config.snapshots.pngPolicy.maxBytesPerImage);
  if (minCaptureIntervalMs) minCaptureIntervalMs.value = String(config.snapshots.pngPolicy.minCaptureIntervalMs);
  if (networkCaptureBodies) networkCaptureBodies.checked = config.network.captureBodies;
  if (networkMaxBodyBytes) networkMaxBodyBytes.value = String(config.network.maxBodyBytes);
  if (automationEnabled) automationEnabled.checked = config.automation.enabled;
  if (automationSensitive) automationSensitive.checked = config.automation.allowSensitiveFields;

  renderAutomationStatus();
}

function getConfigFromForm(): CaptureConfig {
  const safeModeCheckbox = document.getElementById('safe-mode') as HTMLInputElement | null;
  const allowlistInput = document.getElementById('allowlist-domains') as HTMLTextAreaElement | null;
  const snapshotsEnabled = document.getElementById('snapshots-enabled') as HTMLInputElement | null;
  const snapshotsOptIn = document.getElementById('snapshots-opt-in') as HTMLInputElement | null;
  const snapshotMode = document.getElementById('snapshot-mode') as HTMLSelectElement | null;
  const snapshotStyleMode = document.getElementById('snapshot-style-mode') as HTMLSelectElement | null;
  const triggerClick = document.getElementById('snapshot-trigger-click') as HTMLInputElement | null;
  const triggerManual = document.getElementById('snapshot-trigger-manual') as HTMLInputElement | null;
  const triggerNavigation = document.getElementById('snapshot-trigger-navigation') as HTMLInputElement | null;
  const triggerError = document.getElementById('snapshot-trigger-error') as HTMLInputElement | null;
  const maxImagesPerSession = document.getElementById('snapshot-max-images') as HTMLInputElement | null;
  const maxBytesPerImage = document.getElementById('snapshot-max-bytes') as HTMLInputElement | null;
  const minCaptureIntervalMs = document.getElementById('snapshot-min-interval') as HTMLInputElement | null;
  const networkCaptureBodies = document.getElementById('network-capture-bodies') as HTMLInputElement | null;
  const networkMaxBodyBytes = document.getElementById('network-max-body-bytes') as HTMLInputElement | null;
  const automationEnabled = document.getElementById('automation-enabled') as HTMLInputElement | null;
  const automationSensitive = document.getElementById('automation-sensitive-fields') as HTMLInputElement | null;

  const allowlist = (allowlistInput?.value ?? '')
    .split(/[\n,]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const triggers: Array<'click' | 'manual' | 'navigation' | 'error'> = [];
  if (triggerClick?.checked) triggers.push('click');
  if (triggerManual?.checked) triggers.push('manual');
  if (triggerNavigation?.checked) triggers.push('navigation');
  if (triggerError?.checked) triggers.push('error');

  const mode = snapshotMode?.value;
  const safeSnapshotMode = mode === 'png' || mode === 'both' || mode === 'dom' ? mode : 'dom';
  const styleMode = snapshotStyleMode?.value;
  const safeStyleMode = styleMode === 'computed-full' || styleMode === 'computed-lite'
    ? styleMode
    : 'computed-lite';

  const pngPolicy = {
    maxImagesPerSession: Number(maxImagesPerSession?.value ?? 8),
    maxBytesPerImage: Number(maxBytesPerImage?.value ?? 1048576),
    minCaptureIntervalMs: Number(minCaptureIntervalMs?.value ?? 5000),
  };

  const network = {
    captureBodies: networkCaptureBodies?.checked === true,
    maxBodyBytes: Number(networkMaxBodyBytes?.value ?? 262144),
  };

  return {
    safeMode: safeModeCheckbox?.checked ?? true,
    allowlist,
    snapshots: {
      enabled: snapshotsEnabled?.checked ?? false,
      requireOptIn: snapshotsOptIn?.checked ?? true,
      mode: safeSnapshotMode,
      styleMode: safeStyleMode,
      triggers,
      pngPolicy,
    },
    network,
    automation: {
      enabled: automationEnabled?.checked === true,
      allowSensitiveFields: automationSensitive?.checked === true,
    },
  };
}

function renderAutomationStatus(): void {
  const statusEl = document.getElementById('automation-status');
  const stopButton = document.getElementById('automation-emergency-stop') as HTMLButtonElement | null;
  const config = latestCaptureConfig;
  const state = latestSessionState;

  if (!config) {
    setStatusMessage(statusEl, 'Loading live automation settings...', 'info');
    if (stopButton) {
      stopButton.disabled = true;
    }
    return;
  }

  if (!config.automation.enabled) {
    setStatusMessage(statusEl, 'Live automation is off. Actions stay blocked until you explicitly arm it.', 'info');
    if (stopButton) {
      stopButton.disabled = true;
    }
    return;
  }

  const baseMessage = config.automation.allowSensitiveFields
    ? 'Live automation armed, including sensitive-field actions.'
    : 'Live automation armed. Sensitive-field actions remain blocked.';
  const hasRunnableSession = Boolean(state?.isActive && !state.isPaused);
  setStatusMessage(
    statusEl,
    hasRunnableSession ? baseMessage : `${baseMessage} Start or resume a session before actions can run.`,
    hasRunnableSession ? 'warning' : 'info'
  );
  if (stopButton) {
    stopButton.disabled = false;
  }
}

function setConfigStatus(message: string, tone: StatusTone = 'info'): void {
  const status = document.getElementById('config-status');
  setStatusMessage(status, message, tone);
}

function setRetentionStatus(message: string, tone: StatusTone = 'info'): void {
  const status = document.getElementById('retention-status');
  setStatusMessage(status, message, tone);
}

function setHealthActionStatus(message: string, tone: StatusTone = 'info'): void {
  const status = document.getElementById('health-action-status');
  setStatusMessage(status, message, tone);
}

function getCurrentSessionId(): string | null {
  const sessionId = (document.getElementById('session-id')?.textContent ?? '').trim();
  if (!sessionId || sessionId === '-') {
    return null;
  }
  return sessionId;
}

function parseRecentSessions(result: unknown): RecentSession[] {
  if (!result || typeof result !== 'object') {
    return [];
  }

  const value = result as { sessions?: unknown };
  if (!Array.isArray(value.sessions)) {
    return [];
  }

  return value.sessions
    .filter((entry): entry is RecentSession => Boolean(entry) && typeof entry === 'object')
    .filter((entry) => typeof entry.sessionId === 'string');
}

function renderPausedSessionOptions(sessions: RecentSession[]): void {
  const select = document.getElementById('resume-session-id') as HTMLSelectElement | null;
  if (!select) {
    return;
  }

  const previousValue = select.value;
  select.replaceChildren();

  const pausedSessions = sessions.filter((session) => {
    if (session.status === 'paused') {
      return true;
    }
    return typeof session.pausedAt === 'number' && session.endedAt === null;
  });

  if (pausedSessions.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No paused sessions';
    select.append(option);
    select.value = '';
    return;
  }

  for (const session of pausedSessions) {
    const option = document.createElement('option');
    option.value = session.sessionId;
    const createdAt =
      typeof session.createdAt === 'number' ? new Date(session.createdAt).toLocaleString() : 'unknown';
    option.textContent = `${session.sessionId} - ${createdAt}`;
    select.append(option);
  }

  const hasPrevious = pausedSessions.some((session) => session.sessionId === previousValue);
  select.value = hasPrevious ? previousValue : pausedSessions[0]?.sessionId ?? '';
}

async function refreshPausedSessionOptions(): Promise<void> {
  const response = await sendRuntimeMessage({ type: 'SESSION_LIST_RECENT', limit: 100, offset: 0 });
  if (!response.ok) {
    return;
  }
  if (!('result' in response)) {
    return;
  }

  renderPausedSessionOptions(parseRecentSessions(response.result));
}

function parseSessionImportResult(result: unknown): SessionImportResult | null {
  if (!result || typeof result !== 'object') {
    return null;
  }

  const candidate = result as Partial<SessionImportResult>;
  if (typeof candidate.sessionId !== 'string' || typeof candidate.requestedSessionId !== 'string') {
    return null;
  }

  return {
    sessionId: candidate.sessionId,
    requestedSessionId: candidate.requestedSessionId,
    remappedSessionId: candidate.remappedSessionId === true,
    events: Number(candidate.events ?? 0),
    network: Number(candidate.network ?? 0),
    fingerprints: Number(candidate.fingerprints ?? 0),
    snapshots: Number(candidate.snapshots ?? 0),
  };
}

function parseSessionTabScope(result: unknown): SessionTabScope | null {
  if (!result || typeof result !== 'object') {
    return null;
  }

  const candidate = result as Partial<SessionTabScope>;
  const isActive = candidate.isActive === true;
  const sessionId = typeof candidate.sessionId === 'string' ? candidate.sessionId : null;
  const allowedTabIds = Array.isArray(candidate.allowedTabIds)
    ? candidate.allowedTabIds
      .filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry))
      .map((entry) => Math.floor(entry))
    : [];

  const tabs = Array.isArray(candidate.tabs)
    ? candidate.tabs
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return null;
        }

        const tab = entry as Partial<SessionScopeTab>;
        if (typeof tab.tabId !== 'number' || !Number.isFinite(tab.tabId)) {
          return null;
        }

        const mapped: SessionScopeTab = {
          tabId: Math.floor(tab.tabId),
          title: typeof tab.title === 'string' ? tab.title : 'Untitled tab',
          url: typeof tab.url === 'string' ? tab.url : '',
          active: tab.active === true,
          bound: tab.bound === true,
        };
        if (typeof tab.origin === 'string') {
          mapped.origin = tab.origin;
        }

        return mapped;
      })
      .filter((entry): entry is SessionScopeTab => entry !== null)
    : [];

  return {
    isActive,
    sessionId,
    baseOrigin: typeof candidate.baseOrigin === 'string' ? candidate.baseOrigin : undefined,
    allowedTabIds,
    tabs,
  };
}

function renderSessionTabScope(scope: SessionTabScope): void {
  const baseOriginEl = document.getElementById('session-base-origin');
  const tabsListEl = document.getElementById('session-tabs-list');
  if (!baseOriginEl || !tabsListEl) {
    return;
  }

  tabsListEl.replaceChildren();

  if (!scope.isActive || !scope.sessionId) {
    setStatusMessage(baseOriginEl, 'No active session. Start one to bind tabs.', 'info');
    const placeholder = document.createElement('div');
    placeholder.className = 'session-tabs-empty';
    placeholder.textContent = 'Session tab binding is available after session start.';
    tabsListEl.appendChild(placeholder);
    return;
  }

  const originLabel = scope.baseOrigin ?? 'unknown origin';
  setStatusMessage(baseOriginEl, 'Base origin: ' + originLabel + ' | Bound tabs: ' + scope.allowedTabIds.length, 'info');

  if (scope.tabs.length === 0) {
    const placeholder = document.createElement('div');
    placeholder.className = 'session-tabs-empty';
    placeholder.textContent = 'No tabs detected in this window.';
    tabsListEl.appendChild(placeholder);
    return;
  }

  for (const tab of scope.tabs) {
    const item = document.createElement('label');
    item.className = 'session-tab-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'session-tab-checkbox';
    checkbox.dataset.tabId = String(tab.tabId);
    checkbox.checked = tab.bound;

    const label = document.createElement('span');
    label.className = 'session-tab-label';
    const activeSuffix = tab.active ? ' (active)' : '';
    const originText = tab.origin ?? 'unknown origin';
    label.textContent = '[' + tab.tabId + '] ' + tab.title + ' | ' + originText + activeSuffix;

    item.appendChild(checkbox);
    item.appendChild(label);
    tabsListEl.appendChild(item);
  }
}

function parseCaptureDiagnostics(result: unknown): CaptureDiagnostics | null {
  if (!result || typeof result !== 'object') {
    return null;
  }

  const candidate = result as Partial<CaptureDiagnostics>;
  const sessionStateCandidate =
    candidate.sessionState && typeof candidate.sessionState === 'object'
      ? (candidate.sessionState as Partial<SessionState>)
      : null;

  if (
    !sessionStateCandidate ||
    typeof sessionStateCandidate.isActive !== 'boolean' ||
    typeof sessionStateCandidate.isPaused !== 'boolean' ||
    typeof sessionStateCandidate.connectionStatus !== 'string' ||
    typeof sessionStateCandidate.queuedEvents !== 'number' ||
    typeof sessionStateCandidate.droppedEvents !== 'number' ||
    typeof sessionStateCandidate.reconnectAttempts !== 'number'
  ) {
    return null;
  }

  return {
    received: Number(candidate.received ?? 0),
    accepted: Number(candidate.accepted ?? 0),
    rejectedAllowlist: Number(candidate.rejectedAllowlist ?? 0),
    rejectedSafeMode: Number(candidate.rejectedSafeMode ?? 0),
    rejectedTabScope: Number(candidate.rejectedTabScope ?? 0),
    rejectedInactive: Number(candidate.rejectedInactive ?? 0),
    lastEventType: typeof candidate.lastEventType === 'string' ? candidate.lastEventType : '',
    lastSenderUrl: typeof candidate.lastSenderUrl === 'string' ? candidate.lastSenderUrl : '',
    lastUpdatedAt: Number(candidate.lastUpdatedAt ?? 0),
    contentScriptReady: candidate.contentScriptReady === true,
    fallbackInjected: candidate.fallbackInjected === true,
    lastInjectError: typeof candidate.lastInjectError === 'string' ? candidate.lastInjectError : '',
    allowlist: Array.isArray(candidate.allowlist)
      ? candidate.allowlist.filter((entry): entry is string => typeof entry === 'string')
      : [],
    safeMode: candidate.safeMode === true,
    sessionState: {
      isActive: sessionStateCandidate.isActive,
      isPaused: sessionStateCandidate.isPaused,
      sessionId: typeof sessionStateCandidate.sessionId === 'string' ? sessionStateCandidate.sessionId : null,
      baseOrigin: typeof sessionStateCandidate.baseOrigin === 'string'
        ? sessionStateCandidate.baseOrigin
        : undefined,
      allowedTabIds: Array.isArray(sessionStateCandidate.allowedTabIds)
        ? sessionStateCandidate.allowedTabIds.filter((entry): entry is number => typeof entry === 'number')
        : [],
      connectionStatus:
        sessionStateCandidate.connectionStatus === 'connecting' ||
        sessionStateCandidate.connectionStatus === 'connected' ||
        sessionStateCandidate.connectionStatus === 'reconnecting' ||
        sessionStateCandidate.connectionStatus === 'disconnected'
          ? sessionStateCandidate.connectionStatus
          : 'disconnected',
      queuedEvents: sessionStateCandidate.queuedEvents,
      droppedEvents: sessionStateCandidate.droppedEvents,
      reconnectAttempts: sessionStateCandidate.reconnectAttempts,
    },
  };
}

function setHealthValue(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = text;
  }
}

function summarizeGuardrails(diagnostics: CaptureDiagnostics): string {
  const allowlistState = diagnostics.allowlist.length > 0
    ? `${diagnostics.allowlist.length} allowlisted`
    : 'allowlist empty';
  return `${diagnostics.safeMode ? 'safe mode on' : 'safe mode off'} | ${allowlistState}`;
}

function summarizeCaptureCounts(diagnostics: CaptureDiagnostics): string {
  return [
    `accepted ${diagnostics.accepted}/${diagnostics.received}`,
    `inactive ${diagnostics.rejectedInactive}`,
    `scope ${diagnostics.rejectedTabScope}`,
    `allowlist ${diagnostics.rejectedAllowlist}`,
    `safe ${diagnostics.rejectedSafeMode}`,
  ].join(' | ');
}

function formatHealthTimestamp(timestamp: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) {
    return 'No events yet';
  }

  return new Date(timestamp).toLocaleTimeString();
}

function getCaptureStaleMs(diagnostics: CaptureDiagnostics): number | null {
  if (!diagnostics.lastUpdatedAt || !Number.isFinite(diagnostics.lastUpdatedAt)) {
    return null;
  }

  return Math.max(0, Date.now() - diagnostics.lastUpdatedAt);
}

function getHealthTargetSessionId(): string | null {
  const diagnosticsSessionId = latestCaptureDiagnostics?.sessionState.sessionId;
  if (typeof diagnosticsSessionId === 'string' && diagnosticsSessionId.trim().length > 0) {
    return diagnosticsSessionId;
  }

  const stateSessionId = latestSessionState?.sessionId;
  if (typeof stateSessionId === 'string' && stateSessionId.trim().length > 0) {
    return stateSessionId;
  }

  return null;
}

function renderHealthActions(diagnostics: CaptureDiagnostics): void {
  const recoverButton = document.getElementById('health-recover-session') as HTMLButtonElement | null;
  const retryButton = document.getElementById('health-retry-content-script') as HTMLButtonElement | null;
  const focusButton = document.getElementById('health-focus-tab') as HTMLButtonElement | null;
  const hasKnownSession = Boolean(getHealthTargetSessionId());
  const sessionState = diagnostics.sessionState;

  if (recoverButton) {
    recoverButton.disabled = false;
    recoverButton.textContent = sessionState.isActive
      ? sessionState.isPaused
        ? 'Resume session'
        : 'Session running'
      : hasKnownSession
        ? 'Resume session'
        : 'Start session';
    if (sessionState.isActive && !sessionState.isPaused) {
      recoverButton.disabled = true;
    }
  }

  if (retryButton) {
    retryButton.disabled = !hasKnownSession;
  }

  if (focusButton) {
    focusButton.disabled = !hasKnownSession;
  }
}

function renderHealthDiagnostics(diagnostics: CaptureDiagnostics): void {
  latestCaptureDiagnostics = diagnostics;
  const summaryEl = document.getElementById('health-summary');
  const sessionState = diagnostics.sessionState;
  const staleMs = getCaptureStaleMs(diagnostics);
  const hasStaleCapture = Boolean(
    sessionState.isActive
      && sessionState.connectionStatus === 'connected'
      && staleMs !== null
      && staleMs > 60_000
  );
  const transportTone = diagnostics.rejectedInactive > 0 && !sessionState.isActive
    ? 'warning'
    : hasStaleCapture
      ? 'warning'
    : sessionState.connectionStatus === 'connected'
      ? 'success'
      : sessionState.connectionStatus === 'connecting' || sessionState.connectionStatus === 'reconnecting'
        ? 'warning'
        : sessionState.isActive
          ? 'error'
          : 'info';
  const transportLabel = sessionState.connectionStatus === 'reconnecting'
    ? `reconnecting (${sessionState.reconnectAttempts})`
    : sessionState.connectionStatus;
  const summaryMessage = diagnostics.rejectedInactive > 0 && !sessionState.isActive
    ? 'Bridge connected, but capture is being rejected because no session is active. Recover or resume the session.'
    : hasStaleCapture
      ? `Bridge ${transportLabel}, but no fresh capture activity has arrived for ${Math.round((staleMs ?? 0) / 1000)}s. Reopen the bound tab or retry the content script if the page looks stalled.`
    : sessionState.isActive
      ? `Bridge ${transportLabel}. ${diagnostics.contentScriptReady ? 'Content script ready.' : 'Content script unavailable.'}`
      : `Bridge ${transportLabel}. No active session is bound.`;

  setStatusMessage(summaryEl, summaryMessage, transportTone);
  renderHealthActions(diagnostics);
  setHealthValue('health-transport', transportLabel);
  setHealthValue(
    'health-session',
    sessionState.sessionId
      ? `${sessionState.sessionId}${sessionState.isPaused ? ' | paused' : ''}`
      : 'No active session'
  );
  setHealthValue(
    'health-content-script',
    diagnostics.contentScriptReady
      ? diagnostics.fallbackInjected
        ? 'Ready via fallback injection'
        : 'Ready'
      : diagnostics.lastInjectError
        ? `Unavailable | ${diagnostics.lastInjectError}`
        : 'Unavailable'
  );
  setHealthValue('health-guardrails', summarizeGuardrails(diagnostics));
  setHealthValue('health-capture', summarizeCaptureCounts(diagnostics));
  setHealthValue('health-last-event', diagnostics.lastEventType || 'No events yet');
  setHealthValue('health-last-sender', diagnostics.lastSenderUrl || 'No sender recorded');
  setHealthValue('health-last-updated', formatHealthTimestamp(diagnostics.lastUpdatedAt));
}

async function refreshSessionTabScope(): Promise<void> {
  const result = await sendRuntimeMessage({ type: 'SESSION_GET_TAB_SCOPE' });
  if (result.ok && 'result' in result) {
    const parsed = parseSessionTabScope(result.result);
    if (parsed) {
      renderSessionTabScope(parsed);
      return;
    }
  }

  const baseOriginEl = document.getElementById('session-base-origin');
  if (!result.ok) {
    setStatusMessage(baseOriginEl, 'Error: ' + result.error, 'error');
  } else {
    setStatusMessage(baseOriginEl, 'Unexpected tab scope response.', 'warning');
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}

function renderRetention(settings: RetentionSettings, lastCleanup?: CleanupResult): void {
  const retentionDays = document.getElementById('retention-days') as HTMLInputElement | null;
  const maxDbMb = document.getElementById('max-db-mb') as HTMLInputElement | null;
  const maxSessions = document.getElementById('max-sessions') as HTMLInputElement | null;
  const exportPath = document.getElementById('export-path') as HTMLInputElement | null;
  const cleanupInfo = document.getElementById('cleanup-info');

  if (retentionDays) retentionDays.value = String(settings.retentionDays);
  if (maxDbMb) maxDbMb.value = String(settings.maxDbMb);
  if (maxSessions) maxSessions.value = String(settings.maxSessions);
  if (exportPath) exportPath.value = settings.exportPathOverride ?? '';

  if (cleanupInfo) {
    if (!lastCleanup) {
      setStatusMessage(cleanupInfo, 'No cleanup run yet.', 'info');
      return;
    }

    const warningText = lastCleanup.warning ? ` Warning: ${lastCleanup.warning}` : '';
    setStatusMessage(
      cleanupInfo,
      `Last cleanup deleted ${lastCleanup.deletedSessions} session(s).${warningText}`,
      lastCleanup.warning ? 'warning' : 'success'
    );
  }
}

function getRetentionFromForm(): Partial<RetentionSettings> {
  const retentionDays = document.getElementById('retention-days') as HTMLInputElement | null;
  const maxDbMb = document.getElementById('max-db-mb') as HTMLInputElement | null;
  const maxSessions = document.getElementById('max-sessions') as HTMLInputElement | null;
  const exportPath = document.getElementById('export-path') as HTMLInputElement | null;

  return {
    retentionDays: Number(retentionDays?.value ?? 30),
    maxDbMb: Number(maxDbMb?.value ?? 1024),
    maxSessions: Number(maxSessions?.value ?? 10000),
    exportPathOverride: exportPath?.value?.trim() ? exportPath.value.trim() : null,
  };
}

function startStatePolling(): void {
  if (statePollTimer !== null) {
    return;
  }

  statePollTimer = window.setInterval(() => {
    void refreshState();
  }, 1000);
}

function stopStatePolling(): void {
  if (statePollTimer === null) {
    return;
  }

  window.clearInterval(statePollTimer);
  statePollTimer = null;
}

async function refreshState(): Promise<void> {
  const result = await sendRuntimeMessage({ type: 'SESSION_GET_STATE' });
  if (result.ok && 'state' in result) {
    renderSessionState(result.state);
    await refreshSessionTabScope();
    await refreshHealthDiagnostics();
    return;
  }

  const statusEl = document.getElementById('status');
  if (statusEl && !result.ok) {
    setStatusMessage(statusEl, 'Error: ' + result.error, 'error');
  }
}

async function refreshHealthDiagnostics(): Promise<void> {
  const result = await sendRuntimeMessage({ type: 'SESSION_CAPTURE_DIAGNOSTICS' });
  const summaryEl = document.getElementById('health-summary');
  if (result.ok && 'result' in result) {
    const diagnostics = parseCaptureDiagnostics(result.result);
    if (diagnostics) {
      renderHealthDiagnostics(diagnostics);
      return;
    }
    setStatusMessage(summaryEl, 'Unexpected health diagnostics response.', 'warning');
    return;
  }

  if (!result.ok) {
    setStatusMessage(summaryEl, 'Error: ' + result.error, 'error');
  }
}

async function refreshConfig(): Promise<void> {
  const result = await sendRuntimeMessage({ type: 'SESSION_GET_CONFIG' });
  if (result.ok && 'config' in result) {
    renderConfig(result.config);
    return;
  }
  if (!result.ok) {
    setConfigStatus(`Error: ${result.error}`, 'error');
    return;
  }
  setConfigStatus('Unknown configuration error', 'error');
}

async function refreshRetention(): Promise<void> {
  const result = await sendRuntimeMessage({ type: 'RETENTION_GET_SETTINGS' });
  if (result.ok && 'retention' in result) {
    renderRetention(result.retention, result.lastCleanup);
    return;
  }
  if (!result.ok) {
    setRetentionStatus(`Error: ${result.error}`, 'error');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const startButton = document.getElementById('start-session');
  const pauseButton = document.getElementById('pause-session');
  const resumeCurrentButton = document.getElementById('resume-session');
  const stopButton = document.getElementById('stop-session');
  const recoverHealthButton = document.getElementById('health-recover-session');
  const retryHealthButton = document.getElementById('health-retry-content-script');
  const focusHealthButton = document.getElementById('health-focus-tab');
  const resumeByIdButton = document.getElementById('resume-selected-session');
  const resumeByIdSelect = document.getElementById('resume-session-id') as HTMLSelectElement | null;
  const saveConfigButton = document.getElementById('save-config');
  const automationEmergencyStopButton = document.getElementById('automation-emergency-stop');
  const saveRetentionButton = document.getElementById('save-retention');
  const runCleanupButton = document.getElementById('run-cleanup-now');
  const pinSessionButton = document.getElementById('pin-session');
  const unpinSessionButton = document.getElementById('unpin-session');
  const exportSessionButton = document.getElementById('export-session');
  const importSessionButton = document.getElementById('import-session');
  const importSessionInput = document.getElementById('import-session-file') as HTMLInputElement | null;
  const showDbEntriesButton = document.getElementById('show-db-entries');
  const refreshSessionTabsButton = document.getElementById('refresh-session-tabs');
  const sessionTabsList = document.getElementById('session-tabs-list');

  startButton?.addEventListener('click', async () => {
    const result = await sendRuntimeMessage({ type: 'SESSION_START' });
    if (result.ok && 'state' in result) {
      renderSessionState(result.state);
      await refreshSessionTabScope();
      await refreshPausedSessionOptions();
      return;
    }
    setConfigStatus(result.ok ? 'Unable to start session' : result.error, 'error');
  });

  pauseButton?.addEventListener('click', async () => {
    const result = await sendRuntimeMessage({ type: 'SESSION_PAUSE' });
    if (result.ok && 'state' in result) {
      renderSessionState(result.state);
      await refreshSessionTabScope();
      await refreshPausedSessionOptions();
      return;
    }
    setConfigStatus(result.ok ? 'Unable to pause session' : result.error, 'error');
  });

  resumeCurrentButton?.addEventListener('click', async () => {
    const result = await sendRuntimeMessage({ type: 'SESSION_RESUME_CURRENT' });
    if (result.ok && 'state' in result) {
      renderSessionState(result.state);
      await refreshSessionTabScope();
      await refreshPausedSessionOptions();
      return;
    }
    setConfigStatus(result.ok ? 'Unable to resume current session' : result.error, 'error');
  });

  resumeByIdButton?.addEventListener('click', async () => {
    const selectedSessionId = resumeByIdSelect?.value?.trim() ?? '';
    if (!selectedSessionId) {
      setConfigStatus('Choose a paused session to resume.', 'warning');
      return;
    }

    const result = await sendRuntimeMessage({ type: 'SESSION_RESUME_BY_ID', sessionId: selectedSessionId });
    if (result.ok && 'state' in result) {
      renderSessionState(result.state);
      await refreshSessionTabScope();
      await refreshPausedSessionOptions();
      return;
    }

    setConfigStatus(result.ok ? 'Unable to resume selected session' : result.error, 'error');
  });

  stopButton?.addEventListener('click', async () => {
    const result = await sendRuntimeMessage({ type: 'SESSION_STOP' });
    if (result.ok && 'state' in result) {
      renderSessionState(result.state);
      await refreshSessionTabScope();
      await refreshPausedSessionOptions();
      return;
    }
    setConfigStatus(result.ok ? 'Unable to stop session' : result.error, 'error');
  });

  recoverHealthButton?.addEventListener('click', async () => {
    setHealthActionStatus('Recovering session...', 'info');
    const result = await sendRuntimeMessage({
      type: 'SESSION_RECOVER_HEALTH',
      sessionId: getHealthTargetSessionId() ?? undefined,
    });
    if (result.ok && 'state' in result) {
      renderSessionState(result.state);
      await refreshSessionTabScope();
      await refreshPausedSessionOptions();
      await refreshHealthDiagnostics();
      setHealthActionStatus(result.state.isActive ? 'Session is active again.' : 'Session recovery ran.', 'success');
      return;
    }

    setHealthActionStatus(result.ok ? 'Unable to recover session' : result.error, 'error');
  });

  retryHealthButton?.addEventListener('click', async () => {
    setHealthActionStatus('Retrying content script...', 'info');
    const result = await sendRuntimeMessage({
      type: 'SESSION_RETRY_CONTENT_SCRIPT',
      sessionId: getHealthTargetSessionId() ?? undefined,
    });
    if (result.ok) {
      await refreshHealthDiagnostics();
      setHealthActionStatus('Content script check completed.', 'success');
      return;
    }

    setHealthActionStatus(result.error, 'error');
  });

  focusHealthButton?.addEventListener('click', async () => {
    setHealthActionStatus('Opening bound tab...', 'info');
    const result = await sendRuntimeMessage({
      type: 'SESSION_FOCUS_CAPTURE_TAB',
      sessionId: getHealthTargetSessionId() ?? undefined,
    });
    if (result.ok) {
      setHealthActionStatus('Bound tab focused.', 'success');
      return;
    }

    setHealthActionStatus(result.error, 'error');
  });

  refreshSessionTabsButton?.addEventListener('click', async () => {
    await refreshSessionTabScope();
  });

  sessionTabsList?.addEventListener('change', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') {
      return;
    }

    const tabId = Number(target.dataset.tabId);
    if (!Number.isInteger(tabId)) {
      setConfigStatus('Invalid tab selection.', 'error');
      return;
    }

    target.disabled = true;
    const message = target.checked
      ? { type: 'SESSION_ADD_TAB_TO_SESSION' as const, tabId }
      : { type: 'SESSION_REMOVE_TAB_FROM_SESSION' as const, tabId };

    const result = await sendRuntimeMessage(message);
    target.disabled = false;

    if (!result.ok) {
      target.checked = !target.checked;
      setConfigStatus(result.error, 'error');
      return;
    }

    if ('state' in result) {
      renderSessionState(result.state);
    }

    await refreshSessionTabScope();
  });

  saveConfigButton?.addEventListener('click', async () => {
    setConfigStatus('Saving...', 'info');
    const result = await sendRuntimeMessage({
      type: 'SESSION_UPDATE_CONFIG',
      config: getConfigFromForm(),
    });

    if (result.ok && 'config' in result) {
      renderConfig(result.config);
      setConfigStatus('Settings saved', 'success');
      return;
    }

    setConfigStatus(result.ok ? 'Unable to save settings' : result.error, 'error');
  });

  automationEmergencyStopButton?.addEventListener('click', async () => {
    setConfigStatus('Stopping live automation...', 'warning');
    const result = await sendRuntimeMessage({ type: 'AUTOMATION_EMERGENCY_STOP' });
    if (result.ok && 'config' in result) {
      renderConfig(result.config);
      setConfigStatus('Live automation stopped.', 'success');
      return;
    }

    setConfigStatus(result.ok ? 'Unable to stop live automation' : result.error, 'error');
  });

  saveRetentionButton?.addEventListener('click', async () => {
    setRetentionStatus('Saving...', 'info');
    const result = await sendRuntimeMessage({
      type: 'RETENTION_UPDATE_SETTINGS',
      settings: getRetentionFromForm(),
    });

    if (result.ok && 'retention' in result) {
      renderRetention(result.retention);
      setRetentionStatus('Retention settings saved.', 'success');
      return;
    }
    setRetentionStatus(result.ok ? 'Unable to save retention settings' : result.error, 'error');
  });

  runCleanupButton?.addEventListener('click', async () => {
    setRetentionStatus('Running cleanup...', 'info');
    const result = await sendRuntimeMessage({ type: 'RETENTION_RUN_CLEANUP' });
    if (result.ok && 'result' in result) {
      setRetentionStatus('Auto cleanup removed old sessions to enforce limits.', 'success');
      void refreshRetention();
      return;
    }
    setRetentionStatus(result.ok ? 'Unable to run cleanup' : result.error, 'error');
  });

  pinSessionButton?.addEventListener('click', async () => {
    const sessionId = getCurrentSessionId();
    if (!sessionId) {
      setRetentionStatus('No active session to pin.', 'warning');
      return;
    }

    const result = await sendRuntimeMessage({ type: 'SESSION_PIN', sessionId, pinned: true });
    setRetentionStatus(result.ok ? 'Session pinned.' : result.error, result.ok ? 'success' : 'error');
  });

  unpinSessionButton?.addEventListener('click', async () => {
    const sessionId = getCurrentSessionId();
    if (!sessionId) {
      setRetentionStatus('No active session to unpin.', 'warning');
      return;
    }

    const result = await sendRuntimeMessage({ type: 'SESSION_PIN', sessionId, pinned: false });
    setRetentionStatus(result.ok ? 'Session unpinned.' : result.error, result.ok ? 'success' : 'error');
  });

  exportSessionButton?.addEventListener('click', async () => {
    const sessionId = getCurrentSessionId();
    if (!sessionId) {
      setRetentionStatus('No active session to export.', 'warning');
      return;
    }

    const result = await sendRuntimeMessage({ type: 'SESSION_EXPORT', sessionId, format: 'zip' });
    if (result.ok && 'result' in result && result.result && typeof result.result === 'object' && 'filePath' in result.result) {
      const payload = result.result as { filePath: string; snapshots?: number; format?: string };
      setRetentionStatus(
        `Exported ${payload.format ?? 'session'}: ${payload.filePath}${typeof payload.snapshots === 'number' ? ` (${payload.snapshots} snapshots)` : ''}`,
        'success'
      );
      return;
    }
    setRetentionStatus(result.ok ? 'Unable to export session' : result.error, 'error');
  });

  importSessionButton?.addEventListener('click', async () => {
    const file = importSessionInput?.files?.[0];
    if (!file) {
      setRetentionStatus('Choose an exported JSON file first.', 'warning');
      return;
    }

    if (file.size > MAX_IMPORT_FILE_BYTES) {
      setRetentionStatus(`Import file too large. Max ${Math.floor(MAX_IMPORT_FILE_BYTES / (1024 * 1024))} MB.`, 'warning');
      return;
    }

    setRetentionStatus('Importing session...', 'info');

    const isZip = file.name.toLowerCase().endsWith('.zip');
    let result: SessionResponse;

    if (isZip) {
      const archiveBuffer = await file.arrayBuffer();
      result = await sendRuntimeMessage({
        type: 'SESSION_IMPORT',
        format: 'zip',
        payload: {},
        archiveBase64: arrayBufferToBase64(archiveBuffer),
      });
    } else {
      let payload: unknown;
      try {
        payload = JSON.parse(await file.text());
      } catch {
        setRetentionStatus('Invalid JSON file.', 'error');
        return;
      }

      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        setRetentionStatus('Invalid import payload.', 'error');
        return;
      }

      result = await sendRuntimeMessage({
        type: 'SESSION_IMPORT',
        payload: payload as Record<string, unknown>,
      });
    }

    if (result.ok && 'result' in result) {
      const parsed = parseSessionImportResult(result.result);
      if (!parsed) {
        setRetentionStatus('Imported, but server response was invalid.', 'warning');
        return;
      }

      const remapNote = parsed.remappedSessionId
        ? ` (saved as ${parsed.sessionId})`
        : '';
      setRetentionStatus(
        `Imported ${parsed.events} events, ${parsed.network} network rows, ${parsed.fingerprints} fingerprints, ${parsed.snapshots} snapshots${remapNote}.`,
        'success'
      );
      if (importSessionInput) {
        importSessionInput.value = '';
      }
      return;
    }

    setRetentionStatus(result.ok ? 'Unable to import session' : result.error, 'error');
  });

  showDbEntriesButton?.addEventListener('click', async () => {
    const sessionId = getCurrentSessionId();
    const baseUrl = chrome.runtime.getURL('db-viewer.html');
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    const url = `${baseUrl}${query}`;

    try {
      await chrome.tabs.create({ url });
    } catch {
      window.open(url, '_blank');
    }
  });

  const resetDbButton = document.getElementById('reset-db');
  const resetConfirmModal = document.getElementById('reset-confirm-modal') as HTMLDialogElement | null;
  const resetConfirmCancel = document.getElementById('reset-confirm-cancel');
  const resetConfirmYes = document.getElementById('reset-confirm-yes');
  const resetDbStatus = document.getElementById('reset-db-status');

  function setResetDbStatus(message: string, tone: StatusTone = 'info'): void {
    setStatusMessage(resetDbStatus, message, tone);
  }

  async function performDbReset(): Promise<void> {
    setResetDbStatus('Resetting database...', 'info');

    const result = await sendRuntimeMessage({ type: 'DB_RESET' });
    if (result.ok && 'result' in result && result.result && typeof result.result === 'object') {
      const response = result.result as { ok?: boolean; message?: string; error?: string };
      if (response.ok === false) {
        setResetDbStatus(response.error ?? 'Unable to reset database', 'error');
        return;
      }

      setResetDbStatus(response.message ?? 'Database reset successfully.', 'success');
      await refreshState();
      await refreshPausedSessionOptions();
      return;
    }

    setResetDbStatus(result.ok ? 'Unable to reset database' : result.error, 'error');
  }

  resetDbButton?.addEventListener('click', () => {
    resetConfirmModal?.showModal();
  });

  resetConfirmCancel?.addEventListener('click', () => {
    resetConfirmModal?.close();
  });

  resetConfirmYes?.addEventListener('click', async () => {
    resetConfirmModal?.close();
    await performDbReset();
  });

  refreshState();
  refreshPausedSessionOptions();
  refreshConfig();
  refreshRetention();
  startStatePolling();

  window.addEventListener('unload', () => {
    stopStatePolling();
  });
});
