import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { extname, relative, resolve } from 'path';

export type OverrideAssetConfidence = 'high' | 'medium' | 'low';

export interface ObservedOverrideAssetInput {
  url?: unknown;
  href?: unknown;
  requestUrl?: unknown;
  kind?: unknown;
  initiatorType?: unknown;
  rel?: unknown;
  as?: unknown;
  integrity?: unknown;
  fromDom?: unknown;
  fromPerformance?: unknown;
}

export interface NormalizedObservedOverrideAsset {
  url: string;
  assetPath: string | null;
  pathname: string;
  kind?: string;
  initiatorType?: string;
  rel?: string;
  as?: string;
  integrity?: string;
  fromDom: boolean;
  fromPerformance: boolean;
}

export interface NextAssetRecord {
  assetPath: string;
  localFilePath: string;
  extension: string;
  sizeBytes: number;
  sha256: string;
  sourceMapPath?: string;
  sourceCount: number;
  sources: string[];
  manifestRoutes: string[];
  manifestFiles: string[];
}

export interface NextAssetMappingCandidate {
  targetAssetUrl: string;
  assetPath: string;
  localFilePath: string;
  confidence: OverrideAssetConfidence;
  score: number;
  reasons: string[];
  blockers: string[];
  matchedSourcePaths: string[];
  manifestRoutes: string[];
  drift?: NextAssetDriftCheck;
  observed: NormalizedObservedOverrideAsset;
}

export interface NextAssetDriftCheck {
  checkedAt: number;
  status: 'matched' | 'signature_match' | 'different' | 'unavailable' | 'too_large';
  productionSha256?: string;
  localSha256: string;
  productionBytes?: number;
  localBytes: number;
  normalizedSignatureMatch?: boolean;
  error?: string;
}

export interface NextAssetMappingResult {
  projectRoot: string;
  nextDir: string;
  route?: string;
  sourcePaths: string[];
  observedAssetCount: number;
  observedNextAssetCount: number;
  indexedAssetCount: number;
  sourceMappedAssetCount: number;
  driftSummary?: {
    checked: number;
    matched: number;
    signatureMatched: number;
    different: number;
    unavailable: number;
    tooLarge: number;
    skipped: number;
    maxChecked: number;
    concurrency: number;
  };
  candidates: NextAssetMappingCandidate[];
  unmatchedObservedAssets: NormalizedObservedOverrideAsset[];
  warnings: string[];
  nextActions: Array<{ code: string; message: string }>;
}

export interface NextAssetIndex {
  projectRoot: string;
  nextDir: string;
  assets: NextAssetRecord[];
  byAssetPath: Map<string, NextAssetRecord>;
  warnings: string[];
}

const NEXT_MANIFEST_RELATIVE_PATHS = [
  'build-manifest.json',
  'app-build-manifest.json',
  'react-loadable-manifest.json',
];

