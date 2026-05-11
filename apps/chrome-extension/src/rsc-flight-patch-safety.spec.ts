import { describe, expect, it } from 'vitest';
import {
  applyRscFlightTextPatches,
  assertRscFlightTextPatchesSafe,
} from './rsc-flight-patch-safety';

describe('RSC flight patch safety', () => {
  const body = '1:["$","h1",null,{"children":"Original proof","price":"$129"}]';

  it('allows literal replacements inside payload string values', () => {
    expect(() => assertRscFlightTextPatchesSafe(body, [
      { search: 'Original proof', replacement: 'Override proof', expectedCount: 1 },
      { search: '$129', replacement: '$049', expectedCount: 1 },
    ])).not.toThrow();
  });

  it('applies replacements through parsed string values and JSON-escapes replacements', () => {
    const result = applyRscFlightTextPatches(body, [
      { search: 'Original proof', replacement: 'Override "quoted" proof', expectedCount: 1 },
    ]);

    expect(result.blockers).toEqual([]);
    expect(result.applied[0]?.matchedCount).toBe(1);
    expect(result.patchedBody).toBe('1:["$","h1",null,{"children":"Override \\"quoted\\" proof","price":"$129"}]');
    expect(JSON.parse(result.patchedBody.slice(result.patchedBody.indexOf(':') + 1))).toEqual([
      '$',
      'h1',
      null,
      { children: 'Override "quoted" proof', price: '$129' },
    ]);
  });

  it('preserves tagged rows but rejects patch anchors inside them', () => {
    const taggedBody = '0:D{"name":"Original proof"}\n1:I["module","Original proof"]';
    const result = applyRscFlightTextPatches(taggedBody, [
      { search: 'Original proof', replacement: 'Override proof', expectedCount: 2 },
    ]);

    expect(result.blockers[0]).toMatchObject({
      code: 'RSC_FLIGHT_UNSUPPORTED_RECORD',
      rowId: '0',
    });
    expect(result.patchedBody).toBe(taggedBody);
  });

  it('rejects replacements outside JSON string payloads', () => {
    expect(() => assertRscFlightTextPatchesSafe(body, [
      { search: '1:', replacement: '2:', expectedCount: 1 },
    ])).toThrow('outside a JSON string payload');
  });

  it('rejects empty search strings', () => {
    expect(() => assertRscFlightTextPatchesSafe(body, [
      { search: '', replacement: 'Override proof', expectedCount: 1 },
    ])).toThrow('must be a non-empty string');
  });

  it('rejects JSON object key replacements', () => {
    expect(() => assertRscFlightTextPatchesSafe(body, [
      { search: 'children', replacement: 'content', expectedCount: 1 },
    ])).toThrow('matched a JSON object key');
  });

  it('rejects likely RSC protocol reference replacements', () => {
    const protocolBody = '1:["$L1","h1",null,{"children":"Original proof"}]';

    expect(() => assertRscFlightTextPatchesSafe(protocolBody, [
      { search: '$L1', replacement: 'not-rsc', expectedCount: 1 },
    ])).toThrow('RSC protocol reference token');
  });

  it('rejects React element type mutations inside Flight tuples', () => {
    expect(() => assertRscFlightTextPatchesSafe(body, [
      { search: 'h1', replacement: 'h2', expectedCount: 1 },
    ])).toThrow('React element type token');
  });

  it('rejects unsupported rows when the patch anchor appears in them', () => {
    const result = applyRscFlightTextPatches('1:NOT_JSON Original proof', [
      { search: 'Original proof', replacement: 'Override proof', expectedCount: 1 },
    ]);

    expect(result.blockers[0]).toMatchObject({
      code: 'RSC_FLIGHT_UNSUPPORTED_RECORD',
    });
  });
});
