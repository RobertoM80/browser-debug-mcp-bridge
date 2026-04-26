import { spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, extname, isAbsolute, relative, resolve } from 'path';
import {
  createNextAssetIndex,
  mapNextOverrideAssets,
  mapNextOverrideAssetsWithDrift,
  nextAssetSourceMatches,
  normalizeNextSourcePath,
  type NextAssetMappingCandidate,
  type NextAssetRecord,
  type OverrideAssetConfidence,
} from './next-asset-mapper.js';

export interface NextSourceEditInput {
  filePath?: unknown;
  content?: unknown;
  search?: unknown;
  replace?: unknown;
  replacement?: unknown;
  replaceAll?: unknown;
}

export interface AppliedNextSourceEdit {
  filePath: string;
  absolutePath: string;
  operation: 'replace_content' | 'replace_text';
  replacements: number;
}

export interface PlannedNextOverrideRule {
  ruleId: string;
  targetAssetUrl: string;
  localFilePath: string;
  localAssetPath: string;
  contentType: string;
  confidence: OverrideAssetConfidence;
  score: number;
  reason: string;
  matchedSourcePaths: string[];
  originalAssetPath?: string;
  blockers: string[];
}

export interface NextSourceOverridePlanResult {
  projectRoot: string;
  workspaceRoot: string;
  overlayRoot: string;
  overlayProjectRoot: string;
  overlayNextDir: string;
  route?: string;
  sourcePaths: string[];
  editsApplied: AppliedNextSourceEdit[];
  build: {
    command: string;
    cwd: string;
    exitCode: number;
    durationMs: number;
    stdoutTail: string;
    stderrTail: string;
  };
  mappingCandidateCount: number;
  changedAssetCount: number;
  dependencyRuleCount: number;
  rules: PlannedNextOverrideRule[];
  configPath?: string;
  configWritten: boolean;
  warnings: string[];
  blockers: string[];
  nextActions: Array<{ code: string; message: string }>;
}

interface NormalizedSourceEdit {
  filePath: string;
  content?: string;
  search?: string;
  replacement?: string;
  replaceAll: boolean;
}

const DEFAULT_BUILD_TIMEOUT_MS = 180_000;
const DEFAULT_OVERLAY_TTL_MS = 24 * 60 * 60 * 1000;
const CAPTURED_OUTPUT_TAIL_BYTES = 24 * 1024;
const LOW_CONFIDENCE_SCORE = 44;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeSourceEdits(values: unknown): NormalizedSourceEdit[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const edits: NormalizedSourceEdit[] = [];
  for (const value of values) {
    if (!isRecord(value)) {
      continue;
    }

    const filePath = normalizeOptionalString(value.filePath);
    if (!filePath) {
      continue;
    }

    const content = typeof value.content === 'string' ? value.content : undefined;
    const search = typeof value.search === 'string' ? value.search : undefined;
    const replacement = typeof value.replacement === 'string'
      ? value.replacement
      : typeof value.replace === 'string'
        ? value.replace
        : undefined;

    edits.push({
      filePath,
      content,
      search,
      replacement,
      replaceAll: value.replaceAll === true,
    });
  }

  return edits;
}

