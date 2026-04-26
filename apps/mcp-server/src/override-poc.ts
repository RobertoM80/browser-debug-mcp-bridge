import { existsSync, readFileSync, statSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import { fileURLToPath } from 'url';

export interface OverridePocRuleConfig {
  ruleId: string;
  enabled: boolean;
  targetAssetUrl: string;
  localFilePath: string;
  contentType: string;
}

export interface OverridePocProfileConfig {
  profileId: string;
  name: string;
  enabled: boolean;
  autoReload: boolean;
  rules: OverridePocRuleConfig[];
}

export interface OverridePocConfig {
  enabled: boolean;
  activeProfileId: string;
  profiles: OverridePocProfileConfig[];
}

export interface OverridePocRuleSummary extends OverridePocRuleConfig {
  resolvedLocalFilePath: string;
  fileExists: boolean;
  fileSizeBytes: number | null;
}

export interface OverridePocProfileSummary extends Omit<OverridePocProfileConfig, 'rules'> {
  rules: OverridePocRuleSummary[];
  ruleCount: number;
  enabledRuleCount: number;
  fileExists: boolean;
}

export interface OverridePocConfigSummary {
  configEnabled: boolean;
  enabled: boolean;
  activeProfileId: string;
  profileId: string;
  profileName: string;
  autoReload: boolean;
  configPath: string;
  profiles: OverridePocProfileSummary[];
  rules: OverridePocRuleSummary[];
  ruleCount: number;
  enabledRuleCount: number;
  targetAssetUrl: string;
  localFilePath: string;
  resolvedLocalFilePath: string;
  contentType: string;
  fileExists: boolean;
  fileSizeBytes: number | null;
}

export interface OverridePocAssetResponse {
  buffer: Buffer;
  contentType: string;
  summary: OverridePocConfigSummary;
  rule: OverridePocRuleSummary;
}

const DEFAULT_CONTENT_TYPE = 'application/javascript; charset=utf-8';
const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../../../override-poc.config.json', import.meta.url));
const LOCAL_CONFIG_FILENAME = 'override-poc.local.json';

function resolveEnvConfigPath(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.OVERRIDE_POC_CONFIG_PATH;
  if (typeof raw !== 'string') {
    return undefined;
  }

  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`override-poc config field "${fieldName}" must be a non-empty string`);
  }
  return value.trim();
}

function requireBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`override-poc config field "${fieldName}" must be a boolean`);
  }
  return value;
}

function optionalBoolean(value: unknown, fallback: boolean, fieldName: string): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`override-poc config field "${fieldName}" must be a boolean when provided`);
  }
  return value;
}

function optionalString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function parseRule(raw: unknown, index: number): OverridePocRuleConfig {
  if (!isRecord(raw)) {
    throw new Error(`override-poc profile rule at index ${index} must be a JSON object`);
  }

  return {
    ruleId: optionalString(raw.ruleId, `rule-${index + 1}`),
    enabled: optionalBoolean(raw.enabled, true, `rules[${index}].enabled`),
    targetAssetUrl: requireString(raw.targetAssetUrl, `rules[${index}].targetAssetUrl`),
    localFilePath: requireString(raw.localFilePath, `rules[${index}].localFilePath`),
    contentType: optionalString(raw.contentType, DEFAULT_CONTENT_TYPE),
  };
}

function parseProfile(raw: unknown, index: number, rootAutoReload: boolean): OverridePocProfileConfig {
  if (!isRecord(raw)) {
    throw new Error(`override-poc profile at index ${index} must be a JSON object`);
  }

  const rules = Array.isArray(raw.rules)
    ? raw.rules.map((rule, ruleIndex) => parseRule(rule, ruleIndex))
    : [];
  if (rules.length === 0) {
    throw new Error(`override-poc profile at index ${index} must define at least one rule`);
  }

  return {
    profileId: optionalString(raw.profileId, `profile-${index + 1}`),
    name: optionalString(raw.name, `Profile ${index + 1}`),
    enabled: optionalBoolean(raw.enabled, true, `profiles[${index}].enabled`),
    autoReload: optionalBoolean(raw.autoReload, rootAutoReload, `profiles[${index}].autoReload`),
    rules,
  };
}

function parseLegacyConfig(raw: Record<string, unknown>): OverridePocConfig {
  const enabled = requireBoolean(raw.enabled, 'enabled');
  const autoReload = requireBoolean(raw.autoReload, 'autoReload');
  const rule: OverridePocRuleConfig = {
    ruleId: optionalString(raw.ruleId, 'default'),
    enabled: true,
    targetAssetUrl: requireString(raw.targetAssetUrl, 'targetAssetUrl'),
    localFilePath: requireString(raw.localFilePath, 'localFilePath'),
    contentType: optionalString(raw.contentType, DEFAULT_CONTENT_TYPE),
  };
  const profileId = optionalString(raw.profileId, 'poc');

  return {
    enabled,
    activeProfileId: profileId,
    profiles: [{
      profileId,
      name: optionalString(raw.name, 'Override POC'),
      enabled: true,
      autoReload,
      rules: [rule],
    }],
  };
}

export function parseOverridePocConfig(raw: unknown): OverridePocConfig {
  if (!isRecord(raw)) {
    throw new Error('override-poc config must be a JSON object');
  }

  if (!Array.isArray(raw.profiles)) {
    return parseLegacyConfig(raw);
  }

  const enabled = requireBoolean(raw.enabled, 'enabled');
  const rootAutoReload = optionalBoolean(raw.autoReload, true, 'autoReload');
  const profiles = raw.profiles.map((profile, index) => parseProfile(profile, index, rootAutoReload));
  if (profiles.length === 0) {
    throw new Error('override-poc config must define at least one profile');
  }

  const activeProfileId = optionalString(raw.activeProfileId, profiles[0]?.profileId ?? 'profile-1');
  if (!profiles.some((profile) => profile.profileId === activeProfileId)) {
    throw new Error(`override-poc activeProfileId does not match any profile: ${activeProfileId}`);
  }

  return {
    enabled,
    activeProfileId,
    profiles,
  };
}

