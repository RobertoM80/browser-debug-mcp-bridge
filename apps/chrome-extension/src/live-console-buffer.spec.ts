import { describe, expect, it } from 'vitest';
import { LiveConsoleBufferStore } from './live-console-buffer';

describe('LiveConsoleBufferStore', () => {
  it('stores console and runtime error entries and returns newest first', () => {
    const store = new LiveConsoleBufferStore();

    store.append('sess-1', 'console', {
      level: 'info',
      message: 'first',
      timestamp: 1000,
    }, { tabId: 10, origin: 'http://localhost:3000' });

    store.append('sess-1', 'error', {
      message: 'second',
      timestamp: 2000,
    }, { tabId: 10, origin: 'http://localhost:3000' });

    const result = store.query('sess-1', { limit: 10 });

    expect(result.logs).toHaveLength(2);
    expect(result.logs[0]?.message).toBe('second');
    expect(result.logs[0]?.source).toBe('runtime_error');
    expect(result.logs[1]?.message).toBe('first');
  });

  it('enforces max entries per session and tracks dropped count', () => {
    const store = new LiveConsoleBufferStore({ maxEntriesPerSession: 2 });

    store.append('sess-2', 'console', { message: 'a', timestamp: 1000 }, { tabId: 1 });
    store.append('sess-2', 'console', { message: 'b', timestamp: 1001 }, { tabId: 1 });
    store.append('sess-2', 'console', { message: 'c', timestamp: 1002 }, { tabId: 1 });

    const result = store.query('sess-2', { limit: 10 });
    expect(result.buffered).toBe(2);
    expect(result.dropped).toBe(1);
    expect(result.logs.map((entry) => entry.message)).toEqual(['c', 'b']);
  });

  it('filters by level, contains, and sinceTs', () => {
    const store = new LiveConsoleBufferStore();

    store.append('sess-3', 'console', {
      level: 'info',
      message: '[auth] logged in success',
      timestamp: 1000,
    }, { tabId: 5 });

    store.append('sess-3', 'console', {
      level: 'warn',
      message: '[cart] missing coupon',
      timestamp: 2000,
    }, { tabId: 5 });

    store.append('sess-3', 'console', {
      level: 'error',
      message: '[auth] token expired',
      timestamp: 3000,
    }, { tabId: 5 });

    const result = store.query('sess-3', {
      levels: ['error', 'warn'],
      contains: '[auth]',
      sinceTs: 2500,
      limit: 50,
    });

    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]?.message).toBe('[auth] token expired');
    expect(result.logs[0]?.level).toBe('error');
  });

  it('filters by tabId and origin', () => {
    const store = new LiveConsoleBufferStore();

    store.append('sess-4', 'console', {
      level: 'info',
      message: 'local',
      timestamp: 1000,
    }, { tabId: 1, origin: 'http://localhost:3000' });

    store.append('sess-4', 'console', {
      level: 'info',
      message: 'remote',
      timestamp: 2000,
    }, { tabId: 2, origin: 'https://example.com' });

    const byTab = store.query('sess-4', { tabId: 1, limit: 10 });
    expect(byTab.logs).toHaveLength(1);
    expect(byTab.logs[0]?.message).toBe('local');

    const byOrigin = store.query('sess-4', { origin: 'https://example.com', limit: 10 });
    expect(byOrigin.logs).toHaveLength(1);
    expect(byOrigin.logs[0]?.message).toBe('remote');
  });

  it('can exclude runtime error entries', () => {
    const store = new LiveConsoleBufferStore();

    store.append('sess-5', 'console', { level: 'error', message: 'console error', timestamp: 1000 }, { tabId: 1 });
    store.append('sess-5', 'error', { message: 'runtime error', timestamp: 2000 }, { tabId: 1 });

    const result = store.query('sess-5', {
      includeRuntimeErrors: false,
      limit: 10,
    });

    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]?.source).toBe('console');
  });

  it('ignores non-console event types', () => {
    const store = new LiveConsoleBufferStore();

    const appended = store.append('sess-6', 'navigation', {
      to: 'https://example.com',
      timestamp: 1000,
    }, { tabId: 1 });

    expect(appended).toBe(false);
    expect(store.query('sess-6', { limit: 10 }).logs).toHaveLength(0);
  });
});
