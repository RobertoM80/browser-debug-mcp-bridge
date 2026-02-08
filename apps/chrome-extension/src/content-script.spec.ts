// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_KIND, BRIDGE_SOURCE, installContentCapture } from './content-script';

function createRuntimeMock(
  sendMessage: (message: unknown, callback?: () => void) => void
): { sendMessage: (message: unknown, callback?: () => void) => void } {
  return {
    sendMessage,
  };
}

describe('content-script capture', () => {
  beforeEach(() => {
    history.replaceState({}, '', '/start');
  });

  it('captures navigation events from history updates', () => {
    const sendMessage = vi.fn((_message: unknown, callback?: () => void) => {
      callback?.();
    });
    const cleanup = installContentCapture({ runtime: createRuntimeMock(sendMessage) });

    history.pushState({}, '', '/next');
    window.dispatchEvent(new PopStateEvent('popstate'));

    const eventTypes = sendMessage.mock.calls.map((entry: unknown[]) => {
      const message = entry[0] as { eventType: string };
      return message.eventType;
    });

    expect(eventTypes.filter((type: string) => type === 'navigation').length).toBeGreaterThanOrEqual(3);
    cleanup();
  });

  it('forwards injected script events to background worker', async () => {
    const sendMessage = vi.fn((_message: unknown, callback?: () => void) => {
      callback?.();
    });
    const cleanup = installContentCapture({ runtime: createRuntimeMock(sendMessage) });

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          source: BRIDGE_SOURCE,
          kind: BRIDGE_KIND,
          eventType: 'console',
          data: { level: 'error', message: 'boom' },
        },
        source: window,
      })
    );

    await Promise.resolve();

    const forwarded = sendMessage.mock.calls.find((entry: unknown[]) => {
      const message = entry[0] as { eventType?: string };
      return message.eventType === 'console';
    });

    expect(forwarded).toBeDefined();
    cleanup();
  });
});
