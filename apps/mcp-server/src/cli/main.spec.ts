import { describe, expect, it } from 'vitest';
import { getBaseUrl, isLiveSession, parseArgs, parseJsonObject, withCommonLimits } from './main';

describe('bdmcp CLI parsing', () => {
  it('parses command words and long options', () => {
    const parsed = parseArgs(['tool', 'run', 'list_sessions', '--json-args', '{"limit":10}', '--json']);

    expect(parsed.command).toEqual(['tool', 'run', 'list_sessions']);
    expect(parsed.options['json-args']).toBe('{"limit":10}');
    expect(parsed.options.json).toBe(true);
  });

  it('resolves bridge base URL from options', () => {
    expect(getBaseUrl({ port: '9876' })).toBe('http://127.0.0.1:9876');
    expect(getBaseUrl({ 'base-url': 'http://127.0.0.1:9000/' })).toBe('http://127.0.0.1:9000');
  });

  it('parses JSON object arguments and common limits', () => {
    expect(parseJsonObject('{"limit":5}', 'args')).toEqual({ limit: 5 });
    expect(withCommonLimits({ sessionId: 's1' }, { limit: '3', 'max-bytes': '1024' })).toEqual({
      sessionId: 's1',
      limit: 3,
      maxResponseBytes: 1024,
    });
  });

  it('recognizes live sessions from list_sessions metadata', () => {
    expect(isLiveSession({ liveConnection: { connected: true } })).toBe(true);
    expect(isLiveSession({ liveConnection: { connected: false } })).toBe(false);
    expect(isLiveSession({})).toBe(false);
  });
});
