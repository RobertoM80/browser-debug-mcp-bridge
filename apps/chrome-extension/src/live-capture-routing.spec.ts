import { describe, expect, it } from 'vitest';
import { buildPreferredCaptureTabIds, shouldRetryGenericCaptureResult } from './live-capture-routing';

describe('live capture routing helpers', () => {
  it('prefers the active tab before remembered and scoped tabs', () => {
    expect(buildPreferredCaptureTabIds({
      activeTabId: 9,
      rememberedTabId: 4,
      allowedTabIds: [4, 9, 12, 4],
    })).toEqual([9, 4, 12]);
  });

  it('retries empty outline document captures', () => {
    expect(shouldRetryGenericCaptureResult('CAPTURE_DOM_DOCUMENT', {
      mode: 'outline',
      outline: '{"truncated":false,"nodeCount":0,"root":{"tag":"html"}}',
    })).toBe(true);

    expect(shouldRetryGenericCaptureResult('CAPTURE_DOM_DOCUMENT', {
      mode: 'outline',
      outline: '{"truncated":false,"nodeCount":4,"root":{"tag":"html"}}',
    })).toBe(false);
  });

  it('retries page-state captures when frame errors or empty summaries are reported', () => {
    expect(shouldRetryGenericCaptureResult('CAPTURE_PAGE_STATE', {
      frameCaptureError: true,
      summary: { buttons: 0, links: 0, inputs: 0, modals: 0 },
    })).toBe(true);

    expect(shouldRetryGenericCaptureResult('CAPTURE_PAGE_STATE', {
      frames: [{ frameId: 0, frameCaptureError: true }],
      summary: { buttons: 0, links: 0, inputs: 0, modals: 0 },
    })).toBe(true);

    expect(shouldRetryGenericCaptureResult('CAPTURE_PAGE_STATE', {
      summary: { buttons: 1, links: 0, inputs: 0, modals: 0 },
    })).toBe(false);
  });
});
