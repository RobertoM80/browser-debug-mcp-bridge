import { load } from 'cheerio';
import {
  applyJsonPatches,
  assertJsonSerializableValue,
  type AppliedOverrideResponseJsonPatch,
  type JsonValue,
} from './json-rewrite.js';

export interface OverrideDocumentTextPatch {
  operation: 'replaceText';
  selector: string;
  search: string;
  replacement: string;
  expectedCount?: number;
  required: boolean;
}

export interface AppliedOverrideDocumentTextPatch extends OverrideDocumentTextPatch {
  matchedElementCount: number;
  matchedTextCount: number;
}

export interface OverrideDocumentRemoveElementPatch {
  operation: 'removeElement';
  selector: string;
  expectedCount?: number;
  required: boolean;
}

export interface AppliedOverrideDocumentRemoveElementPatch extends OverrideDocumentRemoveElementPatch {
  removedCount: number;
}

export interface OverrideDocumentJsonPatch {
  operation: 'replaceJsonValue';
  selector: string;
  path: string;
  value: JsonValue;
  expectedValue?: JsonValue;
}

export interface AppliedOverrideDocumentJsonPatch extends OverrideDocumentJsonPatch {
  matchedElementCount: number;
  appliedJsonPatches: AppliedOverrideResponseJsonPatch[];
}

export type OverrideDocumentPatch =
  | OverrideDocumentTextPatch
  | OverrideDocumentRemoveElementPatch
  | OverrideDocumentJsonPatch;

export type AppliedOverrideDocumentPatch =
  | AppliedOverrideDocumentTextPatch
  | AppliedOverrideDocumentRemoveElementPatch
  | AppliedOverrideDocumentJsonPatch;

type DocumentRewriteNode = {
  type?: string;
  data?: string | null;
  children?: DocumentRewriteNode[];
};

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function countOccurrences(source: string, search: string): number {
  return source.split(search).length - 1;
}

function normalizeExpectedCount(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.floor(value) < 0) {
    throw new Error(`${fieldName} must be a non-negative finite number when provided`);
  }
  return Math.floor(value);
}

export function normalizeDocumentPatches(value: unknown): OverrideDocumentPatch[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('documentPatches must include at least one patch');
  }

  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`documentPatches[${index}] must be an object`);
    }

    const patch = entry as Record<string, unknown>;
    const operation = normalizeOptionalString(patch.operation);
    if (!operation) {
      throw new Error(`documentPatches[${index}].operation is required`);
    }

    const selector = normalizeOptionalString(patch.selector);
    if (!selector) {
      throw new Error(`documentPatches[${index}].selector must be a non-empty string`);
    }

    switch (operation) {
      case 'replaceText': {
        const search = normalizeOptionalString(patch.search);
        if (!search) {
          throw new Error(`documentPatches[${index}].search must be a non-empty string`);
        }
        if (typeof patch.replacement !== 'string') {
          throw new Error(`documentPatches[${index}].replacement must be a string`);
        }
        return {
          operation,
          selector,
          search,
          replacement: patch.replacement,
          expectedCount: normalizeExpectedCount(patch.expectedCount, `documentPatches[${index}].expectedCount`),
          required: patch.required !== false,
        };
      }
      case 'removeElement':
        return {
          operation,
          selector,
          expectedCount: normalizeExpectedCount(patch.expectedCount, `documentPatches[${index}].expectedCount`),
          required: patch.required !== false,
        };
      case 'replaceJsonValue': {
        const path = normalizeOptionalString(patch.path);
        if (!path || path === '/' || !path.startsWith('/')) {
          throw new Error(`documentPatches[${index}].path must be a non-root JSON Pointer path starting with /`);
        }
        if (!Object.prototype.hasOwnProperty.call(patch, 'value')) {
          throw new Error(`documentPatches[${index}].value is required`);
        }
        assertJsonSerializableValue(patch.value, `documentPatches[${index}].value`);
        if (Object.prototype.hasOwnProperty.call(patch, 'expectedValue')) {
          assertJsonSerializableValue(patch.expectedValue, `documentPatches[${index}].expectedValue`);
        }
        return {
          operation,
          selector,
          path,
          value: patch.value,
          expectedValue: Object.prototype.hasOwnProperty.call(patch, 'expectedValue') ? patch.expectedValue as JsonValue : undefined,
        };
      }
      default:
        throw new Error(`documentPatches[${index}].operation must be replaceText, removeElement, or replaceJsonValue`);
    }
  });
}

