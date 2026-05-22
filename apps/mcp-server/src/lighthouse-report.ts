import type { Database } from 'better-sqlite3';
import type { Dirent } from 'fs';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'path';
import { getRuntimeDataDir } from './runtime-paths.js';

export const LIGHTHOUSE_REPORT_ASSET_DIR = 'lighthouse-reports';

const DEFAULT_REPORT_LIMIT = 25;
const MAX_REPORT_LIMIT = 200;
const DEFAULT_ASSET_CHUNK_BYTES = 64 * 1024;
const MAX_ASSET_CHUNK_BYTES = 256 * 1024;
const DEFAULT_FIX_ITEM_LIMIT = 50;
const MAX_FIX_ITEM_LIMIT = 200;
const DEFAULT_SOURCE_CANDIDATE_LIMIT = 5;
const MAX_SOURCE_CANDIDATE_LIMIT = 20;
const MAX_REPO_SCAN_FILES = 20_000;
const MAX_REPO_SCAN_DEPTH = 12;

const LIGHTHOUSE_CATEGORY_IDS = new Set(['performance', 'accessibility', 'best-practices', 'seo', 'pwa']);
const LIGHTHOUSE_ASSETS = new Set(['json', 'html']);
const REPO_SCAN_IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.next',
  '.nx',
  '.turbo',
  'coverage',
  'dist',
  'build',
  'node_modules',
  'test-results',
  'playwright-report',
]);
const SOURCE_CANDIDATE_EXTENSIONS = new Set([
  '.astro',
  '.avif',
  '.cjs',
  '.css',
  '.gif',
  '.html',
  '.jpeg',
  '.jpg',
  '.js',
  '.jsx',
  '.less',
  '.mjs',
  '.png',
  '.sass',
  '.scss',
  '.svg',
  '.svelte',
  '.ts',
  '.tsx',
  '.vue',
  '.webp',
  '.woff',
  '.woff2',
]);

export type LighthouseFormFactor = 'mobile' | 'desktop';
export type LighthouseReportStatus = 'succeeded' | 'failed';
export type LighthouseReportAsset = 'json' | 'html';
export type LighthouseFixPriority = 'critical' | 'high' | 'medium' | 'low';
export type LighthouseFixReadiness = 'source-located' | 'route-located' | 'needs-investigation';

interface LighthouseCategory {
  id: string;
  title?: string;
  score: number | null;
}

interface LighthouseAuditRef {
  id: string;
  weight?: number;
  group?: string;
}

interface LighthouseAuditDetails {
  type?: string;
  overallSavingsMs?: number;
  overallSavingsBytes?: number;
  items?: unknown[];
  [key: string]: unknown;
}

interface LighthouseAudit {
  id: string;
  title?: string;
  description?: string;
  score?: number | null;
  scoreDisplayMode?: string;
  displayValue?: string;
  details?: LighthouseAuditDetails;
}

interface LighthouseResult {
  requestedUrl?: string;
  finalUrl?: string;
  finalDisplayedUrl?: string;
  fetchTime?: string;
  lighthouseVersion?: string;
  userAgent?: string;
  runWarnings?: string[];
  runtimeError?: {
    code: string;
    message: string;
    errorStack?: string;
  };
  categories: Record<string, LighthouseCategory & { auditRefs?: LighthouseAuditRef[] }>;
  audits: Record<string, LighthouseAudit>;
  environment?: Record<string, unknown>;
  configSettings?: Record<string, unknown>;
}

interface LighthouseRunnerResult {
  lhr: LighthouseResult;
  report: string | string[];
}

export interface RunLighthouseReportInput {
  sessionId?: string;
  url?: string;
  formFactor?: LighthouseFormFactor;
  categories?: string[];
  maxWaitForLoadMs?: number;
  chromeFlags?: string[];
  artifactDir?: string;
}

export interface LighthouseFixPlanInput {
  reportId: string;
  minPriority?: LighthouseFixPriority;
  limit?: number;
  projectRoot?: string;
  routePath?: string;
  sourceCandidateLimit?: number;
}

export interface LighthouseReportRecord {
  reportId: string;
  sessionId?: string;
  requestedUrl: string;
  finalUrl?: string;
  status: LighthouseReportStatus;
  createdAt: number;
  completedAt?: number;
  durationMs?: number;
  lighthouseVersion?: string;
  formFactor: LighthouseFormFactor;
  categories: Record<string, unknown>;
  metrics: Record<string, unknown>;
  scores: Record<string, number | null>;
  runWarnings: string[];
  runtimeError?: Record<string, unknown>;
  jsonPath?: string;
  jsonBytes?: number;
  htmlPath?: string;
  htmlBytes?: number;
  errorMessage?: string;
}

export interface LighthouseSourceCandidate {
  path: string;
  relativePath: string;
  matchType: 'resource-path' | 'resource-name' | 'route-entry' | 'route-layout';
  resourceUrl?: string;
  reason: string;
}

export interface LighthouseFixPlanItem {
  auditId: string;
  title: string;
  priority: LighthouseFixPriority;
  categoryIds: string[];
  score?: number | null;
  displayValue?: string;
  estimatedSavingsMs?: number;
  estimatedSavingsBytes?: number;
  rationale: string;
  suggestedAction: string;
  resourceUrls: string[];
  sourceCandidates: LighthouseSourceCandidate[];
  fixReadiness: LighthouseFixReadiness;
  nextSteps: string[];
}

