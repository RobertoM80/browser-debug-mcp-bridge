import { describe, expect, it } from 'vitest';
import { DEFAULT_REDACTION_SUMMARY, withRedactionSummary } from './responses';

describe('responses', () => {
  it('adds default redactionSummary when omitted', () => {
    const response = withRedactionSummary({ sessionId: 'session-1' });

    expect(response.sessionId).toBe('session-1');
    expect(response.redactionSummary).toEqual(DEFAULT_REDACTION_SUMMARY);
  });

  it('preserves explicit redactionSummary values', () => {
    const response = withRedactionSummary(
      { sessionId: 'session-2' },
      {
        totalFields: 10,
        redactedFields: 2,
        rulesApplied: ['authorization-header', 'token'],
      }
    );

    expect(response.redactionSummary.totalFields).toBe(10);
    expect(response.redactionSummary.redactedFields).toBe(2);
    expect(response.redactionSummary.rulesApplied).toEqual(['authorization-header', 'token']);
  });
});
