import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { planOverrideResponsePatch } from './override-response-planner.js';

describe('override response planner', () => {
  it('plans and writes a document response patch with an exact override config', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'override-response-plan-'));
    const configPath = join(fixtureRoot, 'override-poc.local.json');

    const plan = planOverrideResponsePatch({
      targetUrl: 'https://example.com/products',
      ruleType: 'document',
      contentType: 'text/html; charset=utf-8',
      responseBodyText: '<!doctype html><h1>Original products</h1>',
      textPatches: [{ search: 'Original products', replacement: 'Patched products', expectedCount: 1 }],
      configPath,
      writeConfig: true,
      overwrite: false,
      profileId: 'document-response',
    });

    expect(plan.ruleType).toBe('document');
    expect(plan.configWritten).toBe(true);
    expect(plan.rule).toMatchObject({
      ruleType: 'document',
      requestMethod: 'GET',
      matchMode: 'exact',
      targetAssetUrl: 'https://example.com/products',
      contentType: 'text/html; charset=utf-8',
    });
    expect(plan.localFilePath && existsSync(plan.localFilePath)).toBe(true);
    expect(readFileSync(plan.localFilePath ?? '', 'utf8')).toContain('Patched products');

    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      profiles: Array<{ rules: Array<{ ruleType: string; targetAssetUrl: string; localFilePath: string }> }>;
    };
    expect(config.profiles[0]?.rules[0]).toMatchObject({
      ruleType: 'document',
      targetAssetUrl: 'https://example.com/products',
      localFilePath: plan.localFilePath,
    });
  });

  it('plans structured document patches through selectors and persists the rewritten body', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'override-document-structured-'));
    const configPath = join(fixtureRoot, 'override-poc.local.json');

    try {
      const plan = planOverrideResponsePatch({
        targetUrl: 'https://example.com/products',
        ruleType: 'document',
        contentType: 'text/html; charset=utf-8',
        responseBodyText: '<!doctype html><html><body><h1>Original products</h1><p id="mode">boot-extra</p><script src="/extra.js"></script></body></html>',
        documentPatches: [
          {
            operation: 'replaceText',
            selector: 'h1',
            search: 'Original products',
            replacement: 'Structured products',
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
        ],
        configPath,
        writeConfig: true,
        overwrite: false,
        profileId: 'document-structured',
      });

      expect(plan.ruleType).toBe('document');
      expect(plan.documentPatches).toEqual(expect.arrayContaining([
        expect.objectContaining({ operation: 'replaceText', matchedTextCount: 1 }),
        expect.objectContaining({ operation: 'removeElement', removedCount: 1 }),
      ]));
      expect(plan.localFilePath && readFileSync(plan.localFilePath, 'utf8')).toContain('Structured products');
      expect(plan.localFilePath && readFileSync(plan.localFilePath, 'utf8')).not.toContain('/extra.js');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('plans structured Next.js __NEXT_DATA__ document rewrites through JSON Pointer patches', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'override-document-next-data-'));
    const configPath = join(fixtureRoot, 'override-poc.local.json');

    try {
      const plan = planOverrideResponsePatch({
        targetUrl: 'https://example.com/legacy-data',
        ruleType: 'document',
        contentType: 'text/html; charset=utf-8',
        responseBodyText: '<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"signal":{"mode":"original-next-data","message":"Original","badge":"pages-stable"}}}}</script></body></html>',
        documentPatches: [
          {
            operation: 'replaceJsonValue',
            selector: '#__NEXT_DATA__',
            path: '/props/pageProps/signal/mode',
            value: 'override-next-data',
            expectedValue: 'original-next-data',
          },
        ],
        configPath,
        writeConfig: true,
        overwrite: false,
        profileId: 'document-next-data',
      });

      expect(plan.ruleType).toBe('document');
      expect(plan.documentPatches).toEqual(expect.arrayContaining([
        expect.objectContaining({
          operation: 'replaceJsonValue',
          matchedElementCount: 1,
        }),
      ]));
      expect(plan.localFilePath && readFileSync(plan.localFilePath, 'utf8')).toContain('"mode":"override-next-data"');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('infers RSC and Next data rule types from URL and content type hints', () => {
    const rscPlan = planOverrideResponsePatch({
      targetUrl: 'https://example.com/products?_rsc=abc',
      contentType: 'text/x-component; charset=utf-8',
      responseBodyText: '1:["$","span",null,{"children":"Original"}]',
      textPatches: [{ search: 'Original', replacement: 'Patched' }],
      includePreview: true,
    });

    const dataPlan = planOverrideResponsePatch({
      targetUrl: 'https://example.com/_next/data/build-id/products.json',
      responseBodyText: '{"pageProps":{"headline":"Original"}}',
      textPatches: [{ search: 'Original', replacement: 'Patched' }],
    });

    expect(rscPlan.ruleType).toBe('rsc-flight');
    expect(rscPlan.preview?.after).toContain('Patched');
    expect(rscPlan.blockers.some((blocker) => blocker.includes('requires a body captured'))).toBe(true);
    expect(dataPlan.ruleType).toBe('next-data');
  });

  it('keeps uncaptured prefix-matched RSC response patches inspectable but does not write enableable configs', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'override-response-rsc-prefix-'));
    const configPath = join(fixtureRoot, 'override-poc.local.json');

    try {
      const plan = planOverrideResponsePatch({
        targetUrl: 'https://example.com/about?_rsc=',
        matchMode: 'prefix',
        contentType: 'text/x-component',
        responseBodyText: '1:["$","h1",null,{"children":"Original proof"}]',
        textPatches: [{ search: 'Original proof', replacement: 'Override proof', expectedCount: 1 }],
        configPath,
        writeConfig: true,
        overwrite: false,
        profileId: 'rsc-prefix',
      });

      expect(plan.ruleType).toBe('rsc-flight');
      expect(plan.matchMode).toBe('prefix');
      expect(plan.configWritten).toBe(false);
      expect(plan.rule).toBeUndefined();
      expect(plan.localFilePath).toBeUndefined();
      expect(existsSync(configPath)).toBe(false);
      expect(plan.blockers.some((blocker) => blocker.includes('requires a body captured'))).toBe(true);
      expect(plan.warnings.some((warning) => warning.includes('did not pass production safety checks'))).toBe(true);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('writes production RSC flight configs with structured Flight metadata when the body came from capture', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'override-response-rsc-production-'));
    const configPath = join(fixtureRoot, 'override-poc.local.json');

    try {
      const plan = planOverrideResponsePatch({
        targetUrl: 'https://example.com/products?_rsc=',
        matchMode: 'prefix',
        captureMode: 'cdp-response',
        contentType: 'text/x-component; charset=utf-8',
        responseBodyText: '1:["$","h1",null,{"children":"Original debugging kits"}]',
        requestHeaders: {
          RSC: '1',
        },
        textPatches: [{ search: 'Original debugging kits', replacement: 'Override debugging kits', expectedCount: 1 }],
        configPath,
        writeConfig: true,
        overwrite: false,
        profileId: 'rsc-production',
      });

      expect(plan.blockers).toEqual([]);
      expect(plan.configWritten).toBe(true);
      expect(plan.rule).toMatchObject({
        ruleType: 'rsc-flight',
        requestMethod: 'GET',
        matchMode: 'prefix',
        targetAssetUrl: 'https://example.com/products?_rsc=',
        rscFlight: {
          productionMode: 'structured-flight-v1',
          source: 'cdp-response',
          patchKind: 'string-value-text',
          requestHeaders: {
            rsc: '1',
          },
        },
      });
      expect(plan.rule?.rscFlight?.originalSha256).toBe(plan.originalSha256);
      expect(plan.rule?.rscFlight?.patchedSha256).toBe(plan.patchedSha256);
      expect(plan.localFilePath && readFileSync(plan.localFilePath, 'utf8')).toContain('Override debugging kits');

      const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
        profiles: Array<{ rules: Array<{ rscFlight?: { patchedSha256?: string } }> }>;
      };
      expect(config.profiles[0]?.rules[0]?.rscFlight?.patchedSha256).toBe(plan.patchedSha256);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('rejects production RSC patches that do not target safe string payload values', () => {
    const base = {
      targetUrl: 'https://example.com/products?_rsc=',
      matchMode: 'prefix',
      captureMode: 'cdp-response',
      contentType: 'text/x-component; charset=utf-8',
      responseBodyText: '1:["$","h1",null,{"children":"Original debugging kits"}]',
      requestHeaders: {
        RSC: '1',
      },
    };

    expect(() => planOverrideResponsePatch({
      ...base,
      textPatches: [{ search: 'children', replacement: 'content', expectedCount: 1 }],
      writeConfig: true,
    })).toThrow('matched a JSON object key');

    expect(() => planOverrideResponsePatch({
      ...base,
      textPatches: [{ search: '1:', replacement: '2:', expectedCount: 1 }],
      writeConfig: true,
    })).toThrow('outside a JSON string payload');

    expect(() => planOverrideResponsePatch({
      ...base,
      textPatches: [{ search: '$', replacement: 'not-rsc', expectedCount: 1 }],
      writeConfig: true,
    })).toThrow('RSC protocol reference token');
  });

  it('plans production RSC replacements that require JSON string escaping', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'override-response-rsc-escaped-'));
    const configPath = join(fixtureRoot, 'override-poc.local.json');

    try {
      const plan = planOverrideResponsePatch({
        targetUrl: 'https://example.com/products?_rsc=',
        matchMode: 'prefix',
        captureMode: 'cdp-response',
        contentType: 'text/x-component; charset=utf-8',
        responseBodyText: '1:["$","h1",null,{"children":"Original debugging kits"}]',
        textPatches: [{
          search: 'Original debugging kits',
          replacement: 'Override "quoted" kits',
          expectedCount: 1,
        }],
        configPath,
        writeConfig: true,
        overwrite: false,
        profileId: 'rsc-production-escaped',
      });

      expect(plan.blockers).toEqual([]);
      expect(plan.rule?.rscFlight).toMatchObject({
        productionMode: 'structured-flight-v1',
        patchKind: 'string-value-text',
      });
      const localBody = readFileSync(plan.localFilePath ?? '', 'utf8');
      expect(localBody).toContain('Override \\"quoted\\" kits');
      expect(JSON.parse(localBody.slice(localBody.indexOf(':') + 1))).toEqual([
        '$',
        'h1',
        null,
        { children: 'Override "quoted" kits' },
      ]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('rejects Next.js server action replay plans before patch generation', () => {
    expect(() => planOverrideResponsePatch({
      targetUrl: 'https://example.com/server-actions',
      ruleType: 'rsc-flight',
      requestMethod: 'POST',
      requestHeaders: {
        'next-action': 'fixture-action',
        rsc: '1',
      },
      contentType: 'text/x-component; charset=utf-8',
      responseBodyText: '1:["$","div",null,{"children":"Original server action payload"}]',
      textPatches: [{ search: 'Original server action payload', replacement: 'Override server action payload', expectedCount: 1 }],
    })).toThrow('SERVER_ACTION_UNSUPPORTED');
  });

  it('rejects generic mutation replay plans before patch generation', () => {
    expect(() => planOverrideResponsePatch({
      targetUrl: 'https://example.com/api/mutation-signal',
      ruleType: 'api-response',
      requestMethod: 'POST',
      requestHeaders: {
        'content-type': 'application/json',
      },
      contentType: 'application/json; charset=utf-8',
      responseBodyText: '{"mode":"original","message":"Original mutation response"}',
      jsonPatches: [{ path: '/mode', value: 'override' }],
    })).toThrow('MUTATION_REPLAY_UNSUPPORTED');
  });

  it('rejects unsupported binary content types before writing files', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'override-response-binary-'));

    expect(() => planOverrideResponsePatch({
      targetUrl: 'https://example.com/image.png',
      contentType: 'image/png',
      responseBodyText: 'not really a png',
      textPatches: [{ search: 'png', replacement: 'patched' }],
      outputRoot: fixtureRoot,
      writeBody: true,
    })).toThrow('not supported for response patching');
  });

  it('enforces body byte limits for original and patched bodies', () => {
    expect(() => planOverrideResponsePatch({
      targetUrl: 'https://example.com/api',
      contentType: 'text/plain',
      responseBodyText: 'abcdef',
      maxBodyBytes: 5,
      textPatches: [{ search: 'abc', replacement: 'xyz' }],
    })).toThrow('above maxBodyBytes 5');

    expect(() => planOverrideResponsePatch({
      targetUrl: 'https://example.com/api',
      contentType: 'text/plain',
      responseBodyText: 'abc',
      maxBodyBytes: 5,
      textPatches: [{ search: 'abc', replacement: 'abcdef' }],
    })).toThrow('Patched response body is 6 byte');
  });

  it('checks exact patch counts and required searches', () => {
    expect(() => planOverrideResponsePatch({
      targetUrl: 'https://example.com/page',
      contentType: 'text/html',
      responseBodyText: '<p>same</p><p>same</p>',
      textPatches: [{ search: 'same', replacement: 'changed', expectedCount: 1 }],
    })).toThrow('expected 1');

    expect(() => planOverrideResponsePatch({
      targetUrl: 'https://example.com/page',
      contentType: 'text/html',
      responseBodyText: '<p>same</p>',
      textPatches: [{ search: 'missing', replacement: 'changed' }],
    })).toThrow('was not found');
  });

  it('keeps JSON response bodies valid after patching', () => {
    const validPlan = planOverrideResponsePatch({
      targetUrl: 'https://example.com/api/products',
      ruleType: 'api-response',
      contentType: 'application/json; charset=utf-8',
      responseBodyText: '{"headline":"Original"}',
      textPatches: [{ search: 'Original', replacement: 'Patched' }],
    });

    expect(validPlan.patchedSha256).not.toBe(validPlan.originalSha256);

    expect(() => planOverrideResponsePatch({
      targetUrl: 'https://example.com/api/products',
      ruleType: 'api-response',
      contentType: 'application/json; charset=utf-8',
      responseBodyText: '{"headline":"Original"}',
      textPatches: [{ search: '"Original"', replacement: 'Patched without quotes' }],
    })).toThrow('Patched response body must remain valid JSON');
  });

  it('applies structured JSON response patches and writes generated override bodies', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'override-response-json-patch-'));
    const configPath = join(fixtureRoot, 'override-poc.local.json');

    try {
      const plan = planOverrideResponsePatch({
        targetUrl: 'https://example.com/api/products',
        ruleType: 'api-response',
        contentType: 'application/json; charset=utf-8',
        responseBodyText: '{"pageProps":{"headline":"Original","count":1},"items":[{"label":"Old"}]}',
        jsonPatches: [
          { path: '/pageProps/headline', value: 'Patched', expectedValue: 'Original' },
          { path: '/pageProps/count', value: 2, expectedValue: 1 },
          { path: '/items/0/label', value: 'New' },
        ],
        configPath,
        writeConfig: true,
        overwrite: false,
        profileId: 'json-response',
      });

      expect(plan.patches).toEqual([]);
      expect(plan.jsonPatches).toHaveLength(3);
      expect(plan.jsonPatches[0]).toMatchObject({
        operation: 'replace',
        path: '/pageProps/headline',
        previousValue: 'Original',
        value: 'Patched',
      });
      expect(plan.configWritten).toBe(true);
      expect(plan.rule).toMatchObject({
        ruleType: 'api-response',
        targetAssetUrl: 'https://example.com/api/products',
      });

      const generated = JSON.parse(readFileSync(plan.localFilePath ?? '', 'utf8')) as {
        pageProps: { headline: string; count: number };
        items: Array<{ label: string }>;
      };
      expect(generated.pageProps).toEqual({ headline: 'Patched', count: 2 });
      expect(generated.items[0]?.label).toBe('New');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('rejects unsafe or mismatched structured JSON response patches', () => {
    const base = {
      targetUrl: 'https://example.com/api/products',
      ruleType: 'api-response',
      contentType: 'application/json; charset=utf-8',
      responseBodyText: '{"pageProps":{"headline":"Original"},"items":[{"label":"Old"}]}',
    };

    expect(() => planOverrideResponsePatch({
      ...base,
      textPatches: [{ search: 'Original', replacement: 'Patched' }],
      jsonPatches: [{ path: '/pageProps/headline', value: 'Patched' }],
    })).toThrow('Provide exactly one of textPatches, jsonPatches, or documentPatches');

    expect(() => planOverrideResponsePatch({
      ...base,
      jsonPatches: [{ path: '/pageProps/missing', value: 'Patched' }],
    })).toThrow('JSON patch path does not exist');

    expect(() => planOverrideResponsePatch({
      ...base,
      jsonPatches: [{ path: '/pageProps/headline', value: 'Patched', expectedValue: 'Different' }],
    })).toThrow('expected value did not match');

    expect(() => planOverrideResponsePatch({
      ...base,
      jsonPatches: [{ path: '/items/-/label', value: 'Patched' }],
    })).toThrow('expected an array index');

    expect(() => planOverrideResponsePatch({
      ...base,
      jsonPatches: [{ path: '/__proto__/polluted', value: true }],
    })).toThrow('unsafe segment');
  });

  it('keeps structured JSON patches out of non-JSON and RSC response bodies', () => {
    expect(() => planOverrideResponsePatch({
      targetUrl: 'https://example.com/page',
      ruleType: 'document',
      contentType: 'text/html; charset=utf-8',
      responseBodyText: '<h1>Original</h1>',
      jsonPatches: [{ path: '/headline', value: 'Patched' }],
    })).toThrow('jsonPatches are only supported');

    expect(() => planOverrideResponsePatch({
      targetUrl: 'https://example.com/products?_rsc=abc',
      contentType: 'text/x-component; charset=utf-8',
      responseBodyText: '1:["$","span",null,{"children":"Original"}]',
      jsonPatches: [{ path: '/children', value: 'Patched' }],
    })).toThrow('jsonPatches are only supported');
  });

  it('refuses to overwrite an existing config when overwrite is false', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'override-response-overwrite-'));
    const configPath = join(fixtureRoot, 'override-poc.local.json');
    writeFileSync(configPath, '{}\n', 'utf8');

    expect(() => planOverrideResponsePatch({
      targetUrl: 'https://example.com/page',
      contentType: 'text/html',
      responseBodyText: '<h1>Original</h1>',
      textPatches: [{ search: 'Original', replacement: 'Patched' }],
      configPath,
      writeConfig: true,
      overwrite: false,
    })).toThrow('Refusing to overwrite existing override config');
  });
});
