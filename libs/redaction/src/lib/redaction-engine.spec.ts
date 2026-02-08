import { describe, it, expect } from 'vitest';
import { RedactionEngine, redact, redactObject } from './redaction-engine';

describe('redaction-engine', () => {
  describe('RedactionEngine', () => {
    it('should redact authorization headers', () => {
      const engine = new RedactionEngine();
      const result = engine.redact('Authorization: Bearer token123');
      expect(result.redacted).toBe(true);
      expect(result.value).toBe('Authorization: Bearer [REDACTED]');
      expect(result.rulesApplied).toContain('authorization-header');
    });

    it('should redact JWT tokens', () => {
      const engine = new RedactionEngine();
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
      const result = engine.redact(jwt);
      expect(result.redacted).toBe(true);
      expect(result.value).toBe('[JWT_TOKEN]');
    });

    it('should redact API keys', () => {
      const engine = new RedactionEngine();
      const result = engine.redact('api_key: sk-1234567890abcdef');
      expect(result.redacted).toBe(true);
      expect(result.value).toBe('api_key: [API_KEY]');
    });

    it('should redact generic tokens', () => {
      const engine = new RedactionEngine();
      const result = engine.redact('token: secret-token-value');
      expect(result.redacted).toBe(true);
      expect(result.value).toBe('token: [TOKEN]');
    });

    it('should not redact safe content', () => {
      const engine = new RedactionEngine();
      const result = engine.redact('Hello World');
      expect(result.redacted).toBe(false);
      expect(result.value).toBe('Hello World');
      expect(result.rulesApplied).toHaveLength(0);
    });

    it('should redact objects recursively', () => {
      const engine = new RedactionEngine();
      const obj = {
        message: 'Authorization: Bearer token123',
        nested: {
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
          safe: 'public data',
        },
      };
      const { result, summary } = engine.redactObject(obj);
      expect(result.message).toBe('Authorization: Bearer [REDACTED]');
      expect(result.nested.token).toBe('[JWT_TOKEN]');
      expect(result.nested.safe).toBe('public data');
      expect(summary.redactedFields).toBeGreaterThan(0);
      expect(summary.rulesApplied).toContain('authorization-header');
    });
  });

  describe('redact helper', () => {
    it('should use default rules when none provided', () => {
      const result = redact('password: secret123');
      expect(result.redacted).toBe(true);
      expect(result.value).toBe('password: [PASSWORD]');
    });
  });

  describe('redactObject helper', () => {
    it('should redact object with default rules', () => {
      const { result, summary } = redactObject({ key: 'Authorization: Bearer abc' });
      expect(result.key).toBe('Authorization: Bearer [REDACTED]');
      expect(summary.redactedFields).toBe(1);
    });
  });
});
