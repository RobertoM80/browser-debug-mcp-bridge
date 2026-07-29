export type GenericCaptureCommand =
  | 'CAPTURE_DOM_SUBTREE'
  | 'CAPTURE_DOM_DOCUMENT'
  | 'CAPTURE_PAGE_STATE';

export type CaptureFrameCandidate = {
  frameId: number;
  url?: string;
};

export type CaptureFrameTarget = {
  frameId?: unknown;
  frameUrlContains?: unknown;
};

type CaptureTabPreferenceOptions = {
  activeTabId?: number;
  rememberedTabId?: number;
  allowedTabIds?: number[];
  allowActiveTab?: boolean;
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

export function hasExplicitCaptureFrameTarget(target: CaptureFrameTarget): boolean {
  return target.frameId !== undefined || target.frameUrlContains !== undefined;
}

export function resolveCaptureFrameTarget<T extends CaptureFrameCandidate>(
  frames: T[],
  target: CaptureFrameTarget,
): T {
  let frameId: number | undefined;
  if (target.frameId !== undefined) {
    if (typeof target.frameId !== 'number' || !Number.isInteger(target.frameId) || target.frameId < 0) {
      throw new Error('frameId must be a non-negative integer');
    }
    frameId = target.frameId;
  }

  let frameUrlContains: string | undefined;
  if (target.frameUrlContains !== undefined) {
    if (typeof target.frameUrlContains !== 'string' || target.frameUrlContains.trim().length === 0) {
      throw new Error('frameUrlContains must be a non-empty string');
    }
    frameUrlContains = target.frameUrlContains.trim();
  }

  if (!frameUrlContains) {
    const frame = frameId === undefined
      ? frames.find((candidate) => candidate.frameId === 0)
      : frames.find((candidate) => candidate.frameId === frameId);
    if (!frame) {
      throw new Error(frameId === undefined ? 'No top frame found' : `No frame found for frameId ${frameId}`);
    }
    return frame;
  }

  const normalizedUrl = frameUrlContains.toLowerCase();
  const candidates = frameId === undefined
    ? frames
    : frames.filter((frame) => frame.frameId === frameId);
  if (frameId !== undefined && candidates.length === 0) {
    throw new Error(`No frame found for frameId ${frameId}`);
  }

  const matches = candidates.filter((frame) => frame.url?.toLowerCase().includes(normalizedUrl));
  if (frameId !== undefined) {
    if (matches.length === 0) {
      throw new Error(`frameId ${frameId} does not match frameUrlContains "${frameUrlContains}"`);
    }
    return matches[0];
  }

  if (matches.length === 0) {
    throw new Error(`No frame matches frameUrlContains "${frameUrlContains}"`);
  }
  if (matches.length > 1) {
    const frameIds = matches.map((frame) => frame.frameId).join(', ');
    throw new Error(
      `frameUrlContains "${frameUrlContains}" matched ${matches.length} frames (${frameIds}); specify frameId`,
    );
  }

  return matches[0];
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

  if (options.allowActiveTab !== false) {
    push(options.activeTabId);
  }
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
