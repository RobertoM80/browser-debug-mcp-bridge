import { createHash } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, extname, resolve } from 'path';
import {
  applyDocumentPatches,
  normalizeDocumentPatches,
  type AppliedOverrideDocumentPatch,
} from './document-response-rewriter.js';
import {
  applyJsonPatches,
  normalizeJsonPatches,
  type AppliedOverrideResponseJsonPatch,
} from './json-rewrite.js';
import {
  normalizeOverrideMatchMode,
  isOverridePocRuleType,
  type OverridePocMatchMode,
  normalizeOverrideRequestMethod,
  type OverridePocRuleType,
} from './override-rule-types.js';
import { assertOverrideResponseRequestProductionSafe } from './override-capabilities.js';
import { applyRscFlightTextPatches as applyStructuredRscFlightTextPatches } from './rsc-flight-patch-safety.js';

export interface OverrideResponseTextPatch {
  search: string;
  replacement: string;
  expectedCount?: number;
  required: boolean;
}

export interface AppliedOverrideResponseTextPatch extends OverrideResponseTextPatch {
  matchedCount: number;
}

export interface PlannedRscFlightRuleMetadata {
  productionMode: 'structured-flight-v1';
  source: 'cdp-response' | 'extension-fetch';
  patchKind: 'string-value-text';
  textPatches: Array<{
    search: string;
    replacement: string;
    expectedCount: number;
  }>;
  originalSha256: string;
  patchedSha256: string;
  originalBytes: number;
  patchedBytes: number;
  contentType: string;
  requestHeaders?: Record<string, string>;
}

export interface PlannedOverrideResponseRule {
  ruleId: string;
  ruleType: OverridePocRuleType;
  requestMethod: string;
  matchMode: OverridePocMatchMode;
  targetAssetUrl: string;
  localFilePath: string;
  contentType: string;
  enabled: true;
  rscFlight?: PlannedRscFlightRuleMetadata;
}

export interface OverrideResponsePatchPlanResult {
  targetUrl: string;
  ruleType: OverridePocRuleType;
  requestMethod: string;
  matchMode: OverridePocMatchMode;
  contentType: string;
  originalBytes: number;
  patchedBytes: number;
  originalSha256: string;
  patchedSha256: string;
  patches: AppliedOverrideResponseTextPatch[];
  jsonPatches: AppliedOverrideResponseJsonPatch[];
  documentPatches: AppliedOverrideDocumentPatch[];
  localFilePath?: string;
  configPath?: string;
  configWritten: boolean;
  rule?: PlannedOverrideResponseRule;
  preview?: {
    before: string;
    after: string;
  };
  warnings: string[];
  blockers: string[];
  nextActions: Array<{ code: string; message: string }>;
}

export interface OverrideResponsePatchPlannerOptions {
  targetUrl?: unknown;
  targetAssetUrl?: unknown;
  ruleType?: unknown;
  requestMethod?: unknown;
  matchMode?: unknown;
  contentType?: unknown;
  responseBodyText?: unknown;
  bodyText?: unknown;
  responseBodyBase64?: unknown;
  bodyBase64?: unknown;
  textPatches?: unknown;
  jsonPatches?: unknown;
  documentPatches?: unknown;
  maxBodyBytes?: unknown;
  outputRoot?: unknown;
  configPath?: unknown;
  writeBody?: unknown;
  writeConfig?: unknown;
  overwrite?: unknown;
  enabled?: unknown;
  profileEnabled?: unknown;
  autoReload?: unknown;
  captureMode?: unknown;
  captureSource?: unknown;
  source?: unknown;
  requestHeaders?: unknown;
  profileId?: unknown;
  profileName?: unknown;
  ruleId?: unknown;
  includePreview?: unknown;
}

