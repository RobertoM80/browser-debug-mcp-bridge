import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, extname, join, resolve } from 'path';

export interface DiscoverSsrMockabilityOptions {
  projectRoot: string;
  targetUrl?: string;
  apiHost?: string;
  maxFiles?: number;
}

export type SsrMockabilityClassification =
  | 'mockable-env'
  | 'mockable-central-client'
  | 'possibly-mockable'
  | 'not-mockable';

export interface SsrMockabilityCandidate {
  kind: 'env-var' | 'env-file' | 'source-config' | 'central-client' | 'hardcoded-call';
  path: string;
  line: number;
  excerpt: string;
  envVarName?: string;
  matchedUrl?: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

export interface SsrMockabilityDiscoveryResult {
  projectRoot: string;
  targetUrl?: string;
  apiHost?: string;
  classification: SsrMockabilityClassification;
  mockable: boolean;
  envVarCandidates: string[];
  preferredEnvVarName?: string;
  preferredEnvFilePath?: string;
  centralClientPaths: string[];
  hardcodedCallPaths: string[];
  scannedFileCount: number;
  candidates: SsrMockabilityCandidate[];
  nextActions: Array<{ code: string; message: string }>;
}

export interface ApplySsrMockConfigOptions {
  projectRoot: string;
  envVarName: string;
  mockBaseUrl: string;
  envFilePath?: string;
  rollbackId?: string;
}

export interface ApplySsrMockConfigResult {
  envFilePath: string;
  envVarName: string;
  mockBaseUrl: string;
  rollbackId: string;
  changed: boolean;
  createdFile: boolean;
  mode: 'replaced-existing-value' | 'added-new-value' | 'already-applied';
  originalValue?: string;
  rollback: {
    type: 'restore-commented-value' | 'remove-added-block' | 'already-applied';
    envFilePath: string;
    envVarName: string;
    rollbackId: string;
  };
}

export interface RemoveSsrMockConfigOptions {
  envFilePath: string;
  envVarName: string;
  rollbackId?: string;
}

export interface RemoveSsrMockConfigResult {
  envFilePath: string;
  envVarName: string;
  rollbackId?: string;
  restored: boolean;
  mode: 'restored-commented-value' | 'removed-added-block' | 'not-found';
}

const DEFAULT_SCAN_FILE_LIMIT = 500;
const DEFAULT_ENV_FILENAMES = [
  '.env.local',
  '.env.development.local',
  '.env.development',
  '.env',
] as const;
const SOURCE_FILE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.json',
  '.env',
]);
const EXCLUDED_DIRS = new Set([
  '.git',
  '.next',
  '.nx',
  'coverage',
  'dist',
  'node_modules',
  'tmp',
]);
const ENV_USAGE_PATTERN = /\b(?:process\.env|import\.meta\.env)\.([A-Z][A-Z0-9_]+)\b/g;
const GENERIC_ENV_NAME_PATTERN = /\b([A-Z][A-Z0-9_]*(?:API|BASE|BACKEND|ENDPOINT|SERVER|URL)[A-Z0-9_]*)\b/g;
const CLIENT_HINT_PATTERN = /\b(?:axios\.create|fetch\(|ky\.create|got\.extend|createClient|createApiClient|graphql)\b/;
const BDMCP_ORIGINAL_PREFIX = '# BDMCP_MOCK_ORIGINAL';
const BDMCP_ADDED_START_PREFIX = '# BDMCP_MOCK_ADDED_START';
const BDMCP_ADDED_END_PREFIX = '# BDMCP_MOCK_ADDED_END';

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeUrlHost(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function shouldScanFile(filename: string): boolean {
  if (filename === '.env.local' || filename === '.env.development.local' || filename === '.env.development' || filename === '.env') {
    return true;
  }
  return SOURCE_FILE_EXTENSIONS.has(extname(filename).toLowerCase());
}

function listProjectFiles(projectRoot: string, maxFiles: number): string[] {
  const files: string[] = [];
  const queue = [resolve(projectRoot)];

  while (queue.length > 0 && files.length < maxFiles) {
    const current = queue.shift();
    if (!current || !existsSync(current)) {
      continue;
    }

    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        break;
      }
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) {
          queue.push(fullPath);
        }
        continue;
      }
      if (entry.isFile() && shouldScanFile(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function pushCandidate(candidates: SsrMockabilityCandidate[], candidate: SsrMockabilityCandidate): void {
  candidates.push(candidate);
}

function resolvePreferredEnvFile(projectRoot: string, explicitEnvFilePath?: string): { path: string; createdFile: boolean } {
  if (explicitEnvFilePath) {
    const resolved = resolve(projectRoot, explicitEnvFilePath);
    return { path: resolved, createdFile: !existsSync(resolved) };
  }

  for (const filename of DEFAULT_ENV_FILENAMES) {
    const candidate = resolve(projectRoot, filename);
    if (existsSync(candidate)) {
      return { path: candidate, createdFile: false };
    }
  }

  return { path: resolve(projectRoot, '.env.local'), createdFile: true };
}

function buildExcerpt(line: string): string {
  return line.trim().slice(0, 240);
}

function collectEnvVarMatches(line: string): string[] {
  const matches = new Set<string>();
  for (const pattern of [ENV_USAGE_PATTERN, GENERIC_ENV_NAME_PATTERN]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      if (typeof match[1] === 'string' && match[1].includes('_')) {
        matches.add(match[1]);
      }
    }
  }
  return Array.from(matches);
}

function choosePreferredEnvVar(candidates: SsrMockabilityCandidate[]): string | undefined {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    if (!candidate.envVarName) {
      continue;
    }
    const score = candidate.confidence === 'high' ? 3 : candidate.confidence === 'medium' ? 2 : 1;
    counts.set(candidate.envVarName, (counts.get(candidate.envVarName) ?? 0) + score);
  }

  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
}

function classifyDiscovery(candidates: SsrMockabilityCandidate[]): SsrMockabilityClassification {
  if (candidates.some((candidate) => candidate.kind === 'env-var' && candidate.confidence === 'high')) {
    return 'mockable-env';
  }
  if (candidates.some((candidate) => candidate.kind === 'central-client' && candidate.confidence !== 'low')) {
    return 'mockable-central-client';
  }
  if (candidates.some((candidate) => candidate.kind === 'source-config' || candidate.kind === 'env-file')) {
    return 'possibly-mockable';
  }
  return 'not-mockable';
}

function buildDiscoveryNextActions(classification: SsrMockabilityClassification, preferredEnvVarName?: string): Array<{ code: string; message: string }> {
  switch (classification) {
    case 'mockable-env':
      return [{
        code: 'APPLY_SSR_MOCK_CONFIG',
        message: preferredEnvVarName
          ? `Apply a temporary mock base URL through ${preferredEnvVarName}.`
          : 'Apply a temporary mock base URL through the discovered env var.',
      }];
    case 'mockable-central-client':
      return [{
        code: 'REVIEW_CLIENT_WRAPPER',
        message: 'Confirm the central SSR client base URL is env-driven before patching a local env file.',
      }];
    case 'possibly-mockable':
      return [{
        code: 'CONFIRM_ENV_OR_CLIENT',
        message: 'Inspect the discovered source config paths and choose the intended env var or client wrapper.',
      }];
    case 'not-mockable':
      return [{
        code: 'SOURCE_CHANGES_REQUIRED',
        message: 'No configurable SSR base path was found; SSR mocking needs an env-driven base URL or a central request client.',
      }];
  }
}

export function discoverSsrMockability(options: DiscoverSsrMockabilityOptions): SsrMockabilityDiscoveryResult {
  const projectRoot = resolve(options.projectRoot);
  const targetUrl = normalizeOptionalString(options.targetUrl);
  const apiHost = normalizeOptionalString(options.apiHost) ?? normalizeUrlHost(targetUrl);
  const maxFiles = typeof options.maxFiles === 'number' && Number.isFinite(options.maxFiles)
    ? Math.max(50, Math.floor(options.maxFiles))
    : DEFAULT_SCAN_FILE_LIMIT;
  const files = listProjectFiles(projectRoot, maxFiles);
  const candidates: SsrMockabilityCandidate[] = [];
  const envFilePaths = new Set<string>();
  const centralClientPaths = new Set<string>();
  const hardcodedCallPaths = new Set<string>();

  for (const filePath of files) {
    const content = readTextFile(filePath);
    if (content === undefined) {
      continue;
    }
    const relativePath = toPosixPath(filePath.slice(projectRoot.length + 1));
    const lines = content.split(/\r?\n/u);
    const isEnvFile = basename(filePath).startsWith('.env');

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      const lineNo = index + 1;
      const excerpt = buildExcerpt(line);
      const envVars = collectEnvVarMatches(line);

      if (isEnvFile) {
        const envMatch = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.+?)\s*$/u.exec(line);
        if (envMatch && apiHost && envMatch[2].includes(apiHost)) {
          envFilePaths.add(relativePath);
          pushCandidate(candidates, {
            kind: 'env-file',
            path: relativePath,
            line: lineNo,
            excerpt,
            envVarName: envMatch[1],
            matchedUrl: envMatch[2],
            confidence: 'high',
            reason: 'Env file already defines a target API host value.',
          });
        }
      }

      const hasTargetUrl = targetUrl ? line.includes(targetUrl) : false;
      const hasApiHost = apiHost ? line.includes(apiHost) : false;
      const envDriven = envVars.length > 0;
      const clientHint = CLIENT_HINT_PATTERN.test(line);

      if ((hasTargetUrl || hasApiHost) && envDriven) {
        pushCandidate(candidates, {
          kind: 'env-var',
          path: relativePath,
          line: lineNo,
          excerpt,
          envVarName: envVars[0],
          matchedUrl: hasTargetUrl ? targetUrl : apiHost,
          confidence: 'high',
          reason: 'SSR request path appears to be driven by an env var.',
        });
      } else if (envDriven && clientHint) {
        centralClientPaths.add(relativePath);
        pushCandidate(candidates, {
          kind: 'central-client',
          path: relativePath,
          line: lineNo,
          excerpt,
          envVarName: envVars[0],
          confidence: 'medium',
          reason: 'Central request client uses an env var and is a likely SSR mock injection point.',
        });
      } else if ((hasTargetUrl || hasApiHost) && !envDriven) {
        hardcodedCallPaths.add(relativePath);
        pushCandidate(candidates, {
          kind: 'hardcoded-call',
          path: relativePath,
          line: lineNo,
          excerpt,
          matchedUrl: hasTargetUrl ? targetUrl : apiHost,
          confidence: 'low',
          reason: 'Request appears hardcoded in source; not safely mockable through env patching.',
        });
      } else if (envDriven && /(?:baseUrl|baseURL|apiUrl|apiURL|endpoint)/u.test(line)) {
        pushCandidate(candidates, {
          kind: 'source-config',
          path: relativePath,
          line: lineNo,
          excerpt,
          envVarName: envVars[0],
          confidence: 'medium',
          reason: 'Source configuration references an env-driven base URL or endpoint.',
        });
      }
    }
  }

  const classification = classifyDiscovery(candidates);
  const preferredEnvVarName = choosePreferredEnvVar(candidates);
  const preferredEnvFilePath = envFilePaths.size > 0
    ? resolve(projectRoot, Array.from(envFilePaths).sort()[0] ?? '.env.local')
    : resolvePreferredEnvFile(projectRoot).path;

  return {
    projectRoot,
    targetUrl,
    apiHost,
    classification,
    mockable: classification === 'mockable-env' || classification === 'mockable-central-client',
    envVarCandidates: Array.from(new Set(candidates.map((candidate) => candidate.envVarName).filter((value): value is string => typeof value === 'string'))).sort(),
    preferredEnvVarName,
    preferredEnvFilePath,
    centralClientPaths: Array.from(centralClientPaths).sort(),
    hardcodedCallPaths: Array.from(hardcodedCallPaths).sort(),
    scannedFileCount: files.length,
    candidates: candidates.sort((left, right) => {
      const leftScore = left.confidence === 'high' ? 0 : left.confidence === 'medium' ? 1 : 2;
      const rightScore = right.confidence === 'high' ? 0 : right.confidence === 'medium' ? 1 : 2;
      return leftScore - rightScore || left.path.localeCompare(right.path) || left.line - right.line;
    }),
    nextActions: buildDiscoveryNextActions(classification, preferredEnvVarName),
  };
}

function ensureMockBaseUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error();
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    throw new Error('mockBaseUrl must be a valid absolute http(s) URL');
  }
}

function createRollbackId(value?: string): string {
  return normalizeOptionalString(value) ?? `ssr-mock-${Date.now()}`;
}

function ensureEnvFileDirectory(path: string): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
}

function splitLinesWithEnding(content: string): string[] {
  const matches = content.match(/[^\n]*\n|[^\n]+$/gu);
  return matches ?? [];
}

function findCurrentEnvAssignment(lines: string[], envVarName: string): number {
  const pattern = new RegExp(`^\\s*${envVarName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`, 'u');
  return lines.findIndex((line) => pattern.test(line));
}

export function applySsrMockConfig(options: ApplySsrMockConfigOptions): ApplySsrMockConfigResult {
  const projectRoot = resolve(options.projectRoot);
  const envVarName = normalizeOptionalString(options.envVarName);
  if (!envVarName) {
    throw new Error('envVarName is required');
  }
  const mockBaseUrl = ensureMockBaseUrl(options.mockBaseUrl);
  const rollbackId = createRollbackId(options.rollbackId);
  const { path: envFilePath, createdFile } = resolvePreferredEnvFile(projectRoot, options.envFilePath);
  const existing = readTextFile(envFilePath) ?? '';
  const lines = splitLinesWithEnding(existing);
  const alreadyManagedIndex = lines.findIndex((line) => line.startsWith(`${BDMCP_ORIGINAL_PREFIX} ${rollbackId} ${envVarName}=`));

  if (alreadyManagedIndex >= 0) {
    const currentIndex = findCurrentEnvAssignment(lines, envVarName);
    if (currentIndex >= 0 && lines[currentIndex]?.trim() === `${envVarName}=${mockBaseUrl}`) {
      return {
        envFilePath,
        envVarName,
        mockBaseUrl,
        rollbackId,
        changed: false,
        createdFile,
        mode: 'already-applied',
        rollback: {
          type: 'already-applied',
          envFilePath,
          envVarName,
          rollbackId,
        },
      };
    }
  }

  const assignmentIndex = findCurrentEnvAssignment(lines, envVarName);
  let originalValue: string | undefined;
  let mode: ApplySsrMockConfigResult['mode'];
  let rollback: ApplySsrMockConfigResult['rollback'];

  if (assignmentIndex >= 0) {
    const currentLine = lines[assignmentIndex] ?? '';
    const normalized = currentLine.replace(/\r?\n$/u, '');
    const equalsIndex = normalized.indexOf('=');
    originalValue = equalsIndex >= 0 ? normalized.slice(equalsIndex + 1) : '';
    lines.splice(
      assignmentIndex,
      1,
      `${BDMCP_ORIGINAL_PREFIX} ${rollbackId} ${envVarName}=${originalValue}\n`,
      `${envVarName}=${mockBaseUrl}\n`,
    );
    mode = 'replaced-existing-value';
    rollback = {
      type: 'restore-commented-value',
      envFilePath,
      envVarName,
      rollbackId,
    };
  } else {
    if (lines.length > 0 && !lines[lines.length - 1]?.endsWith('\n')) {
      lines[lines.length - 1] = `${lines[lines.length - 1]}\n`;
    }
    lines.push(
      `${BDMCP_ADDED_START_PREFIX} ${rollbackId} ${envVarName}\n`,
      `${envVarName}=${mockBaseUrl}\n`,
      `${BDMCP_ADDED_END_PREFIX} ${rollbackId} ${envVarName}\n`,
    );
    mode = 'added-new-value';
    rollback = {
      type: 'remove-added-block',
      envFilePath,
      envVarName,
      rollbackId,
    };
  }

  ensureEnvFileDirectory(envFilePath);
  writeFileSync(envFilePath, lines.join(''), 'utf8');

  return {
    envFilePath,
    envVarName,
    mockBaseUrl,
    rollbackId,
    changed: true,
    createdFile,
    mode,
    originalValue,
    rollback,
  };
}