export interface LighthouseFixPlanRecord {
  planId: string;
  reportId: string;
  sessionId?: string;
  createdAt: number;
  itemCount: number;
  priorityCounts: Record<LighthouseFixPriority, number>;
  summary: Record<string, unknown>;
  items: LighthouseFixPlanItem[];
}

export interface LighthouseRunner {
  run(input: {
    url: string;
    formFactor: LighthouseFormFactor;
    categories: string[];
    maxWaitForLoadMs?: number;
    chromeFlags: string[];
  }): Promise<LighthouseRunnerResult>;
}

interface LighthouseSourceContext {
  rootPath: string;
  routePath?: string;
  sourceCandidateLimit: number;
  files: RepoFileEntry[];
  scanFileCount: number;
  scanTruncated: boolean;
}

interface RepoFileEntry {
  path: string;
  relativePath: string;
  basename: string;
  extension: string;
  normalizedStem: string;
}

export function getLighthouseArtifactRoot(): string {
  return join(getRuntimeDataDir(), LIGHTHOUSE_REPORT_ASSET_DIR);
}

export function normalizeLighthouseCategories(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return ['performance'];
  }

  const categories = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => LIGHTHOUSE_CATEGORY_IDS.has(entry));

  return categories.length > 0 ? Array.from(new Set(categories)) : ['performance'];
}

export function normalizeLighthouseFormFactor(value: unknown): LighthouseFormFactor {
  return value === 'desktop' ? 'desktop' : 'mobile';
}

export function normalizeLighthouseAsset(value: unknown): LighthouseReportAsset {
  return value === 'html' ? 'html' : 'json';
}

export function resolveLighthouseLimit(value: unknown, fallback = DEFAULT_REPORT_LIMIT): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(1, Math.floor(value)), MAX_REPORT_LIMIT);
}

export function resolveLighthouseOffset(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

export function resolveLighthouseChunkBytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_ASSET_CHUNK_BYTES;
  }
  return Math.min(Math.max(1, Math.floor(value)), MAX_ASSET_CHUNK_BYTES);
}

export function resolveLighthouseFixItemLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_FIX_ITEM_LIMIT;
  }
  return Math.min(Math.max(1, Math.floor(value)), MAX_FIX_ITEM_LIMIT);
}

export function resolveLighthouseSourceCandidateLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SOURCE_CANDIDATE_LIMIT;
  }
  return Math.min(Math.max(1, Math.floor(value)), MAX_SOURCE_CANDIDATE_LIMIT);
}

export function resolveLighthouseUrl(db: Database, input: { sessionId?: string; url?: string }): string {
  if (typeof input.url === 'string' && input.url.trim().length > 0) {
    return normalizeHttpUrl(input.url, 'url');
  }

  if (!input.sessionId) {
    throw new Error('url or sessionId is required');
  }

  const row = db
    .prepare('SELECT url_last, url_start FROM sessions WHERE session_id = ?')
    .get(input.sessionId) as { url_last: string | null; url_start: string | null } | undefined;

  if (!row) {
    throw new Error(`Session not found: ${input.sessionId}`);
  }

  const candidate = row.url_last ?? row.url_start;
  if (!candidate) {
    throw new Error(`Session has no URL to audit: ${input.sessionId}`);
  }

  return normalizeHttpUrl(candidate, 'session URL');
}

export async function runLighthouseReport(
  db: Database,
  input: RunLighthouseReportInput,
  runner: LighthouseRunner = createDefaultLighthouseRunner(),
): Promise<LighthouseReportRecord> {
  const createdAt = Date.now();
  const reportId = `lhr-${createdAt}-${randomUUID()}`;
  const url = resolveLighthouseUrl(db, input);
  const formFactor = normalizeLighthouseFormFactor(input.formFactor);
  const categories = normalizeLighthouseCategories(input.categories);
  const artifactDir = input.artifactDir ?? getLighthouseArtifactRoot();
  const chromeFlags = normalizeChromeFlags(input.chromeFlags);
  const maxWaitForLoadMs = normalizeMaxWaitForLoadMs(input.maxWaitForLoadMs);

  insertPendingReport(db, {
    reportId,
    sessionId: input.sessionId,
    requestedUrl: url,
    createdAt,
    formFactor,
    categories,
    maxWaitForLoadMs,
  });

  const startedAt = Date.now();

  try {
    const result = await runner.run({
      url,
      formFactor,
      categories,
      maxWaitForLoadMs,
      chromeFlags,
    });
    const completedAt = Date.now();
    const artifactPaths = persistLighthouseArtifacts(artifactDir, reportId, result);
    const record = mapLighthouseResultToRecord({
      reportId,
      sessionId: input.sessionId,
      requestedUrl: url,
      formFactor,
      createdAt,
      completedAt,
      durationMs: completedAt - startedAt,
      result,
      artifactPaths,
    });
    updateCompletedReport(db, record);
    return record;
  } catch (error) {
    const completedAt = Date.now();
    const message = error instanceof Error ? error.message : String(error);
    const failed = mapFailedLighthouseReport({
      reportId,
      sessionId: input.sessionId,
      requestedUrl: url,
      formFactor,
      createdAt,
      completedAt,
      durationMs: completedAt - startedAt,
      errorMessage: message,
    });
    updateCompletedReport(db, failed);
    return failed;
  }
}