const DEFAULT_MAX_RESPONSE_PATCH_BYTES = 1024 * 1024;
const HARD_MAX_RESPONSE_PATCH_BYTES = 5 * 1024 * 1024;
const RSC_FLIGHT_LIMITED_SUPPORT_WARNING =
  'RSC flight response overrides are limited to captured text/x-component responses with structured JSON string-value replacements.';
const NEXT_RSC_CONTEXT_HEADERS = new Set([
  'rsc',
  'next-router-prefetch',
  'purpose',
]);
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeTargetUrl(options: Pick<OverrideResponsePatchPlannerOptions, 'targetUrl' | 'targetAssetUrl'>): string {
  const raw = normalizeOptionalString(options.targetUrl) ?? normalizeOptionalString(options.targetAssetUrl);
  if (!raw) {
    throw new Error('targetUrl is required');
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('targetUrl must use http:// or https://');
    }
    return parsed.toString();
  } catch (error) {
    if (error instanceof Error && error.message.includes('targetUrl must use')) {
      throw error;
    }
    throw new Error('targetUrl must be a valid absolute http(s) URL');
  }
}

function resolveMaxBodyBytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_MAX_RESPONSE_PATCH_BYTES;
  }

  const floored = Math.floor(value);
  if (floored < 1) {
    return DEFAULT_MAX_RESPONSE_PATCH_BYTES;
  }

  return Math.min(floored, HARD_MAX_RESPONSE_PATCH_BYTES);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeRscCaptureSource(options: OverrideResponsePatchPlannerOptions): PlannedRscFlightRuleMetadata['source'] | undefined {
  const raw = normalizeOptionalString(options.captureMode)
    ?? normalizeOptionalString(options.captureSource)
    ?? normalizeOptionalString(options.source);
  if (raw === 'cdp-response' || raw === 'extension-fetch') {
    return raw;
  }
  return undefined;
}

