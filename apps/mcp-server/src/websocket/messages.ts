import { z } from 'zod';

export const EventTypeSchema = z.enum([
  'navigation',
  'console',
  'error',
  'network',
  'click',
  'custom',
]);

export const WebSocketMessageTypeSchema = z.enum([
  'ping',
  'pong',
  'event',
  'session_start',
  'session_end',
  'capture_command',
  'capture_result',
  'error',
]);

export const CaptureCommandSchema = z.enum([
  'CAPTURE_DOM_SUBTREE',
  'CAPTURE_DOM_DOCUMENT',
  'CAPTURE_COMPUTED_STYLES',
  'CAPTURE_LAYOUT_METRICS',
]);

export const BaseWebSocketMessageSchema = z.object({
  type: WebSocketMessageTypeSchema,
  timestamp: z.number().optional(),
});

export const PingMessageSchema = BaseWebSocketMessageSchema.extend({
  type: z.literal('ping'),
});

export const PongMessageSchema = BaseWebSocketMessageSchema.extend({
  type: z.literal('pong'),
});

export const EventMessageSchema = BaseWebSocketMessageSchema.extend({
  type: z.literal('event'),
  sessionId: z.string(),
  eventType: EventTypeSchema,
  data: z.record(z.string(), z.unknown()),
});

export const SessionStartMessageSchema = BaseWebSocketMessageSchema.extend({
  type: z.literal('session_start'),
  sessionId: z.string(),
  url: z.string(),
  tabId: z.number().optional(),
  windowId: z.number().optional(),
  userAgent: z.string().optional(),
  viewport: z.object({
    width: z.number(),
    height: z.number(),
  }).optional(),
  dpr: z.number().optional(),
  safeMode: z.boolean().optional().default(false),
});

export const SessionEndMessageSchema = BaseWebSocketMessageSchema.extend({
  type: z.literal('session_end'),
  sessionId: z.string(),
});

export const CaptureCommandMessageSchema = BaseWebSocketMessageSchema.extend({
  type: z.literal('capture_command'),
  commandId: z.string(),
  sessionId: z.string(),
  command: CaptureCommandSchema,
  payload: z.record(z.string(), z.unknown()).default({}),
  timeoutMs: z.number().int().min(100).max(30000).optional(),
});

export const CaptureResultMessageSchema = BaseWebSocketMessageSchema.extend({
  type: z.literal('capture_result'),
  commandId: z.string(),
  sessionId: z.string(),
  ok: z.boolean(),
  payload: z.record(z.string(), z.unknown()).optional(),
  truncated: z.boolean().optional(),
  error: z.string().optional(),
});

export const ErrorMessageSchema = BaseWebSocketMessageSchema.extend({
  type: z.literal('error'),
  error: z.string(),
  code: z.string().optional(),
});

export const WebSocketMessageSchema = z.discriminatedUnion('type', [
  PingMessageSchema,
  PongMessageSchema,
  EventMessageSchema,
  SessionStartMessageSchema,
  SessionEndMessageSchema,
  CaptureCommandMessageSchema,
  CaptureResultMessageSchema,
  ErrorMessageSchema,
]);

export type WebSocketMessage = z.infer<typeof WebSocketMessageSchema>;
export type PingMessage = z.infer<typeof PingMessageSchema>;
export type PongMessage = z.infer<typeof PongMessageSchema>;
export type EventMessage = z.infer<typeof EventMessageSchema>;
export type SessionStartMessage = z.infer<typeof SessionStartMessageSchema>;
export type SessionEndMessage = z.infer<typeof SessionEndMessageSchema>;
export type CaptureCommand = z.infer<typeof CaptureCommandSchema>;
export type CaptureCommandMessage = z.infer<typeof CaptureCommandMessageSchema>;
export type CaptureResultMessage = z.infer<typeof CaptureResultMessageSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;

export function parseMessage(data: string): WebSocketMessage | null {
  try {
    const parsed = JSON.parse(data);
    const result = WebSocketMessageSchema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }
    return null;
  } catch {
    return null;
  }
}

export function createPongMessage(): PongMessage {
  return {
    type: 'pong',
    timestamp: Date.now(),
  };
}

export function createErrorMessage(error: string, code?: string): ErrorMessage {
  return {
    type: 'error',
    error,
    code,
    timestamp: Date.now(),
  };
}

export function createCaptureCommandMessage(
  commandId: string,
  sessionId: string,
  command: CaptureCommand,
  payload: Record<string, unknown>,
  timeoutMs?: number,
): CaptureCommandMessage {
  return {
    type: 'capture_command',
    commandId,
    sessionId,
    command,
    payload,
    timeoutMs,
    timestamp: Date.now(),
  };
}
