export {};

type RuntimeResponse =
  | { ok: true; result: unknown }
  | { ok: true; config: { safeMode: boolean; allowlist: string[] } }
  | { ok: false; error: string };

type EntrySource = 'event' | 'network';
type EntryFilter = 'all' | EntrySource;

type DbEntryRow = {
  id: string;
  source: EntrySource;
  timestamp: number;
  kind: string;
  summary: string;
  raw: unknown;
};

type EntriesResponse = {
  rows: DbEntryRow[];
  hasMore: boolean;
  nextOffset: number | null;
  totalApprox: number;
};

type SessionItem = {
  sessionId: string;
  createdAt: number;
  endedAt: number | null;
  urlLast: string | null;
  pinned: boolean;
};

let currentSessionId = '';
let rows: DbEntryRow[] = [];
let offset = 0;
let hasMore = false;
let filter: EntryFilter = 'all';
let totalApprox = 0;
let autoRefreshTimer: number | null = null;
const expanded = new Set<string>();
let lastDiagnosticsSummary = '';

function sendRuntimeMessage(message: unknown): Promise<RuntimeResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response: RuntimeResponse) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message ?? 'Unknown runtime error' });
        return;
      }
      resolve(response);
    });
  });
}

function setStatus(message: string): void {
  const el = document.getElementById('entries-status');
  if (el) {
    el.textContent = message;
  }
}

function setDiag(message: string): void {
  const el = document.getElementById('entries-diag');
  if (el) {
    el.textContent = message;
  }
}

async function refreshDiagnostics(): Promise<void> {
  const response = await sendRuntimeMessage({ type: 'SESSION_CAPTURE_DIAGNOSTICS' });
  if (!response.ok || !('result' in response) || !response.result || typeof response.result !== 'object') {
    lastDiagnosticsSummary = '';
    setDiag('');
    return;
  }

  const diag = response.result as {
    received?: number;
    accepted?: number;
    rejectedAllowlist?: number;
    rejectedSafeMode?: number;
    rejectedInactive?: number;
    sessionState?: { connectionStatus?: string; queuedEvents?: number };
  };

  const connection = diag.sessionState?.connectionStatus ?? 'unknown';
  const queued = diag.sessionState?.queuedEvents ?? 0;
  lastDiagnosticsSummary = `diag recv=${diag.received ?? 0} ok=${diag.accepted ?? 0} allowlist=${diag.rejectedAllowlist ?? 0} safe=${diag.rejectedSafeMode ?? 0} inactive=${diag.rejectedInactive ?? 0} conn=${connection} queued=${queued}`;
  setDiag(lastDiagnosticsSummary);
}

function isNotFoundError(error: string): boolean {
  return /not found/i.test(error);
}

function getPageSize(): number {
  const available = Math.max(window.innerHeight - 320, 300);
  return Math.min(Math.max(Math.floor(available / 32), 20), 120);
}

function formatTime(ts: number): string {
  return Number.isFinite(ts) ? new Date(ts).toLocaleString() : '-';
}

function parseEntriesResponse(result: unknown): EntriesResponse | null {
  if (!result || typeof result !== 'object') {
    return null;
  }
  const data = result as Partial<EntriesResponse>;
  if (!Array.isArray(data.rows) || typeof data.hasMore !== 'boolean') {
    return null;
  }
  return {
    rows: data.rows as DbEntryRow[],
    hasMore: data.hasMore,
    nextOffset: typeof data.nextOffset === 'number' ? data.nextOffset : null,
    totalApprox: typeof data.totalApprox === 'number' ? data.totalApprox : data.rows.length,
  };
}

function parseSessions(result: unknown): SessionItem[] {
  if (!result || typeof result !== 'object') {
    return [];
  }
  const value = result as { sessions?: unknown };
  if (!Array.isArray(value.sessions)) {
    return [];
  }
  return value.sessions.filter((item): item is SessionItem => {
    return Boolean(item) && typeof item === 'object' && typeof (item as { sessionId?: unknown }).sessionId === 'string';
  });
}

