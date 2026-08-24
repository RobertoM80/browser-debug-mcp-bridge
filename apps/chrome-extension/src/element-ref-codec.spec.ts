import { describe, expect, it } from 'vitest';
import { decodeElementRefPayload, encodeElementRefPayload } from './element-ref-codec';

describe('element ref codec', () => {
  it('round-trips Unicode text and frame metadata', () => {
    const payload = {
      selector: '#play',
      text: 'Riproduci ▶️',
      frameTitle: 'Lezione è pronta',
    };

    expect(decodeElementRefPayload(encodeElementRefPayload(payload))).toEqual(payload);
  });

  it('decodes refs created by the legacy Latin-1 codec', () => {
    const payload = { selector: '#cafe', text: 'Caffè' };
    const legacyRef = `ref:${btoa(JSON.stringify(payload))}`;

    expect(decodeElementRefPayload(legacyRef)).toEqual(payload);
  });
});
