import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import { normalizeObservedOverrideAssets, type NormalizedObservedOverrideAsset } from './next-asset-mapper.js';

export interface PersistObservedOverrideAssetsInput {
  sessionId: string;
  tabId?: unknown;
  pageUrl?: unknown;
  baseUrl?: unknown;
  title?: unknown;
  serviceWorkerControlled?: unknown;
  cspMetaTags?: unknown;
  assets?: unknown;
  observedAt?: number;
}

export interface PersistObservedOverrideAssetsResult {
  sessionId: string;
  observedAt: number;
  assetCount: number;
  persistedCount: number;
}

export interface StoredObservedOverrideAsset extends NormalizedObservedOverrideAsset {
  observedAssetId: string;
  sessionId: string;
  observedAt: number;
  lastSeenAt: number;
  tabId?: number;
  pageUrl?: string;
  baseUrl?: string;
  title?: string;
  serviceWorkerControlled: boolean;
  cspMetaTags: string[];
}

interface ObservedAssetRow {
  observed_asset_id: string;
  session_id: string;
  observed_at: number;
  last_seen_at: number;
  tab_id: number | null;
  page_url: string | null;
  base_url: string | null;
  page_title: string | null;
  service_worker_controlled: number;
  csp_meta_json: string | null;
  asset_url: string;
  rule_type: StoredObservedOverrideAsset['ruleType'];
  request_method: string;
  resource_type: string | null;
  content_type: string | null;
  status_code: number | null;
  asset_path: string | null;
  pathname: string;
  kind: string | null;
  initiator_type: string | null;
  rel: string | null;
  as_attr: string | null;
  integrity: string | null;
  from_dom: number;
  from_performance: number;
  from_navigation: number;
  from_fetch: number;
  payload_json: string;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeOptionalInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.floor(value);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function createObservedAssetId(sessionId: string, requestMethod: string, assetUrl: string): string {
  return createHash('sha256').update(`${sessionId}\0${requestMethod}\0${assetUrl}`).digest('hex');
}

function safeParseStringArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return normalizeStringArray(parsed);
  } catch {
    return [];
  }
}

function rowToStoredAsset(row: ObservedAssetRow): StoredObservedOverrideAsset {
  return {
    observedAssetId: row.observed_asset_id,
    sessionId: row.session_id,
    observedAt: row.observed_at,
    lastSeenAt: row.last_seen_at,
    tabId: row.tab_id ?? undefined,
    pageUrl: row.page_url ?? undefined,
    baseUrl: row.base_url ?? undefined,
    title: row.page_title ?? undefined,
    serviceWorkerControlled: row.service_worker_controlled === 1,
    cspMetaTags: safeParseStringArray(row.csp_meta_json),
    url: row.asset_url,
    ruleType: row.rule_type,
    requestMethod: row.request_method,
    resourceType: row.resource_type ?? undefined,
    contentType: row.content_type ?? undefined,
    statusCode: row.status_code ?? undefined,
    assetPath: row.asset_path,
    pathname: row.pathname,
    kind: row.kind ?? undefined,
    initiatorType: row.initiator_type ?? undefined,
    rel: row.rel ?? undefined,
    as: row.as_attr ?? undefined,
    integrity: row.integrity ?? undefined,
    fromDom: row.from_dom === 1,
    fromPerformance: row.from_performance === 1,
    fromNavigation: row.from_navigation === 1,
    fromFetch: row.from_fetch === 1,
  };
}

