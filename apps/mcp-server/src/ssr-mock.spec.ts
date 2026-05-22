import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  applySsrMockConfig,
  discoverSsrMockability,
  removeSsrMockConfig,
} from './ssr-mock.js';

describe('ssr-mock discovery', () => {
  it('finds env-driven SSR base URL candidates', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'ssr-mock-discovery-'));
    writeFileSync(join(projectRoot, '.env.local'), 'API_BASE_URL=https://api.example.com\n', 'utf8');
    writeFileSync(
      join(projectRoot, 'server-client.ts'),
      [
        "const apiBaseUrl = process.env.API_BASE_URL ?? 'https://api.example.com';",
        "export async function getProducts() {",
        "  return fetch(`${apiBaseUrl}/products`);",
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = discoverSsrMockability({
      projectRoot,
      targetUrl: 'https://api.example.com/products',
    });

    expect(result.classification).toBe('mockable-env');
    expect(result.mockable).toBe(true);
    expect(result.preferredEnvVarName).toBe('API_BASE_URL');
    expect(result.envVarCandidates).toContain('API_BASE_URL');
    expect(result.candidates.some((candidate) => candidate.kind === 'env-var')).toBe(true);
  });

  it('reports hardcoded SSR calls as not mockable', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'ssr-mock-hardcoded-'));
    writeFileSync(
      join(projectRoot, 'page.ts'),
      [
        'export async function loadData() {',
        "  return fetch('https://api.example.com/products');",
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = discoverSsrMockability({
      projectRoot,
      targetUrl: 'https://api.example.com/products',
    });

    expect(result.classification).toBe('not-mockable');
    expect(result.mockable).toBe(false);
    expect(result.hardcodedCallPaths).toContain('page.ts');
  });
});

describe('ssr-mock env patching', () => {
  it('comments the old env value and writes the mock value', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'ssr-mock-apply-'));
    const envFilePath = join(projectRoot, '.env.local');
    writeFileSync(envFilePath, 'API_BASE_URL=https://api.example.com\nNEXT_PUBLIC_APP=bridge\n', 'utf8');

    const applied = applySsrMockConfig({
      projectRoot,
      envVarName: 'API_BASE_URL',
      mockBaseUrl: 'http://127.0.0.1:8065/mock/ssr/run-1',
      rollbackId: 'run-1',
    });

    const text = readFileSync(envFilePath, 'utf8');
    expect(applied.mode).toBe('replaced-existing-value');
    expect(text).toContain('# BDMCP_MOCK_ORIGINAL run-1 API_BASE_URL=https://api.example.com');
    expect(text).toContain('API_BASE_URL=http://127.0.0.1:8065/mock/ssr/run-1');
    expect(text).toContain('NEXT_PUBLIC_APP=bridge');

    const removed = removeSsrMockConfig({
      envFilePath,
      envVarName: 'API_BASE_URL',
      rollbackId: 'run-1',
    });
    const restored = readFileSync(envFilePath, 'utf8');

    expect(removed.mode).toBe('restored-commented-value');
    expect(restored).toContain('API_BASE_URL=https://api.example.com');
    expect(restored).not.toContain('BDMCP_MOCK_ORIGINAL');
  });

  it('adds and removes a managed block when the env var is missing', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'ssr-mock-add-'));
    const envFilePath = join(projectRoot, '.env.local');
    writeFileSync(envFilePath, 'NEXT_PUBLIC_APP=bridge\n', 'utf8');

    const applied = applySsrMockConfig({
      projectRoot,
      envVarName: 'API_BASE_URL',
      mockBaseUrl: 'http://127.0.0.1:8065/mock/ssr/run-2',
      rollbackId: 'run-2',
    });

    const text = readFileSync(envFilePath, 'utf8');
    expect(applied.mode).toBe('added-new-value');
    expect(text).toContain('# BDMCP_MOCK_ADDED_START run-2 API_BASE_URL');
    expect(text).toContain('API_BASE_URL=http://127.0.0.1:8065/mock/ssr/run-2');
    expect(text).toContain('# BDMCP_MOCK_ADDED_END run-2 API_BASE_URL');

    const removed = removeSsrMockConfig({
      envFilePath,
      envVarName: 'API_BASE_URL',
      rollbackId: 'run-2',
    });
    const restored = readFileSync(envFilePath, 'utf8');

    expect(removed.mode).toBe('removed-added-block');
    expect(restored).toBe('NEXT_PUBLIC_APP=bridge\n');
  });
});