const SOURCE_MAP_EXTENSIONS = new Set(['.js', '.mjs']);
const DEFAULT_PRODUCTION_FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_PRODUCTION_ASSET_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_DRIFT_CANDIDATES = 20;
const DEFAULT_DRIFT_FETCH_CONCURRENCY = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toPortablePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function normalizeRoute(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeAssetPathFromUrl(value: string): { assetPath: string | null; pathname: string } {
  let pathname = value;
  try {
    pathname = new URL(value).pathname;
  } catch {
    const queryIndex = pathname.search(/[?#]/);
    if (queryIndex >= 0) {
      pathname = pathname.slice(0, queryIndex);
    }
  }

  pathname = toPortablePath(pathname);
  const nextIndex = pathname.indexOf('/_next/');
  if (nextIndex < 0) {
    return { assetPath: null, pathname };
  }

  const assetPath = pathname.slice(nextIndex + '/_next/'.length).replace(/^\/+/, '');
  return {
    assetPath: assetPath.startsWith('static/') ? assetPath : null,
    pathname,
  };
}

function normalizeObservedAsset(value: unknown): NormalizedObservedOverrideAsset | null {
  if (!isRecord(value)) {
    return null;
  }

  const url = normalizeOptionalString(value.url)
    ?? normalizeOptionalString(value.href)
    ?? normalizeOptionalString(value.requestUrl);
  if (!url) {
    return null;
  }

  const normalized = normalizeAssetPathFromUrl(url);
  return {
    url,
    assetPath: normalized.assetPath,
    pathname: normalized.pathname,
    kind: normalizeOptionalString(value.kind),
    initiatorType: normalizeOptionalString(value.initiatorType),
    rel: normalizeOptionalString(value.rel),
    as: normalizeOptionalString(value.as),
    integrity: normalizeOptionalString(value.integrity),
    fromDom: value.fromDom === true,
    fromPerformance: value.fromPerformance === true,
  };
}

export function normalizeObservedOverrideAssets(values: unknown): NormalizedObservedOverrideAsset[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const byUrl = new Map<string, NormalizedObservedOverrideAsset>();
  for (const value of values) {
    const normalized = normalizeObservedAsset(value);
    if (!normalized) {
      continue;
    }

    const existing = byUrl.get(normalized.url);
    if (existing) {
      existing.fromDom = existing.fromDom || normalized.fromDom;
      existing.fromPerformance = existing.fromPerformance || normalized.fromPerformance;
      existing.integrity = existing.integrity ?? normalized.integrity;
      existing.kind = existing.kind ?? normalized.kind;
      existing.initiatorType = existing.initiatorType ?? normalized.initiatorType;
      continue;
    }

    byUrl.set(normalized.url, normalized);
  }

  return Array.from(byUrl.values()).sort((first, second) => first.url.localeCompare(second.url));
}

function readJsonFile(filePath: string): unknown | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readJsonText(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function collectManifestReferences(
  value: unknown,
  context: { route?: string; manifestFile: string },
  references: Map<string, { routes: Set<string>; manifests: Set<string>; sources: Set<string> }>,
): void {
  if (typeof value === 'string') {
    const normalized = normalizeAssetPathFromUrl(value);
    if (!normalized.assetPath) {
      return;
    }

    const reference = references.get(normalized.assetPath) ?? { routes: new Set<string>(), manifests: new Set<string>(), sources: new Set<string>() };
    if (context.route) {
      reference.routes.add(context.route);
    }
    reference.manifests.add(context.manifestFile);
    references.set(normalized.assetPath, reference);
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectManifestReferences(entry, context, references);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    const route = key.startsWith('/') ? key : context.route;
    collectManifestReferences(entry, { ...context, route }, references);
  }
}

function walkFiles(currentDir: string, matcher: (filePath: string) => boolean, filePaths: string[]): void {
  if (!existsSync(currentDir)) {
    return;
  }

  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = resolve(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, matcher, filePaths);
      continue;
    }

    if (entry.isFile() && matcher(fullPath)) {
      filePaths.push(fullPath);
    }
  }
}

function collectClientReferenceManifestAssets(
  nextDir: string,
  references: Map<string, { routes: Set<string>; manifests: Set<string>; sources: Set<string> }>,
  warnings: string[],
): void {
  const manifestFiles: string[] = [];
  walkFiles(
    resolve(nextDir, 'server', 'app'),
    (filePath) => filePath.endsWith('client-reference-manifest.js'),
    manifestFiles,
  );

  for (const manifestFile of manifestFiles) {
    const content = readFileSync(manifestFile, 'utf8');
    const assignmentMatch = content.match(/__RSC_MANIFEST\["([^"]+)"\]\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
    if (!assignmentMatch) {
      continue;
    }

    const route = normalizeRoute(assignmentMatch[1]);
    const manifest = readJsonText(assignmentMatch[2] ?? '');
    if (!isRecord(manifest) || !isRecord(manifest.clientModules)) {
      warnings.push(`Unable to parse client reference manifest: ${manifestFile}`);
      continue;
    }

    for (const [sourceReference, moduleRecord] of Object.entries(manifest.clientModules)) {
      if (!isRecord(moduleRecord) || !Array.isArray(moduleRecord.chunks)) {
        continue;
      }

      for (const chunk of moduleRecord.chunks) {
        if (typeof chunk !== 'string') {
          continue;
        }
        const normalized = normalizeAssetPathFromUrl(chunk);
        if (!normalized.assetPath) {
          continue;
        }
        const reference = references.get(normalized.assetPath) ?? { routes: new Set<string>(), manifests: new Set<string>(), sources: new Set<string>() };
        if (route) {
          reference.routes.add(route);
        }
        reference.manifests.add(manifestFile);
        reference.sources.add(normalizeSourceReference(sourceReference));
        references.set(normalized.assetPath, reference);
      }
    }
  }
}

function walkAssets(root: string, currentDir: string, assetPaths: string[]): void {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = resolve(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkAssets(root, fullPath, assetPaths);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const extension = extname(entry.name).toLowerCase();
    if (extension !== '.js' && extension !== '.mjs' && extension !== '.css') {
      continue;
    }

    assetPaths.push(toPortablePath(relative(root, fullPath)));
  }
}

function readSourceMapSources(assetFilePath: string): { sourceMapPath?: string; sources: string[] } {
  if (!SOURCE_MAP_EXTENSIONS.has(extname(assetFilePath).toLowerCase())) {
    return { sources: [] };
  }

  const sourceMapPath = `${assetFilePath}.map`;
  if (!existsSync(sourceMapPath)) {
    return { sources: [] };
  }

  const parsed = readJsonFile(sourceMapPath);
  const sources = isRecord(parsed) && Array.isArray(parsed.sources)
    ? parsed.sources.filter((entry): entry is string => typeof entry === 'string')
    : [];

  return {
    sourceMapPath,
    sources: sources.map(normalizeSourceReference),
  };
}

function normalizeSourceReference(value: string): string {
  let normalized = toPortablePath(value.trim());
  const queryIndex = normalized.search(/[?#]/);
  if (queryIndex >= 0) {
    normalized = normalized.slice(0, queryIndex);
  }

  normalized = normalized.replace(/^webpack:\/\/[^/]+\//, '');
  normalized = normalized.replace(/^file:\/\//, '');
  normalized = normalized.replace(/^\.\//, '');
  normalized = normalized.replace(/^\/+/, '');
  return normalized;
}

export function normalizeNextSourcePath(projectRoot: string, sourcePath: string): string {
  const portable = toPortablePath(sourcePath.trim());
  if (!portable) {
    return portable;
  }

  if (/^[a-zA-Z]:\//.test(portable) || portable.startsWith('/')) {
    return toPortablePath(relative(projectRoot, resolve(portable))).replace(/^\.\//, '');
  }

  return portable.replace(/^\.\//, '');
}

export function nextAssetSourceMatches(candidateSource: string, requestedSource: string): boolean {
  const normalizedCandidate = candidateSource.toLowerCase();
  const normalizedRequested = requestedSource.toLowerCase();
  return normalizedCandidate === normalizedRequested
    || normalizedCandidate.endsWith(`/${normalizedRequested}`)
    || normalizedCandidate.endsWith(normalizedRequested);
}

function hashFile(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function hashBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function normalizeAssetSignature(content: string): string {
  return content
    .replace(/\/\/# sourceMappingURL=.*$/gm, '')
    .replace(/\b[a-f0-9]{8,}\b/gi, '<hash>')
    .replace(/\s+/g, '');
}

async function readBoundedResponseBytes(
  response: Response,
  maxBytes: number,
): Promise<{ status: 'ok'; bytes: Buffer } | { status: 'too_large' }> {
  const contentLength = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { status: 'too_large' };
  }

  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.byteLength > maxBytes ? { status: 'too_large' } : { status: 'ok', bytes: buffer };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const read = await reader.read();
    if (read.done) {
      break;
    }
    totalBytes += read.value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      return { status: 'too_large' };
    }
    chunks.push(read.value);
  }

  return { status: 'ok', bytes: Buffer.concat(chunks, totalBytes) };
}

async function fetchProductionAsset(
  url: string,
  options: { timeoutMs: number; maxBytes: number },
): Promise<{ status: 'ok'; bytes: Buffer } | { status: 'too_large' } | { status: 'unavailable'; error: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return { status: 'unavailable', error: `HTTP ${response.status}` };
    }
    return await readBoundedResponseBytes(response, options.maxBytes);
  } catch (error) {
    return {
      status: 'unavailable',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const current = values[nextIndex];
      nextIndex += 1;
      if (current !== undefined) {
        await mapper(current);
      }
    }
  }));
}

export function createNextAssetIndex(projectRootInput: string, nextDirInput?: string): NextAssetIndex {
  const projectRoot = resolve(projectRootInput);
  const nextDir = resolve(projectRoot, nextDirInput ?? '.next');
  const warnings: string[] = [];
  const manifestReferences = new Map<string, { routes: Set<string>; manifests: Set<string>; sources: Set<string> }>();

  if (!existsSync(nextDir)) {
    warnings.push(`Next.js output directory not found at ${nextDir}. Build the app before mapping override assets.`);
    return { projectRoot, nextDir, assets: [], byAssetPath: new Map(), warnings };
  }

  for (const manifestRelativePath of NEXT_MANIFEST_RELATIVE_PATHS) {
    const manifestFile = resolve(nextDir, manifestRelativePath);
    if (!existsSync(manifestFile)) {
      continue;
    }

    const manifest = readJsonFile(manifestFile);
    if (!manifest) {
      warnings.push(`Unable to parse Next.js manifest: ${manifestFile}`);
      continue;
    }

    collectManifestReferences(manifest, { manifestFile }, manifestReferences);
  }

  collectClientReferenceManifestAssets(nextDir, manifestReferences, warnings);

  const staticRoot = resolve(nextDir, 'static');
  const assetPaths: string[] = [];
  if (existsSync(staticRoot)) {
    walkAssets(nextDir, staticRoot, assetPaths);
  } else {
    warnings.push(`Next.js static directory not found at ${staticRoot}.`);
  }

  const assets = assetPaths.sort((first, second) => first.localeCompare(second)).map((assetPath) => {
    const localFilePath = resolve(nextDir, assetPath);
    const stat = statSync(localFilePath);
    const sourceMap = readSourceMapSources(localFilePath);
    const manifestReference = manifestReferences.get(assetPath);
    const sources = Array.from(new Set([
      ...sourceMap.sources,
      ...Array.from(manifestReference?.sources ?? []),
    ])).sort();
    return {
      assetPath,
      localFilePath,
      extension: extname(assetPath).toLowerCase(),
      sizeBytes: stat.size,
      sha256: hashFile(localFilePath),
      sourceMapPath: sourceMap.sourceMapPath,
      sourceCount: sources.length,
      sources,
      manifestRoutes: Array.from(manifestReference?.routes ?? []).sort(),
      manifestFiles: Array.from(manifestReference?.manifests ?? []).sort(),
    } satisfies NextAssetRecord;
  });

  return {
    projectRoot,
    nextDir,
    assets,
    byAssetPath: new Map(assets.map((asset) => [asset.assetPath, asset])),
    warnings,
  };
}

function confidenceFromScore(score: number): OverrideAssetConfidence {
  if (score >= 80) {
    return 'high';
  }
  if (score >= 45) {
    return 'medium';
  }
  return 'low';
}

function buildNextActions(candidates: NextAssetMappingCandidate[], warnings: string[]): Array<{ code: string; message: string }> {
  if (warnings.length > 0 && candidates.length === 0) {
    return [{ code: 'BUILD_OR_OBSERVE', message: 'Build the Next.js app and observe a live page before generating override rules.' }];
  }

  if (candidates.some((candidate) => candidate.blockers.includes('PRODUCTION_LOCAL_DRIFT'))) {
    return [{ code: 'RESOLVE_PRODUCTION_LOCAL_DRIFT', message: 'Rebuild the local app from the same revision/config as production or disable drift checking before reviewing lower-confidence rules.' }];
  }

  if (candidates.some((candidate) => candidate.blockers.includes('SRI_PRESENT'))) {
    return [{ code: 'HANDLE_SRI_BLOCKER', message: 'Choose a non-SRI target or add document/SRI mitigation before enabling this override.' }];
  }

  if (candidates.some((candidate) => candidate.confidence === 'high')) {
    return [{ code: 'CREATE_OVERRIDE_PROFILE', message: 'Use high-confidence targetAssetUrl/localFilePath pairs to create or update an override profile.' }];
  }

  if (candidates.length > 0) {
    return [{ code: 'REVIEW_MAPPING', message: 'Review medium/low-confidence mappings before enabling browser overrides.' }];
  }

  return [{ code: 'INTERACT_WITH_ROUTE', message: 'Load or interact with the target route so the browser requests the relevant Next.js chunks, then observe assets again.' }];
}

export function mapNextOverrideAssets(options: {
  projectRoot: string;
  nextDir?: string;
  observedAssets?: unknown;
  sourcePaths?: unknown;
  route?: unknown;
  maxResults?: unknown;
}): NextAssetMappingResult {
  const index = createNextAssetIndex(options.projectRoot, normalizeOptionalString(options.nextDir));
  const observedAssets = normalizeObservedOverrideAssets(options.observedAssets);
  const observedNextAssets = observedAssets.filter((asset) => asset.assetPath !== null);
  const sourcePaths = Array.isArray(options.sourcePaths)
    ? options.sourcePaths
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => normalizeNextSourcePath(index.projectRoot, entry))
    : [];
  const route = normalizeRoute(normalizeOptionalString(options.route));
  const maxResults = typeof options.maxResults === 'number' && Number.isFinite(options.maxResults)
    ? Math.max(1, Math.floor(options.maxResults))
    : 50;

  const candidates: NextAssetMappingCandidate[] = [];
  const unmatchedObservedAssets: NormalizedObservedOverrideAsset[] = [];

  for (const observed of observedNextAssets) {
    const assetPath = observed.assetPath;
    const asset = assetPath ? index.byAssetPath.get(assetPath) : undefined;
    if (!asset || !assetPath) {
      unmatchedObservedAssets.push(observed);
      continue;
    }

    const matchedSourcePaths = sourcePaths.filter((sourcePath) => {
      return asset.sources.some((source) => nextAssetSourceMatches(source, sourcePath));
    });
    const routeMatches = route ? asset.manifestRoutes.includes(route) : false;
    const reasons = ['exact_next_asset_path_match'];
    const blockers: string[] = [];
    let score = 65;

    if (sourcePaths.length > 0) {
      if (matchedSourcePaths.length > 0) {
        score += 30;
        reasons.push('source_map_source_match');
      } else if (asset.sourceMapPath) {
        score -= 25;
        reasons.push('source_map_present_without_requested_source');
      } else {
        score -= 10;
        reasons.push('source_map_missing');
      }
    }

    if (route) {
      if (routeMatches) {
        score += 10;
        reasons.push('route_manifest_match');
      } else if (asset.manifestRoutes.length > 0) {
        score -= 10;
        reasons.push('route_manifest_mismatch');
      } else {
        reasons.push('route_manifest_unavailable');
      }
    }

    if (observed.integrity) {
      score -= 35;
      blockers.push('SRI_PRESENT');
      reasons.push('script_or_link_has_integrity_attribute');
    }

    candidates.push({
      targetAssetUrl: observed.url,
      assetPath,
      localFilePath: asset.localFilePath,
      confidence: confidenceFromScore(score),
      score: Math.max(0, Math.min(100, score)),
      reasons,
      blockers,
      matchedSourcePaths,
      manifestRoutes: asset.manifestRoutes,
      observed,
    });
  }

  const sortedCandidates = candidates
    .sort((first, second) => second.score - first.score || first.assetPath.localeCompare(second.assetPath))
    .slice(0, maxResults);

  return {
    projectRoot: index.projectRoot,
    nextDir: index.nextDir,
    route,
    sourcePaths,
    observedAssetCount: observedAssets.length,
    observedNextAssetCount: observedNextAssets.length,
    indexedAssetCount: index.assets.length,
    sourceMappedAssetCount: index.assets.filter((asset) => asset.sourceMapPath).length,
    candidates: sortedCandidates,
    unmatchedObservedAssets,
    warnings: index.warnings,
    nextActions: buildNextActions(sortedCandidates, index.warnings),
  };
}

function createEmptyDriftSummary(maxChecked: number, concurrency: number): NonNullable<NextAssetMappingResult['driftSummary']> {
  return {
    checked: 0,
    matched: 0,
    signatureMatched: 0,
    different: 0,
    unavailable: 0,
    tooLarge: 0,
    skipped: 0,
    maxChecked,
    concurrency,
  };
}

function applyDriftToCandidate(candidate: NextAssetMappingCandidate, drift: NextAssetDriftCheck): void {
  candidate.drift = drift;
  if (drift.status === 'matched') {
    candidate.score = Math.min(100, candidate.score + 5);
    candidate.reasons.push('production_local_hash_match');
  } else if (drift.status === 'signature_match') {
    candidate.score = Math.max(0, candidate.score - 5);
    candidate.reasons.push('production_local_normalized_signature_match');
  } else if (drift.status === 'different') {
    candidate.score = Math.max(0, candidate.score - 35);
    candidate.blockers.push('PRODUCTION_LOCAL_DRIFT');
    candidate.reasons.push('production_local_hash_drift');
  } else if (drift.status === 'too_large') {
    candidate.reasons.push('production_asset_too_large_for_drift_check');
  } else {
    candidate.reasons.push('production_asset_unavailable_for_drift_check');
  }

  candidate.confidence = confidenceFromScore(candidate.score);
}

async function createDriftCheck(
  candidate: NextAssetMappingCandidate,
  options: { timeoutMs: number; maxBytes: number },
  localCache: Map<string, { buffer: Buffer; sha256: string; signature: string }>,
): Promise<NextAssetDriftCheck> {
  let local = localCache.get(candidate.localFilePath);
  if (!local) {
    const buffer = readFileSync(candidate.localFilePath);
    local = {
      buffer,
      sha256: hashBuffer(buffer),
      signature: normalizeAssetSignature(buffer.toString('utf8')),
    };
    localCache.set(candidate.localFilePath, local);
  }
  const fetched = await fetchProductionAsset(candidate.targetAssetUrl, options);
  const checkedAt = Date.now();

  if (fetched.status === 'too_large') {
    return {
      checkedAt,
      status: 'too_large',
      localSha256: local.sha256,
      localBytes: local.buffer.byteLength,
    };
  }

  if (fetched.status === 'unavailable') {
    return {
      checkedAt,
      status: 'unavailable',
      localSha256: local.sha256,
      localBytes: local.buffer.byteLength,
      error: fetched.error,
    };
  }

  const productionSha256 = hashBuffer(fetched.bytes);
  if (productionSha256 === local.sha256) {
    return {
      checkedAt,
      status: 'matched',
      productionSha256,
      localSha256: local.sha256,
      productionBytes: fetched.bytes.byteLength,
      localBytes: local.buffer.byteLength,
      normalizedSignatureMatch: true,
    };
  }

  const normalizedSignatureMatch = normalizeAssetSignature(fetched.bytes.toString('utf8')) === local.signature;
  return {
    checkedAt,
    status: normalizedSignatureMatch ? 'signature_match' : 'different',
    productionSha256,
    localSha256: local.sha256,
    productionBytes: fetched.bytes.byteLength,
    localBytes: local.buffer.byteLength,
    normalizedSignatureMatch,
  };
}

export async function mapNextOverrideAssetsWithDrift(options: {
  projectRoot: string;
  nextDir?: string;
  observedAssets?: unknown;
  sourcePaths?: unknown;
  route?: unknown;
  maxResults?: unknown;
  fetchProductionAssets?: unknown;
  productionFetchTimeoutMs?: unknown;
  maxProductionAssetBytes?: unknown;
  maxDriftCandidates?: unknown;
  productionFetchConcurrency?: unknown;
}): Promise<NextAssetMappingResult> {
  const result = mapNextOverrideAssets(options);
  if (options.fetchProductionAssets !== true || result.candidates.length === 0) {
    return result;
  }

  const timeoutMs = typeof options.productionFetchTimeoutMs === 'number' && Number.isFinite(options.productionFetchTimeoutMs)
    ? Math.max(500, Math.floor(options.productionFetchTimeoutMs))
    : DEFAULT_PRODUCTION_FETCH_TIMEOUT_MS;
  const maxBytes = typeof options.maxProductionAssetBytes === 'number' && Number.isFinite(options.maxProductionAssetBytes)
    ? Math.max(1024, Math.floor(options.maxProductionAssetBytes))
    : DEFAULT_MAX_PRODUCTION_ASSET_BYTES;
  const maxDriftCandidates = typeof options.maxDriftCandidates === 'number' && Number.isFinite(options.maxDriftCandidates)
    ? Math.max(1, Math.floor(options.maxDriftCandidates))
    : DEFAULT_MAX_DRIFT_CANDIDATES;
  const concurrency = typeof options.productionFetchConcurrency === 'number' && Number.isFinite(options.productionFetchConcurrency)
    ? Math.max(1, Math.min(8, Math.floor(options.productionFetchConcurrency)))
    : DEFAULT_DRIFT_FETCH_CONCURRENCY;
  const driftSummary = createEmptyDriftSummary(maxDriftCandidates, concurrency);
  const candidatesToCheck = result.candidates.slice(0, maxDriftCandidates);
  const localCache = new Map<string, { buffer: Buffer; sha256: string; signature: string }>();

  driftSummary.skipped = Math.max(0, result.candidates.length - candidatesToCheck.length);
  if (driftSummary.skipped > 0) {
    result.warnings.push(`Skipped ${driftSummary.skipped} candidate(s) after maxDriftCandidates=${maxDriftCandidates} to keep drift checks bounded.`);
  }

  await mapWithConcurrency(candidatesToCheck, concurrency, async (candidate) => {
    const drift = await createDriftCheck(candidate, { timeoutMs, maxBytes }, localCache);
    driftSummary.checked += 1;
    if (drift.status === 'matched') {
      driftSummary.matched += 1;
    } else if (drift.status === 'signature_match') {
      driftSummary.signatureMatched += 1;
    } else if (drift.status === 'different') {
      driftSummary.different += 1;
    } else if (drift.status === 'too_large') {
      driftSummary.tooLarge += 1;
    } else {
      driftSummary.unavailable += 1;
    }
    applyDriftToCandidate(candidate, drift);
  });

  result.driftSummary = driftSummary;
  result.candidates = result.candidates.sort((first, second) => second.score - first.score || first.assetPath.localeCompare(second.assetPath));
  result.nextActions = buildNextActions(result.candidates, result.warnings);
  return result;
}
