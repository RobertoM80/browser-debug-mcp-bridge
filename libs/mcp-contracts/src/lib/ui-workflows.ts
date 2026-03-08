import { z } from 'zod';

export const UIWorkflowModeSchema = z.enum(['safe', 'fast']);
export const UIWorkflowFailureStrategySchema = z.enum(['stop', 'continue', 'retry_once']);

export const UIWorkflowActionTargetScopeSchema = z.enum(['buttons', 'inputs', 'modals', 'focused']);

export const UIWorkflowActionTargetSchema = z.object({
  selector: z.string().min(1).optional(),
  elementRef: z.string().min(1).optional(),
  tabId: z.number().int().min(0).optional(),
  frameId: z.number().int().min(0).optional(),
  url: z.string().url().optional(),
  testId: z.string().min(1).optional(),
  scope: UIWorkflowActionTargetScopeSchema.optional(),
  textContains: z.string().min(1).optional(),
  labelContains: z.string().min(1).optional(),
  titleContains: z.string().min(1).optional(),
  tagName: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  disabled: z.boolean().optional(),
  selected: z.boolean().optional(),
  pressed: z.boolean().optional(),
  expanded: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  requiredField: z.boolean().optional(),
}).superRefine((value, ctx) => {
  if (
    !value.selector
    && !value.elementRef
    && !value.testId
    && !value.textContains
    && !value.labelContains
    && !value.titleContains
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'target requires selector, elementRef, testId, textContains, labelContains, or titleContains',
      path: ['target'],
    });
  }
});

export const UIWorkflowFailureCaptureSchema = z.object({
  enabled: z.boolean().optional(),
  selector: z.string().min(1).optional(),
  mode: z.enum(['dom', 'png', 'both']).optional(),
  styleMode: z.enum(['computed-lite', 'computed-full']).optional(),
  maxDepth: z.number().int().min(1).max(10).optional(),
  maxBytes: z.number().int().min(1_000).max(200_000).optional(),
  maxAncestors: z.number().int().min(0).max(10).optional(),
  includeDom: z.boolean().optional(),
  includeStyles: z.boolean().optional(),
  includePngDataUrl: z.boolean().optional(),
});

export const UIWorkflowFailurePolicySchema = z.object({
  strategy: UIWorkflowFailureStrategySchema.optional(),
  capture: UIWorkflowFailureCaptureSchema.optional(),
});

const UIWorkflowStepBaseSchema = z.object({
  id: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
  onFailure: UIWorkflowFailurePolicySchema.optional(),
});

const UIWorkflowActionBaseSchema = UIWorkflowStepBaseSchema.extend({
  kind: z.literal('action'),
  traceId: z.string().min(1).optional(),
  target: UIWorkflowActionTargetSchema.optional(),
});

export const UIWorkflowActionStepSchema = z.discriminatedUnion('action', [
  UIWorkflowActionBaseSchema.extend({
    action: z.literal('click'),
    input: z.object({
      button: z.enum(['left', 'middle', 'right']).optional(),
      clickCount: z.number().int().min(1).max(3).optional(),
    }).optional(),
  }),
  UIWorkflowActionBaseSchema.extend({
    action: z.literal('input'),
    input: z.object({
      value: z.string(),
    }),
  }),
  UIWorkflowActionBaseSchema.extend({
    action: z.literal('focus'),
    input: z.object({}).optional(),
  }),
  UIWorkflowActionBaseSchema.extend({
    action: z.literal('blur'),
    input: z.object({}).optional(),
  }),
  UIWorkflowActionBaseSchema.extend({
    action: z.literal('scroll'),
    input: z.object({
      x: z.number().optional(),
      y: z.number().optional(),
      behavior: z.enum(['auto', 'smooth']).optional(),
    }).optional(),
  }),
  UIWorkflowActionBaseSchema.extend({
    action: z.literal('press_key'),
    input: z.object({
      key: z.string().min(1),
      altKey: z.boolean().optional(),
      ctrlKey: z.boolean().optional(),
      metaKey: z.boolean().optional(),
      shiftKey: z.boolean().optional(),
    }),
  }),
  UIWorkflowActionBaseSchema.extend({
    action: z.literal('submit'),
    input: z.object({}).optional(),
  }),
  UIWorkflowActionBaseSchema.extend({
    action: z.literal('reload'),
    input: z.object({
      ignoreCache: z.boolean().optional(),
    }).optional(),
  }),
]);

