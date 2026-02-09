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
};

type SessionResponse =
  | { ok: true; state: SessionState; accepted?: boolean }
  | { ok: true; config: CaptureConfig }
  | { ok: false; error: string };

let statePollTimer: number | null = null;

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

  if (safeModeCheckbox) {
    safeModeCheckbox.checked = config.safeMode;
  }

  if (allowlistInput) {
    allowlistInput.value = config.allowlist.join('\n');
  }
}

function getConfigFromForm(): CaptureConfig {
  const safeModeCheckbox = document.getElementById('safe-mode') as HTMLInputElement | null;
  const allowlistInput = document.getElementById('allowlist-domains') as HTMLTextAreaElement | null;

  const allowlist = (allowlistInput?.value ?? '')
    .split(/[\n,]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);

  return {
    safeMode: safeModeCheckbox?.checked ?? true,
    allowlist,
  };
}

function setConfigStatus(message: string): void {
  const status = document.getElementById('config-status');
  if (status) {
    status.textContent = message;
  }
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

document.addEventListener('DOMContentLoaded', () => {
  const startButton = document.getElementById('start-session');
  const stopButton = document.getElementById('stop-session');
  const saveConfigButton = document.getElementById('save-config');

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

  refreshState();
  refreshConfig();
  startStatePolling();

  window.addEventListener('unload', () => {
    stopStatePolling();
  });
});