export function listLighthouseReports(
  db: Database,
  input: { sessionId?: string; urlContains?: string; status?: string; limit?: number; offset?: number },
): { reports: LighthouseReportRecord[]; pagination: { limit: number; offset: number; returned: number; hasMore: boolean } } {
  const limit = resolveLighthouseLimit(input.limit);
  const offset = resolveLighthouseOffset(input.offset);
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (input.sessionId) {
    clauses.push('session_id = ?');
    params.push(input.sessionId);
  }
  if (typeof input.urlContains === 'string' && input.urlContains.trim().length > 0) {
    clauses.push('requested_url LIKE ?');
    params.push(`%${input.urlContains.trim()}%`);
  }
  if (input.status === 'succeeded' || input.status === 'failed') {
    clauses.push('status = ?');
    params.push(input.status);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`
      SELECT *
      FROM lighthouse_reports
      ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `)
    .all(...params, limit + 1, offset) as Record<string, unknown>[];
  const page = rows.slice(0, limit);

  return {
    reports: page.map(mapReportRow),
    pagination: {
      limit,
      offset,
      returned: page.length,
      hasMore: rows.length > limit,
    },
  };
}

export function getLighthouseReport(db: Database, reportId: string): LighthouseReportRecord {
  const row = db.prepare('SELECT * FROM lighthouse_reports WHERE report_id = ?').get(reportId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error(`Lighthouse report not found: ${reportId}`);
  }
  return mapReportRow(row);
}

export function getLighthouseReportAsset(
  db: Database,
  input: { reportId: string; asset: LighthouseReportAsset; offset?: number; maxBytes?: number; encoding?: 'raw' | 'base64' },
): Record<string, unknown> {
  const row = db.prepare('SELECT json_path, json_bytes, html_path, html_bytes FROM lighthouse_reports WHERE report_id = ?').get(input.reportId) as
    | { json_path: string | null; json_bytes: number | null; html_path: string | null; html_bytes: number | null }
    | undefined;
  if (!row) {
    throw new Error(`Lighthouse report not found: ${input.reportId}`);
  }

  const assetPath = input.asset === 'html' ? row.html_path : row.json_path;
  const totalBytes = input.asset === 'html' ? row.html_bytes : row.json_bytes;
  if (!assetPath || !existsSync(assetPath)) {
    throw new Error(`Lighthouse ${input.asset} asset is not available for report: ${input.reportId}`);
  }

  const offset = resolveLighthouseOffset(input.offset);
  const maxBytes = resolveLighthouseChunkBytes(input.maxBytes);
  const buffer = readFileSync(assetPath);
  const chunk = buffer.subarray(offset, Math.min(buffer.length, offset + maxBytes));
  const encoding = input.encoding === 'raw' ? 'raw' : 'base64';

  return {
    reportId: input.reportId,
    asset: input.asset,
    encoding,
    offset,
    bytesReturned: chunk.length,
    totalBytes: totalBytes ?? buffer.length,
    hasMore: offset + chunk.length < buffer.length,
    data: encoding === 'base64' ? chunk.toString('base64') : chunk.toString('utf8'),
  };
}

