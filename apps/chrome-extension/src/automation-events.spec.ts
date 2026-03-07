import { describe, expect, it } from 'vitest';
import type { LiveUIActionRequest, LiveUIActionResult } from '../../../libs/mcp-contracts/src';
import { buildAutomationEventPayload, buildAutomationStoppedPayload } from './automation-events';

describe('automation event payloads', () => {
  it('redacts input values while keeping useful automation metadata', () => {
    const request: LiveUIActionRequest = {
      action: 'input',
      traceId: 'trace-input-1',
      target: {
        selector: '#email',
        tabId: 9,
        frameId: 0,
        url: 'https://example.com/form',
      },
      input: {
        value: 'secret@example.com',
      },
    };
    const result: LiveUIActionResult = {
      action: 'input',
      traceId: 'trace-input-1',
      status: 'succeeded',
      executionScope: 'top-document-v1',
      startedAt: 1000,
      finishedAt: 1015,
      target: {
        matched: true,
        selector: '#email',
        resolvedSelector: '#email',
        tagName: 'input',
        frameId: 0,
        tabId: 9,
        url: 'https://example.com/form',
      },
      result: {
        fieldType: 'email',
        valueLength: 18,
      },
    };

    const payload = buildAutomationEventPayload({
      eventType: 'automation_succeeded',
      request,
      startedAt: 1000,
      result,
      tabId: 9,
      url: 'https://example.com/form',
      timestamp: 1015,
    });

    expect(payload).toMatchObject({
      eventType: 'automation_succeeded',
      action: 'input',
      traceId: 'trace-input-1',
      selector: '#email',
      status: 'succeeded',
      input: {
        fieldType: 'email',
        valueLength: 18,
        sensitive: true,
      },
      redaction: {
        inputValueRedacted: true,
        sensitiveTarget: true,
      },
    });
    expect((payload.input as Record<string, unknown>).value).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('secret@example.com');
  });

  it('records emergency-stop automation events', () => {
    const payload = buildAutomationStoppedPayload({
      action: 'click',
      traceId: 'trace-stop-1',
      sessionId: 'sess-1',
      tabId: 4,
      url: 'https://example.com',
      reason: 'emergency_stop',
      timestamp: 2000,
    });

    expect(payload).toMatchObject({
      eventType: 'automation_stopped',
      action: 'click',
      traceId: 'trace-stop-1',
      sessionId: 'sess-1',
      status: 'stopped',
      stopReason: 'emergency_stop',
      target: {
        matched: false,
        tabId: 4,
        url: 'https://example.com',
      },
    });
  });
});
