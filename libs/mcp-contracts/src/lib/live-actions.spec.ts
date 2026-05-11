import { describe, expect, it } from 'vitest';
import {
  LiveUIActionRequestSchema,
  LiveUIActionResultSchema,
  createLiveUIActionTraceId,
} from './live-actions';

describe('live-actions', () => {
  it('parses typed live UI action payloads', () => {
    const parsed = LiveUIActionRequestSchema.parse({
      action: 'input',
      traceId: 'trace-1',
      target: {
        selector: '#email',
        tabId: 7,
        frameId: 0,
      },
      input: {
        value: 'hello@example.com',
      },
    });

    expect(parsed.action).toBe('input');
    expect(parsed.input).toMatchObject({ value: 'hello@example.com' });
    expect(parsed.target?.tabId).toBe(7);
  });

  it('validates structured action results', () => {
    const parsed = LiveUIActionResultSchema.parse({
      action: 'click',
      traceId: 'trace-2',
      status: 'rejected',
      executionScope: 'top-document-v1',
      startedAt: 1700000000000,
      finishedAt: 1700000000001,
      target: {
        matched: false,
        selector: '#buy-now',
        frameId: 0,
      },
      failureReason: {
        code: 'action_not_implemented',
        message: 'Execution is not implemented yet.',
      },
    });

    expect(parsed.failureReason?.code).toBe('action_not_implemented');
    expect(parsed.target.matched).toBe(false);
  });

  it('creates readable trace ids', () => {
    expect(createLiveUIActionTraceId()).toMatch(/^uiaction-\d+-[a-z0-9]+$/);
  });
});
