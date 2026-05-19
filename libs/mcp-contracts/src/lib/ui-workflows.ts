import { z } from 'zod';

export const UIWorkflowModeSchema = z.enum(['safe', 'fast']);
export const UIWorkflowFailureStrategySchema = z.enum(['stop', 'continue', 'retry_once']);

export const UIWorkflowActionTargetScopeSchema = z.enum(['buttons', 'links', 'inputs', 'modals', 'focused']);

export const UIWorkflowLocatorMatcherSchema = z.union([
  z.string().min(1),
  z.object({
    pattern: z.string().min(1),
    flags: z.string().regex(/^[imsu]*$/).optional(),
  }),
]);

export const UIWorkflowLocatorStepSchema = z.object({
  kind: z.enum(['css', 'role', 'text', 'label', 'testId', 'placeholder', 'altText']),
  value: UIWorkflowLocatorMatcherSchema.optional(),
  role: z.string().min(1).optional(),
  name: UIWorkflowLocatorMatcherSchema.optional(),
  exact: z.boolean().optional(),
  relation: z.enum(['filter', 'descendant']).optional(),
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

export const UIWorkflowLocatorSchema = z.object({
  scope: UIWorkflowActionTargetScopeSchema.optional(),
  frame: z.object({
    urlContains: z.string().min(1).optional(),
    titleContains: z.string().min(1).optional(),
  }).optional(),
  steps: z.array(UIWorkflowLocatorStepSchema).min(1).max(8),
});

export const UIWorkflowActionTargetSchema = z.object({
  selector: z.string().min(1).optional(),
  elementRef: z.string().min(1).optional(),
  tabId: z.number().int().min(0).optional(),
  frameId: z.number().int().min(0).optional(),
  url: z.string().url().optional(),
  locator: UIWorkflowLocatorSchema.optional(),
  frameUrlContains: z.string().min(1).optional(),
  frameTitleContains: z.string().min(1).optional(),
  testId: z.string().min(1).optional(),
  scope: UIWorkflowActionTargetScopeSchema.optional(),
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
  if (
    !value.selector
    && !value.elementRef
    && !value.locator
    && !value.scope
    && !value.testId
    && !value.textContains
    && !value.labelContains
    && !value.titleContains
    && !value.role
    && !value.name
    && !value.placeholder
    && !value.altText
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'target requires selector, elementRef, locator, scope, testId, textContains, labelContains, titleContains, role, name, placeholder, or altText',
      path: ['target'],
    });
  }
  const positionFields = [value.nth !== undefined, value.first === true, value.last === true].filter(Boolean).length;
  if (positionFields > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'target can use only one of nth, first, or last',
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
    action: z.literal('hover'),
    input: z.object({}).optional(),
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
  scope: z.enum(['buttons', 'links', 'inputs', 'modals', 'focused', 'page']),
  selector: z.string().optional(),
  testId: z.string().optional(),
  textContains: z.string().optional(),
  labelContains: z.string().optional(),
  titleContains: z.string().optional(),
  role: z.string().optional(),
  name: z.string().optional(),
  placeholder: z.string().optional(),
  altText: z.string().optional(),
  exact: z.boolean().optional(),
  frameUrlContains: z.string().optional(),
  frameTitleContains: z.string().optional(),
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

export const AutomationWaitBaseSchema = z.object({
  timeoutMs: z.number().int().min(100).max(120000).optional(),
  pollIntervalMs: z.number().int().min(50).max(5000).optional(),
});

export const AutomationWaitUrlSchema = AutomationWaitBaseSchema.extend({
  waitKind: z.literal('url'),
  urlContains: z.string().min(1).optional(),
  urlRegex: z.string().min(1).optional(),
  exactUrl: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (!value.urlContains && !value.urlRegex && !value.exactUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'url wait requires urlContains, urlRegex, or exactUrl',
      path: ['wait'],
    });
  }
});

export const AutomationWaitNavigationSchema = AutomationWaitBaseSchema.extend({
  waitKind: z.literal('navigation'),
  urlContains: z.string().min(1).optional(),
  urlRegex: z.string().min(1).optional(),
  exactUrl: z.string().min(1).optional(),
  fromUrlContains: z.string().min(1).optional(),
  fromUrlRegex: z.string().min(1).optional(),
  trigger: z.string().min(1).optional(),
  sinceTs: z.number().int().min(0).optional(),
  tabId: z.number().int().min(0).optional(),
}).superRefine((value, ctx) => {
  if (
    !value.urlContains
    && !value.urlRegex
    && !value.exactUrl
    && !value.fromUrlContains
    && !value.fromUrlRegex
    && !value.trigger
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'navigation wait requires a URL, from-URL, or trigger predicate',
      path: ['wait'],
    });
  }
});

export const AutomationWaitLoadStateSchema = AutomationWaitBaseSchema.extend({
  waitKind: z.literal('load_state'),
  state: z.enum(['domcontentloaded', 'load']).default('load'),
  urlContains: z.string().min(1).optional(),
  urlRegex: z.string().min(1).optional(),
  exactUrl: z.string().min(1).optional(),
});

export const AutomationWaitSelectorStateSchema = AutomationWaitBaseSchema.extend({
  waitKind: z.literal('selector_state'),
  selector: z.string().min(1),
  state: z.enum(['attached', 'detached', 'visible', 'hidden']).default('visible'),
  frameId: z.number().int().min(0).default(0),
});

