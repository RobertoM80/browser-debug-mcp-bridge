export interface RscFlightTextPatchSafetyInput {
  search: string;
  replacement: string;
  expectedCount?: number;
  required?: boolean;
}

export type RscFlightPatchFailureCode =
  | 'RSC_PATCH_ANCHOR_MISMATCH'
  | 'RSC_PATCH_UNSAFE'
  | 'RSC_FLIGHT_UNSUPPORTED_RECORD'
  | 'RSC_FLIGHT_STRUCTURAL_DRIFT';

export interface RscFlightPatchBlocker {
  code: RscFlightPatchFailureCode;
  message: string;
  patchSearch?: string;
  rowIndex?: number;
  rowId?: string;
}

export interface AppliedRscFlightTextPatch extends RscFlightTextPatchSafetyInput {
  matchedCount: number;
}

export interface RscFlightPatchResult {
  patchedBody: string;
  applied: AppliedRscFlightTextPatch[];
  blockers: RscFlightPatchBlocker[];
  warnings: string[];
}

interface FlightRow {
  originalLine: string;
  newline: string;
  index: number;
  rowId?: string;
  tag?: string;
  value?: unknown;
  unsupportedReason?: string;
}

const JSON_PAYLOAD_START_PATTERN = /[\[{"\-0-9tfn]/u;

function countOccurrences(source: string, search: string): number {
  return source.split(search).length - 1;
}

function splitFlightRows(body: string): FlightRow[] {
  const rows: FlightRow[] = [];
  let cursor = 0;
  let index = 0;

  while (cursor < body.length) {
    const nextNewline = body.slice(cursor).search(/\r\n|\n|\r/u);
    if (nextNewline === -1) {
      rows.push(parseFlightRow(body.slice(cursor), '', index));
      break;
    }

    const newlineStart = cursor + nextNewline;
    const newline = body.startsWith('\r\n', newlineStart) ? '\r\n' : body[newlineStart] ?? '';
    rows.push(parseFlightRow(body.slice(cursor, newlineStart), newline, index));
    cursor = newlineStart + newline.length;
    index += 1;
  }

  return rows;
}

function parseFlightRow(line: string, newline: string, index: number): FlightRow {
  const colonIndex = line.indexOf(':');
  if (colonIndex <= 0) {
    return {
      originalLine: line,
      newline,
      index,
      unsupportedReason: 'missing Flight row id separator',
    };
  }

  const rowId = line.slice(0, colonIndex);
  const remainder = line.slice(colonIndex + 1);
  const payloadStart = remainder.search(JSON_PAYLOAD_START_PATTERN);
  if (payloadStart === -1) {
    return {
      originalLine: line,
      newline,
      index,
      rowId,
      unsupportedReason: 'missing JSON payload',
    };
  }

  const tag = remainder.slice(0, payloadStart);
  const payload = remainder.slice(payloadStart);
  if (tag.length > 0) {
    return {
      originalLine: line,
      newline,
      index,
      rowId,
      tag,
      unsupportedReason: `unsupported Flight row tag "${tag}"`,
    };
  }

  try {
    return {
      originalLine: line,
      newline,
      index,
      rowId,
      tag,
      value: JSON.parse(payload) as unknown,
    };
  } catch (error) {
    return {
      originalLine: line,
      newline,
      index,
      rowId,
      unsupportedReason: `unparseable JSON payload: ${error instanceof Error ? error.message : 'invalid JSON'}`,
    };
  }
}

function serializeRows(rows: FlightRow[]): string {
  return rows.map((row) => {
    if (row.unsupportedReason !== undefined) {
      return `${row.originalLine}${row.newline}`;
    }
    return `${row.rowId ?? ''}:${row.tag ?? ''}${JSON.stringify(row.value)}${row.newline}`;
  }).join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLikelyRscProtocolReference(value: string): boolean {
  return value === '$'
    || /^\$(?:L\d+|undefined|NaN|Infinity|-0|D|S|F|@|Q|W|K|E|T)/u.test(value);
}

function createBlocker(
  code: RscFlightPatchFailureCode,
  message: string,
  patch: RscFlightTextPatchSafetyInput,
  row?: FlightRow,
): RscFlightPatchBlocker {
  return {
    code,
    message,
    patchSearch: patch.search,
    rowIndex: row?.index,
    rowId: row?.rowId,
  };
}

function findStructuralBlocker(value: unknown, patch: RscFlightTextPatchSafetyInput, row: FlightRow): RscFlightPatchBlocker | undefined {
  if (typeof value === 'string') {
    if (value.includes(patch.search) && isLikelyRscProtocolReference(value)) {
      return createBlocker(
        'RSC_PATCH_UNSAFE',
        `RSC flight patch ${JSON.stringify(patch.search)} matched an RSC protocol reference token.`,
        patch,
        row,
      );
    }
    return undefined;
  }

  if (Array.isArray(value)) {
    if (value[0] === '$') {
      const elementType = value[1];
      const elementKey = value[2];
      if (typeof elementType === 'string' && elementType.includes(patch.search)) {
        return createBlocker(
          'RSC_PATCH_UNSAFE',
          `RSC flight patch ${JSON.stringify(patch.search)} matched a React element type token.`,
          patch,
          row,
        );
      }
      if (typeof elementKey === 'string' && elementKey.includes(patch.search)) {
        return createBlocker(
          'RSC_PATCH_UNSAFE',
          `RSC flight patch ${JSON.stringify(patch.search)} matched a React element key token.`,
          patch,
          row,
        );
      }
    }
    for (const item of value) {
      const blocker = findStructuralBlocker(item, patch, row);
      if (blocker) {
        return blocker;
      }
    }
    return undefined;
  }

  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (key.includes(patch.search)) {
        return createBlocker(
          'RSC_PATCH_UNSAFE',
          `RSC flight patch ${JSON.stringify(patch.search)} matched a JSON object key, not a string payload value.`,
          patch,
          row,
        );
      }
      const blocker = findStructuralBlocker(child, patch, row);
      if (blocker) {
        return blocker;
      }
    }
  }

  return undefined;
}

function replaceStringValueOccurrences(value: unknown, patch: RscFlightTextPatchSafetyInput): { value: unknown; matchedCount: number } {
  if (typeof value === 'string') {
    const matchedCount = countOccurrences(value, patch.search);
    return {
      value: matchedCount > 0 ? value.split(patch.search).join(patch.replacement) : value,
      matchedCount,
    };
  }

  if (Array.isArray(value)) {
    let matchedCount = 0;
    const replaced = value.map((item) => {
      const result = replaceStringValueOccurrences(item, patch);
      matchedCount += result.matchedCount;
      return result.value;
    });
    return { value: replaced, matchedCount };
  }

  if (isRecord(value)) {
    let matchedCount = 0;
    const replaced: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const result = replaceStringValueOccurrences(child, patch);
      matchedCount += result.matchedCount;
      replaced[key] = result.value;
    }
    return { value: replaced, matchedCount };
  }

  return { value, matchedCount: 0 };
}

export function applyRscFlightTextPatches(
  body: string,
  patches: RscFlightTextPatchSafetyInput[],
): RscFlightPatchResult {
  const rows = splitFlightRows(body);
  const applied: AppliedRscFlightTextPatch[] = [];
  const warnings: string[] = [];

  for (const patch of patches) {
    if (patch.search.length === 0) {
      return {
        patchedBody: body,
        applied,
        warnings,
        blockers: [createBlocker('RSC_PATCH_UNSAFE', 'RSC flight patch search text must be a non-empty string.', patch)],
      };
    }

    for (const row of rows) {
      if (row.unsupportedReason !== undefined) {
        if (row.originalLine.includes(patch.search)) {
          return {
            patchedBody: body,
            applied,
            warnings,
            blockers: [
              createBlocker(
                'RSC_FLIGHT_UNSUPPORTED_RECORD',
                `RSC flight patch ${JSON.stringify(patch.search)} matched an unsupported Flight row (${row.unsupportedReason}).`,
                patch,
                row,
              ),
            ],
          };
        }
        continue;
      }

      const blocker = findStructuralBlocker(row.value, patch, row);
      if (blocker) {
        return { patchedBody: body, applied, warnings, blockers: [blocker] };
      }
    }

    let matchedCount = 0;
    const replacementResults: Array<{ row: FlightRow; value: unknown }> = [];
    for (const row of rows) {
      if (row.unsupportedReason !== undefined) {
        continue;
      }
      const result = replaceStringValueOccurrences(row.value, patch);
      replacementResults.push({ row, value: result.value });
      matchedCount += result.matchedCount;
    }

    if (countOccurrences(serializeRows(rows), patch.search) > matchedCount) {
      return {
        patchedBody: body,
        applied,
        warnings,
        blockers: [
          createBlocker(
            'RSC_PATCH_UNSAFE',
            `RSC flight patch ${JSON.stringify(patch.search)} matched outside a JSON string payload.`,
            patch,
          ),
        ],
      };
    }

    for (const result of replacementResults) {
      result.row.value = result.value;
    }

    if (patch.expectedCount !== undefined && matchedCount !== patch.expectedCount) {
      return {
        patchedBody: body,
        applied,
        warnings,
        blockers: [
          createBlocker(
            'RSC_PATCH_ANCHOR_MISMATCH',
            `RSC flight patch ${JSON.stringify(patch.search)} matched ${matchedCount} time(s), expected ${patch.expectedCount}.`,
            patch,
          ),
        ],
      };
    }

    if (matchedCount === 0 && patch.required !== false) {
      return {
        patchedBody: body,
        applied,
        warnings,
        blockers: [
          createBlocker(
            'RSC_PATCH_ANCHOR_MISMATCH',
            `RSC flight patch search text was not found: ${JSON.stringify(patch.search)}`,
            patch,
          ),
        ],
      };
    }

    if (matchedCount === 0) {
      warnings.push(`Optional RSC flight patch search text was not found: ${JSON.stringify(patch.search)}`);
    }
    if (matchedCount > 0 && patch.search === patch.replacement) {
      warnings.push(`RSC flight patch search ${JSON.stringify(patch.search)} is a no-op replacement.`);
    }

    applied.push({
      ...patch,
      matchedCount,
    });
  }

  return {
    patchedBody: serializeRows(rows),
    applied,
    blockers: [],
    warnings,
  };
}

export function assertRscFlightTextPatchesSafe(body: string, patches: RscFlightTextPatchSafetyInput[]): void {
  const result = applyRscFlightTextPatches(body, patches);
  const blocker = result.blockers[0];
  if (blocker) {
    throw new Error(blocker.message);
  }
}
