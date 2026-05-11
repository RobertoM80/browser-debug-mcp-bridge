import { normalizeOverrideRequestMethod, type OverridePocRuleType } from './override-rule-types.js';

export interface OverrideCapabilityIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface OverrideResponseRequestCapabilityOptions {
  requestMethod?: unknown;
  requestHeaders?: unknown;
  ruleId?: unknown;
  ruleType?: unknown;
  subject?: string;
}

export interface OverrideResponseRequestCapabilityResult {
  requestMethod: string;
  requestHeaders: Record<string, string>;
  classification: 'safe-get' | 'safe-head' | 'server-action' | 'mutation-replay';
  productionSafe: boolean;
  captureSafe: boolean;
  issues: OverrideCapabilityIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRequestHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.trim().toLowerCase();
    if (name.length === 0) {
      continue;
    }
    if (typeof rawValue === 'string') {
      const trimmed = rawValue.trim();
      if (trimmed.length > 0) {
        normalized[name] = trimmed;
      }
      continue;
    }
    if (typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      normalized[name] = String(rawValue);
    }
  }
  return normalized;
}

function resolveSubject(options: OverrideResponseRequestCapabilityOptions): string {
  if (typeof options.subject === 'string' && options.subject.trim().length > 0) {
    return options.subject.trim();
  }
  if (typeof options.ruleId === 'string' && options.ruleId.trim().length > 0) {
    return `Rule ${options.ruleId.trim()}`;
  }
  return 'Response override request';
}

function isRscRuleType(value: unknown): value is OverridePocRuleType {
  return value === 'rsc-flight';
}

function isServerActionLikeRequest(options: {
  requestMethod: string;
  requestHeaders: Record<string, string>;
  ruleType?: unknown;
}): boolean {
  if (options.requestMethod === 'GET' || options.requestMethod === 'HEAD') {
    return false;
  }

  if (typeof options.requestHeaders['next-action'] === 'string') {
    return true;
  }
  if (options.requestHeaders.rsc === '1') {
    return true;
  }
  if (isRscRuleType(options.ruleType)) {
    return true;
  }
  return false;
}

export function classifyOverrideResponseRequestCapability(
  options: OverrideResponseRequestCapabilityOptions,
): OverrideResponseRequestCapabilityResult {
  const requestMethod = normalizeOverrideRequestMethod(options.requestMethod);
  const requestHeaders = normalizeRequestHeaders(options.requestHeaders);
  const subject = resolveSubject(options);
  const issues: OverrideCapabilityIssue[] = [];

  if (requestMethod !== 'GET') {
    issues.push({
      code: 'UNSAFE_REQUEST_METHOD',
      severity: 'error',
      message: `${subject} uses ${requestMethod}; production response overrides only support GET requests.`,
    });
  }

  if (requestMethod === 'GET') {
    return {
      requestMethod,
      requestHeaders,
      classification: 'safe-get',
      productionSafe: true,
      captureSafe: true,
      issues,
    };
  }

  if (requestMethod === 'HEAD') {
    return {
      requestMethod,
      requestHeaders,
      classification: 'safe-head',
      productionSafe: false,
      captureSafe: true,
      issues,
    };
  }

  if (isServerActionLikeRequest({ requestMethod, requestHeaders, ruleType: options.ruleType })) {
    issues.push({
      code: 'SERVER_ACTION_UNSUPPORTED',
      severity: 'error',
      message: `${subject} appears to be a Next.js server action or RSC mutation request; production overrides cannot replay or fulfill server action responses.`,
    });
    return {
      requestMethod,
      requestHeaders,
      classification: 'server-action',
      productionSafe: false,
      captureSafe: false,
      issues,
    };
  }

  issues.push({
    code: 'MUTATION_REPLAY_UNSUPPORTED',
    severity: 'error',
    message: `${subject} uses ${requestMethod} and would replay a mutation response; production overrides do not support non-GET mutation requests.`,
  });
  return {
    requestMethod,
    requestHeaders,
    classification: 'mutation-replay',
    productionSafe: false,
    captureSafe: false,
    issues,
  };
}

export function formatOverrideCapabilityIssues(issues: OverrideCapabilityIssue[]): string {
  return issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => `${issue.code}: ${issue.message}`)
    .join(' ');
}

export function assertOverrideResponseRequestProductionSafe(
  options: OverrideResponseRequestCapabilityOptions,
): OverrideResponseRequestCapabilityResult {
  const capability = classifyOverrideResponseRequestCapability(options);
  if (capability.productionSafe) {
    return capability;
  }
  throw new Error(formatOverrideCapabilityIssues(capability.issues));
}

export function assertOverrideResponseRequestCaptureSafe(
  options: OverrideResponseRequestCapabilityOptions,
): OverrideResponseRequestCapabilityResult {
  const capability = classifyOverrideResponseRequestCapability(options);
  if (capability.captureSafe) {
    return capability;
  }
  throw new Error(formatOverrideCapabilityIssues(capability.issues));
}