function normalizeRscRequestHeaders(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const headers: Record<string, string> = {};
  for (const [name, rawHeaderValue] of Object.entries(value as Record<string, unknown>)) {
    const normalizedName = name.trim().toLowerCase();
    if (!NEXT_RSC_CONTEXT_HEADERS.has(normalizedName) || typeof rawHeaderValue !== 'string') {
      continue;
    }
    const trimmedValue = rawHeaderValue.trim();
    if (trimmedValue.length > 0) {
      headers[normalizedName] = trimmedValue;
    }
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

function inferRuleType(targetUrl: string, contentType: string, rawRuleType: unknown): OverridePocRuleType {
  if (rawRuleType !== undefined) {
    if (!isOverridePocRuleType(rawRuleType)) {
      throw new Error('ruleType must be one of asset, document, rsc-flight, next-data, api-response');
    }
    return rawRuleType;
  }

  const parsed = new URL(targetUrl);
  const lowerContentType = contentType.toLowerCase();
  if (lowerContentType.includes('text/x-component') || parsed.searchParams.has('_rsc')) {
    return 'rsc-flight';
  }
  if (parsed.pathname.includes('/_next/data/')) {
    return 'next-data';
  }
  if (lowerContentType.includes('text/html')) {
    return 'document';
  }
  if (lowerContentType.includes('json') || lowerContentType.startsWith('text/')) {
    return 'api-response';
  }
  return 'document';
}

function defaultContentType(ruleType: OverridePocRuleType): string {
  switch (ruleType) {
    case 'document':
      return 'text/html; charset=utf-8';
    case 'rsc-flight':
      return 'text/x-component; charset=utf-8';
    case 'next-data':
    case 'api-response':
      return 'application/json; charset=utf-8';
    case 'asset':
      return 'text/plain; charset=utf-8';
  }
}

function normalizeContentType(value: unknown, targetUrl: string, rawRuleType: unknown): { contentType: string; ruleType: OverridePocRuleType } {
  const preliminary = normalizeOptionalString(value) ?? '';
  const ruleType = inferRuleType(targetUrl, preliminary, rawRuleType);
  return {
    ruleType,
    contentType: preliminary || defaultContentType(ruleType),
  };
}

function isTextualContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase().split(';', 1)[0]?.trim() ?? '';
  return normalized.startsWith('text/')
    || normalized === 'application/json'
    || normalized.endsWith('+json')
    || normalized === 'application/javascript'
    || normalized === 'application/xml'
    || normalized.endsWith('+xml')
    || normalized === 'image/svg+xml'
    || normalized === 'application/x-ndjson';
}

function isJsonLike(ruleType: OverridePocRuleType, contentType: string, body: string): boolean {
  const normalized = contentType.toLowerCase();
  const trimmed = body.trimStart();
  return ruleType === 'next-data'
    || normalized.includes('json')
    || normalized.includes('+json')
    || ((ruleType === 'api-response' || ruleType === 'asset') && (trimmed.startsWith('{') || trimmed.startsWith('[')));
}

function isLikelyRscFlightBody(body: string): boolean {
  return body.length > 0 && /(^|\n)\d+:/u.test(body);
}

function assertValidJson(body: string, label: string): void {
  try {
    JSON.parse(body);
  } catch (error) {
    throw new Error(`${label} response body must remain valid JSON: ${error instanceof Error ? error.message : 'invalid JSON'}`);
  }
}

function decodeBody(options: OverrideResponsePatchPlannerOptions): string {
  const bodyText = normalizeOptionalString(options.responseBodyText) ?? normalizeOptionalString(options.bodyText);
  const bodyBase64 = normalizeOptionalString(options.responseBodyBase64) ?? normalizeOptionalString(options.bodyBase64);
  if (bodyText !== undefined && bodyBase64 !== undefined) {
    throw new Error('Provide either responseBodyText or responseBodyBase64, not both');
  }
  if (bodyText !== undefined) {
    return bodyText;
  }
  if (bodyBase64 !== undefined) {
    return Buffer.from(bodyBase64, 'base64').toString('utf8');
  }
  throw new Error('responseBodyText or responseBodyBase64 is required');
}

function normalizeTextPatches(value: unknown): OverrideResponseTextPatch[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('textPatches must include at least one patch');
  }

  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`textPatches[${index}] must be an object`);
    }
    const patch = entry as Record<string, unknown>;
    const search = normalizeOptionalString(patch.search);
    if (!search) {
      throw new Error(`textPatches[${index}].search must be a non-empty string`);
    }
    if (typeof patch.replacement !== 'string') {
      throw new Error(`textPatches[${index}].replacement must be a string`);
    }

    const expectedCount = patch.expectedCount;
    if (
      expectedCount !== undefined
      && (typeof expectedCount !== 'number' || !Number.isFinite(expectedCount) || Math.floor(expectedCount) < 0)
    ) {
      throw new Error(`textPatches[${index}].expectedCount must be a non-negative finite number when provided`);
    }

    return {
      search,
      replacement: patch.replacement,
      expectedCount: expectedCount === undefined ? undefined : Math.floor(expectedCount),
      required: patch.required !== false,
    };
  });
}

function countOccurrences(source: string, search: string): number {
  return source.split(search).length - 1;
}

function applyTextPatches(body: string, patches: OverrideResponseTextPatch[]): { patchedBody: string; applied: AppliedOverrideResponseTextPatch[]; warnings: string[] } {
  let patchedBody = body;
  const applied: AppliedOverrideResponseTextPatch[] = [];
  const warnings: string[] = [];

  for (const patch of patches) {
    const matchedCount = countOccurrences(patchedBody, patch.search);
    if (patch.expectedCount !== undefined && matchedCount !== patch.expectedCount) {
      throw new Error(`Patch search ${JSON.stringify(patch.search)} matched ${matchedCount} time(s), expected ${patch.expectedCount}`);
    }
    if (matchedCount === 0 && patch.required) {
      throw new Error(`Patch search text was not found: ${JSON.stringify(patch.search)}`);
    }
    if (matchedCount === 0) {
      warnings.push(`Optional patch search text was not found: ${JSON.stringify(patch.search)}`);
    }
    if (matchedCount > 0 && patch.search === patch.replacement) {
      warnings.push(`Patch search ${JSON.stringify(patch.search)} is a no-op replacement.`);
    }

    patchedBody = patchedBody.split(patch.search).join(patch.replacement);
    applied.push({
      ...patch,
      matchedCount,
    });
  }

  if (patchedBody === body) {
    throw new Error('No response patch changed the body');
  }

  return { patchedBody, applied, warnings };
}

