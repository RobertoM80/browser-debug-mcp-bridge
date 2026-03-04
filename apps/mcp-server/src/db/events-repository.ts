import { Database } from 'better-sqlite3';
import type { EventMessage, SessionStartMessage, SessionEndMessage } from '../websocket/messages.js';
import { resolveErrorFingerprint } from './error-fingerprints.js';
import { getDatabasePath } from './connection.js';
import { writeSnapshot } from '../retention.js';

const INLINE_BODY_BYTES_THRESHOLD = 16 * 1024;
const BODY_KIND_REQUEST = 'request';
const BODY_KIND_RESPONSE = 'response';
const SENSITIVE_FIELD_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'access-token',
  'refresh-token',
  'token',
  'password',
  'secret',
  'client_secret',
]);
const REDACTION_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /(Authorization:\s*Bearer\s+)[\w\-\.=]+/gi, replacement: '$1[REDACTED]' },
  { pattern: /eyJ[\w-]*\.eyJ[\w-]*\.[\w-]*/g, replacement: '[JWT_TOKEN]' },
  { pattern: /((?:api[_-]?key|apikey)\s*[:=]\s*)[\w-]+/gi, replacement: '$1[API_KEY]' },
  { pattern: /((?:access[_-]?token|refresh[_-]?token|token)\s*[:=]\s*)[^\s,;]+/gi, replacement: '$1[TOKEN]' },
  { pattern: /((?:password|pwd)\s*[:=]\s*)\S+/gi, replacement: '$1[PASSWORD]' },
];

export interface SessionRecord {
  sessionId: string;
  createdAt: number;
  endedAt?: number;
  tabId?: number;
  windowId?: number;
  urlStart?: string;
  urlLast?: string;
  userAgent?: string;
  viewportW?: number;
  viewportH?: number;
  dpr?: number;
  safeMode: boolean;
  allowlistHash?: string;
}

export interface EventRecord {
  eventId: string;
  sessionId: string;
  timestamp: number;
  type: string;
  payload: Record<string, unknown>;
  tabId?: number;
  origin?: string;
}

interface ProcessedNetworkBody {
  contentType: string | null;
  bodyText: string | null;
  bodyJson: string | null;
  bodyBytes: number | null;
  truncated: boolean;
  chunkRef: string | null;
}

interface NetworkEventInsertInput {
  requestId: string;
  traceId: string | null;
  tabId: number | null;
  tsStart: number;
  durationMs: number | null;
  method: string;
  url: string;
  origin: string | null;
  status: number | null;
  initiator: string;
  errorClass: string | null;
  responseSizeEst: number | null;
  request: ProcessedNetworkBody;
  response: ProcessedNetworkBody;
}

export class EventsRepository {
  constructor(private db: Database) {}

