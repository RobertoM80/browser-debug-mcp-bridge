import { expect, test } from '@playwright/test';
import WebSocket from 'ws';
import { callToolJson, callToolText, connectMcpClient } from './utils/mcp-client';
import { createTempDataDir, getFreePort } from './utils/runtime';

type EventRecord = {
  eventId: string;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
};

function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out opening websocket client'));
    }, 10_000);

    ws.once('open', () => {
      clearTimeout(timeout);
      resolve();
    });
    ws.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function sendWs(ws: WebSocket, payload: Record<string, unknown>): void {
  ws.send(JSON.stringify(payload));
}

function installCaptureResponder(ws: WebSocket): void {
  ws.on('message', (raw) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    if (message.type !== 'capture_command') {
      return;
    }

    const command = message.command;
    const commandId = typeof message.commandId === 'string' ? message.commandId : 'unknown-command-id';
    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : 'unknown-session';

    const payloadByCommand: Record<string, Record<string, unknown>> = {
      CAPTURE_DOM_SUBTREE: {
        selector: '#login-btn',
        nodeCount: 3,
        html: '<div id="root"><button id="login-btn">Login</button></div>',
      },
      CAPTURE_DOM_DOCUMENT: {
        mode: 'outline',
        title: 'Mock login page',
        outline: ['html', 'body', '#root', '#login-btn'],
      },
      CAPTURE_COMPUTED_STYLES: {
        selector: '#login-btn',
        styles: {
          display: 'inline-block',
          visibility: 'visible',
          opacity: '1',
        },
      },
      CAPTURE_LAYOUT_METRICS: {
        viewport: {
          width: 1280,
          height: 720,
          scrollX: 0,
          scrollY: 0,
        },
        element: {
          selector: '#login-btn',
          x: 24,
          y: 64,
          width: 120,
          height: 36,
        },
      },
      CAPTURE_UI_SNAPSHOT: {
        timestamp: Date.now(),
        trigger: 'manual',
        selector: '#login-btn',
        url: 'http://localhost:3000/login',
        mode: {
          dom: true,
          png: false,
          styleMode: 'computed-lite',
        },
        truncation: {
          dom: false,
          styles: false,
          png: false,
        },
        snapshot: {
          dom: { node: 'button', id: 'login-btn' },
          styles: { display: 'inline-block' },
        },
      },
      CAPTURE_GET_LIVE_CONSOLE_LOGS: {
        logs: [
          {
            ts: Date.now(),
            level: 'info',
            message: '[auth] logged in success',
            tabId: 10,
            origin: 'http://localhost:3000',
          },
        ],
        pagination: {
          returned: 1,
          matched: 1,
        },
        filtersApplied: {
          contains: '[auth]',
          levels: ['info', 'error'],
        },
        bufferStats: {
          buffered: 5,
          dropped: 0,
        },
      },
    };

    const responsePayload = payloadByCommand[String(command)] ?? { ok: true };

    sendWs(ws, {
      type: 'capture_result',
      commandId,
      sessionId,
      ok: true,
      payload: responsePayload,
      truncated: false,
      timestamp: Date.now(),
    });
  });
}

async function waitForSeededEvents(clientHandle: Awaited<ReturnType<typeof connectMcpClient>>, sessionId: string): Promise<void> {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    const recent = await callToolJson<{ events?: EventRecord[] }>(clientHandle.client, 'get_recent_events', {
      sessionId,
      limit: 25,
    });

    if (Array.isArray(recent.events) && recent.events.length >= 5) {
      return;
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  }

  throw new Error('Timed out waiting for seeded events to be queryable');
}

