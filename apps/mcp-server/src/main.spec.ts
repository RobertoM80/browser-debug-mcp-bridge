import { describe, it, expect } from 'vitest';
import { fastify } from './main.js';
import { clearDatabase, getConnection, initializeDatabase } from './db';
import { readFileSync } from 'fs';
import { listMockHits, listMockRuns, upsertMockRoute } from './mock-store';

describe('MCP Server', () => {
  it('should have fastify instance', () => {
    expect(fastify).toBeDefined();
  });

  it('should return health status', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/health'
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();
  });

  it('should return server info on root', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/'
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.name).toBe('Browser Debug MCP Bridge Server');
    expect(body.version).toBe('1.0.0');
  });

  it('should return debug stats', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/stats'
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.timestamp).toBeDefined();
    expect(typeof body.uptimeMs).toBe('number');
    expect(body.database).toBeDefined();
    expect(body.websocket).toBeDefined();
  });

  it('should import a session payload', async () => {
    initializeDatabase(getConnection().db);

    const response = await fastify.inject({
      method: 'POST',
      url: '/sessions/import',
      payload: {
        session: {
          session_id: 'main-import-test',
          created_at: 1700000000000,
          safe_mode: 1,
        },
        events: [],
        network: [],
        fingerprints: [],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.ok).toBe(true);
    expect(body.sessionId).toBeDefined();
  });

  it('should reject invalid import payload', async () => {
    initializeDatabase(getConnection().db);

    const response = await fastify.inject({
      method: 'POST',
      url: '/sessions/import',
      payload: {
        session: {},
        events: [],
        network: [],
        fingerprints: [],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.ok).toBe(false);
    expect(body.error).toContain('session_id');
  });

  it('should persist and list snapshots through HTTP APIs', async () => {
    initializeDatabase(getConnection().db);
    clearDatabase(getConnection().db);

    await fastify.inject({
      method: 'POST',
      url: '/sessions/import',
      payload: {
        session: {
          session_id: 'snapshot-api-test',
          created_at: 1700000000000,
          safe_mode: 0,
        },
        events: [],
        network: [],
        fingerprints: [],
      },
    });

    const writeResponse = await fastify.inject({
      method: 'POST',
      url: '/sessions/snapshot-api-test/snapshots',
      payload: {
        timestamp: 1700000000500,
        trigger: 'click',
        selector: '#buy',
        url: 'https://example.test/cart',
        mode: {
          dom: true,
          png: false,
          styleMode: 'computed-lite',
        },
        snapshot: {
          dom: { mode: 'html', html: '<button id="buy">Buy</button>' },
          styles: { nodes: [{ tag: 'BUTTON', css: { display: 'inline-block' } }] },
        },
        truncation: {
          dom: false,
          styles: false,
          png: false,
        },
      },
    });

    const writeBody = JSON.parse(writeResponse.body);
    expect(writeResponse.statusCode).toBe(200);
    expect(writeBody.ok).toBe(true);
    expect(writeBody.snapshotId).toBeDefined();

    const listResponse = await fastify.inject({
      method: 'GET',
      url: '/sessions/snapshot-api-test/snapshots?limit=10&offset=0',
    });
    const listBody = JSON.parse(listResponse.body);

    expect(listResponse.statusCode).toBe(200);
    expect(listBody.ok).toBe(true);
    expect(listBody.snapshots.length).toBe(1);
    expect(listBody.snapshots[0].trigger).toBe('click');
    expect(listBody.snapshots[0].selector).toBe('#buy');
  });

  it('should reject oversized snapshot dom payloads', async () => {
    initializeDatabase(getConnection().db);
    clearDatabase(getConnection().db);

    await fastify.inject({
      method: 'POST',
      url: '/sessions/import',
      payload: {
        session: {
          session_id: 'snapshot-api-limit-test',
          created_at: 1700000000000,
          safe_mode: 0,
        },
        events: [],
        network: [],
        fingerprints: [],
      },
    });

    const oversizedHtml = 'x'.repeat(600 * 1024);
    const response = await fastify.inject({
      method: 'POST',
      url: '/sessions/snapshot-api-limit-test/snapshots',
      payload: {
        timestamp: 1700000000600,
        trigger: 'manual',
        mode: {
          dom: true,
          png: false,
          styleMode: 'computed-lite',
        },
        snapshot: {
          dom: { mode: 'html', html: oversizedHtml },
        },
      },
    });

    const body = JSON.parse(response.body);
    expect(response.statusCode).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Snapshot dom payload exceeds max bytes');
  });

  it('should export zip package and import it back', async () => {
    initializeDatabase(getConnection().db);
    clearDatabase(getConnection().db);

    await fastify.inject({
      method: 'POST',
      url: '/sessions/import',
      payload: {
        session: {
          session_id: 'snapshot-zip-api-test',
          created_at: 1700000000000,
          safe_mode: 0,
        },
        events: [],
        network: [],
        fingerprints: [],
      },
    });

    await fastify.inject({
      method: 'POST',
      url: '/sessions/snapshot-zip-api-test/snapshots',
      payload: {
        timestamp: 1700000000700,
        trigger: 'manual',
        mode: { dom: true, png: false, styleMode: 'computed-lite' },
        snapshot: {
          dom: { mode: 'html', html: '<div>zip-api</div>' },
        },
      },
    });

    const exportResponse = await fastify.inject({
      method: 'POST',
      url: '/sessions/snapshot-zip-api-test/export',
      payload: { format: 'zip' },
    });
    const exportBody = JSON.parse(exportResponse.body) as { ok: boolean; format: string; snapshots: number; filePath: string };

    expect(exportResponse.statusCode).toBe(200);
    expect(exportBody.ok).toBe(true);
    expect(exportBody.format).toBe('zip');
    expect(exportBody.snapshots).toBe(1);

    const zipBase64 = readFileSync(exportBody.filePath).toString('base64');

    const importResponse = await fastify.inject({
      method: 'POST',
      url: '/sessions/import',
      payload: {
        format: 'zip',
        archiveBase64: zipBase64,
      },
    });

    const importBody = JSON.parse(importResponse.body);
    expect(importResponse.statusCode).toBe(200);
    expect(importBody.ok).toBe(true);
    expect(importBody.snapshots).toBe(1);
  });

  it('should persist, list, and diagnose override audit data through HTTP APIs', async () => {
    initializeDatabase(getConnection().db);
    clearDatabase(getConnection().db);

    await fastify.inject({
      method: 'POST',
      url: '/sessions/import',
      payload: {
        session: {
          session_id: 'override-audit-test',
          created_at: 1700000000000,
          safe_mode: 0,
        },
        events: [],
        network: [],
        fingerprints: [],
      },
    });

    const runResponse = await fastify.inject({
      method: 'POST',
      url: '/sessions/override-audit-test/overrides/runs',
      payload: {
        runId: 'run-1',
        startedAt: 1700000000100,
        runStatus: 'active',
        tabId: 17,
        selectedTabId: 17,
        targetAssetUrl: 'https://example.com/_next/static/chunks/app.js',
        localFilePath: './app-local.js',
        resolvedLocalFilePath: 'C:/repo/app-local.js',
        contentType: 'application/javascript; charset=utf-8',
        autoReload: true,
        configPath: 'C:/repo/override-poc.local.json',
        fileExists: true,
        fileSizeBytes: 55,
        matchedRequests: 1,
        fulfilledRequests: 0,
        lastMatchedAt: 1700000000200,
      },
    });

    expect(runResponse.statusCode).toBe(200);
    expect(JSON.parse(runResponse.body).ok).toBe(true);

    const requestResponse = await fastify.inject({
      method: 'POST',
      url: '/sessions/override-audit-test/overrides/requests',
      payload: {
        requestLogId: 'run-1:req-1',
        runId: 'run-1',
        requestId: 'req-1',
        timestamp: 1700000000250,
        requestUrl: 'https://example.com/_next/static/chunks/app.js',
        status: 'failed',
        failureCode: 'FULFILL_FAILED',
        errorMessage: 'Inspector target closed',
      },
    });

    expect(requestResponse.statusCode).toBe(200);
    expect(JSON.parse(requestResponse.body).ok).toBe(true);

    const rscRequestResponse = await fastify.inject({
      method: 'POST',
      url: '/sessions/override-audit-test/overrides/requests',
      payload: {
        requestLogId: 'run-1:req-rsc',
        runId: 'run-1',
        requestId: 'req-rsc',
        timestamp: 1700000000260,
        requestUrl: 'https://example.com/about?_rsc=random-token',
        status: 'failed',
        failureCode: 'RSC_PATCH_ANCHOR_MISMATCH',
        errorMessage: 'RSC live response patch matched 0 time(s), expected 1.',
      },
    });

    expect(rscRequestResponse.statusCode).toBe(200);
    expect(JSON.parse(rscRequestResponse.body).ok).toBe(true);

    const listRunsResponse = await fastify.inject({
      method: 'GET',
      url: '/sessions/override-audit-test/overrides/runs?limit=10&offset=0',
    });
    const listRunsBody = JSON.parse(listRunsResponse.body);
    expect(listRunsResponse.statusCode).toBe(200);
    expect(listRunsBody.ok).toBe(true);
    expect(listRunsBody.runs).toHaveLength(1);
    expect(listRunsBody.runs[0].runId).toBe('run-1');

    const listRequestsResponse = await fastify.inject({
      method: 'GET',
      url: '/sessions/override-audit-test/overrides/requests?runId=run-1&limit=10&offset=0',
    });
    const listRequestsBody = JSON.parse(listRequestsResponse.body);
    expect(listRequestsResponse.statusCode).toBe(200);
    expect(listRequestsBody.ok).toBe(true);
    expect(listRequestsBody.requests).toHaveLength(2);
    expect(listRequestsBody.requests.map((entry: { failureCode: string }) => entry.failureCode)).toEqual([
      'RSC_PATCH_ANCHOR_MISMATCH',
      'FULFILL_FAILED',
    ]);

    const planResponse = await fastify.inject({
      method: 'POST',
      url: '/sessions/override-audit-test/overrides/plans',
      payload: {
        planId: 'plan-1',
        createdAt: 1700000000300,
        plannerKind: 'response-patch',
        toolName: 'plan_override_response_patch',
        profileId: 'profile-1',
        ruleId: 'rule-1',
        ruleType: 'api-response',
        requestMethod: 'GET',
        matchMode: 'exact',
        targetAssetUrl: 'https://example.com/api/override-signal',
        localFilePath: 'C:/repo/tmp/override.json',
        configPath: 'C:/repo/override-poc.local.json',
        contentType: 'application/json; charset=utf-8',
        originalSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        patchedSha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        originalBytes: 18,
        patchedBytes: 20,
        patchSummary: { jsonPatches: [{ path: '/mode' }] },
        preview: { before: 'original', after: 'override' },
        warnings: [],
        blockers: [],
        capturedFromLiveSession: { source: 'cdp-response' },
        rollback: { disableTool: 'disable_overrides', generatedFiles: ['C:/repo/tmp/override.json'] },
      },
    });

    expect(planResponse.statusCode).toBe(200);
    expect(JSON.parse(planResponse.body).ok).toBe(true);

    const listPlansResponse = await fastify.inject({
      method: 'GET',
      url: '/sessions/override-audit-test/overrides/plans?planId=plan-1&limit=10&offset=0',
    });
    const listPlansBody = JSON.parse(listPlansResponse.body);
    expect(listPlansResponse.statusCode).toBe(200);
    expect(listPlansBody.ok).toBe(true);
    expect(listPlansBody.plans).toHaveLength(1);
    expect(listPlansBody.plans[0]).toMatchObject({
      planId: 'plan-1',
      plannerKind: 'response-patch',
      targetAssetUrl: 'https://example.com/api/override-signal',
      patchSummary: { jsonPatches: [{ path: '/mode' }] },
      rollback: { disableTool: 'disable_overrides' },
    });

    const diagnosisResponse = await fastify.inject({
      method: 'GET',
      url: '/sessions/override-audit-test/overrides/diagnosis?runId=run-1',
    });
    const diagnosisBody = JSON.parse(diagnosisResponse.body);
    expect(diagnosisResponse.statusCode).toBe(200);
    expect(diagnosisBody.ok).toBe(true);
    expect(diagnosisBody.diagnosis.runId).toBe('run-1');
    expect(diagnosisBody.diagnosis.summary.requestFailureCount).toBe(2);
    expect(diagnosisBody.diagnosis.issues.some((issue: { code: string }) => issue.code === 'FULFILL_FAILED')).toBe(true);
    expect(diagnosisBody.diagnosis.issues.some((issue: { code: string }) => issue.code === 'RSC_PATCH_ANCHOR_MISMATCH')).toBe(true);
  });

  it('should expose browser mock routes through override config, asset, and hit audit APIs', async () => {
    initializeDatabase(getConnection().db);
    clearDatabase(getConnection().db);

    const now = 1700000000000;
    upsertMockRoute(getConnection().db, {
      routeId: 'route-products-empty',
      createdAt: now,
      updatedAt: now,
      enabled: true,
      mode: 'browser',
      method: 'GET',
      matchMode: 'exact',
      targetUrl: 'https://api.example.com/products',
      statusCode: 202,
      responseHeaders: {
        'content-type': 'application/json; charset=utf-8',
        'x-test-mock': 'products',
      },
      bodyKind: 'json',
      bodyJson: { items: [] },
      bodyText: null,
      bodyBase64: null,
      bodyFilePath: null,
      delayMs: 0,
      sourceKind: 'manual',
      sessionScope: null,
      projectRoot: 'C:/repo/app',
      ttlMs: null,
      expiresAt: null,
    });

    const configResponse = await fastify.inject({
      method: 'GET',
      url: '/overrides/poc/config',
    });
    const configBody = JSON.parse(configResponse.body);
    expect(configResponse.statusCode).toBe(200);
    expect(configBody.enabled).toBe(true);
    expect(configBody.fileExists).toBe(true);
    expect(configBody.rules[0]).toMatchObject({
      ruleId: 'mock-route-route-products-empty',
      ruleType: 'api-response',
      targetAssetUrl: 'https://api.example.com/products',
      fileExists: true,
    });

    const assetResponse = await fastify.inject({
      method: 'GET',
      url: `/overrides/poc/asset?assetUrl=${encodeURIComponent('https://api.example.com/products')}&requestMethod=GET`,
    });
    expect(assetResponse.statusCode).toBe(200);
    expect(assetResponse.headers['x-bdmcp-mock']).toBe('1');
    expect(assetResponse.headers['x-bdmcp-mock-route']).toBe('route-products-empty');
    expect(assetResponse.headers['x-bdmcp-mock-response-code']).toBe('202');
    expect(JSON.parse(assetResponse.body)).toEqual({ items: [] });

    await fastify.inject({
      method: 'POST',
      url: '/sessions/import',
      payload: {
        session: {
          session_id: 'mock-browser-session',
          created_at: now,
          safe_mode: 0,
        },
        events: [],
        network: [],
        fingerprints: [],
      },
    });

    const runResponse = await fastify.inject({
      method: 'POST',
      url: '/sessions/mock-browser-session/overrides/runs',
      payload: {
        runId: 'override-run-1',
        startedAt: now + 100,
        runStatus: 'active',
        tabId: 17,
        selectedTabId: 17,
        targetAssetUrl: 'https://api.example.com/products',
        localFilePath: 'bdmcp-mock-route:route-products-empty',
        resolvedLocalFilePath: 'bdmcp-mock-route:route-products-empty',
        contentType: 'application/json; charset=utf-8',
        autoReload: false,
        configPath: 'mock-routes-db',
        fileExists: true,
        fileSizeBytes: 12,
        matchedRequests: 1,
        fulfilledRequests: 1,
      },
    });
    expect(runResponse.statusCode).toBe(200);

    const requestResponse = await fastify.inject({
      method: 'POST',
      url: '/sessions/mock-browser-session/overrides/requests',
      payload: {
        requestLogId: 'override-run-1:request-1',
        runId: 'override-run-1',
        requestId: 'request-1',
        timestamp: now + 200,
        requestUrl: 'https://api.example.com/products',
        requestMethod: 'GET',
        status: 'fulfilled',
        responseCode: 202,
      },
    });
    expect(requestResponse.statusCode).toBe(200);

    const mockRuns = listMockRuns(getConnection().db, {
      routeId: 'route-products-empty',
      limit: 10,
      offset: 0,
    }).runs;
    const mockHits = listMockHits(getConnection().db, {
      routeId: 'route-products-empty',
      limit: 10,
      offset: 0,
    }).hits;
    expect(mockRuns[0]).toMatchObject({
      runId: 'override-run-1:route-products-empty',
      routeId: 'route-products-empty',
      executionMode: 'browser',
      sessionId: 'mock-browser-session',
    });
    expect(mockHits[0]).toMatchObject({
      hitId: 'override-run-1:request-1:route-products-empty',
      routeId: 'route-products-empty',
      requestUrl: 'https://api.example.com/products',
      fulfilled: true,
      statusCode: 202,
    });
  });

  it('should serve active SSR mock routes from the internal mock endpoint', async () => {
    initializeDatabase(getConnection().db);
    clearDatabase(getConnection().db);

    const now = 1700000000000;
    upsertMockRoute(getConnection().db, {
      routeId: 'route-ssr-search',
      createdAt: now,
      updatedAt: now,
      enabled: true,
      mode: 'ssr',
      method: 'POST',
      matchMode: 'exact',
      targetUrl: 'https://api.example.com/products/search',
      statusCode: 203,
      responseHeaders: {
        'content-type': 'application/json; charset=utf-8',
        'x-test-mock': 'ssr-search',
      },
      bodyKind: 'json',
      bodyJson: { items: ['mocked'] },
      bodyText: null,
      bodyBase64: null,
      bodyFilePath: null,
      delayMs: 0,
      sourceKind: 'manual',
      sessionScope: 'run-1',
      projectRoot: 'C:/repo/app',
      ttlMs: null,
      expiresAt: null,
    });

    const response = await fastify.inject({
      method: 'POST',
      url: '/mock/ssr/run-1/products/search',
      payload: { q: 'debug' },
    });

    expect(response.statusCode).toBe(203);
    expect(response.headers['x-bdmcp-mock']).toBe('1');
    expect(response.headers['x-bdmcp-mock-route']).toBe('route-ssr-search');
    expect(response.headers['x-bdmcp-mock-execution-mode']).toBe('ssr');
    expect(response.headers['x-test-mock']).toBe('ssr-search');
    expect(JSON.parse(response.body)).toEqual({ items: ['mocked'] });

    const missResponse = await fastify.inject({
      method: 'GET',
      url: '/mock/ssr/run-1/products/search',
    });
    expect(missResponse.statusCode).toBe(404);

    const mockRuns = listMockRuns(getConnection().db, {
      routeId: 'route-ssr-search',
      limit: 10,
      offset: 0,
    }).runs;
    const mockHits = listMockHits(getConnection().db, {
      routeId: 'route-ssr-search',
      limit: 10,
      offset: 0,
    }).hits;
    expect(mockRuns[0]).toMatchObject({
      runId: 'ssr:run-1:route-ssr-search',
      routeId: 'route-ssr-search',
      executionMode: 'ssr',
      sessionId: null,
    });
    expect(mockHits[0]).toMatchObject({
      routeId: 'route-ssr-search',
      requestUrl: '/products/search',
      requestMethod: 'POST',
      fulfilled: true,
      statusCode: 203,
    });
  });
});