export function persistObservedOverrideAssets(
  db: Database,
  input: PersistObservedOverrideAssetsInput,
): PersistObservedOverrideAssetsResult {
  const sessionId = normalizeOptionalString(input.sessionId);
  if (!sessionId) {
    throw new Error('sessionId is required to persist observed override assets');
  }

  const observedAt = typeof input.observedAt === 'number' && Number.isFinite(input.observedAt)
    ? Math.floor(input.observedAt)
    : Date.now();
  const tabId = normalizeOptionalInteger(input.tabId);
  const pageUrl = normalizeOptionalString(input.pageUrl);
  const baseUrl = normalizeOptionalString(input.baseUrl);
  const title = normalizeOptionalString(input.title);
  const serviceWorkerControlled = input.serviceWorkerControlled === true ? 1 : 0;
  const cspMetaTags = normalizeStringArray(input.cspMetaTags);
  const assets = normalizeObservedOverrideAssets(input.assets);

  const statement = db.prepare(`
    INSERT INTO override_observed_assets (
      observed_asset_id,
      session_id,
      observed_at,
      last_seen_at,
      tab_id,
      page_url,
      base_url,
      page_title,
      service_worker_controlled,
      csp_meta_json,
      asset_url,
      rule_type,
      request_method,
      resource_type,
      content_type,
      status_code,
      asset_path,
      pathname,
      kind,
      initiator_type,
      rel,
      as_attr,
      integrity,
      from_dom,
      from_performance,
      from_navigation,
      from_fetch,
      payload_json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, request_method, asset_url) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      tab_id = excluded.tab_id,
      page_url = excluded.page_url,
      base_url = excluded.base_url,
      page_title = excluded.page_title,
      service_worker_controlled = excluded.service_worker_controlled,
      csp_meta_json = excluded.csp_meta_json,
      rule_type = excluded.rule_type,
      resource_type = COALESCE(excluded.resource_type, override_observed_assets.resource_type),
      content_type = COALESCE(excluded.content_type, override_observed_assets.content_type),
      status_code = COALESCE(excluded.status_code, override_observed_assets.status_code),
      asset_path = excluded.asset_path,
      pathname = excluded.pathname,
      kind = COALESCE(excluded.kind, override_observed_assets.kind),
      initiator_type = COALESCE(excluded.initiator_type, override_observed_assets.initiator_type),
      rel = COALESCE(excluded.rel, override_observed_assets.rel),
      as_attr = COALESCE(excluded.as_attr, override_observed_assets.as_attr),
      integrity = COALESCE(excluded.integrity, override_observed_assets.integrity),
      from_dom = CASE WHEN excluded.from_dom = 1 THEN 1 ELSE override_observed_assets.from_dom END,
      from_performance = CASE WHEN excluded.from_performance = 1 THEN 1 ELSE override_observed_assets.from_performance END,
      from_navigation = CASE WHEN excluded.from_navigation = 1 THEN 1 ELSE override_observed_assets.from_navigation END,
      from_fetch = CASE WHEN excluded.from_fetch = 1 THEN 1 ELSE override_observed_assets.from_fetch END,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `);

  const persist = db.transaction(() => {
    for (const asset of assets) {
      statement.run(
        createObservedAssetId(sessionId, asset.requestMethod, asset.url),
        sessionId,
        observedAt,
        observedAt,
        tabId ?? null,
        pageUrl ?? null,
        baseUrl ?? null,
        title ?? null,
        serviceWorkerControlled,
        JSON.stringify(cspMetaTags),
        asset.url,
        asset.ruleType,
        asset.requestMethod,
        asset.resourceType ?? null,
        asset.contentType ?? null,
        asset.statusCode ?? null,
        asset.assetPath,
        asset.pathname,
        asset.kind ?? null,
        asset.initiatorType ?? null,
        asset.rel ?? null,
        asset.as ?? null,
        asset.integrity ?? null,
        asset.fromDom ? 1 : 0,
        asset.fromPerformance ? 1 : 0,
        asset.fromNavigation ? 1 : 0,
        asset.fromFetch ? 1 : 0,
        JSON.stringify(asset),
        observedAt,
        observedAt,
      );
    }
  });

  persist();

  return {
    sessionId,
    observedAt,
    assetCount: assets.length,
    persistedCount: assets.length,
  };
}

export function listObservedOverrideAssets(
  db: Database,
  input: { sessionId: string; limit?: number; sinceTimestamp?: number },
): StoredObservedOverrideAsset[] {
  const sessionId = normalizeOptionalString(input.sessionId);
  if (!sessionId) {
    throw new Error('sessionId is required');
  }

  const limit = input.limit !== undefined && Number.isFinite(input.limit)
    ? Math.max(1, Math.min(1000, Math.floor(input.limit)))
    : 500;
  const sinceTimestamp = input.sinceTimestamp !== undefined && Number.isFinite(input.sinceTimestamp)
    ? Math.floor(input.sinceTimestamp)
    : undefined;

  const rows = sinceTimestamp === undefined
    ? db.prepare(`
        SELECT *
        FROM override_observed_assets
        WHERE session_id = ?
        ORDER BY last_seen_at DESC, asset_url ASC
        LIMIT ?
      `).all(sessionId, limit) as ObservedAssetRow[]
    : db.prepare(`
        SELECT *
        FROM override_observed_assets
        WHERE session_id = ? AND last_seen_at >= ?
        ORDER BY last_seen_at DESC, asset_url ASC
        LIMIT ?
      `).all(sessionId, sinceTimestamp, limit) as ObservedAssetRow[];

  return rows.map(rowToStoredAsset);
}
