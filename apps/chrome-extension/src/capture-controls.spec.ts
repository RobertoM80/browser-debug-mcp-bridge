import { describe, expect, it } from 'vitest';
import {
  applySafeModeRestrictions,
  isUrlAllowed,
  loadCaptureConfig,
  normalizeCaptureConfig,
  parseAllowlistInput,
  saveCaptureConfig,
} from './capture-controls';

class MockStorageArea {
  private store: Record<string, unknown> = {};

  get(keys: string | string[] | Record<string, unknown> | null, callback: (items: Record<string, unknown>) => void): void {
    if (typeof keys === 'string') {
      callback({ [keys]: this.store[keys] });
      return;
    }

    if (Array.isArray(keys)) {
      const selected: Record<string, unknown> = {};
      for (const key of keys) {
        selected[key] = this.store[key];
      }
      callback(selected);
      return;
    }

    callback({ ...this.store });
  }

  set(items: Record<string, unknown>, callback?: () => void): void {
    this.store = { ...this.store, ...items };
    callback?.();
  }
}

describe('capture controls', () => {
  it('parses and normalizes allowlist values with wildcards', () => {
    const allowlist = parseAllowlistInput(' Example.com\n*.Staging.Example.com,https://api.example.com/path ');
    expect(allowlist).toEqual(['example.com', '*.staging.example.com', 'api.example.com']);
  });

  it('matches urls against exact and wildcard allowlist rules', () => {
    const allowlist = ['example.com', '*.staging.example.com'];

    expect(isUrlAllowed('https://example.com/home', allowlist)).toBe(true);
    expect(isUrlAllowed('https://foo.staging.example.com/app', allowlist)).toBe(true);
    expect(isUrlAllowed('https://staging.example.com', allowlist)).toBe(true);
    expect(isUrlAllowed('https://other-site.dev', allowlist)).toBe(false);
  });

  it('redacts safe-mode sensitive fields and cookie-like strings', () => {
    const payload = applySafeModeRestrictions('console', {
      inputValue: 'secret text',
      nested: {
        cookieHeader: 'Cookie: auth=abc123',
        localStorageDump: { token: 'abc' },
      },
      message: 'Set-Cookie: refreshToken=xyz',
      status: 'ok',
    });

    expect(payload).toEqual({
      inputValue: '[REDACTED_SAFE_MODE]',
      nested: {
        cookieHeader: '[REDACTED_SAFE_MODE]',
        localStorageDump: '[REDACTED_SAFE_MODE]',
      },
      message: '[REDACTED_SAFE_MODE]',
      status: 'ok',
    });
  });

  it('blocks blocked event categories in safe mode', () => {
    const payload = applySafeModeRestrictions('storage', { key: 'auth' });
    expect(payload).toBeNull();
  });

  it('loads and saves normalized capture config in storage', async () => {
    const storage = new MockStorageArea();
    const saved = await saveCaptureConfig(storage, {
      safeMode: false,
      allowlist: ['  Example.com  ', '*.Sub.Example.com'],
    });

    expect(saved).toEqual({
      safeMode: false,
      allowlist: ['example.com', '*.sub.example.com'],
    });

    const loaded = await loadCaptureConfig(storage);
    expect(loaded).toEqual(saved);
  });

  it('falls back to default capture config for invalid inputs', () => {
    expect(normalizeCaptureConfig(null)).toEqual({
      safeMode: true,
      allowlist: [],
    });
  });
});
