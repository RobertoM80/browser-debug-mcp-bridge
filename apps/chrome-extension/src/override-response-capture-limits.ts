export const DEFAULT_OVERRIDE_RESPONSE_CAPTURE_BYTES = 256 * 1024;
export const MAX_OVERRIDE_RESPONSE_CAPTURE_BYTES = 5 * 1024 * 1024;

export function normalizeOverrideResponseCaptureBytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_OVERRIDE_RESPONSE_CAPTURE_BYTES;
  }

  const floored = Math.floor(value);
  if (floored < 1024) {
    return DEFAULT_OVERRIDE_RESPONSE_CAPTURE_BYTES;
  }
  return Math.min(floored, MAX_OVERRIDE_RESPONSE_CAPTURE_BYTES);
}
