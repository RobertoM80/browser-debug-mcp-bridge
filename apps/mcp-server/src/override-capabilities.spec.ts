import { describe, expect, it } from 'vitest';
import {
  assertOverrideResponseRequestCaptureSafe,
  assertOverrideResponseRequestProductionSafe,
  classifyOverrideResponseRequestCapability,
} from './override-capabilities.js';

describe('override response capabilities', () => {
  it('treats GET requests as production-safe', () => {
    const capability = classifyOverrideResponseRequestCapability({
      ruleId: 'safe-rule',
      requestMethod: 'get',
      requestHeaders: {
        Accept: 'application/json',
      },
    });

    expect(capability).toMatchObject({
      requestMethod: 'GET',
      classification: 'safe-get',
      productionSafe: true,
      captureSafe: true,
    });
    expect(capability.requestHeaders).toEqual({
      accept: 'application/json',
    });
    expect(capability.issues).toEqual([]);
  });

  it('allows HEAD capture but keeps it production-blocked', () => {
    const capability = classifyOverrideResponseRequestCapability({
      subject: 'Planner request',
      requestMethod: 'HEAD',
    });

    expect(capability).toMatchObject({
      requestMethod: 'HEAD',
      classification: 'safe-head',
      productionSafe: false,
      captureSafe: true,
    });
    expect(capability.issues).toEqual([
      expect.objectContaining({
        code: 'UNSAFE_REQUEST_METHOD',
        message: 'Planner request uses HEAD; production response overrides only support GET requests.',
      }),
    ]);
    expect(() => assertOverrideResponseRequestProductionSafe({
      subject: 'Planner request',
      requestMethod: 'HEAD',
    })).toThrow('UNSAFE_REQUEST_METHOD');
    expect(() => assertOverrideResponseRequestCaptureSafe({
      subject: 'Capture request',
      requestMethod: 'HEAD',
    })).not.toThrow();
  });

  it('classifies Next.js server action requests separately from generic mutations', () => {
    const nextAction = classifyOverrideResponseRequestCapability({
      ruleId: 'server-action-rule',
      requestMethod: 'POST',
      requestHeaders: {
        'Next-Action': 'fixture-action',
        RSC: '1',
      },
    });
    const mutation = classifyOverrideResponseRequestCapability({
      ruleId: 'mutation-rule',
      requestMethod: 'POST',
      requestHeaders: {
        'Content-Type': 'application/json',
      },
      ruleType: 'api-response',
    });

    expect(nextAction).toMatchObject({
      classification: 'server-action',
      productionSafe: false,
      captureSafe: false,
    });
    expect(nextAction.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNSAFE_REQUEST_METHOD' }),
      expect.objectContaining({ code: 'SERVER_ACTION_UNSUPPORTED' }),
    ]));
    expect(mutation).toMatchObject({
      classification: 'mutation-replay',
      productionSafe: false,
      captureSafe: false,
    });
    expect(mutation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNSAFE_REQUEST_METHOD' }),
      expect.objectContaining({ code: 'MUTATION_REPLAY_UNSUPPORTED' }),
    ]));
    expect(() => assertOverrideResponseRequestCaptureSafe({
      ruleId: 'server-action-rule',
      requestMethod: 'POST',
      requestHeaders: {
        'Next-Action': 'fixture-action',
        RSC: '1',
      },
    })).toThrow('SERVER_ACTION_UNSUPPORTED');
  });

  it('treats non-GET RSC rules as server-action-like even without captured headers', () => {
    const capability = classifyOverrideResponseRequestCapability({
      requestMethod: 'POST',
      ruleType: 'rsc-flight',
    });

    expect(capability.classification).toBe('server-action');
    expect(capability.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SERVER_ACTION_UNSUPPORTED' }),
    ]));
  });

  it('treats captured POST RSC flight responses without server-action headers as production-safe', () => {
    const capability = classifyOverrideResponseRequestCapability({
      requestMethod: 'POST',
      ruleType: 'rsc-flight',
      requestHeaders: {
        rsc: '1',
      },
    });

    expect(capability).toMatchObject({
      requestMethod: 'POST',
      classification: 'safe-rsc-flight-post',
      productionSafe: true,
      captureSafe: true,
    });
    expect(capability.issues).toEqual([]);
    expect(() => assertOverrideResponseRequestProductionSafe({
      requestMethod: 'POST',
      ruleType: 'rsc-flight',
      requestHeaders: {
        rsc: '1',
      },
    })).not.toThrow();
  });
});