export function planLighthouseFixes(
  db: Database,
  input: LighthouseFixPlanInput,
): LighthouseFixPlanRecord {
  const report = getLighthouseReport(db, input.reportId);
  if (report.status !== 'succeeded' || !report.jsonPath) {
    throw new Error(`Lighthouse report is not usable for fix planning: ${input.reportId}`);
  }
  const lhr = JSON.parse(readFileSync(report.jsonPath, 'utf8')) as LighthouseResult;
  const sourceContext = createLighthouseSourceContext({
    projectRoot: input.projectRoot,
    routePath: input.routePath,
    sourceCandidateLimit: input.sourceCandidateLimit,
    reportUrl: report.finalUrl ?? report.requestedUrl,
  });
  const minRank = priorityRank(input.minPriority ?? 'low');
  const limit = resolveLighthouseFixItemLimit(input.limit);
  const items = createLighthouseFixPlanItems(lhr, sourceContext)
    .filter((item) => priorityRank(item.priority) <= minRank)
    .slice(0, limit);
  const priorityCounts = countPriorities(items);
  const createdAt = Date.now();
  const planId = `lhfix-${createdAt}-${randomUUID()}`;
  const summary = {
    reportId: input.reportId,
    requestedUrl: report.requestedUrl,
    finalUrl: report.finalUrl,
    scores: report.scores,
    generatedFromAuditCount: Object.keys(lhr.audits ?? {}).length,
    returnedItemCount: items.length,
    sourceContext: sourceContext
      ? {
          projectRoot: sourceContext.rootPath,
          routePath: sourceContext.routePath,
          scannedFileCount: sourceContext.scanFileCount,
          scanTruncated: sourceContext.scanTruncated,
          sourceCandidateLimit: sourceContext.sourceCandidateLimit,
        }
      : undefined,
  };

  db.prepare(`
    INSERT INTO lighthouse_fix_plans (
      plan_id, report_id, session_id, created_at, item_count, critical_count, high_count,
      medium_count, low_count, summary_json, items_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    planId,
    input.reportId,
    report.sessionId ?? null,
    createdAt,
    items.length,
    priorityCounts.critical,
    priorityCounts.high,
    priorityCounts.medium,
    priorityCounts.low,
    JSON.stringify(summary),
    JSON.stringify(items),
  );

  return {
    planId,
    reportId: input.reportId,
    sessionId: report.sessionId,
    createdAt,
    itemCount: items.length,
    priorityCounts,
    summary,
    items,
  };
}

export function createLighthouseFixPlanItems(lhr: LighthouseResult, sourceContext?: LighthouseSourceContext): LighthouseFixPlanItem[] {
  const auditCategoryMap = buildAuditCategoryMap(lhr);
  const audits = Object.values(lhr.audits ?? {});
  const items = audits
    .filter((audit) => isActionableAudit(audit))
    .map((audit) => {
      const details = audit.details ?? {};
      const savingsMs = normalizeSavings(details.overallSavingsMs);
      const savingsBytes = normalizeSavings(details.overallSavingsBytes);
      const priority = classifyPriority(audit, savingsMs, savingsBytes);
      const resourceUrls = extractAuditResourceUrls(audit);
      const sourceCandidates = sourceContext ? findSourceCandidatesForAudit(audit, resourceUrls, sourceContext) : [];
      return {
        auditId: audit.id,
        title: audit.title ?? audit.id,
        priority,
        categoryIds: auditCategoryMap.get(audit.id) ?? [],
        score: audit.score,
        displayValue: audit.displayValue,
        estimatedSavingsMs: savingsMs,
        estimatedSavingsBytes: savingsBytes,
        rationale: buildFixRationale(audit, savingsMs, savingsBytes),
        suggestedAction: buildSuggestedAction(audit.id),
        resourceUrls,
        sourceCandidates,
        fixReadiness: classifyFixReadiness(sourceCandidates),
        nextSteps: buildLighthouseNextSteps(audit.id, resourceUrls, sourceCandidates),
      };
    });

  return items.sort((first, second) => {
    const priorityDelta = priorityRank(first.priority) - priorityRank(second.priority);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    return (second.estimatedSavingsMs ?? 0) - (first.estimatedSavingsMs ?? 0);
  });
}

function createLighthouseSourceContext(input: {
  projectRoot?: string;
  routePath?: string;
  sourceCandidateLimit?: number;
  reportUrl?: string;
}): LighthouseSourceContext | undefined {
  if (typeof input.projectRoot !== 'string' || input.projectRoot.trim().length === 0) {
    return undefined;
  }

  const rootPath = resolve(input.projectRoot.trim());
  if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
    throw new Error(`projectRoot must be an existing directory: ${input.projectRoot}`);
  }

  const scan = scanProjectFiles(rootPath);
  return {
    rootPath,
    routePath: normalizeRoutePath(input.routePath) ?? normalizeRoutePathFromUrl(input.reportUrl),
    sourceCandidateLimit: resolveLighthouseSourceCandidateLimit(input.sourceCandidateLimit),
    files: scan.files,
    scanFileCount: scan.scanned,
    scanTruncated: scan.truncated,
  };
}

function scanProjectFiles(rootPath: string): { files: RepoFileEntry[]; scanned: number; truncated: boolean } {
  const files: RepoFileEntry[] = [];
  let scanned = 0;
  let truncated = false;

  function walk(currentPath: string, depth: number): void {
    if (depth > MAX_REPO_SCAN_DEPTH || scanned >= MAX_REPO_SCAN_FILES) {
      truncated = true;
      return;
    }

    let entries: Dirent[];
    try {
      entries = readdirSync(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (scanned >= MAX_REPO_SCAN_FILES) {
        truncated = true;
        return;
      }

      const entryPath = join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (!REPO_SCAN_IGNORED_DIRS.has(entry.name)) {
          walk(entryPath, depth + 1);
        }
        continue;
      }

      if (!entry.isFile() || !isSourceCandidateFile(entry.name)) {
        continue;
      }

      scanned += 1;
      const extension = extname(entry.name).toLowerCase();
      files.push({
        path: entryPath,
        relativePath: toPosixPath(relative(rootPath, entryPath)),
        basename: entry.name.toLowerCase(),
        extension,
        normalizedStem: normalizeAssetStem(entry.name),
      });
    }
  }

  walk(rootPath, 0);
  return { files, scanned, truncated };
}

function isSourceCandidateFile(fileName: string): boolean {
  return SOURCE_CANDIDATE_EXTENSIONS.has(extname(fileName).toLowerCase());
}

function extractAuditResourceUrls(audit: LighthouseAudit): string[] {
  const urls = new Set<string>();
  collectResourceUrls(audit.details, urls, 0);
  return Array.from(urls).slice(0, 25);
}

function collectResourceUrls(value: unknown, urls: Set<string>, depth: number): void {
  if (depth > 8 || urls.size >= 25 || value === null || value === undefined) {
    return;
  }

  if (typeof value === 'string') {
    const url = normalizeResourceUrl(value);
    if (url) {
      urls.add(url);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectResourceUrls(entry, urls, depth + 1);
    }
    return;
  }

  if (typeof value !== 'object') {
    return;
  }

  for (const entry of Object.values(value as Record<string, unknown>)) {
    collectResourceUrls(entry, urls, depth + 1);
  }
}

function normalizeResourceUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length > 2_048) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return trimmed.startsWith('/') && !trimmed.startsWith('//') ? trimmed : undefined;
  }
}

function findSourceCandidatesForAudit(
  audit: LighthouseAudit,
  resourceUrls: string[],
  context: LighthouseSourceContext,
): LighthouseSourceCandidate[] {
  const candidates = new Map<string, LighthouseSourceCandidate>();

  for (const resourceUrl of resourceUrls) {
    for (const candidate of findResourceSourceCandidates(resourceUrl, context)) {
      candidates.set(`${candidate.matchType}:${candidate.relativePath}:${candidate.resourceUrl ?? ''}`, candidate);
      if (candidates.size >= context.sourceCandidateLimit) {
        return Array.from(candidates.values());
      }
    }
  }

  if (auditCanUseRouteCandidates(audit.id)) {
    for (const candidate of findRouteSourceCandidates(context)) {
      candidates.set(`${candidate.matchType}:${candidate.relativePath}`, candidate);
      if (candidates.size >= context.sourceCandidateLimit) {
        return Array.from(candidates.values());
      }
    }
  }

  return Array.from(candidates.values());
}

function findResourceSourceCandidates(resourceUrl: string, context: LighthouseSourceContext): LighthouseSourceCandidate[] {
  const resourcePath = extractResourcePath(resourceUrl);
  if (!resourcePath) {
    return [];
  }

  const resourceFileName = basename(resourcePath).toLowerCase();
  if (!resourceFileName) {
    return [];
  }

  const normalizedResourceStem = normalizeAssetStem(resourceFileName);
  const resourceExtension = extname(resourceFileName).toLowerCase();
  const pathSuffixes = [
    stripLeadingSlash(resourcePath),
    `public/${stripLeadingSlash(resourcePath)}`,
  ].map((entry) => entry.toLowerCase());
  const candidates: LighthouseSourceCandidate[] = [];

  for (const file of context.files) {
    const lowerRelativePath = file.relativePath.toLowerCase();
    const exactPathMatch = pathSuffixes.some((suffix) => lowerRelativePath.endsWith(suffix));
    if (exactPathMatch) {
      candidates.push({
        path: file.path,
        relativePath: file.relativePath,
        matchType: 'resource-path',
        resourceUrl,
        reason: `File path matches Lighthouse resource ${resourcePath}`,
      });
      continue;
    }

    if (
      file.extension === resourceExtension &&
      (file.basename === resourceFileName || (normalizedResourceStem.length > 0 && file.normalizedStem === normalizedResourceStem))
    ) {
      candidates.push({
        path: file.path,
        relativePath: file.relativePath,
        matchType: 'resource-name',
        resourceUrl,
        reason: `File name matches Lighthouse resource ${resourceFileName}`,
      });
    }
  }

  return candidates.slice(0, context.sourceCandidateLimit);
}

function findRouteSourceCandidates(context: LighthouseSourceContext): LighthouseSourceCandidate[] {
  const routePath = context.routePath;
  if (!routePath) {
    return [];
  }

  const routeSegments = routePath === '/' ? [] : routePath.split('/').filter(Boolean);
  const routePart = routeSegments.join('/');
  const routePatterns = routeSegments.length === 0
    ? [
        'app/page',
        'src/app/page',
        'pages/index',
        'src/pages/index',
      ]
    : [
        `app/${routePart}/page`,
        `src/app/${routePart}/page`,
        `pages/${routePart}`,
        `src/pages/${routePart}`,
        `pages/${routePart}/index`,
        `src/pages/${routePart}/index`,
      ];
  const layoutPatterns = routeSegments.length === 0
    ? ['app/layout', 'src/app/layout']
    : [
        `app/${routePart}/layout`,
        `src/app/${routePart}/layout`,
      ];

  const candidates: LighthouseSourceCandidate[] = [];
  for (const file of context.files) {
    const withoutExtension = file.relativePath.slice(0, -file.extension.length).toLowerCase();
    if (routePatterns.some((pattern) => withoutExtension.endsWith(pattern))) {
      candidates.push({
        path: file.path,
        relativePath: file.relativePath,
        matchType: 'route-entry',
        reason: `Route entry candidate for ${routePath}`,
      });
      continue;
    }
    if (layoutPatterns.some((pattern) => withoutExtension.endsWith(pattern))) {
      candidates.push({
        path: file.path,
        relativePath: file.relativePath,
        matchType: 'route-layout',
        reason: `Route layout candidate for ${routePath}`,
      });
    }
  }

  return candidates.slice(0, context.sourceCandidateLimit);
}

function auditCanUseRouteCandidates(auditId: string): boolean {
  return new Set([
    'cumulative-layout-shift',
    'first-contentful-paint',
    'interactive',
    'largest-contentful-paint',
    'render-blocking-resources',
    'server-response-time',
    'speed-index',
    'total-blocking-time',
    'unused-css-rules',
    'unused-javascript',
  ]).has(auditId);
}

function classifyFixReadiness(candidates: LighthouseSourceCandidate[]): LighthouseFixReadiness {
  if (candidates.some((candidate) => candidate.matchType === 'resource-path' || candidate.matchType === 'resource-name')) {
    return 'source-located';
  }
  if (candidates.some((candidate) => candidate.matchType === 'route-entry' || candidate.matchType === 'route-layout')) {
    return 'route-located';
  }
  return 'needs-investigation';
}

function buildLighthouseNextSteps(
  auditId: string,
  resourceUrls: string[],
  sourceCandidates: LighthouseSourceCandidate[],
): string[] {
  const steps: string[] = [];
  const hasResources = resourceUrls.length > 0;
  const hasCandidates = sourceCandidates.length > 0;

  if (hasCandidates) {
    steps.push('Review the listed sourceCandidates first; they are the most likely files to edit for this audit.');
  } else if (hasResources) {
    steps.push('Inspect the listed resourceUrls and map any bundled or hashed assets back through source maps or the app bundler.');
  } else {
    steps.push('Use the persisted JSON/HTML report to inspect the audit details before editing source.');
  }

  const auditSteps: Record<string, string> = {
    'render-blocking-resources': 'Move non-critical CSS/JS off the initial render path, inline critical CSS only when justified, or add preload/defer where the framework supports it.',
    'unused-javascript': 'Trace the listed scripts to their route imports and split or lazy-load code that is not needed for the initial interaction.',
    'unused-css-rules': 'Move broad CSS into route/component styles or remove selectors that are not used by the audited page.',
    'modern-image-formats': 'Convert located image assets to AVIF/WebP and update references while keeping fallbacks where needed.',
    'uses-optimized-images': 'Resize or recompress located images to match rendered dimensions and quality requirements.',
    'largest-contentful-paint': 'Find the LCP element or resource, prioritize its load, and reduce server/render work that delays it.',
    'total-blocking-time': 'Break long startup tasks, reduce hydration work, or defer non-critical scripts from the audited route.',
    'cumulative-layout-shift': 'Reserve image/embed/font space with dimensions, aspect-ratio, or stable fallback layout.',
    'server-response-time': 'Inspect the route handler, data fetching, cache policy, and deployment path for the audited URL.',
  };
  steps.push(auditSteps[auditId] ?? 'Apply the remediation described by Lighthouse, then run a new report to compare scores and metrics.');
  steps.push('After editing, run run_lighthouse_report again for the same URL and compare the new plan against this report.');
  return steps;
}

function normalizeRoutePath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  const trimmed = value.trim();
  const withoutQuery = trimmed.split(/[?#]/, 1)[0] ?? '';
  const route = withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
  return route.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

function normalizeRoutePathFromUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  try {
    return normalizeRoutePath(new URL(value).pathname);
  } catch {
    return normalizeRoutePath(value);
  }
}

function extractResourcePath(resourceUrl: string): string | undefined {
  try {
    return decodeURIComponent(new URL(resourceUrl).pathname);
  } catch {
    return resourceUrl.startsWith('/') ? decodeURIComponent(resourceUrl.split(/[?#]/, 1)[0] ?? '') : undefined;
  }
}

function normalizeAssetStem(fileName: string): string {
  const extension = extname(fileName);
  const name = extension.length > 0 ? basename(fileName, extension) : basename(fileName);
  const normalized = name.toLowerCase();
  const parts = normalized.split(/[._-]/);
  const lastPart = parts.at(-1);
  if (lastPart && /^[a-z0-9]{8,}$/.test(lastPart) && parts.length > 1) {
    return parts.slice(0, -1).join('-');
  }
  return normalized;
}

function stripLeadingSlash(value: string): string {
  return value.replace(/^\/+/, '');
}

function toPosixPath(value: string): string {
  return value.split(sep).join('/');
}

function createDefaultLighthouseRunner(): LighthouseRunner {
  return {
    async run(input) {
      const [{ default: lighthouse, desktopConfig }, { launch }] = await Promise.all([
        import('lighthouse'),
        import('chrome-launcher'),
      ]);
      const chrome = await launch({
        chromeFlags: [
          '--headless=new',
          '--disable-gpu',
          ...input.chromeFlags,
        ],
      });

      try {
        const result = await lighthouse(
          input.url,
          {
            port: chrome.port,
            output: ['json', 'html'],
            logLevel: 'error',
            onlyCategories: input.categories,
            formFactor: input.formFactor,
            maxWaitForLoad: input.maxWaitForLoadMs,
            channel: 'browser-debug-mcp-bridge',
          },
          input.formFactor === 'desktop' ? desktopConfig : undefined,
        );
        if (!result) {
          throw new Error('Lighthouse did not return a report.');
        }
        return result as unknown as LighthouseRunnerResult;
      } finally {
        await chrome.kill();
      }
    },
  };
}

function normalizeHttpUrl(value: string, fieldName: string): string {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`${fieldName} must be an http(s) URL`);
    }
    return parsed.toString();
  } catch (error) {
    if (error instanceof Error && error.message.includes('http(s) URL')) {
      throw error;
    }
    throw new Error(`${fieldName} must be a valid absolute URL`);
  }
}

function normalizeChromeFlags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, 20);
}

function normalizeMaxWaitForLoadMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(Math.max(1_000, Math.floor(value)), 120_000);
}

function insertPendingReport(
  db: Database,
  input: {
    reportId: string;
    sessionId?: string;
    requestedUrl: string;
    createdAt: number;
    formFactor: LighthouseFormFactor;
    categories: string[];
    maxWaitForLoadMs?: number;
  },
): void {
  db.prepare(`
    INSERT INTO lighthouse_reports (
      report_id, session_id, requested_url, status, created_at, form_factor,
      categories_json, metrics_json, scores_json, run_warnings_json, config_json
    ) VALUES (?, ?, ?, 'failed', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.reportId,
    input.sessionId ?? null,
    input.requestedUrl,
    input.createdAt,
    input.formFactor,
    JSON.stringify({ requested: input.categories }),
    '{}',
    '{}',
    '[]',
    JSON.stringify({ categories: input.categories, maxWaitForLoadMs: input.maxWaitForLoadMs }),
  );
}

function updateCompletedReport(db: Database, record: LighthouseReportRecord): void {
  db.prepare(`
    UPDATE lighthouse_reports
    SET
      final_url = ?,
      status = ?,
      completed_at = ?,
      duration_ms = ?,
      lighthouse_version = ?,
      user_agent = ?,
      categories_json = ?,
      metrics_json = ?,
      scores_json = ?,
      score_performance = ?,
      score_accessibility = ?,
      score_best_practices = ?,
      score_seo = ?,
      score_pwa = ?,
      json_path = ?,
      json_bytes = ?,
      html_path = ?,
      html_bytes = ?,
      run_warnings_json = ?,
      runtime_error_json = ?,
      error_message = ?
    WHERE report_id = ?
  `).run(
    record.finalUrl ?? null,
    record.status,
    record.completedAt ?? null,
    record.durationMs ?? null,
    record.lighthouseVersion ?? null,
    typeof record.metrics.userAgent === 'string' ? record.metrics.userAgent : null,
    JSON.stringify(record.categories),
    JSON.stringify(record.metrics),
    JSON.stringify(record.scores),
    record.scores.performance ?? null,
    record.scores.accessibility ?? null,
    record.scores['best-practices'] ?? null,
    record.scores.seo ?? null,
    record.scores.pwa ?? null,
    record.jsonPath ?? null,
    record.jsonBytes ?? null,
    record.htmlPath ?? null,
    record.htmlBytes ?? null,
    JSON.stringify(record.runWarnings),
    record.runtimeError ? JSON.stringify(record.runtimeError) : null,
    record.errorMessage ?? null,
    record.reportId,
  );
}

function persistLighthouseArtifacts(
  artifactDir: string,
  reportId: string,
  result: LighthouseRunnerResult,
): { jsonPath: string; jsonBytes: number; htmlPath: string; htmlBytes: number } {
  const safeReportId = reportId.replace(/[^a-zA-Z0-9._-]/g, '_');
  mkdirSync(artifactDir, { recursive: true });
  const jsonPath = join(artifactDir, `${safeReportId}.json`);
  const htmlPath = join(artifactDir, `${safeReportId}.html`);
  const reports = Array.isArray(result.report) ? result.report : [result.report];
  const jsonReport = JSON.stringify(result.lhr, null, 2);
  const htmlReport = reports.find((entry) => entry.trim().startsWith('<')) ?? '';

  writeFileSync(jsonPath, jsonReport, 'utf8');
  writeFileSync(htmlPath, htmlReport, 'utf8');

  return {
    jsonPath,
    jsonBytes: statSync(jsonPath).size,
    htmlPath,
    htmlBytes: statSync(htmlPath).size,
  };
}

function mapLighthouseResultToRecord(input: {
  reportId: string;
  sessionId?: string;
  requestedUrl: string;
  formFactor: LighthouseFormFactor;
  createdAt: number;
  completedAt: number;
  durationMs: number;
  result: LighthouseRunnerResult;
  artifactPaths: { jsonPath: string; jsonBytes: number; htmlPath: string; htmlBytes: number };
}): LighthouseReportRecord {
  const lhr = input.result.lhr;
  return {
    reportId: input.reportId,
    sessionId: input.sessionId,
    requestedUrl: lhr.requestedUrl ?? input.requestedUrl,
    finalUrl: lhr.finalDisplayedUrl ?? lhr.finalUrl,
    status: lhr.runtimeError ? 'failed' : 'succeeded',
    createdAt: input.createdAt,
    completedAt: input.completedAt,
    durationMs: input.durationMs,
    lighthouseVersion: lhr.lighthouseVersion,
    formFactor: input.formFactor,
    categories: summarizeCategories(lhr),
    metrics: summarizeMetrics(lhr),
    scores: summarizeScores(lhr),
    runWarnings: Array.isArray(lhr.runWarnings) ? lhr.runWarnings : [],
    runtimeError: lhr.runtimeError,
    jsonPath: input.artifactPaths.jsonPath,
    jsonBytes: input.artifactPaths.jsonBytes,
    htmlPath: input.artifactPaths.htmlPath,
    htmlBytes: input.artifactPaths.htmlBytes,
    errorMessage: lhr.runtimeError?.message,
  };
}

function mapFailedLighthouseReport(input: {
  reportId: string;
  sessionId?: string;
  requestedUrl: string;
  formFactor: LighthouseFormFactor;
  createdAt: number;
  completedAt: number;
  durationMs: number;
  errorMessage: string;
}): LighthouseReportRecord {
  return {
    reportId: input.reportId,
    sessionId: input.sessionId,
    requestedUrl: input.requestedUrl,
    status: 'failed',
    createdAt: input.createdAt,
    completedAt: input.completedAt,
    durationMs: input.durationMs,
    formFactor: input.formFactor,
    categories: {},
    metrics: {},
    scores: {},
    runWarnings: [],
    errorMessage: input.errorMessage,
  };
}

function summarizeCategories(lhr: LighthouseResult): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(lhr.categories ?? {}).map(([id, category]) => [
      id,
      {
        title: category.title ?? id,
        score: category.score,
      },
    ]),
  );
}

