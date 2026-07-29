import { describe, expect, it } from 'vitest';
import {
  buildPreferredCaptureTabIds,
  hasExplicitCaptureFrameTarget,
  resolveCaptureFrameTarget,
  shouldRetryGenericCaptureResult,
} from './live-capture-routing';

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

describe('capture frame targeting', () => {
  const frames = [
    { frameId: 0, url: 'https://course.example.com/lecture', sameOriginWithTop: true },
    {
      frameId: 181,
      url: 'https://player.hotmart.com/embed/video',
      parentUrl: 'https://course.example.com/lecture',
      sameOriginWithTop: false,
    },
    { frameId: 182, url: 'https://m.stripe.network/inner.html', sameOriginWithTop: false },
    { frameId: 183, url: 'https://js.stripe.com/v3/controller.html', sameOriginWithTop: false },
  ];

  it('returns top-frame or explicit-frame metadata', () => {
    expect(hasExplicitCaptureFrameTarget({})).toBe(false);
    expect(resolveCaptureFrameTarget(frames, {})).toBe(frames[0]);
    expect(resolveCaptureFrameTarget(frames, { frameId: 181 })).toBe(frames[1]);
    expect(() => resolveCaptureFrameTarget([], {})).toThrow('No top frame found');
    expect(() => resolveCaptureFrameTarget(frames, { frameId: 999 })).toThrow(
      'No frame found for frameId 999',
    );
  });

  it('resolves a unique frame URL case-insensitively', () => {
    expect(hasExplicitCaptureFrameTarget({ frameUrlContains: 'HOTMART' })).toBe(true);
    expect(resolveCaptureFrameTarget(frames, { frameUrlContains: 'HOTMART' })).toBe(frames[1]);
  });

  it('checks frameId and frameUrlContains for consistency', () => {
    expect(resolveCaptureFrameTarget(frames, {
      frameId: 181,
      frameUrlContains: 'hotmart.com',
    })).toBe(frames[1]);
    expect(() => resolveCaptureFrameTarget(frames, {
      frameId: 181,
      frameUrlContains: 'stripe.com',
    })).toThrow('frameId 181 does not match frameUrlContains "stripe.com"');
    expect(() => resolveCaptureFrameTarget(frames, {
      frameId: 999,
      frameUrlContains: 'hotmart.com',
    })).toThrow('No frame found for frameId 999');
  });

  it('rejects missing and ambiguous URL matches', () => {
    expect(() => resolveCaptureFrameTarget(frames, {
      frameUrlContains: 'missing.example',
    })).toThrow('No frame matches frameUrlContains "missing.example"');
    expect(() => resolveCaptureFrameTarget(frames, {
      frameUrlContains: 'stripe',
    })).toThrow('frameUrlContains "stripe" matched 2 frames (182, 183); specify frameId');
  });
});
