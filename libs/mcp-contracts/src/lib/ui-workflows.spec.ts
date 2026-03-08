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
            tagName: 'input',
            type: 'text',
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
      expect(step.target?.tagName).toBe('input');
    }
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
    })).toThrow('target requires selector, elementRef, testId, textContains, labelContains, or titleContains');
  });

  it('creates readable workflow trace ids', () => {
    expect(createUIWorkflowTraceId()).toMatch(/^uiworkflow-\d+-[a-z0-9]+$/);
  });
});