function visibleRows(): DbEntryRow[] {
  if (filter === 'all') {
    return rows;
  }
  return rows.filter((row) => row.source === filter);
}

function renderFilterState(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>('button[data-filter]');
  for (const button of buttons) {
    const value = button.dataset.filter;
    if (value === filter) {
      button.classList.add('is-active');
    } else {
      button.classList.remove('is-active');
    }
  }
}

function renderRows(): void {
  const body = document.getElementById('entries-body') as HTMLTableSectionElement | null;
  if (!body) {
    return;
  }

  body.replaceChildren();
  for (const row of visibleRows()) {
    const tr = document.createElement('tr');
    tr.dataset.rowId = row.id;

    const time = document.createElement('td');
    time.textContent = formatTime(row.timestamp);
    const source = document.createElement('td');
    source.textContent = row.source;
    const kind = document.createElement('td');
    kind.textContent = row.kind;
    const summary = document.createElement('td');
    summary.className = 'summary';
    summary.title = row.summary;
    summary.textContent = row.summary;
    const details = document.createElement('td');
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.dataset.rowToggle = row.id;
    toggle.textContent = expanded.has(row.id) ? 'Hide' : 'Show';
    details.append(toggle);

    tr.append(time, source, kind, summary, details);
    body.append(tr);

    if (expanded.has(row.id)) {
      const expandedRow = document.createElement('tr');
      expandedRow.className = 'expanded';
      const cell = document.createElement('td');
      cell.colSpan = 5;
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify(row.raw, null, 2);
      cell.append(pre);
      expandedRow.append(cell);
      body.append(expandedRow);
    }
  }

  const loadMore = document.getElementById('load-more') as HTMLButtonElement | null;
  if (loadMore) {
    loadMore.disabled = !hasMore;
  }

  const visibleCount = visibleRows().length;
  const updatedAt = new Date().toLocaleTimeString();
  if (rows.length === 0) {
    setStatus(`No DB entries yet. Refreshed ${updatedAt}.`);
  } else if (hasMore) {
    setStatus(`Showing ${visibleCount} rows (${rows.length} loaded of about ${totalApprox}). Refreshed ${updatedAt}.`);
  } else {
    setStatus(`Showing ${visibleCount} rows (${rows.length} loaded). Refreshed ${updatedAt}.`);
  }
}

async function loadEntries(append: boolean): Promise<boolean> {
  if (!currentSessionId) {
    setStatus('No session selected.');
    return false;
  }

  const nextOffset = append ? offset : 0;
  setStatus('Loading entries...');
  const response = await sendRuntimeMessage({
    type: 'SESSION_GET_DB_ENTRIES',
    sessionId: currentSessionId,
    limit: getPageSize(),
    offset: nextOffset,
  });

  if (!response.ok) {
    if (isNotFoundError(response.error)) {
      setStatus('Server API route for DB entries is missing. Restart mcp-server from latest code on port 3000.');
      return false;
    }
    setStatus(`Error: ${response.error}`);
    return false;
  }

  if (!('result' in response)) {
    setStatus('Unexpected entries response.');
    return false;
  }

  const parsed = parseEntriesResponse(response.result);
  if (!parsed) {
    setStatus('Invalid entries response.');
    return false;
  }

  rows = append ? [...rows, ...parsed.rows] : parsed.rows;
  hasMore = parsed.hasMore;
  offset = parsed.nextOffset ?? nextOffset + parsed.rows.length;
  totalApprox = parsed.totalApprox;
  await refreshDiagnostics();
  renderRows();
  return true;
}

function getSessionIdFromQuery(): string {
  const search = new URLSearchParams(window.location.search);
  return search.get('sessionId') ?? '';
}

function renderSessionPicker(sessions: SessionItem[]): void {
  const picker = document.getElementById('session-picker') as HTMLSelectElement | null;
  if (!picker) {
    return;
  }

  picker.replaceChildren();
  for (const session of sessions) {
    const option = document.createElement('option');
    option.value = session.sessionId;
    const pin = session.pinned ? ' [PIN]' : '';
    option.textContent = `${session.sessionId}${pin} - ${new Date(session.createdAt).toLocaleString()}`;
    picker.append(option);
  }

  if (!currentSessionId && sessions[0]) {
    currentSessionId = sessions[0].sessionId;
  }
  picker.value = currentSessionId;
}

