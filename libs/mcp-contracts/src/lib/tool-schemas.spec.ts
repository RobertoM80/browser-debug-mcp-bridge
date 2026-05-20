import { describe, expect, it } from 'vitest';
import { EnableNetworkBlockingSchema } from './tool-schemas';

describe('tool-schemas', () => {
  it('parses network blocking rules with defaults', () => {
    const parsed = EnableNetworkBlockingSchema.parse({
      sessionId: 'session-1',
      rules: [{ urlContains: '/api/blocked' }],
    });

    expect(parsed.sessionId).toBe('session-1');
    expect(parsed.rules[0]?.urlContains).toBe('/api/blocked');
  });

  it('rejects network blocking rules without URL matchers', () => {
    expect(() => EnableNetworkBlockingSchema.parse({
      sessionId: 'session-1',
      rules: [{ method: 'GET' }],
    })).toThrow('network blocking rule requires exactUrl, urlContains, or urlRegex');
  });
});
