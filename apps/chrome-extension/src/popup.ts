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

type DbEntryRow = {
  id: string;
  source: 'event' | 'network';
  timestamp: number;
  kind: string;
  summary: string;
  raw: unknown;
};

type DbEntriesResult = {
  ok: true;
  sessionId: string;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
  totalApprox: number;
  rows: DbEntryRow[];
};

type DbFilter = 'all' | 'event' | 'network';

type SessionImportResult = {
  sessionId: string;
  requestedSessionId: string;
  remappedSessionId: boolean;
  events: number;
  network: number;
  fingerprints: number;
  snapshots: number;
};

let statePollTimer: number | null = null;
let dbEntriesOffset = 0;
let dbEntriesHasMore = false;
let dbEntriesRows: DbEntryRow[] = [];
let dbEntriesFilter: DbFilter = 'all';
const expandedDbRows = new Set<string>();
const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;

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
    statusEl.textContent = state.isActive
      ? `Session active (${statusLabel})`
      : `No active session (${statusLabel})`;
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

function setConfigStatus(message: string): void {
  const status = document.getElementById('config-status');
  if (status) {
    status.textContent = message;
  }
}

function setRetentionStatus(message: string): void {
  const status = document.getElementById('retention-status');
  if (status) {
    status.textContent = message;
  }
}

function setDbEntriesStatus(message: string): void {
  const status = document.getElementById('db-entries-status');
  if (status) {
    status.textContent = message;
  }
}

function getDbEntriesSessionId(): string | null {
  const sessionId = (document.getElementById('session-id')?.textContent ?? '').trim();
  if (!sessionId || sessionId === '-') {
    return null;
  }
  return sessionId;
}

function formatEntryTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) {
    return '-';
  }
  return new Date(timestamp).toLocaleTimeString();
}

function getDbPageSize(): number {
  const height = window.innerHeight;
  const estimated = Math.floor((height - 230) / 30);
  return Math.min(Math.max(estimated, 12), 80);
}

