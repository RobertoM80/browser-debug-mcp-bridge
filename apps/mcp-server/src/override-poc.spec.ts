import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getOverridePocAssetResponse,
  getOverridePocConfigSummary,
  resolveOverridePocConfigPath,
} from './override-poc.js';
import { createOverrideProfileConfig } from './override-profile-generator.js';
import { createNextAssetIndex, mapNextOverrideAssets, mapNextOverrideAssetsWithDrift } from './next-asset-mapper.js';
import { cleanupNextSourceOverlayRoots } from './next-source-override-planner.js';

const originalOverrideConfigPath = process.env.OVERRIDE_POC_CONFIG_PATH;

afterEach(() => {
  if (originalOverrideConfigPath === undefined) {
    delete process.env.OVERRIDE_POC_CONFIG_PATH;
    return;
  }

  process.env.OVERRIDE_POC_CONFIG_PATH = originalOverrideConfigPath;
});

async function withAssetServer(body: string, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    response.end(body);
  });

  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to allocate test server port');
  }

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }
}

function createConfigFixture(): { configPath: string; assetUrl: string; assetBody: string } {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'override-poc-'));
  const outputDir = join(fixtureRoot, '.next', 'static', 'chunks', 'app');
  mkdirSync(outputDir, { recursive: true });

  const assetBody = 'console.log("override poc works");';
  const localAssetPath = join(outputDir, 'page-local.js');
  writeFileSync(localAssetPath, assetBody, 'utf8');

  const assetUrl = 'https://example.com/_next/static/chunks/app/page-prod.js';
  const configPath = join(fixtureRoot, 'override-poc.config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      enabled: true,
      targetAssetUrl: assetUrl,
      localFilePath: '.next/static/chunks/app/page-local.js',
      contentType: 'application/javascript; charset=utf-8',
      autoReload: true,
    }),
    'utf8',
  );

  return {
    configPath,
    assetUrl,
    assetBody,
  };
}

