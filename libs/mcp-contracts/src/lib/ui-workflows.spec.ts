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

  it('parses descendant locator relations in workflow action targets', () => {
    const parsed = RunUIStepsSchema.parse({
      sessionId: 'sess_123',
      steps: [
        {
          kind: 'action',
          action: 'click',
          target: {
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
        },
      ],
    });

    const firstStep = parsed.steps[0];
    expect(firstStep?.kind).toBe('action');
    expect(firstStep?.target.locator?.steps[1]?.relation).toBe('descendant');
  });

  it('parses coordinate workflow action targets', () => {
    const parsed = RunUIStepsSchema.parse({
      sessionId: 'sess_123',
      steps: [
        {
          kind: 'action',
          action: 'click',
          target: {
            coordinates: {
              x: 220,
              y: 144,
            },
            tabId: 4,
          },
        },
      ],
    });

    const firstStep = parsed.steps[0];
    expect(firstStep?.kind).toBe('action');
    expect(firstStep?.target.coordinates).toEqual({
      x: 220,
      y: 144,
    });
  });

  it('parses ancestor locator relations in workflow action targets', () => {
    const parsed = RunUIStepsSchema.parse({
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
                  role: 'button',
                  name: 'Save',
                },
                {
                  kind: 'testId',
                  value: 'settings-panel',
                  relation: 'ancestor',
                },
              ],
            },
          },
        },
      ],
    });

    const firstStep = parsed.steps[0];
    expect(firstStep?.kind).toBe('action');
    expect(firstStep?.target.locator?.steps[1]?.relation).toBe('ancestor');
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
          id: 'wait-lifecycle',
          wait: {
            waitKind: 'navigation_lifecycle',
            state: 'network_idle',
            urlContains: '/dashboard',
            timeoutMs: 5000,
          },
        },
        {
          kind: 'wait',
          id: 'wait-load-state',
          wait: {
            waitKind: 'load_state',
            state: 'domcontentloaded',
            urlContains: '/dashboard',
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
          id: 'wait-dialog',
          wait: {
            waitKind: 'dialog',
            type: 'alert',
            messageContains: 'Saved',
            action: 'accept',
          },
        },
        {
          kind: 'wait',
          id: 'wait-download',
          wait: {
            waitKind: 'download',
            filenameContains: 'invoice',
            state: 'completed',
          },
        },
        {
          kind: 'wait',
          id: 'wait-popup',
          wait: {
            waitKind: 'popup',
            urlContains: '/oauth/callback',
          },
        },
        {
          kind: 'wait',
          id: 'wait-layout',
          wait: {
            waitKind: 'stable_layout',
            selector: '#ready',
            stableMs: 300,
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

    expect(parsed.steps.map((step) => step.kind)).toEqual(['wait', 'wait', 'wait', 'wait', 'wait', 'wait', 'wait', 'wait', 'wait', 'wait']);
    const selectorStep = parsed.steps[3];
    expect(selectorStep.kind).toBe('wait');
    if (selectorStep.kind === 'wait') {
      expect(selectorStep.wait.waitKind).toBe('selector_state');
      if (selectorStep.wait.waitKind === 'selector_state') {
        expect(selectorStep.wait.frameId).toBe(0);
      }
    }
    const dialogStep = parsed.steps[4];
    expect(dialogStep.kind).toBe('wait');
    if (dialogStep.kind === 'wait') {
      expect(dialogStep.wait.waitKind).toBe('dialog');
    }
    const lifecycleStep = parsed.steps[1];
    expect(lifecycleStep.kind).toBe('wait');
    if (lifecycleStep.kind === 'wait') {
      expect(lifecycleStep.wait.waitKind).toBe('navigation_lifecycle');
    }
    const downloadStep = parsed.steps[5];
    expect(downloadStep.kind).toBe('wait');
    if (downloadStep.kind === 'wait') {
      expect(downloadStep.wait.waitKind).toBe('download');
    }
    const popupStep = parsed.steps[6];
    expect(popupStep.kind).toBe('wait');
    if (popupStep.kind === 'wait') {
      expect(popupStep.wait.waitKind).toBe('popup');
    }
    const layoutStep = parsed.steps[7];
    expect(layoutStep.kind).toBe('wait');
    if (layoutStep.kind === 'wait') {
      expect(layoutStep.wait.waitKind).toBe('stable_layout');
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
            waitKind: 'download',
          },
        },
      ],
    })).toThrow('download wait requires a URL or filename predicate');

    expect(() => RunUIStepsSchema.parse({
      sessionId: 'sess_123',
      steps: [
        {
          kind: 'wait',
          wait: {
            waitKind: 'popup',
          },
        },
      ],
    })).toThrow('popup wait requires a URL predicate or openerTabId');

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
    })).toThrow('target requires selector, elementRef, coordinates, locator, scope, testId, textContains, labelContains, titleContains, role, name, placeholder, or altText');
  });

  it('creates readable workflow trace ids', () => {
    expect(createUIWorkflowTraceId()).toMatch(/^uiworkflow-\d+-[a-z0-9]+$/);
  });
});