function parseDbEntriesResult(result: unknown): DbEntriesResult | null {
  if (!result || typeof result !== 'object') {
    return null;
  }

  const candidate = result as Partial<DbEntriesResult>;
  if (!Array.isArray(candidate.rows) || typeof candidate.hasMore !== 'boolean') {
    return null;
  }

  return {
    ok: true,
    sessionId: String(candidate.sessionId ?? ''),
    limit: Number(candidate.limit ?? 0),
    offset: Number(candidate.offset ?? 0),
    hasMore: candidate.hasMore,
    nextOffset: typeof candidate.nextOffset === 'number' ? candidate.nextOffset : null,
    totalApprox: Number(candidate.totalApprox ?? candidate.rows.length),
    rows: candidate.rows as DbEntryRow[],
  };
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

function getVisibleDbRows(rows: DbEntryRow[]): DbEntryRow[] {
  if (dbEntriesFilter === 'all') {
    return rows;
  }
  return rows.filter((row) => row.source === dbEntriesFilter);
}

function updateDbFilterButtons(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>('button[data-db-filter]');
  for (const button of buttons) {
    const value = button.dataset.dbFilter;
    if (value === dbEntriesFilter) {
      button.classList.add('is-active');
    } else {
      button.classList.remove('is-active');
    }
  }
}

function updateDbEntriesStatusText(totalApprox?: number): void {
  const visibleRows = getVisibleDbRows(dbEntriesRows).length;
  const suffix = dbEntriesFilter === 'all' ? 'all rows' : `${dbEntriesFilter} rows`;
  if (dbEntriesRows.length === 0) {
    setDbEntriesStatus('No DB entries for this session yet.');
    return;
  }

  if (dbEntriesHasMore && typeof totalApprox === 'number' && Number.isFinite(totalApprox)) {
    setDbEntriesStatus(`Showing ${visibleRows} loaded ${suffix} (${dbEntriesRows.length} loaded of about ${totalApprox} total).`);
    return;
  }

  setDbEntriesStatus(`Showing ${visibleRows} ${suffix} (${dbEntriesRows.length} loaded).`);
}

function renderDbRows(rows: DbEntryRow[], append = false): void {
  const tbody = document.getElementById('db-entries-body') as HTMLTableSectionElement | null;
  if (!tbody) {
    return;
  }

  if (!append) {
    tbody.replaceChildren();
  }

  const visibleRows = getVisibleDbRows(rows);

  for (const row of visibleRows) {
    const dataRow = document.createElement('tr');
    dataRow.dataset.rowId = row.id;

    const timeCell = document.createElement('td');
    timeCell.textContent = formatEntryTime(row.timestamp);

    const sourceCell = document.createElement('td');
    sourceCell.textContent = row.source;

    const kindCell = document.createElement('td');
    kindCell.textContent = row.kind;

    const summaryCell = document.createElement('td');
    summaryCell.className = 'db-summary';
    summaryCell.title = row.summary;
    summaryCell.textContent = row.summary;

    const detailsCell = document.createElement('td');
    const toggleButton = document.createElement('button');
    toggleButton.type = 'button';
    toggleButton.dataset.toggleRowId = row.id;
    toggleButton.textContent = expandedDbRows.has(row.id) ? 'Hide' : 'Show';
    detailsCell.append(toggleButton);

    dataRow.append(timeCell, sourceCell, kindCell, summaryCell, detailsCell);
    tbody.append(dataRow);

    if (expandedDbRows.has(row.id)) {
      const expandedRow = document.createElement('tr');
      expandedRow.className = 'db-expanded';
      expandedRow.dataset.expandedRowId = row.id;
      const expandedCell = document.createElement('td');
      expandedCell.colSpan = 5;
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify(row.raw, null, 2);
      expandedCell.append(pre);
      expandedRow.append(expandedCell);
      tbody.append(expandedRow);
    }
  }
}

async function loadDbEntries(options: { append: boolean }): Promise<void> {
  const sessionId = getDbEntriesSessionId();
  if (!sessionId) {
    setDbEntriesStatus('No active session available.');
    return;
  }

  const sessionIdLabel = document.getElementById('db-entries-session-id');
  if (sessionIdLabel) {
    sessionIdLabel.textContent = sessionId;
  }

  const offset = options.append ? dbEntriesOffset : 0;
  const limit = getDbPageSize();
  setDbEntriesStatus('Loading DB entries...');

  const response = await sendRuntimeMessage({
    type: 'SESSION_GET_DB_ENTRIES',
    sessionId,
    limit,
    offset,
  });

  if (!response.ok) {
    setDbEntriesStatus(`Error: ${response.error}`);
    return;
  }

  if (!('result' in response)) {
    setDbEntriesStatus('Unexpected response while loading entries.');
    return;
  }

  const parsed = parseDbEntriesResult(response.result);
  if (!parsed) {
    setDbEntriesStatus('Invalid entries payload received.');
    return;
  }

  dbEntriesRows = options.append ? [...dbEntriesRows, ...parsed.rows] : parsed.rows;
  renderDbRows(dbEntriesRows, false);
  dbEntriesHasMore = parsed.hasMore;
  dbEntriesOffset = parsed.nextOffset ?? parsed.offset + parsed.rows.length;

  const loadMoreButton = document.getElementById('load-more-db-entries') as HTMLButtonElement | null;
  if (loadMoreButton) {
    loadMoreButton.disabled = !dbEntriesHasMore;
  }

  updateDbEntriesStatusText(parsed.totalApprox);
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
    cleanupInfo.textContent = lastCleanup
      ? `Last cleanup deleted ${lastCleanup.deletedSessions} session(s).`
      : 'No cleanup run yet.';
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
    statusEl.textContent = `Error: ${result.error}`;
  }
}

async function refreshConfig(): Promise<void> {
  const result = await sendRuntimeMessage({ type: 'SESSION_GET_CONFIG' });
  if (result.ok && 'config' in result) {
    renderConfig(result.config);
    return;
  }
  if (!result.ok) {
    setConfigStatus(`Error: ${result.error}`);
    return;
  }
  setConfigStatus('Unknown configuration error');
}

