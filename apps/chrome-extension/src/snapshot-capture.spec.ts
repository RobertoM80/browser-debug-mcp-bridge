import { describe, expect, it } from 'vitest';
import {
  evaluatePngCapturePolicy,
  normalizeSnapshotMode,
  normalizeSnapshotStyleMode,
  normalizeSnapshotTrigger,
  registerPngCaptureSuccess,
  resolveSnapshotStyleMode,
  shouldCapturePng,
  SnapshotPngPolicy,
  SnapshotPngUsage,
} from './snapshot-capture';

describe('snapshot-capture helpers', () => {
  it('normalizes trigger and mode values to safe defaults', () => {
    expect(normalizeSnapshotTrigger('click')).toBe('click');
    expect(normalizeSnapshotTrigger('unknown')).toBe('manual');

    expect(normalizeSnapshotMode('both', 'dom')).toBe('both');
    expect(normalizeSnapshotMode('invalid', 'dom')).toBe('dom');

    expect(normalizeSnapshotStyleMode('computed-full', 'computed-lite')).toBe('computed-full');
    expect(normalizeSnapshotStyleMode('invalid', 'computed-lite')).toBe('computed-lite');
  });

  it('requires explicit request for computed-full style mode', () => {
    expect(resolveSnapshotStyleMode('computed-full', true)).toBe('computed-full');
    expect(resolveSnapshotStyleMode('computed-full', false)).toBe('computed-lite');
    expect(resolveSnapshotStyleMode('computed-lite', false)).toBe('computed-lite');
  });

  it('identifies png modes correctly', () => {
    expect(shouldCapturePng('png')).toBe(true);
    expect(shouldCapturePng('both')).toBe(true);
    expect(shouldCapturePng('dom')).toBe(false);
  });

  it('enforces png quota and throttle policy', () => {
    const policy: SnapshotPngPolicy = {
      maxImagesPerSession: 2,
      maxBytesPerImage: 256000,
      minCaptureIntervalMs: 5000,
    };
    const usage: SnapshotPngUsage = {
      imageCount: 0,
      lastCaptureAt: 0,
    };

    expect(evaluatePngCapturePolicy(usage, policy, 1000)).toEqual({ allowed: true });

    registerPngCaptureSuccess(usage, 1000);
    expect(usage).toEqual({ imageCount: 1, lastCaptureAt: 1000 });

    const throttled = evaluatePngCapturePolicy(usage, policy, 2000);
    expect(throttled).toEqual({
      allowed: false,
      reason: 'throttled',
      retryAfterMs: 4000,
    });

    registerPngCaptureSuccess(usage, 7000);
    const quotaExceeded = evaluatePngCapturePolicy(usage, policy, 13000);
    expect(quotaExceeded).toEqual({
      allowed: false,
      reason: 'quota_exceeded',
    });
  });
});
