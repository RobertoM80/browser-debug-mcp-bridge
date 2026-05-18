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

  it('parses semantic live UI action targets', () => {
    const parsed = LiveUIActionRequestSchema.parse({
      action: 'hover',
      target: {
        scope: 'links',
        role: 'link',
        name: 'Docs',
        exact: true,
        last: true,
        strict: false,
        frameUrlContains: '/embedded',
      },
    });

    expect(parsed.action).toBe('hover');
    expect(parsed.target?.scope).toBe('links');
    expect(parsed.target?.name).toBe('Docs');
    expect(parsed.target?.last).toBe(true);
    expect(parsed.target?.strict).toBe(false);
    expect(parsed.target?.frameUrlContains).toBe('/embedded');
  });

  it('parses chained locator live UI action targets', () => {
    const parsed = LiveUIActionRequestSchema.parse({
      action: 'click',
      target: {
        locator: {
          scope: 'buttons',
          frame: {
            titleContains: 'Account',
          },
          steps: [
            {
              kind: 'role',
              role: 'button',
              name: {
                pattern: '^Save',
                flags: 'i',
              },
            },
            {
              kind: 'text',
              value: 'Save changes',
              exact: true,
            },
          ],
        },
      },
    });

    expect(parsed.target?.locator?.scope).toBe('buttons');
    expect(parsed.target?.locator?.steps).toHaveLength(2);
    expect(parsed.target?.locator?.steps[0]?.kind).toBe('role');
  });

  it('rejects incomplete locator steps', () => {
    expect(() => LiveUIActionRequestSchema.parse({
      action: 'click',
      target: {
        locator: {
          steps: [
            {
              kind: 'text',
            },
          ],
        },
      },
    })).toThrow('text locator step requires value');
  });

  it('rejects conflicting target position helpers', () => {
    expect(() => LiveUIActionRequestSchema.parse({
      action: 'click',
      target: {
        scope: 'buttons',
        nth: 0,
        first: true,
      },
    })).toThrow('target can use only one of nth, first, or last');
  });

  it('creates readable trace ids', () => {
    expect(createLiveUIActionTraceId()).toMatch(/^uiaction-\d+-[a-z0-9]+$/);
  });
});
