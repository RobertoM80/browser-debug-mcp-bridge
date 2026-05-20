import { describe, expect, it, vi } from 'vitest';
import {
  WorkflowTargetResolutionError,
  hasSemanticActionTargetMatcher,
  resolveWorkflowActionTarget,
  type PageStateCaptureResult,
} from './target-resolution.js';

function pageState(payload: Record<string, unknown>): PageStateCaptureResult {
  return {
    limitsApplied: {
      maxResults: 100,
      truncated: false,
    },
    payload,
  };
}

describe('target resolution', () => {
  it('passes direct selectors through without capturing page state', async () => {
    const capturePageState = vi.fn();

    const resolved = await resolveWorkflowActionTarget('session-1', {
      selector: '#save',
      tabId: 9,
      frameId: 3,
    }, capturePageState);

    expect(capturePageState).not.toHaveBeenCalled();
    expect(resolved).toMatchObject({
      target: {
        selector: '#save',
        tabId: 9,
        frameId: 3,
      },
      resolution: {
        strategy: 'selector',
        matcher: {
          selector: '#save',
          frameId: 3,
        },
      },
    });
  });

  it('passes coordinate targets through without capturing page state', async () => {
    const capturePageState = vi.fn();

    const resolved = await resolveWorkflowActionTarget('session-1', {
      coordinates: {
        x: 320,
        y: 180,
      },
      tabId: 9,
    }, capturePageState);

    expect(capturePageState).not.toHaveBeenCalled();
    expect(resolved).toMatchObject({
      target: {
        coordinates: {
          x: 320,
          y: 180,
        },
        tabId: 9,
      },
      resolution: {
        strategy: 'coordinates',
        matcher: {
          coordinates: {
            x: 320,
            y: 180,
          },
        },
      },
    });
  });

  it('detects semantic targets that need page-state resolution', () => {
    expect(hasSemanticActionTargetMatcher(undefined)).toBe(false);
    expect(hasSemanticActionTargetMatcher({ selector: '#save', role: 'button' })).toBe(false);
    expect(hasSemanticActionTargetMatcher({ elementRef: 'ref-1', textContains: 'Save' })).toBe(false);
    expect(hasSemanticActionTargetMatcher({ role: 'button', name: 'Save' })).toBe(true);
    expect(hasSemanticActionTargetMatcher({ strict: false })).toBe(true);
    expect(hasSemanticActionTargetMatcher({
      locator: {
        steps: [{ kind: 'css', value: '#save' }],
      },
    })).toBe(true);
  });

  it('resolves scoped chained locators from compact page-state refs', async () => {
    const capturePageState = vi.fn().mockResolvedValue(pageState({
      buttons: [
        {
          elementRef: 'top-button-ref',
          selector: '#cancel',
          text: 'Cancel',
          role: 'button',
          name: 'Cancel',
        },
        {
          elementRef: 'frame-button-ref',
          selector: '#save',
          text: 'Save changes',
          role: 'button',
          name: 'Save changes',
          frameId: 42,
          frameUrl: 'https://example.test/settings',
          frameTitle: 'Settings panel',
        },
      ],
    }));

    const resolved = await resolveWorkflowActionTarget('session-1', {
      tabId: 7,
      locator: {
        scope: 'buttons',
        frame: {
          titleContains: 'Settings',
        },
        steps: [
          { kind: 'role', role: 'button', name: { pattern: '^Save', flags: 'i' } },
          { kind: 'text', value: 'Save changes', exact: true },
          { kind: 'css', value: '#save' },
        ],
      },
    }, capturePageState);

    expect(capturePageState).toHaveBeenCalledWith('session-1', {
      includeButtons: true,
      includeLinks: false,
      includeInputs: false,
      includeModals: false,
      maxItems: 100,
      maxTextLength: 120,
    });
    expect(resolved).toMatchObject({
      target: {
        elementRef: 'frame-button-ref',
        selector: '#save',
        tabId: 7,
        frameId: 42,
      },
      resolution: {
        strategy: 'semantic_elementRef',
        matchedCandidateCount: 1,
        selectionStrategy: 'strict-single',
        matcher: {
          locator: {
            scope: 'buttons',
            frame: {
              titleContains: 'Settings',
            },
          },
        },
        matched: {
          selector: '#save',
          text: 'Save changes',
          frameId: 42,
          frameTitle: 'Settings panel',
        },
      },
    });
  });

  it('reports ambiguous semantic matches with sampled candidates', async () => {
    const capturePageState = vi.fn().mockResolvedValue(pageState({
      buttons: [
        { selector: '#save-a', text: 'Save', role: 'button', name: 'Save' },
        { selector: '#save-b', text: 'Save', role: 'button', name: 'Save' },
      ],
    }));

    await expect(resolveWorkflowActionTarget('session-1', {
      role: 'button',
      name: 'Save',
    }, capturePageState)).rejects.toMatchObject({
      code: 'workflow_target_ambiguous',
      details: {
        matchedCandidateCount: 2,
        totalMatchedCandidateCount: 2,
        selectionStrategy: 'strict-single',
        sampledCandidates: [
          { selector: '#save-a', text: 'Save' },
          { selector: '#save-b', text: 'Save' },
        ],
      },
    });
  });

  it('reports out-of-range positional selection as not found', async () => {
    const capturePageState = vi.fn().mockResolvedValue(pageState({
      links: [
        { selector: '#item-0', text: 'Details', role: 'link', name: 'Details' },
      ],
    }));

    await expect(resolveWorkflowActionTarget('session-1', {
      scope: 'links',
      name: 'Details',
      nth: 1,
    }, capturePageState)).rejects.toMatchObject({
      code: 'workflow_target_not_found',
      details: {
        searchedScope: 'links',
        matchedCandidateCount: 1,
        selectionStrategy: 'nth',
        selectedIndex: 1,
      },
    });
  });

  it('preserves the resolver error type for callers', async () => {
    const capturePageState = vi.fn().mockResolvedValue(pageState({ buttons: [] }));

    await expect(resolveWorkflowActionTarget('session-1', {
      role: 'button',
    }, capturePageState)).rejects.toBeInstanceOf(WorkflowTargetResolutionError);
  });
});