function fileExtensionForContentType(contentType: string, ruleType: OverridePocRuleType): string {
  const normalized = contentType.toLowerCase();
  if (normalized.includes('html')) {
    return '.html';
  }
  if (normalized.includes('json') || ruleType === 'next-data') {
    return '.json';
  }
  if (normalized.includes('javascript')) {
    return '.js';
  }
  if (normalized.includes('css')) {
    return '.css';
  }
  if (normalized.includes('x-component') || ruleType === 'rsc-flight') {
    return '.rsc.txt';
  }
  return '.txt';
}

function resolveOutputPath(options: {
  outputRoot?: string;
  configPath?: string;
  targetUrl: string;
  ruleType: OverridePocRuleType;
  contentType: string;
  patchedSha256: string;
}): string {
  const outputRoot = options.outputRoot
    ?? (options.configPath ? resolve(dirname(options.configPath), 'tmp', 'bn', 'response-overrides') : undefined);
  if (!outputRoot) {
    throw new Error('outputRoot or configPath is required when writeBody/writeConfig is true');
  }

  const parsed = new URL(options.targetUrl);
  const basename = parsed.pathname.split('/').filter(Boolean).pop() ?? 'document';
  const cleanBasename = basename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60) || 'response';
  const currentExtension = extname(cleanBasename);
  const extension = currentExtension || fileExtensionForContentType(options.contentType, options.ruleType);
  const stem = currentExtension ? cleanBasename.slice(0, -currentExtension.length) : cleanBasename;
  return resolve(outputRoot, `${options.ruleType}-${stem}-${options.patchedSha256.slice(0, 12)}${extension}`);
}

function writeOverrideConfig(options: {
  configPath: string;
  rule: PlannedOverrideResponseRule;
  profileId?: string;
  profileName?: string;
  enabled?: boolean;
  profileEnabled?: boolean;
  autoReload?: boolean;
  overwrite?: boolean;
}): void {
  if (existsSync(options.configPath) && options.overwrite === false) {
    throw new Error(`Refusing to overwrite existing override config: ${options.configPath}`);
  }

  const profileId = options.profileId ?? 'response-patch';
  mkdirSync(dirname(options.configPath), { recursive: true });
  writeFileSync(
    options.configPath,
    `${JSON.stringify({
      enabled: options.enabled ?? true,
      activeProfileId: profileId,
      profiles: [{
        profileId,
        name: options.profileName ?? 'Response body patch',
        enabled: options.profileEnabled ?? true,
        autoReload: options.autoReload ?? true,
        rules: [options.rule],
      }],
    }, null, 2)}\n`,
    'utf8',
  );
}

function buildNextActions(result: Pick<OverrideResponsePatchPlanResult, 'rule' | 'configWritten' | 'blockers'>): Array<{ code: string; message: string }> {
  if (result.blockers.length > 0) {
    return [{ code: 'FIX_RESPONSE_PATCH_BLOCKERS', message: 'Resolve response patch blockers before enabling overrides.' }];
  }
  if (!result.rule) {
    return [{ code: 'WRITE_RESPONSE_BODY', message: 'Run again with writeBody=true or writeConfig=true to create a local response body.' }];
  }
  if (!result.configWritten) {
    return [{ code: 'WRITE_OVERRIDE_CONFIG', message: 'Run again with writeConfig=true to make the response patch enableable.' }];
  }
  return [{ code: 'ENABLE_OVERRIDES', message: 'Validate the generated profile, then enable overrides on the target tab.' }];
}

