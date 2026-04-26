import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, extname, relative, resolve } from 'path';
import type { OverridePocConfig, OverridePocProfileConfig, OverridePocRuleConfig } from './override-poc.js';

export type OverrideProfileAdapterId = 'static' | 'nextjs';

export interface OverrideProfileNextAction {
  code: string;
  message: string;
}

export interface OverrideProfileGenerationOptions {
  adapter?: OverrideProfileAdapterId;
  targetBaseUrl: string;
  projectRoot?: string;
  assetRoot?: string;
  nextDir?: string;
  configPath?: string;
  profileId?: string;
  profileName?: string;
  enabled?: boolean;
  profileEnabled?: boolean;
  autoReload?: boolean;
  includeManifestFiles?: boolean;
  includeStaticFiles?: boolean;
  extensions?: string[];
  maxRules?: number;
}

export interface NextJsOverrideProfileOptions extends Omit<OverrideProfileGenerationOptions, 'adapter' | 'assetRoot'> {
  nextDir?: string;
}

export interface OverrideProfileGenerationResult {
  adapter: OverrideProfileAdapterId;
  mode: OverrideProfileAdapterId;
  projectRoot: string;
  assetRoot: string;
  nextDir?: string;
  targetBaseUrl: string;
  suggestedConfigPath: string;
  manifestFiles: string[];
  staticFileCount: number;
  missingManifestAssetCount: number;
  ruleCount: number;
  warnings: string[];
  nextActions: OverrideProfileNextAction[];
  config: OverridePocConfig;
  profile: OverridePocProfileConfig;
  rules: OverridePocRuleConfig[];
  configJson: string;
}

interface AdapterDefaults {
  assetRoot: string;
  profileId: string;
  profileName: string;
}

interface AssetDiscoveryResult {
  assetPaths: Set<string>;
  manifestFiles: string[];
  staticFileCount: number;
  missingManifestAssetCount: number;
  warnings: string[];
}

export const OVERRIDE_PROFILE_ADAPTERS: readonly OverrideProfileAdapterId[] = ['static', 'nextjs'];

const DEFAULT_ASSET_EXTENSIONS = ['.js', '.mjs', '.css'];
const DEFAULT_MAX_RULES = 500;
const NEXT_MANIFEST_RELATIVE_PATHS = [
  'build-manifest.json',
  'app-build-manifest.json',
  'react-loadable-manifest.json',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toPortablePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function normalizeOptionalText(value: string | undefined, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function normalizeAdapter(value: OverrideProfileAdapterId | undefined): OverrideProfileAdapterId {
  if (value === undefined) {
    return 'nextjs';
  }
  if (OVERRIDE_PROFILE_ADAPTERS.includes(value)) {
    return value;
  }

  throw new Error(`Unsupported override profile adapter: ${value}`);
}

function getAdapterDefaults(adapter: OverrideProfileAdapterId): AdapterDefaults {
  if (adapter === 'nextjs') {
    return {
      assetRoot: '.next',
      profileId: 'nextjs-local',
      profileName: 'Next.js local overrides',
    };
  }

  return {
    assetRoot: 'dist',
    profileId: 'static-local',
    profileName: 'Static asset local overrides',
  };
}

function normalizeExtensions(value: string[] | undefined): Set<string> {
  const source = value && value.length > 0 ? value : DEFAULT_ASSET_EXTENSIONS;
  const extensions = source
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.startsWith('.') ? entry : `.${entry}`);

  if (extensions.length === 0) {
    throw new Error('At least one asset extension is required');
  }

  return new Set(extensions);
}

function normalizeMaxRules(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_RULES;
  }
  if (!Number.isFinite(value) || value < 1) {
    throw new Error('maxRules must be a positive finite number when provided');
  }

  return Math.floor(value);
}

function normalizeTargetBaseUrl(
  value: string,
  adapter: OverrideProfileAdapterId,
): { targetBaseUrl: string; warnings: string[] } {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('targetBaseUrl is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('targetBaseUrl must be an absolute http(s) URL, for example https://example.com/_next/');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('targetBaseUrl must use http or https');
  }

  parsed.search = '';
  parsed.hash = '';
  if (!parsed.pathname.endsWith('/')) {
    parsed.pathname = `${parsed.pathname}/`;
  }

  const warnings: string[] = [];
  if (adapter === 'nextjs' && !parsed.pathname.includes('/_next/')) {
    warnings.push('targetBaseUrl does not contain /_next/; verify this matches the production Next.js asset prefix exactly.');
  }

  return {
    targetBaseUrl: parsed.toString(),
    warnings,
  };
}

