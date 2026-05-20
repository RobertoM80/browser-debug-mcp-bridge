import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveUIActionRequest } from '../../../libs/mcp-contracts/src';
import {
  executeNativeBlurAction,
  executeNativeClickAction,
  executeNativeFocusAction,
  executeNativeHoverAction,
  executeNativeInputAction,
  executeNativePressKeyAction,
  executeNativeScrollAction,
  executeNativeSubmitAction,
  nativeAutomationBackend,
} from './automation-native';

const targetSnapshot = {
  matched: true,
  selector: '#save',
  resolvedSelector: '#save',
  tagName: 'button',
  textPreview: 'Save',
  center: {
    x: 42,
    y: 24,
  },
  rect: {
    x: 12,
    y: 10,
    width: 60,
    height: 28,
  },
  actionability: {
    visible: true,
    enabled: true,
    stable: true,
    inViewport: true,
    receivesPointerEvents: true,
    hitTargetMatches: true,
  },
};

function installChromeMock(snapshot: unknown = targetSnapshot): {
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  sendCommand: ReturnType<typeof vi.fn>;
  executeScript: ReturnType<typeof vi.fn>;
} {
  const attach = vi.fn(async () => undefined);
  const detach = vi.fn(async () => undefined);
  const sendCommand = vi.fn(async () => ({}));
  const snapshots = Array.isArray(snapshot) ? [...snapshot] : [snapshot];
  const executeScript = vi.fn(async () => {
    const next = snapshots.length > 1 ? snapshots.shift() : snapshots[0];
    if (next instanceof Error) {
      throw next;
    }
    return [{ result: next }];
  });

  vi.stubGlobal('chrome', {
    scripting: {
      executeScript,
    },
    debugger: {
      attach,
      detach,
      sendCommand,
    },
  });

  return {
    attach,
    detach,
    sendCommand,
    executeScript,
  };
}

function encodeElementRef(payload: Record<string, unknown>): string {
  return `ref:${btoa(JSON.stringify(payload))}`;
}

