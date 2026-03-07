import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  getOverridePocAssetResponse,
  getOverridePocConfigSummary,
} from './override-poc.js';

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

  it('returns the configured asset bytes for an exact URL match', () => {
    const fixture = createConfigFixture();
    const response = getOverridePocAssetResponse(fixture.assetUrl, fixture.configPath);

    expect(response.contentType).toBe('application/javascript; charset=utf-8');
    expect(response.buffer.toString('utf8')).toBe(fixture.assetBody);
    expect(response.summary.targetAssetUrl).toBe(fixture.assetUrl);
  });

  it('rejects non-matching asset URLs', () => {
    const fixture = createConfigFixture();

    expect(() => {
      getOverridePocAssetResponse('https://example.com/_next/static/chunks/app/other.js', fixture.configPath);
    }).toThrow('does not match');
  });
});