async function refreshRetention(): Promise<void> {
  const result = await sendRuntimeMessage({ type: 'RETENTION_GET_SETTINGS' });
  if (result.ok && 'retention' in result) {
    renderRetention(result.retention, result.lastCleanup);
    return;
  }
  if (!result.ok) {
    setRetentionStatus(`Error: ${result.error}`);
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
  const closeDbEntriesButton = document.getElementById('close-db-entries');
  const loadMoreDbEntriesButton = document.getElementById('load-more-db-entries');
  const dbEntriesModal = document.getElementById('db-entries-modal') as HTMLDialogElement | null;
  const dbEntriesBody = document.getElementById('db-entries-body');
  const dbFilterBar = dbEntriesModal?.querySelector('.db-filter-bar');

  startButton?.addEventListener('click', async () => {
    const result = await sendRuntimeMessage({ type: 'SESSION_START' });
    if (result.ok && 'state' in result) {
      renderSessionState(result.state);
      return;
    }
    setConfigStatus(result.ok ? 'Unable to start session' : result.error);
  });

  stopButton?.addEventListener('click', async () => {
    const result = await sendRuntimeMessage({ type: 'SESSION_STOP' });
    if (result.ok && 'state' in result) {
      renderSessionState(result.state);
      return;
    }
    setConfigStatus(result.ok ? 'Unable to stop session' : result.error);
  });

  saveConfigButton?.addEventListener('click', async () => {
    setConfigStatus('Saving...');
    const result = await sendRuntimeMessage({
      type: 'SESSION_UPDATE_CONFIG',
      config: getConfigFromForm(),
    });

    if (result.ok && 'config' in result) {
      renderConfig(result.config);
      setConfigStatus('Settings saved');
      return;
    }

    setConfigStatus(result.ok ? 'Unable to save settings' : result.error);
  });

  saveRetentionButton?.addEventListener('click', async () => {
    setRetentionStatus('Saving...');
    const result = await sendRuntimeMessage({
      type: 'RETENTION_UPDATE_SETTINGS',
      settings: getRetentionFromForm(),
    });

    if (result.ok && 'retention' in result) {
      renderRetention(result.retention);
      setRetentionStatus('Retention settings saved.');
      return;
    }
    setRetentionStatus(result.ok ? 'Unable to save retention settings' : result.error);
  });

  runCleanupButton?.addEventListener('click', async () => {
    setRetentionStatus('Running cleanup...');
    const result = await sendRuntimeMessage({ type: 'RETENTION_RUN_CLEANUP' });
    if (result.ok && 'result' in result) {
      setRetentionStatus('Auto cleanup removed old sessions to enforce limits.');
      void refreshRetention();
      return;
    }
    setRetentionStatus(result.ok ? 'Unable to run cleanup' : result.error);
  });

  pinSessionButton?.addEventListener('click', async () => {
    const sessionId = (document.getElementById('session-id')?.textContent ?? '').trim();
    if (!sessionId || sessionId === '-') {
      setRetentionStatus('No active session to pin.');
      return;
    }

    const result = await sendRuntimeMessage({ type: 'SESSION_PIN', sessionId, pinned: true });
    setRetentionStatus(result.ok ? 'Session pinned.' : result.error);
  });

  unpinSessionButton?.addEventListener('click', async () => {
    const sessionId = (document.getElementById('session-id')?.textContent ?? '').trim();
    if (!sessionId || sessionId === '-') {
      setRetentionStatus('No active session to unpin.');
      return;
    }

    const result = await sendRuntimeMessage({ type: 'SESSION_PIN', sessionId, pinned: false });
    setRetentionStatus(result.ok ? 'Session unpinned.' : result.error);
  });

  exportSessionButton?.addEventListener('click', async () => {
    const sessionId = (document.getElementById('session-id')?.textContent ?? '').trim();
    if (!sessionId || sessionId === '-') {
      setRetentionStatus('No active session to export.');
      return;
    }

    const result = await sendRuntimeMessage({ type: 'SESSION_EXPORT', sessionId, format: 'zip' });
    if (result.ok && 'result' in result && result.result && typeof result.result === 'object' && 'filePath' in result.result) {
      const payload = result.result as { filePath: string; snapshots?: number; format?: string };
      setRetentionStatus(
        `Exported ${payload.format ?? 'session'}: ${payload.filePath}${typeof payload.snapshots === 'number' ? ` (${payload.snapshots} snapshots)` : ''}`
      );
      return;
    }
    setRetentionStatus(result.ok ? 'Unable to export session' : result.error);
  });

  importSessionButton?.addEventListener('click', async () => {
    const file = importSessionInput?.files?.[0];
    if (!file) {
      setRetentionStatus('Choose an exported JSON file first.');
      return;
    }

    if (file.size > MAX_IMPORT_FILE_BYTES) {
      setRetentionStatus(`Import file too large. Max ${Math.floor(MAX_IMPORT_FILE_BYTES / (1024 * 1024))} MB.`);
      return;
    }

    setRetentionStatus('Importing session...');

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
        setRetentionStatus('Invalid JSON file.');
        return;
      }

      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        setRetentionStatus('Invalid import payload.');
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
        setRetentionStatus('Imported, but server response was invalid.');
        return;
      }

      const remapNote = parsed.remappedSessionId
        ? ` (saved as ${parsed.sessionId})`
        : '';
      setRetentionStatus(
        `Imported ${parsed.events} events, ${parsed.network} network rows, ${parsed.fingerprints} fingerprints, ${parsed.snapshots} snapshots${remapNote}.`
      );
      if (importSessionInput) {
        importSessionInput.value = '';
      }
      return;
    }

    setRetentionStatus(result.ok ? 'Unable to import session' : result.error);
  });

  showDbEntriesButton?.addEventListener('click', async () => {
    const sessionId = getDbEntriesSessionId();
    const baseUrl = chrome.runtime.getURL('db-viewer.html');
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    const url = `${baseUrl}${query}`;

    try {
      await chrome.tabs.create({ url });
    } catch {
      window.open(url, '_blank');
    }
  });

  closeDbEntriesButton?.addEventListener('click', () => {
    dbEntriesModal?.close();
  });

  loadMoreDbEntriesButton?.addEventListener('click', async () => {
    if (!dbEntriesHasMore) {
      return;
    }
    await loadDbEntries({ append: true });
  });

  dbEntriesBody?.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const button = target.closest('button[data-toggle-row-id]') as HTMLButtonElement | null;
    if (!button) {
      return;
    }

    const rowId = button.dataset.toggleRowId;
    if (!rowId) {
      return;
    }

    if (expandedDbRows.has(rowId)) {
      expandedDbRows.delete(rowId);
    } else {
      expandedDbRows.add(rowId);
    }

    renderDbRows(dbEntriesRows, false);
    updateDbEntriesStatusText();
  });

  dbFilterBar?.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const button = target.closest('button[data-db-filter]') as HTMLButtonElement | null;
    if (!button) {
      return;
    }

    const filter = button.dataset.dbFilter;
    if (filter !== 'all' && filter !== 'event' && filter !== 'network') {
      return;
    }

    dbEntriesFilter = filter;
    updateDbFilterButtons();
    renderDbRows(dbEntriesRows, false);
    updateDbEntriesStatusText();
  });

  const resetDbButton = document.getElementById('reset-db');
  const resetConfirmModal = document.getElementById('reset-confirm-modal') as HTMLDialogElement | null;
  const resetConfirmCancel = document.getElementById('reset-confirm-cancel');
  const resetConfirmYes = document.getElementById('reset-confirm-yes');
  const resetDbStatus = document.getElementById('reset-db-status');

  function setResetDbStatus(message: string): void {
    if (resetDbStatus) {
      resetDbStatus.textContent = message;
    }
  }

  resetDbButton?.addEventListener('click', () => {
    const confirmed = window.confirm('Reset database? This will permanently delete ALL sessions, events, and network data.');
    if (!confirmed) {
      return;
    }

    void (async () => {
      setResetDbStatus('Resetting database...');
      const result = await sendRuntimeMessage({ type: 'DB_RESET' });

      if (result.ok && 'result' in result && result.result && typeof result.result === 'object') {
        const response = result.result as { ok?: boolean; message?: string; error?: string };
        if (response.ok === false) {
          setResetDbStatus(response.error ?? 'Unable to reset database');
          return;
        }

        setResetDbStatus(response.message ?? 'Database reset successfully.');
        await refreshState();
        return;
      }

      setResetDbStatus(result.ok ? 'Unable to reset database' : result.error);
    })();
  });

  resetConfirmCancel?.addEventListener('click', () => {
    resetConfirmModal?.close();
  });

  resetConfirmYes?.addEventListener('click', async () => {
    resetConfirmModal?.close();
    setResetDbStatus('Resetting database...');

    const result = await sendRuntimeMessage({ type: 'DB_RESET' });

    if (result.ok && 'result' in result && result.result && typeof result.result === 'object') {
      const response = result.result as { ok?: boolean; message?: string; error?: string };
      if (response.ok === false) {
        setResetDbStatus(response.error ?? 'Unable to reset database');
        return;
      }

      setResetDbStatus(response.message ?? 'Database reset successfully.');
      await refreshState();
      return;
    }

    setResetDbStatus(result.ok ? 'Unable to reset database' : result.error);
  });

  refreshState();
  refreshConfig();
  refreshRetention();
  startStatePolling();

  window.addEventListener('unload', () => {
    stopStatePolling();
  });
});
