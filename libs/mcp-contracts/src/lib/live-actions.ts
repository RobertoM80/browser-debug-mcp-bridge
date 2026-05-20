import { z } from 'zod';

export const LiveUIActionSchema = z.enum([
  'click',
  'hover',
  'input',
  'focus',
  'blur',
  'scroll',
  'press_key',
  'submit',
  'reload',
]);

export const LiveUIActionLocatorMatcherSchema = z.union([
  z.string().min(1),
  z.object({
    pattern: z.string().min(1),
    flags: z.string().regex(/^[imsu]*$/).optional(),
  }),
]);

export const LiveUIActionLocatorStepSchema = z.object({
  kind: z.enum(['css', 'role', 'text', 'label', 'testId', 'placeholder', 'altText']),
  value: LiveUIActionLocatorMatcherSchema.optional(),
  role: z.string().min(1).optional(),
  name: LiveUIActionLocatorMatcherSchema.optional(),
  exact: z.boolean().optional(),
  relation: z.enum(['filter', 'descendant', 'ancestor']).optional(),
}).superRefine((value, ctx) => {
  if (value.kind === 'role' && !value.role && !value.value) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'role locator step requires role or value',
      path: ['role'],
    });
  }

  if (value.kind !== 'role' && !value.value) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${value.kind} locator step requires value`,
      path: ['value'],
    });
  }
});

export const LiveUIActionLocatorSchema = z.object({
  scope: z.enum(['buttons', 'links', 'inputs', 'modals', 'focused']).optional(),
  frame: z.object({
    selector: z.string().min(1).optional(),
    urlContains: z.string().min(1).optional(),
    titleContains: z.string().min(1).optional(),
  }).optional(),
  steps: z.array(LiveUIActionLocatorStepSchema).min(1).max(8),
});

export const LiveUIActionCoordinateTargetSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  frameId: z.number().int().min(0).optional(),
});

export const LiveUIActionTargetSchema = z.object({
  selector: z.string().min(1).optional(),
  elementRef: z.string().min(1).optional(),
  coordinates: LiveUIActionCoordinateTargetSchema.optional(),
  tabId: z.number().int().min(0).optional(),
  frameId: z.number().int().min(0).optional(),
  url: z.string().url().optional(),
  locator: LiveUIActionLocatorSchema.optional(),
  frameUrlContains: z.string().min(1).optional(),
  frameTitleContains: z.string().min(1).optional(),
  testId: z.string().min(1).optional(),
  scope: z.enum(['buttons', 'links', 'inputs', 'modals', 'focused']).optional(),
  textContains: z.string().min(1).optional(),
  labelContains: z.string().min(1).optional(),
  titleContains: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  placeholder: z.string().min(1).optional(),
  altText: z.string().min(1).optional(),
  tagName: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  exact: z.boolean().optional(),
  nth: z.number().int().min(0).optional(),
  first: z.boolean().optional(),
  last: z.boolean().optional(),
  strict: z.boolean().optional(),
  visible: z.boolean().optional(),
  disabled: z.boolean().optional(),
  selected: z.boolean().optional(),
  pressed: z.boolean().optional(),
  expanded: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  requiredField: z.boolean().optional(),
}).superRefine((value, ctx) => {
  const positionFields = [value.nth !== undefined, value.first === true, value.last === true].filter(Boolean).length;
  if (positionFields > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'target can use only one of nth, first, or last',
      path: ['target'],
    });
  }
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
    action: z.literal('hover'),
    input: z.object({}).optional(),
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
export type LiveUIActionLocatorMatcher = z.infer<typeof LiveUIActionLocatorMatcherSchema>;
export type LiveUIActionLocatorStep = z.infer<typeof LiveUIActionLocatorStepSchema>;
export type LiveUIActionLocator = z.infer<typeof LiveUIActionLocatorSchema>;
export type LiveUIActionCoordinateTarget = z.infer<typeof LiveUIActionCoordinateTargetSchema>;
export type LiveUIActionTarget = z.infer<typeof LiveUIActionTargetSchema>;
export type LiveUIActionRequest = z.infer<typeof LiveUIActionRequestSchema>;
export type LiveUIActionFailureReason = z.infer<typeof LiveUIActionFailureReasonSchema>;
export type LiveUIActionTargetSummary = z.infer<typeof LiveUIActionTargetSummarySchema>;
export type LiveUIActionResult = z.infer<typeof LiveUIActionResultSchema>;

export function createLiveUIActionTraceId(): string {
  return `uiaction-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
