import { describe, expect, it } from 'vitest';
import { applyDocumentPatches, normalizeDocumentPatches } from './document-response-rewriter.js';

describe('document response rewriter', () => {
  it('replaces text content and removes matched elements through structured patches', () => {
    const body = '<!doctype html><html><body><h1>Original title</h1><p id="mode">boot-extra</p><script src="/extra.js"></script></body></html>';
    const patches = normalizeDocumentPatches([
      {
        operation: 'replaceText',
        selector: 'h1',
        search: 'Original title',
        replacement: 'Patched title',
        expectedCount: 1,
      },
      {
        operation: 'replaceText',
        selector: '#mode',
        search: 'boot-extra',
        replacement: 'document-extra',
        expectedCount: 1,
      },
      {
        operation: 'removeElement',
        selector: 'script[src="/extra.js"]',
        expectedCount: 1,
      },
    ]);

    const result = applyDocumentPatches(body, patches);

    expect(result.patchedBody).toContain('Patched title');
    expect(result.patchedBody).toContain('document-extra');
    expect(result.patchedBody).not.toContain('script src="/extra.js"');
    expect(result.applied).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'replaceText', matchedTextCount: 1 }),
      expect.objectContaining({ operation: 'removeElement', removedCount: 1 }),
    ]));
  });

  it('rewrites Next.js __NEXT_DATA__ script JSON through JSON Pointer patches', () => {
    const body = '<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"signal":{"mode":"original-next-data","message":"Original","badge":"pages-stable"}}}}</script></body></html>';
    const patches = normalizeDocumentPatches([
      {
        operation: 'replaceJsonValue',
        selector: '#__NEXT_DATA__',
        path: '/props/pageProps/signal/mode',
        value: 'override-next-data',
        expectedValue: 'original-next-data',
      },
      {
        operation: 'replaceJsonValue',
        selector: '#__NEXT_DATA__',
        path: '/props/pageProps/signal/message',
        value: 'Document rewritten from __NEXT_DATA__.',
      },
    ]);

    const result = applyDocumentPatches(body, patches);

    expect(result.patchedBody).toContain('"mode":"override-next-data"');
    expect(result.patchedBody).toContain('Document rewritten from __NEXT_DATA__.');
    expect(result.applied).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operation: 'replaceJsonValue',
        matchedElementCount: 1,
      }),
    ]));
  });

  it('blocks ambiguous JSON script selectors', () => {
    const body = '<!doctype html><html><body><script type="application/json">{"a":1}</script><script type="application/json">{"a":2}</script></body></html>';
    const patches = normalizeDocumentPatches([
      {
        operation: 'replaceJsonValue',
        selector: 'script[type="application/json"]',
        path: '/a',
        value: 3,
      },
    ]);

    expect(() => applyDocumentPatches(body, patches)).toThrow('matched 2 element(s), expected exactly 1');
  });
});