function isInsidePath(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function findWorkspaceRoot(projectRoot: string): string {
  let current = resolve(projectRoot);
  while (true) {
    if (existsSync(resolve(current, 'package.json'))) {
      return current;
    }

    const parent = resolve(current, '..');
    if (parent === current) {
      return resolve(projectRoot);
    }
    current = parent;
  }
}

function findNextBin(projectRoot: string, workspaceRoot: string): string {
  let current = resolve(projectRoot);
  while (true) {
    const candidate = resolve(current, 'node_modules', 'next', 'dist', 'bin', 'next');
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = resolve(current, '..');
    if (parent === current) {
      break;
    }
    current = parent;
  }

  const workspaceCandidate = resolve(workspaceRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (existsSync(workspaceCandidate)) {
    return workspaceCandidate;
  }

  throw new Error(`Unable to locate Next.js CLI from ${projectRoot}. Install next in the project workspace before planning source overrides.`);
}

function createOverlay(projectRoot: string, workspaceRoot: string): { overlayRoot: string; overlayProjectRoot: string } {
  const relativeProjectRoot = relative(workspaceRoot, projectRoot);
  if (relativeProjectRoot.startsWith('..')) {
    throw new Error(`projectRoot must be inside the detected workspace root (${workspaceRoot})`);
  }

  const overlayRoot = resolve(workspaceRoot, 'tmp', 'bn', randomUUID().slice(0, 8));
  const overlayProjectRoot = resolve(overlayRoot, relativeProjectRoot);
  mkdirSync(dirname(overlayProjectRoot), { recursive: true });

  const rootFiles = ['package.json', 'nx.json', 'tsconfig.base.json', 'tsconfig.json', 'jsconfig.json'];
  for (const rootFile of rootFiles) {
    const sourcePath = resolve(workspaceRoot, rootFile);
    if (!existsSync(sourcePath)) {
      continue;
    }
    const targetPath = resolve(overlayRoot, rootFile);
    mkdirSync(dirname(targetPath), { recursive: true });
    cpSync(sourcePath, targetPath);
  }

  cpSync(projectRoot, overlayProjectRoot, {
    recursive: true,
    filter: (sourcePath) => {
      const name = sourcePath.split(/[\\/]/).pop() ?? '';
      return !['.next', 'node_modules', 'dist', 'out', 'coverage', '.turbo'].includes(name);
    },
  });

  return { overlayRoot, overlayProjectRoot };
}

export function cleanupNextSourceOverlayRoots(workspaceRoot: string, ttlMs: number = DEFAULT_OVERLAY_TTL_MS, now: number = Date.now()): number {
  const overlayBase = resolve(workspaceRoot, 'tmp', 'bn');
  if (!existsSync(overlayBase)) {
    return 0;
  }

  let removed = 0;
  for (const entry of readdirSync(overlayBase, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const fullPath = resolve(overlayBase, entry.name);
    const ageMs = now - statSync(fullPath).mtimeMs;
    if (ageMs >= ttlMs) {
      rmSync(fullPath, { recursive: true, force: true });
      removed += 1;
    }
  }

  return removed;
}

function applySourceEdits(overlayProjectRoot: string, edits: NormalizedSourceEdit[]): AppliedNextSourceEdit[] {
  const applied: AppliedNextSourceEdit[] = [];
  for (const edit of edits) {
    const absolutePath = resolve(overlayProjectRoot, edit.filePath);
    if (!isInsidePath(overlayProjectRoot, absolutePath)) {
      throw new Error(`source edit path escapes projectRoot: ${edit.filePath}`);
    }

    if (edit.content !== undefined) {
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, edit.content, 'utf8');
      applied.push({
        filePath: edit.filePath,
        absolutePath,
        operation: 'replace_content',
        replacements: existsSync(absolutePath) ? 1 : 0,
      });
      continue;
    }

    if (edit.search === undefined || edit.replacement === undefined) {
      throw new Error(`source edit for ${edit.filePath} must provide content or search plus replacement`);
    }
    if (!existsSync(absolutePath)) {
      throw new Error(`source edit target not found: ${edit.filePath}`);
    }

    const originalContent = readFileSync(absolutePath, 'utf8');
    if (!originalContent.includes(edit.search)) {
      throw new Error(`source edit search text not found in ${edit.filePath}`);
    }

    const replacements = edit.replaceAll ? originalContent.split(edit.search).length - 1 : 1;
    const updatedContent = edit.replaceAll
      ? originalContent.split(edit.search).join(edit.replacement)
      : originalContent.replace(edit.search, edit.replacement);
    writeFileSync(absolutePath, updatedContent, 'utf8');
    applied.push({
      filePath: edit.filePath,
      absolutePath,
      operation: 'replace_text',
      replacements,
    });
  }

  return applied;
}

function appendOutputTail(current: string, chunk: Buffer): string {
  const next = current + chunk.toString('utf8');
  if (Buffer.byteLength(next, 'utf8') <= CAPTURED_OUTPUT_TAIL_BYTES) {
    return next;
  }

  return next.slice(next.length - CAPTURED_OUTPUT_TAIL_BYTES);
}

async function runNextBuild(options: {
  projectRoot: string;
  overlayProjectRoot: string;
  workspaceRoot: string;
  timeoutMs: number;
}): Promise<NextSourceOverridePlanResult['build']> {
  const nextBin = findNextBin(options.projectRoot, options.workspaceRoot);
  const startedAt = Date.now();
  const args = [nextBin, 'build', options.overlayProjectRoot];
  const child = spawn(process.execPath, args, {
    cwd: options.workspaceRoot,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: '1',
    },
    windowsHide: true,
  });

  let stdoutTail = '';
  let stderrTail = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutTail = appendOutputTail(stdoutTail, chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = appendOutputTail(stderrTail, chunk);
  });

  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Next.js overlay build timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolvePromise(code ?? 1);
    });
  });

  const build = {
    command: `${process.execPath} ${nextBin} build ${options.overlayProjectRoot}`,
    cwd: options.workspaceRoot,
    exitCode,
    durationMs: Date.now() - startedAt,
    stdoutTail,
    stderrTail,
  };

  if (exitCode !== 0) {
    throw new Error(`Next.js overlay build failed with exit code ${exitCode}\n${stderrTail || stdoutTail}`);
  }

  return build;
}

