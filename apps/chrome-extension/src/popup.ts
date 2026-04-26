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

type OverridePocStatus = {
  active: boolean;
  configuredEnabled: boolean;
  runId?: string;
  activeProfileId?: string;
  profileId?: string;
  profileName?: string;
  ruleCount?: number;
  enabledRuleCount?: number;
  selectedTabId?: number;
  tabId?: number;
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
  lastErrorCode?: string;
  lastError?: string;
  auditPendingRequests?: number;
  auditLastError?: string;
  diagnosis?: OverridePocUiDiagnosis;
};

type OverridePocUiDiagnosis = {
  issueCount: number;
  issues: Array<{
    code: string;
    severity: 'info' | 'warning' | 'error';
    message: string;
  }>;
  observedAssets?: {
    observedAssetCount: number;
    targetAssetObserved: boolean;
    targetAssetIntegrity: string | null;
    serviceWorkerControlled: boolean;
    cspMetaTagCount: number;
    sriAssetCount: number;
  };
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

type StatusTone = 'info' | 'success' | 'warning' | 'error';

let statePollTimer: number | null = null;
let latestSessionTabScope: SessionTabScope | null = null;
let latestOverridePocStatus: OverridePocStatus | null = null;
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
}

function renderConfig(config: CaptureConfig): void {
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
  };
}

function setConfigStatus(message: string, tone: StatusTone = 'info'): void {
  const status = document.getElementById('config-status');
  setStatusMessage(status, message, tone);
}

function setRetentionStatus(message: string, tone: StatusTone = 'info'): void {
  const status = document.getElementById('retention-status');
  setStatusMessage(status, message, tone);
}

function setOverridePocStatusMessage(message: string, tone: StatusTone = 'info'): void {
  const status = document.getElementById('override-poc-status');
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

function parseOverridePocUiDiagnosis(value: unknown): OverridePocUiDiagnosis | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const candidate = value as Partial<OverridePocUiDiagnosis>;
  const issues = Array.isArray(candidate.issues)
    ? candidate.issues
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return null;
        }
        const issue = entry as Partial<OverridePocUiDiagnosis['issues'][number]>;
        if (typeof issue.code !== 'string' || typeof issue.message !== 'string') {
          return null;
        }
        const severity = issue.severity === 'error' || issue.severity === 'warning' || issue.severity === 'info'
          ? issue.severity
          : 'info';
        return { code: issue.code, severity, message: issue.message };
      })
      .filter((entry): entry is OverridePocUiDiagnosis['issues'][number] => entry !== null)
    : [];

  const observed = candidate.observedAssets && typeof candidate.observedAssets === 'object'
    ? candidate.observedAssets
    : undefined;
  const observedAssets = observed
    ? {
        observedAssetCount: Number(observed.observedAssetCount ?? 0),
        targetAssetObserved: observed.targetAssetObserved === true,
        targetAssetIntegrity: typeof observed.targetAssetIntegrity === 'string' ? observed.targetAssetIntegrity : null,
        serviceWorkerControlled: observed.serviceWorkerControlled === true,
        cspMetaTagCount: Number(observed.cspMetaTagCount ?? 0),
        sriAssetCount: Number(observed.sriAssetCount ?? 0),
      }
    : undefined;

  return {
    issueCount: Number(candidate.issueCount ?? issues.length),
    issues,
    observedAssets,
  };
}