async function initializeSessions(): Promise<void> {
  currentSessionId = getSessionIdFromQuery();

  if (currentSessionId) {
    const loaded = await loadEntries(false);
    if (loaded) {
      const picker = document.getElementById('session-picker') as HTMLSelectElement | null;
      if (picker) {
        const option = document.createElement('option');
        option.value = currentSessionId;
        option.textContent = currentSessionId;
        picker.replaceChildren(option);
        picker.value = currentSessionId;
      }
      return;
    }
  }

  const response = await sendRuntimeMessage({ type: 'SESSION_LIST_RECENT', limit: 50, offset: 0 });
  if (!response.ok) {
    if (isNotFoundError(response.error)) {
      setStatus('Server API route /sessions is missing. You are running an older mcp-server. Restart with: pnpm nx serve mcp-server');
      return;
    }
    setStatus(`Error loading sessions: ${response.error}`);
    return;
  }

  if (!('result' in response)) {
    setStatus('Unexpected sessions response.');
    return;
  }

  const sessions = parseSessions(response.result);
  if (!currentSessionId && sessions[0]) {
    currentSessionId = sessions[0].sessionId;
  }

  renderSessionPicker(sessions);

  if (!currentSessionId) {
    const config = await sendRuntimeMessage({ type: 'SESSION_GET_CONFIG' });
    if (config.ok && 'config' in config && config.config.allowlist.length === 0) {
      setStatus('No sessions found. Add your domain to allowlist in popup, start session, then reload this page.');
      return;
    }
    setStatus('No sessions found. Start a capture session from popup first, then reload this page.');
    return;
  }

  await loadEntries(false);
}

document.addEventListener('DOMContentLoaded', () => {
  const body = document.getElementById('entries-body');
  const filters = document.querySelector('.filter-bar');
  const loadMore = document.getElementById('load-more');
  const reload = document.getElementById('reload-entries');
  const picker = document.getElementById('session-picker') as HTMLSelectElement | null;
  const autoRefresh = document.getElementById('auto-refresh') as HTMLInputElement | null;

  body?.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const button = target.closest('button[data-row-toggle]') as HTMLButtonElement | null;
    if (!button) {
      return;
    }
    const id = button.dataset.rowToggle;
    if (!id) {
      return;
    }
    if (expanded.has(id)) {
      expanded.delete(id);
    } else {
      expanded.add(id);
    }
    renderRows();
  });

  filters?.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const button = target.closest('button[data-filter]') as HTMLButtonElement | null;
    if (!button) {
      return;
    }
    const value = button.dataset.filter;
    if (value !== 'all' && value !== 'event' && value !== 'network') {
      return;
    }
    filter = value;
    renderFilterState();
    renderRows();
  });

  loadMore?.addEventListener('click', async () => {
    if (!hasMore) {
      return;
    }
    await loadEntries(true);
  });

  reload?.addEventListener('click', async () => {
    expanded.clear();
    await loadEntries(false);
  });

  picker?.addEventListener('change', async () => {
    currentSessionId = picker.value;
    rows = [];
    offset = 0;
    hasMore = false;
    expanded.clear();
    await loadEntries(false);
  });

  autoRefresh?.addEventListener('change', () => {
    if (autoRefresh.checked) {
      if (autoRefreshTimer !== null) {
        window.clearInterval(autoRefreshTimer);
      }
      autoRefreshTimer = window.setInterval(() => {
        void loadEntries(false);
      }, 2000);
      return;
    }

    if (autoRefreshTimer !== null) {
      window.clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
  });

  window.addEventListener('unload', () => {
    if (autoRefreshTimer !== null) {
      window.clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
  });

  renderFilterState();
  void initializeSessions();
});
