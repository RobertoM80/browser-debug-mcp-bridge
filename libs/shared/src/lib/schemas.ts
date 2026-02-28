import { z } from 'zod';

export const SessionSchema = z.object({
  id: z.string(),
  url: z.string(),
  startedAt: z.date(),
  endedAt: z.date().optional(),
  status: z.enum(['active', 'closed']),
});

export const EventTypeSchema = z.enum([
  'navigation',
  'console',
  'error',
  'network',
  'click',
  'scroll',
  'input',
  'change',
  'submit',
  'focus',
  'blur',
  'keydown',
  'custom',
]);

export const NetworkErrorTypeSchema = z.enum([
  'timeout',
  'cors',
  'dns',
  'blocked',
  'http_error',
]);

export const EventSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  type: EventTypeSchema,
  timestamp: z.date(),
  data: z.record(z.string(), z.unknown()),
});

export const NetworkEventSchema = EventSchema.extend({
  type: z.literal('network'),
  data: z.object({
    method: z.string(),
    url: z.string(),
    status: z.number(),
    duration: z.number(),
    errorType: NetworkErrorTypeSchema.optional(),
  }),
});

export const ConsoleEventSchema = EventSchema.extend({
  type: z.literal('console'),
  data: z.object({
    level: z.enum(['log', 'info', 'warn', 'error', 'debug', 'trace']),
    message: z.string(),
    args: z.array(z.unknown()).optional(),
  }),
});

export const ErrorEventSchema = EventSchema.extend({
  type: z.literal('error'),
  data: z.object({
    message: z.string(),
    stack: z.string().optional(),
    filename: z.string().optional(),
    line: z.number().optional(),
    column: z.number().optional(),
    fingerprint: z.string().optional(),
  }),
});

export const NavigationEventSchema = EventSchema.extend({
  type: z.literal('navigation'),
  data: z.object({
    from: z.string().optional(),
    to: z.string(),
    timestamp: z.number(),
  }),
});

export const ClickEventSchema = EventSchema.extend({
  type: z.literal('click'),
  data: z.object({
    selector: z.string(),
    timestamp: z.number(),
  }),
});

export const ScrollEventSchema = EventSchema.extend({
  type: z.literal('scroll'),
  data: z.object({
    selector: z.string(),
    scrollX: z.number(),
    scrollY: z.number(),
    deltaX: z.number().optional(),
    deltaY: z.number().optional(),
    timestamp: z.number(),
  }),
});

export const InputEventSchema = EventSchema.extend({
  type: z.literal('input'),
  data: z.object({
    selector: z.string(),
    fieldType: z.string(),
    valueLength: z.number(),
    timestamp: z.number(),
  }),
});
