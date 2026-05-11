export const OVERRIDE_POC_RULE_TYPES = [
  'asset',
  'document',
  'rsc-flight',
  'next-data',
  'api-response',
] as const;

export type OverridePocRuleType = typeof OVERRIDE_POC_RULE_TYPES[number];

const RULE_TYPE_SET = new Set<string>(OVERRIDE_POC_RULE_TYPES);

export const OVERRIDE_POC_MATCH_MODES = [
  'exact',
  'prefix',
] as const;

export type OverridePocMatchMode = typeof OVERRIDE_POC_MATCH_MODES[number];

const MATCH_MODE_SET = new Set<string>(OVERRIDE_POC_MATCH_MODES);

export function isOverridePocRuleType(value: unknown): value is OverridePocRuleType {
  return typeof value === 'string' && RULE_TYPE_SET.has(value);
}

export function isOverridePocMatchMode(value: unknown): value is OverridePocMatchMode {
  return typeof value === 'string' && MATCH_MODE_SET.has(value);
}

export function normalizeOverridePocRuleType(value: unknown, fallback: OverridePocRuleType = 'asset'): OverridePocRuleType {
  return isOverridePocRuleType(value) ? value : fallback;
}

export function normalizeOverrideMatchMode(value: unknown, fallback: OverridePocMatchMode = 'exact'): OverridePocMatchMode {
  return isOverridePocMatchMode(value) ? value : fallback;
}

export function normalizeOverrideRequestMethod(value: unknown, fallback = 'GET'): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fallback;
  }

  return value.trim().toUpperCase();
}
