import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
import { getRuntimeDataDir } from '../runtime-paths.js';

const CLI_TOKEN_FILE = 'cli-token.json';

interface CliTokenRecord {
  token: string;
  createdAt: string;
}

export const CLI_TOKEN_HEADER = 'x-browser-debug-cli-token';

export function getCliTokenPath(): string {
  return join(getRuntimeDataDir(), CLI_TOKEN_FILE);
}

function normalizeTokenRecord(value: unknown): CliTokenRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Partial<CliTokenRecord>;
  if (typeof record.token !== 'string' || record.token.length < 32) {
    return null;
  }
  if (typeof record.createdAt !== 'string' || record.createdAt.length === 0) {
    return null;
  }
  return {
    token: record.token,
    createdAt: record.createdAt,
  };
}

function readTokenRecord(path = getCliTokenPath()): CliTokenRecord | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return normalizeTokenRecord(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

export function ensureCliToken(): string {
  const tokenPath = getCliTokenPath();
  const existing = readTokenRecord(tokenPath);
  if (existing) {
    return existing.token;
  }

  const record: CliTokenRecord = {
    token: randomBytes(32).toString('base64url'),
    createdAt: new Date().toISOString(),
  };
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return record.token;
}

export function getBearerToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1];
}

export function isAuthorizedCliRequest(headers: Record<string, unknown>): boolean {
  const expected = ensureCliToken();
  const headerValue = headers[CLI_TOKEN_HEADER] ?? headers[CLI_TOKEN_HEADER.toLowerCase()];
  const explicitToken = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const authorization = headers.authorization;
  const bearer = Array.isArray(authorization) ? getBearerToken(authorization[0]) : getBearerToken(authorization);
  return explicitToken === expected || bearer === expected;
}