describe('native automation backend', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('dispatches native CDP mouse events for click actions', async () => {
    const chromeMock = installChromeMock();
    const request: Extract<LiveUIActionRequest, { action: 'click' }> = {
      action: 'click',
      traceId: 'trace-click-native',
      target: {
        selector: '#save',
        tabId: 7,
        frameId: 0,
        url: 'https://example.com/settings',
      },
      input: {
        clickCount: 2,
      },
    };

    const result = await executeNativeClickAction({
      request,
      tab: {
        id: 7,
        url: 'https://example.com/settings',
      } as chrome.tabs.Tab & { id: number },
      startedAt: 1000,
      traceId: 'trace-click-native',
    });

    expect(result.status).toBe('succeeded');
    expect(result.result).toMatchObject({
      backend: nativeAutomationBackend,
      clickCount: 2,
      button: 'left',
      point: {
        x: 42,
        y: 24,
      },
    });
    expect(chromeMock.attach).toHaveBeenCalledWith({ tabId: 7 }, '1.3');
    expect(chromeMock.sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.dispatchMouseEvent',
      expect.objectContaining({
        type: 'mousePressed',
        x: 42,
        y: 24,
      }),
    );
    expect(chromeMock.detach).toHaveBeenCalledWith({ tabId: 7 });
  });

  it('dispatches coordinate click targets directly in the top document', async () => {
    const chromeMock = installChromeMock({
      url: 'https://example.com/settings',
      inViewport: true,
      point: {
        x: 88,
        y: 44,
      },
      viewportRect: {
        x: 0,
        y: 0,
        width: 1280,
        height: 720,
      },
      hitTargetSelector: '#save',
      hitTargetTagName: 'button',
      hitTargetTextPreview: 'Save',
    });
    const request: Extract<LiveUIActionRequest, { action: 'click' }> = {
      action: 'click',
      traceId: 'trace-click-coordinate-native',
      target: {
        tabId: 7,
        coordinates: {
          x: 88,
          y: 44,
        },
      },
    };

    const result = await executeNativeClickAction({
      request,
      tab: {
        id: 7,
        url: 'https://example.com/settings',
      } as chrome.tabs.Tab & { id: number },
      startedAt: 1000,
      traceId: 'trace-click-coordinate-native',
    });

    expect(result.status).toBe('succeeded');
    expect(result.result).toMatchObject({
      backend: nativeAutomationBackend,
      point: {
        x: 88,
        y: 44,
      },
      pointCoordinateSpace: 'top-document',
      coordinateTarget: true,
    });
    expect(chromeMock.sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.dispatchMouseEvent',
      expect.objectContaining({
        type: 'mousePressed',
        x: 88,
        y: 44,
      }),
    );
  });

  it('rejects coordinate targets for non-top-document frames', async () => {
    const chromeMock = installChromeMock();
    const request: Extract<LiveUIActionRequest, { action: 'click' }> = {
      action: 'click',
      traceId: 'trace-click-coordinate-frame',
      target: {
        tabId: 7,
        coordinates: {
          x: 88,
          y: 44,
          frameId: 4,
        },
      },
    };

    const result = await executeNativeClickAction({
      request,
      tab: {
        id: 7,
        url: 'https://example.com/settings',
      } as chrome.tabs.Tab & { id: number },
      startedAt: 1000,
      traceId: 'trace-click-coordinate-frame',
    });

    expect(result.status).toBe('rejected');
    expect(result.failureReason?.code).toBe('coordinate_frame_unsupported');
    expect(chromeMock.executeScript).not.toHaveBeenCalled();
    expect(chromeMock.sendCommand).not.toHaveBeenCalled();
  });

  it('resolves locator targets in the native page context before dispatch', async () => {
    const attach = vi.fn(async () => undefined);
    const detach = vi.fn(async () => undefined);
    const sendCommand = vi.fn(async () => ({}));
    const executeScript = vi
      .fn()
      .mockResolvedValueOnce([
        {
          frameId: 0,
          result: {
            url: 'https://example.com/settings',
            title: 'Settings',
            candidates: [
              {
                selector: '#save',
                text: 'Save',
                role: 'button',
                name: 'Save',
                tagName: 'button',
                visible: true,
                disabled: false,
              },
            ],
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          result: targetSnapshot,
        },
      ]);

    vi.stubGlobal('chrome', {
      scripting: {
        executeScript,
      },
      debugger: {
        attach,
        detach,
        sendCommand,
      },
    });

    const request: Extract<LiveUIActionRequest, { action: 'click' }> = {
      action: 'click',
      traceId: 'trace-click-native-locator',
      target: {
        tabId: 7,
        locator: {
          steps: [
            {
              kind: 'testId',
              value: 'settings-panel',
            },
            {
              kind: 'role',
              role: 'button',
              name: 'Save',
              exact: true,
              relation: 'descendant',
            },
          ],
        },
      },
    };

    const result = await executeNativeClickAction({
      request,
      tab: {
        id: 7,
        url: 'https://example.com/settings',
      } as chrome.tabs.Tab & { id: number },
      startedAt: 1000,
      traceId: 'trace-click-native-locator',
    });

    expect(result.status).toBe('succeeded');
    expect(result.target).toMatchObject({
      selector: '#save',
      frameId: 0,
    });
    expect(result.result).toMatchObject({
      backend: nativeAutomationBackend,
      locatorResolution: {
        strategy: 'native_locator',
        matchedCandidateCount: 1,
        matched: {
          selector: '#save',
          frameId: 0,
        },
      },
    });
    expect(executeScript).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        target: {
          tabId: 7,
          allFrames: true,
        },
        args: [
          expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({
                kind: 'role',
                relation: 'descendant',
              }),
            ]),
          }),
          expect.any(Object),
        ],
      }),
    );
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.dispatchMouseEvent',
      expect.objectContaining({
        type: 'mousePressed',
        x: 42,
        y: 24,
      }),
    );
  });

  it('uses frame selector paths to disambiguate locator targets across nested frames', async () => {
    const attach = vi.fn(async () => undefined);
    const detach = vi.fn(async () => undefined);
    const sendCommand = vi.fn(async () => ({}));
    const executeScript = vi
      .fn()
      .mockResolvedValueOnce([
        {
          frameId: 4,
          result: {
            frameSelector: '#child-frame',
            url: 'https://example.com/child-frame',
            title: 'Child frame',
            candidates: [
              {
                selector: '#inside-frame',
                text: 'Inside frame',
                role: 'button',
                name: 'Inside frame',
                tagName: 'button',
                visible: true,
                disabled: false,
              },
            ],
          },
        },
        {
          frameId: 8,
          result: {
            url: 'https://example.com/nested-frame',
            title: 'Nested frame',
            candidates: [
              {
                selector: '#nested-frame-action',
                text: 'Nested frame action',
                role: 'button',
                name: 'Nested frame action',
                tagName: 'button',
                visible: true,
                disabled: false,
              },
            ],
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          result: ['#child-frame'],
        },
      ])
      .mockResolvedValueOnce([
        {
          result: ['#outer-frame => #inner-frame'],
        },
      ])
      .mockResolvedValueOnce([
        {
          result: {
            ...targetSnapshot,
            selector: '#nested-frame-action',
            resolvedSelector: '#nested-frame-action',
            frameId: 8,
            url: 'https://example.com/nested-frame',
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          result: {
            x: 100,
            y: 200,
          },
        },
      ]);

    vi.stubGlobal('chrome', {
      scripting: {
        executeScript,
      },
      debugger: {
        attach,
        detach,
        sendCommand,
      },
    });

    const request: Extract<LiveUIActionRequest, { action: 'click' }> = {
      action: 'click',
      traceId: 'trace-click-native-frame-selector',
      target: {
        tabId: 7,
        locator: {
          frame: {
            selector: '#outer-frame => #inner-frame',
          },
          steps: [
            {
              kind: 'testId',
              value: 'nested-frame-action',
            },
          ],
        },
      },
    };

    const result = await executeNativeClickAction({
      request,
      tab: {
        id: 7,
        url: 'https://example.com/settings',
      } as chrome.tabs.Tab & { id: number },
      startedAt: 1000,
      traceId: 'trace-click-native-frame-selector',
    });

    expect(result.status).toBe('succeeded');
    expect(result.target).toMatchObject({
      selector: '#nested-frame-action',
      frameId: 8,
    });
    expect(result.result).toMatchObject({
      backend: nativeAutomationBackend,
      locatorResolution: {
        strategy: 'native_locator',
        matcher: {
          locator: {
            frame: {
              selector: '#outer-frame => #inner-frame',
            },
          },
        },
        matched: {
          selector: '#nested-frame-action',
          frameSelector: '#outer-frame => #inner-frame',
        },
      },
    });
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.dispatchMouseEvent',
      expect.objectContaining({
        type: 'mousePressed',
        x: 142,
        y: 224,
      }),
    );
  });

  it('rejects ambiguous native locator targets before dispatch', async () => {
    const attach = vi.fn(async () => undefined);
    const detach = vi.fn(async () => undefined);
    const sendCommand = vi.fn(async () => ({}));
    const executeScript = vi.fn(async () => [
      {
        frameId: 0,
        result: {
          url: 'https://example.com/settings',
          title: 'Settings',
          candidates: [
            {
              selector: '#save-a',
              text: 'Save',
              role: 'button',
              name: 'Save',
            },
            {
              selector: '#save-b',
              text: 'Save',
              role: 'button',
              name: 'Save',
            },
          ],
        },
      },
    ]);

    vi.stubGlobal('chrome', {
      scripting: {
        executeScript,
      },
      debugger: {
        attach,
        detach,
        sendCommand,
      },
    });

    const request: Extract<LiveUIActionRequest, { action: 'click' }> = {
      action: 'click',
      traceId: 'trace-click-native-locator-ambiguous',
      target: {
        tabId: 7,
        locator: {
          scope: 'buttons',
          steps: [
            {
              kind: 'role',
              role: 'button',
              name: 'Save',
              exact: true,
            },
          ],
        },
      },
    };

    const result = await executeNativeClickAction({
      request,
      tab: {
        id: 7,
        url: 'https://example.com/settings',
      } as chrome.tabs.Tab & { id: number },
      startedAt: 1000,
      traceId: 'trace-click-native-locator-ambiguous',
    });

    expect(result.status).toBe('rejected');
    expect(result.failureReason?.code).toBe('target_locator_ambiguous');
    expect(result.result).toMatchObject({
      backend: nativeAutomationBackend,
      locatorResolution: {
        strategy: 'native_locator',
        matchedCandidateCount: 2,
        sampledCandidates: [
          { selector: '#save-a' },
          { selector: '#save-b' },
        ],
      },
    });
    expect(attach).not.toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('translates same-origin frame click coordinates before CDP dispatch', async () => {
    const chromeMock = installChromeMock([
      {
        ...targetSnapshot,
        frameId: 3,
      },
      {
        x: 100,
        y: 200,
      },
    ]);
    const request: Extract<LiveUIActionRequest, { action: 'click' }> = {
      action: 'click',
      traceId: 'trace-click-frame-native',
      target: {
        selector: '#save',
        tabId: 7,
        frameId: 3,
      },
    };

    const result = await executeNativeClickAction({
      request,
      tab: {
        id: 7,
        url: 'https://example.com/settings',
      } as chrome.tabs.Tab & { id: number },
      startedAt: 1000,
      traceId: 'trace-click-frame-native',
    });

    expect(result.status).toBe('succeeded');
    expect(result.target.frameId).toBe(3);
    expect(result.result).toMatchObject({
      backend: nativeAutomationBackend,
      point: {
        x: 142,
        y: 224,
      },
      pointCoordinateSpace: 'translated-frame',
      actionability: {
        frameCoordinateResolved: true,
      },
    });
    expect(chromeMock.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: {
          tabId: 7,
          frameIds: [3],
        },
      }),
    );
    expect(chromeMock.sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.dispatchMouseEvent',
      expect.objectContaining({
        type: 'mousePressed',
        x: 142,
        y: 224,
      }),
    );
  });

  it('dispatches native CDP mouse move events for hover actions', async () => {
    const chromeMock = installChromeMock();
    const request: Extract<LiveUIActionRequest, { action: 'hover' }> = {
      action: 'hover',
      traceId: 'trace-hover-native',
      target: {
        selector: '#save',
        tabId: 7,
      },
    };

    const result = await executeNativeHoverAction({
      request,
      tab: {
        id: 7,
        url: 'https://example.com/settings',
      } as chrome.tabs.Tab & { id: number },
      startedAt: 1000,
      traceId: 'trace-hover-native',
    });

    expect(result.status).toBe('succeeded');
    expect(result.result).toMatchObject({
      backend: nativeAutomationBackend,
      point: {
        x: 42,
        y: 24,
      },
    });
    expect(chromeMock.sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.dispatchMouseEvent',
      expect.objectContaining({
        type: 'mouseMoved',
        x: 42,
        y: 24,
      }),
    );
  });

  it('dispatches coordinate hover targets directly in the top document', async () => {
    const chromeMock = installChromeMock({
      url: 'https://example.com/settings',
      inViewport: true,
      point: {
        x: 144,
        y: 96,
      },
      viewportRect: {
        x: 0,
        y: 0,
        width: 1280,
        height: 720,
      },
      hitTargetSelector: '#docs-secondary',
      hitTargetTagName: 'a',
      hitTargetTextPreview: 'Docs',
    });
    const request: Extract<LiveUIActionRequest, { action: 'hover' }> = {
      action: 'hover',
      traceId: 'trace-hover-coordinate-native',
      target: {
        tabId: 7,
        coordinates: {
          x: 144,
          y: 96,
        },
      },
    };

    const result = await executeNativeHoverAction({
      request,
      tab: {
        id: 7,
        url: 'https://example.com/settings',
      } as chrome.tabs.Tab & { id: number },
      startedAt: 1000,
      traceId: 'trace-hover-coordinate-native',
    });

    expect(result.status).toBe('succeeded');
    expect(result.result).toMatchObject({
      backend: nativeAutomationBackend,
      point: {
        x: 144,
        y: 96,
      },
      pointCoordinateSpace: 'top-document',
      coordinateTarget: true,
    });
    expect(chromeMock.sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.dispatchMouseEvent',
      expect.objectContaining({
        type: 'mouseMoved',
        x: 144,
        y: 96,
      }),
    );
  });

  it('rejects non-actionable native click targets before dispatch', async () => {
    const chromeMock = installChromeMock({
      ...targetSnapshot,
      actionability: {
        ...targetSnapshot.actionability,
        enabled: false,
        failureCode: 'target_disabled',
        failureMessage: 'The native click target is disabled.',
      },
    });
    const request: Extract<LiveUIActionRequest, { action: 'click' }> = {
      action: 'click',
      traceId: 'trace-click-disabled',
      target: {
        selector: '#save',
        tabId: 7,
      },
    };

    const result = await executeNativeClickAction({
      request,
      tab: {
        id: 7,
        url: 'https://example.com/settings',
      } as chrome.tabs.Tab & { id: number },
      startedAt: 1000,
      traceId: 'trace-click-disabled',
    });

    expect(result.status).toBe('rejected');
    expect(result.failureReason?.code).toBe('target_disabled');
    expect(result.result).toMatchObject({
      backend: nativeAutomationBackend,
      actionability: {
        enabled: false,
      },
    });
    expect(chromeMock.attach).not.toHaveBeenCalled();
    expect(chromeMock.sendCommand).not.toHaveBeenCalled();
  });

  it('returns zero-size diagnostics for geometry failures', async () => {
    const chromeMock = installChromeMock({
      ...targetSnapshot,
      actionability: {
        ...targetSnapshot.actionability,
        visible: false,
        failureCode: 'zero_size_target',
        failureMessage: 'The native click target has zero size.',
        boundingRect: {
          x: 20,
          y: 12,
          width: 0,
          height: 0,
        },
        intersectionRect: {
          x: 20,
          y: 12,
          width: 0,
          height: 0,
        },
        viewportRect: {
          x: 0,
          y: 0,
          width: 1280,
          height: 720,
        },
      },
    });
    const request: Extract<LiveUIActionRequest, { action: 'click' }> = {
      action: 'click',
      traceId: 'trace-click-zero-size',
      target: {
        selector: '#zero-size-action',
        tabId: 7,
      },
    };

    const result = await executeNativeClickAction({
      request,
      tab: {
        id: 7,
        url: 'https://example.com/settings',
      } as chrome.tabs.Tab & { id: number },
      startedAt: 1000,
      traceId: 'trace-click-zero-size',
    });

    expect(result.status).toBe('rejected');
    expect(result.failureReason?.code).toBe('zero_size_target');
    expect(result.result).toMatchObject({
      backend: nativeAutomationBackend,
      actionability: {
        failureCode: 'zero_size_target',
        boundingRect: {
          width: 0,
          height: 0,
        },
      },
    });
    expect(chromeMock.sendCommand).not.toHaveBeenCalled();
  });

  it('returns explicit diagnostics for closed shadow root selectors', async () => {
    const chromeMock = installChromeMock({
      ...targetSnapshot,
      matched: false,
      selector: '#closed-shadow-host >> #closed-shadow-action',
      resolvedSelector: '#closed-shadow-host >> #closed-shadow-action',
      actionability: {
        ...targetSnapshot.actionability,
        visible: false,
        failureCode: 'closed_shadow_root_unsupported',
        failureMessage: 'The target selector requires traversing a closed or inaccessible shadow root, which native automation does not support.',
      },
    });
    const request: Extract<LiveUIActionRequest, { action: 'click' }> = {
      action: 'click',
      traceId: 'trace-click-closed-shadow',
      target: {
        selector: '#closed-shadow-host >> #closed-shadow-action',
        tabId: 7,
      },
    };

    const result = await executeNativeClickAction({
      request,
      tab: {
        id: 7,
        url: 'https://example.com/settings',
      } as chrome.tabs.Tab & { id: number },
      startedAt: 1000,
      traceId: 'trace-click-closed-shadow',
    });

    expect(result.status).toBe('rejected');
    expect(result.failureReason?.code).toBe('closed_shadow_root_unsupported');
    expect(result.result).toMatchObject({
      backend: nativeAutomationBackend,
      actionability: {
        failureCode: 'closed_shadow_root_unsupported',
      },
    });
    expect(chromeMock.sendCommand).not.toHaveBeenCalled();
  });

  it('retries transient actionability failures before dispatch', async () => {
    const chromeMock = installChromeMock([
      {
        ...targetSnapshot,
        actionability: {
          ...targetSnapshot.actionability,
          stable: false,
          failureCode: 'target_not_stable',
          failureMessage: 'The native click target layout did not stabilize before the action.',
        },
      },
      targetSnapshot,
    ]);
    const request: Extract<LiveUIActionRequest, { action: 'click' }> = {
      action: 'click',
      traceId: 'trace-click-retry',
      target: {
        selector: '#save',
        tabId: 7,
      },
    };

    const result = await executeNativeClickAction({
      request,
      tab: {
        id: 7,
        url: 'https://example.com/settings',
      } as chrome.tabs.Tab & { id: number },
      startedAt: 1000,
      traceId: 'trace-click-retry',
    });

    expect(result.status).toBe('succeeded');
    expect(result.result?.actionability).toMatchObject({
      attempts: 2,
    });
    expect(chromeMock.executeScript).toHaveBeenCalledTimes(2);
    expect(chromeMock.sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.dispatchMouseEvent',
      expect.objectContaining({
        type: 'mousePressed',
      }),
    );
  });

  it('retries detached native targets after scroll-time replacement', async () => {
    const chromeMock = installChromeMock([
      {
        ...targetSnapshot,
        actionability: {
          ...targetSnapshot.actionability,
          scrolledIntoView: true,
          failureCode: 'target_detached',
          failureMessage: 'The native click target detached while scrolling into view.',
        },
      },
      targetSnapshot,
    ]);
    const request: Extract<LiveUIActionRequest, { action: 'click' }> = {
      action: 'click',
      traceId: 'trace-click-detached-retry',
      target: {
        selector: '#save',
        tabId: 7,
      },
    };

    const result = await executeNativeClickAction({
      request,
      tab: {
        id: 7,
        url: 'https://example.com/settings',
      } as chrome.tabs.Tab & { id: number },
      startedAt: 1000,
      traceId: 'trace-click-detached-retry',
    });

    expect(result.status).toBe('succeeded');
    expect(result.result?.actionability).toMatchObject({
      attempts: 2,
      retryCount: 1,
      retriedAfterDetach: true,
      previousFailureCode: 'target_detached',
    });
    expect(chromeMock.executeScript).toHaveBeenCalledTimes(2);
    expect(chromeMock.sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.dispatchMouseEvent',
      expect.objectContaining({
        type: 'mousePressed',
      }),
    );
  });

  it('recovers stale frame refs by resolving the selector against frame metadata', async () => {
    const attach = vi.fn(async () => undefined);
    const detach = vi.fn(async () => undefined);
    const sendCommand = vi.fn(async () => ({}));
    const executeScript = vi
      .fn()
      .mockResolvedValueOnce([
        {
          frameId: 0,
          result: {
            matched: false,
            url: 'https://example.com/settings',
            title: 'Settings',
          },
        },
        {
          frameId: 4,
          result: {
            matched: false,
            url: 'https://example.com/frame',
            title: 'Frame',
            selector: '#child-frame',
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          result: {
            ...targetSnapshot,
            frameId: 4,
            url: 'https://example.com/frame',
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          result: {
            x: 100,
            y: 200,
          },
        },
      ]);

    vi.stubGlobal('chrome', {
      scripting: {
        executeScript,
      },
      debugger: {
        attach,
        detach,
        sendCommand,
      },
    });

    const request: Extract<LiveUIActionRequest, { action: 'click' }> = {
      action: 'click',
      traceId: 'trace-click-stale-frame-ref',
      target: {
        elementRef: encodeElementRef({
          selector: '#save',
          frameId: 99,
          frameUrl: 'https://example.com/frame',
          frameTitle: 'Frame',
          frameSelector: '#child-frame',
        }),
        tabId: 7,
      },
    };

    const result = await executeNativeClickAction({
      request,
      tab: {
        id: 7,
        url: 'https://example.com/settings',
      } as chrome.tabs.Tab & { id: number },
      startedAt: 1000,
      traceId: 'trace-click-stale-frame-ref',
    });

    expect(result.status).toBe('succeeded');
    expect(result.target.frameId).toBe(4);
    expect(result.result).toMatchObject({
      backend: nativeAutomationBackend,
      point: {
        x: 142,
        y: 224,
      },
      actionability: {
        frameRefreshed: true,
        previousFrameId: 99,
        frameCoordinateResolved: true,
      },
      frameResolution: {
        selectedBy: 'frame_context',
        matched: {
          frameId: 4,
          frameSelector: '#child-frame',
        },
      },
    });
    expect(executeScript).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        target: {
          tabId: 7,
          allFrames: true,
        },
      }),
    );
  });

  it('returns frame ambiguity diagnostics before dispatch when multiple frames match the frame locator', async () => {
    const attach = vi.fn(async () => undefined);
    const detach = vi.fn(async () => undefined);
    const sendCommand = vi.fn(async () => ({}));
    const executeScript = vi.fn(async () => [
      {
        frameId: 0,
        result: {
          matched: false,
          url: 'https://example.com/settings',
          title: 'Settings',
        },
      },
      {
        frameId: 4,
        result: {
          matched: true,
          selector: '#ambiguous-frame-a',
          url: 'about:srcdoc',
          title: 'Ambiguous Frame',
        },
      },
      {
        frameId: 5,
        result: {
          matched: true,
          selector: '#ambiguous-frame-b',
          url: 'about:srcdoc',
          title: 'Ambiguous Frame',
        },
      },
    ]);

    vi.stubGlobal('chrome', {
      scripting: {
        executeScript,
      },
      debugger: {
        attach,
        detach,
        sendCommand,
      },
    });

    const request: Extract<LiveUIActionRequest, { action: 'click' }> = {
      action: 'click',
      traceId: 'trace-click-frame-ambiguous',
      target: {
        selector: '#ambiguous-frame-action',
        frameTitleContains: 'Ambiguous Frame',
        tabId: 7,
      },
    };

    const result = await executeNativeClickAction({
      request,
      tab: {
        id: 7,
        url: 'https://example.com/settings',
      } as chrome.tabs.Tab & { id: number },
      startedAt: 1000,
      traceId: 'trace-click-frame-ambiguous',
    });

    expect(result.status).toBe('rejected');
    expect(result.failureReason?.code).toBe('frame_target_ambiguous');
    expect(result.result).toMatchObject({
      backend: nativeAutomationBackend,
      frameResolution: {
        strategy: 'frame_context',
        frameContextCandidateCount: 2,
        selectorMatchedCandidateCount: 2,
        matchedCandidateCount: 2,
        selectedBy: 'target_selector',
        sampledCandidates: [
          { frameId: 4, frameSelector: '#ambiguous-frame-a' },
          { frameId: 5, frameSelector: '#ambiguous-frame-b' },
        ],
      },
    });
    expect(attach).not.toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('returns explicit frame policy when native pointer coordinates cannot be mapped', async () => {
    const chromeMock = installChromeMock([
      {
        ...targetSnapshot,
        frameId: 4,
        url: 'https://third.example/frame',
        framePolicy: {
          frameId: 4,
          url: 'https://third.example/frame',
          origin: 'https://third.example',
          topAccessible: false,
          sameOriginWithTop: false,
          isOpaqueOrigin: false,
          pointerActionsSupported: false,
          unsupportedReason: 'cross_origin_with_top',
        },
        actionability: {
          ...targetSnapshot.actionability,
          frameCoordinateResolved: false,
        },
      },
      null,
    ]);
    const request: Extract<LiveUIActionRequest, { action: 'click' }> = {
      action: 'click',
      traceId: 'trace-click-cross-origin-frame',
      target: {
        selector: '#save',
        tabId: 7,
        frameId: 4,
      },
    };

    const result = await executeNativeClickAction({
      request,
      tab: {
        id: 7,
        url: 'https://example.com/settings',
      } as chrome.tabs.Tab & { id: number },
      startedAt: 1000,
      traceId: 'trace-click-cross-origin-frame',
    });

    expect(result.status).toBe('rejected');
    expect(result.failureReason?.code).toBe('unsupported_cross_origin_frame');
    expect(result.result).toMatchObject({
      backend: nativeAutomationBackend,
      framePolicy: {
        pointerActionsSupported: false,
        unsupportedReason: 'cross_origin_with_top',
      },
      actionability: {
        frameCoordinateResolved: false,
      },
    });
    expect(chromeMock.attach).not.toHaveBeenCalled();
    expect(chromeMock.sendCommand).not.toHaveBeenCalled();
  });

  it('uses native text insertion for input actions', async () => {
    const chromeMock = installChromeMock([
      targetSnapshot,
      { fieldType: 'text', valueLength: 3 },
      12,
    ]);
    const request: Extract<LiveUIActionRequest, { action: 'input' }> = {
      action: 'input',
      traceId: 'trace-input-native',
      target: {
        selector: '#name',
        tabId: 7,
      },
      input: {
        value: 'Ada Lovelace',
      },
    };

    const result = await executeNativeInputAction({
      request,
      tab: {
        id: 7,
        url: 'https://example.com/settings',
      } as chrome.tabs.Tab & { id: number },
      startedAt: 1000,
      traceId: 'trace-input-native',
    });

    expect(result.status).toBe('succeeded');
    expect(result.result).toMatchObject({
      backend: nativeAutomationBackend,
      fieldType: 'text',
      previousValueLength: 3,
      valueLength: 12,
    });
    expect(chromeMock.sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.insertText',
      { text: 'Ada Lovelace' },
    );
  });

  it('runs native input helpers inside the requested frame', async () => {
    const chromeMock = installChromeMock([
      {
        ...targetSnapshot,
        frameId: 4,
      },
      { fieldType: 'text', valueLength: 0 },
      5,
    ]);
    const request: Extract<LiveUIActionRequest, { action: 'input' }> = {
      action: 'input',
      traceId: 'trace-input-frame-native',
      target: {
        selector: '#name',
        tabId: 7,
        frameId: 4,
      },
      input: {
        value: 'Frame',
      },
    };

    const result = await executeNativeInputAction({
      request,
      tab: {
        id: 7,
        url: 'https://example.com/settings',
      } as chrome.tabs.Tab & { id: number },
      startedAt: 1000,
      traceId: 'trace-input-frame-native',
    });

    expect(result.status).toBe('succeeded');
    expect(result.target.frameId).toBe(4);
    expect(chromeMock.executeScript).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        target: {
          tabId: 7,
          frameIds: [4],
        },
      }),
    );
    expect(chromeMock.executeScript).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: {
          tabId: 7,
          frameIds: [4],
        },
      }),
    );
    expect(chromeMock.executeScript).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        target: {
          tabId: 7,
          frameIds: [4],
        },
      }),
    );
  });

  it('rejects readonly native input targets before text dispatch', async () => {
    const chromeMock = installChromeMock([
      targetSnapshot,
      new Error('target_readonly: Native input target is read-only.'),
    ]);
    const request: Extract<LiveUIActionRequest, { action: 'input' }> = {
      action: 'input',
      traceId: 'trace-input-readonly',
      target: {
        selector: '#name',
        tabId: 7,
      },
      input: {
        value: 'Ada',
      },
    };

    const result = await executeNativeInputAction({
      request,
      tab: {
        id: 7,
        url: 'https://example.com/settings',
      } as chrome.tabs.Tab & { id: number },
      startedAt: 1000,
      traceId: 'trace-input-readonly',
    });

    expect(result.status).toBe('rejected');
    expect(result.failureReason?.code).toBe('target_readonly');
    expect(chromeMock.attach).not.toHaveBeenCalled();
    expect(chromeMock.sendCommand).not.toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.insertText',
      expect.anything(),
    );
  });

  it('dispatches native key events for press_key actions', async () => {
    const chromeMock = installChromeMock();
    const request: Extract<LiveUIActionRequest, { action: 'press_key' }> = {
      action: 'press_key',
      traceId: 'trace-key-native',
      input: {
        key: 'Enter',
      },
    };

    const result = await executeNativePressKeyAction({
      request,
      tab: {
        id: 7,
        url: 'https://example.com/settings',
      } as chrome.tabs.Tab & { id: number },
      startedAt: 1000,
      traceId: 'trace-key-native',
    });

    expect(result.status).toBe('succeeded');
    expect(result.result).toMatchObject({
      backend: nativeAutomationBackend,
      key: 'Enter',
    });
    expect(chromeMock.sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.dispatchKeyEvent',
      expect.objectContaining({
        type: 'rawKeyDown',
        key: 'Enter',
      }),
    );
    expect(chromeMock.sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.dispatchKeyEvent',
      expect.objectContaining({
        type: 'keyUp',
        key: 'Enter',
      }),
    );
  });

  it('focuses and blurs native targets through the page context', async () => {
    const chromeMock = installChromeMock([
      targetSnapshot,
      { focused: true },
      targetSnapshot,
      { blurred: true },
    ]);
    const tab = {
      id: 7,
      url: 'https://example.com/settings',
    } as chrome.tabs.Tab & { id: number };

    const focusRequest: Extract<LiveUIActionRequest, { action: 'focus' }> = {
      action: 'focus',
      traceId: 'trace-focus-native',
      target: {
        selector: '#save',
        tabId: 7,
      },
    };
    const blurRequest: Extract<LiveUIActionRequest, { action: 'blur' }> = {
      action: 'blur',
      traceId: 'trace-blur-native',
      target: {
        selector: '#save',
        tabId: 7,
      },
    };

    const focus = await executeNativeFocusAction({
      request: focusRequest,
      tab,
      startedAt: 1000,
      traceId: 'trace-focus-native',
    });
    const blur = await executeNativeBlurAction({
      request: blurRequest,
      tab,
      startedAt: 1100,
      traceId: 'trace-blur-native',
    });

    expect(focus.status).toBe('succeeded');
    expect(focus.result).toMatchObject({
      backend: nativeAutomationBackend,
      focused: true,
    });
    expect(blur.status).toBe('succeeded');
    expect(blur.result).toMatchObject({
      backend: nativeAutomationBackend,
      blurred: true,
    });
    expect(chromeMock.executeScript).toHaveBeenCalledTimes(4);
  });

  it('scrolls native targets through the page context', async () => {
    const chromeMock = installChromeMock([
      targetSnapshot,
      {
        scrollTarget: '#save',
        x: 0,
        y: 120,
        behavior: 'auto',
      },
    ]);
    const request: Extract<LiveUIActionRequest, { action: 'scroll' }> = {
      action: 'scroll',
      traceId: 'trace-scroll-native',
      target: {
        selector: '#save',
        tabId: 7,
      },
      input: {
        y: 120,
      },
    };

    const result = await executeNativeScrollAction({
      request,
      tab: {
        id: 7,
        url: 'https://example.com/settings',
      } as chrome.tabs.Tab & { id: number },
      startedAt: 1000,
      traceId: 'trace-scroll-native',
    });

    expect(result.status).toBe('succeeded');
    expect(result.result).toMatchObject({
      backend: nativeAutomationBackend,
      scrollTarget: '#save',
      y: 120,
      behavior: 'auto',
    });
    expect(chromeMock.executeScript).toHaveBeenCalledTimes(2);
  });

  it('submits native targets through the page context', async () => {
    const chromeMock = installChromeMock([
      targetSnapshot,
      {
        submitted: true,
        method: 'post',
        action: 'https://example.com/settings',
      },
    ]);
    const request: Extract<LiveUIActionRequest, { action: 'submit' }> = {
      action: 'submit',
      traceId: 'trace-submit-native',
      target: {
        selector: '#save',
        tabId: 7,
      },
    };

    const result = await executeNativeSubmitAction({
      request,
      tab: {
        id: 7,
        url: 'https://example.com/settings',
      } as chrome.tabs.Tab & { id: number },
      startedAt: 1000,
      traceId: 'trace-submit-native',
    });

    expect(result.status).toBe('succeeded');
    expect(result.result).toMatchObject({
      backend: nativeAutomationBackend,
      submitted: true,
      method: 'post',
    });
    expect(chromeMock.executeScript).toHaveBeenCalledTimes(2);
  });
});