function buildRscFlightMetadata(options: {
  plannerOptions: OverrideResponsePatchPlannerOptions;
  targetUrl: string;
  requestMethod: string;
  contentType: string;
  body: string;
  patchedBody: string;
  originalSha256: string;
  patchedSha256: string;
  originalBytes: number;
  patchedBytes: number;
  appliedPatches: AppliedOverrideResponseTextPatch[];
}): { metadata?: PlannedRscFlightRuleMetadata; blockers: string[]; warnings: string[] } {
  const blockers: string[] = [];
  const warnings = [RSC_FLIGHT_LIMITED_SUPPORT_WARNING];
  const source = normalizeRscCaptureSource(options.plannerOptions);
  const parsedTargetUrl = new URL(options.targetUrl);
  const rscRequestHeaders = normalizeRscRequestHeaders(options.plannerOptions.requestHeaders);
  const isCapturedPostRscFlight = options.requestMethod === 'POST' && rscRequestHeaders?.rsc === '1';

  if (!source) {
    blockers.push('RSC flight response config writing requires a body captured with captureMode "cdp-response" or "extension-fetch".');
  }
  if (options.requestMethod !== 'GET' && !isCapturedPostRscFlight) {
    blockers.push('RSC flight response overrides only support GET requests or captured POST RSC response-stage patches.');
  }
  if (options.requestMethod === 'GET' && !parsedTargetUrl.searchParams.has('_rsc')) {
    blockers.push('RSC flight response targetUrl must include the Next.js _rsc search parameter.');
  }
  if (!options.contentType.toLowerCase().includes('text/x-component')) {
    blockers.push('RSC flight response overrides require a text/x-component content type.');
  }
  if (!isLikelyRscFlightBody(options.body)) {
    blockers.push('Original RSC flight response body does not match the supported Flight payload shape.');
  }
  if (!isLikelyRscFlightBody(options.patchedBody)) {
    blockers.push('Patched RSC flight response body does not match the supported Flight payload shape.');
  }
  if (!SHA256_HEX_PATTERN.test(options.originalSha256) || !SHA256_HEX_PATTERN.test(options.patchedSha256)) {
    blockers.push('RSC flight response hashes are invalid.');
  }
  if (options.originalSha256 === options.patchedSha256) {
    blockers.push('RSC flight response patches must change the response body hash.');
  }

  if (blockers.length > 0 || !source) {
    return { blockers, warnings };
  }

  return {
    blockers,
    warnings,
    metadata: {
      productionMode: 'structured-flight-v1',
      source,
      patchKind: 'string-value-text',
      textPatches: options.appliedPatches.map((patch) => ({
        search: patch.search,
        replacement: patch.replacement,
        expectedCount: patch.expectedCount ?? patch.matchedCount,
      })),
      originalSha256: options.originalSha256,
      patchedSha256: options.patchedSha256,
      originalBytes: options.originalBytes,
      patchedBytes: options.patchedBytes,
      contentType: options.contentType,
      requestHeaders: rscRequestHeaders,
    },
  };
}