function parseOverridePocStatus(result: unknown): OverridePocStatus | null {
  if (!result || typeof result !== 'object') {
    return null;
  }

  const candidate = result as Partial<OverridePocStatus>;
  if (candidate.active !== true && candidate.active !== false) {
    return null;
  }
  if (candidate.configuredEnabled !== true && candidate.configuredEnabled !== false) {
    return null;
  }
  if (typeof candidate.matchedRequests !== 'number' || !Number.isFinite(candidate.matchedRequests)) {
    return null;
  }
  if (typeof candidate.fulfilledRequests !== 'number' || !Number.isFinite(candidate.fulfilledRequests)) {
    return null;
  }

  const mapOptionalNumber = (value: unknown): number | undefined => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return undefined;
    }
    return Math.floor(value);
  };

  const mapOptionalString = (value: unknown): string | undefined => {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  };

  return {
    active: candidate.active,
    configuredEnabled: candidate.configuredEnabled,
    runId: mapOptionalString(candidate.runId),
    activeProfileId: mapOptionalString(candidate.activeProfileId),
    profileId: mapOptionalString(candidate.profileId),
    profileName: mapOptionalString(candidate.profileName),
    ruleCount: mapOptionalNumber(candidate.ruleCount),
    enabledRuleCount: mapOptionalNumber(candidate.enabledRuleCount),
    selectedTabId: mapOptionalNumber(candidate.selectedTabId),
    tabId: mapOptionalNumber(candidate.tabId),
    targetAssetUrl: mapOptionalString(candidate.targetAssetUrl),
    localFilePath: mapOptionalString(candidate.localFilePath),
    resolvedLocalFilePath: mapOptionalString(candidate.resolvedLocalFilePath),
    contentType: mapOptionalString(candidate.contentType),
    autoReload: typeof candidate.autoReload === 'boolean' ? candidate.autoReload : undefined,
    configPath: mapOptionalString(candidate.configPath),
    fileExists: typeof candidate.fileExists === 'boolean' ? candidate.fileExists : undefined,
    fileSizeBytes: candidate.fileSizeBytes === null
      ? null
      : mapOptionalNumber(candidate.fileSizeBytes),
    matchedRequests: Math.floor(candidate.matchedRequests),
    fulfilledRequests: Math.floor(candidate.fulfilledRequests),
    lastMatchedAt: mapOptionalNumber(candidate.lastMatchedAt),
    lastFulfilledAt: mapOptionalNumber(candidate.lastFulfilledAt),
    lastErrorCode: mapOptionalString(candidate.lastErrorCode),
    lastError: mapOptionalString(candidate.lastError),
    auditPendingRequests: mapOptionalNumber(candidate.auditPendingRequests),
    auditLastError: mapOptionalString(candidate.auditLastError),
    diagnosis: parseOverridePocUiDiagnosis(candidate.diagnosis),
  };
}

function formatOverridePocTabLabel(tab: SessionScopeTab): string {
  const activeSuffix = tab.active ? ' (active)' : '';
  const originText = tab.origin ?? 'unknown origin';
  return '[' + tab.tabId + '] ' + tab.title + ' | ' + originText + activeSuffix;
}

function renderOverridePocTargetTabSelector(): void {
  const select = document.getElementById('override-poc-target-tab') as HTMLSelectElement | null;
  if (!select) {
    return;
  }

  select.replaceChildren();

  const scope = latestSessionTabScope;
  if (!scope || !scope.isActive || !scope.sessionId) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Start a session to choose a target tab';
    select.append(option);
    select.disabled = true;
    return;
  }

  const boundTabs = scope.tabs.filter((tab) => tab.bound);
  if (boundTabs.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Bind a session tab first';
    select.append(option);
    select.disabled = true;
    return;
  }

  for (const tab of boundTabs) {
    const option = document.createElement('option');
    option.value = String(tab.tabId);
    option.textContent = formatOverridePocTabLabel(tab);
    select.append(option);
  }

  const preferredTabId = latestOverridePocStatus?.selectedTabId
    ?? latestOverridePocStatus?.tabId
    ?? boundTabs.find((tab) => tab.active)?.tabId
    ?? boundTabs[0]?.tabId;

  const resolvedTabId = boundTabs.some((tab) => tab.tabId === preferredTabId)
    ? preferredTabId
    : boundTabs[0]?.tabId;

  select.value = typeof resolvedTabId === 'number' ? String(resolvedTabId) : '';
  select.disabled = latestOverridePocStatus?.active === true;
  select.title = latestOverridePocStatus?.active === true
    ? 'Disable the active override before changing target tabs.'
    : '';
}

