import { SessionManager, SessionState } from './session-manager';

type RuntimeRequest =
  | { type: 'SESSION_GET_STATE' }
  | { type: 'SESSION_START' }
  | { type: 'SESSION_STOP' }
  | { type: 'SESSION_QUEUE_EVENT'; eventType: string; data: Record<string, unknown> };

type RuntimeResponse =
  | { ok: true; state: SessionState; accepted?: boolean }
  | { ok: false; error: string };

const sessionManager = new SessionManager();

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function handleRequest(request: RuntimeRequest): Promise<RuntimeResponse> {
  switch (request.type) {
    case 'SESSION_GET_STATE':
      return Promise.resolve({ ok: true, state: sessionManager.getState() });

    case 'SESSION_START': {
      return getActiveTab()
        .then((tab) => {
          const started = sessionManager.startSession({
            url: tab?.url ?? 'about:blank',
            tabId: tab?.id,
            windowId: tab?.windowId,
            userAgent: navigator.userAgent,
            viewport: {
              width: window.screen.width,
              height: window.screen.height,
            },
            dpr: window.devicePixelRatio,
            safeMode: false,
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
      const accepted = sessionManager.queueEvent(request.eventType, request.data);
      return Promise.resolve({ ok: true, state: sessionManager.getState(), accepted });
    }

    default:
      return Promise.resolve({ ok: false, error: 'Unsupported message type' });
  }
}

chrome.runtime.onMessage.addListener((request: RuntimeRequest, _sender, sendResponse) => {
  handleRequest(request)
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

console.log('[BrowserDebug] Background service worker started');

chrome.runtime.onStartup.addListener(() => {
  console.log('[BrowserDebug] Extension started');
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[BrowserDebug] Extension installed');
});