export function planOverrideResponsePatch(options: OverrideResponsePatchPlannerOptions): OverrideResponsePatchPlanResult {
  const targetUrl = normalizeTargetUrl(options);
  const { contentType, ruleType } = normalizeContentType(options.contentType, targetUrl, options.ruleType);
  if (!isTextualContentType(contentType)) {
    throw new Error(`Response content type is not supported for response patching: ${contentType}`);
  }

  const requestMethod = normalizeOverrideRequestMethod(options.requestMethod);
  assertOverrideResponseRequestProductionSafe({
    requestMethod,
    requestHeaders: options.requestHeaders,
    ruleType,
  });
  const matchMode = normalizeOverrideMatchMode(options.matchMode);
  const maxBodyBytes = resolveMaxBodyBytes(options.maxBodyBytes);
  const body = decodeBody(options);
  const originalBytes = byteLength(body);
  if (originalBytes > maxBodyBytes) {
    throw new Error(`Response body is ${originalBytes} byte(s), above maxBodyBytes ${maxBodyBytes}`);
  }

  const hasTextPatches = options.textPatches !== undefined;
  const hasJsonPatches = options.jsonPatches !== undefined;
  const hasDocumentPatches = options.documentPatches !== undefined;
  const providedPatchKinds = [hasTextPatches, hasJsonPatches, hasDocumentPatches].filter(Boolean).length;
  if (providedPatchKinds !== 1) {
    throw new Error('Provide exactly one of textPatches, jsonPatches, or documentPatches');
  }

  const patches = hasTextPatches ? normalizeTextPatches(options.textPatches) : [];
  const jsonPatches = hasJsonPatches ? normalizeJsonPatches(options.jsonPatches) : [];
  const documentPatches = hasDocumentPatches ? normalizeDocumentPatches(options.documentPatches) : [];
  const jsonLike = isJsonLike(ruleType, contentType, body);
  const supportsStructuredJsonPatches = ruleType === 'next-data' || ruleType === 'api-response';
  if (hasJsonPatches && (!supportsStructuredJsonPatches || !jsonLike)) {
    throw new Error('jsonPatches are only supported for JSON-like next-data or api-response bodies');
  }
  if (hasDocumentPatches && ruleType !== 'document') {
    throw new Error('documentPatches are only supported for document response bodies');
  }
  if (jsonLike && patches.length > 0) {
    assertValidJson(body, 'Original');
  }

  const {
    patchedBody,
    applied,
    appliedJsonPatches,
    appliedDocumentPatches,
    warnings,
  } = documentPatches.length > 0
    ? (() => {
        const documentResult = applyDocumentPatches(body, documentPatches);
        return {
          patchedBody: documentResult.patchedBody,
          applied: [] as AppliedOverrideResponseTextPatch[],
          appliedJsonPatches: [] as AppliedOverrideResponseJsonPatch[],
          appliedDocumentPatches: documentResult.applied,
          warnings: documentResult.warnings,
        };
      })()
    : jsonPatches.length > 0
    ? (() => {
        const jsonResult = applyJsonPatches(body, jsonPatches);
        return {
          patchedBody: jsonResult.patchedBody,
          applied: [] as AppliedOverrideResponseTextPatch[],
          appliedJsonPatches: jsonResult.applied,
          appliedDocumentPatches: [] as AppliedOverrideDocumentPatch[],
          warnings: jsonResult.warnings,
        };
      })()
    : ruleType === 'rsc-flight'
    ? (() => {
        const rscResult = applyStructuredRscFlightTextPatches(body, patches);
        const blocker = rscResult.blockers[0];
        if (blocker) {
          throw new Error(blocker.message);
        }
        if (rscResult.patchedBody === body) {
          throw new Error('No response patch changed the body');
        }
        return {
          patchedBody: rscResult.patchedBody,
          applied: rscResult.applied.map((patch) => ({
            search: patch.search,
            replacement: patch.replacement,
            expectedCount: patch.expectedCount,
            required: patch.required !== false,
            matchedCount: patch.matchedCount,
          })),
          appliedJsonPatches: [] as AppliedOverrideResponseJsonPatch[],
          appliedDocumentPatches: [] as AppliedOverrideDocumentPatch[],
          warnings: rscResult.warnings,
        };
      })()
    : (() => {
        const textResult = applyTextPatches(body, patches);
        return {
          patchedBody: textResult.patchedBody,
          applied: textResult.applied,
          appliedJsonPatches: [] as AppliedOverrideResponseJsonPatch[],
          appliedDocumentPatches: [] as AppliedOverrideDocumentPatch[],
          warnings: textResult.warnings,
        };
      })();
  if (isJsonLike(ruleType, contentType, patchedBody)) {
    assertValidJson(patchedBody, 'Patched');
  }

  const patchedBytes = byteLength(patchedBody);
  if (patchedBytes > maxBodyBytes) {
    throw new Error(`Patched response body is ${patchedBytes} byte(s), above maxBodyBytes ${maxBodyBytes}`);
  }

  const originalSha256 = sha256(body);
  const patchedSha256 = sha256(patchedBody);
  const configPath = normalizeOptionalString(options.configPath);
  const outputRoot = normalizeOptionalString(options.outputRoot);
  const blockers: string[] = [];
  let rscFlightMetadata: PlannedRscFlightRuleMetadata | undefined;
  if (ruleType === 'rsc-flight') {
    const rscFlight = buildRscFlightMetadata({
      plannerOptions: options,
      targetUrl,
      requestMethod,
      contentType,
      body,
      patchedBody,
      originalSha256,
      patchedSha256,
      originalBytes,
      patchedBytes,
      appliedPatches: applied,
    });
    blockers.push(...rscFlight.blockers);
    warnings.push(...rscFlight.warnings);
    rscFlightMetadata = rscFlight.metadata;
    if (options.writeConfig === true) {
      warnings.push(
        rscFlight.metadata
          ? 'Generated RSC flight override config includes production structured-flight metadata.'
          : 'Override config was not written because the RSC flight response did not pass production safety checks.',
      );
    }
  }

  const shouldWriteBody = options.writeBody === true || (options.writeConfig === true && blockers.length === 0);
  const shouldWriteConfig = options.writeConfig === true && blockers.length === 0;
  let localFilePath: string | undefined;
  let rule: PlannedOverrideResponseRule | undefined;

  if (shouldWriteBody || shouldWriteConfig) {
    localFilePath = resolveOutputPath({
      outputRoot,
      configPath,
      targetUrl,
      ruleType,
      contentType,
      patchedSha256,
    });
    mkdirSync(dirname(localFilePath), { recursive: true });
    writeFileSync(localFilePath, patchedBody, 'utf8');
    if (blockers.length === 0) {
      rule = {
        ruleId: normalizeOptionalString(options.ruleId) ?? 'response-1',
        ruleType,
        requestMethod,
        matchMode,
        targetAssetUrl: targetUrl,
        localFilePath,
        contentType,
        enabled: true,
        rscFlight: rscFlightMetadata,
      };
    }
  }

  if (shouldWriteConfig) {
    if (!configPath) {
      throw new Error('configPath is required when writeConfig is true');
    }
    if (!rule) {
      throw new Error('A generated response rule is required when writeConfig is true');
    }
    writeOverrideConfig({
      configPath,
      rule,
      profileId: normalizeOptionalString(options.profileId),
      profileName: normalizeOptionalString(options.profileName),
      enabled: options.enabled === false ? false : true,
      profileEnabled: options.profileEnabled === false ? false : true,
      autoReload: options.autoReload !== false,
      overwrite: typeof options.overwrite === 'boolean' ? options.overwrite : undefined,
    });
  }

  const resultWithoutActions = {
    targetUrl,
    ruleType,
    requestMethod,
    matchMode,
    contentType,
    originalBytes,
    patchedBytes,
    originalSha256,
    patchedSha256,
    patches: applied,
    jsonPatches: appliedJsonPatches,
    documentPatches: appliedDocumentPatches,
    localFilePath,
    configPath,
    configWritten: shouldWriteConfig,
    rule,
    preview: options.includePreview === true
      ? {
          before: body.slice(0, 500),
          after: patchedBody.slice(0, 500),
        }
      : undefined,
    warnings,
    blockers,
  } satisfies Omit<OverrideResponsePatchPlanResult, 'nextActions'>;

  return {
    ...resultWithoutActions,
    nextActions: buildNextActions(resultWithoutActions),
  };
}
