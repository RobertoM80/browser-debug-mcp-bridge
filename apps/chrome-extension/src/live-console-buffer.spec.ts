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
    expect(result.oldestTimestamp).toBe(1001);
    expect(result.newestTimestamp).toBe(1002);
  });

  it('protects retained messages from ordinary ring eviction', () => {
    const store = new LiveConsoleBufferStore({
      maxEntriesPerSession: 2,
      maxRetainedEntriesPerSession: 2,
    });

    store.query('sess-retain', { retain: ['MomentMark'] });
    store.append('sess-retain', 'console', { message: '[MomentMark] loaded', timestamp: 1000 });
    store.append('sess-retain', 'console', { message: 'noise-a', timestamp: 1001 });
    store.append('sess-retain', 'console', { message: 'noise-b', timestamp: 1002 });
    store.append('sess-retain', 'console', { message: 'noise-c', timestamp: 1003 });

    const result = store.query('sess-retain', { contains: 'MomentMark' });
    expect(result.logs.map((entry) => entry.message)).toEqual(['[MomentMark] loaded']);
    expect(result.buffered).toBe(3);
    expect(result.regularBuffered).toBe(2);
    expect(result.retained).toBe(1);
    expect(result.dropped).toBe(1);
    expect(result.retainedDropped).toBe(0);
    expect(result.retain).toEqual(['momentmark']);
  });

  it('mutes configured noise before it consumes buffer capacity', () => {
    const store = new LiveConsoleBufferStore({ maxEntriesPerSession: 2 });

    store.query('sess-mute', { mute: ['Script error.', 'VIDEOJS: WARN'] });
    store.append('sess-mute', 'console', { message: 'important', timestamp: 1000 });
    store.append('sess-mute', 'console', { message: 'Script error.', timestamp: 1001 });
    store.append('sess-mute', 'console', { message: 'VIDEOJS: WARN retry', timestamp: 1002 });

    const result = store.query('sess-mute');
    expect(result.logs.map((entry) => entry.message)).toEqual(['important']);
    expect(result.buffered).toBe(1);
    expect(result.muted).toBe(2);
    expect(result.dropped).toBe(0);
    expect(result.mute).toEqual(['script error.', 'videojs: warn']);
  });

  it('gives retention precedence when a message matches retain and mute filters', () => {
    const store = new LiveConsoleBufferStore({ maxRetainedEntriesPerSession: 1 });

    store.query('sess-priority', { retain: ['important'], mute: ['important'] });
    store.append('sess-priority', 'console', { message: 'important evidence', timestamp: 1000 });

    const result = store.query('sess-priority');
    expect(result.logs.map((entry) => entry.message)).toEqual(['important evidence']);
    expect(result.retained).toBe(1);
    expect(result.muted).toBe(0);
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

  it('can dedupe repetitive logs in a time window', () => {
    const store = new LiveConsoleBufferStore();

    store.append('sess-dedupe', 'console', { level: 'warn', message: 'retrying', timestamp: 1200 }, { tabId: 1 });
    store.append('sess-dedupe', 'console', { level: 'warn', message: 'retrying', timestamp: 1500 }, { tabId: 1 });
    store.append('sess-dedupe', 'console', { level: 'warn', message: 'retrying', timestamp: 2000 }, { tabId: 1 });
    store.append('sess-dedupe', 'console', { level: 'error', message: 'failed', timestamp: 2100 }, { tabId: 1 });

    const result = store.query('sess-dedupe', {
      dedupeWindowMs: 1000,
      limit: 10,
    });

    expect(result.logs).toHaveLength(2);
    const dedupedWarn = result.logs.find((entry) => entry.message === 'retrying');
    expect(dedupedWarn).toMatchObject({
      count: 3,
      firstTimestamp: 1200,
      lastTimestamp: 2000,
    });
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