export const UIWorkflowPageStateMatcherSchema = z.object({
  scope: z.enum(['buttons', 'inputs', 'modals', 'focused', 'page']),
  selector: z.string().optional(),
  testId: z.string().optional(),
  textContains: z.string().optional(),
  labelContains: z.string().optional(),
  titleContains: z.string().optional(),
  urlContains: z.string().optional(),
  language: z.string().optional(),
  disabled: z.boolean().optional(),
  selected: z.boolean().optional(),
  pressed: z.boolean().optional(),
  expanded: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  requiredField: z.boolean().optional(),
  tagName: z.string().optional(),
  type: z.string().optional(),
  countExactly: z.number().int().min(0).optional(),
  countAtLeast: z.number().int().min(0).optional(),
  maxItems: z.number().int().min(1).max(100).optional(),
  maxTextLength: z.number().int().min(8).max(200).optional(),
}).superRefine((value, ctx) => {
  if (value.countExactly !== undefined && value.countAtLeast !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'countExactly and countAtLeast cannot both be set',
      path: ['countExactly'],
    });
  }
});

export const UIWorkflowWaitForStepSchema = UIWorkflowStepBaseSchema.extend({
  kind: z.literal('waitFor'),
  matcher: UIWorkflowPageStateMatcherSchema.extend({
    timeoutMs: z.number().int().min(100).max(30000).optional(),
    pollIntervalMs: z.number().int().min(50).max(2000).optional(),
  }),
});

export const UIWorkflowAssertStepSchema = UIWorkflowStepBaseSchema.extend({
  kind: z.literal('assert'),
  matcher: UIWorkflowPageStateMatcherSchema,
});

export const UIWorkflowStepSchema = z.discriminatedUnion('kind', [
  UIWorkflowActionStepSchema,
  UIWorkflowWaitForStepSchema,
  UIWorkflowAssertStepSchema,
]);

export const RunUIStepsSchema = z.object({
  sessionId: z.string().min(1).describe('Connected session identifier'),
  mode: UIWorkflowModeSchema.default('safe')
    .describe('safe favors fuller verification; fast reuses cached state and lighter summaries'),
  stopOnFailure: z.boolean().default(true)
    .describe('Stop immediately on the first failed step'),
  defaultTimeoutMs: z.number().int().min(100).max(30000).optional()
    .describe('Default timeout for wait steps that omit timeoutMs'),
  defaultPollIntervalMs: z.number().int().min(50).max(2000).optional()
    .describe('Default poll interval for wait steps that omit pollIntervalMs'),
  steps: z.array(UIWorkflowStepSchema).min(1).max(50)
    .describe('Sequential workflow steps'),
});

export type UIWorkflowMode = z.infer<typeof UIWorkflowModeSchema>;
export type UIWorkflowFailureStrategy = z.infer<typeof UIWorkflowFailureStrategySchema>;
export type UIWorkflowFailureCapture = z.infer<typeof UIWorkflowFailureCaptureSchema>;
export type UIWorkflowFailurePolicy = z.infer<typeof UIWorkflowFailurePolicySchema>;
export type UIWorkflowActionTarget = z.infer<typeof UIWorkflowActionTargetSchema>;
export type UIWorkflowActionStep = z.infer<typeof UIWorkflowActionStepSchema>;
export type UIWorkflowPageStateMatcher = z.infer<typeof UIWorkflowPageStateMatcherSchema>;
export type UIWorkflowWaitForStep = z.infer<typeof UIWorkflowWaitForStepSchema>;
export type UIWorkflowAssertStep = z.infer<typeof UIWorkflowAssertStepSchema>;
export type UIWorkflowStep = z.infer<typeof UIWorkflowStepSchema>;
export type RunUIStepsRequest = z.infer<typeof RunUIStepsSchema>;

export function createUIWorkflowTraceId(): string {
  return `uiworkflow-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