test.describe('@full mcp tool end-to-end coverage', () => {
  test('executes query and live tools through stdio bridge with session/url filtering', async () => {
    const dataDir = createTempDataDir('bdmcp-e2e-full-mcp-data-');
    const port = await getFreePort();
    const mcp = await connectMcpClient(dataDir, { port });

    const liveSessionId = 'sess-live';
    const historicalSessionId = 'sess-historical';

    const wsLive = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const wsHistorical = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    try {
      await waitForOpen(wsLive);
      await waitForOpen(wsHistorical);

      installCaptureResponder(wsLive);

      sendWs(wsLive, {
        type: 'session_start',
        sessionId: liveSessionId,
        url: 'http://localhost:3000/login',
        tabId: 10,
        safeMode: false,
        timestamp: Date.now(),
      });

      sendWs(wsHistorical, {
        type: 'session_start',
        sessionId: historicalSessionId,
        url: 'http://example.com/',
        tabId: 20,
        safeMode: false,
        timestamp: Date.now(),
      });

      const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP+fM9vWQAAAABJRU5ErkJggg==';

      sendWs(wsLive, {
        type: 'event_batch',
        sessionId: liveSessionId,
        events: [
          {
            eventType: 'navigation',
            data: {
              url: 'http://localhost:3000/login',
              to: 'http://localhost:3000/login',
            },
            origin: 'http://localhost:3000',
            tabId: 10,
            timestamp: Date.now() - 800,
          },
          {
            eventType: 'console',
            data: {
              level: 'info',
              message: '[auth] logged in success',
              url: 'http://localhost:3000/login',
              selector: '#login-btn',
            },
            origin: 'http://localhost:3000',
            tabId: 10,
            timestamp: Date.now() - 700,
          },
          {
            eventType: 'console',
            data: {
              level: 'error',
              message: '[auth] login failed',
              url: 'http://localhost:3000/login',
              selector: '#login-btn',
            },
            origin: 'http://localhost:3000',
            tabId: 10,
            timestamp: Date.now() - 650,
          },
          {
            eventType: 'error',
            data: {
              message: 'Unhandled auth failure',
              stack: 'Error: Unhandled auth failure at login.ts:1',
              url: 'http://localhost:3000/login',
            },
            origin: 'http://localhost:3000',
            tabId: 10,
            timestamp: Date.now() - 600,
          },
          {
            eventType: 'click',
            data: {
              eventType: 'click',
              selector: '#login-btn',
              href: 'http://localhost:3000/login',
            },
            origin: 'http://localhost:3000',
            tabId: 10,
            timestamp: Date.now() - 550,
          },
          {
            eventType: 'network',
            data: {
              url: 'http://localhost:3000/api/login',
              method: 'POST',
              status: 500,
              initiator: 'fetch',
              errorType: 'http_error',
              responseSize: 256,
              timestamp: Date.now() - 500,
            },
            origin: 'http://localhost:3000',
            tabId: 10,
            timestamp: Date.now() - 500,
          },
          {
            eventType: 'ui_snapshot',
            data: {
              timestamp: Date.now() - 450,
              trigger: 'manual',
              selector: '#login-btn',
              url: 'http://localhost:3000/login',
              mode: {
                dom: true,
                png: true,
                styleMode: 'computed-lite',
              },
              truncation: {
                dom: false,
                styles: false,
                png: false,
              },
              snapshot: {
                dom: { tag: 'button', id: 'login-btn' },
                styles: { display: 'inline-block' },
              },
              png: {
                captured: true,
                format: 'png',
                dataUrl: pngDataUrl,
                byteLength: 67,
              },
            },
            origin: 'http://localhost:3000',
            tabId: 10,
            timestamp: Date.now() - 450,
          },
        ],
        timestamp: Date.now(),
      });

      sendWs(wsHistorical, {
        type: 'event',
        sessionId: historicalSessionId,
        eventType: 'console',
        data: {
          level: 'info',
          message: '[legacy] example session log',
          url: 'http://example.com/',
        },
        origin: 'http://example.com',
        tabId: 20,
        timestamp: Date.now() - 300,
      });

      sendWs(wsHistorical, {
        type: 'session_end',
        sessionId: historicalSessionId,
        timestamp: Date.now(),
      });

      await waitForSeededEvents(mcp, liveSessionId);

      const sessions = await callToolJson<{
        sessions: Array<{ sessionId: string; liveConnection?: { connected?: boolean } }>;
      }>(mcp.client, 'list_sessions', { limit: 25 });
      expect(sessions.sessions.some((session) => session.sessionId === liveSessionId)).toBe(true);
      expect(sessions.sessions.some((session) => session.sessionId === historicalSessionId)).toBe(true);

      const summary = await callToolJson<{ counts: Record<string, number> }>(mcp.client, 'get_session_summary', {
        sessionId: liveSessionId,
      });
      expect(summary.counts).toBeDefined();

      const recent = await callToolJson<{ events: EventRecord[] }>(mcp.client, 'get_recent_events', {
        sessionId: liveSessionId,
        limit: 100,
      });
      expect(recent.events.length).toBeGreaterThan(0);

      const byOrigin = await callToolJson<{ events: EventRecord[] }>(mcp.client, 'get_recent_events', {
        url: 'http://localhost:3000',
        limit: 100,
      });
      expect(byOrigin.events.length).toBeGreaterThan(0);
      expect(byOrigin.events.every((event) => event.sessionId === liveSessionId)).toBe(true);

      const intersection = await callToolJson<{ events: EventRecord[] }>(mcp.client, 'get_recent_events', {
        sessionId: liveSessionId,
        url: 'http://localhost:3000',
        limit: 100,
      });
      expect(intersection.events.length).toBeGreaterThan(0);

      const invalidUrl = await callToolText(mcp.client, 'get_recent_events', {
        url: 'localhost:3000',
      });
      expect(invalidUrl.isError).toBe(true);
      expect(invalidUrl.text).toContain('valid absolute http(s) URL');

      const nav = await callToolJson<{ events: Array<Record<string, unknown>> }>(mcp.client, 'get_navigation_history', {
        sessionId: liveSessionId,
      });
      expect(nav.events.length).toBeGreaterThan(0);

      const consoleEvents = await callToolJson<{ events: EventRecord[] }>(mcp.client, 'get_console_events', {
        sessionId: liveSessionId,
        level: 'error',
      });
      expect(consoleEvents.events.some((event) => event.payload.level === 'error')).toBe(true);

      const fingerprints = await callToolJson<{ fingerprints: Array<Record<string, unknown>> }>(mcp.client, 'get_error_fingerprints', {
        sessionId: liveSessionId,
      });
      expect(fingerprints.fingerprints.length).toBeGreaterThan(0);

      const failures = await callToolJson<{ failures: Array<Record<string, unknown>> }>(mcp.client, 'get_network_failures', {
        sessionId: liveSessionId,
      });
      expect(failures.failures.length).toBeGreaterThan(0);

      const elementRefs = await callToolJson<{ refs: EventRecord[] }>(mcp.client, 'get_element_refs', {
        sessionId: liveSessionId,
        selector: '#login-btn',
      });
      expect(elementRefs.refs.length).toBeGreaterThan(0);

      const domSubtree = await callToolJson<Record<string, unknown>>(mcp.client, 'get_dom_subtree', {
        sessionId: liveSessionId,
        selector: '#login-btn',
      });
      expect(domSubtree.selector).toBe('#login-btn');

      const domDocument = await callToolJson<Record<string, unknown>>(mcp.client, 'get_dom_document', {
        sessionId: liveSessionId,
        mode: 'outline',
      });
      expect(domDocument.mode).toBe('outline');

      const styles = await callToolJson<Record<string, unknown>>(mcp.client, 'get_computed_styles', {
        sessionId: liveSessionId,
        selector: '#login-btn',
        properties: ['display', 'opacity'],
      });
      expect(styles.selector).toBe('#login-btn');

      const layout = await callToolJson<Record<string, unknown>>(mcp.client, 'get_layout_metrics', {
        sessionId: liveSessionId,
        selector: '#login-btn',
      });
      expect(layout.viewport).toBeDefined();

      const snapshotCapture = await callToolJson<Record<string, unknown>>(mcp.client, 'capture_ui_snapshot', {
        sessionId: liveSessionId,
        selector: '#login-btn',
        trigger: 'manual',
      });
      expect(snapshotCapture.snapshot).toBeDefined();

      const liveConsole = await callToolJson<{ logs: Array<Record<string, unknown>> }>(mcp.client, 'get_live_console_logs', {
        sessionId: liveSessionId,
        url: 'http://localhost:3000',
        levels: ['info', 'error'],
        contains: '[auth]',
      });
      expect(liveConsole.logs.length).toBeGreaterThan(0);

      const explanation = await callToolJson<{ timeline: Array<Record<string, unknown>> }>(mcp.client, 'explain_last_failure', {
        sessionId: liveSessionId,
      });
      expect(Array.isArray(explanation.timeline)).toBe(true);

      const errorEvent = recent.events.find((event) => event.type === 'error') ?? recent.events[0];
      if (!errorEvent) {
        throw new Error('Expected at least one event for correlation tests');
      }

      const correlation = await callToolJson<{ correlatedEvents: Array<Record<string, unknown>> }>(mcp.client, 'get_event_correlation', {
        sessionId: liveSessionId,
        eventId: errorEvent.eventId,
      });
      expect(Array.isArray(correlation.correlatedEvents)).toBe(true);

      const snapshots = await callToolJson<{ snapshots: Array<{ snapshotId: string; triggerEventId?: string }> }>(mcp.client, 'list_snapshots', {
        sessionId: liveSessionId,
      });
      expect(snapshots.snapshots.length).toBeGreaterThan(0);

      const snapshotMeta = snapshots.snapshots[0];
      if (!snapshotMeta) {
        throw new Error('Expected at least one snapshot');
      }

      const triggerEventId = snapshotMeta.triggerEventId ?? errorEvent.eventId;
      const snapshotForEvent = await callToolJson<{ snapshot: Record<string, unknown> | null }>(mcp.client, 'get_snapshot_for_event', {
        sessionId: liveSessionId,
        eventId: triggerEventId,
      });
      expect(snapshotForEvent.snapshot).toBeTruthy();

      const snapshotAsset = await callToolJson<{ chunkBase64?: string; returnedBytes: number }>(mcp.client, 'get_snapshot_asset', {
        sessionId: liveSessionId,
        snapshotId: snapshotMeta.snapshotId,
        asset: 'png',
        encoding: 'base64',
        maxBytes: 2048,
      });
      expect(snapshotAsset.returnedBytes).toBeGreaterThan(0);
      expect(typeof snapshotAsset.chunkBase64).toBe('string');
    } finally {
      wsLive.close();
      wsHistorical.close();
      await mcp.close();
    }
  });
});