export function resolveOverridePocLocalFilePath(
  config: Pick<OverridePocRuleConfig, 'localFilePath'>,
  configPath?: string,
): string {
  const resolvedConfigPath = resolveOverridePocConfigPath(configPath);
  if (isAbsolute(config.localFilePath)) {
    return config.localFilePath;
  }

  return resolve(dirname(resolvedConfigPath), config.localFilePath);
}

export function getOverridePocLocalConfigPath(defaultConfigPath: string = DEFAULT_CONFIG_PATH): string {
  return resolve(dirname(defaultConfigPath), LOCAL_CONFIG_FILENAME);
}

export function resolveOverridePocConfigPath(
  configPath?: string,
  env: NodeJS.ProcessEnv = process.env,
  defaultConfigPath: string = DEFAULT_CONFIG_PATH,
): string {
  if (typeof configPath === 'string' && configPath.trim().length > 0) {
    return configPath.trim();
  }

  const envConfigPath = resolveEnvConfigPath(env);
  if (envConfigPath) {
    return envConfigPath;
  }

  const localConfigPath = getOverridePocLocalConfigPath(defaultConfigPath);
  if (existsSync(localConfigPath)) {
    return localConfigPath;
  }

  return defaultConfigPath;
}

export function loadOverridePocConfig(configPath?: string): OverridePocConfig {
  const resolvedConfigPath = resolveOverridePocConfigPath(configPath);
  let rawText: string;
  try {
    rawText = readFileSync(resolvedConfigPath, 'utf8');
  } catch (error) {
    throw new Error(
      `Unable to read override-poc config at ${resolvedConfigPath}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(
      `Invalid JSON in override-poc config at ${resolvedConfigPath}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }

  return parseOverridePocConfig(parsed);
}

function resolveRuleSummary(rule: OverridePocRuleConfig, configPath: string): OverridePocRuleSummary {
  const resolvedLocalFilePath = resolveOverridePocLocalFilePath(rule, configPath);
  const fileExists = existsSync(resolvedLocalFilePath);
  const fileSizeBytes = fileExists ? statSync(resolvedLocalFilePath).size : null;

  return {
    ...rule,
    resolvedLocalFilePath,
    fileExists,
    fileSizeBytes,
  };
}

function resolveProfileSummary(profile: OverridePocProfileConfig, configPath: string): OverridePocProfileSummary {
  const rules = profile.rules.map((rule) => resolveRuleSummary(rule, configPath));
  const enabledRules = rules.filter((rule) => rule.enabled);

  return {
    ...profile,
    rules,
    ruleCount: rules.length,
    enabledRuleCount: enabledRules.length,
    fileExists: enabledRules.length > 0 && enabledRules.every((rule) => rule.fileExists),
  };
}

export function getOverridePocConfigSummary(configPath?: string): OverridePocConfigSummary {
  const resolvedConfigPath = resolveOverridePocConfigPath(configPath);
  const config = loadOverridePocConfig(resolvedConfigPath);
  const profiles = config.profiles.map((profile) => resolveProfileSummary(profile, resolvedConfigPath));
  const activeProfile = profiles.find((profile) => profile.profileId === config.activeProfileId) ?? profiles[0];
  if (!activeProfile) {
    throw new Error('override-poc config must define at least one profile');
  }

  const enabledRules = activeProfile.rules.filter((rule) => rule.enabled);
  const primaryRule = enabledRules[0] ?? activeProfile.rules[0];
  if (!primaryRule) {
    throw new Error(`override-poc active profile "${activeProfile.profileId}" must define at least one rule`);
  }

  const enabled = config.enabled && activeProfile.enabled && enabledRules.length > 0;
  const fileExists = enabledRules.length > 0 && enabledRules.every((rule) => rule.fileExists);

  return {
    configEnabled: config.enabled,
    enabled,
    activeProfileId: activeProfile.profileId,
    profileId: activeProfile.profileId,
    profileName: activeProfile.name,
    autoReload: activeProfile.autoReload,
    configPath: resolvedConfigPath,
    profiles,
    rules: activeProfile.rules,
    ruleCount: activeProfile.ruleCount,
    enabledRuleCount: activeProfile.enabledRuleCount,
    targetAssetUrl: primaryRule.targetAssetUrl,
    localFilePath: primaryRule.localFilePath,
    resolvedLocalFilePath: primaryRule.resolvedLocalFilePath,
    contentType: primaryRule.contentType,
    fileExists,
    fileSizeBytes: primaryRule.fileSizeBytes,
  };
}

export function getOverridePocAssetResponse(
  assetUrl: string,
  configPath?: string,
): OverridePocAssetResponse {
  const summary = getOverridePocConfigSummary(configPath);
  if (!summary.enabled) {
    throw new Error(`Override POC is disabled in ${summary.configPath}`);
  }

  const rule = summary.rules.find((candidate) => candidate.targetAssetUrl === assetUrl);
  if (!rule) {
    throw new Error('Requested assetUrl does not match any enabled rule in the active override profile');
  }

  if (!rule.enabled) {
    throw new Error(`Override rule is disabled: ${rule.ruleId}`);
  }

  if (!rule.fileExists) {
    throw new Error(`Configured local file does not exist: ${rule.resolvedLocalFilePath}`);
  }

  const buffer = readFileSync(rule.resolvedLocalFilePath);
  return {
    buffer,
    contentType: rule.contentType,
    summary,
    rule,
  };
}
