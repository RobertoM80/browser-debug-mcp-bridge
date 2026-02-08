type SessionState = {
  isActive: boolean;
  sessionId: string | null;
  connectionStatus: 'disconnected' | 'connecting' | 'connected';
  queuedEvents: number;
  droppedEvents: number;
};

type SessionResponse =
  | { ok: true; state: SessionState; accepted?: boolean }
  | { ok: false; error: string };

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
    statusEl.textContent = state.isActive
      ? `Session active (${state.connectionStatus})`
      : `No active session (${state.connectionStatus})`;
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

async function refreshState(): Promise<void> {
  const result = await sendRuntimeMessage({ type: 'SESSION_GET_STATE' });
  if (result.ok) {
    renderSessionState(result.state);
    return;
  }

  const statusEl = document.getElementById('status');
  if (statusEl) {
    statusEl.textContent = `Error: ${result.error}`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const startButton = document.getElementById('start-session');
  const stopButton = document.getElementById('stop-session');

  startButton?.addEventListener('click', async () => {
    const result = await sendRuntimeMessage({ type: 'SESSION_START' });
    if (result.ok) {
      renderSessionState(result.state);
    }
  });

  stopButton?.addEventListener('click', async () => {
    const result = await sendRuntimeMessage({ type: 'SESSION_STOP' });
    if (result.ok) {
      renderSessionState(result.state);
    }
  });

  refreshState();
});