export function removeSsrMockConfig(options: RemoveSsrMockConfigOptions): RemoveSsrMockConfigResult {
  const envFilePath = resolve(options.envFilePath);
  const envVarName = normalizeOptionalString(options.envVarName);
  if (!envVarName) {
    throw new Error('envVarName is required');
  }

  const content = readTextFile(envFilePath);
  if (content === undefined) {
    return {
      envFilePath,
      envVarName,
      rollbackId: normalizeOptionalString(options.rollbackId),
      restored: false,
      mode: 'not-found',
    };
  }

  const rollbackId = normalizeOptionalString(options.rollbackId);
  const lines = splitLinesWithEnding(content);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const expectedPrefix = rollbackId
      ? `${BDMCP_ORIGINAL_PREFIX} ${rollbackId} ${envVarName}=`
      : `${BDMCP_ORIGINAL_PREFIX} `;
    if (!line.startsWith(expectedPrefix) || (rollbackId === undefined && !line.includes(` ${envVarName}=`))) {
      continue;
    }

    const match = /^# BDMCP_MOCK_ORIGINAL\s+(\S+)\s+([A-Z][A-Z0-9_]*)=(.*)\n?$/u.exec(line);
    if (!match || match[2] !== envVarName) {
      continue;
    }

    const managedRollbackId = match[1];
    const originalValue = match[3];
    if (index + 1 < lines.length && (lines[index + 1] ?? '').startsWith(`${envVarName}=`)) {
      lines.splice(index, 2, `${envVarName}=${originalValue}\n`);
      writeFileSync(envFilePath, lines.join(''), 'utf8');
      return {
        envFilePath,
        envVarName,
        rollbackId: managedRollbackId,
        restored: true,
        mode: 'restored-commented-value',
      };
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const expectedPrefix = rollbackId
      ? `${BDMCP_ADDED_START_PREFIX} ${rollbackId} ${envVarName}`
      : `${BDMCP_ADDED_START_PREFIX} `;
    if (!line.startsWith(expectedPrefix) || (rollbackId === undefined && !line.includes(` ${envVarName}`))) {
      continue;
    }

    const match = /^# BDMCP_MOCK_ADDED_START\s+(\S+)\s+([A-Z][A-Z0-9_]*)\n?$/u.exec(line);
    if (!match || match[2] !== envVarName) {
      continue;
    }
    const managedRollbackId = match[1];
    const endIndex = lines.findIndex((candidate, candidateIndex) => {
      return candidateIndex > index
        && candidate.startsWith(`${BDMCP_ADDED_END_PREFIX} ${managedRollbackId} ${envVarName}`);
    });
    if (endIndex > index) {
      lines.splice(index, endIndex - index + 1);
      writeFileSync(envFilePath, lines.join(''), 'utf8');
      return {
        envFilePath,
        envVarName,
        rollbackId: managedRollbackId,
        restored: true,
        mode: 'removed-added-block',
      };
    }
  }

  return {
    envFilePath,
    envVarName,
    rollbackId,
    restored: false,
    mode: 'not-found',
  };
}