describe('override-poc config', () => {
  it('resolves relative local file paths from the config file directory', () => {
    const fixture = createConfigFixture();
    const summary = getOverridePocConfigSummary(fixture.configPath);

    expect(summary.enabled).toBe(true);
    expect(summary.fileExists).toBe(true);
    expect(summary.resolvedLocalFilePath).toContain('.next');
    expect(summary.fileSizeBytes).toBeGreaterThan(0);
  });

  it('does not use the deprecated root enabled flag as a runtime gate', () => {
    const fixture = createConfigFixture();
    writeFileSync(
      fixture.configPath,
      JSON.stringify({
        enabled: false,
        targetAssetUrl: fixture.assetUrl,
        localFilePath: '.next/static/chunks/app/page-local.js',
        contentType: 'application/javascript; charset=utf-8',
        autoReload: true,
      }),
      'utf8',
    );

    const summary = getOverridePocConfigSummary(fixture.configPath);
    const response = getOverridePocAssetResponse(fixture.assetUrl, fixture.configPath);

    expect(summary.configEnabled).toBe(false);
    expect(summary.enabled).toBe(true);
    expect(response.buffer.toString('utf8')).toBe(fixture.assetBody);
  });

  it('returns the configured asset bytes for an exact URL match', () => {
    const fixture = createConfigFixture();
    const response = getOverridePocAssetResponse(fixture.assetUrl, fixture.configPath);

    expect(response.contentType).toBe('application/javascript; charset=utf-8');
    expect(response.buffer.toString('utf8')).toBe(fixture.assetBody);
    expect(response.summary.targetAssetUrl).toBe(fixture.assetUrl);
    expect(response.rule.ruleId).toBe('default');
  });

  it('requires exact request method matches when serving duplicate target URLs', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'override-poc-method-'));
    const getPath = join(fixtureRoot, 'get.json');
    const postPath = join(fixtureRoot, 'post.json');
    const configPath = join(fixtureRoot, 'override-poc.config.json');
    writeFileSync(getPath, '{"mode":"get"}', 'utf8');
    writeFileSync(postPath, '{"mode":"post"}', 'utf8');
    writeFileSync(
      configPath,
      JSON.stringify({
        enabled: true,
        activeProfileId: 'methods',
        profiles: [{
          profileId: 'methods',
          name: 'Method rules',
          enabled: true,
          autoReload: true,
          rules: [
            {
              ruleId: 'get-rule',
              ruleType: 'api-response',
              requestMethod: 'GET',
              targetAssetUrl: 'https://example.com/api/products',
              localFilePath: './get.json',
              contentType: 'application/json; charset=utf-8',
            },
            {
              ruleId: 'post-rule',
              ruleType: 'api-response',
              requestMethod: 'POST',
              targetAssetUrl: 'https://example.com/api/products',
              localFilePath: './post.json',
              contentType: 'application/json; charset=utf-8',
            },
          ],
        }],
      }),
      'utf8',
    );

    const getResponse = getOverridePocAssetResponse('https://example.com/api/products', configPath, 'GET');
    const postResponse = getOverridePocAssetResponse('https://example.com/api/products', configPath, 'post');

    expect(getResponse.rule.ruleId).toBe('get-rule');
    expect(getResponse.buffer.toString('utf8')).toContain('"get"');
    expect(postResponse.rule.ruleId).toBe('post-rule');
    expect(postResponse.buffer.toString('utf8')).toContain('"post"');
  });

  it('serves multiple enabled rules from the active profile', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'override-poc-profile-'));
    const firstLocalPath = join(fixtureRoot, 'first.js');
    const secondLocalPath = join(fixtureRoot, 'second.js');
    const configPath = join(fixtureRoot, 'override-poc.config.json');
    writeFileSync(firstLocalPath, 'console.log("first override");', 'utf8');
    writeFileSync(secondLocalPath, 'console.log("second override");', 'utf8');
    writeFileSync(
      configPath,
      JSON.stringify({
        enabled: true,
        activeProfileId: 'local-dev',
        profiles: [{
          profileId: 'local-dev',
          name: 'Local development overrides',
          enabled: true,
          autoReload: true,
          rules: [
            {
              ruleId: 'first',
              targetAssetUrl: 'https://example.com/first.js',
              localFilePath: './first.js',
              contentType: 'application/javascript; charset=utf-8',
            },
            {
              ruleId: 'second',
              targetAssetUrl: 'https://example.com/second.js',
              localFilePath: './second.js',
              contentType: 'application/javascript; charset=utf-8',
            },
          ],
        }],
      }),
      'utf8',
    );

    const summary = getOverridePocConfigSummary(configPath);
    const secondResponse = getOverridePocAssetResponse('https://example.com/second.js', configPath);

    expect(summary.profileId).toBe('local-dev');
    expect(summary.ruleCount).toBe(2);
    expect(summary.enabledRuleCount).toBe(2);
    expect(summary.fileExists).toBe(true);
    expect(secondResponse.rule.ruleId).toBe('second');
    expect(secondResponse.buffer.toString('utf8')).toContain('second override');
  });

  it('rejects non-matching asset URLs', () => {
    const fixture = createConfigFixture();

    expect(() => {
      getOverridePocAssetResponse('https://example.com/_next/static/chunks/app/other.js', fixture.configPath);
    }).toThrow('does not match');
  });

  it('prefers override-poc.local.json over the checked-in default config path', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'override-poc-local-'));
    const defaultConfigPath = join(fixtureRoot, 'override-poc.config.json');
    const localConfigPath = join(fixtureRoot, 'override-poc.local.json');

    writeFileSync(
      defaultConfigPath,
      JSON.stringify({
        enabled: false,
        targetAssetUrl: 'https://example.com/default.js',
        localFilePath: '.next/static/chunks/default.js',
        contentType: 'application/javascript; charset=utf-8',
        autoReload: false,
      }),
      'utf8',
    );
    writeFileSync(
      localConfigPath,
      JSON.stringify({
        enabled: true,
        targetAssetUrl: 'https://example.com/local.js',
        localFilePath: '.next/static/chunks/local.js',
        contentType: 'application/javascript; charset=utf-8',
        autoReload: true,
      }),
      'utf8',
    );

    const resolvedPath = resolveOverridePocConfigPath(undefined, process.env, defaultConfigPath);
    const summary = getOverridePocConfigSummary(resolvedPath);

    expect(resolvedPath).toBe(localConfigPath);
    expect(summary.configPath).toBe(localConfigPath);
    expect(summary.enabled).toBe(true);
    expect(summary.targetAssetUrl).toBe('https://example.com/local.js');
  });

  it('prefers OVERRIDE_POC_CONFIG_PATH over automatic local-config discovery', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'override-poc-env-'));
    const defaultConfigPath = join(fixtureRoot, 'override-poc.config.json');
    const envConfigPath = join(fixtureRoot, 'custom-override.json');

    writeFileSync(
      defaultConfigPath,
      JSON.stringify({
        enabled: false,
        targetAssetUrl: 'https://example.com/default.js',
        localFilePath: '.next/static/chunks/default.js',
        contentType: 'application/javascript; charset=utf-8',
        autoReload: false,
      }),
      'utf8',
    );
    writeFileSync(
      join(fixtureRoot, 'override-poc.local.json'),
      JSON.stringify({
        enabled: true,
        targetAssetUrl: 'https://example.com/local.js',
        localFilePath: '.next/static/chunks/local.js',
        contentType: 'application/javascript; charset=utf-8',
        autoReload: true,
      }),
      'utf8',
    );
    writeFileSync(
      envConfigPath,
      JSON.stringify({
        enabled: true,
        targetAssetUrl: 'https://example.com/env.js',
        localFilePath: '.next/static/chunks/env.js',
        contentType: 'application/javascript; charset=utf-8',
        autoReload: true,
      }),
      'utf8',
    );

    process.env.OVERRIDE_POC_CONFIG_PATH = envConfigPath;

    const resolvedPath = resolveOverridePocConfigPath(undefined, process.env, defaultConfigPath);
    const summary = getOverridePocConfigSummary(resolvedPath);

    expect(resolvedPath).toBe(envConfigPath);
    expect(summary.configPath).toBe(envConfigPath);
    expect(summary.targetAssetUrl).toBe('https://example.com/env.js');
  });

  it('preserves prefix match mode for response override rules', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'override-poc-prefix-'));
    const configPath = join(fixtureRoot, 'override-poc.local.json');
    const bodyPath = join(fixtureRoot, 'about.rsc');

    try {
      writeFileSync(bodyPath, '1:["$","h1",null,{"children":"Override proof"}]', 'utf8');
      writeFileSync(
        configPath,
        JSON.stringify({
          enabled: true,
          activeProfileId: 'rsc',
          profiles: [{
            profileId: 'rsc',
            name: 'RSC prefix',
            enabled: true,
            autoReload: true,
            rules: [{
              ruleId: 'about-rsc',
              enabled: true,
              ruleType: 'rsc-flight',
              requestMethod: 'GET',
              matchMode: 'prefix',
              targetAssetUrl: 'https://example.com/about?_rsc=',
              localFilePath: './about.rsc',
              contentType: 'text/x-component',
            }],
          }],
        }, null, 2),
        'utf8',
      );

      const summary = getOverridePocConfigSummary(configPath);
      expect(summary.matchMode).toBe('prefix');
      expect(summary.rules[0]?.matchMode).toBe('prefix');

      const response = getOverridePocAssetResponse('https://example.com/about?_rsc=', configPath, 'GET');
      expect(response.rule.matchMode).toBe('prefix');
      expect(response.buffer.toString('utf8')).toContain('Override proof');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('generates Next.js candidate profiles from manifests and static assets', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'override-poc-next-profile-'));
    const chunksDir = join(fixtureRoot, '.next', 'static', 'chunks');
    const cssDir = join(fixtureRoot, '.next', 'static', 'css');
    mkdirSync(chunksDir, { recursive: true });
    mkdirSync(cssDir, { recursive: true });
    writeFileSync(join(chunksDir, 'main.js'), 'console.log("main");', 'utf8');
    writeFileSync(join(chunksDir, 'lazy.js'), 'console.log("lazy");', 'utf8');
    writeFileSync(join(cssDir, 'app.css'), 'body { color: red; }', 'utf8');
    writeFileSync(
      join(fixtureRoot, '.next', 'build-manifest.json'),
      JSON.stringify({
        pages: {
          '/': ['static/chunks/main.js', '/_next/static/css/app.css', 'static/chunks/missing.js'],
        },
      }),
      'utf8',
    );

    const generated = createOverrideProfileConfig({
      adapter: 'nextjs',
      projectRoot: fixtureRoot,
      targetBaseUrl: 'https://cdn.example.com/_next/',
    });

    expect(generated.adapter).toBe('nextjs');
    expect(generated.nextDir).toBe(join(fixtureRoot, '.next'));
    expect(generated.ruleCount).toBe(3);
    expect(generated.missingManifestAssetCount).toBe(1);
    expect(generated.config.enabled).toBe(true);
    expect(generated.rules.map((rule) => rule.targetAssetUrl)).toContain('https://cdn.example.com/_next/static/chunks/main.js');
    expect(generated.rules.map((rule) => rule.localFilePath)).toContain('.next/static/chunks/main.js');
    expect(generated.rules.find((rule) => rule.localFilePath.endsWith('app.css'))?.contentType).toBe('text/css; charset=utf-8');
    expect(generated.nextActions.some((action) => action.code === 'REVIEW_ASSET_URLS')).toBe(true);

    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('generates generic static candidate profiles for framework-neutral builds', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'override-poc-static-profile-'));
    const assetsDir = join(fixtureRoot, 'dist', 'assets');
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, 'app.js'), 'console.log("app");', 'utf8');
    writeFileSync(join(assetsDir, 'app.css'), 'body { color: blue; }', 'utf8');

    const generated = createOverrideProfileConfig({
      adapter: 'static',
      projectRoot: fixtureRoot,
      assetRoot: 'dist/assets',
      targetBaseUrl: 'https://example.com/assets/',
    });

    expect(generated.adapter).toBe('static');
    expect(generated.assetRoot).toBe(assetsDir);
    expect(generated.profile.profileId).toBe('static-local');
    expect(generated.ruleCount).toBe(2);
    expect(generated.warnings.some((warning) => warning.includes('/_next/'))).toBe(false);
    expect(generated.rules.map((rule) => rule.targetAssetUrl)).toEqual([
      'https://example.com/assets/app.css',
      'https://example.com/assets/app.js',
    ]);

    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('maps observed Next.js assets to local chunks and source paths', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'next-asset-map-'));
    try {
      const chunkDir = join(fixtureRoot, '.next', 'static', 'chunks', 'app');
      mkdirSync(chunkDir, { recursive: true });
      const chunkPath = join(chunkDir, 'home.js');
      writeFileSync(chunkPath, 'console.log("home chunk");\n', 'utf8');
      writeFileSync(
        `${chunkPath}.map`,
        JSON.stringify({
          version: 3,
          sources: ['webpack://_N_E/./src/app/page.tsx', 'webpack://_N_E/./src/app/scenario-boot.tsx'],
          mappings: '',
        }),
        'utf8',
      );

      const result = mapNextOverrideAssets({
        projectRoot: fixtureRoot,
        observedAssets: [{
          url: 'https://www.example.com/_next/static/chunks/app/home.js',
          kind: 'script',
          fromDom: true,
        }],
        sourcePaths: ['src/app/scenario-boot.tsx'],
      });

      expect(result.observedNextAssetCount).toBe(1);
      expect(result.indexedAssetCount).toBe(1);
      expect(result.candidates[0]).toMatchObject({
        targetAssetUrl: 'https://www.example.com/_next/static/chunks/app/home.js',
        assetPath: 'static/chunks/app/home.js',
        confidence: 'high',
        matchedSourcePaths: ['src/app/scenario-boot.tsx'],
      });
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('separates direct source-map ownership from client-reference chunk membership', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'next-asset-source-split-'));
    try {
      const chunkDir = join(fixtureRoot, '.next', 'static', 'chunks');
      const manifestDir = join(fixtureRoot, '.next', 'server', 'app', 'about');
      mkdirSync(chunkDir, { recursive: true });
      mkdirSync(manifestDir, { recursive: true });

      const sharedChunkPath = join(chunkDir, 'shared.js');
      writeFileSync(sharedChunkPath, 'console.log("shared next/link chunk");\n', 'utf8');
      writeFileSync(
        `${sharedChunkPath}.map`,
        JSON.stringify({
          version: 3,
          sources: ['webpack://_N_E/./node_modules/next/dist/client/app-dir/link.js'],
          mappings: '',
        }),
        'utf8',
      );

      const pageChunkPath = join(chunkDir, 'page.js');
      writeFileSync(pageChunkPath, 'console.log("scenario chunk");\n', 'utf8');
      writeFileSync(
        `${pageChunkPath}.map`,
        JSON.stringify({
          version: 3,
          sources: ['webpack://_N_E/./src/app/scenario-boot.tsx'],
          mappings: '',
        }),
        'utf8',
      );

      writeFileSync(
        join(manifestDir, 'page_client-reference-manifest.js'),
        `globalThis.__RSC_MANIFEST["/about/page"] = ${JSON.stringify({
          clientModules: {
            '[project]/apps/override-next-fixture/src/app/scenario-boot.tsx': {
              chunks: [
                '/_next/static/chunks/shared.js',
                '/_next/static/chunks/page.js',
              ],
            },
          },
        })};`,
        'utf8',
      );

      const index = createNextAssetIndex(fixtureRoot);
      const shared = index.byAssetPath.get('static/chunks/shared.js');
      const page = index.byAssetPath.get('static/chunks/page.js');

      expect(shared?.manifestSources).toContain('[project]/apps/override-next-fixture/src/app/scenario-boot.tsx');
      expect(shared?.sources).toContain('[project]/apps/override-next-fixture/src/app/scenario-boot.tsx');
      expect(shared?.sourceMapSources).not.toContain('[project]/apps/override-next-fixture/src/app/scenario-boot.tsx');
      expect(page?.sourceMapSources).toContain('src/app/scenario-boot.tsx');
      expect(page?.manifestSources).toContain('[project]/apps/override-next-fixture/src/app/scenario-boot.tsx');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('checks production/local drift for mapped Next.js assets', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'next-asset-drift-'));
    try {
      const chunkDir = join(fixtureRoot, '.next', 'static', 'chunks', 'app');
      mkdirSync(chunkDir, { recursive: true });
      const chunkBody = 'console.log("same chunk");\n';
      const chunkPath = join(chunkDir, 'home.js');
      writeFileSync(chunkPath, chunkBody, 'utf8');
      writeFileSync(
        `${chunkPath}.map`,
        JSON.stringify({
          version: 3,
          sources: ['webpack://_N_E/./src/app/page.tsx'],
          mappings: '',
        }),
        'utf8',
      );

      await withAssetServer(chunkBody, async (baseUrl) => {
        const result = await mapNextOverrideAssetsWithDrift({
          projectRoot: fixtureRoot,
          observedAssets: [{
            url: `${baseUrl}/_next/static/chunks/app/home.js`,
            kind: 'script',
            fromDom: true,
          }],
          sourcePaths: ['src/app/page.tsx'],
          fetchProductionAssets: true,
          productionFetchConcurrency: 2,
        });

        expect(result.driftSummary).toMatchObject({ checked: 1, matched: 1, different: 0, skipped: 0, concurrency: 2 });
        expect(result.candidates[0]?.drift).toMatchObject({ status: 'matched' });
        expect(result.candidates[0]?.blockers).not.toContain('PRODUCTION_LOCAL_DRIFT');
      });

      await withAssetServer('console.log("different chunk");\n', async (baseUrl) => {
        const result = await mapNextOverrideAssetsWithDrift({
          projectRoot: fixtureRoot,
          observedAssets: [{
            url: `${baseUrl}/_next/static/chunks/app/home.js`,
            kind: 'script',
            fromDom: true,
          }],
          sourcePaths: ['src/app/page.tsx'],
          fetchProductionAssets: true,
        });

        expect(result.driftSummary).toMatchObject({ checked: 1, matched: 0, different: 1 });
        expect(result.candidates[0]?.drift).toMatchObject({ status: 'different' });
        expect(result.candidates[0]?.blockers).toContain('PRODUCTION_LOCAL_DRIFT');
      });
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('bounds production/local drift checks for large candidate sets', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'next-asset-drift-limit-'));
    try {
      const chunkDir = join(fixtureRoot, '.next', 'static', 'chunks', 'app');
      mkdirSync(chunkDir, { recursive: true });
      for (const chunkName of ['one.js', 'two.js', 'three.js']) {
        writeFileSync(join(chunkDir, chunkName), 'console.log("bounded");\n', 'utf8');
      }

      await withAssetServer('console.log("bounded");\n', async (baseUrl) => {
        const result = await mapNextOverrideAssetsWithDrift({
          projectRoot: fixtureRoot,
          observedAssets: [
            { url: `${baseUrl}/_next/static/chunks/app/one.js`, kind: 'script', fromDom: true },
            { url: `${baseUrl}/_next/static/chunks/app/two.js`, kind: 'script', fromDom: true },
            { url: `${baseUrl}/_next/static/chunks/app/three.js`, kind: 'script', fromDom: true },
          ],
          fetchProductionAssets: true,
          maxDriftCandidates: 2,
          productionFetchConcurrency: 2,
        });

        expect(result.driftSummary).toMatchObject({ checked: 2, skipped: 1, maxChecked: 2, concurrency: 2 });
        expect(result.candidates.filter((candidate) => candidate.drift).length).toBe(2);
        expect(result.warnings.some((warning) => warning.includes('maxDriftCandidates=2'))).toBe(true);
      });
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('marks oversized production assets without reading beyond configured cap', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'next-asset-drift-large-'));
    try {
      const chunkDir = join(fixtureRoot, '.next', 'static', 'chunks', 'app');
      mkdirSync(chunkDir, { recursive: true });
      writeFileSync(join(chunkDir, 'large.js'), 'console.log("local");\n', 'utf8');

      await withAssetServer('x'.repeat(2048), async (baseUrl) => {
        const result = await mapNextOverrideAssetsWithDrift({
          projectRoot: fixtureRoot,
          observedAssets: [{
            url: `${baseUrl}/_next/static/chunks/app/large.js`,
            kind: 'script',
            fromDom: true,
          }],
          fetchProductionAssets: true,
          maxProductionAssetBytes: 1024,
        });

        expect(result.driftSummary).toMatchObject({ checked: 1, tooLarge: 1 });
        expect(result.candidates[0]?.drift).toMatchObject({ status: 'too_large' });
        expect(result.candidates[0]?.blockers).not.toContain('PRODUCTION_LOCAL_DRIFT');
      });
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('cleans expired Next.js source overlay folders', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'next-overlay-cleanup-'));
    try {
      mkdirSync(join(workspaceRoot, 'tmp', 'bn', 'old-a'), { recursive: true });
      mkdirSync(join(workspaceRoot, 'tmp', 'bn', 'old-b'), { recursive: true });

      const removed = cleanupNextSourceOverlayRoots(workspaceRoot, 0);

      expect(removed).toBe(2);
      expect(existsSync(join(workspaceRoot, 'tmp', 'bn', 'old-a'))).toBe(false);
      expect(existsSync(join(workspaceRoot, 'tmp', 'bn', 'old-b'))).toBe(false);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('preserves unexpired Next.js source overlay folders', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'next-overlay-keep-'));
    const overlayPath = join(workspaceRoot, 'tmp', 'bn', 'fresh');
    try {
      mkdirSync(overlayPath, { recursive: true });

      const removed = cleanupNextSourceOverlayRoots(workspaceRoot, 60_000, Date.now());

      expect(removed).toBe(0);
      expect(existsSync(overlayPath)).toBe(true);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