export const AutomationWaitConsoleSchema = AutomationWaitBaseSchema.extend({
  waitKind: z.literal('console'),
  levels: z.array(z.string().min(1)).optional(),
  contains: z.string().min(1).optional(),
  sinceTs: z.number().int().min(0).optional(),
  includeRuntimeErrors: z.boolean().optional(),
});

export const AutomationWaitDialogSchema = AutomationWaitBaseSchema.extend({
  waitKind: z.literal('dialog'),
  type: z.enum(['alert', 'confirm', 'prompt', 'beforeunload']).optional(),
  messageContains: z.string().min(1).optional(),
  urlContains: z.string().min(1).optional(),
  action: z.enum(['none', 'accept', 'dismiss']).default('none'),
  promptText: z.string().optional(),
  tabId: z.number().int().min(0).optional(),
});

export const AutomationWaitNetworkQuietSchema = AutomationWaitBaseSchema.extend({
  waitKind: z.literal('network_quiet'),
  quietMs: z.number().int().min(100).max(10000).default(500),
  urlContains: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
  tabId: z.number().int().min(0).optional(),
});

export const AutomationWaitNetworkBaseSchema = AutomationWaitBaseSchema.extend({
  urlContains: z.string().min(1).optional(),
  urlRegex: z.string().min(1).optional(),
  exactUrl: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
  traceId: z.string().min(1).optional(),
  initiator: z.enum(['fetch', 'xhr', 'img', 'script', 'other']).optional(),
  requestContentType: z.string().min(1).optional(),
  sinceTs: z.number().int().min(0).optional(),
  tabId: z.number().int().min(0).optional(),
  includeBodies: z.boolean().optional(),
});

export const AutomationWaitRequestSchema = AutomationWaitNetworkBaseSchema.extend({
  waitKind: z.literal('request'),
}).superRefine((value, ctx) => {
  if (!value.urlContains && !value.urlRegex && !value.exactUrl && !value.traceId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'request wait requires urlContains, urlRegex, exactUrl, or traceId',
      path: ['wait'],
    });
  }
});

export const AutomationWaitResponseSchema = AutomationWaitNetworkBaseSchema.extend({
  waitKind: z.literal('response'),
  statusIn: z.array(z.number().int().min(100).max(599)).optional(),
  statusGte: z.number().int().min(100).max(599).optional(),
  statusLt: z.number().int().min(100).max(600).optional(),
  responseContentType: z.string().min(1).optional(),
  errorType: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (!value.urlContains && !value.urlRegex && !value.exactUrl && !value.traceId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'response wait requires urlContains, urlRegex, exactUrl, or traceId',
      path: ['wait'],
    });
  }
  if (value.statusGte !== undefined && value.statusLt !== undefined && value.statusGte >= value.statusLt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'statusGte must be less than statusLt',
      path: ['statusGte'],
    });
  }
});

export const AutomationWaitSpecSchema = z.discriminatedUnion('waitKind', [
  AutomationWaitUrlSchema,
  AutomationWaitNavigationSchema,
  AutomationWaitLoadStateSchema,
  AutomationWaitSelectorStateSchema,
  AutomationWaitConsoleSchema,
  AutomationWaitDialogSchema,
  AutomationWaitNetworkQuietSchema,
  AutomationWaitRequestSchema,
  AutomationWaitResponseSchema,
]);

export const UIWorkflowGenericWaitStepSchema = UIWorkflowStepBaseSchema.extend({
  kind: z.literal('wait'),
  wait: AutomationWaitSpecSchema,
});

export const UIWorkflowAssertStepSchema = UIWorkflowStepBaseSchema.extend({
  kind: z.literal('assert'),
  matcher: UIWorkflowPageStateMatcherSchema,
});

export const UIWorkflowStepSchema = z.discriminatedUnion('kind', [
  UIWorkflowActionStepSchema,
  UIWorkflowWaitForStepSchema,
  UIWorkflowGenericWaitStepSchema,
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
export type UIWorkflowLocatorMatcher = z.infer<typeof UIWorkflowLocatorMatcherSchema>;
export type UIWorkflowLocatorStep = z.infer<typeof UIWorkflowLocatorStepSchema>;
export type UIWorkflowLocator = z.infer<typeof UIWorkflowLocatorSchema>;
export type UIWorkflowActionTarget = z.infer<typeof UIWorkflowActionTargetSchema>;
export type UIWorkflowActionStep = z.infer<typeof UIWorkflowActionStepSchema>;
export type UIWorkflowPageStateMatcher = z.infer<typeof UIWorkflowPageStateMatcherSchema>;
export type UIWorkflowWaitForStep = z.infer<typeof UIWorkflowWaitForStepSchema>;
export type AutomationWaitSpec = z.infer<typeof AutomationWaitSpecSchema>;
export type UIWorkflowGenericWaitStep = z.infer<typeof UIWorkflowGenericWaitStepSchema>;
export type UIWorkflowAssertStep = z.infer<typeof UIWorkflowAssertStepSchema>;
export type UIWorkflowStep = z.infer<typeof UIWorkflowStepSchema>;
export type RunUIStepsRequest = z.infer<typeof RunUIStepsSchema>;

export function createUIWorkflowTraceId(): string {
  return `uiworkflow-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
