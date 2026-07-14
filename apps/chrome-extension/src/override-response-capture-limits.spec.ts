import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OVERRIDE_RESPONSE_CAPTURE_BYTES,
  MAX_OVERRIDE_RESPONSE_CAPTURE_BYTES,
  normalizeOverrideResponseCaptureBytes,
} from './override-response-capture-limits';

describe('override response capture byte limits', () => {
  it('falls back to the default for missing or too-small values', () => {
    expect(normalizeOverrideResponseCaptureBytes(undefined)).toBe(DEFAULT_OVERRIDE_RESPONSE_CAPTURE_BYTES);
    expect(normalizeOverrideResponseCaptureBytes(128)).toBe(DEFAULT_OVERRIDE_RESPONSE_CAPTURE_BYTES);
  });

  it('preserves requested values up to the 5 MiB hard cap', () => {
    expect(normalizeOverrideResponseCaptureBytes(2_000_000)).toBe(2_000_000);
    expect(normalizeOverrideResponseCaptureBytes(5_000_000)).toBe(5_000_000);
  });

  it('clamps larger values to the hard cap', () => {
    expect(normalizeOverrideResponseCaptureBytes(10_000_000)).toBe(MAX_OVERRIDE_RESPONSE_CAPTURE_BYTES);
  });
});
