import { describe, expect, it } from 'vitest';
import {
  RunUIStepsSchema,
  createUIWorkflowTraceId,
} from './ui-workflows';

describe('ui-workflows', () => {
  it('parses a safe workflow with action, wait, and assert steps', () => {
    const parsed = RunUIStepsSchema.parse({
      sessionId: 'sess_123',
      mode: 'safe',
      stopOnFailure: true,
      steps: [
        {
          kind: 'action',
          id: 'build-targets',
          action: 'click',
          target: {
            scope: 'buttons',
            textContains: 'Build targets',
          },
        },
        {
          kind: 'waitFor',
          id: 'wait-week',
          matcher: {
            scope: 'buttons',
            textContains: 'Generate 7-day plan',
            timeoutMs: 5000,
          },
        },
        {
          kind: 'assert',
          id: 'assert-week',
          matcher: {
            scope: 'buttons',
            textContains: 'Generate 7-day plan',
          },
        },
      ],
    });

    expect(parsed.steps).toHaveLength(3);
    expect(parsed.steps[0]?.kind).toBe('action');
    expect(parsed.steps[1]?.kind).toBe('waitFor');
    expect(parsed.steps[2]?.kind).toBe('assert');
  });

  it('parses fast mode workflows', () => {
    const parsed = RunUIStepsSchema.parse({
      sessionId: 'sess_123',
      mode: 'fast',
      steps: [
        {
          kind: 'action',
          action: 'click',
          target: {
            selector: '#continue',
          },
        },
      ],
    });

    expect(parsed.mode).toBe('fast');
  });

  it('parses first-class wait steps including navigation and request/response waits', () => {
    const parsed = RunUIStepsSchema.parse({
      sessionId: 'sess_123',
      steps: [
        {
          kind: 'wait',
          id: 'wait-route',
          wait: {
            waitKind: 'navigation',
            urlContains: '/dashboard',
            fromUrlContains: '/login',
            trigger: 'pushState',
            tabId: 4,
            timeoutMs: 5000,
          },
        },
        {
          kind: 'wait',
          id: 'wait-selector',
          wait: {
            waitKind: 'selector_state',
            selector: '#ready',
          },
        },
        {
          kind: 'wait',
          id: 'wait-api-request',
          wait: {
            waitKind: 'request',
            urlContains: '/api/session',
            method: 'POST',
            initiator: 'fetch',
          },
        },
        {
          kind: 'wait',
          id: 'wait-api-response',
          wait: {
            waitKind: 'response',
            urlContains: '/api/session',
            statusGte: 200,
            statusLt: 300,
            responseContentType: 'application/json',
          },
        },
      ],
    });

    expect(parsed.steps.map((step) => step.kind)).toEqual(['wait', 'wait', 'wait', 'wait']);
    const selectorStep = parsed.steps[1];
    expect(selectorStep.kind).toBe('wait');
    if (selectorStep.kind === 'wait') {
      expect(selectorStep.wait.waitKind).toBe('selector_state');
      if (selectorStep.wait.waitKind === 'selector_state') {
        expect(selectorStep.wait.frameId).toBe(0);
      }
    }
  });

  it('rejects under-specified first-class wait steps', () => {
    expect(() => RunUIStepsSchema.parse({
      sessionId: 'sess_123',
      steps: [
        {
          kind: 'wait',
          wait: {
            waitKind: 'request',
          },
        },
      ],
    })).toThrow('request wait requires urlContains, urlRegex, exactUrl, or traceId');

    expect(() => RunUIStepsSchema.parse({
      sessionId: 'sess_123',
      steps: [
        {
          kind: 'wait',
          wait: {
            waitKind: 'response',
            urlContains: '/api/session',
            statusGte: 300,
            statusLt: 200,
          },
        },
      ],
    })).toThrow('statusGte must be less than statusLt');
  });

  it('parses per-step failure policies', () => {
    const parsed = RunUIStepsSchema.parse({
      sessionId: 'sess_123',
      steps: [
        {
          kind: 'action',
          action: 'click',
          target: {
            selector: '#continue',
          },
          onFailure: {
            strategy: 'retry_once',
            capture: {
              enabled: true,
              mode: 'dom',
            },
          },
        },
      ],
    });

    const step = parsed.steps[0];
    expect(step.onFailure?.strategy).toBe('retry_once');
    expect(step.onFailure?.capture?.enabled).toBe(true);
  });

  it('accepts richer semantic action target matchers', () => {
    const parsed = RunUIStepsSchema.parse({
      sessionId: 'sess_123',
      steps: [
        {
          kind: 'action',
          action: 'input',
          target: {
            scope: 'inputs',
            labelContains: 'Email',
            frameTitleContains: 'Account iframe',
            tagName: 'input',
            type: 'text',
            first: true,
            readOnly: false,
          },
          input: {
            value: 'person@example.com',
          },
        },
      ],
    });

    const step = parsed.steps[0];
    expect(step.kind).toBe('action');
    if (step.kind === 'action') {
      expect(step.target?.labelContains).toBe('Email');
      expect(step.target?.frameTitleContains).toBe('Account iframe');
      expect(step.target?.first).toBe(true);
      expect(step.target?.tagName).toBe('input');
    }
  });

  it('accepts chained locator action targets', () => {
    const parsed = RunUIStepsSchema.parse({
      sessionId: 'sess_123',
      steps: [
        {
          kind: 'action',
          action: 'click',
          target: {
            locator: {
              scope: 'buttons',
              frame: {
                urlContains: '/account',
              },
              steps: [
                {
                  kind: 'role',
                  role: 'button',
                  name: 'Save',
                },
                {
                  kind: 'text',
                  value: {
                    pattern: 'changes$',
                    flags: 'i',
                  },
                },
              ],
            },
          },
        },
      ],
    });

    const step = parsed.steps[0];
    expect(step.kind).toBe('action');
    if (step.kind === 'action') {
      expect(step.target?.locator?.scope).toBe('buttons');
      expect(step.target?.locator?.steps).toHaveLength(2);
    }
  });

  it('rejects incomplete workflow locator steps', () => {
    expect(() => RunUIStepsSchema.parse({
      sessionId: 'sess_123',
      steps: [
        {
          kind: 'action',
          action: 'click',
          target: {
            locator: {
              steps: [
                {
                  kind: 'role',
                },
              ],
            },
          },
        },
      ],
    })).toThrow('role locator step requires role or value');
  });

  it('rejects conflicting action target position helpers', () => {
    expect(() => RunUIStepsSchema.parse({
      sessionId: 'sess_123',
      steps: [
        {
          kind: 'action',
          action: 'click',
          target: {
            scope: 'buttons',
            first: true,
            last: true,
          },
        },
      ],
    })).toThrow('target can use only one of nth, first, or last');
  });

  it('requires a usable action target matcher', () => {
    expect(() => RunUIStepsSchema.parse({
      sessionId: 'sess_123',
      steps: [
        {
          kind: 'action',
          action: 'click',
          target: {},
        },
      ],
    })).toThrow('target requires selector, elementRef, locator, scope, testId, textContains, labelContains, titleContains, role, name, placeholder, or altText');
  });

  it('creates readable workflow trace ids', () => {
    expect(createUIWorkflowTraceId()).toMatch(/^uiworkflow-\d+-[a-z0-9]+$/);
  });
});
