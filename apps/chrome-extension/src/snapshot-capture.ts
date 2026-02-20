import { SnapshotMode, SnapshotStyleMode, SnapshotTrigger } from './capture-controls';

export interface SnapshotPngUsage {
  imageCount: number;
  lastCaptureAt: number;
}

export interface SnapshotPngPolicy {
  maxImagesPerSession: number;
  maxBytesPerImage: number;
  minCaptureIntervalMs: number;
}

export function normalizeSnapshotTrigger(value: unknown): SnapshotTrigger {
  if (value === 'click' || value === 'manual' || value === 'navigation' || value === 'error') {
    return value;
  }
  return 'manual';
}

export function normalizeSnapshotMode(value: unknown, fallback: SnapshotMode): SnapshotMode {
  if (value === 'dom' || value === 'png' || value === 'both') {
    return value;
  }
  return fallback;
}

export function normalizeSnapshotStyleMode(value: unknown, fallback: SnapshotStyleMode): SnapshotStyleMode {
  if (value === 'computed-lite' || value === 'computed-full') {
    return value;
  }
  return fallback;
}

export function resolveSnapshotStyleMode(
  requestedStyleMode: SnapshotStyleMode,
  explicitStyleMode: boolean
): SnapshotStyleMode {
  if (requestedStyleMode === 'computed-full' && explicitStyleMode) {
    return 'computed-full';
  }
  return 'computed-lite';
}

export function shouldCapturePng(mode: SnapshotMode): boolean {
  return mode === 'png' || mode === 'both';
}

export function evaluatePngCapturePolicy(
  usage: SnapshotPngUsage,
  policy: SnapshotPngPolicy,
  now: number
): { allowed: true } | { allowed: false; reason: 'quota_exceeded' | 'throttled'; retryAfterMs?: number } {
  if (usage.imageCount >= policy.maxImagesPerSession) {
    return { allowed: false, reason: 'quota_exceeded' };
  }

  const elapsedMs = now - usage.lastCaptureAt;
  if (usage.lastCaptureAt > 0 && elapsedMs < policy.minCaptureIntervalMs) {
    return {
      allowed: false,
      reason: 'throttled',
      retryAfterMs: policy.minCaptureIntervalMs - elapsedMs,
    };
  }

  return { allowed: true };
}

export function registerPngCaptureSuccess(usage: SnapshotPngUsage, now: number): void {
  usage.imageCount += 1;
  usage.lastCaptureAt = now;
}