  insertEventsBatch(messages: EventMessage[]): void {
    if (messages.length === 0) {
      return;
    }

    const insert = this.db.prepare(`
      INSERT INTO events (event_id, session_id, ts, type, payload_json, tab_id, origin)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertNetwork = this.db.prepare(`
      INSERT INTO network (
        request_id, session_id, trace_id, tab_id, ts_start, duration_ms, method, url, origin, status, initiator, error_class, response_size_est,
        request_content_type, request_body_text, request_body_json, request_body_bytes, request_body_truncated, request_body_chunk_ref,
        response_content_type, response_body_text, response_body_json, response_body_bytes, response_body_truncated, response_body_chunk_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertBodyChunk = this.db.prepare(`
      INSERT INTO body_chunks (
        chunk_ref, session_id, request_id, trace_id, body_kind, content_type, body_text, body_bytes, truncated, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const upsertFingerprint = this.db.prepare(`
      INSERT INTO error_fingerprints (
        fingerprint, session_id, count, sample_message, sample_stack, first_seen_at, last_seen_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(fingerprint) DO UPDATE SET
        count = count + 1,
        last_seen_at = excluded.last_seen_at,
        sample_message = COALESCE(error_fingerprints.sample_message, excluded.sample_message),
        sample_stack = COALESCE(error_fingerprints.sample_stack, excluded.sample_stack)
    `);

    const runBatch = this.db.transaction((batch: EventMessage[]) => {
      for (const message of batch) {
        const eventId = `${message.sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
        const dbEventType = this.mapEventType(message.eventType);
        const sanitizedData =
          message.eventType === 'network'
            ? sanitizeRecord(message.data)
            : message.data;
        const eventTabId =
          typeof message.tabId === 'number' && Number.isFinite(message.tabId)
            ? Math.floor(message.tabId)
            : this.resolveTabIdFromPayload(sanitizedData);
        const eventOrigin = this.resolveEventOrigin(sanitizedData, message.origin);

        insert.run(
          eventId,
          message.sessionId,
          message.timestamp ?? Date.now(),
          dbEventType,
          JSON.stringify(sanitizedData),
          eventTabId,
          eventOrigin,
        );

        if (message.eventType === 'error') {
          this.upsertErrorFingerprintPrepared(upsertFingerprint, message.sessionId, sanitizedData);
        }

        if (message.eventType === 'network') {
          this.insertNetworkEventPrepared(
            insertNetwork,
            insertBodyChunk,
            message.sessionId,
            sanitizedData,
            eventOrigin,
            eventTabId,
          );
        }

        if (message.eventType === 'ui_snapshot') {
          this.insertSnapshotPrepared(message.sessionId, eventId, sanitizedData);
        }
      }
    });

    runBatch(messages);
  }

  createSession(message: SessionStartMessage): void {
    const insert = this.db.prepare(`
      INSERT INTO sessions (
        session_id, created_at, tab_id, window_id, url_start, url_last,
        user_agent, viewport_w, viewport_h, dpr, safe_mode, allowlist_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = Date.now();
    insert.run(
      message.sessionId,
      now,
      message.tabId ?? null,
      message.windowId ?? null,
      message.url,
      message.url,
      message.userAgent ?? null,
      message.viewport?.width ?? null,
      message.viewport?.height ?? null,
      message.dpr ?? null,
      message.safeMode ? 1 : 0,
      null
    );
  }

  endSession(message: SessionEndMessage): void {
    const update = this.db.prepare(`
      UPDATE sessions
      SET ended_at = ?
      WHERE session_id = ?
    `);

    update.run(Date.now(), message.sessionId);
  }

  insertEvent(message: EventMessage): void {
    this.insertEventsBatch([message]);
  }

  private mapEventType(eventType: string): string {
    const mapping: Record<string, string> = {
      navigation: 'nav',
      console: 'console',
      error: 'error',
      network: 'network',
      click: 'ui',
      scroll: 'ui',
      input: 'ui',
      change: 'ui',
      submit: 'ui',
      focus: 'ui',
      blur: 'ui',
      keydown: 'ui',
      ui_snapshot: 'ui',
      custom: 'ui',
    };
    return mapping[eventType] || 'ui';
  }

  private upsertErrorFingerprintPrepared(
    statement: ReturnType<Database['prepare']>,
    sessionId: string,
    data: Record<string, unknown>
  ): void {
    const fingerprint = resolveErrorFingerprint(data);
    if (!fingerprint) return;

    const now = Date.now();
    (statement as { run: (...params: unknown[]) => unknown }).run(
      fingerprint,
      sessionId,
      (data.message as string) ?? 'Unknown error',
      (data.stack as string) ?? null,
      now,
      now
    );
  }

  private insertNetworkEventPrepared(
    networkStatement: ReturnType<Database['prepare']>,
    bodyChunkStatement: ReturnType<Database['prepare']>,
    sessionId: string,
    data: Record<string, unknown>,
    eventOrigin: string | null,
    eventTabId: number | null,
  ): void {
    const normalized = this.normalizeNetworkInsertInput(sessionId, data, eventOrigin, eventTabId, bodyChunkStatement);
    (networkStatement as { run: (...params: unknown[]) => unknown }).run(
      normalized.requestId,
      sessionId,
      normalized.traceId,
      normalized.tabId,
      normalized.tsStart,
      normalized.durationMs,
      normalized.method,
      normalized.url,
      normalized.origin,
      normalized.status,
      normalized.initiator,
      normalized.errorClass,
      normalized.responseSizeEst,
      normalized.request.contentType,
      normalized.request.bodyText,
      normalized.request.bodyJson,
      normalized.request.bodyBytes,
      normalized.request.truncated ? 1 : 0,
      normalized.request.chunkRef,
      normalized.response.contentType,
      normalized.response.bodyText,
      normalized.response.bodyJson,
      normalized.response.bodyBytes,
      normalized.response.truncated ? 1 : 0,
      normalized.response.chunkRef,
    );
  }

  private normalizeNetworkInsertInput(
    sessionId: string,
    data: Record<string, unknown>,
    eventOrigin: string | null,
    eventTabId: number | null,
    bodyChunkStatement: ReturnType<Database['prepare']>,
  ): NetworkEventInsertInput {
    const requestId = toNonEmptyString(data.requestId)
      ?? `${sessionId}-net-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const traceId = toNonEmptyString(data.traceId) ?? null;
    const url = toNonEmptyString(data.url) ?? '';
    const origin = eventOrigin ?? normalizeOriginCandidate(url);

    const request = this.processNetworkBody({
      sessionId,
      requestId,
      traceId,
      bodyKind: BODY_KIND_REQUEST,
      contentType: toNullableContentType(data.requestContentType),
      bodyText: toNonEmptyString(data.requestBodyText),
      bodyJson: toRecordLike(data.requestBodyJson),
      bodyBytes: toNullableInteger(data.requestBodyBytes),
      truncated: data.requestBodyTruncated === true,
      bodyChunkStatement,
    });

    const response = this.processNetworkBody({
      sessionId,
      requestId,
      traceId,
      bodyKind: BODY_KIND_RESPONSE,
      contentType: toNullableContentType(data.responseContentType),
      bodyText: toNonEmptyString(data.responseBodyText),
      bodyJson: toRecordLike(data.responseBodyJson),
      bodyBytes: toNullableInteger(data.responseBodyBytes),
      truncated: data.responseBodyTruncated === true,
      bodyChunkStatement,
    });

    return {
      requestId,
      traceId,
      tabId: eventTabId,
      tsStart: toNullableInteger(data.timestamp) ?? Date.now(),
      durationMs: toNullableInteger(data.duration),
      method: normalizeMethod(toNonEmptyString(data.method)),
      url,
      origin,
      status: toNullableInteger(data.status),
      initiator: normalizeInitiator(toNonEmptyString(data.initiator)),
      errorClass: normalizeErrorClass(toNonEmptyString(data.errorType)),
      responseSizeEst: toNullableInteger(data.responseSize),
      request,
      response,
    };
  }

  private processNetworkBody(params: {
    sessionId: string;
    requestId: string;
    traceId: string | null;
    bodyKind: typeof BODY_KIND_REQUEST | typeof BODY_KIND_RESPONSE;
    contentType: string | null;
    bodyText: string | null;
    bodyJson: Record<string, unknown> | null;
    bodyBytes: number | null;
    truncated: boolean;
    bodyChunkStatement: ReturnType<Database['prepare']>;
  }): ProcessedNetworkBody {
    const redactedJson = params.bodyJson ? sanitizeRecord(params.bodyJson) : null;
    const redactedText = params.bodyText ? redactString(params.bodyText) : null;
    const resolvedText = redactedText
      ?? (redactedJson ? JSON.stringify(redactedJson) : null);
    const resolvedBytes = resolvedText ? utf8Bytes(resolvedText) : params.bodyBytes;
    const resolvedJsonText = redactedJson ? JSON.stringify(redactedJson) : null;

    if (!resolvedText && !resolvedJsonText && resolvedBytes === null) {
      return {
        contentType: params.contentType,
        bodyText: null,
        bodyJson: null,
        bodyBytes: null,
        truncated: params.truncated,
        chunkRef: null,
      };
    }

    if (resolvedText && resolvedBytes !== null && resolvedBytes > INLINE_BODY_BYTES_THRESHOLD) {
      const chunkRef = `${params.requestId}:${params.bodyKind}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      (params.bodyChunkStatement as { run: (...args: unknown[]) => unknown }).run(
        chunkRef,
        params.sessionId,
        params.requestId,
        params.traceId,
        params.bodyKind,
        params.contentType,
        resolvedText,
        resolvedBytes,
        params.truncated ? 1 : 0,
        Date.now(),
      );
      return {
        contentType: params.contentType,
        bodyText: null,
        bodyJson: null,
        bodyBytes: resolvedBytes,
        truncated: params.truncated,
        chunkRef,
      };
    }

    return {
      contentType: params.contentType,
      bodyText: resolvedText,
      bodyJson: resolvedJsonText,
      bodyBytes: resolvedBytes,
      truncated: params.truncated,
      chunkRef: null,
    };
  }

  private insertSnapshotPrepared(
    sessionId: string,
    triggerEventId: string,
    data: Record<string, unknown>
  ): void {
    writeSnapshot(
      this.db,
      getDatabasePath(),
      sessionId,
      data,
      triggerEventId,
    );
  }

  private resolveTabIdFromPayload(payload: Record<string, unknown>): number | null {
    const candidate = payload.tabId;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return Math.floor(candidate);
    }
    return null;
  }

  private resolveEventOrigin(payload: Record<string, unknown>, fallback?: string): string | null {
    const candidates: unknown[] = [fallback, payload.origin, payload.url, payload.to, payload.href, payload.location];
    for (const candidate of candidates) {
      const origin = normalizeOriginCandidate(candidate);
      if (origin) {
        return origin;
      }
    }
    return null;
  }

  sessionExists(sessionId: string): boolean {
    const result = this.db.prepare('SELECT 1 FROM sessions WHERE session_id = ?').get(sessionId);
    return !!result;
  }
}

function normalizeOriginCandidate(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toNullableInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.floor(value);
}

function toNullableContentType(value: unknown): string | null {
  const normalized = toNonEmptyString(value);
  if (!normalized) {
    return null;
  }
  return normalized.toLowerCase();
}

function toRecordLike(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf-8');
}

function normalizeMethod(value: string | null): string {
  return value ? value.toUpperCase() : 'GET';
}

function normalizeInitiator(value: string | null): string {
  if (!value) {
    return 'other';
  }
  const normalized = value.toLowerCase();
  if (normalized === 'fetch' || normalized === 'xhr' || normalized === 'img' || normalized === 'script' || normalized === 'other') {
    return normalized;
  }
  return 'other';
}

function normalizeErrorClass(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.toLowerCase();
  if (normalized === 'timeout' || normalized === 'cors' || normalized === 'dns' || normalized === 'blocked' || normalized === 'http_error' || normalized === 'unknown') {
    return normalized;
  }
  return 'unknown';
}

function sanitizeRecord(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizeValue(value, 'root') as Record<string, unknown>;
}

function sanitizeValue(value: unknown, key: string): unknown {
  if (typeof value === 'string') {
    if (SENSITIVE_FIELD_NAMES.has(key.toLowerCase())) {
      return '[REDACTED]';
    }
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, key));
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      result[entryKey] = sanitizeValue(entryValue, entryKey);
    }
    return result;
  }

  return value;
}

function redactString(value: string): string {
  let result = value;
  for (const rule of REDACTION_PATTERNS) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}
