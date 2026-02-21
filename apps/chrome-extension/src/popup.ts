type SessionState = {
  isActive: boolean;
  sessionId: string | null;
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

type SessionImportResult = {
  sessionId: string;
  requestedSessionId: string;
  remappedSessionId: boolean;
  events: number;
  network: number;
  fingerprints: number;
  snapshots: number;
};

type StatusTone = 'info' | 'success' | 'warning' | 'error';

let statePollTimer: number | null = null;
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
  const stopButton = document.getElementById('stop-session') as HTMLButtonElement | null;

  if (statusEl) {
    const statusLabel = state.connectionStatus === 'reconnecting'
      ? `reconnecting, attempt ${state.reconnectAttempts}`
      : state.connectionStatus;
    const message = state.isActive
      ? `Session active (${statusLabel})`
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
  if (stopButton) {
    stopButton.disabled = !state.isActive;
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
    maxBytesPerImage: Number(maxBytesPerImage?.value ?? 262144),
    minCaptureIntervalMs: Number(minCaptureIntervalMs?.value ?? 5000),
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

function getCurrentSessionId(): string | null {
  const sessionId = (document.getElementById('session-id')?.textContent ?? '').trim();
  if (!sessionId || sessionId === '-') {
    return null;
  }
  return sessionId;
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
    return;
  }

  const statusEl = document.getElementById('status');
  if (statusEl && !result.ok) {
    setStatusMessage(statusEl, `Error: ${result.error}`, 'error');
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
  const stopButton = document.getElementById('stop-session');
  const saveConfigButton = document.getElementById('save-config');
  const saveRetentionButton = document.getElementById('save-retention');
  const runCleanupButton = document.getElementById('run-cleanup-now');
  const pinSessionButton = document.getElementById('pin-session');
  const unpinSessionButton = document.getElementById('unpin-session');
  const exportSessionButton = document.getElementById('export-session');
  const importSessionButton = document.getElementById('import-session');
  const importSessionInput = document.getElementById('import-session-file') as HTMLInputElement | null;
  const showDbEntriesButton = document.getElementById('show-db-entries');

  startButton?.addEventListener('click', async () => {
    const result = await sendRuntimeMessage({ type: 'SESSION_START' });
    if (result.ok && 'state' in result) {
      renderSessionState(result.state);
      return;
    }
    setConfigStatus(result.ok ? 'Unable to start session' : result.error, 'error');
  });

  stopButton?.addEventListener('click', async () => {
    const result = await sendRuntimeMessage({ type: 'SESSION_STOP' });
    if (result.ok && 'state' in result) {
      renderSessionState(result.state);
      return;
    }
    setConfigStatus(result.ok ? 'Unable to stop session' : result.error, 'error');
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
  refreshConfig();
  refreshRetention();
  startStatePolling();

  window.addEventListener('unload', () => {
    stopStatePolling();
  });
});