function getContentType(assetPath: string): string {
  const extension = extname(assetPath).toLowerCase();
  if (extension === '.css') {
    return 'text/css; charset=utf-8';
  }
  return 'application/javascript; charset=utf-8';
}

function hashFile(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function extractQuotedLiterals(value: string): string[] {
  const literals: string[] = [];
  for (const match of value.matchAll(/(['"])((?:\\.|(?!\1)[\s\S])*?)\1/g)) {
    if (match[2] !== undefined) {
      literals.push(match[2].replace(/\\'/g, "'").replace(/\\"/g, '"'));
    }
  }
  return literals;
}

function inferAssetTextReplacements(edits: NormalizedSourceEdit[]): Array<{ search: string; replacement: string }> {
  const replacements = new Map<string, string>();
  for (const edit of edits) {
    if (!edit.search || edit.replacement === undefined) {
      continue;
    }

    const oldLiterals = extractQuotedLiterals(edit.search);
    const newLiterals = extractQuotedLiterals(edit.replacement);
    const pairCount = Math.min(oldLiterals.length, newLiterals.length);
    for (let index = 0; index < pairCount; index += 1) {
      const search = oldLiterals[index];
      const replacement = newLiterals[index];
      if (search && replacement !== undefined && search !== replacement) {
        replacements.set(search, replacement);
      }
    }
  }

  return Array.from(replacements.entries()).map(([search, replacement]) => ({ search, replacement }));
}

function createPatchedObservedAsset(options: {
  originalAsset: NextAssetRecord;
  overlayRoot: string;
  replacements: Array<{ search: string; replacement: string }>;
  ruleIndex: number;
}): NextAssetRecord | undefined {
  if (options.replacements.length === 0) {
    return undefined;
  }

  let content = readFileSync(options.originalAsset.localFilePath, 'utf8');
  let replacementCount = 0;
  for (const replacement of options.replacements) {
    if (!content.includes(replacement.search)) {
      continue;
    }
    replacementCount += content.split(replacement.search).length - 1;
    content = content.split(replacement.search).join(replacement.replacement);
  }

  if (replacementCount === 0) {
    return undefined;
  }

  const patchDir = resolve(options.overlayRoot, 'patches');
  mkdirSync(patchDir, { recursive: true });
  const patchPath = resolve(patchDir, `${options.ruleIndex}-${options.originalAsset.assetPath.replace(/[\\/]/g, '_')}`);
  writeFileSync(patchPath, content, 'utf8');
  const stat = statSync(patchPath);

  return {
    ...options.originalAsset,
    localFilePath: patchPath,
    sizeBytes: stat.size,
    sha256: hashFile(patchPath),
  };
}

function candidateUrlPrefix(candidate: NextAssetMappingCandidate): string | undefined {
  const index = candidate.targetAssetUrl.indexOf(candidate.assetPath);
  if (index < 0) {
    return undefined;
  }
  return candidate.targetAssetUrl.slice(0, index);
}

function assetMatchesAnySource(asset: NextAssetRecord, sourcePaths: string[]): string[] {
  return sourcePaths.filter((sourcePath) => {
    return asset.sources.some((source) => nextAssetSourceMatches(source, sourcePath));
  });
}

function scoreTempAssetForCandidate(asset: NextAssetRecord, candidate: NextAssetMappingCandidate, sourcePaths: string[]): number {
  const requestedSources = candidate.matchedSourcePaths.length > 0 ? candidate.matchedSourcePaths : sourcePaths;
  const sourceScore = assetMatchesAnySource(asset, requestedSources).length * 100;
  const extensionScore = extname(candidate.localFilePath).toLowerCase() === asset.extension ? 20 : 0;
  const routeScore = candidate.manifestRoutes.some((route) => asset.manifestRoutes.includes(route)) ? 10 : 0;
  return sourceScore + extensionScore + routeScore;
}

function findBestTempAssetForCandidate(
  tempAssets: NextAssetRecord[],
  candidate: NextAssetMappingCandidate,
  sourcePaths: string[],
): NextAssetRecord | undefined {
  return tempAssets
    .map((asset) => ({ asset, score: scoreTempAssetForCandidate(asset, candidate, sourcePaths) }))
    .filter((entry) => entry.score > 0)
    .sort((first, second) => second.score - first.score || first.asset.assetPath.localeCompare(second.asset.assetPath))[0]?.asset;
}

function extractReferencedNextAssets(asset: NextAssetRecord): string[] {
  const content = readFileSync(asset.localFilePath, 'utf8');
  const references = new Set<string>();
  const patterns = [
    /\/_next\/(static\/[^"'`)\s]+?\.(?:js|css))(?:[?#][^"'`)\s]*)?/g,
    /(?<![A-Za-z0-9_/-])(static\/[^"'`)\s]+?\.(?:js|css))(?:[?#][^"'`)\s]*)?/g,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) {
        references.add(match[1]);
      }
    }
  }

  return Array.from(references).sort();
}

function confidenceAllowed(confidence: OverrideAssetConfidence): boolean {
  return confidence === 'high';
}

function createRule(options: {
  ruleId: string;
  targetAssetUrl: string;
  localAsset: NextAssetRecord;
  reason: string;
  confidence: OverrideAssetConfidence;
  score: number;
  matchedSourcePaths: string[];
  originalAssetPath?: string;
  blockers?: string[];
}): PlannedNextOverrideRule {
  return {
    ruleId: options.ruleId,
    targetAssetUrl: options.targetAssetUrl,
    localFilePath: options.localAsset.localFilePath,
    localAssetPath: options.localAsset.assetPath,
    contentType: getContentType(options.localAsset.assetPath),
    confidence: options.confidence,
    score: options.score,
    reason: options.reason,
    matchedSourcePaths: options.matchedSourcePaths,
    originalAssetPath: options.originalAssetPath,
    blockers: options.blockers ?? [],
  };
}

function writeOverrideConfig(options: {
  configPath: string;
  rules: PlannedNextOverrideRule[];
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

  mkdirSync(dirname(options.configPath), { recursive: true });
  const profileId = options.profileId ?? 'next-source-overlay';
  writeFileSync(
    options.configPath,
    `${JSON.stringify({
      enabled: options.enabled ?? true,
      activeProfileId: profileId,
      profiles: [{
        profileId,
        name: options.profileName ?? 'Next.js source overlay',
        enabled: options.profileEnabled ?? true,
        autoReload: options.autoReload ?? true,
        rules: options.rules.map((rule) => ({
          ruleId: rule.ruleId,
          targetAssetUrl: rule.targetAssetUrl,
          localFilePath: rule.localFilePath,
          contentType: rule.contentType,
          enabled: true,
        })),
      }],
    }, null, 2)}\n`,
    'utf8',
  );
}

function buildNextActions(result: Pick<NextSourceOverridePlanResult, 'rules' | 'blockers' | 'configWritten'>): Array<{ code: string; message: string }> {
  if (result.blockers.length > 0 && result.rules.length === 0) {
    return [{ code: 'FIX_BLOCKERS', message: 'Resolve source mapping or build blockers before enabling overrides.' }];
  }
  if (result.configWritten) {
    return [{ code: 'ENABLE_OVERRIDES', message: 'Enable overrides for the selected session/tab to load the planned temp overlay chunks.' }];
  }
  if (result.rules.length > 0) {
    return [{ code: 'WRITE_CONFIG', message: 'Write these planned rules to an override profile config before enabling overrides.' }];
  }
  return [{ code: 'OBSERVE_ASSETS', message: 'Observe the live Next.js route assets, then plan the source override again.' }];
}

export async function planNextSourceOverride(options: {
  projectRoot: string;
  nextDir?: unknown;
  route?: unknown;
  observedAssets?: unknown;
  sourceEdits?: unknown;
  sourcePaths?: unknown;
  configPath?: unknown;
  writeConfig?: unknown;
  overwrite?: unknown;
  enabled?: unknown;
  profileEnabled?: unknown;
  autoReload?: unknown;
  profileId?: unknown;
  profileName?: unknown;
  buildTimeoutMs?: unknown;
  maxRules?: unknown;
  fetchProductionAssets?: unknown;
  productionFetchTimeoutMs?: unknown;
  maxProductionAssetBytes?: unknown;
  maxDriftCandidates?: unknown;
  productionFetchConcurrency?: unknown;
  overlayTtlMs?: unknown;
}): Promise<NextSourceOverridePlanResult> {
  const projectRoot = resolve(options.projectRoot);
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  const overlayTtlMs = typeof options.overlayTtlMs === 'number' && Number.isFinite(options.overlayTtlMs)
    ? Math.max(0, Math.floor(options.overlayTtlMs))
    : DEFAULT_OVERLAY_TTL_MS;
  const cleanedOverlayCount = cleanupNextSourceOverlayRoots(workspaceRoot, overlayTtlMs);
  const edits = normalizeSourceEdits(options.sourceEdits);
  if (edits.length === 0) {
    throw new Error('sourceEdits must include at least one file edit');
  }

  const sourcePathsFromInput = Array.isArray(options.sourcePaths)
    ? options.sourcePaths.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  const sourcePaths = Array.from(new Set([
    ...edits.map((edit) => normalizeNextSourcePath(projectRoot, edit.filePath)),
    ...sourcePathsFromInput.map((sourcePath) => normalizeNextSourcePath(projectRoot, sourcePath)),
  ])).sort();

  const originalNextDir = normalizeOptionalString(options.nextDir);
  const mapping = options.fetchProductionAssets === true
    ? await mapNextOverrideAssetsWithDrift({
        projectRoot,
        nextDir: originalNextDir,
        route: options.route,
        observedAssets: options.observedAssets,
        sourcePaths,
        maxResults: 100,
        fetchProductionAssets: true,
        productionFetchTimeoutMs: options.productionFetchTimeoutMs,
        maxProductionAssetBytes: options.maxProductionAssetBytes,
        maxDriftCandidates: options.maxDriftCandidates,
        productionFetchConcurrency: options.productionFetchConcurrency,
      })
    : mapNextOverrideAssets({
    projectRoot,
    nextDir: originalNextDir,
    route: options.route,
    observedAssets: options.observedAssets,
    sourcePaths,
    maxResults: 100,
  });
  const mappingCandidates = mapping.candidates.filter((candidate) => confidenceAllowed(candidate.confidence));
  const blockers: string[] = [];
  const warnings = [...mapping.warnings];
  if (cleanedOverlayCount > 0) {
    warnings.push(`Cleaned ${cleanedOverlayCount} expired Next.js source overlay folder(s).`);
  }
  for (const candidate of mapping.candidates) {
    for (const blocker of candidate.blockers) {
      blockers.push(`${candidate.targetAssetUrl}: ${blocker}`);
    }
  }

  if (mappingCandidates.length === 0) {
    blockers.push('No medium/high confidence observed production Next.js asset matched the requested source paths.');
  }

  const { overlayRoot, overlayProjectRoot } = createOverlay(projectRoot, workspaceRoot);
  const editsApplied = applySourceEdits(overlayProjectRoot, edits);
  const timeoutMs = typeof options.buildTimeoutMs === 'number' && Number.isFinite(options.buildTimeoutMs)
    ? Math.max(1_000, Math.floor(options.buildTimeoutMs))
    : DEFAULT_BUILD_TIMEOUT_MS;
  const build = await runNextBuild({ projectRoot, overlayProjectRoot, workspaceRoot, timeoutMs });
  const overlayNextDir = resolve(overlayProjectRoot, originalNextDir ?? '.next');
  const originalIndex = createNextAssetIndex(projectRoot, originalNextDir);
  const overlayIndex = createNextAssetIndex(overlayProjectRoot, originalNextDir);
  warnings.push(...overlayIndex.warnings.map((warning) => `overlay: ${warning}`));

  const tempAssetsForSources = overlayIndex.assets.filter((asset) => assetMatchesAnySource(asset, sourcePaths).length > 0);
  const changedAssets = tempAssetsForSources.filter((asset) => {
    const original = originalIndex.byAssetPath.get(asset.assetPath);
    return !original || original.sha256 !== asset.sha256 || original.sizeBytes !== asset.sizeBytes;
  });

  const rules: PlannedNextOverrideRule[] = [];
  const usedTargetUrls = new Set<string>();
  const selectedOverlayPrimaryAssets: NextAssetRecord[] = [];
  const assetTextReplacements = inferAssetTextReplacements(edits);

  for (const candidate of mappingCandidates) {
    if (candidate.blockers.length > 0) {
      continue;
    }

    const tempAsset = findBestTempAssetForCandidate(changedAssets, candidate, sourcePaths);
    const originalAsset = originalIndex.byAssetPath.get(candidate.assetPath);
    const patchedAsset = originalAsset
      ? createPatchedObservedAsset({
          originalAsset,
          overlayRoot,
          replacements: assetTextReplacements,
          ruleIndex: rules.length + 1,
        })
      : undefined;
    const localAsset = patchedAsset ?? tempAsset;
    if (!localAsset) {
      warnings.push(`No changed overlay chunk matched observed asset ${candidate.targetAssetUrl}.`);
      continue;
    }

    const matchedSourcePaths = patchedAsset ? candidate.matchedSourcePaths : assetMatchesAnySource(localAsset, sourcePaths);
    const rule = createRule({
      ruleId: `source-${rules.length + 1}`,
      targetAssetUrl: candidate.targetAssetUrl,
      localAsset,
      reason: patchedAsset ? 'observed_asset_patched_from_source_edit' : 'observed_asset_rebuilt_from_source_edit',
      confidence: candidate.confidence,
      score: candidate.score,
      matchedSourcePaths,
      originalAssetPath: candidate.assetPath,
    });
    rules.push(rule);
    usedTargetUrls.add(rule.targetAssetUrl);
    if (!patchedAsset && tempAsset) {
      selectedOverlayPrimaryAssets.push(tempAsset);
    }
  }

  const firstPrefix = mappingCandidates.map(candidateUrlPrefix).find((entry): entry is string => typeof entry === 'string');
  if (firstPrefix && selectedOverlayPrimaryAssets.length > 0) {
    const dependencyAssetPaths = new Set<string>();
    for (const asset of selectedOverlayPrimaryAssets) {
      for (const referencedAssetPath of extractReferencedNextAssets(asset)) {
        if (referencedAssetPath !== asset.assetPath) {
          dependencyAssetPaths.add(referencedAssetPath);
        }
      }
    }
    for (const asset of changedAssets) {
      if (!selectedOverlayPrimaryAssets.some((selected) => selected.assetPath === asset.assetPath)) {
        dependencyAssetPaths.add(asset.assetPath);
      }
    }

    for (const dependencyAssetPath of dependencyAssetPaths) {
      const dependencyAsset = overlayIndex.byAssetPath.get(dependencyAssetPath);
      if (!dependencyAsset || !existsSync(dependencyAsset.localFilePath) || !statSync(dependencyAsset.localFilePath).isFile()) {
        continue;
      }
      const targetAssetUrl = `${firstPrefix}${dependencyAsset.assetPath}`;
      if (usedTargetUrls.has(targetAssetUrl)) {
        continue;
      }
      usedTargetUrls.add(targetAssetUrl);
      rules.push(createRule({
        ruleId: `dependency-${rules.length + 1}`,
        targetAssetUrl,
        localAsset: dependencyAsset,
        reason: selectedOverlayPrimaryAssets.some((selected) => extractReferencedNextAssets(selected).includes(dependencyAsset.assetPath))
          ? 'referenced_overlay_dependency_chunk'
          : 'edited_source_chunk_without_observed_original',
        confidence: 'medium',
        score: LOW_CONFIDENCE_SCORE + 1,
        matchedSourcePaths: assetMatchesAnySource(dependencyAsset, sourcePaths),
      }));
    }
  } else if (changedAssets.length > 0) {
    warnings.push('Unable to infer production Next.js asset URL prefix for dependency chunks.');
  }

  const maxRules = typeof options.maxRules === 'number' && Number.isFinite(options.maxRules)
    ? Math.max(1, Math.floor(options.maxRules))
    : 200;
  const limitedRules = rules.slice(0, maxRules);
  if (rules.length > limitedRules.length) {
    warnings.push(`Rule list truncated from ${rules.length} to ${limitedRules.length}.`);
  }
  if (limitedRules.length === 0) {
    blockers.push('No override rules could be planned from the edited source files.');
  }

  const configPath = normalizeOptionalString(options.configPath);
  const shouldWriteConfig = options.writeConfig === true;
  if (shouldWriteConfig) {
    if (!configPath) {
      throw new Error('configPath is required when writeConfig is true');
    }
    writeOverrideConfig({
      configPath,
      rules: limitedRules,
      profileId: normalizeOptionalString(options.profileId),
      profileName: normalizeOptionalString(options.profileName),
      enabled: options.enabled === false ? false : true,
      profileEnabled: options.profileEnabled === false ? false : true,
      autoReload: options.autoReload !== false,
      overwrite: typeof options.overwrite === 'boolean' ? options.overwrite : undefined,
    });
  }

  const resultWithoutActions = {
    projectRoot,
    workspaceRoot,
    overlayRoot,
    overlayProjectRoot,
    overlayNextDir,
    route: mapping.route,
    sourcePaths,
    editsApplied,
    build,
    mappingCandidateCount: mappingCandidates.length,
    changedAssetCount: changedAssets.length,
    dependencyRuleCount: limitedRules.filter((rule) => rule.reason.includes('dependency') || rule.reason.includes('without_observed')).length,
    rules: limitedRules,
    configPath,
    configWritten: shouldWriteConfig,
    warnings,
    blockers,
  } satisfies Omit<NextSourceOverridePlanResult, 'nextActions'>;

  return {
    ...resultWithoutActions,
    nextActions: buildNextActions(resultWithoutActions),
  };
}