function renderSessionTabScope(scope: SessionTabScope): void {
  latestSessionTabScope = scope;
  const baseOriginEl = document.getElementById('session-base-origin');
  const tabsListEl = document.getElementById('session-tabs-list');
  if (!baseOriginEl || !tabsListEl) {
    renderOverridePocTargetTabSelector();
    return;
  }

  tabsListEl.replaceChildren();

  if (!scope.isActive || !scope.sessionId) {
    setStatusMessage(baseOriginEl, 'No active session. Start one to bind tabs.', 'info');
    const placeholder = document.createElement('div');
    placeholder.className = 'session-tabs-empty';
    placeholder.textContent = 'Session tab binding is available after session start.';
    tabsListEl.appendChild(placeholder);
    renderOverridePocTargetTabSelector();
    return;
  }

  const originLabel = scope.baseOrigin ?? 'unknown origin';
  setStatusMessage(baseOriginEl, 'Base origin: ' + originLabel + ' | Bound tabs: ' + scope.allowedTabIds.length, 'info');

  if (scope.tabs.length === 0) {
    const placeholder = document.createElement('div');
    placeholder.className = 'session-tabs-empty';
    placeholder.textContent = 'No tabs detected in this window.';
    tabsListEl.appendChild(placeholder);
    renderOverridePocTargetTabSelector();
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

  renderOverridePocTargetTabSelector();
}

function renderOverridePocDiagnostics(status: OverridePocStatus): void {
  const diagnosticsEl = document.getElementById('override-poc-diagnostics');
  if (!diagnosticsEl) {
    return;
  }

  diagnosticsEl.replaceChildren();
  const diagnosis = status.diagnosis;
  if (!diagnosis) {
    const empty = document.createElement('div');
    empty.className = 'override-poc-diagnostics-empty';
    empty.textContent = status.runId ? 'Diagnosis pending.' : 'Enable an override to collect diagnostics.';
    diagnosticsEl.appendChild(empty);
    return;
  }

  const observed = diagnosis.observedAssets;
  if (observed) {
    const summary = document.createElement('div');
    summary.className = 'override-poc-diagnostics-summary';
    const targetStatus = observed.targetAssetObserved ? 'target observed' : 'target not observed';
    const flags = [
      observed.targetAssetIntegrity ? 'SRI target' : null,
      observed.cspMetaTagCount > 0 ? `CSP meta ${observed.cspMetaTagCount}` : null,
      observed.serviceWorkerControlled ? 'SW controlled' : null,
      observed.sriAssetCount > 0 ? `SRI assets ${observed.sriAssetCount}` : null,
    ].filter((entry): entry is string => entry !== null);
    summary.textContent = `Observed assets: ${observed.observedAssetCount}; ${targetStatus}${flags.length > 0 ? '; ' + flags.join('; ') : ''}.`;
    diagnosticsEl.appendChild(summary);
  }

  if (diagnosis.issues.length === 0) {
    const ok = document.createElement('div');
    ok.className = 'override-poc-diagnostics-empty';
    ok.textContent = 'No override blockers reported.';
    diagnosticsEl.appendChild(ok);
    return;
  }

  const list = document.createElement('div');
  list.className = 'override-poc-diagnostics-list';
  for (const issue of diagnosis.issues) {
    const item = document.createElement('div');
    item.className = 'override-poc-diagnostics-item';
    item.dataset.severity = issue.severity;
    item.textContent = `${issue.code}: ${issue.message}`;
    list.appendChild(item);
  }
  diagnosticsEl.appendChild(list);
}

function renderOverridePocStatus(status: OverridePocStatus): void {
  latestOverridePocStatus = status;
  const targetUrlEl = document.getElementById('override-poc-target-url');
  const localFileEl = document.getElementById('override-poc-local-file');
  const configPathEl = document.getElementById('override-poc-config-path');
  const profileEl = document.getElementById('override-poc-profile');
  const rulesEl = document.getElementById('override-poc-rules');
  const selectedTabIdEl = document.getElementById('override-poc-selected-tab-id');
  const tabIdEl = document.getElementById('override-poc-tab-id');
  const matchedEl = document.getElementById('override-poc-matched');
  const fulfilledEl = document.getElementById('override-poc-fulfilled');
  const auditEl = document.getElementById('override-poc-audit');
  const enableButton = document.getElementById('override-poc-enable') as HTMLButtonElement | null;
  const disableButton = document.getElementById('override-poc-disable') as HTMLButtonElement | null;

  if (targetUrlEl) {
    targetUrlEl.textContent = status.targetAssetUrl ?? '-';
  }
  if (localFileEl) {
    localFileEl.textContent = status.resolvedLocalFilePath ?? status.localFilePath ?? '-';
  }
  if (configPathEl) {
    configPathEl.textContent = status.configPath ?? '-';
  }
  if (profileEl) {
    profileEl.textContent = status.profileName ?? status.profileId ?? status.activeProfileId ?? '-';
  }
  if (rulesEl) {
    const enabledRuleCount = typeof status.enabledRuleCount === 'number' ? status.enabledRuleCount : '-';
    const ruleCount = typeof status.ruleCount === 'number' ? status.ruleCount : '-';
    rulesEl.textContent = `${enabledRuleCount}/${ruleCount} enabled`;
  }
  if (selectedTabIdEl) {
    selectedTabIdEl.textContent = typeof status.selectedTabId === 'number' ? String(status.selectedTabId) : '-';
  }
  if (tabIdEl) {
    tabIdEl.textContent = typeof status.tabId === 'number' ? String(status.tabId) : '-';
  }
  if (matchedEl) {
    matchedEl.textContent = String(status.matchedRequests);
  }
  if (fulfilledEl) {
    fulfilledEl.textContent = String(status.fulfilledRequests);
  }
  if (auditEl) {
    const pending = status.auditPendingRequests ?? 0;
    auditEl.textContent = status.auditLastError
      ? `pending ${pending}; retrying after: ${status.auditLastError}`
      : pending > 0
        ? `pending ${pending}`
        : 'synced';
  }

  let message = 'Override POC ready but inactive.';
  let tone: StatusTone = 'info';

  if (status.lastError) {
    message = status.lastError;
    tone = 'error';
  } else if (status.diagnosis?.issues.some((issue) => issue.severity === 'error')) {
    const issue = status.diagnosis.issues.find((entry) => entry.severity === 'error');
    message = issue ? `${issue.code}: ${issue.message}` : 'Override blocker reported.';
    tone = 'error';
  } else if (!status.configuredEnabled) {
    message = 'Disabled in override-poc.config.json.';
    tone = 'warning';
  } else if (status.fileExists === false) {
    message = 'Configured local file was not found on disk.';
    tone = 'warning';
  } else if (status.active) {
    message = `Attached to tab ${status.tabId ?? '-'}; matched ${status.matchedRequests}, fulfilled ${status.fulfilledRequests}.`;
    tone = 'success';
  }

  setOverridePocStatusMessage(message, tone);
  renderOverridePocDiagnostics(status);

  if (enableButton) {
    enableButton.disabled = status.active || !status.configuredEnabled || status.fileExists === false;
  }
  if (disableButton) {
    disableButton.disabled = !status.active;
  }

  renderOverridePocTargetTabSelector();
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

async function refreshOverridePocStatus(): Promise<void> {
  const result = await sendRuntimeMessage({ type: 'OVERRIDE_POC_GET_STATUS' });
  if (result.ok && 'result' in result) {
    const parsed = parseOverridePocStatus(result.result);
    if (parsed) {
      renderOverridePocStatus(parsed);
      return;
    }
  }

  if (!result.ok) {
    setOverridePocStatusMessage(`Error: ${result.error}`, 'error');
  } else {
    setOverridePocStatusMessage('Unexpected override POC response.', 'warning');
  }
}

function getSelectedOverridePocTargetTabId(): number | null {
  const select = document.getElementById('override-poc-target-tab') as HTMLSelectElement | null;
  if (!select) {
    return null;
  }

  const selectedValue = Number(select.value);
  if (!Number.isInteger(selectedValue)) {
    return null;
  }

  return selectedValue;
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
    await refreshOverridePocStatus();
    return;
  }

  const statusEl = document.getElementById('status');
  if (statusEl && !result.ok) {
    setStatusMessage(statusEl, 'Error: ' + result.error, 'error');
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

export function initializePopup(): void {
  const startButton = document.getElementById('start-session');
  const pauseButton = document.getElementById('pause-session');
  const resumeCurrentButton = document.getElementById('resume-session');
  const stopButton = document.getElementById('stop-session');
  const resumeByIdButton = document.getElementById('resume-selected-session');
  const resumeByIdSelect = document.getElementById('resume-session-id') as HTMLSelectElement | null;
  const saveConfigButton = document.getElementById('save-config');
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
  const overridePocEnableButton = document.getElementById('override-poc-enable');
  const overridePocDisableButton = document.getElementById('override-poc-disable');
  const overridePocRefreshButton = document.getElementById('override-poc-refresh');
  const overridePocTargetTabSelect = document.getElementById('override-poc-target-tab') as HTMLSelectElement | null;

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

  refreshSessionTabsButton?.addEventListener('click', async () => {
    await refreshSessionTabScope();
  });

  overridePocTargetTabSelect?.addEventListener('change', async () => {
    const tabId = getSelectedOverridePocTargetTabId();
    if (tabId === null) {
      return;
    }

    const result = await sendRuntimeMessage({ type: 'OVERRIDE_POC_SET_TARGET_TAB', tabId });
    if (!result.ok) {
      setOverridePocStatusMessage(result.error, 'error');
      await refreshOverridePocStatus();
      return;
    }

    await refreshOverridePocStatus();
  });

  overridePocEnableButton?.addEventListener('click', async () => {
    const tabId = getSelectedOverridePocTargetTabId();
    if (tabId === null) {
      setOverridePocStatusMessage('Select a bound target tab before enabling the override.', 'warning');
      return;
    }

    setOverridePocStatusMessage('Enabling override POC...', 'info');
    const result = await sendRuntimeMessage({ type: 'OVERRIDE_POC_ENABLE', tabId });
    if (!result.ok) {
      setOverridePocStatusMessage(result.error, 'error');
      return;
    }

    await refreshOverridePocStatus();
  });

  overridePocDisableButton?.addEventListener('click', async () => {
    setOverridePocStatusMessage('Disabling override POC...', 'info');
    const result = await sendRuntimeMessage({ type: 'OVERRIDE_POC_DISABLE' });
    if (!result.ok) {
      setOverridePocStatusMessage(result.error, 'error');
      return;
    }

    await refreshOverridePocStatus();
  });

  overridePocRefreshButton?.addEventListener('click', async () => {
    await refreshOverridePocStatus();
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
  refreshOverridePocStatus();
  startStatePolling();

  window.addEventListener('unload', () => {
    stopStatePolling();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initializePopup();
});
