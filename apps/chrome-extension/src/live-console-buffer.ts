export type LiveConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace';
export type LiveConsoleSource = 'console' | 'runtime_error';

export interface LiveConsoleEntry {
  timestamp: number;
  level: LiveConsoleLevel;
  message: string;
  args: unknown[];
  tabId: number | null;
  origin?: string;
  source: LiveConsoleSource;
}

export interface LiveConsoleAppendContext {
  tabId?: number;
  origin?: string;
  now?: number;
}

export interface LiveConsoleQuery {
  limit?: number;
  tabId?: number;
  origin?: string;
  levels?: string[];
  contains?: string;
  sinceTs?: number;
  includeRuntimeErrors?: boolean;
  dedupeWindowMs?: number;
}

export interface LiveConsoleQueryLogEntry extends LiveConsoleEntry {
  count?: number;
  firstTimestamp?: number;
  lastTimestamp?: number;
}

export interface LiveConsoleQueryResult {
  logs: LiveConsoleQueryLogEntry[];
  matched: number;
  buffered: number;
  dropped: number;
  truncated: boolean;
}

interface LiveConsoleStoreOptions {
  maxEntriesPerSession?: number;
  maxArgsPerEntry?: number;
  maxMessageChars?: number;
}

const DEFAULT_MAX_ENTRIES_PER_SESSION = 1500;
const DEFAULT_MAX_ARGS_PER_ENTRY = 25;
const DEFAULT_MAX_MESSAGE_CHARS = 2000;
const DEFAULT_QUERY_LIMIT = 100;
const MAX_QUERY_LIMIT = 500;

const ALLOWED_LEVELS: ReadonlySet<LiveConsoleLevel> = new Set(['log', 'info', 'warn', 'error', 'debug', 'trace']);

function resolveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.floor(value);
}

function clampLimit(value: unknown): number {
  const parsed = resolveInteger(value);
  if (parsed === undefined || parsed < 1) {
    return DEFAULT_QUERY_LIMIT;
  }

  return Math.min(parsed, MAX_QUERY_LIMIT);
}

function normalizeLevel(value: unknown): LiveConsoleLevel {
  if (typeof value !== 'string') {
    return 'log';
  }

  const normalized = value.trim().toLowerCase();
  return ALLOWED_LEVELS.has(normalized as LiveConsoleLevel) ? (normalized as LiveConsoleLevel) : 'log';
}

function normalizeLevelSet(value: unknown): Set<LiveConsoleLevel> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const levels = new Set<LiveConsoleLevel>();
  for (const candidate of value) {
    if (typeof candidate !== 'string') {
      continue;
    }

    const normalized = candidate.trim().toLowerCase();
    if (ALLOWED_LEVELS.has(normalized as LiveConsoleLevel)) {
      levels.add(normalized as LiveConsoleLevel);
    }
  }

  return levels.size > 0 ? levels : undefined;
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  const parsed = resolveInteger(value);
  if (parsed === undefined || parsed < 0) {
    return fallback;
  }

  return parsed;
}

function normalizeTabId(value: unknown): number | null {
  const parsed = resolveInteger(value);
  if (parsed === undefined || parsed < 0) {
    return null;
  }

  return parsed;
}

