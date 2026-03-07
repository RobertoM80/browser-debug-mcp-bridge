import { z } from 'zod';

export const LiveUIActionSchema = z.enum([
  'click',
  'input',
  'focus',
  'blur',
  'scroll',
  'press_key',
  'submit',
  'reload',
]);

export const LiveUIActionTargetSchema = z.object({
  selector: z.string().min(1).optional(),
  tabId: z.number().int().min(0).optional(),
  frameId: z.number().int().min(0).optional(),
  url: z.string().url().optional(),
});

const LiveUIActionBaseSchema = z.object({
  traceId: z.string().min(1).optional(),
  target: LiveUIActionTargetSchema.optional(),
});

export const LiveUIActionRequestSchema = z.discriminatedUnion('action', [
  LiveUIActionBaseSchema.extend({
    action: z.literal('click'),
    input: z.object({
      button: z.enum(['left', 'middle', 'right']).optional(),
      clickCount: z.number().int().min(1).max(3).optional(),
    }).optional(),
  }),
  LiveUIActionBaseSchema.extend({
    action: z.literal('input'),
    input: z.object({
      value: z.string(),
    }),
  }),
  LiveUIActionBaseSchema.extend({
    action: z.literal('focus'),
    input: z.object({}).optional(),
  }),
  LiveUIActionBaseSchema.extend({
    action: z.literal('blur'),
    input: z.object({}).optional(),
  }),
  LiveUIActionBaseSchema.extend({
    action: z.literal('scroll'),
    input: z.object({
      x: z.number().optional(),
      y: z.number().optional(),
      behavior: z.enum(['auto', 'smooth']).optional(),
    }).optional(),
  }),
  LiveUIActionBaseSchema.extend({
    action: z.literal('press_key'),
    input: z.object({
      key: z.string().min(1),
      altKey: z.boolean().optional(),
      ctrlKey: z.boolean().optional(),
      metaKey: z.boolean().optional(),
      shiftKey: z.boolean().optional(),
    }),
  }),
  LiveUIActionBaseSchema.extend({
    action: z.literal('submit'),
    input: z.object({}).optional(),
  }),
  LiveUIActionBaseSchema.extend({
    action: z.literal('reload'),
    input: z.object({
      ignoreCache: z.boolean().optional(),
    }).optional(),
  }),
]);

export const LiveUIActionFailureReasonSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

export const LiveUIActionTargetSummarySchema = z.object({
  matched: z.boolean(),
  selector: z.string().optional(),
  resolvedSelector: z.string().optional(),
  tagName: z.string().optional(),
  textPreview: z.string().optional(),
  tabId: z.number().int().min(0).optional(),
  frameId: z.number().int().min(0).default(0),
  url: z.string().optional(),
});

export const LiveUIActionResultSchema = z.object({
  action: LiveUIActionSchema,
  traceId: z.string().min(1),
  status: z.enum(['succeeded', 'rejected', 'failed']),
  executionScope: z.literal('top-document-v1'),
  startedAt: z.number().int().min(0),
  finishedAt: z.number().int().min(0),
  target: LiveUIActionTargetSummarySchema,
  failureReason: LiveUIActionFailureReasonSchema.optional(),
  result: z.record(z.string(), z.unknown()).optional(),
});

export type LiveUIAction = z.infer<typeof LiveUIActionSchema>;
export type LiveUIActionTarget = z.infer<typeof LiveUIActionTargetSchema>;
export type LiveUIActionRequest = z.infer<typeof LiveUIActionRequestSchema>;
export type LiveUIActionFailureReason = z.infer<typeof LiveUIActionFailureReasonSchema>;
export type LiveUIActionTargetSummary = z.infer<typeof LiveUIActionTargetSummarySchema>;
export type LiveUIActionResult = z.infer<typeof LiveUIActionResultSchema>;

export function createLiveUIActionTraceId(): string {
  return `uiaction-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