function summarizeScores(lhr: LighthouseResult): Record<string, number | null> {
  return Object.fromEntries(
    Object.entries(lhr.categories ?? {}).map(([id, category]) => [id, category.score]),
  );
}

function summarizeMetrics(lhr: LighthouseResult): Record<string, unknown> {
  const metricIds = [
    'first-contentful-paint',
    'largest-contentful-paint',
    'total-blocking-time',
    'cumulative-layout-shift',
    'speed-index',
    'interactive',
  ];
  const metrics: Record<string, unknown> = {
    fetchTime: lhr.fetchTime,
    userAgent: lhr.userAgent,
    environment: lhr.environment,
  };

  for (const id of metricIds) {
    const audit = lhr.audits?.[id];
    if (audit) {
      metrics[id] = {
        score: audit.score,
        displayValue: audit.displayValue,
      };
    }
  }

  return metrics;
}

function mapReportRow(row: Record<string, unknown>): LighthouseReportRecord {
  return {
    reportId: String(row.report_id),
    sessionId: typeof row.session_id === 'string' ? row.session_id : undefined,
    requestedUrl: String(row.requested_url),
    finalUrl: typeof row.final_url === 'string' ? row.final_url : undefined,
    status: row.status === 'succeeded' ? 'succeeded' : 'failed',
    createdAt: Number(row.created_at),
    completedAt: typeof row.completed_at === 'number' ? row.completed_at : undefined,
    durationMs: typeof row.duration_ms === 'number' ? row.duration_ms : undefined,
    lighthouseVersion: typeof row.lighthouse_version === 'string' ? row.lighthouse_version : undefined,
    formFactor: row.form_factor === 'desktop' ? 'desktop' : 'mobile',
    categories: parseJsonRecord(row.categories_json),
    metrics: parseJsonRecord(row.metrics_json),
    scores: parseJsonRecord(row.scores_json) as Record<string, number | null>,
    runWarnings: parseJsonArray(row.run_warnings_json),
    runtimeError: parseJsonRecordOrUndefined(row.runtime_error_json),
    jsonPath: typeof row.json_path === 'string' ? row.json_path : undefined,
    jsonBytes: typeof row.json_bytes === 'number' ? row.json_bytes : undefined,
    htmlPath: typeof row.html_path === 'string' ? row.html_path : undefined,
    htmlBytes: typeof row.html_bytes === 'number' ? row.html_bytes : undefined,
    errorMessage: typeof row.error_message === 'string' ? row.error_message : undefined,
  };
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseJsonRecordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  const parsed = parseJsonRecord(value);
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string') {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function buildAuditCategoryMap(lhr: LighthouseResult): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [categoryId, category] of Object.entries(lhr.categories ?? {})) {
    for (const ref of category.auditRefs ?? []) {
      const categories = map.get(ref.id) ?? [];
      categories.push(categoryId);
      map.set(ref.id, categories);
    }
  }
  return map;
}

