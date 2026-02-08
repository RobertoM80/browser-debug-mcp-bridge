import { createHash } from 'node:crypto';

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function createErrorFingerprint(message: string, stack?: string): string {
  const normalizedMessage = normalizeText(message || 'unknown error');
  const normalizedStack = normalizeText(stack || '');
  const source = `${normalizedMessage}\n${normalizedStack}`;
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 16);
  return `fp-${digest}`;
}

export function resolveErrorFingerprint(data: Record<string, unknown>): string | null {
  const provided = typeof data.fingerprint === 'string' ? data.fingerprint.trim() : '';
  if (provided) {
    return provided;
  }

  const message = typeof data.message === 'string' ? data.message : 'Unknown error';
  const stack = typeof data.stack === 'string' ? data.stack : undefined;

  return createErrorFingerprint(message, stack);
}