function normalizeNextAssetPath(value: string, extensions: Set<string>): string | null {
  let pathname = value.trim();
  if (pathname.length === 0) {
    return null;
  }

  try {
    const parsed = new URL(pathname);
    pathname = parsed.pathname;
  } catch {
    const queryIndex = pathname.search(/[?#]/);
    if (queryIndex >= 0) {
      pathname = pathname.slice(0, queryIndex);
    }
  }

  pathname = toPortablePath(pathname);
  const nextIndex = pathname.indexOf('/_next/');
  if (nextIndex >= 0) {
    pathname = pathname.slice(nextIndex + '/_next/'.length);
  } else if (pathname.startsWith('_next/')) {
    pathname = pathname.slice('_next/'.length);
  } else if (pathname.startsWith('/static/')) {
    pathname = pathname.slice(1);
  } else if (pathname.startsWith('.next/')) {
    pathname = pathname.slice('.next/'.length);
  }

  pathname = pathname.replace(/^\/+/, '');
  if (!pathname.startsWith('static/')) {
    return null;
  }

  const extension = extname(pathname).toLowerCase();
  return extensions.has(extension) ? pathname : null;
}

function collectNextAssetPaths(value: unknown, extensions: Set<string>, paths: Set<string>): void {
  if (typeof value === 'string') {
    const assetPath = normalizeNextAssetPath(value, extensions);
    if (assetPath) {
      paths.add(assetPath);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectNextAssetPaths(entry, extensions, paths);
    }
    return;
  }

  if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      collectNextAssetPaths(entry, extensions, paths);
    }
  }
}