function isActionableAudit(audit: LighthouseAudit): boolean {
  if (!audit.id || audit.scoreDisplayMode === 'notApplicable' || audit.scoreDisplayMode === 'manual') {
    return false;
  }
  if (audit.details?.type === 'opportunity') {
    return true;
  }
  return typeof audit.score === 'number' && audit.score < 1;
}

function classifyPriority(
  audit: LighthouseAudit,
  savingsMs?: number,
  savingsBytes?: number,
): LighthouseFixPriority {
  if ((savingsMs ?? 0) >= 1_000 || (savingsBytes ?? 0) >= 500_000 || (typeof audit.score === 'number' && audit.score <= 0.25)) {
    return 'critical';
  }
  if ((savingsMs ?? 0) >= 500 || (savingsBytes ?? 0) >= 150_000 || (typeof audit.score === 'number' && audit.score <= 0.5)) {
    return 'high';
  }
  if ((savingsMs ?? 0) >= 100 || (savingsBytes ?? 0) >= 50_000 || (typeof audit.score === 'number' && audit.score < 0.9)) {
    return 'medium';
  }
  return 'low';
}

function priorityRank(priority: LighthouseFixPriority): number {
  if (priority === 'critical') return 1;
  if (priority === 'high') return 2;
  if (priority === 'medium') return 3;
  return 4;
}

