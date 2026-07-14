export type GenericCaptureCommand =
  | 'CAPTURE_DOM_SUBTREE'
  | 'CAPTURE_DOM_DOCUMENT'
  | 'CAPTURE_PAGE_STATE';

type CaptureTabPreferenceOptions = {
  activeTabId?: number;
  rememberedTabId?: number;
  allowedTabIds?: number[];
};

type DomDocumentPayload = {
  mode?: unknown;
  outline?: unknown;
};

type PageStatePayload = {
  frameCaptureError?: unknown;
  frameCaptureErrorCode?: unknown;
  summary?: unknown;
  frames?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseOutlineNodeCount(payload: DomDocumentPayload): number | undefined {
  if (typeof payload.outline !== 'string' || payload.outline.length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(payload.outline) as unknown;
    const record = asRecord(parsed);
    return typeof record?.nodeCount === 'number' && Number.isFinite(record.nodeCount)
      ? record.nodeCount
      : undefined;
  } catch {
    return undefined;
  }
}

function isPageStateSummaryEmpty(summary: unknown): boolean {
  const record = asRecord(summary);
  if (!record) {
    return false;
  }

  return ['buttons', 'links', 'inputs', 'modals'].every((key) => {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) && value === 0;
  });
}

function hasFrameCaptureError(frames: unknown): boolean {
  if (!Array.isArray(frames)) {
    return false;
  }

  return frames.some((frame) => asRecord(frame)?.frameCaptureError === true);
}

export function buildPreferredCaptureTabIds(options: CaptureTabPreferenceOptions): number[] {
  const ordered: number[] = [];
  const seen = new Set<number>();

  const push = (value: unknown): void => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || seen.has(value)) {
      return;
    }
    seen.add(value);
    ordered.push(value);
  };

  push(options.activeTabId);
  push(options.rememberedTabId);
  for (const tabId of options.allowedTabIds ?? []) {
    push(tabId);
  }

  return ordered;
}

export function shouldRetryGenericCaptureResult(
  command: GenericCaptureCommand,
  payload: Record<string, unknown>,
): boolean {
  if (command === 'CAPTURE_DOM_DOCUMENT') {
    const documentPayload = payload as DomDocumentPayload;
    if (documentPayload.mode !== 'outline') {
      return false;
    }
    return parseOutlineNodeCount(documentPayload) === 0;
  }

  if (command === 'CAPTURE_PAGE_STATE') {
    const pageStatePayload = payload as PageStatePayload;
    return pageStatePayload.frameCaptureError === true
      || hasFrameCaptureError(pageStatePayload.frames)
      || isPageStateSummaryEmpty(pageStatePayload.summary);
  }

  return false;
}
