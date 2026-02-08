export interface CaptureConfig {
  safeMode: boolean;
  allowlist: string[];
}

export interface StorageAreaLike {
  get(keys: string | string[] | Record<string, unknown> | null, callback: (items: Record<string, unknown>) => void): void;
  set(items: Record<string, unknown>, callback?: () => void): void;
}

const STORAGE_KEY = 'captureConfig';
const SAFE_MODE_REDACTION = '[REDACTED_SAFE_MODE]';

const BLOCKED_SAFE_MODE_EVENT_TYPES = new Set(['cookie', 'cookies', 'storage', 'local_storage', 'session_storage']);
const SENSITIVE_KEY_PATTERNS = [
  /cookie/i,
  /local.?storage/i,
  /session.?storage/i,
  /indexed.?db/i,
  /input/i,
  /password/i,
  /form.?value/i,
  /input.?value/i,
  /typed.?text/i,
  /^value$/i,
];
const COOKIE_VALUE_PATTERN = /(^|\s)(cookie|set-cookie)\s*:/i;

export const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
  safeMode: true,
  allowlist: [],
};

export function normalizeCaptureConfig(value: unknown): CaptureConfig {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_CAPTURE_CONFIG };
  }

  const config = value as Partial<CaptureConfig>;
  return {
    safeMode: config.safeMode ?? DEFAULT_CAPTURE_CONFIG.safeMode,
    allowlist: normalizeAllowlist(config.allowlist ?? DEFAULT_CAPTURE_CONFIG.allowlist),
  };
}

export function normalizeAllowlist(values: string[]): string[] {
  const normalized = new Set<string>();

  for (const value of values) {
    const rule = normalizeAllowlistRule(value);
    if (rule) {
      normalized.add(rule);
    }
  }

  return Array.from(normalized);
}

export function parseAllowlistInput(input: string): string[] {
  const raw = input
    .split(/[\n,]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return normalizeAllowlist(raw);
}

export function isUrlAllowed(url: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) {
    return false;
  }

  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }

  return allowlist.some((rule) => hostMatchesRule(host, rule));
}

export function applySafeModeRestrictions(eventType: string, data: Record<string, unknown>): Record<string, unknown> | null {
  if (BLOCKED_SAFE_MODE_EVENT_TYPES.has(eventType)) {
    return null;
  }

  const sanitized = sanitizeUnknownValue(data);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    return {};
  }

  return sanitized as Record<string, unknown>;
}

export function loadCaptureConfig(storageArea: StorageAreaLike): Promise<CaptureConfig> {
  return new Promise((resolve) => {
    storageArea.get(STORAGE_KEY, (items) => {
      resolve(normalizeCaptureConfig(items[STORAGE_KEY]));
    });
  });
}

export function saveCaptureConfig(storageArea: StorageAreaLike, config: CaptureConfig): Promise<CaptureConfig> {
  const normalized = normalizeCaptureConfig(config);
  return new Promise((resolve) => {
    storageArea.set({ [STORAGE_KEY]: normalized }, () => {
      resolve(normalized);
    });
  });
}

function sanitizeUnknownValue(value: unknown, keyName?: string): unknown {
  if (keyName && isSensitiveKey(keyName)) {
    return SAFE_MODE_REDACTION;
  }

  if (typeof value === 'string') {
    if (COOKIE_VALUE_PATTERN.test(value)) {
      return SAFE_MODE_REDACTION;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeUnknownValue(entry));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(source)) {
    result[key] = sanitizeUnknownValue(entry, key);
  }

  return result;
}

function normalizeAllowlistRule(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  const wildcard = trimmed.startsWith('*.');
  const candidate = wildcard ? trimmed.slice(2) : trimmed;
  const host = extractHostname(candidate);

  if (!host) {
    return null;
  }

  return wildcard ? `*.${host}` : host;
}

function extractHostname(input: string): string | null {
  const withProtocol = /^https?:\/\//.test(input) ? input : `https://${input}`;

  try {
    const url = new URL(withProtocol);
    if (!url.hostname) {
      return null;
    }
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hostMatchesRule(host: string, rule: string): boolean {
  if (rule.startsWith('*.')) {
    const base = rule.slice(2);
    return host === base || host.endsWith(`.${base}`);
  }

  return host === rule;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}
