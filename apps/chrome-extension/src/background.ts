import { SessionManager, SessionState, CaptureCommandType } from './session-manager';
import {
  applySafeModeRestrictions,
  CaptureConfig,
  DEFAULT_CAPTURE_CONFIG,
  isUrlAllowed,
  loadCaptureConfig,
  saveCaptureConfig,
} from './capture-controls';

type RuntimeRequest =
  | { type: 'SESSION_GET_STATE' }
  | { type: 'SESSION_START' }
  | { type: 'SESSION_STOP' }
  | { type: 'SESSION_QUEUE_EVENT'; eventType: string; data: Record<string, unknown> }
  | { type: 'SESSION_GET_CONFIG' }
  | { type: 'SESSION_UPDATE_CONFIG'; config: CaptureConfig };

type RuntimeResponse =
  | { ok: true; state: SessionState; accepted?: boolean }
  | { ok: true; config: CaptureConfig }
  | { ok: false; error: string };

interface CaptureTabResponse {
  ok: boolean;
  result?: Record<string, unknown>;
  truncated?: boolean;
  error?: string;
}

async function executeCaptureCommand(
  command: CaptureCommandType,
  payload: Record<string, unknown>
): Promise<{ payload: Record<string, unknown>; truncated?: boolean }> {
  const tab = await getActiveTab();
  const tabId = tab?.id;
  if (tabId === undefined) {
    throw new Error('No active tab available for capture');
  }

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
}

const sessionManager = new SessionManager({
  handleCaptureCommand: executeCaptureCommand,
});
const LOG_PREFIX = '[BrowserDebug][Background]';
let captureConfig: CaptureConfig = { ...DEFAULT_CAPTURE_CONFIG };

void loadCaptureConfig(chrome.storage.local).then((loaded) => {
  captureConfig = loaded;
});

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
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
        .then((tab) => {
          const activeUrl = tab?.url ?? 'about:blank';
          const canCaptureActiveTab = isUrlAllowed(activeUrl, captureConfig.allowlist);

          if (!canCaptureActiveTab) {
            return {
              ok: false as const,
              error: 'Active tab is not in allowlist. Add a domain in popup settings.',
            };
          }

          const started = sessionManager.startSession({
            url: activeUrl,
            tabId: tab?.id,
            windowId: tab?.windowId,
            userAgent: navigator.userAgent,
            viewport: {
              width: window.screen.width,
              height: window.screen.height,
            },
            dpr: window.devicePixelRatio,
            safeMode: captureConfig.safeMode,
          });
          return { ok: true as const, state: started };
        })
        .catch((error) => ({
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to start session',
        }));
    }

    case 'SESSION_STOP':
      return Promise.resolve({ ok: true, state: sessionManager.stopSession() });

    case 'SESSION_QUEUE_EVENT': {
      const senderUrl = sender.tab?.url ?? sender.url ?? '';
      const canCaptureSender = isUrlAllowed(senderUrl, captureConfig.allowlist);

      if (!canCaptureSender) {
        return Promise.resolve({ ok: true, state: sessionManager.getState(), accepted: false });
      }

      let payload = request.data;
      if (captureConfig.safeMode) {
        const restricted = applySafeModeRestrictions(request.eventType, request.data);
        if (!restricted) {
          return Promise.resolve({ ok: true, state: sessionManager.getState(), accepted: false });
        }
        payload = restricted;
      }

      const accepted = sessionManager.queueEvent(request.eventType, payload);
      return Promise.resolve({ ok: true, state: sessionManager.getState(), accepted });
    }

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

console.log(`${LOG_PREFIX} Service worker started`);

chrome.runtime.onStartup.addListener(() => {
  console.log(`${LOG_PREFIX} Extension started`);
});

chrome.runtime.onInstalled.addListener(() => {
  console.log(`${LOG_PREFIX} Extension installed`);
});