function collectNextManifestAssets(
  assetRoot: string,
  extensions: Set<string>,
): { assetPaths: Set<string>; manifestFiles: string[]; missingManifestAssetCount: number; warnings: string[] } {
  const discoveredAssetPaths = new Set<string>();
  const manifestFiles: string[] = [];
  const warnings: string[] = [];

  for (const relativePath of NEXT_MANIFEST_RELATIVE_PATHS) {
    const manifestPath = resolve(assetRoot, relativePath);
    if (!existsSync(manifestPath)) {
      continue;
    }

    manifestFiles.push(manifestPath);
    try {
      collectNextAssetPaths(JSON.parse(readFileSync(manifestPath, 'utf8')), extensions, discoveredAssetPaths);
    } catch (error) {
      warnings.push(`Unable to parse ${manifestPath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  const existingAssetPaths = new Set<string>();
  let missingManifestAssetCount = 0;
  for (const assetPath of discoveredAssetPaths) {
    if (existsSync(resolve(assetRoot, assetPath))) {
      existingAssetPaths.add(assetPath);
    } else {
      missingManifestAssetCount += 1;
    }
  }

  return {
    assetPaths: existingAssetPaths,
    manifestFiles,
    missingManifestAssetCount,
    warnings,
  };
}

function walkAssets(
  assetRoot: string,
  currentDir: string,
  extensions: Set<string>,
  assetPaths: Set<string>,
): void {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = resolve(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkAssets(assetRoot, fullPath, extensions, assetPaths);
      continue;
    }

    if (!entry.isFile() || !extensions.has(extname(entry.name).toLowerCase())) {
      continue;
    }

    assetPaths.add(toPortablePath(relative(assetRoot, fullPath)));
  }
}

function collectDirectoryAssets(
  assetRoot: string,
  extensions: Set<string>,
  options: { subdir?: string; label: string },
): { assetPaths: Set<string>; warnings: string[] } {
  const scanRoot = options.subdir ? resolve(assetRoot, options.subdir) : assetRoot;
  const assetPaths = new Set<string>();
  const warnings: string[] = [];
  if (!existsSync(scanRoot)) {
    warnings.push(`${options.label} directory not found at ${scanRoot}. Build the app before generating a profile.`);
    return { assetPaths, warnings };
  }

  if (!statSync(scanRoot).isDirectory()) {
    warnings.push(`${options.label} path exists but is not a directory: ${scanRoot}`);
    return { assetPaths, warnings };
  }

  walkAssets(assetRoot, scanRoot, extensions, assetPaths);
  return { assetPaths, warnings };
}

function discoverStaticAssets(assetRoot: string, extensions: Set<string>): AssetDiscoveryResult {
  const directoryAssets = collectDirectoryAssets(assetRoot, extensions, { label: 'Static asset root' });
  return {
    assetPaths: directoryAssets.assetPaths,
    manifestFiles: [],
    staticFileCount: directoryAssets.assetPaths.size,
    missingManifestAssetCount: 0,
    warnings: directoryAssets.warnings,
  };
}

function discoverNextAssets(
  assetRoot: string,
  extensions: Set<string>,
  includeManifestFiles: boolean,
  includeStaticFiles: boolean,
): AssetDiscoveryResult {
  const assetPaths = new Set<string>();
  const warnings: string[] = [];
  let manifestFiles: string[] = [];
  let missingManifestAssetCount = 0;
  let staticFileCount = 0;

  if (!existsSync(assetRoot)) {
    warnings.push(`Next.js output directory not found at ${assetRoot}.`);
  }

  if (includeManifestFiles) {
    const manifestAssets = collectNextManifestAssets(assetRoot, extensions);
    manifestFiles = manifestAssets.manifestFiles;
    missingManifestAssetCount = manifestAssets.missingManifestAssetCount;
    warnings.push(...manifestAssets.warnings);
    for (const assetPath of manifestAssets.assetPaths) {
      assetPaths.add(assetPath);
    }

    if (manifestFiles.length === 0) {
      warnings.push(`No supported Next.js manifests found under ${assetRoot}. Falling back to static asset discovery if enabled.`);
    }
  }

  if (includeStaticFiles) {
    const staticAssets = collectDirectoryAssets(assetRoot, extensions, { subdir: 'static', label: 'Next.js static' });
    staticFileCount = staticAssets.assetPaths.size;
    warnings.push(...staticAssets.warnings);
    for (const assetPath of staticAssets.assetPaths) {
      assetPaths.add(assetPath);
    }
  }

  if (missingManifestAssetCount > 0) {
    warnings.push(`${missingManifestAssetCount} manifest asset(s) were skipped because the local file was missing.`);
  }

  return {
    assetPaths,
    manifestFiles,
    staticFileCount,
    missingManifestAssetCount,
    warnings,
  };
}

function createRuleId(assetPath: string, index: number, usedRuleIds: Set<string>): string {
  const base = assetPath
    .replace(/\.[^/.]+$/, '')
    .replace(/^static\/(chunks|css|media)\//, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60) || 'asset';

  let candidate = base;
  let suffix = index + 1;
  while (usedRuleIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  usedRuleIds.add(candidate);
  return candidate;
}

function resolveContentType(assetPath: string): string {
  const extension = extname(assetPath).toLowerCase();
  if (extension === '.css') {
    return 'text/css; charset=utf-8';
  }
  if (extension === '.json') {
    return 'application/json; charset=utf-8';
  }

  return 'application/javascript; charset=utf-8';
}

function createGenerationNextActions(
  adapter: OverrideProfileAdapterId,
  ruleCount: number,
  suggestedConfigPath: string,
  enabled: boolean,
): OverrideProfileNextAction[] {
  if (ruleCount === 0) {
    return [{
      code: 'BUILD_APP',
      message: `Build the ${adapter === 'nextjs' ? 'Next.js app' : 'app'} so local assets exist, then generate the profile again.`,
    }];
  }

  const actions: OverrideProfileNextAction[] = [
    {
      code: 'REVIEW_ASSET_URLS',
      message: 'Review generated targetAssetUrl values against the production network requests before enabling overrides.',
    },
    {
      code: 'SAVE_LOCAL_CONFIG',
      message: `Save the generated config JSON to ${suggestedConfigPath}, or rerun create_override_profile with writeConfig=true.`,
    },
    {
      code: 'VALIDATE_PROFILE',
      message: 'Run validate_override_profile after saving the generated config.',
    },
  ];

  if (!enabled) {
    actions.push({
      code: 'ENABLE_CONFIG_AFTER_REVIEW',
      message: 'The generated root config is disabled by default; set enabled=true after reviewing the mappings.',
    });
  }

  actions.push({
    code: 'ENABLE_OVERRIDES',
    message: 'Enable overrides on a connected session only after validation succeeds.',
  });

  return actions;
}

export function createOverrideProfileConfig(options: OverrideProfileGenerationOptions): OverrideProfileGenerationResult {
  const adapter = normalizeAdapter(options.adapter);
  const defaults = getAdapterDefaults(adapter);
  const projectRoot = resolve(normalizeOptionalText(options.projectRoot, process.cwd()));
  const rawAssetRoot = adapter === 'nextjs'
    ? normalizeOptionalText(options.nextDir ?? options.assetRoot, defaults.assetRoot)
    : normalizeOptionalText(options.assetRoot, defaults.assetRoot);
  const assetRoot = resolve(projectRoot, rawAssetRoot);
  const suggestedConfigPath = resolve(projectRoot, normalizeOptionalText(options.configPath, 'override-poc.local.json'));
  const configDir = dirname(suggestedConfigPath);
  const profileId = normalizeOptionalText(options.profileId, defaults.profileId);
  const profileName = normalizeOptionalText(options.profileName, defaults.profileName);
  const configEnabled = options.enabled ?? false;
  const profileEnabled = options.profileEnabled ?? true;
  const autoReload = options.autoReload ?? true;
  const includeManifestFiles = options.includeManifestFiles ?? true;
  const includeStaticFiles = options.includeStaticFiles ?? true;
  const extensions = normalizeExtensions(options.extensions);
  const maxRules = normalizeMaxRules(options.maxRules);
  const targetBase = normalizeTargetBaseUrl(options.targetBaseUrl, adapter);
  const discovery = adapter === 'nextjs'
    ? discoverNextAssets(assetRoot, extensions, includeManifestFiles, includeStaticFiles)
    : discoverStaticAssets(assetRoot, extensions);
  const warnings = [...targetBase.warnings, ...discovery.warnings];
  const sortedAssetPaths = Array.from(discovery.assetPaths).sort((first, second) => first.localeCompare(second));
  const limitedAssetPaths = sortedAssetPaths.slice(0, maxRules);
  if (sortedAssetPaths.length > limitedAssetPaths.length) {
    warnings.push(`Rule generation was limited to ${maxRules} assets; increase maxRules if you need the remaining ${sortedAssetPaths.length - limitedAssetPaths.length}.`);
  }

  const usedRuleIds = new Set<string>();
  const rules: OverridePocRuleConfig[] = limitedAssetPaths.map((assetPath, index) => {
    const absoluteLocalFilePath = resolve(assetRoot, assetPath);
    return {
      ruleId: createRuleId(assetPath, index, usedRuleIds),
      enabled: true,
      targetAssetUrl: new URL(assetPath, targetBase.targetBaseUrl).toString(),
      localFilePath: toPortablePath(relative(configDir, absoluteLocalFilePath)),
      contentType: resolveContentType(assetPath),
    };
  });

  const profile: OverridePocProfileConfig = {
    profileId,
    name: profileName,
    enabled: profileEnabled,
    autoReload,
    rules,
  };
  const config: OverridePocConfig = {
    enabled: configEnabled,
    activeProfileId: profileId,
    profiles: [profile],
  };
  const configJson = `${JSON.stringify(config, null, 2)}\n`;

  return {
    adapter,
    mode: adapter,
    projectRoot,
    assetRoot,
    nextDir: adapter === 'nextjs' ? assetRoot : undefined,
    targetBaseUrl: targetBase.targetBaseUrl,
    suggestedConfigPath,
    manifestFiles: discovery.manifestFiles,
    staticFileCount: discovery.staticFileCount,
    missingManifestAssetCount: discovery.missingManifestAssetCount,
    ruleCount: rules.length,
    warnings,
    nextActions: createGenerationNextActions(adapter, rules.length, suggestedConfigPath, configEnabled),
    config,
    profile,
    rules,
    configJson,
  };
}

export function createNextJsOverrideProfileConfig(options: NextJsOverrideProfileOptions): OverrideProfileGenerationResult {
  return createOverrideProfileConfig({
    ...options,
    adapter: 'nextjs',
  });
}
