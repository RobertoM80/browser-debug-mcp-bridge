function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeUtf8Base64(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Refs created before UTF-8 encoding stored Latin-1 code units directly.
    return binary;
  }
}

export function encodeElementRefPayload(payload: object): string {
  return `ref:${encodeUtf8Base64(JSON.stringify(payload))}`;
}

export function decodeElementRefPayload(elementRef: unknown): Record<string, unknown> | undefined {
  if (typeof elementRef !== 'string' || !elementRef.startsWith('ref:')) {
    return undefined;
  }

  try {
    const decoded = JSON.parse(decodeUtf8Base64(elementRef.slice(4))) as unknown;
    return decoded && typeof decoded === 'object' && !Array.isArray(decoded)
      ? decoded as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}