function normalizeContains(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function formatArgForMessage(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || value == null) {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeArgs(value: unknown, maxArgsPerEntry: number): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(0, maxArgsPerEntry);
}

function resolveConsoleMessage(data: Record<string, unknown>, args: unknown[], maxMessageChars: number): string {
  const fromMessage = typeof data.message === 'string' ? data.message : '';
  const fallback = args.map((entry) => formatArgForMessage(entry)).join(' ');
  const message = (fromMessage || fallback || 'console event').trim();

  if (message.length <= maxMessageChars) {
    return message;
  }

  return message.slice(0, maxMessageChars);
}

function resolveRuntimeErrorMessage(data: Record<string, unknown>, maxMessageChars: number): string {
  const message = typeof data.message === 'string' && data.message.trim().length > 0
    ? data.message.trim()
    : 'Runtime error';

  if (message.length <= maxMessageChars) {
    return message;
  }

  return message.slice(0, maxMessageChars);
}

function resolveSinceTimestamp(value: unknown): number | undefined {
  const parsed = resolveInteger(value);
  if (parsed === undefined || parsed < 0) {
    return undefined;
  }

  return parsed;
}

function resolveDedupeWindowMs(value: unknown): number {
  const parsed = resolveInteger(value);
  if (parsed === undefined || parsed < 1) {
    return 0;
  }

  return Math.min(parsed, 60_000);
}

function buildDedupeKey(entry: LiveConsoleEntry): string {
  return [
    entry.level,
    entry.message,
    entry.tabId ?? '',
    entry.origin ?? '',
    entry.source,
  ].join('\u0000');
}

function dedupeEntries(entries: LiveConsoleEntry[], dedupeWindowMs: number): LiveConsoleQueryLogEntry[] {
  if (dedupeWindowMs < 1 || entries.length === 0) {
    return entries;
  }

  interface DedupeCluster {
    key: string;
    base: LiveConsoleEntry;
    newestTs: number;
    oldestTs: number;
    count: number;
  }

  const clusters: LiveConsoleQueryLogEntry[] = [];
  let current: DedupeCluster | null = null;

  const flushCluster = () => {
    if (!current) {
      return;
    }

    if (current.count <= 1) {
      clusters.push(current.base);
    } else {
      clusters.push({
        ...current.base,
        count: current.count,
        firstTimestamp: current.oldestTs,
        lastTimestamp: current.newestTs,
      });
    }
  };

  for (const entry of entries) {
    const key = buildDedupeKey(entry);
    if (
      current
      && current.key === key
      && current.newestTs - entry.timestamp <= dedupeWindowMs
    ) {
      current.count += 1;
      current.oldestTs = entry.timestamp;
      continue;
    }

    flushCluster();
    current = {
      key,
      base: entry,
      newestTs: entry.timestamp,
      oldestTs: entry.timestamp,
      count: 1,
    };
  }

  flushCluster();
  return clusters;
}

export class LiveConsoleBufferStore {
  private readonly maxEntriesPerSession: number;
  private readonly maxArgsPerEntry: number;
  private readonly maxMessageChars: number;
  private readonly entriesBySession = new Map<string, LiveConsoleEntry[]>();
  private readonly droppedBySession = new Map<string, number>();

  constructor(options: LiveConsoleStoreOptions = {}) {
    this.maxEntriesPerSession = options.maxEntriesPerSession ?? DEFAULT_MAX_ENTRIES_PER_SESSION;
    this.maxArgsPerEntry = options.maxArgsPerEntry ?? DEFAULT_MAX_ARGS_PER_ENTRY;
    this.maxMessageChars = options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
  }

  append(
    sessionId: string,
    eventType: string,
    data: Record<string, unknown>,
    context: LiveConsoleAppendContext = {},
  ): boolean {
    const entry = this.buildEntry(eventType, data, context);
    if (!entry) {
      return false;
    }

    const entries = this.entriesBySession.get(sessionId) ?? [];
    entries.push(entry);

    if (entries.length > this.maxEntriesPerSession) {
      entries.shift();
      const dropped = this.droppedBySession.get(sessionId) ?? 0;
      this.droppedBySession.set(sessionId, dropped + 1);
    }

    this.entriesBySession.set(sessionId, entries);
    return true;
  }

  query(sessionId: string, query: LiveConsoleQuery = {}): LiveConsoleQueryResult {
    const entries = this.entriesBySession.get(sessionId) ?? [];
    const levels = normalizeLevelSet(query.levels);
    const contains = normalizeContains(query.contains);
    const origin = normalizeOrigin(query.origin);
    const tabId = normalizeTabId(query.tabId);
    const sinceTs = resolveSinceTimestamp(query.sinceTs);
    const includeRuntimeErrors = query.includeRuntimeErrors !== false;
    const dedupeWindowMs = resolveDedupeWindowMs(query.dedupeWindowMs);
    const limit = clampLimit(query.limit);

    const filtered = entries.filter((entry) => {
      if (!includeRuntimeErrors && entry.source === 'runtime_error') {
        return false;
      }

      if (tabId !== null && entry.tabId !== tabId) {
        return false;
      }

      if (origin && entry.origin !== origin) {
        return false;
      }

      if (sinceTs !== undefined && entry.timestamp < sinceTs) {
        return false;
      }

      if (levels && !levels.has(entry.level)) {
        return false;
      }

      if (contains && !entry.message.toLowerCase().includes(contains)) {
        return false;
      }

      return true;
    });

    const sorted = filtered.slice().sort((a, b) => b.timestamp - a.timestamp);
    const deduped = dedupeEntries(sorted, dedupeWindowMs);
    const logs = deduped.slice(0, limit);

    return {
      logs,
      matched: deduped.length,
      buffered: entries.length,
      dropped: this.droppedBySession.get(sessionId) ?? 0,
      truncated: deduped.length > limit,
    };
  }

  clearSession(sessionId: string): void {
    this.entriesBySession.delete(sessionId);
    this.droppedBySession.delete(sessionId);
  }

  private buildEntry(
    eventType: string,
    data: Record<string, unknown>,
    context: LiveConsoleAppendContext,
  ): LiveConsoleEntry | null {
    const now = context.now ?? Date.now();
    const timestamp = normalizeTimestamp(data.timestamp, now);
    const tabId = normalizeTabId(context.tabId);
    const origin = normalizeOrigin(context.origin);

    if (eventType === 'console') {
      const args = normalizeArgs(data.args, this.maxArgsPerEntry);
      return {
        timestamp,
        level: normalizeLevel(data.level),
        message: resolveConsoleMessage(data, args, this.maxMessageChars),
        args,
        tabId,
        origin,
        source: 'console',
      };
    }

    if (eventType === 'error') {
      return {
        timestamp,
        level: 'error',
        message: resolveRuntimeErrorMessage(data, this.maxMessageChars),
        args: [],
        tabId,
        origin,
        source: 'runtime_error',
      };
    }

    return null;
  }
}