function normalizeSavings(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

function buildFixRationale(audit: LighthouseAudit, savingsMs?: number, savingsBytes?: number): string {
  const savings: string[] = [];
  if (savingsMs) {
    savings.push(`${savingsMs} ms estimated time savings`);
  }
  if (savingsBytes) {
    savings.push(`${savingsBytes} bytes estimated transfer savings`);
  }
  if (savings.length > 0) {
    return savings.join('; ');
  }
  if (typeof audit.score === 'number') {
    return `Audit score is ${audit.score}`;
  }
  return 'Lighthouse marked this audit as needing attention';
}

function buildSuggestedAction(auditId: string): string {
  const suggestions: Record<string, string> = {
    'render-blocking-resources': 'Defer or inline critical CSS/JS and remove render-blocking requests from the initial path.',
    'unused-javascript': 'Reduce, split, or lazy-load unused JavaScript shipped during initial page load.',
    'unused-css-rules': 'Remove unused CSS and load route-specific styles only where needed.',
    'modern-image-formats': 'Serve images in modern formats such as AVIF or WebP where browser support allows.',
    'uses-optimized-images': 'Resize and compress image assets to match rendered dimensions and quality needs.',
    'largest-contentful-paint': 'Identify the LCP element and prioritize its resource, server response, and render path.',
    'total-blocking-time': 'Break up long main-thread work and reduce expensive JavaScript execution during startup.',
    'cumulative-layout-shift': 'Reserve dimensions for images/embeds and avoid late layout-affecting DOM or font changes.',
    'server-response-time': 'Reduce backend latency, caching misses, and document request processing time.',
  };
  return suggestions[auditId] ?? 'Inspect the Lighthouse audit details and apply the recommended remediation for this audit.';
}

function countPriorities(items: LighthouseFixPlanItem[]): Record<LighthouseFixPriority, number> {
  return {
    critical: items.filter((item) => item.priority === 'critical').length,
    high: items.filter((item) => item.priority === 'high').length,
    medium: items.filter((item) => item.priority === 'medium').length,
    low: items.filter((item) => item.priority === 'low').length,
  };
}

export function ensureArtifactParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

export function isSupportedLighthouseAsset(value: unknown): value is LighthouseReportAsset {
  return typeof value === 'string' && LIGHTHOUSE_ASSETS.has(value);
}
