import { existsSync, readFileSync, statSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import { fileURLToPath } from 'url';

export interface OverridePocConfig {
  enabled: boolean;
  targetAssetUrl: string;
  localFilePath: string;
  contentType: string;
  autoReload: boolean;
}

export interface OverridePocConfigSummary extends OverridePocConfig {
  configPath: string;
  resolvedLocalFilePath: string;
  fileExists: boolean;
  fileSizeBytes: number | null;
}

export interface OverridePocAssetResponse {
  buffer: Buffer;
  contentType: string;
  summary: OverridePocConfigSummary;
}

const DEFAULT_CONTENT_TYPE = 'application/javascript; charset=utf-8';
const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../../../override-poc.config.json', import.meta.url));

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

export function parseOverridePocConfig(raw: unknown): OverridePocConfig {
  if (!isRecord(raw)) {
    throw new Error('override-poc config must be a JSON object');
  }

  const enabled = requireBoolean(raw.enabled, 'enabled');
  const targetAssetUrl = requireString(raw.targetAssetUrl, 'targetAssetUrl');
  const localFilePath = requireString(raw.localFilePath, 'localFilePath');
  const contentType = typeof raw.contentType === 'string' && raw.contentType.trim().length > 0
    ? raw.contentType.trim()
    : DEFAULT_CONTENT_TYPE;
  const autoReload = requireBoolean(raw.autoReload, 'autoReload');

  return {
    enabled,
    targetAssetUrl,
    localFilePath,
    contentType,
    autoReload,
  };
}

export function resolveOverridePocLocalFilePath(
  config: Pick<OverridePocConfig, 'localFilePath'>,
  configPath: string = DEFAULT_CONFIG_PATH,
): string {
  if (isAbsolute(config.localFilePath)) {
    return config.localFilePath;
  }

  return resolve(dirname(configPath), config.localFilePath);
}

export function loadOverridePocConfig(configPath: string = DEFAULT_CONFIG_PATH): OverridePocConfig {
  let rawText: string;
  try {
    rawText = readFileSync(configPath, 'utf8');
  } catch (error) {
    throw new Error(
      `Unable to read override-poc config at ${configPath}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(
      `Invalid JSON in override-poc config at ${configPath}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }

  return parseOverridePocConfig(parsed);
}

export function getOverridePocConfigSummary(configPath: string = DEFAULT_CONFIG_PATH): OverridePocConfigSummary {
  const config = loadOverridePocConfig(configPath);
  const resolvedLocalFilePath = resolveOverridePocLocalFilePath(config, configPath);
  const fileExists = existsSync(resolvedLocalFilePath);
  const fileSizeBytes = fileExists ? statSync(resolvedLocalFilePath).size : null;

  return {
    ...config,
    configPath,
    resolvedLocalFilePath,
    fileExists,
    fileSizeBytes,
  };
}

export function getOverridePocAssetResponse(
  assetUrl: string,
  configPath: string = DEFAULT_CONFIG_PATH,
): OverridePocAssetResponse {
  const summary = getOverridePocConfigSummary(configPath);
  if (!summary.enabled) {
    throw new Error(`Override POC is disabled in ${summary.configPath}`);
  }

  if (assetUrl !== summary.targetAssetUrl) {
    throw new Error('Requested assetUrl does not match the configured targetAssetUrl');
  }

  if (!summary.fileExists) {
    throw new Error(`Configured local file does not exist: ${summary.resolvedLocalFilePath}`);
  }

  const buffer = readFileSync(summary.resolvedLocalFilePath);
  return {
    buffer,
    contentType: summary.contentType,
    summary,
  };
}
