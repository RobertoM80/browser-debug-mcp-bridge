import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { getRuntimeDataDir } from './runtime-paths.js';

export const LIGHTHOUSE_REPORT_ASSET_DIR = 'lighthouse-reports';

const DEFAULT_REPORT_LIMIT = 25;
const MAX_REPORT_LIMIT = 200;
const DEFAULT_ASSET_CHUNK_BYTES = 64 * 1024;
const MAX_ASSET_CHUNK_BYTES = 256 * 1024;
const DEFAULT_FIX_ITEM_LIMIT = 50;
const MAX_FIX_ITEM_LIMIT = 200;

const LIGHTHOUSE_CATEGORY_IDS = new Set(['performance', 'accessibility', 'best-practices', 'seo', 'pwa']);
const LIGHTHOUSE_ASSETS = new Set(['json', 'html']);

export type LighthouseFormFactor = 'mobile' | 'desktop';
export type LighthouseReportStatus = 'succeeded' | 'failed';
export type LighthouseReportAsset = 'json' | 'html';
export type LighthouseFixPriority = 'critical' | 'high' | 'medium' | 'low';

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
  input: { reportId: string; minPriority?: LighthouseFixPriority; limit?: number },
): LighthouseFixPlanRecord {
  const report = getLighthouseReport(db, input.reportId);
  if (report.status !== 'succeeded' || !report.jsonPath) {
    throw new Error(`Lighthouse report is not usable for fix planning: ${input.reportId}`);
  }
  const lhr = JSON.parse(readFileSync(report.jsonPath, 'utf8')) as LighthouseResult;
  const minRank = priorityRank(input.minPriority ?? 'low');
  const limit = resolveLighthouseFixItemLimit(input.limit);
  const items = createLighthouseFixPlanItems(lhr)
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

export function createLighthouseFixPlanItems(lhr: LighthouseResult): LighthouseFixPlanItem[] {
  const auditCategoryMap = buildAuditCategoryMap(lhr);
  const audits = Object.values(lhr.audits ?? {});
  const items = audits
    .filter((audit) => isActionableAudit(audit))
    .map((audit) => {
      const details = audit.details ?? {};
      const savingsMs = normalizeSavings(details.overallSavingsMs);
      const savingsBytes = normalizeSavings(details.overallSavingsBytes);
      const priority = classifyPriority(audit, savingsMs, savingsBytes);
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
