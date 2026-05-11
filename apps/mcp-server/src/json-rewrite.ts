export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface OverrideResponseJsonPatch {
  operation: 'replace';
  path: string;
  value: JsonValue;
  expectedValue?: JsonValue;
}

export interface AppliedOverrideResponseJsonPatch extends OverrideResponseJsonPatch {
  previousValue: JsonValue;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function hasOwnProperty(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isJsonRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertJsonSerializableValue(value: unknown, fieldName: string): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${fieldName} must be a finite JSON number`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonSerializableValue(entry, `${fieldName}[${index}]`));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      assertJsonSerializableValue(entry, `${fieldName}.${key}`);
    }
    return;
  }
  throw new Error(`${fieldName} must be a JSON-serializable value`);
}

export function normalizeJsonPatches(value: unknown): OverrideResponseJsonPatch[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('jsonPatches must include at least one patch');
  }

  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`jsonPatches[${index}] must be an object`);
    }
    const patch = entry as Record<string, unknown>;
    const operation = normalizeOptionalString(patch.operation ?? patch.op) ?? 'replace';
    if (operation !== 'replace') {
      throw new Error(`jsonPatches[${index}].operation must be replace`);
    }
    const path = normalizeOptionalString(patch.path);
    if (!path || path === '/' || !path.startsWith('/')) {
      throw new Error(`jsonPatches[${index}].path must be a non-root JSON Pointer path starting with /`);
    }
    if (!hasOwnProperty(patch, 'value')) {
      throw new Error(`jsonPatches[${index}].value is required`);
    }
    assertJsonSerializableValue(patch.value, `jsonPatches[${index}].value`);

    const normalized: OverrideResponseJsonPatch = {
      operation,
      path,
      value: patch.value,
    };
    if (hasOwnProperty(patch, 'expectedValue')) {
      assertJsonSerializableValue(patch.expectedValue, `jsonPatches[${index}].expectedValue`);
      normalized.expectedValue = patch.expectedValue;
    }
    return normalized;
  });
}

function decodeJsonPointer(path: string): string[] {
  return path.slice(1).split('/').map((segment) => {
    if (/~(?![01])/u.test(segment)) {
      throw new Error(`JSON patch path contains an invalid JSON Pointer escape: ${path}`);
    }
    const decoded = segment.replace(/~1/gu, '/').replace(/~0/gu, '~');
    if (decoded === '__proto__' || decoded === 'prototype' || decoded === 'constructor') {
      throw new Error(`JSON patch path contains an unsafe segment: ${decoded}`);
    }
    return decoded;
  });
}

function parseArrayIndex(segment: string, length: number, path: string): number {
  if (!/^(0|[1-9]\d*)$/u.test(segment)) {
    throw new Error(`JSON patch path ${path} expected an array index, got ${JSON.stringify(segment)}`);
  }
  const index = Number(segment);
  if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
    throw new Error(`JSON patch path ${path} array index ${segment} does not exist`);
  }
  return index;
}

function readJsonChild(parent: JsonValue, segment: string, path: string): JsonValue {
  if (Array.isArray(parent)) {
    return parent[parseArrayIndex(segment, parent.length, path)] as JsonValue;
  }
  if (isJsonRecord(parent)) {
    if (!hasOwnProperty(parent, segment)) {
      throw new Error(`JSON patch path does not exist: ${path}`);
    }
    return parent[segment] as JsonValue;
  }
  throw new Error(`JSON patch path cannot traverse non-container value: ${path}`);
}

function writeJsonChild(parent: JsonValue, segment: string, path: string, value: JsonValue): JsonValue {
  if (Array.isArray(parent)) {
    const index = parseArrayIndex(segment, parent.length, path);
    const previous = parent[index] as JsonValue;
    parent[index] = cloneJsonValue(value);
    return previous;
  }
  if (isJsonRecord(parent)) {
    if (!hasOwnProperty(parent, segment)) {
      throw new Error(`JSON patch path does not exist: ${path}`);
    }
    const previous = parent[segment] as JsonValue;
    parent[segment] = cloneJsonValue(value);
    return previous;
  }
  throw new Error(`JSON patch path cannot replace non-container value: ${path}`);
}

function cloneJsonValue(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function jsonValuesEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((entry, index) => jsonValuesEqual(entry, right[index] as JsonValue));
  }
  if (isJsonRecord(left) || isJsonRecord(right)) {
    if (!isJsonRecord(left) || !isJsonRecord(right)) {
      return false;
    }
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => hasOwnProperty(right, key) && jsonValuesEqual(left[key] as JsonValue, right[key] as JsonValue));
  }
  return false;
}

function resolveJsonPatchParent(root: JsonValue, path: string): { parent: JsonValue; leaf: string } {
  const segments = decodeJsonPointer(path);
  if (segments.length === 0) {
    throw new Error(`JSON patch path must not target the root document: ${path}`);
  }

  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = readJsonChild(current, segment, path);
  }

  return { parent: current, leaf: segments[segments.length - 1] as string };
}

export function applyJsonPatches(body: string, patches: OverrideResponseJsonPatch[]): {
  patchedBody: string;
  applied: AppliedOverrideResponseJsonPatch[];
  warnings: string[];
} {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(body) as JsonValue;
  } catch (error) {
    throw new Error(`Original response body must remain valid JSON: ${error instanceof Error ? error.message : 'invalid JSON'}`);
  }

  const applied: AppliedOverrideResponseJsonPatch[] = [];
  const warnings: string[] = [];
  let changed = false;
  for (const patch of patches) {
    const { parent, leaf } = resolveJsonPatchParent(parsed, patch.path);
    const previousValue = readJsonChild(parent, leaf, patch.path);
    if (patch.expectedValue !== undefined && !jsonValuesEqual(previousValue, patch.expectedValue)) {
      throw new Error(`JSON patch ${patch.path} expected value did not match the response body`);
    }
    writeJsonChild(parent, leaf, patch.path, patch.value);
    if (jsonValuesEqual(previousValue, patch.value)) {
      warnings.push(`JSON patch ${patch.path} is a no-op replacement.`);
    } else {
      changed = true;
    }
    applied.push({
      ...patch,
      previousValue: cloneJsonValue(previousValue),
    });
  }

  if (!changed) {
    throw new Error('No JSON response patch changed the body');
  }

  return {
    patchedBody: `${JSON.stringify(parsed)}\n`,
    applied,
    warnings,
  };
}