function applyTextPatchToNode(node: DocumentRewriteNode, patch: OverrideDocumentTextPatch): number {
  let matchedTextCount = 0;

  if (node.type === 'text' && typeof node.data === 'string') {
    const localMatches = countOccurrences(node.data, patch.search);
    if (localMatches > 0) {
      node.data = node.data.split(patch.search).join(patch.replacement);
      matchedTextCount += localMatches;
    }
  }

  for (const child of node.children ?? []) {
    matchedTextCount += applyTextPatchToNode(child, patch);
  }

  return matchedTextCount;
}

export function applyDocumentPatches(body: string, patches: OverrideDocumentPatch[]): {
  patchedBody: string;
  applied: AppliedOverrideDocumentPatch[];
  warnings: string[];
} {
  const $ = load(body, { scriptingEnabled: false });
  const applied: AppliedOverrideDocumentPatch[] = [];
  const warnings: string[] = [];

  for (const patch of patches) {
    const selection = $(patch.selector);
    const matchedElementCount = selection.length;

    switch (patch.operation) {
      case 'replaceText': {
        if (matchedElementCount === 0 && patch.required) {
          throw new Error(`Document patch selector did not match any elements: ${patch.selector}`);
        }
        if (matchedElementCount === 0) {
          warnings.push(`Optional document patch selector did not match any elements: ${patch.selector}`);
          applied.push({
            ...patch,
            matchedElementCount: 0,
            matchedTextCount: 0,
          });
          continue;
        }

        let matchedTextCount = 0;
        selection.each((_index, node) => {
          matchedTextCount += applyTextPatchToNode(node as unknown as DocumentRewriteNode, patch);
        });

        if (patch.expectedCount !== undefined && matchedTextCount !== patch.expectedCount) {
          throw new Error(`Document patch ${patch.selector} matched ${matchedTextCount} text occurrence(s), expected ${patch.expectedCount}`);
        }
        if (matchedTextCount === 0 && patch.required) {
          throw new Error(`Document patch text was not found within selector ${patch.selector}: ${JSON.stringify(patch.search)}`);
        }
        if (matchedTextCount === 0) {
          warnings.push(`Optional document patch text was not found within selector ${patch.selector}: ${JSON.stringify(patch.search)}`);
        }
        if (matchedTextCount > 0 && patch.search === patch.replacement) {
          warnings.push(`Document patch ${patch.selector} is a no-op replacement.`);
        }

        applied.push({
          ...patch,
          matchedElementCount,
          matchedTextCount,
        });
        continue;
      }
      case 'removeElement': {
        if (patch.expectedCount !== undefined && matchedElementCount !== patch.expectedCount) {
          throw new Error(`Document patch ${patch.selector} matched ${matchedElementCount} element(s), expected ${patch.expectedCount}`);
        }
        if (matchedElementCount === 0 && patch.required) {
          throw new Error(`Document patch selector did not match any elements: ${patch.selector}`);
        }
        if (matchedElementCount === 0) {
          warnings.push(`Optional document patch selector did not match any elements: ${patch.selector}`);
        } else {
          selection.remove();
        }

        applied.push({
          ...patch,
          removedCount: matchedElementCount,
        });
        continue;
      }
      case 'replaceJsonValue': {
        if (matchedElementCount !== 1) {
          throw new Error(`Document JSON patch selector ${patch.selector} matched ${matchedElementCount} element(s), expected exactly 1`);
        }

        const currentJson = selection.html();
        if (typeof currentJson !== 'string' || currentJson.trim().length === 0) {
          throw new Error(`Document JSON patch selector ${patch.selector} does not contain JSON text`);
        }

        const jsonResult = applyJsonPatches(currentJson, [{
          operation: 'replace',
          path: patch.path,
          value: patch.value,
          expectedValue: patch.expectedValue,
        }]);
        selection.text(jsonResult.patchedBody.trimEnd());
        warnings.push(...jsonResult.warnings.map((warning) => `Document JSON patch ${patch.selector}: ${warning}`));

        applied.push({
          ...patch,
          matchedElementCount,
          appliedJsonPatches: jsonResult.applied,
        });
      }
    }
  }

  const patchedBody = $.html();
  if (patchedBody === body) {
    throw new Error('No document patch changed the body');
  }

  return {
    patchedBody,
    applied,
    warnings,
  };
}
