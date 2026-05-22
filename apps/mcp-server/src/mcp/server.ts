import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Database } from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { z } from 'zod';
import {
  WorkflowTargetResolutionError,
  hasSemanticActionTargetMatcher,
  resolveWorkflowActionTarget,
  summarizeWorkflowTargetMatcher,
  type PageStateCaptureResult,
  type UIWorkflowActionTarget,
} from './target-resolution.js';
import { getConnection } from '../db/connection.js';
import {
  diagnoseOverridePoc,
  insertOverridePlanAudit,
  insertSsrMockAudit,
  listOverridePlanAudits,
  listOverridePocRequests,
  listOverridePocRuns,
  listSsrMockAudits,
} from '../override-audit.js';
import type {
  MockRouteBodyKind,
  MockRouteMode,
  MockRouteRecord,
  MockRouteSourceKind,
  OverridePlanAuditRecord,
  SsrMockAuditRecord,
  SsrMockAuditStatus,
} from '../override-audit-contract.js';
import { deleteMockRoute, getMockRoute, listMockHits, listMockRoutes, listMockRuns, upsertMockRoute } from '../mock-store.js';
import {
  createOverrideProfileConfig,
  OVERRIDE_PROFILE_ADAPTERS,
  type OverrideProfileAdapterId,
} from '../override-profile-generator.js';
import {
  assertOverrideResponseRequestCaptureSafe,
  classifyOverrideResponseRequestCapability,
} from '../override-capabilities.js';
import { getOverridePocConfigSummary } from '../override-poc.js';
import { normalizeOverrideRequestMethod } from '../override-rule-types.js';
import { mapNextOverrideAssetsWithDrift } from '../next-asset-mapper.js';
import { planNextSourceOverride, type NextSourceOverridePlanResult, type PlannedNextOverrideRule } from '../next-source-override-planner.js';
import { listObservedOverrideAssets, persistObservedOverrideAssets } from '../override-observed-assets.js';
import { planOverrideResponsePatch, type OverrideResponsePatchPlanResult } from '../override-response-planner.js';
import { applySsrMockConfig, discoverSsrMockability, removeSsrMockConfig } from '../ssr-mock.js';
import {
  getLighthouseReport,
  getLighthouseReportAsset,
  listLighthouseReports,
  normalizeLighthouseAsset,
  planLighthouseFixes,
  runLighthouseReport,
} from '../lighthouse-report.js';
import { createToolLoopGuard, type ToolLoopGuard } from './tool-loop-guard.js';

type ToolInput = Record<string, unknown>;

interface RedactionSummary {
  totalFields: number;
  redactedFields: number;
  rulesApplied: string[];
}

interface BaseToolResponse {
  sessionId?: string;
  limitsApplied: {
    maxResults: number;
    truncated: boolean;
  };
  redactionSummary: RedactionSummary;
}

type ToolResponse = BaseToolResponse & Record<string, unknown>;

export type ToolHandler = (input: ToolInput) => Promise<ToolResponse>;

export interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: object;
  handler: ToolHandler;
}

export interface MCPServerRuntime {
  server: Server;
  transport: StdioServerTransport;
  tools: RegisteredTool[];
  start: () => Promise<void>;
}

export interface SessionConnectionLookupResult {
  connected: boolean;
  connectedAt: number;
  lastHeartbeatAt: number;
  disconnectedAt?: number;
  disconnectReason?: 'manual_stop' | 'network_error' | 'stale_timeout' | 'normal_closure' | 'abnormal_close' | 'unknown';
}

export interface MCPServerOptions {
  captureClient?: CaptureCommandClient;
  logger?: MCPLogger;
  getSessionConnectionState?: (sessionId: string) => SessionConnectionLookupResult | undefined;
  loopGuard?: ToolLoopGuard | false;
}

export interface MCPLogger {
  info(payload: Record<string, unknown>, message?: string): void;
  error(payload: Record<string, unknown>, message?: string): void;
  debug(payload: Record<string, unknown>, message?: string): void;
}

function createDefaultMcpLogger(): MCPLogger {
  const write = (level: 'info' | 'error' | 'debug', message: string, payload: Record<string, unknown>): void => {
    process.stderr.write(`${message} ${JSON.stringify({ level, ...payload })}\n`);
  };

  return {
    info: (payload, message) => {
      write('info', message ?? '[MCPServer][MCP][info]', payload);
    },
    error: (payload, message) => {
      write('error', message ?? '[MCPServer][MCP][error]', payload);
    },
    debug: (payload, message) => {
      write('debug', message ?? '[MCPServer][MCP][debug]', payload);
    },
  };
}

const UIActionTargetScopeSchema = z.enum(['buttons', 'links', 'inputs', 'modals', 'focused']);

const UIActionLocatorMatcherSchema = z.union([
  z.string().min(1),
  z.object({
    pattern: z.string().min(1),
    flags: z.string().regex(/^[imsu]*$/).optional(),
  }),
]);

const UIActionLocatorStepSchema = z.object({
  kind: z.enum(['css', 'role', 'text', 'label', 'testId', 'placeholder', 'altText']),
  value: UIActionLocatorMatcherSchema.optional(),
  role: z.string().min(1).optional(),
  name: UIActionLocatorMatcherSchema.optional(),
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

const UIActionLocatorSchema = z.object({
  scope: UIActionTargetScopeSchema.optional(),
  frame: z.object({
    selector: z.string().min(1).optional(),
    urlContains: z.string().min(1).optional(),
    titleContains: z.string().min(1).optional(),
  }).optional(),
  steps: z.array(UIActionLocatorStepSchema).min(1).max(8),
});

const UIActionCoordinateTargetSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  frameId: z.number().int().min(0).optional(),
});

const LiveUIActionTargetSchema = z.object({
  selector: z.string().min(1).optional(),
  elementRef: z.string().min(1).optional(),
  coordinates: UIActionCoordinateTargetSchema.optional(),
  tabId: z.number().int().min(0).optional(),
  frameId: z.number().int().min(0).optional(),
  url: z.string().url().optional(),
  locator: UIActionLocatorSchema.optional(),
  frameUrlContains: z.string().min(1).optional(),
  frameTitleContains: z.string().min(1).optional(),
  testId: z.string().min(1).optional(),
  scope: UIActionTargetScopeSchema.optional(),
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

const LiveUIActionRequestSchema = z.discriminatedUnion('action', [
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

type LiveUIActionRequest = z.infer<typeof LiveUIActionRequestSchema>;
type LiveUIActionResult = {
  action: LiveUIActionRequest['action'];
  traceId: string;
  status: 'succeeded' | 'rejected' | 'failed';
  executionScope: 'top-document-v1';
  startedAt: number;
  finishedAt: number;
  target: {
    matched: boolean;
    selector?: string;
    resolvedSelector?: string;
    tagName?: string;
    textPreview?: string;
    tabId?: number;
    frameId?: number;
    url?: string;
  };
  failureReason?: {
    code: string;
    message: string;
  };
  result?: Record<string, unknown>;
};

const UIWorkflowModeSchema = z.enum(['safe', 'fast']);
const UIWorkflowFailureStrategySchema = z.enum(['stop', 'continue', 'retry_once']);
const UIWorkflowActionTargetScopeSchema = UIActionTargetScopeSchema;

const UIWorkflowActionTargetSchema = z.object({
  selector: z.string().min(1).optional(),
  elementRef: z.string().min(1).optional(),
  coordinates: UIActionCoordinateTargetSchema.optional(),
  tabId: z.number().int().min(0).optional(),
  frameId: z.number().int().min(0).optional(),
  url: z.string().url().optional(),
  locator: UIActionLocatorSchema.optional(),
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
    && !value.coordinates
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
      message: 'target requires selector, elementRef, coordinates, locator, scope, testId, textContains, labelContains, titleContains, role, name, placeholder, or altText',
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

const UIWorkflowFailureCaptureSchema = z.object({
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

const UIWorkflowFailurePolicySchema = z.object({
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

const UIWorkflowActionStepSchema = z.discriminatedUnion('action', [
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

const UIWorkflowPageStateMatcherSchema = z.object({
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
  visible: z.boolean().optional(),
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

const UIWorkflowWaitForStepSchema = UIWorkflowStepBaseSchema.extend({
  kind: z.literal('waitFor'),
  matcher: UIWorkflowPageStateMatcherSchema.extend({
    timeoutMs: z.number().int().min(100).max(30000).optional(),
    pollIntervalMs: z.number().int().min(50).max(2000).optional(),
  }),
});

const UIWorkflowAssertStepSchema = UIWorkflowStepBaseSchema.extend({
  kind: z.literal('assert'),
  matcher: UIWorkflowPageStateMatcherSchema,
});

const AutomationWaitBaseSchema = z.object({
  timeoutMs: z.number().int().min(100).max(120000).optional(),
  pollIntervalMs: z.number().int().min(50).max(5000).optional(),
});

const AutomationWaitUrlSchema = AutomationWaitBaseSchema.extend({
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

const AutomationWaitNavigationSchema = AutomationWaitBaseSchema.extend({
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

const AutomationWaitNavigationLifecycleSchema = AutomationWaitBaseSchema.extend({
  waitKind: z.literal('navigation_lifecycle'),
  state: z.enum(['commit', 'same_document', 'domcontentloaded', 'load', 'network_idle']).default('load'),
  urlContains: z.string().min(1).optional(),
  urlRegex: z.string().min(1).optional(),
  exactUrl: z.string().min(1).optional(),
  tabId: z.number().int().min(0).optional(),
});

const AutomationWaitLoadStateSchema = AutomationWaitBaseSchema.extend({
  waitKind: z.literal('load_state'),
  state: z.enum(['domcontentloaded', 'load']).default('load'),
  urlContains: z.string().min(1).optional(),
  urlRegex: z.string().min(1).optional(),
  exactUrl: z.string().min(1).optional(),
});

const AutomationWaitSelectorStateSchema = AutomationWaitBaseSchema.extend({
  waitKind: z.literal('selector_state'),
  selector: z.string().min(1),
  state: z.enum(['attached', 'detached', 'visible', 'hidden']).default('visible'),
  frameId: z.number().int().min(0).default(0),
});

const AutomationWaitConsoleSchema = AutomationWaitBaseSchema.extend({
  waitKind: z.literal('console'),
  levels: z.array(z.string().min(1)).optional(),
  contains: z.string().min(1).optional(),
  sinceTs: z.number().int().min(0).optional(),
  includeRuntimeErrors: z.boolean().optional(),
});

const AutomationWaitDialogSchema = AutomationWaitBaseSchema.extend({
  waitKind: z.literal('dialog'),
  type: z.enum(['alert', 'confirm', 'prompt', 'beforeunload']).optional(),
  messageContains: z.string().min(1).optional(),
  urlContains: z.string().min(1).optional(),
  action: z.enum(['none', 'accept', 'dismiss']).default('none'),
  promptText: z.string().optional(),
  tabId: z.number().int().min(0).optional(),
});

const AutomationWaitStableLayoutSchema = AutomationWaitBaseSchema.extend({
  waitKind: z.literal('stable_layout'),
  selector: z.string().min(1).optional(),
  stableMs: z.number().int().min(100).max(10000).default(500),
  tabId: z.number().int().min(0).optional(),
});

const AutomationWaitDownloadSchema = AutomationWaitBaseSchema.extend({
  waitKind: z.literal('download'),
  urlContains: z.string().min(1).optional(),
  urlRegex: z.string().min(1).optional(),
  exactUrl: z.string().min(1).optional(),
  filenameContains: z.string().min(1).optional(),
  filenameRegex: z.string().min(1).optional(),
  state: z.enum(['started', 'completed']).default('started'),
  tabId: z.number().int().min(0).optional(),
}).superRefine((value, ctx) => {
  if (!value.urlContains && !value.urlRegex && !value.exactUrl && !value.filenameContains && !value.filenameRegex) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'download wait requires a URL or filename predicate',
      path: ['wait'],
    });
  }
});

const AutomationWaitPopupSchema = AutomationWaitBaseSchema.extend({
  waitKind: z.literal('popup'),
  urlContains: z.string().min(1).optional(),
  urlRegex: z.string().min(1).optional(),
  exactUrl: z.string().min(1).optional(),
  openerTabId: z.number().int().min(0).optional(),
}).superRefine((value, ctx) => {
  if (!value.urlContains && !value.urlRegex && !value.exactUrl && value.openerTabId === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'popup wait requires a URL predicate or openerTabId',
      path: ['wait'],
    });
  }
});

const AutomationWaitNetworkQuietSchema = AutomationWaitBaseSchema.extend({
  waitKind: z.literal('network_quiet'),
  quietMs: z.number().int().min(100).max(10000).default(500),
  urlContains: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
  tabId: z.number().int().min(0).optional(),
});

const AutomationWaitNetworkBaseSchema = AutomationWaitBaseSchema.extend({
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

const AutomationWaitRequestSchema = AutomationWaitNetworkBaseSchema.extend({
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

const AutomationWaitResponseSchema = AutomationWaitNetworkBaseSchema.extend({
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

const AutomationWaitSpecSchema = z.discriminatedUnion('waitKind', [
  AutomationWaitUrlSchema,
  AutomationWaitNavigationSchema,
  AutomationWaitNavigationLifecycleSchema,
  AutomationWaitLoadStateSchema,
  AutomationWaitSelectorStateSchema,
  AutomationWaitConsoleSchema,
  AutomationWaitDialogSchema,
  AutomationWaitStableLayoutSchema,
  AutomationWaitDownloadSchema,
  AutomationWaitPopupSchema,
  AutomationWaitNetworkQuietSchema,
  AutomationWaitRequestSchema,
  AutomationWaitResponseSchema,
]);

const UIWorkflowGenericWaitStepSchema = UIWorkflowStepBaseSchema.extend({
  kind: z.literal('wait'),
  wait: AutomationWaitSpecSchema,
});

const UIWorkflowStepSchema = z.discriminatedUnion('kind', [
  UIWorkflowActionStepSchema,
  UIWorkflowWaitForStepSchema,
  UIWorkflowAssertStepSchema,
  UIWorkflowGenericWaitStepSchema,
]);

const RunUIStepsSchema = z.object({
  sessionId: z.string().min(1),
  mode: UIWorkflowModeSchema.default('safe'),
  stopOnFailure: z.boolean().default(true),
  defaultTimeoutMs: z.number().int().min(100).max(30000).optional(),
  defaultPollIntervalMs: z.number().int().min(50).max(2000).optional(),
  steps: z.array(UIWorkflowStepSchema).min(1).max(50),
});

type UIWorkflowActionStep = z.infer<typeof UIWorkflowActionStepSchema>;
type UIWorkflowStep = z.infer<typeof UIWorkflowStepSchema>;
type RunUIStepsRequest = z.infer<typeof RunUIStepsSchema>;
type AutomationWaitSpec = z.infer<typeof AutomationWaitSpecSchema>;

function createUIWorkflowTraceId(): string {
  return `uiworkflow-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const LOCATOR_MATCHER_TOOL_SCHEMA = {
  anyOf: [
    { type: 'string' },
    {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string' },
        flags: { type: 'string' },
      },
    },
  ],
};

const ACTION_LOCATOR_TOOL_SCHEMA = {
  type: 'object',
  required: ['steps'],
  properties: {
    scope: { type: 'string', enum: ['buttons', 'links', 'inputs', 'modals', 'focused'] },
    frame: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        urlContains: { type: 'string' },
        titleContains: { type: 'string' },
      },
    },
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        required: ['kind'],
        properties: {
          kind: { type: 'string', enum: ['css', 'role', 'text', 'label', 'testId', 'placeholder', 'altText'] },
          value: LOCATOR_MATCHER_TOOL_SCHEMA,
          role: { type: 'string' },
          name: LOCATOR_MATCHER_TOOL_SCHEMA,
          exact: { type: 'boolean' },
          relation: { type: 'string', enum: ['filter', 'descendant', 'ancestor'] },
        },
      },
    },
  },
};

const AUTOMATION_WAIT_TOOL_SCHEMA = {
  type: 'object',
  required: ['waitKind'],
  properties: {
    waitKind: { type: 'string', enum: ['url', 'navigation', 'navigation_lifecycle', 'load_state', 'selector_state', 'console', 'dialog', 'stable_layout', 'download', 'popup', 'network_quiet', 'request', 'response'] },
    timeoutMs: { type: 'number' },
    pollIntervalMs: { type: 'number' },
    urlContains: { type: 'string' },
    urlRegex: { type: 'string' },
    exactUrl: { type: 'string' },
    fromUrlContains: { type: 'string' },
    fromUrlRegex: { type: 'string' },
    trigger: { type: 'string' },
    state: { type: 'string', enum: ['commit', 'same_document', 'domcontentloaded', 'load', 'network_idle', 'attached', 'detached', 'visible', 'hidden', 'started', 'completed'] },
    selector: { type: 'string' },
    frameId: { type: 'number' },
    levels: { type: 'array', items: { type: 'string' } },
    contains: { type: 'string' },
    sinceTs: { type: 'number' },
    includeRuntimeErrors: { type: 'boolean' },
    action: { type: 'string', enum: ['none', 'accept', 'dismiss'] },
    promptText: { type: 'string' },
    stableMs: { type: 'number' },
    filenameContains: { type: 'string' },
    filenameRegex: { type: 'string' },
    openerTabId: { type: 'number' },
    quietMs: { type: 'number' },
    method: { type: 'string' },
    traceId: { type: 'string' },
    initiator: { type: 'string', enum: ['fetch', 'xhr', 'img', 'script', 'other'] },
    requestContentType: { type: 'string' },
    responseContentType: { type: 'string' },
    statusIn: { type: 'array', items: { type: 'number' } },
    statusGte: { type: 'number' },
    statusLt: { type: 'number' },
    errorType: { type: 'string' },
    includeBodies: { type: 'boolean' },
    tabId: { type: 'number' },
  },
};

const TOOL_SCHEMAS: Record<string, object> = {
  list_sessions: {
    type: 'object',
    properties: {
      sinceMinutes: { type: 'number' },
      limit: { type: 'number' },
      offset: { type: 'number' },
      maxResponseBytes: { type: 'number' },
    },
  },
  get_session_summary: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
    },
  },
  get_live_session_health: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
    },
  },
  get_recent_events: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      url: { type: 'string' },
      eventTypes: { type: 'array', items: { type: 'string' } },
      limit: { type: 'number' },
      offset: { type: 'number' },
      responseProfile: { type: 'string' },
      includePayload: { type: 'boolean' },
      maxResponseBytes: { type: 'number' },
    },
  },
  get_navigation_history: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      url: { type: 'string' },
      limit: { type: 'number' },
      offset: { type: 'number' },
      responseProfile: { type: 'string' },
      includePayload: { type: 'boolean' },
      maxResponseBytes: { type: 'number' },
    },
  },
  get_console_events: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      url: { type: 'string' },
      level: { type: 'string' },
      limit: { type: 'number' },
      offset: { type: 'number' },
      responseProfile: { type: 'string' },
      includePayload: { type: 'boolean' },
      maxResponseBytes: { type: 'number' },
    },
  },
  get_console_summary: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      url: { type: 'string' },
      level: { type: 'string' },
      sinceMinutes: { type: 'number' },
      limit: { type: 'number' },
    },
  },
  get_event_summary: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      url: { type: 'string' },
      eventTypes: { type: 'array', items: { type: 'string' } },
      sinceMinutes: { type: 'number' },
      limit: { type: 'number' },
    },
  },
  get_error_fingerprints: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      sinceMinutes: { type: 'number' },
      limit: { type: 'number' },
      offset: { type: 'number' },
      maxResponseBytes: { type: 'number' },
    },
  },
  get_network_failures: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      url: { type: 'string' },
      errorType: { type: 'string' },
      groupBy: { type: 'string' },
      limit: { type: 'number' },
      offset: { type: 'number' },
      maxResponseBytes: { type: 'number' },
    },
  },
  get_network_calls: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      urlContains: { type: 'string' },
      urlRegex: { type: 'string' },
      method: { type: 'string' },
      statusIn: { type: 'array', items: { type: 'number' } },
      tabId: { type: 'number' },
      timeFrom: { type: 'number' },
      timeTo: { type: 'number' },
      includeBodies: { type: 'boolean' },
      limit: { type: 'number' },
      offset: { type: 'number' },
      maxResponseBytes: { type: 'number' },
    },
  },
  wait_for_network_call: {
    type: 'object',
    required: ['sessionId', 'urlPattern'],
    properties: {
      sessionId: { type: 'string' },
      urlPattern: { type: 'string' },
      method: { type: 'string' },
      timeoutMs: { type: 'number' },
      includeBodies: { type: 'boolean' },
    },
  },
  get_request_trace: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      requestId: { type: 'string' },
      traceId: { type: 'string' },
      includeBodies: { type: 'boolean' },
      eventLimit: { type: 'number' },
    },
  },
  get_body_chunk: {
    type: 'object',
    required: ['chunkRef'],
    properties: {
      chunkRef: { type: 'string' },
      sessionId: { type: 'string' },
      offset: { type: 'number' },
      limit: { type: 'number' },
    },
  },
  get_element_refs: {
    type: 'object',
    required: ['sessionId', 'selector'],
    properties: {
      sessionId: { type: 'string' },
      selector: { type: 'string' },
      limit: { type: 'number' },
      offset: { type: 'number' },
      maxResponseBytes: { type: 'number' },
    },
  },
  get_dom_subtree: {
    type: 'object',
    required: ['sessionId', 'selector'],
    properties: {
      sessionId: { type: 'string' },
      selector: { type: 'string' },
      maxDepth: { type: 'number' },
      maxBytes: { type: 'number' },
    },
  },
  get_dom_document: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      mode: { type: 'string' },
    },
  },
  get_computed_styles: {
    type: 'object',
    required: ['sessionId', 'selector'],
    properties: {
      sessionId: { type: 'string' },
      selector: { type: 'string' },
      frameId: { type: 'number' },
      properties: { type: 'array', items: { type: 'string' } },
    },
  },
  get_layout_metrics: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      selector: { type: 'string' },
      frameId: { type: 'number' },
    },
  },
  get_page_state: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      maxItems: { type: 'number' },
      maxTextLength: { type: 'number' },
      includeButtons: { type: 'boolean' },
      includeLinks: { type: 'boolean' },
      includeInputs: { type: 'boolean' },
      includeModals: { type: 'boolean' },
    },
  },
  get_interactive_elements: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      kinds: {
        type: 'array',
        items: { type: 'string', enum: ['buttons', 'links', 'inputs', 'modals', 'focused'] },
      },
      maxItems: { type: 'number' },
      maxTextLength: { type: 'number' },
    },
  },
  set_viewport: {
    type: 'object',
    required: ['sessionId', 'width', 'height'],
    properties: {
      sessionId: { type: 'string' },
      width: { type: 'number' },
      height: { type: 'number' },
    },
  },
  assert_page_state: {
    type: 'object',
    required: ['sessionId', 'scope'],
    properties: {
      sessionId: { type: 'string' },
      scope: { type: 'string', enum: ['buttons', 'links', 'inputs', 'modals', 'focused', 'page'] },
      selector: { type: 'string' },
      testId: { type: 'string' },
      textContains: { type: 'string' },
      labelContains: { type: 'string' },
      titleContains: { type: 'string' },
      role: { type: 'string' },
      name: { type: 'string' },
      placeholder: { type: 'string' },
      altText: { type: 'string' },
      exact: { type: 'boolean' },
      frameUrlContains: { type: 'string' },
      frameTitleContains: { type: 'string' },
      urlContains: { type: 'string' },
      language: { type: 'string' },
      visible: { type: 'boolean' },
      disabled: { type: 'boolean' },
      selected: { type: 'boolean' },
      pressed: { type: 'boolean' },
      expanded: { type: 'boolean' },
      readOnly: { type: 'boolean' },
      requiredField: { type: 'boolean' },
      tagName: { type: 'string' },
      type: { type: 'string' },
      countExactly: { type: 'number' },
      countAtLeast: { type: 'number' },
      maxItems: { type: 'number' },
      maxTextLength: { type: 'number' },
    },
  },
  wait_for_page_state: {
    type: 'object',
    required: ['sessionId', 'scope'],
    properties: {
      sessionId: { type: 'string' },
      scope: { type: 'string', enum: ['buttons', 'links', 'inputs', 'modals', 'focused', 'page'] },
      selector: { type: 'string' },
      testId: { type: 'string' },
      textContains: { type: 'string' },
      labelContains: { type: 'string' },
      titleContains: { type: 'string' },
      role: { type: 'string' },
      name: { type: 'string' },
      placeholder: { type: 'string' },
      altText: { type: 'string' },
      exact: { type: 'boolean' },
      frameUrlContains: { type: 'string' },
      frameTitleContains: { type: 'string' },
      urlContains: { type: 'string' },
      language: { type: 'string' },
      visible: { type: 'boolean' },
      disabled: { type: 'boolean' },
      selected: { type: 'boolean' },
      pressed: { type: 'boolean' },
      expanded: { type: 'boolean' },
      readOnly: { type: 'boolean' },
      requiredField: { type: 'boolean' },
      tagName: { type: 'string' },
      type: { type: 'string' },
      countExactly: { type: 'number' },
      countAtLeast: { type: 'number' },
      maxItems: { type: 'number' },
      maxTextLength: { type: 'number' },
      timeoutMs: { type: 'number' },
      pollIntervalMs: { type: 'number' },
    },
  },
  preflight_automation_flow: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      expectedUrlContains: { type: 'string' },
      requireSensitiveAutomation: { type: 'boolean' },
      plannedActions: { type: 'array', items: { type: 'string' } },
      includePageState: { type: 'boolean' },
      maxItems: { type: 'number' },
      maxTextLength: { type: 'number' },
    },
  },
  wait_for_url: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      urlContains: { type: 'string' },
      urlRegex: { type: 'string' },
      exactUrl: { type: 'string' },
      timeoutMs: { type: 'number' },
      pollIntervalMs: { type: 'number' },
    },
  },
  wait_for_navigation: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      urlContains: { type: 'string' },
      urlRegex: { type: 'string' },
      exactUrl: { type: 'string' },
      fromUrlContains: { type: 'string' },
      fromUrlRegex: { type: 'string' },
      trigger: { type: 'string' },
      sinceTs: { type: 'number' },
      tabId: { type: 'number' },
      timeoutMs: { type: 'number' },
      pollIntervalMs: { type: 'number' },
    },
  },
  wait_for_navigation_lifecycle: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      state: { type: 'string', enum: ['commit', 'same_document', 'domcontentloaded', 'load', 'network_idle'] },
      urlContains: { type: 'string' },
      urlRegex: { type: 'string' },
      exactUrl: { type: 'string' },
      tabId: { type: 'number' },
      timeoutMs: { type: 'number' },
      pollIntervalMs: { type: 'number' },
    },
  },
  wait_for_load_state: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      state: { type: 'string', enum: ['domcontentloaded', 'load'] },
      urlContains: { type: 'string' },
      urlRegex: { type: 'string' },
      exactUrl: { type: 'string' },
      timeoutMs: { type: 'number' },
      pollIntervalMs: { type: 'number' },
    },
  },
  wait_for_selector_state: {
    type: 'object',
    required: ['sessionId', 'selector'],
    properties: {
      sessionId: { type: 'string' },
      selector: { type: 'string' },
      state: { type: 'string', enum: ['attached', 'detached', 'visible', 'hidden'] },
      frameId: { type: 'number' },
      timeoutMs: { type: 'number' },
      pollIntervalMs: { type: 'number' },
    },
  },
  wait_for_console: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      levels: { type: 'array', items: { type: 'string' } },
      contains: { type: 'string' },
      sinceTs: { type: 'number' },
      includeRuntimeErrors: { type: 'boolean' },
      timeoutMs: { type: 'number' },
      pollIntervalMs: { type: 'number' },
    },
  },
  wait_for_dialog: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      type: { type: 'string', enum: ['alert', 'confirm', 'prompt', 'beforeunload'] },
      messageContains: { type: 'string' },
      urlContains: { type: 'string' },
      action: { type: 'string', enum: ['none', 'accept', 'dismiss'] },
      promptText: { type: 'string' },
      tabId: { type: 'number' },
      timeoutMs: { type: 'number' },
      pollIntervalMs: { type: 'number' },
    },
  },
  wait_for_stable_layout: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      selector: { type: 'string' },
      stableMs: { type: 'number' },
      tabId: { type: 'number' },
      timeoutMs: { type: 'number' },
      pollIntervalMs: { type: 'number' },
    },
  },
  wait_for_download: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      urlContains: { type: 'string' },
      urlRegex: { type: 'string' },
      exactUrl: { type: 'string' },
      filenameContains: { type: 'string' },
      filenameRegex: { type: 'string' },
      state: { type: 'string', enum: ['started', 'completed'] },
      tabId: { type: 'number' },
      timeoutMs: { type: 'number' },
      pollIntervalMs: { type: 'number' },
    },
  },
  wait_for_popup: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      urlContains: { type: 'string' },
      urlRegex: { type: 'string' },
      exactUrl: { type: 'string' },
      openerTabId: { type: 'number' },
      timeoutMs: { type: 'number' },
      pollIntervalMs: { type: 'number' },
    },
  },
  wait_for_request: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      urlContains: { type: 'string' },
      urlRegex: { type: 'string' },
      exactUrl: { type: 'string' },
      method: { type: 'string' },
      traceId: { type: 'string' },
      initiator: { type: 'string', enum: ['fetch', 'xhr', 'img', 'script', 'other'] },
      requestContentType: { type: 'string' },
      sinceTs: { type: 'number' },
      tabId: { type: 'number' },
      includeBodies: { type: 'boolean' },
      timeoutMs: { type: 'number' },
      pollIntervalMs: { type: 'number' },
    },
  },
  wait_for_response: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      urlContains: { type: 'string' },
      urlRegex: { type: 'string' },
      exactUrl: { type: 'string' },
      method: { type: 'string' },
      traceId: { type: 'string' },
      initiator: { type: 'string', enum: ['fetch', 'xhr', 'img', 'script', 'other'] },
      requestContentType: { type: 'string' },
      responseContentType: { type: 'string' },
      statusIn: { type: 'array', items: { type: 'number' } },
      statusGte: { type: 'number' },
      statusLt: { type: 'number' },
      errorType: { type: 'string' },
      sinceTs: { type: 'number' },
      tabId: { type: 'number' },
      includeBodies: { type: 'boolean' },
      timeoutMs: { type: 'number' },
      pollIntervalMs: { type: 'number' },
    },
  },
  wait_for_network_quiet: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      quietMs: { type: 'number' },
      urlContains: { type: 'string' },
      method: { type: 'string' },
      tabId: { type: 'number' },
      timeoutMs: { type: 'number' },
      pollIntervalMs: { type: 'number' },
    },
  },
  capture_ui_snapshot: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      selector: { type: 'string' },
      trigger: { type: 'string' },
      mode: { type: 'string' },
      styleMode: { type: 'string' },
      maxDepth: { type: 'number' },
      maxBytes: { type: 'number' },
      maxAncestors: { type: 'number' },
      includeDom: { type: 'boolean' },
      includeStyles: { type: 'boolean' },
      includePngDataUrl: { type: 'boolean' },
    },
  },
  get_live_console_logs: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      url: { type: 'string' },
      tabId: { type: 'number' },
      levels: { type: 'array', items: { type: 'string' } },
      contains: { type: 'string' },
      sinceTs: { type: 'number' },
      includeRuntimeErrors: { type: 'boolean' },
      dedupeWindowMs: { type: 'number' },
      limit: { type: 'number' },
      responseProfile: { type: 'string' },
      includeArgs: { type: 'boolean' },
      maxResponseBytes: { type: 'number' },
    },
  },
  list_override_profiles: {
    type: 'object',
    properties: {
      responseProfile: { type: 'string', enum: ['compact', 'full'] },
    },
  },
  create_override_profile: {
    type: 'object',
    required: ['targetBaseUrl'],
    properties: {
      adapter: { type: 'string' },
      mode: { type: 'string' },
      targetBaseUrl: { type: 'string' },
      projectRoot: { type: 'string' },
      assetRoot: { type: 'string' },
      nextDir: { type: 'string' },
      configPath: { type: 'string' },
      profileId: { type: 'string' },
      profileName: { type: 'string' },
      enabled: { type: 'boolean' },
      profileEnabled: { type: 'boolean' },
      autoReload: { type: 'boolean' },
      includeManifestFiles: { type: 'boolean' },
      includeStaticFiles: { type: 'boolean' },
      extensions: { type: 'array', items: { type: 'string' } },
      maxRules: { type: 'number' },
      writeConfig: { type: 'boolean' },
      overwrite: { type: 'boolean' },
      responseProfile: { type: 'string', enum: ['compact', 'full'] },
      includeConfigJson: { type: 'boolean' },
    },
  },
  validate_override_profile: {
    type: 'object',
    properties: {
      profileId: { type: 'string' },
      responseProfile: { type: 'string', enum: ['compact', 'full'] },
    },
  },
  preflight_overrides: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      profileId: { type: 'string' },
    },
  },
  observe_override_assets: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      tabId: { type: 'number' },
      includePerformance: { type: 'boolean' },
    },
  },
  capture_override_response_body: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      tabId: { type: 'number' },
      targetUrl: { type: 'string' },
      targetAssetUrl: { type: 'string' },
      captureMode: { type: 'string', enum: ['extension-fetch', 'cdp-response'] },
      triggerReload: { type: 'boolean' },
      matchMode: { type: 'string', enum: ['exact', 'prefix'] },
      ruleType: { type: 'string' },
      requestMethod: { type: 'string' },
      requestHeaders: { type: 'object' },
      timeoutMs: { type: 'number' },
      maxBodyBytes: { type: 'number' },
      includeBody: { type: 'boolean' },
    },
  },
  list_observed_override_assets: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      limit: { type: 'number' },
      sinceTimestamp: { type: 'number' },
      responseProfile: { type: 'string', enum: ['compact', 'full'] },
    },
  },
  map_next_override_assets: {
    type: 'object',
    required: ['projectRoot'],
    properties: {
      sessionId: { type: 'string' },
      tabId: { type: 'number' },
      projectRoot: { type: 'string' },
      nextDir: { type: 'string' },
      route: { type: 'string' },
      sourcePaths: { type: 'array', items: { type: 'string' } },
      observedAssets: { type: 'array', items: { type: 'object' } },
      maxResults: { type: 'number' },
      fetchProductionAssets: { type: 'boolean' },
      productionFetchTimeoutMs: { type: 'number' },
      maxProductionAssetBytes: { type: 'number' },
      maxDriftCandidates: { type: 'number' },
      productionFetchConcurrency: { type: 'number' },
    },
  },
  plan_override_response_patch: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      tabId: { type: 'number' },
      targetUrl: { type: 'string' },
      targetAssetUrl: { type: 'string' },
      captureMode: { type: 'string', enum: ['extension-fetch', 'cdp-response'] },
      triggerReload: { type: 'boolean' },
      ruleType: { type: 'string' },
      requestMethod: { type: 'string' },
      matchMode: { type: 'string', enum: ['exact', 'prefix'] },
      requestHeaders: { type: 'object' },
      timeoutMs: { type: 'number' },
      contentType: { type: 'string' },
      responseBodyText: { type: 'string' },
      bodyText: { type: 'string' },
      responseBodyBase64: { type: 'string' },
      bodyBase64: { type: 'string' },
      textPatches: { type: 'array', items: { type: 'object' } },
      jsonPatches: { type: 'array', items: { type: 'object' } },
      documentPatches: { type: 'array', items: { type: 'object' } },
      maxBodyBytes: { type: 'number' },
      outputRoot: { type: 'string' },
      configPath: { type: 'string' },
      writeBody: { type: 'boolean' },
      writeConfig: { type: 'boolean' },
      overwrite: { type: 'boolean' },
      enabled: { type: 'boolean' },
      profileEnabled: { type: 'boolean' },
      autoReload: { type: 'boolean' },
      profileId: { type: 'string' },
      profileName: { type: 'string' },
      ruleId: { type: 'string' },
      includePreview: { type: 'boolean' },
    },
  },
  plan_next_source_override: {
    type: 'object',
    required: ['projectRoot', 'sourceEdits'],
    properties: {
      sessionId: { type: 'string' },
      tabId: { type: 'number' },
      projectRoot: { type: 'string' },
      nextDir: { type: 'string' },
      route: { type: 'string' },
      sourcePaths: { type: 'array', items: { type: 'string' } },
      sourceEdits: { type: 'array', items: { type: 'object' } },
      observedAssets: { type: 'array', items: { type: 'object' } },
      configPath: { type: 'string' },
      writeConfig: { type: 'boolean' },
      overwrite: { type: 'boolean' },
      enabled: { type: 'boolean' },
      profileEnabled: { type: 'boolean' },
      autoReload: { type: 'boolean' },
      profileId: { type: 'string' },
      profileName: { type: 'string' },
      buildTimeoutMs: { type: 'number' },
      maxRules: { type: 'number' },
      fetchProductionAssets: { type: 'boolean' },
      productionFetchTimeoutMs: { type: 'number' },
      maxProductionAssetBytes: { type: 'number' },
      maxDriftCandidates: { type: 'number' },
      productionFetchConcurrency: { type: 'number' },
      overlayTtlMs: { type: 'number' },
    },
  },
  enable_overrides: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      tabId: { type: 'number' },
      profileId: { type: 'string' },
    },
  },
  disable_overrides: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
    },
  },
  get_override_status: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      profileId: { type: 'string' },
    },
  },
  get_override_request_log: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      runId: { type: 'string' },
      limit: { type: 'number' },
      offset: { type: 'number' },
      maxResponseBytes: { type: 'number' },
    },
  },
  get_override_plan_log: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      planId: { type: 'string' },
      limit: { type: 'number' },
      offset: { type: 'number' },
      maxResponseBytes: { type: 'number' },
    },
  },
  diagnose_overrides: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      runId: { type: 'string' },
    },
  },
  discover_ssr_mockability: {
    type: 'object',
    required: ['projectRoot'],
    properties: {
      projectRoot: { type: 'string' },
      targetUrl: { type: 'string' },
      apiHost: { type: 'string' },
      maxFiles: { type: 'number' },
    },
  },
  apply_ssr_mock_config: {
    type: 'object',
    required: ['projectRoot', 'envVarName', 'mockBaseUrl'],
    properties: {
      projectRoot: { type: 'string' },
      envVarName: { type: 'string' },
      mockBaseUrl: { type: 'string' },
      envFilePath: { type: 'string' },
      rollbackId: { type: 'string' },
    },
  },
  remove_ssr_mock_config: {
    type: 'object',
    required: ['envFilePath', 'envVarName'],
    properties: {
      envFilePath: { type: 'string' },
      envVarName: { type: 'string' },
      rollbackId: { type: 'string' },
    },
  },
  get_ssr_mock_audit_log: {
    type: 'object',
    properties: {
      projectRoot: { type: 'string' },
      rollbackId: { type: 'string' },
      envVarName: { type: 'string' },
      limit: { type: 'number' },
      offset: { type: 'number' },
      maxResponseBytes: { type: 'number' },
    },
  },
  create_mock_route: {
    type: 'object',
    required: ['targetUrl'],
    properties: {
      routeId: { type: 'string' },
      enabled: { type: 'boolean' },
      mode: { type: 'string' },
      method: { type: 'string' },
      matchMode: { type: 'string' },
      targetUrl: { type: 'string' },
      statusCode: { type: 'number' },
      responseHeaders: { type: 'object' },
      bodyJson: {},
      bodyText: { type: 'string' },
      bodyBase64: { type: 'string' },
      bodyFilePath: { type: 'string' },
      delayMs: { type: 'number' },
      sourceKind: { type: 'string' },
      sessionScope: { type: 'string' },
      projectRoot: { type: 'string' },
      ttlMs: { type: 'number' },
    },
  },
  update_mock_route: {
    type: 'object',
    required: ['routeId'],
    properties: {
      routeId: { type: 'string' },
      enabled: { type: 'boolean' },
      mode: { type: 'string' },
      method: { type: 'string' },
      matchMode: { type: 'string' },
      targetUrl: { type: 'string' },
      statusCode: { type: 'number' },
      responseHeaders: { type: 'object' },
      bodyJson: {},
      bodyText: { type: 'string' },
      bodyBase64: { type: 'string' },
      bodyFilePath: { type: 'string' },
      delayMs: { type: 'number' },
      sourceKind: { type: 'string' },
      sessionScope: { type: 'string' },
      projectRoot: { type: 'string' },
      ttlMs: { type: 'number' },
    },
  },
  delete_mock_route: {
    type: 'object',
    required: ['routeId'],
    properties: {
      routeId: { type: 'string' },
    },
  },
  list_mock_routes: {
    type: 'object',
    properties: {
      projectRoot: { type: 'string' },
      mode: { type: 'string' },
      enabled: { type: 'boolean' },
      limit: { type: 'number' },
      offset: { type: 'number' },
      maxResponseBytes: { type: 'number' },
    },
  },
  get_mock_route: {
    type: 'object',
    required: ['routeId'],
    properties: {
      routeId: { type: 'string' },
    },
  },
  get_mock_run_log: {
    type: 'object',
    properties: {
      routeId: { type: 'string' },
      sessionId: { type: 'string' },
      limit: { type: 'number' },
      offset: { type: 'number' },
      maxResponseBytes: { type: 'number' },
    },
  },
  get_mock_hit_log: {
    type: 'object',
    properties: {
      routeId: { type: 'string' },
      runId: { type: 'string' },
      limit: { type: 'number' },
      offset: { type: 'number' },
      maxResponseBytes: { type: 'number' },
    },
  },
  get_mock_status: {
    type: 'object',
    properties: {
      routeId: { type: 'string' },
      projectRoot: { type: 'string' },
    },
  },
  explain_last_failure: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      lookbackSeconds: { type: 'number' },
    },
  },
  get_event_correlation: {
    type: 'object',
    required: ['sessionId', 'eventId'],
    properties: {
      sessionId: { type: 'string' },
      eventId: { type: 'string' },
      windowSeconds: { type: 'number' },
    },
  },
  list_snapshots: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      trigger: { type: 'string' },
      sinceTimestamp: { type: 'number' },
      untilTimestamp: { type: 'number' },
      limit: { type: 'number' },
      offset: { type: 'number' },
      maxResponseBytes: { type: 'number' },
    },
  },
  get_snapshot_for_event: {
    type: 'object',
    required: ['sessionId', 'eventId'],
    properties: {
      sessionId: { type: 'string' },
      eventId: { type: 'string' },
      maxDeltaMs: { type: 'number' },
    },
  },
  get_snapshot_asset: {
    type: 'object',
    required: ['sessionId', 'snapshotId'],
    properties: {
      sessionId: { type: 'string' },
      snapshotId: { type: 'string' },
      asset: { type: 'string' },
      offset: { type: 'number' },
      maxBytes: { type: 'number' },
      encoding: { type: 'string' },
    },
  },
  run_lighthouse_report: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      url: { type: 'string' },
      formFactor: { type: 'string', enum: ['mobile', 'desktop'] },
      categories: {
        type: 'array',
        items: { type: 'string', enum: ['performance', 'accessibility', 'best-practices', 'seo', 'pwa'] },
      },
      maxWaitForLoadMs: { type: 'number' },
      chromeFlags: { type: 'array', items: { type: 'string' } },
    },
  },
  list_lighthouse_reports: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      urlContains: { type: 'string' },
      status: { type: 'string', enum: ['succeeded', 'failed'] },
      limit: { type: 'number' },
      offset: { type: 'number' },
    },
  },
  get_lighthouse_report: {
    type: 'object',
    required: ['reportId'],
    properties: {
      reportId: { type: 'string' },
    },
  },
  get_lighthouse_report_asset: {
    type: 'object',
    required: ['reportId'],
    properties: {
      reportId: { type: 'string' },
      asset: { type: 'string', enum: ['json', 'html'] },
      offset: { type: 'number' },
      maxBytes: { type: 'number' },
      encoding: { type: 'string', enum: ['base64', 'raw'] },
    },
  },
  plan_lighthouse_fixes: {
    type: 'object',
    required: ['reportId'],
    properties: {
      reportId: { type: 'string' },
      minPriority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
      limit: { type: 'number' },
      projectRoot: { type: 'string' },
      routePath: { type: 'string' },
      sourceCandidateLimit: { type: 'number' },
    },
  },
  list_automation_runs: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      status: { type: 'string', enum: ['requested', 'started', 'succeeded', 'failed', 'rejected', 'stopped'] },
      action: { type: 'string', enum: ['click', 'hover', 'input', 'focus', 'blur', 'scroll', 'press_key', 'submit', 'reload'] },
      traceId: { type: 'string' },
      limit: { type: 'number' },
      offset: { type: 'number' },
      maxResponseBytes: { type: 'number' },
    },
  },
  get_automation_run: {
    type: 'object',
    required: ['sessionId', 'runId'],
    properties: {
      sessionId: { type: 'string' },
      runId: { type: 'string' },
      stepLimit: { type: 'number' },
      stepOffset: { type: 'number' },
      maxResponseBytes: { type: 'number' },
    },
  },
  execute_ui_action: {
    type: 'object',
    required: ['sessionId', 'action'],
    properties: {
      sessionId: { type: 'string' },
      action: { type: 'string', enum: ['click', 'hover', 'input', 'focus', 'blur', 'scroll', 'press_key', 'submit', 'reload'] },
      traceId: { type: 'string' },
      target: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          elementRef: { type: 'string' },
          coordinates: {
            type: 'object',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              frameId: { type: 'number' },
            },
          },
          tabId: { type: 'number' },
          frameId: { type: 'number' },
          url: { type: 'string' },
          locator: ACTION_LOCATOR_TOOL_SCHEMA,
          frameUrlContains: { type: 'string' },
          frameTitleContains: { type: 'string' },
          testId: { type: 'string' },
          scope: { type: 'string', enum: ['buttons', 'links', 'inputs', 'modals', 'focused'] },
          textContains: { type: 'string' },
          labelContains: { type: 'string' },
          titleContains: { type: 'string' },
          role: { type: 'string' },
          name: { type: 'string' },
          placeholder: { type: 'string' },
          altText: { type: 'string' },
          exact: { type: 'boolean' },
          nth: { type: 'number' },
          first: { type: 'boolean' },
          last: { type: 'boolean' },
          strict: { type: 'boolean' },
          tagName: { type: 'string' },
          type: { type: 'string' },
          visible: { type: 'boolean' },
          enabled: { type: 'boolean' },
          disabled: { type: 'boolean' },
          editable: { type: 'boolean' },
          checked: { type: 'boolean' },
          selected: { type: 'boolean' },
          pressed: { type: 'boolean' },
          expanded: { type: 'boolean' },
          readOnly: { type: 'boolean' },
          requiredField: { type: 'boolean' },
        },
      },
      input: { type: 'object' },
      captureOnFailure: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          selector: { type: 'string' },
          mode: { type: 'string', enum: ['dom', 'png', 'both'] },
          styleMode: { type: 'string', enum: ['computed-lite', 'computed-full'] },
          maxDepth: { type: 'number' },
          maxBytes: { type: 'number' },
          maxAncestors: { type: 'number' },
          includeDom: { type: 'boolean' },
          includeStyles: { type: 'boolean' },
          includePngDataUrl: { type: 'boolean' },
        },
      },
      waitForPageState: {
        type: 'object',
        required: ['scope'],
        properties: {
          scope: { type: 'string', enum: ['buttons', 'links', 'inputs', 'modals', 'focused', 'page'] },
          selector: { type: 'string' },
          testId: { type: 'string' },
          textContains: { type: 'string' },
          labelContains: { type: 'string' },
          titleContains: { type: 'string' },
          role: { type: 'string' },
          name: { type: 'string' },
          placeholder: { type: 'string' },
          altText: { type: 'string' },
          exact: { type: 'boolean' },
          frameUrlContains: { type: 'string' },
          frameTitleContains: { type: 'string' },
          urlContains: { type: 'string' },
          language: { type: 'string' },
          visible: { type: 'boolean' },
          disabled: { type: 'boolean' },
          selected: { type: 'boolean' },
          pressed: { type: 'boolean' },
          expanded: { type: 'boolean' },
          readOnly: { type: 'boolean' },
          requiredField: { type: 'boolean' },
          tagName: { type: 'string' },
          type: { type: 'string' },
          countExactly: { type: 'number' },
          countAtLeast: { type: 'number' },
          maxItems: { type: 'number' },
          maxTextLength: { type: 'number' },
          timeoutMs: { type: 'number' },
          pollIntervalMs: { type: 'number' },
        },
      },
    },
  },
  run_ui_steps: {
    type: 'object',
    required: ['sessionId', 'steps'],
    properties: {
      sessionId: { type: 'string' },
      mode: { type: 'string', enum: ['safe', 'fast'] },
      stopOnFailure: { type: 'boolean' },
      defaultTimeoutMs: { type: 'number' },
      defaultPollIntervalMs: { type: 'number' },
      steps: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['kind'],
          properties: {
            id: { type: 'string' },
            note: { type: 'string' },
            kind: { type: 'string', enum: ['action', 'waitFor', 'assert', 'wait'] },
            action: { type: 'string' },
            traceId: { type: 'string' },
            target: {
              type: 'object',
              properties: {
                selector: { type: 'string' },
                elementRef: { type: 'string' },
                coordinates: {
                  type: 'object',
                  properties: {
                    x: { type: 'number' },
                    y: { type: 'number' },
                    frameId: { type: 'number' },
                  },
                },
                tabId: { type: 'number' },
                frameId: { type: 'number' },
                url: { type: 'string' },
                locator: ACTION_LOCATOR_TOOL_SCHEMA,
                frameUrlContains: { type: 'string' },
                frameTitleContains: { type: 'string' },
                testId: { type: 'string' },
                scope: { type: 'string', enum: ['buttons', 'links', 'inputs', 'modals', 'focused'] },
                textContains: { type: 'string' },
                labelContains: { type: 'string' },
                titleContains: { type: 'string' },
                role: { type: 'string' },
                name: { type: 'string' },
                placeholder: { type: 'string' },
                altText: { type: 'string' },
                exact: { type: 'boolean' },
                nth: { type: 'number' },
                first: { type: 'boolean' },
                last: { type: 'boolean' },
                strict: { type: 'boolean' },
                tagName: { type: 'string' },
                type: { type: 'string' },
                visible: { type: 'boolean' },
                disabled: { type: 'boolean' },
                selected: { type: 'boolean' },
                pressed: { type: 'boolean' },
                expanded: { type: 'boolean' },
                readOnly: { type: 'boolean' },
                requiredField: { type: 'boolean' },
              },
            },
            input: { type: 'object' },
            onFailure: {
              type: 'object',
              properties: {
                strategy: { type: 'string', enum: ['stop', 'continue', 'retry_once'] },
                capture: {
                  type: 'object',
                  properties: {
                    enabled: { type: 'boolean' },
                    selector: { type: 'string' },
                    mode: { type: 'string', enum: ['dom', 'png', 'both'] },
                    styleMode: { type: 'string', enum: ['computed-lite', 'computed-full'] },
                    maxDepth: { type: 'number' },
                    maxBytes: { type: 'number' },
                    maxAncestors: { type: 'number' },
                    includeDom: { type: 'boolean' },
                    includeStyles: { type: 'boolean' },
                    includePngDataUrl: { type: 'boolean' },
                  },
                },
              },
            },
            matcher: {
              type: 'object',
              properties: {
                scope: { type: 'string', enum: ['buttons', 'links', 'inputs', 'modals', 'focused', 'page'] },
                selector: { type: 'string' },
                testId: { type: 'string' },
                textContains: { type: 'string' },
                labelContains: { type: 'string' },
                titleContains: { type: 'string' },
                role: { type: 'string' },
                name: { type: 'string' },
                placeholder: { type: 'string' },
                altText: { type: 'string' },
                exact: { type: 'boolean' },
                frameUrlContains: { type: 'string' },
                frameTitleContains: { type: 'string' },
                urlContains: { type: 'string' },
                language: { type: 'string' },
                visible: { type: 'boolean' },
                disabled: { type: 'boolean' },
                selected: { type: 'boolean' },
                pressed: { type: 'boolean' },
                expanded: { type: 'boolean' },
                readOnly: { type: 'boolean' },
                requiredField: { type: 'boolean' },
                tagName: { type: 'string' },
                type: { type: 'string' },
                countExactly: { type: 'number' },
                countAtLeast: { type: 'number' },
                maxItems: { type: 'number' },
                maxTextLength: { type: 'number' },
                timeoutMs: { type: 'number' },
                pollIntervalMs: { type: 'number' },
              },
            },
            wait: AUTOMATION_WAIT_TOOL_SCHEMA,
          },
        },
      },
    },
  },
};

const TOOL_DESCRIPTIONS: Record<string, string> = {
  list_sessions: 'List captured debugging sessions',
  get_session_summary: 'Get summary counters for one session',
  get_recent_events: 'Read recent events from a session',
  get_navigation_history: 'Read navigation events for a session',
  get_console_events: 'Read console events for a session',
  get_console_summary: 'Summarize console volume and top repeated messages',
  get_event_summary: 'Summarize event volume and type distribution',
  get_error_fingerprints: 'List aggregated error fingerprints',
  get_network_failures: 'List network failures and groupings',
  get_network_calls: 'Query network calls with targeted filters and optional sanitized bodies',
  wait_for_network_call: 'Wait for the next matching network call and return it deterministically',
  get_request_trace: 'Get correlated UI/events/network chain by requestId or traceId',
  get_body_chunk: 'Retrieve a chunk from a stored large body payload',
  get_element_refs: 'Get element references by selector',
  get_dom_subtree: 'Capture a bounded DOM subtree',
  get_dom_document: 'Capture full document as outline or html',
  get_computed_styles: 'Read computed CSS styles for an element',
  get_layout_metrics: 'Read viewport and element layout metrics',
  get_page_state: 'Read a compact structured page model for forms, buttons, modals, and viewport state',
  get_interactive_elements: 'Read compact live element references for buttons, links, inputs, modals, and focused elements',
  get_live_session_health: 'Read live transport health and session binding details for one session',
  set_viewport: 'Resize the live browser window for a session and return the resulting viewport metrics',
  assert_page_state: 'Assert compact page-state conditions without pulling raw DOM payloads',
  wait_for_page_state: 'Poll compact page state until a structured assertion becomes true',
  preflight_automation_flow: 'Check live-session readiness and production risks before running an automation flow',
  wait_for_url: 'Poll the live page URL until it matches an exact, contains, or regex condition',
  wait_for_navigation: 'Poll persisted navigation events until a matching URL or trigger is observed',
  wait_for_navigation_lifecycle: 'Wait for a live navigation lifecycle milestone such as commit, load, or network idle',
  wait_for_load_state: 'Poll the live page document readiness until domcontentloaded or load is reached',
  wait_for_selector_state: 'Poll a selector until it is attached, detached, visible, or hidden',
  wait_for_console: 'Poll live console logs until a matching message appears',
  wait_for_dialog: 'Wait for a native JavaScript dialog and optionally accept or dismiss it',
  wait_for_stable_layout: 'Wait until the page or selector layout stays unchanged for a stable window',
  wait_for_download: 'Wait for a download started by the bound tab and optionally until completion',
  wait_for_popup: 'Wait for a popup tab or window opened from the bound session tab',
  wait_for_network_quiet: 'Wait until persisted network activity is quiet for a bounded window',
  wait_for_request: 'Poll persisted network activity until a matching request is observed',
  wait_for_response: 'Poll persisted network activity until a matching response is observed',
  capture_ui_snapshot: 'Capture redacted UI snapshot (DOM/styles/optional PNG) and persist it',
  get_live_console_logs: 'Read in-memory live console logs for a connected session',
  list_override_profiles: 'List configured browser override profiles',
  create_override_profile: 'Generate a candidate browser override profile from local build assets',
  validate_override_profile: 'Validate the current browser override profile and local asset readiness',
  preflight_overrides: 'Run production-safety checks before enabling browser overrides for a live session',
  observe_override_assets: 'Observe production render artifacts from a live extension tab',
  capture_override_response_body: 'Capture a bounded text response body from a live extension session for override planning, using extension fetch or explicit CDP response-stage capture',
  list_observed_override_assets: 'List persisted production render artifacts observed for a session',
  map_next_override_assets: 'Map observed production Next.js assets to local build chunks and source paths',
  plan_override_response_patch: 'Patch a supplied or live-captured text response body with literal textPatches or JSON Pointer jsonPatches and write an exact or prefix override rule for supported response types',
  plan_next_source_override: 'Apply source edits in a temp Next.js overlay build and plan exact browser override rules',
  enable_overrides: 'Enable browser overrides for a live extension session',
  disable_overrides: 'Disable browser overrides for a live extension session',
  get_override_status: 'Read live or persisted browser override status for a session',
  get_override_request_log: 'Read persisted browser override request audit rows',
  get_override_plan_log: 'Read persisted generated override plan audit rows with previews, hashes, and rollback metadata',
  diagnose_overrides: 'Diagnose persisted browser override runs and failure indicators',
  discover_ssr_mockability: 'Inspect a local project for env-driven or central-client SSR mock injection points',
  apply_ssr_mock_config: 'Apply a temporary SSR mock base URL by commenting the old env value and writing a managed replacement',
  remove_ssr_mock_config: 'Restore or remove a managed SSR mock env patch from a local env file',
  get_ssr_mock_audit_log: 'Read persisted SSR mock discovery and env patch audit rows',
  create_mock_route: 'Create or persist a reusable browser or SSR mock route',
  update_mock_route: 'Update an existing mock route definition',
  delete_mock_route: 'Delete a persisted mock route',
  list_mock_routes: 'List persisted mock route definitions',
  get_mock_route: 'Read one persisted mock route definition',
  get_mock_run_log: 'Read persisted mock route run records',
  get_mock_hit_log: 'Read persisted mock route hit records',
  get_mock_status: 'Summarize persisted mock route, run, and hit state',
  explain_last_failure: 'Explain the latest failure timeline',
  get_event_correlation: 'Correlate related events by window',
  list_snapshots: 'List snapshot metadata by session/time/trigger',
  get_snapshot_for_event: 'Find snapshot most related to an event',
  get_snapshot_asset: 'Read bounded binary chunks for snapshot assets',
  run_lighthouse_report: 'Run an official Lighthouse report for a URL or session URL and persist JSON/HTML artifacts',
  list_lighthouse_reports: 'List persisted Lighthouse report metadata',
  get_lighthouse_report: 'Read one persisted Lighthouse report summary',
  get_lighthouse_report_asset: 'Read bounded chunks from a persisted Lighthouse JSON or HTML report artifact',
  plan_lighthouse_fixes: 'Create a prioritized fix plan from a persisted Lighthouse report',
  list_automation_runs: 'List first-class automation runs from dedicated automation tables',
  get_automation_run: 'Inspect one automation run with bounded step details',
  execute_ui_action: 'Execute one live UI action in the current bound extension session',
  run_ui_steps: 'Run a small generic UI workflow locally in the bridge using actions, waits, and assertions',
};

const ALL_TOOLS = Object.keys(TOOL_SCHEMAS);

const DEFAULT_REDACTION_SUMMARY: RedactionSummary = {
  totalFields: 0,
  redactedFields: 0,
  rulesApplied: [],
};

const DEFAULT_LIST_LIMIT = 25;
const DEFAULT_EVENT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_SNAPSHOT_ASSET_CHUNK_BYTES = 64 * 1024;
const MAX_SNAPSHOT_ASSET_CHUNK_BYTES = 256 * 1024;
const DEFAULT_BODY_CHUNK_BYTES = 64 * 1024;
const MAX_BODY_CHUNK_BYTES = 256 * 1024;
const DEFAULT_NETWORK_POLL_TIMEOUT_MS = 15_000;
const MAX_NETWORK_POLL_TIMEOUT_MS = 120_000;
const DEFAULT_NETWORK_POLL_INTERVAL_MS = 250;
const DEFAULT_AUTOMATION_WAIT_LOOKBACK_MS = 5_000;
const LIVE_SESSION_DISCONNECTED_CODE = 'LIVE_SESSION_DISCONNECTED';
const OVERRIDE_LIVE_COMMAND_TIMEOUT_CODE = 'OVERRIDE_LIVE_COMMAND_TIMEOUT';
const OVERRIDE_LIVE_COMMAND_FAILED_CODE = 'OVERRIDE_LIVE_COMMAND_FAILED';
const STALE_LIVE_CONNECTION_GRACE_WINDOW_MS = 30 * 60 * 1000;
const NOISE_SESSION_HOST_PATTERNS = [
  /(^|\.)adtrafficquality\.google$/i,
  /(^|\.)doubleclick\.net$/i,
  /(^|\.)googlesyndication\.com$/i,
  /(^|\.)googleadservices\.com$/i,
  /(^|\.)recaptcha\.net$/i,
  /(^|\.)gstatic\.com$/i,
];
const NOISE_SESSION_PATH_PATTERNS = [/\/sodar/i, /\/recaptcha/i, /runner\.html$/i];
const NETWORK_CALL_SELECT_COLUMNS = `
  request_id, session_id, trace_id, tab_id, ts_start, duration_ms, method, url, origin, status, initiator, error_class, response_size_est,
  request_content_type, request_body_text, request_body_json, request_body_bytes, request_body_truncated, request_body_chunk_ref,
  response_content_type, response_body_text, response_body_json, response_body_bytes, response_body_truncated, response_body_chunk_ref
`;

interface SessionScopeAssessment {
  kind: 'top_level_page' | 'likely_iframe_noise' | 'unknown';
  note: string;
  origin?: string;
  host?: string;
  isLocalhost?: boolean;
}

const NETWORK_DOMAIN_GROUP_SQL = `
  CASE
    WHEN instr(replace(replace(url, 'https://', ''), 'http://', ''), '/') > 0
      THEN substr(
        replace(replace(url, 'https://', ''), 'http://', ''),
        1,
        instr(replace(replace(url, 'https://', ''), 'http://', ''), '/') - 1
      )
    ELSE replace(replace(url, 'https://', ''), 'http://', '')
  END
`;

interface SessionRow {
  session_id: string;
  created_at: number;
  last_seen_at: number | null;
  paused_at: number | null;
  ended_at: number | null;
  tab_id: number | null;
  window_id: number | null;
  url_start: string | null;
  url_last: string | null;
  user_agent: string | null;
  viewport_w: number | null;
  viewport_h: number | null;
  dpr: number | null;
  safe_mode: number;
  pinned: number;
}

interface EventRow {
  event_id: string;
  session_id: string;
  ts: number;
  type: string;
  payload_json: string;
  tab_id: number | null;
  origin: string | null;
}

interface ErrorFingerprintRow {
  fingerprint: string;
  session_id: string;
  count: number;
  sample_message: string;
  sample_stack: string | null;
  first_seen_at: number;
  last_seen_at: number;
}

interface NetworkFailureRow {
  request_id: string;
  session_id: string;
  trace_id: string | null;
  tab_id: number | null;
  ts_start: number;
  duration_ms: number | null;
  method: string;
  url: string;
  origin: string | null;
  status: number | null;
  initiator: string | null;
  error_class: string | null;
}

interface NetworkCallRow {
  request_id: string;
  session_id: string;
  trace_id: string | null;
  tab_id: number | null;
  ts_start: number;
  duration_ms: number | null;
  method: string;
  url: string;
  origin: string | null;
  status: number | null;
  initiator: string | null;
  error_class: string | null;
  response_size_est: number | null;
  request_content_type: string | null;
  request_body_text: string | null;
  request_body_json: string | null;
  request_body_bytes: number | null;
  request_body_truncated: number;
  request_body_chunk_ref: string | null;
  response_content_type: string | null;
  response_body_text: string | null;
  response_body_json: string | null;
  response_body_bytes: number | null;
  response_body_truncated: number;
  response_body_chunk_ref: string | null;
}

interface BodyChunkRow {
  chunk_ref: string;
  session_id: string;
  request_id: string | null;
  trace_id: string | null;
  body_kind: string;
  content_type: string | null;
  body_text: string;
  body_bytes: number;
  truncated: number;
  created_at: number;
}

interface GroupedNetworkFailureRow {
  group_key: string;
  count: number;
  first_ts: number;
  last_ts: number;
}

interface SnapshotRow {
  snapshot_id: string;
  session_id: string;
  trigger_event_id: string | null;
  ts: number;
  trigger: string;
  selector: string | null;
  url: string | null;
  mode: string;
  style_mode: string | null;
  dom_json: string | null;
  styles_json: string | null;
  png_path: string | null;
  png_mime: string | null;
  png_bytes: number | null;
  dom_truncated: number;
  styles_truncated: number;
  png_truncated: number;
  created_at: number;
}

interface AutomationRunRow {
  run_id: string;
  session_id: string;
  trace_id: string | null;
  action: string | null;
  tab_id: number | null;
  selector: string | null;
  status: string;
  started_at: number;
  completed_at: number | null;
  stop_reason: string | null;
  target_summary_json: string | null;
  diagnostics_json: string | null;
  failure_json: string | null;
  redaction_json: string | null;
  created_at: number;
  updated_at: number;
  step_count: number;
  last_step_at: number | null;
}

interface AutomationStepRow {
  step_id: string;
  run_id: string;
  session_id: string;
  step_order: number;
  trace_id: string | null;
  action: string;
  selector: string | null;
  status: string;
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  tab_id: number | null;
  target_summary_json: string | null;
  diagnostics_json: string | null;
  redaction_json: string | null;
  failure_json: string | null;
  input_metadata_json: string | null;
  event_type: string;
  event_id: string | null;
  created_at: number;
  updated_at: number;
}

interface CorrelationCandidate {
  eventId: string;
  type: string;
  timestamp: number;
  payload?: Record<string, unknown>;
  correlationScore: number;
  relationship: string;
  deltaMs: number;
}

type ResponseProfile = 'legacy' | 'compact';

interface ByteBudgetResult<T> {
  items: T[];
  responseBytes: number;
  truncatedByBytes: boolean;
}

export interface CaptureClientResult {
  ok: boolean;
  payload?: Record<string, unknown>;
  truncated?: boolean;
  error?: string;
}

type CaptureCommandName =
  | 'CAPTURE_DOM_SUBTREE'
  | 'CAPTURE_DOM_DOCUMENT'
  | 'CAPTURE_COMPUTED_STYLES'
  | 'CAPTURE_LAYOUT_METRICS'
  | 'CAPTURE_PAGE_STATE'
  | 'CAPTURE_UI_SNAPSHOT'
  | 'CAPTURE_GET_LIVE_CONSOLE_LOGS'
  | 'CAPTURE_WAIT_FOR_NAVIGATION_LIFECYCLE'
  | 'CAPTURE_WAIT_FOR_DIALOG'
  | 'CAPTURE_WAIT_FOR_STABLE_LAYOUT'
  | 'CAPTURE_WAIT_FOR_DOWNLOAD'
  | 'CAPTURE_WAIT_FOR_POPUP'
  | 'CAPTURE_OVERRIDE_OBSERVE_ASSETS'
  | 'CAPTURE_OVERRIDE_RESPONSE_BODY'
  | 'CAPTURE_OVERRIDE_POC_GET_STATUS'
  | 'CAPTURE_OVERRIDE_POC_ENABLE'
  | 'CAPTURE_OVERRIDE_POC_DISABLE'
  | 'SET_VIEWPORT'
  | 'EXECUTE_UI_ACTION';

export interface CaptureCommandClient {
  execute(
    sessionId: string,
    command: CaptureCommandName,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<CaptureClientResult>;
}

interface SnapshotResponseOptions {
  includeDom: boolean;
  includeStyles: boolean;
  includePngDataUrl: boolean;
}

interface FailureEvidenceCaptureOptions extends SnapshotResponseOptions {
  enabled: boolean;
  selector?: string;
  mode: 'dom' | 'png' | 'both';
  styleMode: 'computed-lite' | 'computed-full';
  explicitStyleMode: boolean;
  maxDepth: number;
  maxBytes: number;
  maxAncestors: number;
}

class LiveSessionDisconnectedError extends Error {
  readonly code = LIVE_SESSION_DISCONNECTED_CODE;

  constructor(sessionId: string, reason?: string) {
    const normalizedReason = typeof reason === 'string' && reason.trim().length > 0
      ? reason.trim()
      : 'Extension connection is stale or unavailable';
    super(
      `${LIVE_SESSION_DISCONNECTED_CODE}: Session ${sessionId} is not connected to a live extension target. ${normalizedReason}. Start a fresh session in the extension and retry with a connected sessionId from list_sessions.`,
    );
    this.name = 'LiveSessionDisconnectedError';
  }
}

function resolveLimit(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const floored = Math.floor(value);
  if (floored < 1) {
    return fallback;
  }

  return Math.min(floored, MAX_LIMIT);
}

function resolveOffset(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }

  const floored = Math.floor(value);
  return floored < 0 ? 0 : floored;
}

function resolveResponseProfile(value: unknown): ResponseProfile {
  return value === 'compact' ? 'compact' : 'legacy';
}

function resolveMaxResponseBytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_MAX_RESPONSE_BYTES;
  }

  const floored = Math.floor(value);
  if (floored < 1_024) {
    return DEFAULT_MAX_RESPONSE_BYTES;
  }

  return Math.min(floored, MAX_RESPONSE_BYTES);
}

function createSsrMockAuditRecord(input: {
  action: SsrMockAuditRecord['action'];
  status: SsrMockAuditStatus;
  projectRoot: string;
  targetUrl?: string | null;
  apiHost?: string | null;
  envVarName?: string | null;
  envFilePath?: string | null;
  mockBaseUrl?: string | null;
  rollbackId?: string | null;
  summary?: unknown;
  result?: unknown;
}): SsrMockAuditRecord {
  return {
    auditId: randomUUID(),
    createdAt: Date.now(),
    action: input.action,
    status: input.status,
    projectRoot: input.projectRoot,
    targetUrl: input.targetUrl ?? null,
    apiHost: input.apiHost ?? null,
    envVarName: input.envVarName ?? null,
    envFilePath: input.envFilePath ?? null,
    mockBaseUrl: input.mockBaseUrl ?? null,
    rollbackId: input.rollbackId ?? null,
    summary: input.summary ?? null,
    result: input.result ?? null,
  };
}

function estimateJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf-8');
}

function applyByteBudget<T>(items: T[], maxResponseBytes: number): ByteBudgetResult<T> {
  if (items.length === 0) {
    return {
      items: [],
      responseBytes: 2, // []
      truncatedByBytes: false,
    };
  }

  const selected: T[] = [];
  let usedBytes = 2; // []
  let truncatedByBytes = false;

  for (const item of items) {
    const itemBytes = estimateJsonBytes(item);
    const separatorBytes = selected.length > 0 ? 1 : 0; // comma
    const nextBytes = usedBytes + separatorBytes + itemBytes;

    if (nextBytes > maxResponseBytes && selected.length > 0) {
      truncatedByBytes = true;
      break;
    }

    selected.push(item);
    usedBytes = nextBytes;
  }

  if (!truncatedByBytes && selected.length < items.length) {
    truncatedByBytes = true;
  }

  return {
    items: selected,
    responseBytes: usedBytes,
    truncatedByBytes,
  };
}

function buildOffsetPagination(
  offset: number,
  returned: number,
  hasMore: boolean,
  maxResponseBytes: number,
): Record<string, unknown> {
  return {
    offset,
    returned,
    hasMore,
    nextOffset: hasMore ? offset + returned : null,
    maxResponseBytes,
  };
}

function readJsonPayload(payloadJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed payloads and return an empty object
  }

  return {};
}

function mapRequestedEventType(type: string): string {
  switch (type) {
    case 'navigation':
      return 'nav';
    case 'click':
    case 'scroll':
    case 'input':
    case 'change':
    case 'submit':
    case 'focus':
    case 'blur':
    case 'keydown':
    case 'custom':
      return 'ui';
    default:
      return type;
  }
}

function parseRequestedTypes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = value
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    .map((entry) => mapRequestedEventType(entry));

  return Array.from(new Set(normalized));
}

function normalizeRequestedOrigin(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error('url must be a string');
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('url must use http:// or https://');
    }
    return parsed.origin;
  } catch {
    throw new Error('url must be a valid absolute http(s) URL');
  }
}

function ensureSessionOrOriginFilter(sessionId: string | undefined, origin: string | undefined): void {
  if (!sessionId && !origin) {
    throw new Error('sessionId or url is required');
  }
}

function resolveUrlPrefixFromOrigin(origin: string): string {
  return origin.endsWith('/') ? origin : origin + '/';
}

function appendEventOriginFilter(where: string[], params: unknown[], origin: string | undefined): void {
  if (!origin) {
    return;
  }

  const prefix = resolveUrlPrefixFromOrigin(origin);
  where.push(`
    (
      origin = ?
      OR (
        origin IS NULL AND (
          json_extract(payload_json, '$.origin') = ?
          OR json_extract(payload_json, '$.url') = ?
          OR json_extract(payload_json, '$.url') LIKE ?
          OR json_extract(payload_json, '$.to') = ?
          OR json_extract(payload_json, '$.to') LIKE ?
          OR json_extract(payload_json, '$.href') = ?
          OR json_extract(payload_json, '$.href') LIKE ?
          OR json_extract(payload_json, '$.location') = ?
          OR json_extract(payload_json, '$.location') LIKE ?
        )
      )
    )
  `);
  params.push(origin, origin, origin, `${prefix}%`, origin, `${prefix}%`, origin, `${prefix}%`, origin, `${prefix}%`);
}

function appendNetworkOriginFilter(where: string[], params: unknown[], origin: string | undefined): void {
  if (!origin) {
    return;
  }

  const prefix = resolveUrlPrefixFromOrigin(origin);
  where.push('(origin = ? OR (origin IS NULL AND (url = ? OR url LIKE ?)))');
  params.push(origin, origin, `${prefix}%`);
}

function resolveLastUrl(payload: Record<string, unknown>): string | undefined {
  const candidates = [payload.url, payload.to, payload.href, payload.location];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }

  return undefined;
}

function classifySessionUrl(urlValue: string | null | undefined): SessionScopeAssessment {
  if (!urlValue) {
    return {
      kind: 'unknown',
      note: 'No session URL is available yet.',
    };
  }

  try {
    const parsed = new URL(urlValue);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    const origin = parsed.origin;
    const isLocalhost = host === 'localhost' || host === '127.0.0.1';

    if (
      NOISE_SESSION_HOST_PATTERNS.some((pattern) => pattern.test(host))
      || NOISE_SESSION_PATH_PATTERNS.some((pattern) => pattern.test(pathname))
    ) {
      return {
        kind: 'likely_iframe_noise',
        note: 'Last URL looks like third-party iframe/ad traffic rather than the app surface.',
        origin,
        host,
        isLocalhost,
      };
    }

    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return {
        kind: 'top_level_page',
        note: isLocalhost
          ? 'Last URL looks like a local top-level app page.'
          : 'Last URL looks like a top-level app page.',
        origin,
        host,
        isLocalhost,
      };
    }
  } catch {
    return {
      kind: 'unknown',
      note: 'Session URL could not be parsed.',
    };
  }

  return {
    kind: 'unknown',
    note: 'Session URL does not use an http(s) page origin.',
  };
}

function getSessionStatus(row: Pick<SessionRow, 'paused_at' | 'ended_at'>): 'active' | 'paused' | 'ended' {
  if (row.ended_at) {
    return 'ended';
  }
  if (row.paused_at) {
    return 'paused';
  }
  return 'active';
}

function buildOverrideProfileRecords(): Record<string, unknown>[] {
  const summary = getOverridePocConfigSummary();
  return summary.profiles.map((profile) => ({
    profileId: profile.profileId,
    name: profile.name,
    active: profile.profileId === summary.activeProfileId,
    configEnabled: summary.configEnabled,
    enabled: profile.enabled,
    effectiveEnabled: profile.enabled && profile.enabledRuleCount > 0,
    autoReload: profile.autoReload,
    configPath: summary.configPath,
    fileExists: profile.fileExists,
    ruleCount: profile.ruleCount,
    enabledRuleCount: profile.enabledRuleCount,
    rules: profile.rules,
  }));
}

function resolveOverrideProfileRecord(value: unknown): Record<string, unknown> {
  const profiles = buildOverrideProfileRecords();
  const fallbackProfileId = typeof profiles[0]?.profileId === 'string' ? profiles[0].profileId : 'poc';
  const requestedProfileId = typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallbackProfileId;
  const profile = profiles.find((candidate) => candidate.profileId === requestedProfileId);
  if (!profile) {
    throw new Error(`Unknown override profile: ${requestedProfileId}`);
  }

  return profile;
}

function resolveOverrideResponseProfile(value: unknown): 'compact' | 'full' {
  return value === 'full' ? 'full' : 'compact';
}

function compactOverrideRule(rule: unknown): Record<string, unknown> {
  if (!isRecord(rule)) {
    return {};
  }
  return {
    ruleId: rule.ruleId,
    enabled: rule.enabled,
    ruleType: rule.ruleType,
    requestMethod: rule.requestMethod,
    matchMode: rule.matchMode,
    targetAssetUrl: rule.targetAssetUrl,
    localFilePath: rule.localFilePath,
    contentType: rule.contentType,
    fileExists: rule.fileExists,
    integrity: rule.integrity,
  };
}

function compactOverrideProfile(profile: Record<string, unknown>, ruleLimit = 10): Record<string, unknown> {
  const rules = Array.isArray(profile.rules) ? profile.rules : [];
  return {
    profileId: profile.profileId,
    name: profile.name,
    active: profile.active,
    configEnabled: profile.configEnabled,
    enabled: profile.enabled,
    effectiveEnabled: profile.effectiveEnabled,
    autoReload: profile.autoReload,
    configPath: profile.configPath,
    fileExists: profile.fileExists,
    ruleCount: profile.ruleCount,
    enabledRuleCount: profile.enabledRuleCount,
    rules: rules.slice(0, ruleLimit).map(compactOverrideRule),
    rulesOmitted: Math.max(0, rules.length - ruleLimit),
  };
}

function serializeOverrideProfile(profile: Record<string, unknown>, responseProfile: 'compact' | 'full'): Record<string, unknown> {
  return responseProfile === 'full' ? profile : compactOverrideProfile(profile);
}

function compactObservedOverrideAsset(asset: unknown): Record<string, unknown> {
  if (!isRecord(asset)) {
    return {};
  }
  return {
    observedAssetId: asset.observedAssetId,
    lastSeenAt: asset.lastSeenAt,
    tabId: asset.tabId,
    url: asset.url,
    ruleType: asset.ruleType,
    requestMethod: asset.requestMethod,
    resourceType: asset.resourceType,
    contentType: asset.contentType,
    statusCode: asset.statusCode,
    pathname: asset.pathname,
    assetPath: asset.assetPath,
    kind: asset.kind,
    integrity: asset.integrity,
    fromDom: asset.fromDom,
    fromPerformance: asset.fromPerformance,
    fromNavigation: asset.fromNavigation,
    fromFetch: asset.fromFetch,
    serviceWorkerControlled: asset.serviceWorkerControlled,
  };
}

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isRecordWithRscFlightMetadata(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && (
      value.productionMode === 'structured-flight-v1' && value.patchKind === 'string-value-text'
      || value.productionMode === 'literal-response-v1' && value.patchKind === 'literal-text'
    )
    && value.source !== undefined
    && value.patchKind !== undefined;
}

function normalizeRuleStringHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const headers: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(value)) {
    if (typeof rawValue !== 'string') {
      continue;
    }
    const normalizedName = name.trim().toLowerCase();
    const normalizedValue = rawValue.trim();
    if (normalizedName.length > 0 && normalizedValue.length > 0) {
      headers[normalizedName] = normalizedValue;
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function getRscFlightRuleRequestHeaders(rule: Record<string, unknown>): Record<string, string> | undefined {
  return isRecord(rule.rscFlight) ? normalizeRuleStringHeaders(rule.rscFlight.requestHeaders) : undefined;
}

function getOverrideRuleRequestHeaders(rule: Record<string, unknown>): Record<string, string> | undefined {
  return normalizeRuleStringHeaders(rule.requestHeaders) ?? getRscFlightRuleRequestHeaders(rule);
}

function buildRscFlightRuleIssues(rule: Record<string, unknown>): Array<Record<string, unknown>> {
  const ruleId = String(rule.ruleId ?? 'unknown');
  const issues: Array<Record<string, unknown>> = [];
  const rscFlight = rule.rscFlight;
  if (!isRecordWithRscFlightMetadata(rscFlight)) {
    return [{
      code: 'UNSUPPORTED_RSC_FLIGHT_RULE',
      severity: 'error',
      message: `Rule ${ruleId} targets a Next.js RSC flight response without production RSC metadata generated by the response planner.`,
    }];
  }

  const source = rscFlight.source;
  if (source !== 'cdp-response' && source !== 'extension-fetch') {
    issues.push({
      code: 'RSC_FLIGHT_METADATA_INVALID',
      severity: 'error',
      message: `Rule ${ruleId} RSC metadata source must be cdp-response or extension-fetch.`,
    });
  }

  if (!Array.isArray(rscFlight.textPatches) || rscFlight.textPatches.length === 0) {
    issues.push({
      code: 'RSC_FLIGHT_PATCHES_INVALID',
      severity: 'error',
      message: `Rule ${ruleId} RSC flight metadata must include string-value text patches.`,
    });
  } else {
    for (const [index, patch] of rscFlight.textPatches.entries()) {
      if (
        !isRecord(patch)
        || typeof patch.search !== 'string'
        || patch.search.length === 0
        || typeof patch.replacement !== 'string'
        || typeof patch.expectedCount !== 'number'
        || !Number.isFinite(patch.expectedCount)
        || patch.expectedCount < 0
      ) {
        issues.push({
          code: 'RSC_FLIGHT_PATCHES_INVALID',
          severity: 'error',
          message: `Rule ${ruleId} RSC flight textPatches[${index}] is invalid.`,
        });
      }
    }
  }

  const requestMethod = normalizeOverrideRequestMethod(rule.requestMethod);
  const requestHeaders = getRscFlightRuleRequestHeaders(rule);
  const isCapturedPostRscFlight = requestMethod === 'POST' && requestHeaders?.rsc === '1';
  if (requestMethod !== 'GET' && !isCapturedPostRscFlight) {
    issues.push({
      code: 'RSC_FLIGHT_METHOD_UNSUPPORTED',
      severity: 'error',
      message: `Rule ${ruleId} RSC flight overrides only support GET requests or captured POST RSC response-stage patches.`,
    });
  }

  const targetAssetUrl = typeof rule.targetAssetUrl === 'string' ? rule.targetAssetUrl : '';
  try {
    const parsed = new URL(targetAssetUrl);
    if (requestMethod === 'GET' && !parsed.searchParams.has('_rsc')) {
      issues.push({
        code: 'RSC_FLIGHT_TARGET_INVALID',
        severity: 'error',
        message: `Rule ${ruleId} RSC flight targetAssetUrl must include the _rsc search parameter.`,
      });
    }
  } catch {
    issues.push({
      code: 'RSC_FLIGHT_TARGET_INVALID',
      severity: 'error',
      message: `Rule ${ruleId} RSC flight targetAssetUrl must be an absolute http(s) URL.`,
    });
  }

  const contentType = typeof rule.contentType === 'string' ? rule.contentType : '';
  const metadataContentType = typeof rscFlight.contentType === 'string' ? rscFlight.contentType : '';
  if (!contentType.toLowerCase().includes('text/x-component') || !metadataContentType.toLowerCase().includes('text/x-component')) {
    issues.push({
      code: 'RSC_FLIGHT_CONTENT_TYPE_INVALID',
      severity: 'error',
      message: `Rule ${ruleId} RSC flight overrides require text/x-component content types.`,
    });
  }

  const originalSha256 = typeof rscFlight.originalSha256 === 'string' ? rscFlight.originalSha256 : '';
  const patchedSha256 = typeof rscFlight.patchedSha256 === 'string' ? rscFlight.patchedSha256 : '';
  if (!SHA256_HEX_PATTERN.test(originalSha256) || !SHA256_HEX_PATTERN.test(patchedSha256) || originalSha256 === patchedSha256) {
    issues.push({
      code: 'RSC_FLIGHT_HASH_INVALID',
      severity: 'error',
      message: `Rule ${ruleId} RSC flight metadata must include distinct original and patched sha256 hashes.`,
    });
  }

  const patchedBytes = typeof rscFlight.patchedBytes === 'number' && Number.isFinite(rscFlight.patchedBytes)
    ? Math.floor(rscFlight.patchedBytes)
    : null;
  if (patchedBytes === null || patchedBytes < 1) {
    issues.push({
      code: 'RSC_FLIGHT_BYTES_INVALID',
      severity: 'error',
      message: `Rule ${ruleId} RSC flight metadata must include a positive patchedBytes value.`,
    });
  }

  const fileSizeBytes = typeof rule.fileSizeBytes === 'number' && Number.isFinite(rule.fileSizeBytes)
    ? Math.floor(rule.fileSizeBytes)
    : null;
  if (patchedBytes !== null && fileSizeBytes !== null && patchedBytes !== fileSizeBytes) {
    issues.push({
      code: 'RSC_FLIGHT_LOCAL_FILE_MISMATCH',
      severity: 'error',
      message: `Rule ${ruleId} local RSC file size does not match patchedBytes metadata.`,
    });
  }

  const resolvedLocalFilePath = typeof rule.resolvedLocalFilePath === 'string' ? rule.resolvedLocalFilePath : '';
  if (resolvedLocalFilePath && existsSync(resolvedLocalFilePath) && SHA256_HEX_PATTERN.test(patchedSha256)) {
    const body = readFileSync(resolvedLocalFilePath, 'utf8');
    if (!/(^|\n)\d+:/u.test(body)) {
      issues.push({
        code: 'RSC_FLIGHT_BODY_INVALID',
        severity: 'error',
        message: `Rule ${ruleId} local RSC file does not match the supported Flight payload shape.`,
      });
    }
    if (sha256Text(body) !== patchedSha256) {
      issues.push({
        code: 'RSC_FLIGHT_LOCAL_FILE_MISMATCH',
        severity: 'error',
        message: `Rule ${ruleId} local RSC file hash does not match patchedSha256 metadata.`,
      });
    }
  }

  return issues;
}

function buildOverrideProfileIssues(profile: Record<string, unknown>): Array<Record<string, unknown>> {
  const issues: Array<Record<string, unknown>> = [];
  const rules = Array.isArray(profile.rules)
    ? profile.rules.filter((rule): rule is Record<string, unknown> => isRecord(rule))
    : [];

  if (profile.enabled !== true) {
    issues.push({
      code: 'PROFILE_DISABLED',
      severity: 'warning',
      message: 'The override profile is disabled and cannot replace requests until enabled.',
    });
  }

  if (rules.length === 0 || !rules.some((rule) => rule.enabled === true)) {
    issues.push({
      code: 'NO_ENABLED_RULES',
      severity: 'error',
      message: 'The override profile has no enabled rules.',
    });
  }

  for (const rule of rules) {
    if (rule.enabled !== true) {
      continue;
    }

    if (typeof rule.targetAssetUrl !== 'string' || !rule.targetAssetUrl.startsWith('http')) {
      issues.push({
        code: 'TARGET_URL_INVALID',
        severity: 'error',
        message: `Rule ${String(rule.ruleId ?? 'unknown')} targetAssetUrl must be an absolute http(s) URL.`,
      });
    }

    if (rule.fileExists !== true) {
      issues.push({
        code: 'LOCAL_FILE_MISSING',
        severity: 'error',
        message: `Rule ${String(rule.ruleId ?? 'unknown')} local override file does not exist.`,
      });
    }

    issues.push(...classifyOverrideResponseRequestCapability({
      ruleId: rule.ruleId,
      requestMethod: rule.requestMethod,
      requestHeaders: getOverrideRuleRequestHeaders(rule),
      ruleType: rule.ruleType,
    }).issues.map((issue) => ({ ...issue })));

    if (rule.ruleType === 'rsc-flight') {
      issues.push(...buildRscFlightRuleIssues(rule));
    }
  }

  return issues;
}

function buildOverrideProfileNextActions(
  profile: Record<string, unknown>,
  issues: Array<Record<string, unknown>>,
): Array<Record<string, string>> {
  if (issues.some((issue) => issue.code === 'SERVER_ACTION_UNSUPPORTED')) {
    return [{
      code: 'REPLAN_SERVER_ACTION_OVERRIDE',
      message: 'Server actions stay unsupported in production override mode; replace the flow with a GET document/data/API response path instead.',
    }];
  }

  if (issues.some((issue) => issue.code === 'MUTATION_REPLAY_UNSUPPORTED')) {
    return [{
      code: 'REPLAN_MUTATION_OVERRIDE',
      message: 'Mutation responses are not replay-safe; move the override to a GET document/data/API response or remove the non-GET rule.',
    }];
  }

  if (issues.some((issue) => issue.code === 'UNSAFE_REQUEST_METHOD')) {
    return [{
      code: 'REPLAN_GET_ONLY_OVERRIDE',
      message: 'Response override rules are production-safe only for GET requests; regenerate or remove non-GET rules.',
    }];
  }

  if (issues.some((issue) => issue.code === 'LOCAL_FILE_MISSING')) {
    return [{
      code: 'REBUILD_OR_FIX_LOCAL_PATHS',
      message: 'Rebuild the local app or fix localFilePath values before enabling overrides.',
    }];
  }

  if (issues.some((issue) => issue.code === 'NO_ENABLED_RULES')) {
    return [{
      code: 'ENABLE_RULES',
      message: 'Enable at least one rule in the selected override profile.',
    }];
  }

  if (issues.some((issue) => issue.code === 'TARGET_URL_INVALID')) {
    return [{
      code: 'FIX_TARGET_URLS',
      message: 'Use absolute http(s) production URLs for every targetAssetUrl.',
    }];
  }

  if (issues.some((issue) => typeof issue.code === 'string' && issue.code.startsWith('RSC_FLIGHT_'))
    || issues.some((issue) => issue.code === 'UNSUPPORTED_RSC_FLIGHT_RULE')) {
    return [{
      code: 'REPLAN_RSC_RESPONSE_OVERRIDE',
      message: 'Regenerate the RSC rule with plan_override_response_patch from a captured text/x-component response body.',
    }];
  }

  if (profile.enabled !== true) {
    return [{
      code: 'ENABLE_PROFILE',
      message: 'Set the selected override profile enabled=true after reviewing its rules.',
    }];
  }

  return [{
    code: 'ENABLE_OVERRIDES',
    message: 'Enable overrides on a connected session, then reload the target tab if needed.',
  }];
}

function hasEnabledExperimentalRscFlightRule(profile: Record<string, unknown>): boolean {
  const rules = Array.isArray(profile.rules)
    ? profile.rules.filter((rule): rule is Record<string, unknown> => isRecord(rule))
    : [];
  return rules.some((rule) => {
    return rule.enabled === true
      && rule.ruleType === 'rsc-flight'
      && rule.allowExperimentalRscFlightFulfillment === true;
  });
}

function canBypassPreflightForExperimentalRsc(
  profile: Record<string, unknown>,
  blockingCodes: string[],
): boolean {
  const allowedExperimentalBlockers = new Set([
    'UNSUPPORTED_RSC_FLIGHT_RULE',
    'NO_OBSERVED_ASSETS',
    'TARGET_ASSET_NOT_OBSERVED',
  ]);
  return blockingCodes.length > 0
    && blockingCodes.includes('UNSUPPORTED_RSC_FLIGHT_RULE')
    && blockingCodes.every((code) => allowedExperimentalBlockers.has(code))
    && hasEnabledExperimentalRscFlightRule(profile);
}

const OVERRIDE_VARIANT_HEADER_ALLOWLIST = new Set([
  'accept',
  'content-type',
  'next-router-prefetch',
  'next-router-state-tree',
  'purpose',
  'rsc',
  'x-nextjs-data',
]);

function normalizeOverrideVariantHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.trim().toLowerCase();
    if (!OVERRIDE_VARIANT_HEADER_ALLOWLIST.has(name)) {
      continue;
    }
    if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
      normalized[name] = rawValue.trim();
      continue;
    }
    if (typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      normalized[name] = String(rawValue);
    }
  }

  return normalized;
}

function buildOverrideVariantContext(options: {
  targetUrl?: unknown;
  requestMethod?: unknown;
  matchMode?: unknown;
  ruleType?: unknown;
  captureMode?: unknown;
  source?: unknown;
  triggerReload?: unknown;
  requestHeaders?: unknown;
}): Record<string, unknown> | null {
  const targetUrl = normalizeOptionalString(options.targetUrl);
  if (!targetUrl) {
    return null;
  }

  const requestMethod = normalizeOverrideRequestMethod(options.requestMethod);
  const matchMode = normalizeOptionalString(options.matchMode) ?? 'exact';
  const ruleType = normalizeOptionalString(options.ruleType) ?? 'document';
  const captureMode = normalizeOptionalString(options.captureMode);
  const source = normalizeOptionalString(options.source);
  const headers = normalizeOverrideVariantHeaders(options.requestHeaders);
  const isPrefetchVariant = headers['next-router-prefetch'] === '1'
    || headers.purpose?.toLowerCase() === 'prefetch';
  const isRscRequest = ruleType === 'rsc-flight' || headers.rsc === '1';
  let isNextDataRequest = ruleType === 'next-data' || headers['x-nextjs-data'] === '1';

  let origin: string | undefined;
  let pathname: string | undefined;
  let searchParams: Array<{ name: string; value: string }> = [];

  try {
    const parsed = new URL(targetUrl);
    origin = parsed.origin;
    pathname = parsed.pathname;
    searchParams = Array.from(parsed.searchParams.entries()).map(([name, value]) => ({ name, value }));
    if (pathname.startsWith('/_next/data/')) {
      isNextDataRequest = true;
    }
  } catch {
    pathname = undefined;
  }

  const searchParamKeys = [...new Set(searchParams.map((entry) => entry.name))].sort();
  const variantBasis = {
    targetUrl,
    origin: origin ?? null,
    pathname: pathname ?? null,
    searchParams,
    requestMethod,
    matchMode,
    ruleType,
    captureMode: captureMode ?? null,
    source: source ?? null,
    triggerReload: options.triggerReload === true,
    headers,
    isPrefetchVariant,
    isRscRequest,
    isNextDataRequest,
  };

  return {
    ...variantBasis,
    searchParamKeys,
    variantKey: sha256Text(JSON.stringify(variantBasis)),
  };
}

function extractPlanVariantContext(plan: OverridePlanAuditRecord): Record<string, unknown> | null {
  if (isRecord(plan.patchSummary) && isRecord(plan.patchSummary.variantContext)) {
    return plan.patchSummary.variantContext;
  }

  if (isRecord(plan.capturedFromLiveSession)) {
    if (isRecord(plan.capturedFromLiveSession.variantContext)) {
      return plan.capturedFromLiveSession.variantContext;
    }
    return buildOverrideVariantContext({
      targetUrl: plan.capturedFromLiveSession.targetUrl ?? plan.targetAssetUrl,
      requestMethod: plan.capturedFromLiveSession.requestMethod ?? plan.requestMethod,
      matchMode: plan.capturedFromLiveSession.matchMode ?? plan.matchMode,
      ruleType: plan.capturedFromLiveSession.ruleType ?? plan.ruleType,
      captureMode: plan.capturedFromLiveSession.captureMode,
      source: plan.capturedFromLiveSession.source,
      triggerReload: plan.capturedFromLiveSession.triggerReload,
      requestHeaders: plan.capturedFromLiveSession.requestHeaders,
    });
  }

  return buildOverrideVariantContext({
    targetUrl: plan.targetAssetUrl,
    requestMethod: plan.requestMethod,
    matchMode: plan.matchMode,
    ruleType: plan.ruleType,
  });
}

function pushOverridePreflightIssue(
  issues: Array<Record<string, unknown>>,
  issue: Record<string, unknown>,
): void {
  const code = typeof issue.code === 'string' ? issue.code : '';
  const source = typeof issue.source === 'string' ? issue.source : '';
  const message = typeof issue.message === 'string' ? issue.message : '';
  if (issues.some((existing) => existing.code === code && existing.source === source && existing.message === message)) {
    return;
  }
  issues.push(issue);
}

function getPreflightIssues(preflight: Record<string, unknown> | null): Array<Record<string, unknown>> {
  return Array.isArray(preflight?.issues)
    ? preflight.issues.filter((issue): issue is Record<string, unknown> => isRecord(issue))
    : [];
}

function getBlockingPreflightCodes(preflight: Record<string, unknown> | null): string[] {
  return getPreflightIssues(preflight)
    .filter((issue) => issue.severity === 'error')
    .map((issue) => String(issue.code ?? 'UNKNOWN'));
}

function hasPreflightIssue(preflight: Record<string, unknown> | null, codes: string[]): boolean {
  const expected = new Set(codes);
  return getPreflightIssues(preflight).some((issue) => expected.has(String(issue.code ?? '')));
}

function shouldRefreshObservedAssetsForEnable(preflight: Record<string, unknown> | null): boolean {
  const assetReadinessCodes = new Set([
    'NO_OBSERVED_ASSETS',
    'TARGET_ASSET_NOT_OBSERVED',
    'SESSION_SCOPE_DRIFT',
  ]);
  const blockingCodes = getBlockingPreflightCodes(preflight);
  if (blockingCodes.length === 0 || !blockingCodes.every((code) => assetReadinessCodes.has(code))) {
    return false;
  }
  return hasPreflightIssue(preflight, [
    'NO_OBSERVED_ASSETS',
    'TARGET_ASSET_NOT_OBSERVED',
    'SESSION_SCOPE_DRIFT',
  ]);
}

function buildOverridePreflight(options: {
  db: Database;
  sessionId: string;
  profileId?: unknown;
  getSessionConnectionState?: (sessionId: string) => SessionConnectionLookupResult | undefined;
}): Record<string, unknown> {
  const session = options.db
    .prepare(`
      SELECT
        session_id,
        created_at,
        last_seen_at,
        paused_at,
        ended_at,
        tab_id,
        window_id,
        url_start,
        url_last,
        user_agent,
        viewport_w,
        viewport_h,
        dpr,
        safe_mode,
        pinned
      FROM sessions
      WHERE session_id = ?
      LIMIT 1
    `)
    .get(options.sessionId) as SessionRow | undefined;
  const profile = resolveOverrideProfileRecord(options.profileId);
  const issues: Array<Record<string, unknown>> = [];
  const observedAssets = session
    ? listObservedOverrideAssets(options.db, { sessionId: options.sessionId, limit: 200 })
    : [];
  const latestRun = session ? listOverridePocRuns(options.db, options.sessionId, 1, 0).runs[0] ?? null : null;
  const recentPlans = session
    ? listOverridePlanAudits(options.db, { sessionId: options.sessionId, limit: 5, offset: 0 }).plans
    : [];
  const variantContexts = [...new Map(
    recentPlans
      .map((plan) => extractPlanVariantContext(plan))
      .filter((context): context is Record<string, unknown> => context !== null)
      .map((context) => [String(context.variantKey ?? JSON.stringify(context)), context]),
  ).values()];
  const sessionState = options.getSessionConnectionState?.(options.sessionId);
  const hasLiveConnectionLookup = typeof options.getSessionConnectionState === 'function';
  const diagnosis = session ? diagnoseOverridePoc(options.db, options.sessionId, latestRun?.runId) : null;
  const observedAssetTabs = [...new Set(
    observedAssets
      .map((asset) => asset.tabId)
      .filter((tabId): tabId is number => typeof tabId === 'number' && Number.isFinite(tabId)),
  )].sort((a, b) => a - b);
  const observedAssetPageUrls = [...new Set(
    observedAssets
      .map((asset) => asset.pageUrl)
      .filter((pageUrl): pageUrl is string => typeof pageUrl === 'string' && pageUrl.trim().length > 0),
  )].slice(0, 5);
  const sessionTabId = typeof session?.tab_id === 'number' ? session.tab_id : undefined;
  const observedAssetsWithKnownTabs = observedAssets.filter((asset) => typeof asset.tabId === 'number');
  const topLevelScopeLikely = sessionTabId === undefined
    || observedAssets.length === 0
    || observedAssetsWithKnownTabs.length === 0
    || observedAssetsWithKnownTabs.some((asset) => asset.tabId === sessionTabId);

  for (const issue of buildOverrideProfileIssues(profile)) {
    pushOverridePreflightIssue(issues, { ...issue, source: 'profile' });
  }

  if (!session) {
    pushOverridePreflightIssue(issues, {
      code: 'SESSION_NOT_FOUND',
      severity: 'error',
      source: 'session',
      message: `Session not found: ${options.sessionId}`,
    });
  } else {
    const sessionStatus = getSessionStatus(session);
    if (sessionStatus === 'paused') {
      pushOverridePreflightIssue(issues, {
        code: 'SESSION_PAUSED',
        severity: 'error',
        source: 'session',
        message: `Session ${options.sessionId} is paused and cannot enable overrides until it resumes.`,
      });
    }
    if (sessionStatus === 'ended') {
      pushOverridePreflightIssue(issues, {
        code: 'SESSION_ENDED',
        severity: 'error',
        source: 'session',
        message: `Session ${options.sessionId} has ended and cannot enable overrides.`,
      });
    }
    if (hasLiveConnectionLookup && (!sessionState || sessionState.connected !== true)) {
      pushOverridePreflightIssue(issues, {
        code: LIVE_SESSION_DISCONNECTED_CODE,
        severity: 'error',
        source: 'connection',
        message: sessionState
          ? `Session ${options.sessionId} is not currently connected to the live extension bridge. Last disconnect reason: ${sessionState.disconnectReason ?? 'unknown'}.`
          : `Session ${options.sessionId} has no current live extension connection state.`,
        disconnectedAt: sessionState?.disconnectedAt,
        disconnectReason: sessionState?.disconnectReason,
      });
    }
  }

  const enabledRules = Array.isArray(profile.rules)
    ? profile.rules.filter((rule): rule is Record<string, unknown> => isRecord(rule) && rule.enabled === true)
    : [];
  const enabledRuleAssetReadiness = enabledRules
    .map((rule) => {
      const targetAssetUrl = normalizeOptionalString(rule.targetAssetUrl);
      if (!targetAssetUrl) {
        return null;
      }
      const requestMethod = normalizeOverrideRequestMethod(rule.requestMethod);
      const matchMode = String(rule.matchMode ?? 'exact');
      const matchingAssets = observedAssets.filter((asset) => {
        const methodMatches = normalizeOverrideRequestMethod(asset.requestMethod) === requestMethod;
        if (!methodMatches) {
          return false;
        }
        return matchMode === 'prefix'
          ? asset.url.startsWith(targetAssetUrl)
          : asset.url === targetAssetUrl;
      });

      return {
        ruleId: String(rule.ruleId ?? 'unknown'),
        targetAssetUrl,
        requestMethod,
        matchMode,
        captureProven: rule.ruleType === 'rsc-flight' && isRecordWithRscFlightMetadata(rule.rscFlight),
        matchingAssets,
      };
    })
    .filter((readiness): readiness is {
      ruleId: string;
      targetAssetUrl: string;
      requestMethod: string;
      matchMode: string;
      captureProven: boolean;
      matchingAssets: typeof observedAssets;
    } => readiness !== null);
  const matchedTargetAssetCount = enabledRuleAssetReadiness.filter((readiness) => readiness.matchingAssets.length > 0).length;
  const capturedTargetAssetCount = enabledRuleAssetReadiness
    .filter((readiness) => readiness.matchingAssets.length === 0 && readiness.captureProven)
    .length;
  const unobservedTargetAssetCount = enabledRuleAssetReadiness.length - matchedTargetAssetCount;
  const unsatisfiedTargetAssetCount = enabledRuleAssetReadiness.length - matchedTargetAssetCount - capturedTargetAssetCount;
  const targetAssetObserved = observedAssets.length > 0 && matchedTargetAssetCount > 0;
  const targetAssetReadinessSatisfied = observedAssets.length > 0
    && (enabledRuleAssetReadiness.length === 0 || matchedTargetAssetCount > 0 || capturedTargetAssetCount > 0);
  const anyServiceWorkerControlled = observedAssets.some((asset) => asset.serviceWorkerControlled);
  const cspMetaTags = [...new Set(observedAssets.flatMap((asset) => asset.cspMetaTags))];

  if (observedAssets.length === 0) {
    pushOverridePreflightIssue(issues, {
      code: 'NO_OBSERVED_ASSETS',
      severity: 'error',
      source: 'observed-assets',
      message: 'No observed production assets are stored for this session yet; the target route is not capture-ready for override enablement.',
    });
  } else if (!topLevelScopeLikely) {
    pushOverridePreflightIssue(issues, {
      code: 'SESSION_SCOPE_DRIFT',
      severity: 'error',
      source: 'observed-assets',
      message: `Observed override assets were recorded only for tab(s) ${observedAssetTabs.join(', ')}, but the session top-level tab is ${sessionTabId}.`,
      observedAssetTabs,
      sessionTabId,
      observedPageUrls: observedAssetPageUrls,
    });
  }

  if (observedAssets.length > 0 && enabledRuleAssetReadiness.length > 0 && matchedTargetAssetCount === 0 && capturedTargetAssetCount === 0) {
    const sampleTargets = enabledRuleAssetReadiness.slice(0, 5).map((readiness) => ({
      ruleId: readiness.ruleId,
      requestMethod: readiness.requestMethod,
      matchMode: readiness.matchMode,
      targetAssetUrl: readiness.targetAssetUrl,
    }));
    pushOverridePreflightIssue(issues, {
      code: 'TARGET_ASSET_NOT_OBSERVED',
      severity: 'error',
      source: 'observed-assets',
      message: enabledRuleAssetReadiness.length === 1
        ? `Rule ${enabledRuleAssetReadiness[0].ruleId} target asset was not observed for ${enabledRuleAssetReadiness[0].requestMethod} ${enabledRuleAssetReadiness[0].targetAssetUrl}.`
        : `None of the ${enabledRuleAssetReadiness.length} enabled override targets were observed for this session.`,
      checkedTargetAssetCount: enabledRuleAssetReadiness.length,
      sampleTargets,
    });
  }

  for (const readiness of enabledRuleAssetReadiness) {
    if (readiness.matchingAssets.length === 0) {
      if (readiness.captureProven) {
        continue;
      }
      pushOverridePreflightIssue(issues, {
        code: 'TARGET_ASSET_NOT_OBSERVED_FOR_RULE',
        severity: 'warning',
        source: 'observed-assets',
        message: `Rule ${readiness.ruleId} target asset was not observed for ${readiness.requestMethod} ${readiness.targetAssetUrl}.`,
      });
      continue;
    }

    for (const asset of readiness.matchingAssets) {
      if (typeof asset.integrity === 'string' && asset.integrity.length > 0) {
        pushOverridePreflightIssue(issues, {
          code: 'TARGET_ASSET_SRI_PRESENT',
          severity: 'error',
          source: 'observed-assets',
          message: `Rule ${readiness.ruleId} target asset ${asset.url} includes integrity="${asset.integrity}" and cannot be overridden safely.`,
        });
      }
    }
  }

  if (anyServiceWorkerControlled) {
    pushOverridePreflightIssue(issues, {
      code: 'SERVICE_WORKER_CONTROLLED',
      severity: 'warning',
      source: 'observed-assets',
      message: 'The observed page is service-worker controlled; verify the target requests still reach the network path that the debugger can fulfill.',
    });
  }

  if (cspMetaTags.length > 0) {
    pushOverridePreflightIssue(issues, {
      code: 'CSP_META_PRESENT',
      severity: 'warning',
      source: 'observed-assets',
      message: `The observed page emitted ${cspMetaTags.length} CSP meta tag(s); document or bootstrap rewrites may still be constrained by page policy.`,
    });
  }

  const ready = !issues.some((issue) => issue.severity === 'error');
  const nextActions = !ready
    ? issues.some((issue) => issue.code === 'SESSION_NOT_FOUND' || issue.code === 'SESSION_PAUSED' || issue.code === 'SESSION_ENDED' || issue.code === LIVE_SESSION_DISCONNECTED_CODE)
      ? [{ code: 'RECONNECT_SESSION', message: 'Reconnect or resume the target session before enabling overrides.' }]
      : issues.some((issue) => issue.code === 'SESSION_SCOPE_DRIFT')
        ? [{ code: 'FOCUS_BOUND_TAB', message: 'Focus or reselect the bound top-level tab, then observe override assets again.' }]
        : issues.some((issue) => issue.code === 'SERVER_ACTION_UNSUPPORTED')
      ? [{
          code: 'REPLAN_SERVER_ACTION_OVERRIDE',
          message: 'Server actions stay unsupported in production override mode; move the override to a GET document/data/API response.',
        }]
      : issues.some((issue) => issue.code === 'MUTATION_REPLAY_UNSUPPORTED')
        ? [{
            code: 'REPLAN_MUTATION_OVERRIDE',
            message: 'Mutation responses are not replay-safe; use a GET document/data/API response path instead.',
          }]
        : issues.some((issue) => issue.code === 'UNSAFE_REQUEST_METHOD')
          ? [{ code: 'REPLAN_GET_ONLY_OVERRIDE', message: 'Remove or regenerate non-GET rules before enabling overrides.' }]
          : issues.some((issue) => issue.code === 'TARGET_ASSET_SRI_PRESENT')
            ? [{ code: 'CHOOSE_ANOTHER_OVERRIDE_PATH', message: 'Choose a document/data response path or remove SRI on the production asset before enabling overrides.' }]
            : issues.some((issue) => issue.code === 'NO_OBSERVED_ASSETS')
              ? [{ code: 'OBSERVE_OVERRIDE_ASSETS', message: 'Observe the bound target route before enabling overrides.' }]
              : issues.some((issue) => issue.code === 'TARGET_ASSET_NOT_OBSERVED')
                ? [{ code: 'OBSERVE_TARGET_ROUTE', message: 'Load the route that requests the configured target and observe assets again.' }]
                : buildOverrideProfileNextActions(profile, issues)
    : observedAssets.length === 0
      ? [{ code: 'OBSERVE_OVERRIDE_ASSETS', message: 'Run observe_override_assets on the target route before enabling overrides in production workflows.' }]
      : [{ code: 'ENABLE_OVERRIDES', message: 'Preflight checks passed; the selected profile can be enabled on the live session.' }];

  return {
    ready,
    profileId: profile.profileId,
    profile,
    session: session
      ? {
          sessionId: session.session_id,
          status: getSessionStatus(session),
          lastSeenAt: resolveSessionLastSeenAt(session, sessionState),
          connected: sessionState?.connected === true,
          disconnectedAt: sessionState?.disconnectedAt,
          disconnectReason: sessionState?.disconnectReason,
          urlLast: session.url_last ?? undefined,
          tabId: session.tab_id ?? undefined,
        }
      : null,
    issues,
    checks: {
      sessionFound: session !== undefined,
      connected: sessionState?.connected === true,
      captureReady: session !== undefined
        && getSessionStatus(session) === 'active'
        && (!hasLiveConnectionLookup || sessionState?.connected === true)
        && observedAssets.length > 0
        && topLevelScopeLikely
        && !issues.some((issue) => issue.severity === 'error'),
      topLevelScopeLikely,
      observedAssetTabs,
      observedAssetPageUrls,
      observedAssetCount: observedAssets.length,
      targetAssetObserved,
      targetAssetReadinessSatisfied,
      matchedTargetAssetCount,
      capturedTargetAssetCount,
      unobservedTargetAssetCount,
      unsatisfiedTargetAssetCount,
      serviceWorkerControlled: anyServiceWorkerControlled,
      cspMetaTagCount: cspMetaTags.length,
      recentPlanCount: recentPlans.length,
      variantContextCount: variantContexts.length,
    },
    observedAssets: {
      count: observedAssets.length,
      tabIds: observedAssetTabs,
      pageUrls: observedAssetPageUrls,
      targetAssetObserved,
      targetAssetReadinessSatisfied,
      matchedTargetAssetCount,
      capturedTargetAssetCount,
      unobservedTargetAssetCount,
      unsatisfiedTargetAssetCount,
      serviceWorkerControlled: anyServiceWorkerControlled,
      cspMetaTags,
    },
    latestRun,
    recentPlans,
    variantContexts,
    diagnosis,
    nextActions,
  };
}

function normalizeOptionalBooleanInput(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${fieldName} must be a boolean when provided`);
  }
  return value;
}

function normalizeOptionalNumberInput(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number when provided`);
  }
  return value;
}

function normalizeOptionalStringArrayInput(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of strings when provided`);
  }

  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new Error(`${fieldName}[${index}] must be a non-empty string`);
    }
    return entry.trim();
  });
}

function resolveSessionLastSeenAt(
  row: Pick<SessionRow, 'created_at' | 'last_seen_at' | 'paused_at' | 'ended_at'>,
  state?: SessionConnectionLookupResult,
): number {
  return Math.max(
    row.created_at,
    row.last_seen_at ?? 0,
    row.paused_at ?? 0,
    row.ended_at ?? 0,
    state?.lastHeartbeatAt ?? 0,
  );
}

function buildLiveConnectionRecord(
  row: Pick<SessionRow, 'created_at' | 'last_seen_at' | 'paused_at' | 'ended_at'>,
  scope: SessionScopeAssessment,
  state?: SessionConnectionLookupResult,
): Record<string, unknown> {
  const status = getSessionStatus(row);
  const lastSeenAt = resolveSessionLastSeenAt(row, state);
  const heartbeatAt = state?.lastHeartbeatAt;
  const heartbeatAgeMs = typeof heartbeatAt === 'number' ? Math.max(0, Date.now() - heartbeatAt) : undefined;
  const likelyStale = Boolean(
    !state?.connected
      && status === 'active'
      && scope.kind !== 'likely_iframe_noise'
      && typeof heartbeatAt === 'number'
      && Date.now() - heartbeatAt <= STALE_LIVE_CONNECTION_GRACE_WINDOW_MS,
  );

  return {
    connected: state?.connected === true,
    connectedAt: state?.connectedAt,
    lastHeartbeatAt: heartbeatAt,
    heartbeatAgeMs,
    disconnectedAt: state?.disconnectedAt,
    disconnectReason: state?.disconnectReason ?? (status === 'ended' ? 'manual_stop' : undefined),
    status: status === 'ended'
      ? 'ended'
      : status === 'paused'
        ? 'paused'
        : state?.connected
          ? 'connected'
          : likelyStale
            ? 'likely_stale'
            : 'disconnected',
    captureReady: state?.connected === true && status === 'active',
    recommendedForLiveCapture: state?.connected === true && status === 'active' && scope.kind !== 'likely_iframe_noise',
    lastSeenAt,
    activityAgeMs: Math.max(0, Date.now() - lastSeenAt),
  };
}

function buildLiveSessionNextAction(
  liveConnection: Record<string, unknown>,
  scope: SessionScopeAssessment,
): string {
  const liveStatus = typeof liveConnection.status === 'string' ? liveConnection.status : 'disconnected';

  if (liveStatus === 'connected' && scope.kind !== 'likely_iframe_noise') {
    return 'Use this session for live capture tools.';
  }

  if (liveStatus === 'connected' && scope.kind === 'likely_iframe_noise') {
    return 'Reconnect on a top-level app tab before relying on live navigation or performance captures.';
  }

  if (liveStatus === 'likely_stale') {
    return 'Retry list_sessions after a fresh app interaction or restart the session if live capture still fails.';
  }

  if (liveStatus === 'paused') {
    return 'Resume the session from the extension popup before using live capture tools.';
  }

  if (liveStatus === 'ended') {
    return 'Start a new extension session before using live capture tools.';
  }

  return 'Reconnect or restart the extension session before using live capture tools.';
}

function buildLiveSessionRecommendedAction(
  liveConnection: Record<string, unknown>,
  scope: SessionScopeAssessment,
): string {
  const liveStatus = typeof liveConnection.status === 'string' ? liveConnection.status : 'disconnected';

  if (liveStatus === 'connected' && scope.kind !== 'likely_iframe_noise') {
    return 'ready';
  }

  if (liveStatus === 'ended') {
    return 'start_new_session';
  }

  if (liveStatus === 'paused') {
    return 'resume_session';
  }

  return 'reconnect_extension';
}

function mapEventRecord(
  row: EventRow,
  profile: ResponseProfile = 'legacy',
  options: { includePayload?: boolean } = {},
): Record<string, unknown> {
  const payload = readJsonPayload(row.payload_json);

  if (profile === 'compact') {
    const compact: Record<string, unknown> = {
      eventId: row.event_id,
      sessionId: row.session_id,
      timestamp: row.ts,
      type: row.type,
      summary: describeEvent(row.type, payload),
    };

    if (row.type === 'console') {
      compact.level = typeof payload.level === 'string' ? payload.level : undefined;
      compact.message = typeof payload.message === 'string' ? payload.message : undefined;
    }

    if (row.type === 'nav') {
      compact.url = resolveLastUrl(payload);
    }

    if (options.includePayload === true) {
      compact.payload = payload;
    }

    return compact;
  }

  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    timestamp: row.ts,
    type: row.type,
    tabId: row.tab_id ?? (typeof payload.tabId === 'number' ? payload.tabId : undefined),
    origin:
      row.origin
      ?? (typeof payload.origin === 'string' ? payload.origin : undefined)
      ?? undefined,
    payload,
  };
}

function classifyNetworkFailure(status: number | null, errorClass: string | null): string {
  if (errorClass && errorClass.length > 0) {
    return errorClass;
  }

  if (typeof status === 'number' && status >= 400) {
    return 'http_error';
  }

  return 'unknown';
}

function buildNetworkFailureFilter(errorType: unknown): string {
  if (typeof errorType !== 'string' || errorType.length === 0) {
    return '(error_class IS NOT NULL OR COALESCE(status, 0) >= 400)';
  }

  if (errorType === 'http_error') {
    return "(error_class = 'http_error' OR (error_class IS NULL AND COALESCE(status, 0) >= 400))";
  }

  return 'error_class = ?';
}

function resolveWindowSeconds(value: unknown, fallback: number, maxValue: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const floored = Math.floor(value);
  if (floored < 1) {
    return fallback;
  }

  return Math.min(floored, maxValue);
}

function resolveOptionalTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  const floored = Math.floor(value);
  return floored < 0 ? undefined : floored;
}

function resolveChunkBytes(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const floored = Math.floor(value);
  if (floored < 1) {
    return fallback;
  }

  return Math.min(floored, MAX_SNAPSHOT_ASSET_CHUNK_BYTES);
}

function resolveDurationMs(value: unknown, fallback: number, maxValue: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const floored = Math.floor(value);
  if (floored < 1) {
    return fallback;
  }

  return Math.min(floored, maxValue);
}

function resolveBodyChunkBytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_BODY_CHUNK_BYTES;
  }

  const floored = Math.floor(value);
  if (floored < 1) {
    return DEFAULT_BODY_CHUNK_BYTES;
  }

  return Math.min(floored, MAX_BODY_CHUNK_BYTES);
}

function resolveTimeoutMs(value: unknown, fallback: number, maxValue: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const floored = Math.floor(value);
  if (floored < 100) {
    return fallback;
  }

  return Math.min(floored, maxValue);
}

function normalizeHttpMethod(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeMockRouteMode(value: unknown): MockRouteMode {
  return value === 'ssr' || value === 'both' ? value : 'browser';
}

function normalizeMockRouteSourceKind(value: unknown): MockRouteSourceKind {
  return value === 'captured' || value === 'patched' ? value : 'manual';
}

function normalizeMockRouteBody(input: ToolInput): {
  bodyKind: MockRouteBodyKind;
  bodyJson?: unknown;
  bodyText?: string | null;
  bodyBase64?: string | null;
  bodyFilePath?: string | null;
} | null {
  if (Object.prototype.hasOwnProperty.call(input, 'bodyJson')) {
    return {
      bodyKind: 'json',
      bodyJson: input.bodyJson,
    };
  }

  const bodyText = normalizeOptionalString(input.bodyText);
  if (bodyText !== undefined) {
    return {
      bodyKind: 'text',
      bodyText,
    };
  }

  const bodyBase64 = normalizeOptionalString(input.bodyBase64);
  if (bodyBase64 !== undefined) {
    return {
      bodyKind: 'base64',
      bodyBase64,
    };
  }

  const bodyFilePath = normalizeOptionalString(input.bodyFilePath);
  if (bodyFilePath !== undefined) {
    return {
      bodyKind: 'file',
      bodyFilePath,
    };
  }

  return null;
}

function createMockRouteRecord(input: ToolInput, existing?: MockRouteRecord): MockRouteRecord {
  const now = Date.now();
  const targetUrl = normalizeOptionalString(input.targetUrl) ?? existing?.targetUrl;
  if (!targetUrl) {
    throw new Error('targetUrl is required');
  }

  const body = normalizeMockRouteBody(input);
  const ttlMs = typeof input.ttlMs === 'number' && Number.isFinite(input.ttlMs) && input.ttlMs > 0
    ? Math.floor(input.ttlMs)
    : existing?.ttlMs ?? null;

  return {
    routeId: normalizeOptionalString(input.routeId) ?? existing?.routeId ?? randomUUID(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : existing?.enabled ?? false,
    mode: normalizeMockRouteMode(input.mode ?? existing?.mode),
    method: normalizeHttpMethod(input.method) ?? existing?.method ?? 'GET',
    matchMode: input.matchMode === 'prefix' ? 'prefix' : existing?.matchMode ?? 'exact',
    targetUrl,
    statusCode: typeof input.statusCode === 'number' && Number.isFinite(input.statusCode)
      ? Math.max(100, Math.min(599, Math.floor(input.statusCode)))
      : existing?.statusCode ?? 200,
    responseHeaders: Object.keys(normalizeMockHeaders(input.responseHeaders)).length > 0
      ? normalizeMockHeaders(input.responseHeaders)
      : existing?.responseHeaders ?? {},
    bodyKind: body?.bodyKind ?? existing?.bodyKind ?? 'json',
    bodyJson: body?.bodyJson ?? existing?.bodyJson,
    bodyText: body?.bodyText ?? existing?.bodyText ?? null,
    bodyBase64: body?.bodyBase64 ?? existing?.bodyBase64 ?? null,
    bodyFilePath: body?.bodyFilePath ?? existing?.bodyFilePath ?? null,
    delayMs: typeof input.delayMs === 'number' && Number.isFinite(input.delayMs) && input.delayMs >= 0
      ? Math.floor(input.delayMs)
      : existing?.delayMs ?? 0,
    sourceKind: normalizeMockRouteSourceKind(input.sourceKind ?? existing?.sourceKind),
    sessionScope: normalizeOptionalString(input.sessionScope) ?? existing?.sessionScope ?? null,
    projectRoot: normalizeOptionalString(input.projectRoot) ?? existing?.projectRoot ?? null,
    ttlMs,
    expiresAt: ttlMs !== null ? now + ttlMs : null,
  };
}

function normalizeMockHeaders(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }

  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') {
      headers[key.toLowerCase()] = raw;
    }
  }
  return headers;
}

function normalizeStatusIn(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const statuses = value
    .filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry))
    .map((entry) => Math.floor(entry))
    .filter((entry) => entry >= 100 && entry <= 599);

  return Array.from(new Set(statuses));
}

function parseJsonOrUndefined(value: string | null): unknown {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function compileSafeRegex(value: string | undefined): RegExp | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return new RegExp(value);
  } catch {
    throw new Error('urlRegex must be a valid regular expression');
  }
}

function mapNetworkCallRecord(row: NetworkCallRow, includeBodies: boolean): Record<string, unknown> {
  const requestBodyJson = parseJsonOrUndefined(row.request_body_json);
  const responseBodyJson = parseJsonOrUndefined(row.response_body_json);
  return {
    requestId: row.request_id,
    sessionId: row.session_id,
    traceId: row.trace_id ?? undefined,
    tabId: row.tab_id ?? undefined,
    timestamp: row.ts_start,
    durationMs: row.duration_ms ?? undefined,
    method: row.method,
    url: row.url,
    origin: row.origin ?? undefined,
    status: row.status ?? undefined,
    initiator: row.initiator ?? undefined,
    errorType: classifyNetworkFailure(row.status, row.error_class),
    responseSizeEst: row.response_size_est ?? undefined,
    request: {
      contentType: row.request_content_type ?? undefined,
      bodyBytes: row.request_body_bytes ?? undefined,
      truncated: row.request_body_truncated === 1,
      bodyChunkRef: row.request_body_chunk_ref ?? undefined,
      bodyJson: includeBodies ? requestBodyJson : undefined,
      bodyText: includeBodies ? row.request_body_text ?? undefined : undefined,
    },
    response: {
      contentType: row.response_content_type ?? undefined,
      bodyBytes: row.response_body_bytes ?? undefined,
      truncated: row.response_body_truncated === 1,
      bodyChunkRef: row.response_body_chunk_ref ?? undefined,
      bodyJson: includeBodies ? responseBodyJson : undefined,
      bodyText: includeBodies ? row.response_body_text ?? undefined : undefined,
    },
  };
}

function mapBodyChunkRecord(row: BodyChunkRow, offset: number, limit: number): Record<string, unknown> {
  const fullBuffer = Buffer.from(row.body_text, 'utf-8');
  if (offset >= fullBuffer.byteLength) {
    return {
      chunkRef: row.chunk_ref,
      sessionId: row.session_id,
      requestId: row.request_id ?? undefined,
      traceId: row.trace_id ?? undefined,
      bodyKind: row.body_kind,
      contentType: row.content_type ?? undefined,
      totalBytes: fullBuffer.byteLength,
      offset,
      returnedBytes: 0,
      hasMore: false,
      nextOffset: null,
      chunkText: '',
      truncated: row.truncated === 1,
      createdAt: row.created_at,
    };
  }

  const chunkBuffer = fullBuffer.subarray(offset, Math.min(offset + limit, fullBuffer.byteLength));
  const returnedBytes = chunkBuffer.byteLength;
  const nextOffset = offset + returnedBytes;
  const hasMore = nextOffset < fullBuffer.byteLength;

  return {
    chunkRef: row.chunk_ref,
    sessionId: row.session_id,
    requestId: row.request_id ?? undefined,
    traceId: row.trace_id ?? undefined,
    bodyKind: row.body_kind,
    contentType: row.content_type ?? undefined,
    totalBytes: fullBuffer.byteLength,
    offset,
    returnedBytes,
    hasMore,
    nextOffset: hasMore ? nextOffset : null,
    chunkText: chunkBuffer.toString('utf-8'),
    truncated: row.truncated === 1,
    createdAt: row.created_at,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function normalizeAssetPath(pathValue: string): string {
  return pathValue.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
}

function getMainDbPath(db: Database): string {
  const entries = db.prepare('PRAGMA database_list').all() as Array<{ name: string; file: string }>;
  const main = entries.find((entry) => entry.name === 'main');
  if (!main || !main.file) {
    throw new Error('Snapshot asset retrieval is unavailable for in-memory databases.');
  }
  return main.file;
}

function resolveSnapshotAbsolutePath(dbPath: string, relativeAssetPath: string): string {
  const baseDir = resolve(dirname(dbPath));
  const normalized = normalizeAssetPath(relativeAssetPath);
  const absolutePath = resolve(baseDir, normalized);
  const inBaseDir = absolutePath === baseDir || absolutePath.startsWith(`${baseDir}\\`) || absolutePath.startsWith(`${baseDir}/`);
  if (!inBaseDir) {
    throw new Error('Snapshot asset path is invalid.');
  }
  return absolutePath;
}

function mapSnapshotMetadata(row: SnapshotRow): Record<string, unknown> {
  return {
    snapshotId: row.snapshot_id,
    sessionId: row.session_id,
    triggerEventId: row.trigger_event_id ?? undefined,
    timestamp: row.ts,
    trigger: row.trigger,
    selector: row.selector ?? undefined,
    url: row.url ?? undefined,
    mode: row.mode,
    styleMode: row.style_mode ?? undefined,
    hasDom: row.dom_json !== null,
    hasStyles: row.styles_json !== null,
    hasPng: row.png_path !== null,
    pngBytes: row.png_bytes ?? undefined,
    truncation: {
      dom: row.dom_truncated === 1,
      styles: row.styles_truncated === 1,
      png: row.png_truncated === 1,
    },
    createdAt: row.created_at,
  };
}

function mapAutomationRunRecord(row: AutomationRunRow): Record<string, unknown> {
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    traceId: row.trace_id ?? undefined,
    action: row.action ?? undefined,
    tabId: row.tab_id ?? undefined,
    selector: row.selector ?? undefined,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    durationMs:
      typeof row.completed_at === 'number'
        ? Math.max(0, row.completed_at - row.started_at)
        : undefined,
    stopReason: row.stop_reason ?? undefined,
    target: parseJsonOrUndefined(row.target_summary_json),
    diagnostics: parseJsonOrUndefined(row.diagnostics_json),
    failure: parseJsonOrUndefined(row.failure_json),
    redaction: parseJsonOrUndefined(row.redaction_json),
    stepCount: row.step_count,
    lastStepAt: row.last_step_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    source: 'automation_runs',
  };
}

function mapAutomationStepRecord(row: AutomationStepRow): Record<string, unknown> {
  return {
    stepId: row.step_id,
    runId: row.run_id,
    sessionId: row.session_id,
    stepOrder: row.step_order,
    traceId: row.trace_id ?? undefined,
    action: row.action,
    selector: row.selector ?? undefined,
    status: row.status,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    tabId: row.tab_id ?? undefined,
    target: parseJsonOrUndefined(row.target_summary_json),
    diagnostics: parseJsonOrUndefined(row.diagnostics_json),
    redaction: parseJsonOrUndefined(row.redaction_json),
    failure: parseJsonOrUndefined(row.failure_json),
    inputMetadata: parseJsonOrUndefined(row.input_metadata_json),
    eventType: row.event_type,
    eventId: row.event_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    source: 'automation_steps',
  };
}

function asRecordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function buildFailureEvidenceSummary(
  failureEvidence: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!failureEvidence) {
    return undefined;
  }

  const snapshot = asRecordOrUndefined(failureEvidence.snapshot);
  const snapshotRoot = asRecordOrUndefined(snapshot?.snapshot);
  return {
    captured: failureEvidence.captured === true,
    error: typeof failureEvidence.error === 'string' ? failureEvidence.error : undefined,
    limitsApplied: asRecordOrUndefined(failureEvidence.limitsApplied),
    snapshot: snapshot
      ? {
          timestamp: typeof snapshot.timestamp === 'number' ? snapshot.timestamp : undefined,
          trigger: typeof snapshot.trigger === 'string' ? snapshot.trigger : undefined,
          selector: typeof snapshot.selector === 'string' ? snapshot.selector : undefined,
          url: typeof snapshot.url === 'string' ? snapshot.url : undefined,
          mode: snapshot.mode,
          hasDom: Boolean(snapshotRoot && 'dom' in snapshotRoot),
          hasStyles: Boolean(snapshotRoot && 'styles' in snapshotRoot),
          hasPng: Boolean(snapshot.png),
        }
      : undefined,
  };
}

function findRelatedFailureSnapshot(
  db: Database,
  sessionId: string,
  failureEvidence: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const snapshotSummary = asRecordOrUndefined(buildFailureEvidenceSummary(failureEvidence)?.snapshot);
  if (!snapshotSummary) {
    return undefined;
  }

  const timestamp = typeof snapshotSummary.timestamp === 'number' ? snapshotSummary.timestamp : undefined;
  const selector = typeof snapshotSummary.selector === 'string' ? snapshotSummary.selector : undefined;
  const url = typeof snapshotSummary.url === 'string' ? snapshotSummary.url : undefined;
  const where: string[] = ['session_id = ?'];
  const params: unknown[] = [sessionId];

  if (selector) {
    where.push('selector = ?');
    params.push(selector);
  }
  if (url) {
    where.push('url = ?');
    params.push(url);
  }
  if (timestamp !== undefined) {
    where.push('ts BETWEEN ? AND ?');
    params.push(timestamp - 10_000, timestamp + 10_000);
  }

  const row = db.prepare(
    `SELECT snapshot_id, trigger_event_id, ts, selector, url
     FROM snapshots
     WHERE ${where.join(' AND ')}
     ORDER BY ${timestamp !== undefined ? 'ABS(ts - ?) ASC,' : ''} ts DESC
     LIMIT 1`
  ).get(...params, ...(timestamp !== undefined ? [timestamp] : [])) as {
    snapshot_id: string;
    trigger_event_id: string | null;
    ts: number;
    selector: string | null;
    url: string | null;
  } | undefined;

  if (!row) {
    return undefined;
  }

  return {
    snapshotId: row.snapshot_id,
    triggerEventId: row.trigger_event_id ?? undefined,
    timestamp: row.ts,
    selector: row.selector ?? undefined,
    url: row.url ?? undefined,
  };
}

function mergeAutomationDiagnosticsEvidence(
  db: Database,
  options: {
    sessionId: string;
    traceId: string;
    failureEvidence?: Record<string, unknown>;
    cdpFailure?: Record<string, unknown>;
  },
): void {
  if (!options.traceId) {
    return;
  }

  const failureEvidence = buildFailureEvidenceSummary(options.failureEvidence);
  const linkedSnapshot = findRelatedFailureSnapshot(db, options.sessionId, options.failureEvidence);
  if (!failureEvidence && !linkedSnapshot && !options.cdpFailure) {
    return;
  }

  const updateDiagnosticsJson = (
    tableName: 'automation_runs' | 'automation_steps',
    keyColumn: 'run_id' | 'step_id',
    keyValue: string,
    existingJson: string | null,
  ): void => {
    const existing = asRecordOrUndefined(parseJsonOrUndefined(existingJson)) ?? {};
    const merged = {
      ...existing,
      ...(options.cdpFailure ? { cdpFailure: options.cdpFailure } : {}),
      ...(failureEvidence ? { failureEvidence } : {}),
      ...(linkedSnapshot ? { linkedSnapshot } : {}),
    };
    db.prepare(`UPDATE ${tableName} SET diagnostics_json = ?, updated_at = ? WHERE ${keyColumn} = ?`).run(
      JSON.stringify(merged),
      Date.now(),
      keyValue,
    );
  };

  const runRow = db.prepare(
    `SELECT run_id, diagnostics_json
     FROM automation_runs
     WHERE session_id = ? AND trace_id = ?
     ORDER BY started_at DESC, updated_at DESC
     LIMIT 1`
  ).get(options.sessionId, options.traceId) as { run_id: string; diagnostics_json: string | null } | undefined;
  if (runRow) {
    updateDiagnosticsJson('automation_runs', 'run_id', runRow.run_id, runRow.diagnostics_json);
  }

  const stepRow = db.prepare(
    `SELECT step_id, diagnostics_json
     FROM automation_steps
     WHERE session_id = ? AND trace_id = ?
     ORDER BY step_order DESC, updated_at DESC
     LIMIT 1`
  ).get(options.sessionId, options.traceId) as { step_id: string; diagnostics_json: string | null } | undefined;
  if (stepRow) {
    updateDiagnosticsJson('automation_steps', 'step_id', stepRow.step_id, stepRow.diagnostics_json);
  }
}

function formatUrlPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function describeEvent(type: string, payload: Record<string, unknown>): string {
  if (type === 'nav') {
    return `Navigation to ${resolveLastUrl(payload) ?? 'unknown URL'}`;
  }

  if (type === 'ui') {
    const selector = typeof payload.selector === 'string' ? payload.selector : 'unknown target';
    const eventType = typeof payload.eventType === 'string' ? payload.eventType : 'interaction';
    return `User ${eventType} on ${selector}`;
  }

  if (type === 'console') {
    const level = typeof payload.level === 'string' ? payload.level : 'log';
    const message = typeof payload.message === 'string' ? payload.message : 'no message';
    return `Console ${level}: ${message}`;
  }

  if (type === 'error') {
    const message = typeof payload.message === 'string' ? payload.message : 'Unknown runtime error';
    return `Runtime error: ${message}`;
  }

  return `${type} event`;
}

function describeNetworkFailure(row: NetworkFailureRow): string {
  const errorType = classifyNetworkFailure(row.status, row.error_class);
  const method = row.method || 'REQUEST';
  const target = formatUrlPath(row.url);
  const statusText = typeof row.status === 'number' ? ` status ${row.status}` : '';
  return `Network ${errorType}: ${method} ${target}${statusText}`;
}

function inferCorrelationRelationship(anchorType: string, candidateType: string, deltaMs: number): string {
  if (anchorType === 'ui' && (candidateType === 'error' || candidateType === 'network')) {
    return deltaMs >= 0 ? 'possible_consequence' : 'possible_trigger';
  }

  if ((anchorType === 'error' || anchorType === 'network') && (candidateType === 'error' || candidateType === 'network')) {
    return 'same_failure_window';
  }

  if (candidateType === 'nav') {
    return 'navigation_context';
  }

  if (candidateType === 'ui') {
    return deltaMs <= 0 ? 'preceding_user_action' : 'subsequent_user_action';
  }

  return 'temporal_proximity';
}

function scoreCorrelation(anchorType: string, candidateType: string, deltaMs: number, windowMs: number): number {
  const distance = Math.abs(deltaMs);
  const temporalScore = Math.max(0, 1 - distance / Math.max(windowMs, 1));

  let semanticWeight = 0.45;
  if (anchorType === 'ui' && (candidateType === 'error' || candidateType === 'network')) {
    semanticWeight = 0.85;
  } else if ((anchorType === 'error' || anchorType === 'network') && (candidateType === 'error' || candidateType === 'network')) {
    semanticWeight = 0.9;
  } else if ((anchorType === 'error' || anchorType === 'network') && candidateType === 'ui') {
    semanticWeight = 0.75;
  } else if (candidateType === 'nav') {
    semanticWeight = 0.6;
  }

  const combined = semanticWeight * 0.7 + temporalScore * 0.3;
  return Number(combined.toFixed(3));
}

function resolveCaptureBytes(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const floored = Math.floor(value);
  if (floored < 1_000) {
    return fallback;
  }

  return Math.min(floored, 1_000_000);
}

function resolveCaptureDepth(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const floored = Math.floor(value);
  if (floored < 1) {
    return fallback;
  }

  return Math.min(floored, 10);
}

function resolveCaptureAncestors(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const floored = Math.floor(value);
  if (floored < 0) {
    return fallback;
  }

  return Math.min(floored, 8);
}

function resolveStructuredMaxItems(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const floored = Math.floor(value);
  if (floored < 1) {
    return fallback;
  }

  return Math.min(floored, 100);
}

function resolveStructuredTextLength(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const floored = Math.floor(value);
  if (floored < 8) {
    return fallback;
  }

  return Math.min(floored, 200);
}

function resolveViewportDimension(value: unknown, axis: 'width' | 'height'): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${axis} must be a finite number`);
  }

  const floored = Math.floor(value);
  const min = axis === 'width' ? 320 : 200;
  const max = axis === 'width' ? 5120 : 4320;
  if (floored < min || floored > max) {
    throw new Error(`${axis} must be between ${min} and ${max}`);
  }

  return floored;
}

type PageStateScope = 'buttons' | 'links' | 'inputs' | 'modals' | 'focused' | 'page';

interface PageStateMatcher {
  scope: PageStateScope;
  selector?: string;
  testId?: string;
  textContains?: string;
  labelContains?: string;
  titleContains?: string;
  role?: string;
  name?: string;
  placeholder?: string;
  altText?: string;
  exact?: boolean;
  frameUrlContains?: string;
  frameTitleContains?: string;
  urlContains?: string;
  language?: string;
  disabled?: boolean;
  selected?: boolean;
  pressed?: boolean;
  expanded?: boolean;
  readOnly?: boolean;
  requiredField?: boolean;
  tagName?: string;
  type?: string;
  visible?: boolean;
  countExactly?: number;
  countAtLeast?: number;
}

interface PageStateWaitResult {
  limitsApplied: { maxResults: number; truncated: boolean };
  matcher: PageStateMatcher;
  matched: boolean;
  matchCount: number;
  expectedCount: { countExactly?: number; countAtLeast?: number };
  sampledMatches: Record<string, unknown>[];
  pageSummary: Record<string, unknown> | undefined;
  page?:
    | {
      url: unknown;
      title: unknown;
      language: unknown;
      viewport: unknown;
    }
    | undefined;
  waitedMs: number;
  attempts: number;
  pollIntervalMs: number;
  timeoutMs?: number;
}

interface UIWorkflowStepResult {
  id: string;
  kind: UIWorkflowStep['kind'];
  status: 'succeeded' | 'failed' | 'skipped';
  durationMs: number;
  action?: UIWorkflowActionStep['action'];
  traceId?: string;
  target?: Record<string, unknown>;
  matcher?: Record<string, unknown>;
  wait?: Record<string, unknown>;
  matchCount?: number;
  waitedMs?: number;
  attempts?: number;
  executionAttempts?: number;
  failurePolicy?: {
    strategy: 'stop' | 'continue' | 'retry_once';
    captureEnabled: boolean;
  };
  failureEvidence?: Record<string, unknown>;
  recommendedAction?: string;
  pageChangeSummary?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
}

interface UIWorkflowResolvedFailurePolicy {
  strategy: 'stop' | 'continue' | 'retry_once';
  captureOptions?: FailureEvidenceCaptureOptions;
}

interface DetailedPageStateWaitResult extends PageStateWaitResult {
  lastCapture?: PageStateCaptureResult;
}

interface AutomationWaitResult {
  waitKind: AutomationWaitSpec['waitKind'];
  matched: boolean;
  waitedMs: number;
  attempts: number;
  timeoutMs: number;
  pollIntervalMs: number;
  evidence?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
}

function buildWaitTimeoutDiagnostics(options: {
  waitKind: AutomationWaitSpec['waitKind'];
  timeoutMs: number;
  waitedMs: number;
  attempts: number;
  pollIntervalMs: number;
  matcherSummary: Record<string, unknown>;
  lastObserved?: unknown;
  candidateCount?: number;
  sampledCandidates?: unknown[];
}): Record<string, unknown> {
  const diagnostics: Record<string, unknown> = {
    waitKind: options.waitKind,
    timeoutMs: options.timeoutMs,
    waitedMs: options.waitedMs,
    attempts: options.attempts,
    pollIntervalMs: options.pollIntervalMs,
    matcherSummary: options.matcherSummary,
  };
  if (options.lastObserved !== undefined) {
    diagnostics.lastObserved = options.lastObserved;
  }
  if (typeof options.candidateCount === 'number') {
    diagnostics.candidateCount = options.candidateCount;
  }
  if (Array.isArray(options.sampledCandidates) && options.sampledCandidates.length > 0) {
    diagnostics.sampledCandidates = options.sampledCandidates;
  }
  return diagnostics;
}

function resolveOptionalMatcherString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function resolveOptionalMatcherBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function resolveOptionalMatcherCount(value: unknown, field: 'countExactly' | 'countAtLeast'): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  const floored = Math.floor(value);
  if (floored < 0) {
    throw new Error(`${field} must be greater than or equal to 0`);
  }

  return floored;
}

function resolvePageStateScope(value: unknown): PageStateScope {
  if (value === 'buttons' || value === 'links' || value === 'inputs' || value === 'modals' || value === 'focused' || value === 'page') {
    return value;
  }

  throw new Error('scope must be one of buttons, links, inputs, modals, focused, or page');
}

function resolvePageStateMatcher(input: ToolInput): PageStateMatcher {
  const matcher: PageStateMatcher = {
    scope: resolvePageStateScope(input.scope),
    selector: resolveOptionalMatcherString(input.selector),
    testId: resolveOptionalMatcherString(input.testId),
    textContains: resolveOptionalMatcherString(input.textContains),
    labelContains: resolveOptionalMatcherString(input.labelContains),
    titleContains: resolveOptionalMatcherString(input.titleContains),
    role: resolveOptionalMatcherString(input.role)?.toLowerCase(),
    name: resolveOptionalMatcherString(input.name),
    placeholder: resolveOptionalMatcherString(input.placeholder),
    altText: resolveOptionalMatcherString(input.altText),
    exact: resolveOptionalMatcherBoolean(input.exact),
    frameUrlContains: resolveOptionalMatcherString(input.frameUrlContains),
    frameTitleContains: resolveOptionalMatcherString(input.frameTitleContains),
    urlContains: resolveOptionalMatcherString(input.urlContains),
    language: resolveOptionalMatcherString(input.language),
    disabled: resolveOptionalMatcherBoolean(input.disabled),
    selected: resolveOptionalMatcherBoolean(input.selected),
    pressed: resolveOptionalMatcherBoolean(input.pressed),
    expanded: resolveOptionalMatcherBoolean(input.expanded),
    readOnly: resolveOptionalMatcherBoolean(input.readOnly),
    requiredField: resolveOptionalMatcherBoolean(input.requiredField),
    tagName: resolveOptionalMatcherString(input.tagName)?.toLowerCase(),
    type: resolveOptionalMatcherString(input.type)?.toLowerCase(),
    visible: resolveOptionalMatcherBoolean(input.visible),
    countExactly: resolveOptionalMatcherCount(input.countExactly, 'countExactly'),
    countAtLeast: resolveOptionalMatcherCount(input.countAtLeast, 'countAtLeast'),
  };

  if (matcher.countExactly !== undefined && matcher.countAtLeast !== undefined) {
    throw new Error('countExactly and countAtLeast cannot both be set');
  }

  return matcher;
}

function includesNormalized(value: unknown, needle: string | undefined): boolean {
  if (!needle) {
    return true;
  }

  return typeof value === 'string' && value.toLowerCase().includes(needle.toLowerCase());
}

function matchesTextValue(value: unknown, expected: string | undefined, exact: boolean | undefined): boolean {
  if (!expected) {
    return true;
  }
  if (typeof value !== 'string') {
    return false;
  }

  const normalizedValue = value.trim().toLowerCase();
  const normalizedExpected = expected.trim().toLowerCase();
  return exact === true
    ? normalizedValue === normalizedExpected
    : normalizedValue.includes(normalizedExpected);
}

function equalsNormalized(value: unknown, expected: string | undefined): boolean {
  if (!expected) {
    return true;
  }

  return typeof value === 'string' && value.toLowerCase() === expected.toLowerCase();
}

function equalsOptionalBoolean(value: unknown, expected: boolean | undefined): boolean {
  if (expected === undefined) {
    return true;
  }

  return value === expected;
}

function pickPageStateScopeItems(payload: Record<string, unknown>, scope: PageStateScope): Record<string, unknown>[] {
  if (scope === 'buttons' || scope === 'links' || scope === 'inputs' || scope === 'modals') {
    const value = payload[scope];
    return asRecordArray(value);
  }

  if (scope === 'focused') {
    const focused = payload.focused;
    return typeof focused === 'object' && focused !== null ? [focused as Record<string, unknown>] : [];
  }

  return [payload];
}

function matchesPageStateItem(item: Record<string, unknown>, matcher: PageStateMatcher): boolean {
  return (
    includesNormalized(item.selector, matcher.selector)
    && equalsNormalized(item.testId, matcher.testId)
    && matchesTextValue(item.text, matcher.textContains, matcher.exact)
    && matchesTextValue(item.label, matcher.labelContains, matcher.exact)
    && matchesTextValue(item.title, matcher.titleContains, matcher.exact)
    && equalsNormalized(item.role, matcher.role)
    && matchesTextValue(item.name, matcher.name, matcher.exact)
    && matchesTextValue(item.placeholder, matcher.placeholder, matcher.exact)
    && matchesTextValue(item.altText, matcher.altText, matcher.exact)
    && includesNormalized(item.frameUrl, matcher.frameUrlContains)
    && includesNormalized(item.frameTitle, matcher.frameTitleContains)
    && includesNormalized(item.url, matcher.urlContains)
    && equalsNormalized(item.language, matcher.language)
    && equalsNormalized(item.tagName, matcher.tagName)
    && equalsNormalized(item.type, matcher.type)
    && equalsOptionalBoolean(item.visible, matcher.visible)
    && equalsOptionalBoolean(item.disabled, matcher.disabled)
    && equalsOptionalBoolean(item.selected, matcher.selected)
    && equalsOptionalBoolean(item.pressed, matcher.pressed)
    && equalsOptionalBoolean(item.expanded, matcher.expanded)
    && equalsOptionalBoolean(item.readOnly, matcher.readOnly)
    && equalsOptionalBoolean(item.required, matcher.requiredField)
  );
}

function evaluatePageStateAssertion(
  payload: Record<string, unknown>,
  matcher: PageStateMatcher,
): {
  matched: boolean;
  matchCount: number;
  sampledMatches: Record<string, unknown>[];
  expectedCount: { countExactly?: number; countAtLeast?: number };
  summary: Record<string, unknown> | undefined;
} {
  const scopeItems = pickPageStateScopeItems(payload, matcher.scope);
  const matchingItems = scopeItems.filter((item) => matchesPageStateItem(item, matcher));
  const matchCount = matchingItems.length;
  const matched =
    matcher.countExactly !== undefined
      ? matchCount === matcher.countExactly
      : matcher.countAtLeast !== undefined
        ? matchCount >= matcher.countAtLeast
        : matchCount >= 1;

  return {
    matched,
    matchCount,
    sampledMatches: matchingItems.slice(0, 5),
    expectedCount: {
      countExactly: matcher.countExactly,
      countAtLeast: matcher.countAtLeast,
    },
    summary:
      typeof payload.summary === 'object' && payload.summary !== null
        ? payload.summary as Record<string, unknown>
        : undefined,
  };
}

function extractPageSummarySnapshot(
  capture: PageStateCaptureResult | undefined,
): {
  url?: string;
  language?: string;
  summary?: Record<string, unknown>;
  focusedText?: string;
} | undefined {
  if (!capture) {
    return undefined;
  }

  const summary =
    typeof capture.payload.summary === 'object' && capture.payload.summary !== null
      ? capture.payload.summary as Record<string, unknown>
      : undefined;
  const focused =
    typeof capture.payload.focused === 'object' && capture.payload.focused !== null
      ? capture.payload.focused as Record<string, unknown>
      : undefined;

  return {
    url: typeof capture.payload.url === 'string' ? capture.payload.url : undefined,
    language: typeof capture.payload.language === 'string' ? capture.payload.language : undefined,
    summary,
    focusedText: typeof focused?.text === 'string' ? focused.text : undefined,
  };
}

function createPageChangeSummary(
  previousCapture: PageStateCaptureResult | undefined,
  currentCapture: PageStateCaptureResult | undefined,
): Record<string, unknown> | undefined {
  const previous = extractPageSummarySnapshot(previousCapture);
  const current = extractPageSummarySnapshot(currentCapture);
  if (!current) {
    return undefined;
  }

  const changes: string[] = [];
  const previousSummary = previous?.summary;
  const currentSummary = current.summary;
  const summaryDelta: Record<string, { previous?: number; current?: number }> = {};

  for (const key of ['buttons', 'links', 'inputs', 'modals']) {
    const previousValue = typeof previousSummary?.[key] === 'number' ? previousSummary[key] as number : undefined;
    const currentValue = typeof currentSummary?.[key] === 'number' ? currentSummary[key] as number : undefined;
    if (previousValue !== currentValue && currentValue !== undefined) {
      summaryDelta[key] = {
        previous: previousValue,
        current: currentValue,
      };
      changes.push(`${key} ${previousValue ?? 0} -> ${currentValue}`);
    }
  }

  if (previous?.url && current.url && previous.url !== current.url) {
    changes.push(`url changed`);
  }
  if (previous?.language && current.language && previous.language !== current.language) {
    changes.push(`language ${previous.language} -> ${current.language}`);
  }
  if ((previous?.focusedText ?? '') !== (current.focusedText ?? '') && current.focusedText) {
    changes.push('focused element changed');
  }

  return {
    changes,
    previous: previous ?? null,
    current,
    summaryDelta,
  };
}

type InteractiveElementKind = 'buttons' | 'links' | 'inputs' | 'modals' | 'focused';

function resolveInteractiveKinds(value: unknown): InteractiveElementKind[] {
  if (!Array.isArray(value) || value.length === 0) {
    return ['buttons', 'links', 'inputs', 'modals', 'focused'];
  }

  const allowed = new Set(['buttons', 'links', 'inputs', 'modals', 'focused']);
  const kinds = value
    .filter((entry): entry is string => typeof entry === 'string' && allowed.has(entry))
    .map((entry) => entry as InteractiveElementKind);

  return kinds.length > 0 ? Array.from(new Set(kinds)) : ['buttons', 'links', 'inputs', 'modals', 'focused'];
}

function collectInteractiveElementRefs(
  payload: Record<string, unknown>,
  kinds: InteractiveElementKind[],
  maxItems: number,
): Array<Record<string, unknown>> {
  const refs: Array<Record<string, unknown>> = [];
  for (const kind of kinds) {
    if (kind === 'focused') {
      const focused = typeof payload.focused === 'object' && payload.focused !== null
        ? payload.focused as Record<string, unknown>
        : undefined;
      if (focused?.elementRef) {
        refs.push({
          kind,
          ...focused,
        });
      }
      continue;
    }

    for (const item of asRecordArray(payload[kind])) {
      refs.push({
        kind,
        ...item,
      });
      if (refs.length >= maxItems) {
        return refs.slice(0, maxItems);
      }
    }
  }

  return refs.slice(0, maxItems);
}

async function waitForPageStateConditionDetailed(
  sessionId: string,
  input: ToolInput,
  capturePageState: (
    sessionId: string,
    input: ToolInput,
  ) => Promise<PageStateCaptureResult>,
  initialCapture?: PageStateCaptureResult,
): Promise<DetailedPageStateWaitResult> {
  const matcher = resolvePageStateMatcher(input);
  const timeoutMs = resolveTimeoutMs(input.timeoutMs, 5_000, 30_000);
  const pollIntervalMs = resolveDurationMs(input.pollIntervalMs, 50, 2_000) ?? 200;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;
  let lastCapture: PageStateCaptureResult | undefined = initialCapture;
  let lastAssertion:
    | ReturnType<typeof evaluatePageStateAssertion>
    | undefined;

  if (lastCapture) {
    lastAssertion = evaluatePageStateAssertion(lastCapture.payload, matcher);
    if (lastAssertion.matched) {
      return {
        limitsApplied: lastCapture.limitsApplied,
        matcher,
        matched: true,
        matchCount: lastAssertion.matchCount,
        expectedCount: lastAssertion.expectedCount,
        sampledMatches: lastAssertion.sampledMatches,
        pageSummary: lastAssertion.summary,
        page: {
          url: lastCapture.payload.url,
          title: lastCapture.payload.title,
          language: lastCapture.payload.language,
          viewport: lastCapture.payload.viewport,
        },
        waitedMs: 0,
        attempts,
        pollIntervalMs,
        lastCapture,
      };
    }
  }

  while (Date.now() <= deadline) {
    attempts += 1;
    lastCapture = await capturePageState(sessionId, input);
    lastAssertion = evaluatePageStateAssertion(lastCapture.payload, matcher);
    if (lastAssertion.matched) {
      return {
        limitsApplied: lastCapture.limitsApplied,
        matcher,
        matched: true,
        matchCount: lastAssertion.matchCount,
        expectedCount: lastAssertion.expectedCount,
        sampledMatches: lastAssertion.sampledMatches,
        pageSummary: lastAssertion.summary,
        page: {
          url: lastCapture.payload.url,
          title: lastCapture.payload.title,
          language: lastCapture.payload.language,
          viewport: lastCapture.payload.viewport,
        },
        waitedMs: Date.now() - startedAt,
        attempts,
        pollIntervalMs,
        lastCapture,
      };
    }

    await sleep(pollIntervalMs);
  }

  return {
    limitsApplied: lastCapture?.limitsApplied ?? { maxResults: 0, truncated: false },
    matcher,
    matched: false,
    matchCount: lastAssertion?.matchCount ?? 0,
    expectedCount: lastAssertion?.expectedCount ?? {
      countExactly: matcher.countExactly,
      countAtLeast: matcher.countAtLeast,
    },
    sampledMatches: lastAssertion?.sampledMatches ?? [],
    pageSummary: lastAssertion?.summary,
    page: lastCapture
      ? {
          url: lastCapture.payload.url,
          title: lastCapture.payload.title,
          language: lastCapture.payload.language,
          viewport: lastCapture.payload.viewport,
        }
      : undefined,
    waitedMs: Date.now() - startedAt,
    attempts,
    pollIntervalMs,
    timeoutMs,
    lastCapture,
  };
}

async function waitForPageStateCondition(
  sessionId: string,
  input: ToolInput,
  capturePageState: (
    sessionId: string,
    input: ToolInput,
  ) => Promise<PageStateCaptureResult>,
): Promise<PageStateWaitResult> {
  const detailed = await waitForPageStateConditionDetailed(sessionId, input, capturePageState);
  const { lastCapture: _lastCapture, ...waited } = detailed;
  return waited;
}

function compileWaitRegex(value: string | undefined, fieldName: string): RegExp | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return new RegExp(value);
  } catch {
    throw new Error(`${fieldName} must be a valid regular expression`);
  }
}

function matchesUrlWait(url: unknown, wait: z.infer<typeof AutomationWaitUrlSchema>): boolean {
  return matchesUrlPredicates(url, {
    exactUrl: wait.exactUrl,
    urlContains: wait.urlContains,
    urlRegex: wait.urlRegex,
  });
}

function matchesUrlPredicates(
  url: unknown,
  predicates: { exactUrl?: string; urlContains?: string; urlRegex?: string; regexFieldName?: string },
): boolean {
  if (typeof url !== 'string') {
    return false;
  }
  if (predicates.exactUrl && url !== predicates.exactUrl) {
    return false;
  }
  if (predicates.urlContains && !url.includes(predicates.urlContains)) {
    return false;
  }
  const regex = compileWaitRegex(predicates.urlRegex, predicates.regexFieldName ?? 'urlRegex');
  if (regex && !regex.test(url)) {
    return false;
  }
  return true;
}

function resolveAutomationWaitSinceTs(value: unknown): number {
  return resolveOptionalTimestamp(value) ?? Math.max(0, Date.now() - DEFAULT_AUTOMATION_WAIT_LOOKBACK_MS);
}

function isElementMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no element found for selector/i.test(message);
}

async function captureSelectorState(
  captureClient: CaptureCommandClient,
  sessionId: string,
  selector: string,
  frameId: number = 0,
): Promise<Record<string, unknown>> {
  try {
    const [styleCapture, layoutCapture] = await Promise.all([
      executeLiveCapture(
        captureClient,
        sessionId,
        'CAPTURE_COMPUTED_STYLES',
        { selector, frameId, properties: ['display', 'visibility', 'opacity'] },
        3_000,
      ),
      executeLiveCapture(
        captureClient,
        sessionId,
        'CAPTURE_LAYOUT_METRICS',
        { selector, frameId },
        3_000,
      ),
    ]);
    const stylePayload = ensureCaptureSuccess(styleCapture, sessionId);
    const layoutPayload = ensureCaptureSuccess(layoutCapture, sessionId);
    const properties = isRecord(stylePayload.properties) ? stylePayload.properties : {};
    const element = isRecord(layoutPayload.element) ? layoutPayload.element : {};
    const width = typeof element.width === 'number' ? element.width : 0;
    const height = typeof element.height === 'number' ? element.height : 0;
    const display = typeof properties.display === 'string' ? properties.display : undefined;
    const visibility = typeof properties.visibility === 'string' ? properties.visibility : undefined;
    const opacityText = typeof properties.opacity === 'string' ? properties.opacity : undefined;
    const opacity = opacityText !== undefined ? Number.parseFloat(opacityText) : undefined;
    const visible = display !== 'none'
      && visibility !== 'hidden'
      && visibility !== 'collapse'
      && opacity !== 0
      && width > 0
      && height > 0;

    return {
      selector,
      frameId,
      attached: true,
      visible,
      styles: properties,
      element,
      viewport: layoutPayload.viewport,
    };
  } catch (error) {
    if (isElementMissingError(error)) {
      return {
        selector,
        frameId,
        attached: false,
        visible: false,
        missing: true,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    throw error;
  }
}

function selectorStateMatches(state: Record<string, unknown>, expectedState: 'attached' | 'detached' | 'visible' | 'hidden'): boolean {
  const attached = state.attached === true;
  const visible = state.visible === true;
  switch (expectedState) {
    case 'attached':
      return attached;
    case 'detached':
      return !attached;
    case 'visible':
      return attached && visible;
    case 'hidden':
      return !attached || !visible;
  }
}

async function waitForUrlCondition(
  sessionId: string,
  wait: z.infer<typeof AutomationWaitUrlSchema>,
  capturePageState: (
    sessionId: string,
    input: ToolInput,
  ) => Promise<PageStateCaptureResult>,
): Promise<AutomationWaitResult> {
  const timeoutMs = resolveTimeoutMs(wait.timeoutMs, 5_000, MAX_NETWORK_POLL_TIMEOUT_MS);
  const pollIntervalMs = resolveDurationMs(wait.pollIntervalMs, 100, 5_000);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;
  let lastPage: Record<string, unknown> | undefined;

  while (Date.now() <= deadline) {
    attempts += 1;
    const capture = await capturePageState(sessionId, {
      includeButtons: false,
      includeLinks: false,
      includeInputs: false,
      includeModals: false,
      maxItems: 1,
      maxTextLength: 40,
    });
    lastPage = {
      url: capture.payload.url,
      title: capture.payload.title,
      language: capture.payload.language,
      viewport: capture.payload.viewport,
    };
    if (matchesUrlWait(capture.payload.url, wait)) {
      return {
        waitKind: 'url',
        matched: true,
        waitedMs: Date.now() - startedAt,
        attempts,
        timeoutMs,
        pollIntervalMs,
        evidence: { page: lastPage },
      };
    }
    await sleep(pollIntervalMs);
  }

  return {
    waitKind: 'url',
    matched: false,
    waitedMs: Date.now() - startedAt,
    attempts,
    timeoutMs,
    pollIntervalMs,
    evidence: {
      page: lastPage,
      expected: wait,
      timeoutDiagnostics: buildWaitTimeoutDiagnostics({
        waitKind: 'url',
        timeoutMs,
        waitedMs: Date.now() - startedAt,
        attempts,
        pollIntervalMs,
        matcherSummary: {
          exactUrl: wait.exactUrl,
          urlContains: wait.urlContains,
          urlRegex: wait.urlRegex,
        },
        lastObserved: lastPage,
      }),
    },
    error: {
      code: 'url_wait_timeout',
      message: 'Timed out waiting for the page URL to match the requested condition.',
    },
  };
}

function pageReadyStateMatches(
  readyState: unknown,
  expectedState: z.infer<typeof AutomationWaitLoadStateSchema>['state'],
): boolean {
  if (readyState !== 'loading' && readyState !== 'interactive' && readyState !== 'complete') {
    return false;
  }
  if (expectedState === 'domcontentloaded') {
    return readyState === 'interactive' || readyState === 'complete';
  }
  return readyState === 'complete';
}

async function waitForLoadStateCondition(
  sessionId: string,
  wait: z.infer<typeof AutomationWaitLoadStateSchema>,
  capturePageState: (
    sessionId: string,
    input: ToolInput,
  ) => Promise<PageStateCaptureResult>,
): Promise<AutomationWaitResult> {
  const timeoutMs = resolveTimeoutMs(wait.timeoutMs, 5_000, MAX_NETWORK_POLL_TIMEOUT_MS);
  const pollIntervalMs = resolveDurationMs(wait.pollIntervalMs, 100, 5_000);
  const expectedState = wait.state ?? 'load';
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;
  let lastPage: Record<string, unknown> | undefined;

  while (Date.now() <= deadline) {
    attempts += 1;
    const capture = await capturePageState(sessionId, {
      includeButtons: false,
      includeLinks: false,
      includeInputs: false,
      includeModals: false,
      maxItems: 1,
      maxTextLength: 40,
    });
    lastPage = {
      url: capture.payload.url,
      title: capture.payload.title,
      readyState: capture.payload.readyState,
      language: capture.payload.language,
      viewport: capture.payload.viewport,
    };
    const urlMatches = matchesUrlPredicates(
      typeof capture.payload.url === 'string' ? capture.payload.url : undefined,
      {
        exactUrl: wait.exactUrl,
        urlContains: wait.urlContains,
        urlRegex: wait.urlRegex,
      },
    );
    if (urlMatches && pageReadyStateMatches(capture.payload.readyState, expectedState)) {
      return {
        waitKind: 'load_state',
        matched: true,
        waitedMs: Date.now() - startedAt,
        attempts,
        timeoutMs,
        pollIntervalMs,
        evidence: {
          state: expectedState,
          page: lastPage,
        },
      };
    }
    await sleep(pollIntervalMs);
  }

  return {
    waitKind: 'load_state',
    matched: false,
    waitedMs: Date.now() - startedAt,
    attempts,
    timeoutMs,
    pollIntervalMs,
    evidence: {
      state: expectedState,
      page: lastPage,
      expected: wait,
      timeoutDiagnostics: buildWaitTimeoutDiagnostics({
        waitKind: 'load_state',
        timeoutMs,
        waitedMs: Date.now() - startedAt,
        attempts,
        pollIntervalMs,
        matcherSummary: {
          state: expectedState,
          exactUrl: wait.exactUrl,
          urlContains: wait.urlContains,
          urlRegex: wait.urlRegex,
        },
        lastObserved: lastPage,
      }),
    },
    error: {
      code: 'load_state_wait_timeout',
      message: `Timed out waiting for page load state "${expectedState}".`,
    },
  };
}

async function waitForSelectorStateCondition(
  sessionId: string,
  wait: z.infer<typeof AutomationWaitSelectorStateSchema>,
  captureClient: CaptureCommandClient,
): Promise<AutomationWaitResult> {
  const timeoutMs = resolveTimeoutMs(wait.timeoutMs, 5_000, MAX_NETWORK_POLL_TIMEOUT_MS);
  const pollIntervalMs = resolveDurationMs(wait.pollIntervalMs, 100, 5_000);
  const expectedState = wait.state ?? 'visible';
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;
  let lastState: Record<string, unknown> | undefined;

  while (Date.now() <= deadline) {
    attempts += 1;
    lastState = await captureSelectorState(captureClient, sessionId, wait.selector, wait.frameId);
    if (selectorStateMatches(lastState, expectedState)) {
      return {
        waitKind: 'selector_state',
        matched: true,
        waitedMs: Date.now() - startedAt,
        attempts,
        timeoutMs,
        pollIntervalMs,
        evidence: {
          selector: wait.selector,
          state: expectedState,
          selectorState: lastState,
        },
      };
    }
    await sleep(pollIntervalMs);
  }

  return {
    waitKind: 'selector_state',
    matched: false,
    waitedMs: Date.now() - startedAt,
    attempts,
    timeoutMs,
    pollIntervalMs,
    evidence: {
      selector: wait.selector,
      state: expectedState,
      selectorState: lastState,
      timeoutDiagnostics: buildWaitTimeoutDiagnostics({
        waitKind: 'selector_state',
        timeoutMs,
        waitedMs: Date.now() - startedAt,
        attempts,
        pollIntervalMs,
        matcherSummary: {
          selector: wait.selector,
          state: expectedState,
          frameId: wait.frameId,
        },
        lastObserved: lastState,
      }),
    },
    error: {
      code: 'selector_state_wait_timeout',
      message: `Timed out waiting for selector "${wait.selector}" to become ${expectedState}.`,
    },
  };
}

async function waitForConsoleCondition(
  sessionId: string,
  wait: z.infer<typeof AutomationWaitConsoleSchema>,
  captureClient: CaptureCommandClient,
): Promise<AutomationWaitResult> {
  const timeoutMs = resolveTimeoutMs(wait.timeoutMs, 5_000, MAX_NETWORK_POLL_TIMEOUT_MS);
  const pollIntervalMs = resolveDurationMs(wait.pollIntervalMs, 100, 5_000);
  const levels = resolveLiveConsoleLevels(wait.levels);
  const contains = normalizeOptionalString(wait.contains);
  const sinceTs = resolveAutomationWaitSinceTs(wait.sinceTs);
  const includeRuntimeErrors = wait.includeRuntimeErrors !== false;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;
  let lastLogs: Record<string, unknown>[] = [];

  while (Date.now() <= deadline) {
    attempts += 1;
    const capture = await executeLiveCapture(
      captureClient,
      sessionId,
      'CAPTURE_GET_LIVE_CONSOLE_LOGS',
      {
        levels,
        contains,
        sinceTs,
        includeRuntimeErrors,
        limit: 10,
      },
      3_000,
    );
    const payload = ensureCaptureSuccess(capture, sessionId);
    lastLogs = asRecordArray(payload.logs);
    if (lastLogs.length > 0) {
      return {
        waitKind: 'console',
        matched: true,
        waitedMs: Date.now() - startedAt,
        attempts,
        timeoutMs,
        pollIntervalMs,
        evidence: {
          filters: { levels, contains, sinceTs, includeRuntimeErrors },
          logs: lastLogs.slice(0, 5).map((log) => mapLiveConsoleLogRecord(log, 'compact')),
        },
      };
    }
    await sleep(pollIntervalMs);
  }

  return {
    waitKind: 'console',
    matched: false,
    waitedMs: Date.now() - startedAt,
    attempts,
    timeoutMs,
    pollIntervalMs,
    evidence: {
      filters: { levels, contains, sinceTs, includeRuntimeErrors },
      sampledLogs: lastLogs.slice(0, 5).map((log) => mapLiveConsoleLogRecord(log, 'compact')),
      timeoutDiagnostics: buildWaitTimeoutDiagnostics({
        waitKind: 'console',
        timeoutMs,
        waitedMs: Date.now() - startedAt,
        attempts,
        pollIntervalMs,
        matcherSummary: { levels, contains, sinceTs, includeRuntimeErrors },
        lastObserved: lastLogs[0],
        candidateCount: lastLogs.length,
        sampledCandidates: lastLogs.slice(0, 5).map((log) => mapLiveConsoleLogRecord(log, 'compact')),
      }),
    },
    error: {
      code: 'console_wait_timeout',
      message: 'Timed out waiting for a matching live console log.',
    },
  };
}

async function waitForDialogCondition(
  sessionId: string,
  wait: z.infer<typeof AutomationWaitDialogSchema>,
  captureClient: CaptureCommandClient,
): Promise<AutomationWaitResult> {
  const timeoutMs = resolveTimeoutMs(wait.timeoutMs, 5_000, MAX_NETWORK_POLL_TIMEOUT_MS);
  const startedAt = Date.now();
  const capture = await executeLiveCapture(
    captureClient,
    sessionId,
    'CAPTURE_WAIT_FOR_DIALOG',
    {
      type: wait.type,
      messageContains: wait.messageContains,
      urlContains: wait.urlContains,
      action: wait.action,
      promptText: wait.promptText,
      tabId: wait.tabId,
      timeoutMs,
    },
    timeoutMs + 2_000,
  );
  const payload = ensureCaptureSuccess(capture, sessionId);
  const matched = payload.matched === true;

  return {
    waitKind: 'dialog',
    matched,
    waitedMs: Date.now() - startedAt,
    attempts: 1,
    timeoutMs,
    pollIntervalMs: timeoutMs,
    evidence: {
      filters: {
        type: wait.type,
        messageContains: wait.messageContains,
        urlContains: wait.urlContains,
        action: wait.action,
        tabId: wait.tabId,
      },
      dialog: matched ? payload : undefined,
      expected: matched ? undefined : payload.expected ?? wait,
      timeoutDiagnostics: matched
        ? undefined
        : buildWaitTimeoutDiagnostics({
            waitKind: 'dialog',
            timeoutMs,
            waitedMs: Date.now() - startedAt,
            attempts: 1,
            pollIntervalMs: timeoutMs,
            matcherSummary: {
              type: wait.type,
              messageContains: wait.messageContains,
              urlContains: wait.urlContains,
              action: wait.action,
              tabId: wait.tabId,
            },
            lastObserved: payload.lastObserved,
            candidateCount: typeof payload.observedCount === 'number' ? payload.observedCount : undefined,
          }),
    },
    error: matched
      ? undefined
      : {
          code: 'dialog_wait_timeout',
          message: 'Timed out waiting for a matching JavaScript dialog.',
      },
  };
}

async function waitForStableLayoutCondition(
  sessionId: string,
  wait: z.infer<typeof AutomationWaitStableLayoutSchema>,
  captureClient: CaptureCommandClient,
): Promise<AutomationWaitResult> {
  const timeoutMs = resolveTimeoutMs(wait.timeoutMs, 5_000, MAX_NETWORK_POLL_TIMEOUT_MS);
  const stableMs = wait.stableMs;
  const pollIntervalMs = resolveDurationMs(wait.pollIntervalMs, 100, 5_000);
  const startedAt = Date.now();
  const capture = await executeLiveCapture(
    captureClient,
    sessionId,
    'CAPTURE_WAIT_FOR_STABLE_LAYOUT',
    {
      selector: wait.selector,
      stableMs,
      tabId: wait.tabId,
      timeoutMs,
      pollIntervalMs,
    },
    timeoutMs + 2_000,
  );
  const payload = ensureCaptureSuccess(capture, sessionId);
  const matched = payload.matched === true;

  return {
    waitKind: 'stable_layout',
    matched,
    waitedMs: Date.now() - startedAt,
    attempts: 1,
    timeoutMs,
    pollIntervalMs,
    evidence: {
      filters: {
        selector: wait.selector,
        stableMs,
        tabId: wait.tabId,
      },
      layout: payload,
      timeoutDiagnostics: matched
        ? undefined
        : buildWaitTimeoutDiagnostics({
            waitKind: 'stable_layout',
            timeoutMs,
            waitedMs: Date.now() - startedAt,
            attempts: typeof payload.attempts === 'number' ? payload.attempts : 1,
            pollIntervalMs,
            matcherSummary: {
              selector: wait.selector,
              stableMs,
              tabId: wait.tabId,
            },
            lastObserved: payload.snapshot,
          }),
    },
    error: matched
      ? undefined
      : {
          code: 'stable_layout_wait_timeout',
          message: 'Timed out waiting for layout to stay stable.',
        },
  };
}

function mapNavigationWaitEvent(row: EventRow): Record<string, unknown> {
  const payload = readJsonPayload(row.payload_json);
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    timestamp: row.ts,
    tabId: row.tab_id ?? undefined,
    origin: row.origin ?? undefined,
    url: resolveLastUrl(payload),
    from: typeof payload.from === 'string' ? payload.from : undefined,
    trigger: typeof payload.trigger === 'string' ? payload.trigger : undefined,
    payload,
  };
}

function navigationEventMatches(row: EventRow, wait: z.infer<typeof AutomationWaitNavigationSchema>): boolean {
  const payload = readJsonPayload(row.payload_json);
  const toUrl = resolveLastUrl(payload);
  const fromUrl = typeof payload.from === 'string' ? payload.from : undefined;
  const trigger = typeof payload.trigger === 'string' ? payload.trigger : undefined;

  if (!matchesUrlPredicates(toUrl, {
    exactUrl: wait.exactUrl,
    urlContains: wait.urlContains,
    urlRegex: wait.urlRegex,
  })) {
    return false;
  }

  if (wait.fromUrlContains || wait.fromUrlRegex) {
    if (!matchesUrlPredicates(fromUrl, {
      urlContains: wait.fromUrlContains,
      urlRegex: wait.fromUrlRegex,
      regexFieldName: 'fromUrlRegex',
    })) {
      return false;
    }
  }

  if (wait.trigger && trigger !== wait.trigger) {
    return false;
  }

  return true;
}

function queryNavigationWaitCandidates(
  db: Database,
  options: {
    sessionId: string;
    sinceTs: number;
    tabId?: number;
  },
): EventRow[] {
  const where: string[] = ['session_id = ?', "type = 'nav'", 'ts >= ?'];
  const params: unknown[] = [options.sessionId, options.sinceTs];
  if (options.tabId !== undefined) {
    where.push('tab_id = ?');
    params.push(options.tabId);
  }

  return db.prepare(
    `SELECT event_id, session_id, ts, type, payload_json, tab_id, origin
     FROM events
     WHERE ${where.join(' AND ')}
     ORDER BY ts ASC
     LIMIT 200`
  ).all(...params) as EventRow[];
}

async function waitForNavigationCondition(
  sessionId: string,
  wait: z.infer<typeof AutomationWaitNavigationSchema>,
  db: Database,
): Promise<AutomationWaitResult> {
  const timeoutMs = resolveTimeoutMs(wait.timeoutMs, 5_000, MAX_NETWORK_POLL_TIMEOUT_MS);
  const pollIntervalMs = resolveDurationMs(wait.pollIntervalMs, 100, 5_000);
  const sinceTs = resolveAutomationWaitSinceTs(wait.sinceTs);
  const tabId = resolveOptionalTabId(wait.tabId);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;
  let lastEvents: EventRow[] = [];

  while (Date.now() <= deadline) {
    attempts += 1;
    lastEvents = queryNavigationWaitCandidates(db, { sessionId, sinceTs, tabId });
    const matched = lastEvents.find((row) => navigationEventMatches(row, wait));
    if (matched) {
      return {
        waitKind: 'navigation',
        matched: true,
        waitedMs: Date.now() - startedAt,
        attempts,
        timeoutMs,
        pollIntervalMs,
        evidence: {
          filters: {
            urlContains: wait.urlContains,
            urlRegex: wait.urlRegex,
            exactUrl: wait.exactUrl,
            fromUrlContains: wait.fromUrlContains,
            fromUrlRegex: wait.fromUrlRegex,
            trigger: wait.trigger,
            sinceTs,
            tabId,
          },
          navigation: mapNavigationWaitEvent(matched),
        },
      };
    }
    await sleep(pollIntervalMs);
  }

  return {
    waitKind: 'navigation',
    matched: false,
    waitedMs: Date.now() - startedAt,
    attempts,
    timeoutMs,
    pollIntervalMs,
    evidence: {
      filters: {
        urlContains: wait.urlContains,
        urlRegex: wait.urlRegex,
        exactUrl: wait.exactUrl,
        fromUrlContains: wait.fromUrlContains,
        fromUrlRegex: wait.fromUrlRegex,
        trigger: wait.trigger,
        sinceTs,
        tabId,
      },
      sampledEvents: lastEvents.slice(0, 5).map((row) => mapNavigationWaitEvent(row)),
      timeoutDiagnostics: buildWaitTimeoutDiagnostics({
        waitKind: 'navigation',
        timeoutMs,
        waitedMs: Date.now() - startedAt,
        attempts,
        pollIntervalMs,
        matcherSummary: {
          urlContains: wait.urlContains,
          urlRegex: wait.urlRegex,
          exactUrl: wait.exactUrl,
          fromUrlContains: wait.fromUrlContains,
          fromUrlRegex: wait.fromUrlRegex,
          trigger: wait.trigger,
          sinceTs,
          tabId,
        },
        lastObserved: lastEvents.length > 0 ? mapNavigationWaitEvent(lastEvents[lastEvents.length - 1] as EventRow) : undefined,
        candidateCount: lastEvents.length,
        sampledCandidates: lastEvents.slice(0, 5).map((row) => mapNavigationWaitEvent(row)),
      }),
    },
    error: {
      code: 'navigation_wait_timeout',
      message: 'Timed out waiting for a matching navigation event.',
    },
  };
}

async function waitForNavigationLifecycleCondition(
  sessionId: string,
  wait: z.infer<typeof AutomationWaitNavigationLifecycleSchema>,
  captureClient: CaptureCommandClient,
): Promise<AutomationWaitResult> {
  const timeoutMs = resolveTimeoutMs(wait.timeoutMs, 5_000, MAX_NETWORK_POLL_TIMEOUT_MS);
  const startedAt = Date.now();
  const capture = await executeLiveCapture(
    captureClient,
    sessionId,
    'CAPTURE_WAIT_FOR_NAVIGATION_LIFECYCLE',
    {
      state: wait.state,
      urlContains: wait.urlContains,
      urlRegex: wait.urlRegex,
      exactUrl: wait.exactUrl,
      tabId: wait.tabId,
      timeoutMs,
    },
    timeoutMs + 2_000,
  );
  const payload = ensureCaptureSuccess(capture, sessionId);
  const matched = payload.matched === true;

  return {
    waitKind: 'navigation_lifecycle',
    matched,
    waitedMs: Date.now() - startedAt,
    attempts: 1,
    timeoutMs,
    pollIntervalMs: timeoutMs,
    evidence: {
      filters: {
        state: wait.state,
        urlContains: wait.urlContains,
        urlRegex: wait.urlRegex,
        exactUrl: wait.exactUrl,
        tabId: wait.tabId,
      },
      lifecycle: matched ? payload : undefined,
      expected: matched ? undefined : payload.expected ?? wait,
      timeoutDiagnostics: matched
        ? undefined
        : buildWaitTimeoutDiagnostics({
            waitKind: 'navigation_lifecycle',
            timeoutMs,
            waitedMs: Date.now() - startedAt,
            attempts: 1,
            pollIntervalMs: timeoutMs,
            matcherSummary: {
              state: wait.state,
              urlContains: wait.urlContains,
              urlRegex: wait.urlRegex,
              exactUrl: wait.exactUrl,
              tabId: wait.tabId,
            },
            lastObserved: payload.lastObserved,
            candidateCount: typeof payload.observedEventCount === 'number' ? payload.observedEventCount : undefined,
          }),
    },
    error: matched
      ? undefined
      : {
          code: 'navigation_lifecycle_wait_timeout',
          message: 'Timed out waiting for a matching navigation lifecycle event.',
        },
  };
}

async function waitForDownloadCondition(
  sessionId: string,
  wait: z.infer<typeof AutomationWaitDownloadSchema>,
  captureClient: CaptureCommandClient,
): Promise<AutomationWaitResult> {
  const timeoutMs = resolveTimeoutMs(wait.timeoutMs, 5_000, MAX_NETWORK_POLL_TIMEOUT_MS);
  const startedAt = Date.now();
  const capture = await executeLiveCapture(
    captureClient,
    sessionId,
    'CAPTURE_WAIT_FOR_DOWNLOAD',
    {
      urlContains: wait.urlContains,
      urlRegex: wait.urlRegex,
      exactUrl: wait.exactUrl,
      filenameContains: wait.filenameContains,
      filenameRegex: wait.filenameRegex,
      state: wait.state,
      tabId: wait.tabId,
      timeoutMs,
    },
    timeoutMs + 2_000,
  );
  const payload = ensureCaptureSuccess(capture, sessionId);
  const matched = payload.matched === true;

  return {
    waitKind: 'download',
    matched,
    waitedMs: Date.now() - startedAt,
    attempts: 1,
    timeoutMs,
    pollIntervalMs: timeoutMs,
    evidence: {
      filters: {
        urlContains: wait.urlContains,
        urlRegex: wait.urlRegex,
        exactUrl: wait.exactUrl,
        filenameContains: wait.filenameContains,
        filenameRegex: wait.filenameRegex,
        state: wait.state,
        tabId: wait.tabId,
      },
      download: matched ? payload : undefined,
      expected: matched ? undefined : payload.expected ?? wait,
      timeoutDiagnostics: matched
        ? undefined
        : buildWaitTimeoutDiagnostics({
            waitKind: 'download',
            timeoutMs,
            waitedMs: Date.now() - startedAt,
            attempts: 1,
            pollIntervalMs: timeoutMs,
            matcherSummary: {
              urlContains: wait.urlContains,
              urlRegex: wait.urlRegex,
              exactUrl: wait.exactUrl,
              filenameContains: wait.filenameContains,
              filenameRegex: wait.filenameRegex,
              state: wait.state,
              tabId: wait.tabId,
            },
            lastObserved: payload.lastObserved ?? payload.lastMatchedDownload,
            candidateCount: typeof payload.observedEventCount === 'number' ? payload.observedEventCount : undefined,
          }),
    },
    error: matched
      ? undefined
      : {
          code: 'download_wait_timeout',
          message: 'Timed out waiting for a matching download.',
        },
  };
}

async function waitForPopupCondition(
  sessionId: string,
  wait: z.infer<typeof AutomationWaitPopupSchema>,
  captureClient: CaptureCommandClient,
): Promise<AutomationWaitResult> {
  const timeoutMs = resolveTimeoutMs(wait.timeoutMs, 5_000, MAX_NETWORK_POLL_TIMEOUT_MS);
  const startedAt = Date.now();
  const capture = await executeLiveCapture(
    captureClient,
    sessionId,
    'CAPTURE_WAIT_FOR_POPUP',
    {
      urlContains: wait.urlContains,
      urlRegex: wait.urlRegex,
      exactUrl: wait.exactUrl,
      openerTabId: wait.openerTabId,
      timeoutMs,
    },
    timeoutMs + 2_000,
  );
  const payload = ensureCaptureSuccess(capture, sessionId);
  const matched = payload.matched === true;

  return {
    waitKind: 'popup',
    matched,
    waitedMs: Date.now() - startedAt,
    attempts: 1,
    timeoutMs,
    pollIntervalMs: timeoutMs,
    evidence: {
      filters: {
        urlContains: wait.urlContains,
        urlRegex: wait.urlRegex,
        exactUrl: wait.exactUrl,
        openerTabId: wait.openerTabId,
      },
      popup: matched ? payload : undefined,
      expected: matched ? undefined : payload.expected ?? wait,
      timeoutDiagnostics: matched
        ? undefined
        : buildWaitTimeoutDiagnostics({
            waitKind: 'popup',
            timeoutMs,
            waitedMs: Date.now() - startedAt,
            attempts: 1,
            pollIntervalMs: timeoutMs,
            matcherSummary: {
              urlContains: wait.urlContains,
              urlRegex: wait.urlRegex,
              exactUrl: wait.exactUrl,
              openerTabId: wait.openerTabId,
            },
            lastObserved: payload.lastObserved,
            candidateCount: typeof payload.observedPopupCount === 'number' ? payload.observedPopupCount : undefined,
            sampledCandidates: Array.isArray(payload.pendingTabIds) ? payload.pendingTabIds : undefined,
          }),
    },
    error: matched
      ? undefined
      : {
          code: 'popup_wait_timeout',
          message: 'Timed out waiting for a matching popup tab.',
        },
  };
}

type AutomationNetworkWaitSpec =
  | z.infer<typeof AutomationWaitRequestSchema>
  | z.infer<typeof AutomationWaitResponseSchema>;

function normalizeNetworkWaitFilters(wait: AutomationNetworkWaitSpec): Record<string, unknown> {
  const responseWait = wait.waitKind === 'response' ? wait as z.infer<typeof AutomationWaitResponseSchema> : undefined;
  return {
    urlContains: normalizeOptionalString(wait.urlContains),
    urlRegex: normalizeOptionalString(wait.urlRegex),
    exactUrl: normalizeOptionalString(wait.exactUrl),
    method: normalizeHttpMethod(wait.method),
    traceId: normalizeOptionalString(wait.traceId),
    initiator: normalizeOptionalString(wait.initiator),
    requestContentType: normalizeOptionalString(wait.requestContentType),
    responseContentType: normalizeOptionalString(responseWait?.responseContentType),
    statusIn: responseWait ? normalizeStatusIn(responseWait.statusIn) : [],
    statusGte: responseWait?.statusGte,
    statusLt: responseWait?.statusLt,
    errorType: normalizeOptionalString(responseWait?.errorType),
    sinceTs: resolveAutomationWaitSinceTs(wait.sinceTs),
    tabId: resolveOptionalTabId(wait.tabId),
    includeBodies: wait.includeBodies === true,
  };
}

function queryNetworkWaitCandidates(
  db: Database,
  sessionId: string,
  filters: Record<string, unknown>,
): NetworkCallRow[] {
  const where: string[] = ['session_id = ?', 'ts_start >= ?'];
  const params: unknown[] = [sessionId, filters.sinceTs];
  if (filters.exactUrl) {
    where.push('url = ?');
    params.push(filters.exactUrl);
  } else if (filters.urlContains) {
    where.push('url LIKE ?');
    params.push(`%${filters.urlContains}%`);
  }
  if (filters.method) {
    where.push('method = ?');
    params.push(filters.method);
  }
  if (filters.traceId) {
    where.push('trace_id = ?');
    params.push(filters.traceId);
  }
  if (filters.initiator) {
    where.push('initiator = ?');
    params.push(filters.initiator);
  }
  if (filters.requestContentType) {
    where.push('request_content_type LIKE ?');
    params.push(`%${filters.requestContentType}%`);
  }
  if (filters.responseContentType) {
    where.push('response_content_type LIKE ?');
    params.push(`%${filters.responseContentType}%`);
  }
  const statusIn = Array.isArray(filters.statusIn) ? filters.statusIn : [];
  if (statusIn.length > 0) {
    where.push(`status IN (${statusIn.map(() => '?').join(', ')})`);
    params.push(...statusIn);
  }
  if (typeof filters.statusGte === 'number') {
    where.push('status >= ?');
    params.push(filters.statusGte);
  }
  if (typeof filters.statusLt === 'number') {
    where.push('status < ?');
    params.push(filters.statusLt);
  }
  if (filters.tabId !== undefined) {
    where.push('tab_id = ?');
    params.push(filters.tabId);
  }

  return db.prepare(
    `SELECT ${NETWORK_CALL_SELECT_COLUMNS}
     FROM network
     WHERE ${where.join(' AND ')}
     ORDER BY ts_start ASC
     LIMIT 200`
  ).all(...params) as NetworkCallRow[];
}

function networkCallMatchesFilters(row: NetworkCallRow, filters: Record<string, unknown>): boolean {
  if (!matchesUrlPredicates(row.url, {
    exactUrl: typeof filters.exactUrl === 'string' ? filters.exactUrl : undefined,
    urlContains: typeof filters.urlContains === 'string' ? filters.urlContains : undefined,
    urlRegex: typeof filters.urlRegex === 'string' ? filters.urlRegex : undefined,
  })) {
    return false;
  }

  if (typeof filters.errorType === 'string' && classifyNetworkFailure(row.status, row.error_class) !== filters.errorType) {
    return false;
  }

  return true;
}

async function waitForNetworkMatchCondition(
  sessionId: string,
  wait: AutomationNetworkWaitSpec,
  db: Database,
): Promise<AutomationWaitResult> {
  const timeoutMs = resolveTimeoutMs(wait.timeoutMs, DEFAULT_NETWORK_POLL_TIMEOUT_MS, MAX_NETWORK_POLL_TIMEOUT_MS);
  const pollIntervalMs = resolveDurationMs(wait.pollIntervalMs, DEFAULT_NETWORK_POLL_INTERVAL_MS, 5_000);
  const filters = normalizeNetworkWaitFilters(wait);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;
  let lastCalls: NetworkCallRow[] = [];

  while (Date.now() <= deadline) {
    attempts += 1;
    lastCalls = queryNetworkWaitCandidates(db, sessionId, filters);
    const matched = lastCalls.find((row) => networkCallMatchesFilters(row, filters));
    if (matched) {
      return {
        waitKind: wait.waitKind,
        matched: true,
        waitedMs: Date.now() - startedAt,
        attempts,
        timeoutMs,
        pollIntervalMs,
        evidence: {
          filters,
          call: mapNetworkCallRecord(matched, filters.includeBodies === true),
        },
      };
    }

    await sleep(pollIntervalMs);
  }

  return {
    waitKind: wait.waitKind,
    matched: false,
    waitedMs: Date.now() - startedAt,
    attempts,
    timeoutMs,
    pollIntervalMs,
    evidence: {
      filters,
      sampledCalls: lastCalls.slice(0, 5).map((row) => mapNetworkCallRecord(row, false)),
      timeoutDiagnostics: buildWaitTimeoutDiagnostics({
        waitKind: wait.waitKind,
        timeoutMs,
        waitedMs: Date.now() - startedAt,
        attempts,
        pollIntervalMs,
        matcherSummary: filters,
        lastObserved: lastCalls.length > 0 ? mapNetworkCallRecord(lastCalls[lastCalls.length - 1] as NetworkCallRow, false) : undefined,
        candidateCount: lastCalls.length,
        sampledCandidates: lastCalls.slice(0, 5).map((row) => mapNetworkCallRecord(row, false)),
      }),
    },
    error: {
      code: wait.waitKind === 'request' ? 'request_wait_timeout' : 'response_wait_timeout',
      message: `Timed out waiting for a matching ${wait.waitKind}.`,
    },
  };
}

function queryRecentNetworkActivity(
  db: Database,
  options: {
    sessionId: string;
    sinceTs: number;
    urlContains?: string;
    method?: string;
    tabId?: number;
  },
): NetworkCallRow[] {
  const where: string[] = ['session_id = ?', 'ts_start >= ?'];
  const params: unknown[] = [options.sessionId, options.sinceTs];
  if (options.urlContains) {
    where.push('url LIKE ?');
    params.push(`%${options.urlContains}%`);
  }
  if (options.method) {
    where.push('method = ?');
    params.push(options.method);
  }
  if (options.tabId !== undefined) {
    where.push('tab_id = ?');
    params.push(options.tabId);
  }

  return db.prepare(
    `SELECT ${NETWORK_CALL_SELECT_COLUMNS}
     FROM network
     WHERE ${where.join(' AND ')}
     ORDER BY ts_start DESC
     LIMIT 10`
  ).all(...params) as NetworkCallRow[];
}

async function waitForNetworkQuietCondition(
  sessionId: string,
  wait: z.infer<typeof AutomationWaitNetworkQuietSchema>,
  db: Database,
): Promise<AutomationWaitResult> {
  const timeoutMs = resolveTimeoutMs(wait.timeoutMs, DEFAULT_NETWORK_POLL_TIMEOUT_MS, MAX_NETWORK_POLL_TIMEOUT_MS);
  const pollIntervalMs = resolveDurationMs(wait.pollIntervalMs, DEFAULT_NETWORK_POLL_INTERVAL_MS, 5_000);
  const quietMs = resolveDurationMs(wait.quietMs, 500, 10_000);
  const urlContains = normalizeOptionalString(wait.urlContains);
  const method = normalizeHttpMethod(wait.method);
  const tabId = resolveOptionalTabId(wait.tabId);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;
  let lastActivityAt = startedAt;
  let lastCalls: NetworkCallRow[] = [];

  while (Date.now() <= deadline) {
    attempts += 1;
    const rows = queryRecentNetworkActivity(db, {
      sessionId,
      sinceTs: lastActivityAt + 1,
      urlContains,
      method,
      tabId,
    });
    if (rows.length > 0) {
      lastCalls = rows;
      lastActivityAt = Math.max(...rows.map((row) => row.ts_start), Date.now());
    }

    if (Date.now() - lastActivityAt >= quietMs) {
      return {
        waitKind: 'network_quiet',
        matched: true,
        waitedMs: Date.now() - startedAt,
        attempts,
        timeoutMs,
        pollIntervalMs,
        evidence: {
          quietMs,
          filters: { urlContains, method, tabId },
          lastActivityAt,
          sampledCalls: lastCalls.slice(0, 5).map((row) => mapNetworkCallRecord(row, false)),
        },
      };
    }

    await sleep(pollIntervalMs);
  }

  return {
    waitKind: 'network_quiet',
    matched: false,
    waitedMs: Date.now() - startedAt,
    attempts,
    timeoutMs,
    pollIntervalMs,
    evidence: {
      quietMs,
      filters: { urlContains, method, tabId },
      lastActivityAt,
      sampledCalls: lastCalls.slice(0, 5).map((row) => mapNetworkCallRecord(row, false)),
      timeoutDiagnostics: buildWaitTimeoutDiagnostics({
        waitKind: 'network_quiet',
        timeoutMs,
        waitedMs: Date.now() - startedAt,
        attempts,
        pollIntervalMs,
        matcherSummary: { quietMs, urlContains, method, tabId },
        lastObserved: lastCalls.length > 0 ? mapNetworkCallRecord(lastCalls[0] as NetworkCallRow, false) : undefined,
        candidateCount: lastCalls.length,
        sampledCandidates: lastCalls.slice(0, 5).map((row) => mapNetworkCallRecord(row, false)),
      }),
    },
    error: {
      code: 'network_quiet_timeout',
      message: `Timed out waiting for ${quietMs}ms of quiet network activity.`,
    },
  };
}

async function runAutomationWait(options: {
  sessionId: string;
  wait: AutomationWaitSpec;
  capturePageState: (
    sessionId: string,
    input: ToolInput,
  ) => Promise<PageStateCaptureResult>;
  captureClient: CaptureCommandClient;
  getDb?: () => Database;
}): Promise<AutomationWaitResult> {
  switch (options.wait.waitKind) {
    case 'url':
      return waitForUrlCondition(options.sessionId, options.wait, options.capturePageState);
    case 'navigation': {
      const db = options.getDb?.();
      if (!db) {
        throw new Error('navigation waits require database access');
      }
      return waitForNavigationCondition(options.sessionId, options.wait, db);
    }
    case 'navigation_lifecycle':
      return waitForNavigationLifecycleCondition(options.sessionId, options.wait, options.captureClient);
    case 'load_state':
      return waitForLoadStateCondition(options.sessionId, options.wait, options.capturePageState);
    case 'selector_state':
      return waitForSelectorStateCondition(options.sessionId, options.wait, options.captureClient);
    case 'console':
      return waitForConsoleCondition(options.sessionId, options.wait, options.captureClient);
    case 'dialog':
      return waitForDialogCondition(options.sessionId, options.wait, options.captureClient);
    case 'stable_layout':
      return waitForStableLayoutCondition(options.sessionId, options.wait, options.captureClient);
    case 'download':
      return waitForDownloadCondition(options.sessionId, options.wait, options.captureClient);
    case 'popup':
      return waitForPopupCondition(options.sessionId, options.wait, options.captureClient);
    case 'network_quiet': {
      const db = options.getDb?.();
      if (!db) {
        throw new Error('network_quiet waits require database access');
      }
      return waitForNetworkQuietCondition(options.sessionId, options.wait, db);
    }
    case 'request':
    case 'response': {
      const db = options.getDb?.();
      if (!db) {
        throw new Error(`${options.wait.waitKind} waits require database access`);
      }
      return waitForNetworkMatchCondition(options.sessionId, options.wait, db);
    }
  }
}

function getSessionRow(db: Database, sessionId: string): SessionRow | undefined {
  return db.prepare(`
    SELECT
      session_id,
      created_at,
      last_seen_at,
      paused_at,
      ended_at,
      tab_id,
      window_id,
      url_start,
      url_last,
      user_agent,
      viewport_w,
      viewport_h,
      dpr,
      safe_mode,
      pinned
    FROM sessions
    WHERE session_id = ?
    LIMIT 1
  `).get(sessionId) as SessionRow | undefined;
}

function looksSensitiveText(value: unknown): boolean {
  return typeof value === 'string'
    && /(password|passwd|pwd|token|secret|auth|session|email|card|cvv|cvc|ssn|iban|payment|billing)/i.test(value);
}

function isSensitivePageInput(input: Record<string, unknown>): boolean {
  const type = typeof input.type === 'string' ? input.type.toLowerCase() : '';
  return type === 'password'
    || looksSensitiveText(input.selector)
    || looksSensitiveText(input.label)
    || looksSensitiveText(input.name)
    || looksSensitiveText(input.placeholder)
    || looksSensitiveText(input.testId);
}

function collectAutomationPageRisks(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!payload) {
    return {
      sensitiveInputs: [],
      frameCount: 0,
      crossOriginFrameCount: 0,
    };
  }

  const inputs = asRecordArray(payload.inputs);
  const frames = asRecordArray(payload.frames);
  const sensitiveInputs = inputs
    .filter(isSensitivePageInput)
    .slice(0, 8)
    .map((input) => ({
      selector: input.selector,
      type: input.type,
      label: input.label,
      name: input.name,
      placeholder: input.placeholder,
      frameId: input.frameId,
      frameUrl: input.frameUrl,
    }));
  const crossOriginFrames = frames
    .filter((frame) => frame.sameOrigin === false || frame.accessible === false || frame.crossOrigin === true)
    .slice(0, 8)
    .map((frame) => ({
      frameId: frame.frameId,
      url: frame.url ?? frame.frameUrl,
      title: frame.title ?? frame.frameTitle,
      sameOrigin: frame.sameOrigin,
      accessible: frame.accessible,
    }));

  return {
    sensitiveInputs,
    sensitiveInputCount: sensitiveInputs.length,
    frameCount: frames.length,
    crossOriginFrameCount: crossOriginFrames.length,
    crossOriginFrames,
  };
}

async function buildAutomationFlowPreflight(options: {
  sessionId: string;
  input: ToolInput;
  capturePageState: (
    sessionId: string,
    input: ToolInput,
  ) => Promise<PageStateCaptureResult>;
  getDb?: () => Database;
  getSessionConnectionState?: (sessionId: string) => SessionConnectionLookupResult | undefined;
}): Promise<Record<string, unknown>> {
  const blockers: Array<Record<string, unknown>> = [];
  const warnings: Array<Record<string, unknown>> = [];
  const includePageState = options.input.includePageState !== false;
  const expectedUrlContains = normalizeOptionalString(options.input.expectedUrlContains);
  const requireSensitiveAutomation = options.input.requireSensitiveAutomation === true;
  const plannedActions = Array.isArray(options.input.plannedActions)
    ? options.input.plannedActions.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  const db = options.getDb?.();
  const session = db ? getSessionRow(db, options.sessionId) : undefined;
  const sessionState = options.getSessionConnectionState?.(options.sessionId);
  const hasLiveConnectionLookup = typeof options.getSessionConnectionState === 'function';
  const scope = classifySessionUrl(session?.url_last ?? undefined);
  const liveConnection = session
    ? buildLiveConnectionRecord(session, scope, sessionState)
    : {
        connected: sessionState?.connected === true,
        status: sessionState?.connected === true ? 'connected' : 'unknown',
        recommendedForLiveCapture: false,
      };

  if (!db) {
    warnings.push({
      code: 'DB_UNAVAILABLE',
      severity: 'warning',
      source: 'server',
      message: 'Database access was not available; session history checks were skipped.',
    });
  }

  if (!session) {
    blockers.push({
      code: 'SESSION_NOT_FOUND',
      severity: 'error',
      source: 'session',
      message: `Session not found: ${options.sessionId}`,
    });
  } else {
    const status = getSessionStatus(session);
    if (status === 'paused') {
      blockers.push({
        code: 'SESSION_PAUSED',
        severity: 'error',
        source: 'session',
        message: 'Resume the session before running an automation flow.',
      });
    }
    if (status === 'ended') {
      blockers.push({
        code: 'SESSION_ENDED',
        severity: 'error',
        source: 'session',
        message: 'Start a new session before running an automation flow.',
      });
    }
    if (scope.kind === 'likely_iframe_noise') {
      blockers.push({
        code: 'SESSION_SCOPE_NOISE',
        severity: 'error',
        source: 'session',
        message: 'The selected session appears to be bound to iframe/ad traffic rather than the app surface.',
      });
    }
    if (scope.kind === 'top_level_page' && scope.isLocalhost !== true) {
      warnings.push({
        code: 'PRODUCTION_OR_REMOTE_ORIGIN',
        severity: 'warning',
        source: 'session',
        message: 'The current session URL is remote/production-like. Keep the flow scoped and avoid destructive actions.',
        origin: scope.origin,
      });
    }
    if (expectedUrlContains && !String(session.url_last ?? '').includes(expectedUrlContains)) {
      blockers.push({
        code: 'EXPECTED_URL_MISMATCH',
        severity: 'error',
        source: 'session',
        message: `Current session URL does not include "${expectedUrlContains}".`,
        currentUrl: session.url_last,
      });
    }
  }

  if (hasLiveConnectionLookup && (!sessionState || sessionState.connected !== true)) {
    blockers.push({
      code: LIVE_SESSION_DISCONNECTED_CODE,
      severity: 'error',
      source: 'connection',
      message: 'The session is not currently connected to a live extension target.',
      disconnectedAt: sessionState?.disconnectedAt,
      disconnectReason: sessionState?.disconnectReason,
    });
  }

  let pageCapture: PageStateCaptureResult | undefined;
  if (includePageState && blockers.length === 0) {
    try {
      pageCapture = await options.capturePageState(options.sessionId, {
        includeButtons: true,
        includeLinks: true,
        includeInputs: true,
        includeModals: true,
        maxItems: resolveLimit(options.input.maxItems, 40),
        maxTextLength: resolveDurationMs(options.input.maxTextLength, 80, 200),
      });
    } catch (error) {
      blockers.push({
        code: isLiveSessionDisconnectedError(error) ? LIVE_SESSION_DISCONNECTED_CODE : 'PAGE_STATE_CAPTURE_FAILED',
        severity: 'error',
        source: 'page-state',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const pageRisks = collectAutomationPageRisks(pageCapture?.payload);
  const sensitiveInputs = Array.isArray(pageRisks.sensitiveInputs) ? pageRisks.sensitiveInputs : [];
  const hasInputLikeAction = plannedActions.some((action) => ['input', 'type', 'clear', 'select_option', 'press_key'].includes(action));
  if (sensitiveInputs.length > 0 && (requireSensitiveAutomation || hasInputLikeAction)) {
    warnings.push({
      code: 'SENSITIVE_FIELD_AUTOMATION_RISK',
      severity: 'warning',
      source: 'page-state',
      message: 'Sensitive-looking fields are present. The extension sensitive-field opt-in may be required before input-like actions.',
      count: sensitiveInputs.length,
      sampledInputs: sensitiveInputs,
    });
  }
  if (typeof pageRisks.crossOriginFrameCount === 'number' && pageRisks.crossOriginFrameCount > 0) {
    warnings.push({
      code: 'CROSS_ORIGIN_FRAME_PRESENT',
      severity: 'warning',
      source: 'page-state',
      message: 'Cross-origin or inaccessible frames are present. Automation inside those frames may be diagnostic-only.',
      count: pageRisks.crossOriginFrameCount,
      frames: pageRisks.crossOriginFrames,
    });
  }

  const ready = blockers.length === 0;
  return {
    ready,
    blockers,
    warnings,
    checks: {
      sessionFound: Boolean(session),
      liveConnected: sessionState?.connected === true || (hasLiveConnectionLookup ? false : undefined),
      recommendedForLiveCapture: liveConnection.recommendedForLiveCapture,
      expectedUrlMatched: expectedUrlContains ? blockers.every((blocker) => blocker.code !== 'EXPECTED_URL_MISMATCH') : undefined,
      pageStateCaptured: pageCapture !== undefined,
      remoteOrProductionLike: scope.kind === 'top_level_page' && scope.isLocalhost !== true,
      sensitiveInputCount: sensitiveInputs.length,
      crossOriginFrameCount: pageRisks.crossOriginFrameCount,
    },
    session: session
      ? {
          sessionId: session.session_id,
          status: getSessionStatus(session),
          tabId: session.tab_id ?? undefined,
          windowId: session.window_id ?? undefined,
          urlStart: session.url_start ?? undefined,
          urlLast: session.url_last ?? undefined,
          lastSeenAt: resolveSessionLastSeenAt(session, sessionState),
          safeMode: session.safe_mode === 1,
        }
      : undefined,
    scope,
    liveConnection,
    page: pageCapture
      ? {
          url: pageCapture.payload.url,
          title: pageCapture.payload.title,
          language: pageCapture.payload.language,
          viewport: pageCapture.payload.viewport,
          summary: pageCapture.payload.summary,
        }
      : undefined,
    detectedRisks: pageRisks,
    nextActions: ready
      ? [{ code: 'RUN_FLOW', message: 'Run the automation flow with bounded waits and failure capture enabled.' }]
      : blockers.map((blocker) => ({
          code: String(blocker.code ?? 'FIX_BLOCKER'),
          message: String(blocker.message ?? 'Resolve this preflight blocker before running the flow.'),
        })),
  };
}

function createWorkflowStepId(step: UIWorkflowStep, index: number): string {
  return step.id ?? `step_${index + 1}`;
}

async function captureWorkflowPageState(
  sessionId: string,
  capturePageState: (
    sessionId: string,
    input: ToolInput,
  ) => Promise<PageStateCaptureResult>,
  mode: 'safe' | 'fast',
): Promise<PageStateCaptureResult> {
  const maxItems = mode === 'fast' ? 12 : 20;
  const maxTextLength = mode === 'fast' ? 60 : 80;
  return capturePageState(sessionId, {
    includeButtons: true,
    includeLinks: true,
    includeInputs: true,
    includeModals: true,
    maxItems,
    maxTextLength,
  });
}

function normalizeWorkflowError(error: unknown): { code: string; message: string } {
  if (error instanceof WorkflowTargetResolutionError) {
    return {
      code: error.code,
      message: `${error.message} ${JSON.stringify(error.details)}`,
    };
  }

  if (error instanceof z.ZodError) {
    return {
      code: 'invalid_workflow_step',
      message: error.issues.map((issue) => issue.message).join('; '),
    };
  }

  if (error instanceof Error) {
    return {
      code: 'workflow_step_failed',
      message: error.message,
    };
  }

  return {
    code: 'workflow_step_failed',
    message: 'Unknown workflow step failure',
  };
}

function resolveWorkflowRecommendedAction(error: { code: string; message: string } | undefined): string | undefined {
  if (!error) {
    return undefined;
  }

  if (
    error.code === LIVE_SESSION_DISCONNECTED_CODE
    || error.message.includes(LIVE_SESSION_DISCONNECTED_CODE)
    || error.message.toLowerCase().includes('transport closed')
  ) {
    return 'reconnect_session';
  }
  if (error.code === 'target_not_found') {
    return 'inspect_page_state';
  }
  if (error.code === 'click_intercepted') {
    return 'retry_step';
  }
  if (error.code === 'workflow_target_ambiguous') {
    return 'refine_target';
  }
  if (error.code === 'workflow_target_not_found') {
    return 'inspect_page_state';
  }
  if (error.code === 'page_state_not_matched' || error.code === 'page_state_assertion_failed') {
    return 'inspect_page_state';
  }
  if (error.code === 'url_wait_timeout' || error.code === 'navigation_wait_timeout') {
    return 'inspect_navigation_state';
  }
  if (error.code === 'selector_state_wait_timeout') {
    return 'inspect_selector_state';
  }
  if (error.code === 'console_wait_timeout') {
    return 'inspect_live_console_logs';
  }
  if (
    error.code === 'network_quiet_timeout'
    || error.code === 'request_wait_timeout'
    || error.code === 'response_wait_timeout'
  ) {
    return 'inspect_network_calls';
  }

  return undefined;
}

function resolveWorkflowFailureSelector(
  step: UIWorkflowStep,
  stepResultTarget: Record<string, unknown> | undefined,
): string | undefined {
  if (step.kind === 'action') {
    if (typeof step.target?.selector === 'string' && step.target.selector.trim().length > 0) {
      return step.target.selector.trim();
    }
    const actionTarget = isRecord(stepResultTarget?.actionTarget) ? stepResultTarget?.actionTarget : undefined;
    if (typeof actionTarget?.selector === 'string' && actionTarget.selector.trim().length > 0) {
      return actionTarget.selector.trim();
    }
    const resolution = isRecord(stepResultTarget?.resolution) ? stepResultTarget?.resolution : undefined;
    const matched = isRecord(resolution?.matched) ? resolution.matched : undefined;
    if (typeof matched?.selector === 'string' && matched.selector.trim().length > 0) {
      return matched.selector.trim();
    }
  }

  return undefined;
}

function asStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    .slice(0, maxItems);
}

const LIVE_CONSOLE_LEVELS = new Set(['log', 'info', 'warn', 'error', 'debug', 'trace']);

function resolveLiveConsoleLevels(value: unknown): string[] {
  const levels = asStringArray(value, 16)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => LIVE_CONSOLE_LEVELS.has(entry));

  return Array.from(new Set(levels));
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null);
}

function mapLiveConsoleLogRecord(
  log: Record<string, unknown>,
  profile: ResponseProfile,
  options: { includeArgs?: boolean } = {},
): Record<string, unknown> {
  if (profile === 'compact') {
    const compact: Record<string, unknown> = {
      timestamp:
        typeof log.timestamp === 'number'
          ? log.timestamp
          : typeof log.ts === 'number'
            ? log.ts
            : undefined,
      level: typeof log.level === 'string' ? log.level : undefined,
      message: typeof log.message === 'string' ? log.message : '',
    };

    if (typeof log.count === 'number') {
      compact.count = log.count;
    }
    if (typeof log.firstTimestamp === 'number') {
      compact.firstTimestamp = log.firstTimestamp;
    }
    if (typeof log.lastTimestamp === 'number') {
      compact.lastTimestamp = log.lastTimestamp;
    }

    if (options.includeArgs === true && Array.isArray(log.args)) {
      compact.args = log.args;
    }

    return compact;
  }

  return log;
}

function resolveOptionalTabId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('tabId must be an integer');
  }

  const tabId = Math.floor(value);
  if (!Number.isInteger(tabId) || tabId < 0) {
    throw new Error('tabId must be an integer');
  }

  return tabId;
}

function isLiveSessionDisconnectedMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('no active extension connection')
    || normalized.includes('receiving end does not exist')
    || normalized.includes('could not establish connection')
    || normalized.includes('connection closed before capture completed')
    || normalized.includes('websocket manager closed')
    || normalized.includes('extension target is unavailable')
    || normalized.includes('target tab for this session is unavailable');
}

function normalizeCaptureError(sessionId: string, error: unknown): Error {
  const fallback = error instanceof Error ? error : new Error(String(error));
  const message = fallback.message ?? '';

  if (isLiveSessionDisconnectedMessage(message)) {
    return new LiveSessionDisconnectedError(sessionId, message);
  }

  return fallback;
}

function isCaptureTimeoutMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('timed out') || normalized.includes('timeout');
}

function isRecoverableOverrideLiveCommandError(error: unknown): boolean {
  if (isLiveSessionDisconnectedError(error)) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return isCaptureTimeoutMessage(message);
}

function extractTimeoutMsFromMessage(message: string, fallback: number): number {
  const match = message.match(/(?:after|waiting)\s+(\d+)ms/i);
  if (!match) {
    return fallback;
  }

  const parsed = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildOverrideLiveCommandFailure(options: {
  sessionId: string;
  command: CaptureCommandName;
  timeoutMs: number;
  error: unknown;
  getSessionConnectionState?: (sessionId: string) => SessionConnectionLookupResult | undefined;
}): Record<string, unknown> {
  const originalMessage = options.error instanceof Error ? options.error.message : String(options.error);
  const timeout = extractTimeoutMsFromMessage(originalMessage, options.timeoutMs);
  const timedOut = isCaptureTimeoutMessage(originalMessage);
  const disconnected = isLiveSessionDisconnectedError(options.error);
  const sessionState = options.getSessionConnectionState?.(options.sessionId);
  const code = disconnected
    ? LIVE_SESSION_DISCONNECTED_CODE
    : timedOut
      ? OVERRIDE_LIVE_COMMAND_TIMEOUT_CODE
      : OVERRIDE_LIVE_COMMAND_FAILED_CODE;
  const message = timedOut
    ? `${options.command} for session ${options.sessionId} timed out after ${timeout}ms before the live extension returned an override command result.`
    : disconnected
      ? `${options.command} for session ${options.sessionId} could not reach a connected live extension target.`
      : `${options.command} for session ${options.sessionId} failed before returning an override command result.`;

  return {
    ok: false,
    available: false,
    code,
    command: options.command,
    timeoutMs: timeout,
    timedOut,
    disconnected,
    message,
    originalMessage,
    sessionConnected: sessionState?.connected,
    disconnectedAt: sessionState?.disconnectedAt,
    disconnectReason: sessionState?.disconnectReason,
  };
}

function createOverrideLiveCommandError(options: {
  sessionId: string;
  command: CaptureCommandName;
  timeoutMs: number;
  error: unknown;
  getSessionConnectionState?: (sessionId: string) => SessionConnectionLookupResult | undefined;
}): Error {
  const failure = buildOverrideLiveCommandFailure(options);
  const code = String(failure.code ?? OVERRIDE_LIVE_COMMAND_FAILED_CODE);
  const message = `${code}: ${options.command} for session ${options.sessionId} ${failure.timedOut === true
    ? `timed out after ${String(failure.timeoutMs)}ms`
    : `failed`}. ${String(failure.message ?? '')} Original error: ${String(failure.originalMessage ?? 'unknown')}`;
  const error = new Error(message);
  Object.assign(error, { code, details: failure });
  return error;
}

function isLiveSessionDisconnectedError(error: unknown): error is LiveSessionDisconnectedError {
  return error instanceof LiveSessionDisconnectedError;
}

async function executeLiveCapture(
  captureClient: CaptureCommandClient,
  sessionId: string,
  command: CaptureCommandName,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<CaptureClientResult> {
  try {
    return await captureClient.execute(sessionId, command, payload, timeoutMs);
  } catch (error) {
    throw normalizeCaptureError(sessionId, error);
  }
}

async function executeOverrideLiveCaptureWithDiagnostics(options: {
  captureClient: CaptureCommandClient;
  sessionId: string;
  command: CaptureCommandName;
  payload: Record<string, unknown>;
  timeoutMs: number;
  getSessionConnectionState?: (sessionId: string) => SessionConnectionLookupResult | undefined;
}): Promise<{ capture: CaptureClientResult; payload: Record<string, unknown> }> {
  try {
    const capture = await executeLiveCapture(
      options.captureClient,
      options.sessionId,
      options.command,
      options.payload,
      options.timeoutMs,
    );
    return { capture, payload: ensureCaptureSuccess(capture, options.sessionId) };
  } catch (error) {
    throw createOverrideLiveCommandError({
      sessionId: options.sessionId,
      command: options.command,
      timeoutMs: options.timeoutMs,
      error,
      getSessionConnectionState: options.getSessionConnectionState,
    });
  }
}

function ensureCaptureSuccess(result: CaptureClientResult, sessionId: string): Record<string, unknown> {
  if (!result.ok) {
    throw normalizeCaptureError(sessionId, new Error(result.error ?? 'Capture command failed'));
  }

  return result.payload ?? {};
}

async function refreshObservedAssetsForOverrideEnable(options: {
  captureClient: CaptureCommandClient;
  db: Database;
  sessionId: string;
  tabId?: number;
  getSessionConnectionState?: (sessionId: string) => SessionConnectionLookupResult | undefined;
}): Promise<Record<string, unknown>> {
  const { payload } = await executeOverrideLiveCaptureWithDiagnostics({
    captureClient: options.captureClient,
    sessionId: options.sessionId,
    command: 'CAPTURE_OVERRIDE_OBSERVE_ASSETS',
    payload: { tabId: options.tabId, includePerformance: true },
    timeoutMs: 5_000,
    getSessionConnectionState: options.getSessionConnectionState,
  });
  persistObservedOverrideAssets(options.db, {
    ...payload,
    sessionId: options.sessionId,
    tabId: payload.tabId ?? options.tabId,
  });

  return {
    tabId: typeof payload.tabId === 'number' ? payload.tabId : options.tabId,
    pageUrl: typeof payload.pageUrl === 'string' ? payload.pageUrl : undefined,
    assetCount: Array.isArray(payload.assets) ? payload.assets.length : 0,
  };
}

function buildPersistedOverrideStatus(options: {
  db: Database;
  sessionId: string;
  profileId?: unknown;
  getSessionConnectionState?: (sessionId: string) => SessionConnectionLookupResult | undefined;
}): Record<string, unknown> {
  let profile: Record<string, unknown> | null = null;
  let profileError: string | undefined;
  try {
    profile = resolveOverrideProfileRecord(options.profileId);
  } catch (error) {
    profileError = error instanceof Error ? error.message : String(error);
  }
  const latestRun = listOverridePocRuns(options.db, options.sessionId, 1, 0).runs[0] ?? null;
  const recentRequests = listOverridePocRequests(options.db, options.sessionId, 5, 0, latestRun?.runId).requests;
  const recentPlans = listOverridePlanAudits(options.db, { sessionId: options.sessionId, limit: 5, offset: 0 }).plans;
  let preflight: Record<string, unknown>;
  if (profileError) {
    preflight = {
      ready: false,
      profileId: null,
      profile: null,
      issues: [{
        code: 'OVERRIDE_CONFIG_UNAVAILABLE',
        severity: 'error',
        source: 'profile',
        message: profileError,
      }],
      checks: {
        sessionFound: auditSessionExists(options.db, options.sessionId),
        connected: options.getSessionConnectionState?.(options.sessionId)?.connected === true,
      },
      nextActions: [{
        code: 'FIX_OVERRIDE_CONFIG_PATH',
        message: 'Create a readable override-poc config or point OVERRIDE_POC_CONFIG_PATH at the intended config, then retry override status.',
      }],
    };
  } else {
    preflight = buildOverridePreflight({
      db: options.db,
      sessionId: options.sessionId,
      profileId: options.profileId,
      getSessionConnectionState: options.getSessionConnectionState,
    });
  }

  return {
    profile,
    profileError,
    latestRun,
    recentRequests,
    recentPlans,
    preflight,
    diagnosis: diagnoseOverridePoc(options.db, options.sessionId, latestRun?.runId),
  };
}

function auditSessionExists(db: Database, sessionId: string): boolean {
  const row = db.prepare('SELECT 1 FROM sessions WHERE session_id = ? LIMIT 1').get(sessionId);
  return row !== undefined;
}

function hashLocalFileIfPresent(filePath: string | undefined): { sha256: string | null; bytes: number | null } {
  if (!filePath || !existsSync(filePath)) {
    return { sha256: null, bytes: null };
  }
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    return { sha256: null, bytes: null };
  }
  return {
    sha256: createHash('sha256').update(readFileSync(filePath)).digest('hex'),
    bytes: stat.size,
  };
}

function resolveAuditProfileId(input: ToolInput): string | null {
  return normalizeOptionalString(input.profileId) ?? null;
}

function buildOverrideRollbackMetadata(options: {
  sessionId: string;
  profileId: string | null;
  configPath?: string | null;
  generatedFiles: string[];
  generatedDirectories?: string[];
  note?: string;
}): Record<string, unknown> {
  return {
    disableTool: 'disable_overrides',
    validateTool: 'validate_override_profile',
    sessionId: options.sessionId,
    profileId: options.profileId,
    configPath: options.configPath ?? null,
    generatedFiles: Array.from(new Set(options.generatedFiles.filter((entry) => entry.trim().length > 0))),
    generatedDirectories: Array.from(new Set((options.generatedDirectories ?? []).filter((entry) => entry.trim().length > 0))),
    notes: [
      'Disable overrides for this session before deleting generated files or config entries.',
      'Re-run validate_override_profile after editing or removing generated config rules.',
      options.note,
    ].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0),
  };
}

function persistResponsePlanAudit(options: {
  db: Database;
  sessionId?: string;
  input: ToolInput;
  plan: OverrideResponsePatchPlanResult;
  capturedFromLiveSession?: unknown;
  variantContext?: unknown;
}): OverridePlanAuditRecord | undefined {
  if (!options.sessionId || !options.plan.rule || !auditSessionExists(options.db, options.sessionId)) {
    return undefined;
  }

  const profileId = resolveAuditProfileId(options.input);
  const record: OverridePlanAuditRecord = {
    planId: randomUUID(),
    sessionId: options.sessionId,
    createdAt: Date.now(),
    plannerKind: 'response-patch',
    toolName: 'plan_override_response_patch',
    profileId,
    ruleId: options.plan.rule.ruleId,
    ruleType: options.plan.rule.ruleType,
    requestMethod: options.plan.requestMethod,
    matchMode: options.plan.matchMode,
    targetAssetUrl: options.plan.targetUrl,
    localFilePath: options.plan.localFilePath ?? options.plan.rule.localFilePath,
    configPath: options.plan.configPath ?? null,
    contentType: options.plan.contentType,
    originalSha256: options.plan.originalSha256,
    patchedSha256: options.plan.patchedSha256,
    originalBytes: options.plan.originalBytes,
    patchedBytes: options.plan.patchedBytes,
    patchSummary: {
      textPatches: options.plan.patches,
      jsonPatches: options.plan.jsonPatches,
      documentPatches: options.plan.documentPatches,
      ruleType: options.plan.ruleType,
      configWritten: options.plan.configWritten,
      rscFlight: options.plan.rule.rscFlight ?? null,
      variantContext: options.variantContext ?? null,
    },
    preview: options.plan.preview ?? null,
    warnings: options.plan.warnings,
    blockers: options.plan.blockers,
    capturedFromLiveSession: options.capturedFromLiveSession ?? null,
    rollback: buildOverrideRollbackMetadata({
      sessionId: options.sessionId,
      profileId,
      configPath: options.plan.configPath ?? null,
      generatedFiles: options.plan.localFilePath ? [options.plan.localFilePath] : [],
      note: 'Generated response override bodies are disposable once the override has been disabled.',
    }),
  };

  return insertOverridePlanAudit(options.db, record);
}

function persistNextSourcePlanAudits(options: {
  db: Database;
  sessionId?: string;
  input: ToolInput;
  plan: NextSourceOverridePlanResult;
}): OverridePlanAuditRecord[] {
  if (!options.sessionId || !auditSessionExists(options.db, options.sessionId)) {
    return [];
  }

  const sessionId = options.sessionId;
  const profileId = resolveAuditProfileId(options.input);
  const generatedFiles = options.plan.rules.map((rule) => rule.localFilePath);
  return options.plan.rules.map((rule: PlannedNextOverrideRule) => {
    const localFile = hashLocalFileIfPresent(rule.localFilePath);
    const record: OverridePlanAuditRecord = {
      planId: randomUUID(),
      sessionId: options.sessionId,
      createdAt: Date.now(),
      plannerKind: 'next-source-overlay',
      toolName: 'plan_next_source_override',
      profileId,
      ruleId: rule.ruleId,
      ruleType: rule.ruleType,
      requestMethod: rule.requestMethod,
      matchMode: rule.matchMode,
      targetAssetUrl: rule.targetAssetUrl,
      localFilePath: rule.localFilePath,
      configPath: options.plan.configPath ?? null,
      contentType: rule.contentType,
      originalSha256: null,
      patchedSha256: localFile.sha256,
      originalBytes: null,
      patchedBytes: localFile.bytes,
      patchSummary: {
        sourcePaths: options.plan.sourcePaths,
        editsApplied: options.plan.editsApplied,
        ruleReason: rule.reason,
        confidence: rule.confidence,
        score: rule.score,
        matchedSourcePaths: rule.matchedSourcePaths,
        originalAssetPath: rule.originalAssetPath ?? null,
        build: options.plan.build,
        configWritten: options.plan.configWritten,
      },
      preview: null,
      warnings: [...options.plan.warnings, ...rule.blockers.map((blocker) => `rule ${rule.ruleId}: ${blocker}`)],
      blockers: options.plan.blockers,
      capturedFromLiveSession: null,
      rollback: buildOverrideRollbackMetadata({
        sessionId,
        profileId,
        configPath: options.plan.configPath ?? null,
        generatedFiles,
        generatedDirectories: [options.plan.overlayRoot],
        note: 'Generated Next.js overlay folders are disposable once the override has been disabled.',
      }),
    };
    return insertOverridePlanAudit(options.db, record);
  });
}

function normalizeSnapshotResponsePayload(
  payload: Record<string, unknown>,
  options: SnapshotResponseOptions,
): Record<string, unknown> {
  const snapshotRecord = structuredClone(payload);
  const snapshotRoot = snapshotRecord.snapshot;
  if (typeof snapshotRoot === 'object' && snapshotRoot !== null) {
    const snapshotObject = snapshotRoot as Record<string, unknown>;
    if (!options.includeDom) {
      delete snapshotObject.dom;
    }
    if (!options.includeStyles) {
      delete snapshotObject.styles;
    }
  }

  const png = snapshotRecord.png;
  if (!options.includePngDataUrl && typeof png === 'object' && png !== null) {
    delete (png as Record<string, unknown>).dataUrl;
  }

  return snapshotRecord;
}

function resolveFailureEvidenceCaptureOptions(input: ToolInput): FailureEvidenceCaptureOptions {
  const raw = isRecord(input.captureOnFailure) ? input.captureOnFailure : undefined;
  const enabled = raw !== undefined ? raw.enabled !== false : false;
  const mode = raw?.mode === 'png' || raw?.mode === 'both' || raw?.mode === 'dom' ? raw.mode : 'dom';
  const styleMode = raw?.styleMode === 'computed-full' || raw?.styleMode === 'computed-lite'
    ? raw.styleMode
    : 'computed-lite';
  return {
    enabled,
    selector: typeof raw?.selector === 'string' && raw.selector.trim().length > 0 ? raw.selector.trim() : undefined,
    mode,
    styleMode,
    explicitStyleMode: raw?.styleMode === 'computed-full' || raw?.styleMode === 'computed-lite',
    maxDepth: resolveCaptureDepth(raw?.maxDepth, 3),
    maxBytes: resolveCaptureBytes(raw?.maxBytes, 50_000),
    maxAncestors: resolveCaptureAncestors(raw?.maxAncestors, 4),
    includeDom: typeof raw?.includeDom === 'boolean' ? raw.includeDom : mode !== 'png',
    includeStyles: typeof raw?.includeStyles === 'boolean' ? raw.includeStyles : mode !== 'png',
    includePngDataUrl: typeof raw?.includePngDataUrl === 'boolean' ? raw.includePngDataUrl : mode !== 'png',
  };
}

function resolveWorkflowFailurePolicy(
  step: UIWorkflowStep,
  stopOnFailure: boolean | undefined,
): UIWorkflowResolvedFailurePolicy {
  const raw = isRecord(step.onFailure) ? step.onFailure : undefined;
  const strategy = raw?.strategy === 'continue' || raw?.strategy === 'retry_once' || raw?.strategy === 'stop'
    ? raw.strategy
    : stopOnFailure === false
      ? 'continue'
      : 'stop';

  const captureRaw = raw && isRecord(raw.capture)
    ? {
        captureOnFailure: {
          ...raw.capture,
          enabled: raw.capture.enabled ?? true,
        },
      }
    : undefined;

  return {
    strategy,
    captureOptions: captureRaw ? resolveFailureEvidenceCaptureOptions(captureRaw) : undefined,
  };
}

async function captureFailureSnapshot(
  captureClient: CaptureCommandClient,
  sessionId: string,
  selector: string | undefined,
  options: FailureEvidenceCaptureOptions,
): Promise<Record<string, unknown> | undefined> {
  if (!options.enabled) {
    return undefined;
  }

  try {
    const capture = await executeLiveCapture(
      captureClient,
      sessionId,
      'CAPTURE_UI_SNAPSHOT',
      {
        selector: options.selector ?? selector,
        trigger: 'error',
        mode: options.mode,
        styleMode: options.styleMode,
        explicitStyleMode: options.explicitStyleMode,
        maxDepth: options.maxDepth,
        maxBytes: options.maxBytes,
        maxAncestors: options.maxAncestors,
        includeDom: options.includeDom,
        includeStyles: options.includeStyles,
        includePngDataUrl: options.includePngDataUrl,
        llmRequested: true,
      },
      5_000,
    );
    const payload = ensureCaptureSuccess(capture, sessionId);

    return {
      captured: true,
      limitsApplied: {
        maxBytes: options.maxBytes,
        truncated: capture.truncated ?? false,
      },
      snapshot: normalizeSnapshotResponsePayload(payload, options),
    };
  } catch (error) {
    const normalized = normalizeCaptureError(sessionId, error);
    return {
      captured: false,
      error: normalized.message,
    };
  }
}

async function captureFailureEvidence(
  captureClient: CaptureCommandClient,
  sessionId: string,
  request: LiveUIActionRequest,
  options: FailureEvidenceCaptureOptions,
): Promise<Record<string, unknown> | undefined> {
  return captureFailureSnapshot(captureClient, sessionId, request.target?.selector, options);
}

export function createV1ToolHandlers(
  getDb: () => Database,
  getSessionConnectionState?: (sessionId: string) => SessionConnectionLookupResult | undefined,
): Partial<Record<string, ToolHandler>> {
  return {
    list_sessions: async (input) => {
      const db = getDb();
      const sinceMinutes = typeof input.sinceMinutes === 'number' ? input.sinceMinutes : undefined;
      const limit = resolveLimit(input.limit, DEFAULT_LIST_LIMIT);
      const offset = resolveOffset(input.offset);
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);

      const where: string[] = [];
      const params: unknown[] = [];

      if (sinceMinutes !== undefined && Number.isFinite(sinceMinutes) && sinceMinutes > 0) {
        where.push(`
          CASE
            WHEN COALESCE(last_seen_at, 0) > created_at THEN COALESCE(last_seen_at, 0)
            ELSE created_at
          END >= ?
        `);
        params.push(Date.now() - Math.floor(sinceMinutes * 60_000));
      }

      const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      const sql = `
        SELECT
          session_id,
          created_at,
          last_seen_at,
          paused_at,
          ended_at,
          tab_id,
          window_id,
          url_start,
          url_last,
          user_agent,
          viewport_w,
          viewport_h,
          dpr,
          safe_mode,
          pinned
        FROM sessions
        ${whereClause}
        ORDER BY
          CASE
            WHEN COALESCE(last_seen_at, 0) > created_at THEN COALESCE(last_seen_at, 0)
            ELSE created_at
          END DESC,
          created_at DESC
        LIMIT ? OFFSET ?
      `;

      const rows = db.prepare(sql).all(...params, limit + 1, offset) as SessionRow[];
      const truncatedByLimit = rows.length > limit;
      const sessions = rows.slice(0, limit).map((row) => {
        const status = getSessionStatus(row);
        const state = getSessionConnectionState?.(row.session_id);
        const lastUrl = row.url_last ?? undefined;
        const scope = classifySessionUrl(lastUrl);
        const liveConnection = buildLiveConnectionRecord(row, scope, state);

        return {
          sessionId: row.session_id,
          createdAt: row.created_at,
          lastSeenAt: resolveSessionLastSeenAt(row, state),
          pausedAt: row.paused_at ?? undefined,
          endedAt: row.ended_at ?? undefined,
          status,
          tabId: row.tab_id ?? undefined,
          windowId: row.window_id ?? undefined,
          urlStart: row.url_start ?? undefined,
          urlLast: lastUrl,
          lastUrl,
          userAgent: row.user_agent ?? undefined,
          viewport:
            row.viewport_w !== null && row.viewport_h !== null
              ? {
                  width: row.viewport_w,
                  height: row.viewport_h,
                }
              : undefined,
          dpr: row.dpr ?? undefined,
          safeMode: row.safe_mode === 1,
          pinned: row.pinned === 1,
          scope,
          liveConnection,
        };
      });
      const bytePage = applyByteBudget(sessions, maxResponseBytes);
      const truncated = truncatedByLimit || bytePage.truncatedByBytes;

      return {
        ...createBaseResponse(),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
        responseBytes: bytePage.responseBytes,
        sessions: bytePage.items,
      };
    },

    get_session_summary: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const session = db
        .prepare('SELECT session_id, created_at, ended_at, url_last, pinned FROM sessions WHERE session_id = ?')
        .get(sessionId) as
        | {
            session_id: string;
            created_at: number;
            ended_at: number | null;
            url_last: string | null;
            pinned: number;
          }
        | undefined;

      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const counters = db
        .prepare(`
        SELECT
          SUM(CASE WHEN type = 'error' THEN 1 ELSE 0 END) AS errors,
          SUM(CASE WHEN type = 'console' AND json_extract(payload_json, '$.level') = 'warn' THEN 1 ELSE 0 END) AS warnings
        FROM events
        WHERE session_id = ?
      `)
        .get(sessionId) as { errors: number | null; warnings: number | null };

      const networkFails = db
        .prepare(`
        SELECT COUNT(*) AS count
        FROM network
        WHERE session_id = ?
          AND (error_class IS NOT NULL OR COALESCE(status, 0) >= 400)
      `)
        .get(sessionId) as { count: number };

      const latestNav = db
        .prepare(`
        SELECT payload_json
        FROM events
        WHERE session_id = ? AND type = 'nav'
        ORDER BY ts DESC
        LIMIT 1
      `)
        .get(sessionId) as { payload_json: string } | undefined;

      const eventRange = db
        .prepare(`
        SELECT MIN(ts) AS start_ts, MAX(ts) AS end_ts
        FROM events
        WHERE session_id = ?
      `)
        .get(sessionId) as { start_ts: number | null; end_ts: number | null };

      const navPayload = latestNav ? readJsonPayload(latestNav.payload_json) : {};
      const lastUrl = resolveLastUrl(navPayload) ?? session.url_last ?? undefined;

      return {
        ...createBaseResponse(sessionId),
        counts: {
          errors: counters.errors ?? 0,
          warnings: counters.warnings ?? 0,
          networkFails: networkFails.count,
        },
        lastUrl,
        timeRange: {
          start: eventRange.start_ts ?? session.created_at,
          end: eventRange.end_ts ?? session.ended_at ?? session.created_at,
        },
        pinned: session.pinned === 1,
      };
    },

    get_live_session_health: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const session = db
        .prepare(`
          SELECT
            session_id,
            created_at,
            last_seen_at,
            paused_at,
            ended_at,
            tab_id,
            window_id,
            url_start,
            url_last,
            viewport_w,
            viewport_h,
            dpr,
            safe_mode,
            pinned
          FROM sessions
          WHERE session_id = ?
        `)
        .get(sessionId) as
        | {
            session_id: string;
            created_at: number;
            last_seen_at: number | null;
            paused_at: number | null;
            ended_at: number | null;
            tab_id: number | null;
            window_id: number | null;
            url_start: string | null;
            url_last: string | null;
            viewport_w: number | null;
            viewport_h: number | null;
            dpr: number | null;
            safe_mode: number;
            pinned: number;
          }
        | undefined;

      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const latestNav = db
        .prepare(`
          SELECT payload_json
          FROM events
          WHERE session_id = ? AND type = 'nav'
          ORDER BY ts DESC
          LIMIT 1
        `)
        .get(sessionId) as { payload_json: string } | undefined;

      const navPayload = latestNav ? readJsonPayload(latestNav.payload_json) : {};
      const lastUrl = resolveLastUrl(navPayload) ?? session.url_last ?? undefined;
      const scope = classifySessionUrl(lastUrl);
      const connectionState = getSessionConnectionState?.(sessionId);
      const liveConnection = buildLiveConnectionRecord(session, scope, connectionState);
      const status = getSessionStatus(session);
      const lastSeenAt = resolveSessionLastSeenAt(session, connectionState);
      const nextAction = buildLiveSessionNextAction(liveConnection, scope);
      const recommendedAction = buildLiveSessionRecommendedAction(liveConnection, scope);
      const sessionRecord = {
        sessionId: session.session_id,
        createdAt: session.created_at,
        lastSeenAt,
        pausedAt: session.paused_at ?? undefined,
        endedAt: session.ended_at ?? undefined,
        status,
        tabId: session.tab_id ?? undefined,
        windowId: session.window_id ?? undefined,
        urlStart: session.url_start ?? undefined,
        urlLast: session.url_last ?? undefined,
        lastUrl,
        viewport:
          session.viewport_w !== null && session.viewport_h !== null
            ? {
                width: session.viewport_w,
                height: session.viewport_h,
              }
            : undefined,
        dpr: session.dpr ?? undefined,
        safeMode: session.safe_mode === 1,
        pinned: session.pinned === 1,
      };

      return {
        ...createBaseResponse(sessionId),
        status,
        createdAt: session.created_at,
        lastSeenAt,
        pausedAt: session.paused_at ?? undefined,
        endedAt: session.ended_at ?? undefined,
        tabId: session.tab_id ?? undefined,
        windowId: session.window_id ?? undefined,
        lastUrl,
        safeMode: session.safe_mode === 1,
        pinned: session.pinned === 1,
        session: sessionRecord,
        scope,
        liveConnection,
        nextAction,
        recommendedAction,
      };
    },

    list_override_profiles: async (input) => {
      const profiles = buildOverrideProfileRecords();
      const responseProfile = resolveOverrideResponseProfile(input.responseProfile);

      return {
        ...createBaseResponse(),
        limitsApplied: {
          maxResults: profiles.length,
          truncated: false,
        },
        responseProfile,
        profiles: profiles.map((profile) => serializeOverrideProfile(profile, responseProfile)),
        nextActions: profiles.length > 0
          ? [{ code: 'VALIDATE_PROFILE', message: 'Run validate_override_profile before enabling overrides.' }]
          : [{ code: 'CREATE_PROFILE', message: 'Run create_override_profile to generate a candidate profile.' }],
      };
    },

    create_override_profile: async (input) => {
      const adapterInput = normalizeOptionalString(input.adapter) ?? normalizeOptionalString(input.mode);
      let adapter: OverrideProfileAdapterId | undefined;
      if (adapterInput !== undefined) {
        if (!OVERRIDE_PROFILE_ADAPTERS.includes(adapterInput as OverrideProfileAdapterId)) {
          throw new Error(`adapter must be one of: ${OVERRIDE_PROFILE_ADAPTERS.join(', ')}`);
        }
        adapter = adapterInput as OverrideProfileAdapterId;
      }

      const targetBaseUrl = normalizeOptionalString(input.targetBaseUrl);
      if (!targetBaseUrl) {
        throw new Error('targetBaseUrl is required, for example https://example.com/_next/ or https://example.com/assets/');
      }

      const generated = createOverrideProfileConfig({
        adapter,
        targetBaseUrl,
        projectRoot: normalizeOptionalString(input.projectRoot),
        assetRoot: normalizeOptionalString(input.assetRoot),
        nextDir: normalizeOptionalString(input.nextDir),
        configPath: normalizeOptionalString(input.configPath),
        profileId: normalizeOptionalString(input.profileId),
        profileName: normalizeOptionalString(input.profileName),
        enabled: normalizeOptionalBooleanInput(input.enabled, 'enabled'),
        profileEnabled: normalizeOptionalBooleanInput(input.profileEnabled, 'profileEnabled'),
        autoReload: normalizeOptionalBooleanInput(input.autoReload, 'autoReload'),
        includeManifestFiles: normalizeOptionalBooleanInput(input.includeManifestFiles, 'includeManifestFiles'),
        includeStaticFiles: normalizeOptionalBooleanInput(input.includeStaticFiles, 'includeStaticFiles'),
        extensions: normalizeOptionalStringArrayInput(input.extensions, 'extensions'),
        maxRules: normalizeOptionalNumberInput(input.maxRules, 'maxRules'),
      });

      const writeConfig = normalizeOptionalBooleanInput(input.writeConfig, 'writeConfig') ?? false;
      const overwrite = normalizeOptionalBooleanInput(input.overwrite, 'overwrite') ?? false;
      const responseProfile = resolveOverrideResponseProfile(input.responseProfile);
      const includeConfigJson = input.includeConfigJson === true || responseProfile === 'full';
      const write: Record<string, unknown> = {
        written: false,
        path: generated.suggestedConfigPath,
      };
      let nextActions = generated.nextActions;

      if (writeConfig && generated.ruleCount === 0) {
        write.failureCode = 'NO_RULES';
        write.message = 'Generated profile has no rules; config was not written.';
        nextActions = [{
          code: 'BUILD_APP',
          message: 'Build the app so local assets exist, then generate the profile again.',
        }];
      } else if (writeConfig && existsSync(generated.suggestedConfigPath) && !overwrite) {
        write.failureCode = 'CONFIG_EXISTS';
        write.message = 'Config file already exists; pass overwrite=true or choose another configPath.';
        nextActions = [{
          code: 'OVERWRITE_OR_CHOOSE_CONFIG_PATH',
          message: 'Pass overwrite=true to replace the config file, or choose a different configPath.',
        }, ...generated.nextActions];
      } else if (writeConfig) {
        mkdirSync(dirname(generated.suggestedConfigPath), { recursive: true });
        writeFileSync(generated.suggestedConfigPath, generated.configJson, 'utf8');
        write.written = true;
        write.bytes = Buffer.byteLength(generated.configJson, 'utf8');
        nextActions = generated.nextActions.filter((action) => action.code !== 'SAVE_LOCAL_CONFIG');
      }

      return {
        ...createBaseResponse(),
        limitsApplied: {
          maxResults: generated.ruleCount,
          truncated: generated.warnings.some((warning) => warning.startsWith('Rule generation was limited')),
        },
        adapter: generated.adapter,
        mode: generated.mode,
        projectRoot: generated.projectRoot,
        assetRoot: generated.assetRoot,
        nextDir: generated.nextDir,
        targetBaseUrl: generated.targetBaseUrl,
        suggestedConfigPath: generated.suggestedConfigPath,
        ruleCount: generated.ruleCount,
        manifestFiles: generated.manifestFiles,
        staticFileCount: generated.staticFileCount,
        missingManifestAssetCount: generated.missingManifestAssetCount,
        warnings: generated.warnings,
        nextActions,
        write,
        responseProfile,
        profile: responseProfile === 'full' ? generated.profile : compactOverrideProfile(generated.profile as unknown as Record<string, unknown>),
        config: responseProfile === 'full'
          ? generated.config
          : {
              enabled: generated.config.enabled,
              activeProfileId: generated.config.activeProfileId,
              profileCount: generated.config.profiles.length,
            },
        configJson: includeConfigJson ? generated.configJson : undefined,
        configJsonOmitted: !includeConfigJson,
      };
    },

    validate_override_profile: async (input) => {
      const profile = resolveOverrideProfileRecord(input.profileId);
      const issues = buildOverrideProfileIssues(profile);
      const responseProfile = resolveOverrideResponseProfile(input.responseProfile);

      return {
        ...createBaseResponse(),
        profileId: profile.profileId,
        valid: !issues.some((issue) => issue.severity === 'error'),
        issues,
        nextActions: buildOverrideProfileNextActions(profile, issues),
        responseProfile,
        profile: serializeOverrideProfile(profile, responseProfile),
      };
    },

    preflight_overrides: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const preflight = buildOverridePreflight({
        db,
        sessionId,
        profileId: input.profileId,
        getSessionConnectionState,
      });

      return {
        ...createBaseResponse(sessionId),
        ...preflight,
      };
    },

    list_observed_override_assets: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const assets = listObservedOverrideAssets(getDb(), {
        sessionId,
        limit: typeof input.limit === 'number' ? input.limit : 50,
        sinceTimestamp: typeof input.sinceTimestamp === 'number' ? input.sinceTimestamp : undefined,
      });
      const responseProfile = resolveOverrideResponseProfile(input.responseProfile);

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: assets.length,
          truncated: false,
        },
        responseProfile,
        assets: responseProfile === 'full' ? assets : assets.map(compactObservedOverrideAsset),
      };
    },

    plan_override_response_patch: async (input) => {
      const sessionId = getSessionId(input);
      const plan = planOverrideResponsePatch(input);
      const variantContext = buildOverrideVariantContext({
        targetUrl: plan.targetUrl,
        requestMethod: plan.requestMethod,
        matchMode: plan.matchMode,
        ruleType: plan.ruleType,
        captureMode: input.captureMode,
        source: input.source,
        triggerReload: input.triggerReload,
        requestHeaders: input.requestHeaders,
      });
      const auditPlan = persistResponsePlanAudit({
        db: getDb(),
        sessionId,
        input,
        plan,
        variantContext,
      });

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: plan.rule ? 1 : 0,
          truncated: false,
        },
        variantContext,
        audit: {
          persisted: auditPlan !== undefined,
          plans: auditPlan ? [auditPlan] : [],
        },
        ...plan,
      };
    },

    map_next_override_assets: async (input) => {
      const projectRoot = normalizeOptionalString(input.projectRoot);
      if (!projectRoot) {
        throw new Error('projectRoot is required');
      }

      const sessionId = getSessionId(input);
      const observedAssets = Array.isArray(input.observedAssets)
        ? input.observedAssets
        : sessionId
          ? listObservedOverrideAssets(getDb(), { sessionId })
          : input.observedAssets;

      const mapping = await mapNextOverrideAssetsWithDrift({
        projectRoot,
        nextDir: normalizeOptionalString(input.nextDir),
        observedAssets,
        sourcePaths: input.sourcePaths,
        route: input.route,
        maxResults: input.maxResults,
        fetchProductionAssets: input.fetchProductionAssets,
        productionFetchTimeoutMs: input.productionFetchTimeoutMs,
        maxProductionAssetBytes: input.maxProductionAssetBytes,
        maxDriftCandidates: input.maxDriftCandidates,
        productionFetchConcurrency: input.productionFetchConcurrency,
      });

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: mapping.candidates.length,
          truncated: false,
        },
        observedFromPersisted: !Array.isArray(input.observedAssets) && sessionId
          ? { sessionId, assetCount: Array.isArray(observedAssets) ? observedAssets.length : 0 }
          : undefined,
        ...mapping,
      };
    },

    plan_next_source_override: async (input) => {
      const projectRoot = normalizeOptionalString(input.projectRoot);
      if (!projectRoot) {
        throw new Error('projectRoot is required');
      }

      const sessionId = getSessionId(input);
      const observedAssets = Array.isArray(input.observedAssets)
        ? input.observedAssets
        : sessionId
          ? listObservedOverrideAssets(getDb(), { sessionId })
          : input.observedAssets;

      const plan = await planNextSourceOverride({
        projectRoot,
        nextDir: normalizeOptionalString(input.nextDir),
        observedAssets,
        sourceEdits: input.sourceEdits,
        sourcePaths: input.sourcePaths,
        route: input.route,
        configPath: input.configPath,
        writeConfig: input.writeConfig,
        overwrite: input.overwrite,
        enabled: input.enabled,
        profileEnabled: input.profileEnabled,
        autoReload: input.autoReload,
        profileId: input.profileId,
        profileName: input.profileName,
        buildTimeoutMs: input.buildTimeoutMs,
        maxRules: input.maxRules,
        fetchProductionAssets: input.fetchProductionAssets,
        productionFetchTimeoutMs: input.productionFetchTimeoutMs,
        maxProductionAssetBytes: input.maxProductionAssetBytes,
        maxDriftCandidates: input.maxDriftCandidates,
        productionFetchConcurrency: input.productionFetchConcurrency,
        overlayTtlMs: input.overlayTtlMs,
      });
      const auditPlans = persistNextSourcePlanAudits({
        db: getDb(),
        sessionId,
        input,
        plan,
      });

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: plan.rules.length,
          truncated: false,
        },
        observedFromPersisted: !Array.isArray(input.observedAssets) && sessionId
          ? { sessionId, assetCount: Array.isArray(observedAssets) ? observedAssets.length : 0 }
          : undefined,
        audit: {
          persisted: auditPlans.length > 0,
          plans: auditPlans,
        },
        ...plan,
      };
    },

    get_override_status: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      const profile = resolveOverrideProfileRecord(input.profileId);
      const latestRun = sessionId ? listOverridePocRuns(db, sessionId, 1, 0).runs[0] ?? null : null;
      const recentRequests = sessionId
        ? listOverridePocRequests(db, sessionId, 5, 0, latestRun?.runId).requests
        : [];
      const recentPlans = sessionId
        ? listOverridePlanAudits(db, { sessionId, limit: 5, offset: 0 }).plans
        : [];

      return {
        ...createBaseResponse(sessionId),
        profile,
        latestRun,
        recentRequests,
        recentPlans,
        preflight: sessionId
          ? buildOverridePreflight({
              db,
              sessionId,
              profileId: input.profileId,
              getSessionConnectionState,
            })
          : null,
        diagnosis: sessionId ? diagnoseOverridePoc(db, sessionId, latestRun?.runId) : null,
        nextActions: latestRun?.lastErrorCode
          ? [{ code: 'DIAGNOSE_OVERRIDES', message: 'Run diagnose_overrides for the latest failed override run.' }]
          : latestRun
            ? [{ code: 'GET_OVERRIDE_REQUEST_LOG', message: 'Inspect get_override_request_log for matched and fulfilled requests.' }]
            : [{ code: 'ENABLE_OVERRIDES', message: 'Enable overrides on a connected session after profile validation succeeds.' }],
      };
    },

    get_override_request_log: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const limit = resolveLimit(input.limit, DEFAULT_EVENT_LIMIT);
      const offset = resolveOffset(input.offset);
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);
      const runId = typeof input.runId === 'string' && input.runId.trim().length > 0
        ? input.runId.trim()
        : undefined;
      const result = listOverridePocRequests(db, sessionId, limit, offset, runId);
      const bytePage = applyByteBudget(result.requests, maxResponseBytes);
      const truncated = result.hasMore || bytePage.truncatedByBytes;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        runId: runId ?? null,
        pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
        responseBytes: bytePage.responseBytes,
        requests: bytePage.items,
        nextActions: bytePage.items.length === 0
          ? [{ code: 'RELOAD_TAB', message: 'Reload the selected tab after enabling overrides so matching requests are observed.' }]
          : [{ code: 'DIAGNOSE_OVERRIDES', message: 'Run diagnose_overrides if any matched request failed or did not fulfill.' }],
      };
    },

    get_override_plan_log: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const limit = resolveLimit(input.limit, DEFAULT_EVENT_LIMIT);
      const offset = resolveOffset(input.offset);
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);
      const planId = typeof input.planId === 'string' && input.planId.trim().length > 0
        ? input.planId.trim()
        : undefined;
      const result = listOverridePlanAudits(db, { sessionId, limit, offset, planId });
      const bytePage = applyByteBudget(result.plans, maxResponseBytes);
      const truncated = result.hasMore || bytePage.truncatedByBytes;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        planId: planId ?? null,
        pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
        responseBytes: bytePage.responseBytes,
        plans: bytePage.items,
        nextActions: bytePage.items.length === 0
          ? [{ code: 'PLAN_OVERRIDE', message: 'Run plan_override_response_patch or plan_next_source_override with sessionId to persist generated rule metadata.' }]
          : [{ code: 'REVIEW_ROLLBACK', message: 'Review rollback metadata before enabling or deleting generated override files.' }],
      };
    },

    diagnose_overrides: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const runId = typeof input.runId === 'string' && input.runId.trim().length > 0
        ? input.runId.trim()
        : undefined;

      const diagnosis = diagnoseOverridePoc(db, sessionId, runId);
      const firstIssue = diagnosis.issues[0];

      return {
        ...createBaseResponse(sessionId),
        diagnosis,
        nextActions: firstIssue?.suggestedActions[0]
          ? [{ code: firstIssue.code, message: firstIssue.suggestedActions[0] }]
          : [{ code: 'NO_DIAGNOSIS_ISSUES', message: 'No diagnosis issues were found for the selected override run.' }],
      };
    },

    discover_ssr_mockability: async (input) => {
      const db = getDb();
      const projectRoot = normalizeOptionalString(input.projectRoot);
      if (!projectRoot) {
        throw new Error('projectRoot is required');
      }

      const discovery = discoverSsrMockability({
        projectRoot,
        targetUrl: normalizeOptionalString(input.targetUrl),
        apiHost: normalizeOptionalString(input.apiHost),
        maxFiles: typeof input.maxFiles === 'number' ? input.maxFiles : undefined,
      });
      const auditRecord = createSsrMockAuditRecord({
        action: 'discover',
        status: discovery.mockable ? 'succeeded' : 'not_mockable',
        projectRoot: discovery.projectRoot,
        targetUrl: discovery.targetUrl,
        apiHost: discovery.apiHost,
        envVarName: discovery.preferredEnvVarName,
        envFilePath: discovery.preferredEnvFilePath,
        summary: {
          classification: discovery.classification,
          scannedFileCount: discovery.scannedFileCount,
          candidateCount: discovery.candidates.length,
        },
        result: discovery,
      });
      insertSsrMockAudit(db, auditRecord);

      return {
        ...createBaseResponse(),
        limitsApplied: {
          maxResults: discovery.candidates.length,
          truncated: false,
        },
        audit: auditRecord,
        ...discovery,
      };
    },

    apply_ssr_mock_config: async (input) => {
      const db = getDb();
      const projectRoot = normalizeOptionalString(input.projectRoot);
      if (!projectRoot) {
        throw new Error('projectRoot is required');
      }
      const envVarName = normalizeOptionalString(input.envVarName);
      if (!envVarName) {
        throw new Error('envVarName is required');
      }
      const mockBaseUrl = normalizeOptionalString(input.mockBaseUrl);
      if (!mockBaseUrl) {
        throw new Error('mockBaseUrl is required');
      }

      const applied = applySsrMockConfig({
        projectRoot,
        envVarName,
        mockBaseUrl,
        envFilePath: normalizeOptionalString(input.envFilePath),
        rollbackId: normalizeOptionalString(input.rollbackId),
      });
      const auditRecord = createSsrMockAuditRecord({
        action: 'apply-config',
        status: applied.changed ? 'succeeded' : 'no_change',
        projectRoot,
        envVarName,
        envFilePath: applied.envFilePath,
        mockBaseUrl: applied.mockBaseUrl,
        rollbackId: applied.rollbackId,
        summary: {
          mode: applied.mode,
          createdFile: applied.createdFile,
          changed: applied.changed,
        },
        result: applied,
      });
      insertSsrMockAudit(db, auditRecord);

      return {
        ...createBaseResponse(),
        limitsApplied: {
          maxResults: 1,
          truncated: false,
        },
        audit: auditRecord,
        ...applied,
        nextActions: [
          { code: 'RESTART_APP_SERVER', message: 'Restart the SSR app server so the env change takes effect.' },
          { code: 'REMOVE_SSR_MOCK_CONFIG', message: 'Run remove_ssr_mock_config when the mock session is finished.' },
        ],
      };
    },

    remove_ssr_mock_config: async (input) => {
      const db = getDb();
      const envFilePath = normalizeOptionalString(input.envFilePath);
      if (!envFilePath) {
        throw new Error('envFilePath is required');
      }
      const envVarName = normalizeOptionalString(input.envVarName);
      if (!envVarName) {
        throw new Error('envVarName is required');
      }

      const removed = removeSsrMockConfig({
        envFilePath,
        envVarName,
        rollbackId: normalizeOptionalString(input.rollbackId),
      });
      const auditRecord = createSsrMockAuditRecord({
        action: 'remove-config',
        status: removed.restored ? 'succeeded' : 'not_found',
        projectRoot: envFilePath,
        envVarName,
        envFilePath: removed.envFilePath,
        rollbackId: removed.rollbackId,
        summary: {
          mode: removed.mode,
          restored: removed.restored,
        },
        result: removed,
      });
      insertSsrMockAudit(db, auditRecord);

      return {
        ...createBaseResponse(),
        limitsApplied: {
          maxResults: 1,
          truncated: false,
        },
        audit: auditRecord,
        ...removed,
        nextActions: removed.restored
          ? [{ code: 'RESTART_APP_SERVER', message: 'Restart the SSR app server so the restored env value takes effect.' }]
          : [{ code: 'INSPECT_ENV_FILE', message: 'No managed SSR mock patch was found for this env var.' }],
      };
    },

    get_ssr_mock_audit_log: async (input) => {
      const db = getDb();
      const limit = resolveLimit(input.limit, DEFAULT_EVENT_LIMIT);
      const offset = resolveOffset(input.offset);
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);
      const projectRoot = normalizeOptionalString(input.projectRoot);
      const rollbackId = normalizeOptionalString(input.rollbackId);
      const envVarName = normalizeOptionalString(input.envVarName);
      const result = listSsrMockAudits(db, {
        projectRoot,
        rollbackId,
        envVarName,
        limit,
        offset,
      });
      const bytePage = applyByteBudget(result.audits, maxResponseBytes);
      const truncated = result.hasMore || bytePage.truncatedByBytes;

      return {
        ...createBaseResponse(),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        projectRoot: projectRoot ?? null,
        rollbackId: rollbackId ?? null,
        envVarName: envVarName ?? null,
        pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
        responseBytes: bytePage.responseBytes,
        audits: bytePage.items,
        nextActions: bytePage.items.length === 0
          ? [{ code: 'DISCOVER_SSR_MOCKABILITY', message: 'Run discover_ssr_mockability or apply_ssr_mock_config to create SSR mock audit rows.' }]
          : [{ code: 'REVIEW_SSR_MOCK_CLEANUP', message: 'Review the latest audit rows to confirm rollback ids and env file cleanup state.' }],
      };
    },

    create_mock_route: async (input) => {
      const db = getDb();
      const record = createMockRouteRecord(input);
      upsertMockRoute(db, record);

      const ssrScope = record.sessionScope ?? record.routeId;
      const ssrMockBasePath = record.mode === 'ssr' || record.mode === 'both'
        ? `/mock/ssr/${encodeURIComponent(ssrScope)}`
        : undefined;

      return {
        ...createBaseResponse(),
        limitsApplied: {
          maxResults: 1,
          truncated: false,
        },
        route: record,
        ssrMockBasePath,
        nextActions: [record.enabled
          ? {
              code: record.mode === 'browser' ? 'ENABLE_BROWSER_MOCKS' : 'APPLY_SSR_MOCK_CONFIG',
              message: record.mode === 'browser'
                ? 'Enable browser overrides so matching requests are fulfilled.'
                : record.mode === 'ssr'
                ? `Point the discovered SSR env var at ${ssrMockBasePath ?? '/mock/ssr/<scope>'}.`
                : `Use browser overrides or point the discovered SSR env var at ${ssrMockBasePath ?? '/mock/ssr/<scope>'}.`,
            }
          : {
              code: 'ENABLE_MOCK_ROUTE',
              message: 'Set enabled=true when the route should start affecting browser or SSR traffic.',
            }],
      };
    },

    update_mock_route: async (input) => {
      const db = getDb();
      const routeId = normalizeOptionalString(input.routeId);
      if (!routeId) {
        throw new Error('routeId is required');
      }
      const existing = getMockRoute(db, routeId);
      if (!existing) {
        throw new Error(`Unknown mock route: ${routeId}`);
      }
      const record = createMockRouteRecord(input, existing);
      upsertMockRoute(db, record);

      return {
        ...createBaseResponse(),
        limitsApplied: {
          maxResults: 1,
          truncated: false,
        },
        route: record,
        nextActions: [{ code: 'REVIEW_MOCK_STATUS', message: 'Review route mode, target URL, and body payload before running the mock.' }],
      };
    },

    delete_mock_route: async (input) => {
      const db = getDb();
      const routeId = normalizeOptionalString(input.routeId);
      if (!routeId) {
        throw new Error('routeId is required');
      }
      const deleted = deleteMockRoute(db, routeId);
      return {
        ...createBaseResponse(),
        limitsApplied: {
          maxResults: 1,
          truncated: false,
        },
        routeId,
        deleted,
        nextActions: deleted
          ? [{ code: 'CONFIRM_CLEANUP', message: 'If a runtime was using this route, confirm no active mock run still references it.' }]
          : [{ code: 'LIST_MOCK_ROUTES', message: 'The route was not found; list persisted mock routes to confirm the intended routeId.' }],
      };
    },

    list_mock_routes: async (input) => {
      const db = getDb();
      const limit = resolveLimit(input.limit, DEFAULT_EVENT_LIMIT);
      const offset = resolveOffset(input.offset);
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);
      const result = listMockRoutes(db, {
        projectRoot: normalizeOptionalString(input.projectRoot),
        mode: normalizeOptionalString(input.mode) === 'ssr' || normalizeOptionalString(input.mode) === 'both'
          ? normalizeOptionalString(input.mode) as MockRouteMode
          : normalizeOptionalString(input.mode) === 'browser'
            ? 'browser'
            : undefined,
        enabled: typeof input.enabled === 'boolean' ? input.enabled : undefined,
        limit,
        offset,
      });
      const bytePage = applyByteBudget(result.routes, maxResponseBytes);
      const truncated = result.hasMore || bytePage.truncatedByBytes;

      return {
        ...createBaseResponse(),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
        responseBytes: bytePage.responseBytes,
        routes: bytePage.items,
        nextActions: bytePage.items.length === 0
          ? [{ code: 'CREATE_MOCK_ROUTE', message: 'Create a persisted mock route before enabling browser or SSR mocking.' }]
          : [{ code: 'GET_MOCK_STATUS', message: 'Inspect mock status and recent run or hit records for one route.' }],
      };
    },

    get_mock_route: async (input) => {
      const db = getDb();
      const routeId = normalizeOptionalString(input.routeId);
      if (!routeId) {
        throw new Error('routeId is required');
      }
      const route = getMockRoute(db, routeId);
      if (!route) {
        throw new Error(`Unknown mock route: ${routeId}`);
      }
      return {
        ...createBaseResponse(),
        limitsApplied: {
          maxResults: 1,
          truncated: false,
        },
        route,
        nextActions: [{ code: 'GET_MOCK_STATUS', message: 'Inspect latest runs and hits before enabling or updating this route.' }],
      };
    },

    get_mock_run_log: async (input) => {
      const db = getDb();
      const limit = resolveLimit(input.limit, DEFAULT_EVENT_LIMIT);
      const offset = resolveOffset(input.offset);
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);
      const result = listMockRuns(db, {
        routeId: normalizeOptionalString(input.routeId),
        sessionId: normalizeOptionalString(input.sessionId),
        limit,
        offset,
      });
      const bytePage = applyByteBudget(result.runs, maxResponseBytes);
      const truncated = result.hasMore || bytePage.truncatedByBytes;

      return {
        ...createBaseResponse(),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
        responseBytes: bytePage.responseBytes,
        runs: bytePage.items,
        nextActions: bytePage.items.length === 0
          ? [{ code: 'ENABLE_BROWSER_MOCKS', message: 'No mock runs exist yet; wire a runtime flow that can create execution records.' }]
          : [{ code: 'GET_MOCK_HIT_LOG', message: 'Inspect matching hit records for the selected run or route.' }],
      };
    },

    get_mock_hit_log: async (input) => {
      const db = getDb();
      const limit = resolveLimit(input.limit, DEFAULT_EVENT_LIMIT);
      const offset = resolveOffset(input.offset);
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);
      const result = listMockHits(db, {
        routeId: normalizeOptionalString(input.routeId),
        runId: normalizeOptionalString(input.runId),
        limit,
        offset,
      });
      const bytePage = applyByteBudget(result.hits, maxResponseBytes);
      const truncated = result.hasMore || bytePage.truncatedByBytes;

      return {
        ...createBaseResponse(),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
        responseBytes: bytePage.responseBytes,
        hits: bytePage.items,
        nextActions: bytePage.items.length === 0
          ? [{ code: 'RUN_MOCK_ROUTE', message: 'No hit records exist yet; execute the route through a browser or SSR runtime.' }]
          : [{ code: 'DIAGNOSE_MOCK_ROUTE', message: 'Use hit results to verify whether the route matched and fulfilled as expected.' }],
      };
    },

    get_mock_status: async (input) => {
      const db = getDb();
      const routeId = normalizeOptionalString(input.routeId);
      const projectRoot = normalizeOptionalString(input.projectRoot);
      const route = routeId ? getMockRoute(db, routeId) : null;
      const recentRoutes = listMockRoutes(db, { projectRoot, limit: 5, offset: 0 }).routes;
      const recentRuns = listMockRuns(db, { routeId, limit: 5, offset: 0 }).runs;
      const recentHits = listMockHits(db, { routeId, limit: 5, offset: 0 }).hits;

      return {
        ...createBaseResponse(),
        limitsApplied: {
          maxResults: 5,
          truncated: false,
        },
        route,
        recentRoutes,
        recentRuns,
        recentHits,
        nextActions: route
          ? [{ code: 'EXECUTE_MOCK_ROUTE', message: 'Bind the persisted route to browser or SSR execution so runs and hits begin to accumulate.' }]
          : [{ code: 'CREATE_MOCK_ROUTE', message: 'Persist a mock route first, then inspect status again.' }],
      };
    },

    get_recent_events: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      const origin = normalizeRequestedOrigin(input.url);
      ensureSessionOrOriginFilter(sessionId, origin);

      const limit = resolveLimit(input.limit, DEFAULT_EVENT_LIMIT);
      const offset = resolveOffset(input.offset);
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);
      const responseProfile = resolveResponseProfile(input.responseProfile);
      const includePayload = responseProfile === 'compact' && input.includePayload === true;
      const requestedTypes = parseRequestedTypes(input.types ?? input.eventTypes);

      const params: unknown[] = [];
      const where: string[] = [];
      if (sessionId) {
        where.push('session_id = ?');
        params.push(sessionId);
      }
      appendEventOriginFilter(where, params, origin);
      if (requestedTypes.length > 0) {
        const placeholders = requestedTypes.map(() => '?').join(', ');
        where.push(`type IN (${placeholders})`);
        params.push(...requestedTypes);
      }

      const rows = db
        .prepare(`
        SELECT event_id, session_id, ts, type, payload_json, tab_id, origin
        FROM events
        WHERE ${where.join(' AND ')}
        ORDER BY ts DESC
        LIMIT ? OFFSET ?
      `)
        .all(...params, limit + 1, offset) as EventRow[];

      const truncatedByLimit = rows.length > limit;
      const events = rows
        .slice(0, limit)
        .map((row) => mapEventRecord(row, responseProfile, { includePayload }));
      const bytePage = applyByteBudget(events, maxResponseBytes);
      const truncated = truncatedByLimit || bytePage.truncatedByBytes;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
        responseProfile,
        responseBytes: bytePage.responseBytes,
        events: bytePage.items,
      };
    },

    get_navigation_history: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      const origin = normalizeRequestedOrigin(input.url);
      ensureSessionOrOriginFilter(sessionId, origin);

      const limit = resolveLimit(input.limit, DEFAULT_EVENT_LIMIT);
      const offset = resolveOffset(input.offset);
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);
      const responseProfile = resolveResponseProfile(input.responseProfile);
      const includePayload = responseProfile === 'compact' && input.includePayload === true;
      const params: unknown[] = [];
      const where: string[] = ["type = 'nav'"];
      if (sessionId) {
        where.push('session_id = ?');
        params.push(sessionId);
      }
      appendEventOriginFilter(where, params, origin);
      const rows = db
        .prepare(`
        SELECT event_id, session_id, ts, type, payload_json, tab_id, origin
        FROM events
        WHERE ${where.join(' AND ')}
        ORDER BY ts DESC
        LIMIT ? OFFSET ?
      `)
        .all(...params, limit + 1, offset) as EventRow[];

      const truncatedByLimit = rows.length > limit;
      const events = rows
        .slice(0, limit)
        .map((row) => mapEventRecord(row, responseProfile, { includePayload }));
      const bytePage = applyByteBudget(events, maxResponseBytes);
      const truncated = truncatedByLimit || bytePage.truncatedByBytes;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
        responseProfile,
        responseBytes: bytePage.responseBytes,
        events: bytePage.items,
      };
    },

    get_console_events: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      const origin = normalizeRequestedOrigin(input.url);
      ensureSessionOrOriginFilter(sessionId, origin);

      const level = typeof input.level === 'string' ? input.level : undefined;
      const limit = resolveLimit(input.limit, DEFAULT_EVENT_LIMIT);
      const offset = resolveOffset(input.offset);
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);
      const responseProfile = resolveResponseProfile(input.responseProfile);
      const includePayload = responseProfile === 'compact' && input.includePayload === true;
      const params: unknown[] = [];
      const where: string[] = ["type = 'console'"];
      if (sessionId) {
        where.push('session_id = ?');
        params.push(sessionId);
      }
      appendEventOriginFilter(where, params, origin);

      if (level) {
        where.push("json_extract(payload_json, '$.level') = ?");
        params.push(level);
      }

      const rows = db
        .prepare(`
        SELECT event_id, session_id, ts, type, payload_json, tab_id, origin
        FROM events
        WHERE ${where.join(' AND ')}
        ORDER BY ts DESC
        LIMIT ? OFFSET ?
      `)
        .all(...params, limit + 1, offset) as EventRow[];

      const truncatedByLimit = rows.length > limit;
      const events = rows
        .slice(0, limit)
        .map((row) => mapEventRecord(row, responseProfile, { includePayload }));
      const bytePage = applyByteBudget(events, maxResponseBytes);
      const truncated = truncatedByLimit || bytePage.truncatedByBytes;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
        responseProfile,
        responseBytes: bytePage.responseBytes,
        events: bytePage.items,
      };
    },

    get_console_summary: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      const origin = normalizeRequestedOrigin(input.url);
      ensureSessionOrOriginFilter(sessionId, origin);
      const level = typeof input.level === 'string' && input.level.length > 0 ? input.level : undefined;
      const sinceMinutes = typeof input.sinceMinutes === 'number' && Number.isFinite(input.sinceMinutes)
        ? Math.floor(input.sinceMinutes)
        : undefined;
      const limit = resolveLimit(input.limit, 10);

      const where: string[] = ["type = 'console'"];
      const params: unknown[] = [];
      if (sessionId) {
        where.push('session_id = ?');
        params.push(sessionId);
      }
      appendEventOriginFilter(where, params, origin);
      if (level) {
        where.push("json_extract(payload_json, '$.level') = ?");
        params.push(level);
      }
      if (sinceMinutes !== undefined && sinceMinutes > 0) {
        where.push('ts >= ?');
        params.push(Date.now() - sinceMinutes * 60_000);
      }
      const whereClause = `WHERE ${where.join(' AND ')}`;

      const totals = db
        .prepare(
          `
          SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN json_extract(payload_json, '$.level') = 'log' THEN 1 ELSE 0 END) AS log_count,
            SUM(CASE WHEN json_extract(payload_json, '$.level') = 'info' THEN 1 ELSE 0 END) AS info_count,
            SUM(CASE WHEN json_extract(payload_json, '$.level') = 'warn' THEN 1 ELSE 0 END) AS warn_count,
            SUM(CASE WHEN json_extract(payload_json, '$.level') = 'error' THEN 1 ELSE 0 END) AS error_count,
            SUM(CASE WHEN json_extract(payload_json, '$.level') = 'debug' THEN 1 ELSE 0 END) AS debug_count,
            SUM(CASE WHEN json_extract(payload_json, '$.level') = 'trace' THEN 1 ELSE 0 END) AS trace_count,
            MIN(ts) AS first_ts,
            MAX(ts) AS last_ts
          FROM events
          ${whereClause}
        `,
        )
        .get(...params) as {
        total: number;
        log_count: number | null;
        info_count: number | null;
        warn_count: number | null;
        error_count: number | null;
        debug_count: number | null;
        trace_count: number | null;
        first_ts: number | null;
        last_ts: number | null;
      };

      const topMessages = db
        .prepare(
          `
          SELECT
            COALESCE(json_extract(payload_json, '$.message'), 'console event') AS message,
            COALESCE(json_extract(payload_json, '$.level'), 'log') AS level,
            COUNT(*) AS count,
            MIN(ts) AS first_ts,
            MAX(ts) AS last_ts
          FROM events
          ${whereClause}
          GROUP BY message, level
          ORDER BY count DESC, last_ts DESC
          LIMIT ?
        `,
        )
        .all(...params, limit) as Array<{
        message: string;
        level: string;
        count: number;
        first_ts: number;
        last_ts: number;
      }>;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated: false,
        },
        counts: {
          total: totals.total ?? 0,
          byLevel: {
            log: totals.log_count ?? 0,
            info: totals.info_count ?? 0,
            warn: totals.warn_count ?? 0,
            error: totals.error_count ?? 0,
            debug: totals.debug_count ?? 0,
            trace: totals.trace_count ?? 0,
          },
        },
        firstSeenAt: totals.first_ts ?? undefined,
        lastSeenAt: totals.last_ts ?? undefined,
        topMessages: topMessages.map((entry) => ({
          level: entry.level,
          message: entry.message,
          count: entry.count,
          firstSeenAt: entry.first_ts,
          lastSeenAt: entry.last_ts,
        })),
      };
    },

    get_event_summary: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      const origin = normalizeRequestedOrigin(input.url);
      ensureSessionOrOriginFilter(sessionId, origin);
      const requestedTypes = parseRequestedTypes(input.types ?? input.eventTypes);
      const sinceMinutes = typeof input.sinceMinutes === 'number' && Number.isFinite(input.sinceMinutes)
        ? Math.floor(input.sinceMinutes)
        : undefined;
      const limit = resolveLimit(input.limit, 20);

      const where: string[] = [];
      const params: unknown[] = [];
      if (sessionId) {
        where.push('session_id = ?');
        params.push(sessionId);
      }
      appendEventOriginFilter(where, params, origin);
      if (requestedTypes.length > 0) {
        const placeholders = requestedTypes.map(() => '?').join(', ');
        where.push(`type IN (${placeholders})`);
        params.push(...requestedTypes);
      }
      if (sinceMinutes !== undefined && sinceMinutes > 0) {
        where.push('ts >= ?');
        params.push(Date.now() - sinceMinutes * 60_000);
      }
      const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

      const totals = db
        .prepare(
          `
          SELECT COUNT(*) AS total, MIN(ts) AS first_ts, MAX(ts) AS last_ts
          FROM events
          ${whereClause}
        `,
        )
        .get(...params) as {
        total: number;
        first_ts: number | null;
        last_ts: number | null;
      };

      const byType = db
        .prepare(
          `
          SELECT type, COUNT(*) AS count, MIN(ts) AS first_ts, MAX(ts) AS last_ts
          FROM events
          ${whereClause}
          GROUP BY type
          ORDER BY count DESC, last_ts DESC
          LIMIT ?
        `,
        )
        .all(...params, limit) as Array<{
        type: string;
        count: number;
        first_ts: number;
        last_ts: number;
      }>;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated: false,
        },
        counts: {
          total: totals.total ?? 0,
        },
        firstSeenAt: totals.first_ts ?? undefined,
        lastSeenAt: totals.last_ts ?? undefined,
        byType: byType.map((entry) => ({
          type: entry.type,
          count: entry.count,
          firstSeenAt: entry.first_ts,
          lastSeenAt: entry.last_ts,
        })),
      };
    },

    get_error_fingerprints: async (input) => {
      const db = getDb();
      const sessionId = typeof input.sessionId === 'string' ? input.sessionId : undefined;
      const sinceMinutes = typeof input.sinceMinutes === 'number' && Number.isFinite(input.sinceMinutes)
        ? Math.floor(input.sinceMinutes)
        : undefined;
      const limit = resolveLimit(input.limit, DEFAULT_LIST_LIMIT);
      const offset = resolveOffset(input.offset);
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);

      const params: unknown[] = [];
      const where: string[] = [];

      if (sessionId) {
        where.push('session_id = ?');
        params.push(sessionId);
      }

      if (sinceMinutes !== undefined && sinceMinutes > 0) {
        where.push('last_seen_at >= ?');
        params.push(Date.now() - sinceMinutes * 60_000);
      }

      const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

      const rows = db
        .prepare(`
          SELECT fingerprint, session_id, count, sample_message, sample_stack, first_seen_at, last_seen_at
          FROM error_fingerprints
          ${whereClause}
          ORDER BY count DESC, last_seen_at DESC
          LIMIT ? OFFSET ?
        `)
        .all(...params, limit + 1, offset) as ErrorFingerprintRow[];

      const truncatedByLimit = rows.length > limit;
      const fingerprints = rows.slice(0, limit).map((row) => ({
        fingerprint: row.fingerprint,
        sessionId: row.session_id,
        count: row.count,
        sampleMessage: row.sample_message,
        sampleStack: row.sample_stack ?? undefined,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
      }));
      const bytePage = applyByteBudget(fingerprints, maxResponseBytes);
      const truncated = truncatedByLimit || bytePage.truncatedByBytes;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
        responseBytes: bytePage.responseBytes,
        fingerprints: bytePage.items,
      };
    },

    get_network_failures: async (input) => {
      const db = getDb();
      const sessionId = typeof input.sessionId === 'string' ? input.sessionId : undefined;
      const origin = normalizeRequestedOrigin(input.url);
      ensureSessionOrOriginFilter(sessionId, origin);
      const groupBy = typeof input.groupBy === 'string' ? input.groupBy : undefined;
      const errorType = typeof input.errorType === 'string' ? input.errorType : undefined;
      const limit = resolveLimit(input.limit, DEFAULT_LIST_LIMIT);
      const offset = resolveOffset(input.offset);
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);

      const params: unknown[] = [];
      const where: string[] = [];
      const errorFilter = buildNetworkFailureFilter(errorType);

      if (sessionId) {
        where.push('session_id = ?');
        params.push(sessionId);
      }
      appendNetworkOriginFilter(where, params, origin);

      where.push(errorFilter);
      if (errorFilter === 'error_class = ?' && errorType) {
        params.push(errorType);
      }

      const whereClause = `WHERE ${where.join(' AND ')}`;

      if (groupBy === 'url' || groupBy === 'errorType' || groupBy === 'domain') {
        const groupExpression =
          groupBy === 'url'
            ? 'url'
            : groupBy === 'domain'
              ? NETWORK_DOMAIN_GROUP_SQL
              : "COALESCE(error_class, CASE WHEN COALESCE(status, 0) >= 400 THEN 'http_error' ELSE 'unknown' END)";

        const rows = db
          .prepare(`
            SELECT
              ${groupExpression} AS group_key,
              COUNT(*) AS count,
              MIN(ts_start) AS first_ts,
              MAX(ts_start) AS last_ts
            FROM network
            ${whereClause}
            GROUP BY group_key
            ORDER BY count DESC, last_ts DESC
            LIMIT ? OFFSET ?
          `)
          .all(...params, limit + 1, offset) as GroupedNetworkFailureRow[];

        const truncatedByLimit = rows.length > limit;
        const groups = rows.slice(0, limit).map((row) => ({
          key: row.group_key,
          count: row.count,
          firstSeenAt: row.first_ts,
          lastSeenAt: row.last_ts,
        }));
        const bytePage = applyByteBudget(groups, maxResponseBytes);
        const truncated = truncatedByLimit || bytePage.truncatedByBytes;

        return {
          ...createBaseResponse(sessionId),
          limitsApplied: {
            maxResults: limit,
            truncated,
          },
          pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
          responseBytes: bytePage.responseBytes,
          groupBy,
          groups: bytePage.items,
        };
      }

      const rows = db
        .prepare(`
          SELECT request_id, session_id, trace_id, tab_id, ts_start, duration_ms, method, url, origin, status, initiator, error_class
          FROM network
          ${whereClause}
          ORDER BY ts_start DESC
          LIMIT ? OFFSET ?
        `)
        .all(...params, limit + 1, offset) as NetworkFailureRow[];

      const truncatedByLimit = rows.length > limit;
      const failures = rows.slice(0, limit).map((row) => ({
        requestId: row.request_id,
        sessionId: row.session_id,
        traceId: row.trace_id ?? undefined,
        tabId: row.tab_id ?? undefined,
        timestamp: row.ts_start,
        durationMs: row.duration_ms ?? undefined,
        method: row.method,
        url: row.url,
        origin: row.origin ?? undefined,
        status: row.status ?? undefined,
        initiator: row.initiator ?? undefined,
        errorType: classifyNetworkFailure(row.status, row.error_class),
      }));
      const bytePage = applyByteBudget(failures, maxResponseBytes);
      const truncated = truncatedByLimit || bytePage.truncatedByBytes;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
        responseBytes: bytePage.responseBytes,
        failures: bytePage.items,
      };
    },

    get_network_calls: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const includeBodies = input.includeBodies === true;
      const urlContains = normalizeOptionalString(input.urlContains);
      const urlRegex = compileSafeRegex(normalizeOptionalString(input.urlRegex));
      const method = normalizeHttpMethod(input.method);
      const statusIn = normalizeStatusIn(input.statusIn);
      const tabId = resolveOptionalTabId(input.tabId);
      const timeFrom = resolveOptionalTimestamp(input.timeFrom);
      const timeTo = resolveOptionalTimestamp(input.timeTo);
      const limit = resolveLimit(input.limit, DEFAULT_EVENT_LIMIT);
      const offset = resolveOffset(input.offset);
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);
      if (timeFrom !== undefined && timeTo !== undefined && timeFrom > timeTo) {
        throw new Error('timeFrom must be <= timeTo');
      }

      const where: string[] = ['session_id = ?'];
      const params: unknown[] = [sessionId];
      if (urlContains) {
        where.push('url LIKE ?');
        params.push(`%${urlContains}%`);
      }
      if (method) {
        where.push('method = ?');
        params.push(method);
      }
      if (statusIn.length > 0) {
        where.push(`status IN (${statusIn.map(() => '?').join(', ')})`);
        params.push(...statusIn);
      }
      if (tabId !== undefined) {
        where.push('tab_id = ?');
        params.push(tabId);
      }
      if (timeFrom !== undefined) {
        where.push('ts_start >= ?');
        params.push(timeFrom);
      }
      if (timeTo !== undefined) {
        where.push('ts_start <= ?');
        params.push(timeTo);
      }
      const whereClause = `WHERE ${where.join(' AND ')}`;

      if (!urlRegex) {
        const rows = db.prepare(
          `SELECT ${NETWORK_CALL_SELECT_COLUMNS}
           FROM network
           ${whereClause}
           ORDER BY ts_start DESC
           LIMIT ? OFFSET ?`
        ).all(...params, limit + 1, offset) as NetworkCallRow[];

        const truncatedByLimit = rows.length > limit;
        const calls = rows
          .slice(0, limit)
          .map((row) => mapNetworkCallRecord(row, includeBodies));
        const bytePage = applyByteBudget(calls, maxResponseBytes);
        const truncated = truncatedByLimit || bytePage.truncatedByBytes;

        return {
          ...createBaseResponse(sessionId),
          limitsApplied: {
            maxResults: limit,
            truncated,
          },
          filtersApplied: {
            sessionId,
            urlContains,
            method,
            statusIn,
            tabId,
            timeFrom,
            timeTo,
            includeBodies,
          },
          pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
          responseBytes: bytePage.responseBytes,
          calls: bytePage.items,
        };
      }

      const regexScanLimit = Math.min(Math.max(limit + offset + 200, 500), 5000);
      const regex = urlRegex;
      const regexRows = db.prepare(
        `SELECT ${NETWORK_CALL_SELECT_COLUMNS}
         FROM network
         ${whereClause}
         ORDER BY ts_start DESC
         LIMIT ?`
      ).all(...params, regexScanLimit) as NetworkCallRow[];
      const matched = regexRows.filter((row) => regex.test(row.url));
      const sliced = matched.slice(offset, offset + limit + 1);
      const truncatedByLimit = matched.length > offset + limit;
      const calls = sliced
        .slice(0, limit)
        .map((row) => mapNetworkCallRecord(row, includeBodies));
      const bytePage = applyByteBudget(calls, maxResponseBytes);
      const truncated = truncatedByLimit || bytePage.truncatedByBytes;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        filtersApplied: {
          sessionId,
          urlContains,
          urlRegex: urlRegex.source,
          method,
          statusIn,
          tabId,
          timeFrom,
          timeTo,
          includeBodies,
          regexScanLimit,
        },
        pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
        responseBytes: bytePage.responseBytes,
        calls: bytePage.items,
      };
    },

    wait_for_network_call: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const urlPattern = normalizeOptionalString(input.urlPattern);
      if (!urlPattern) {
        throw new Error('urlPattern is required');
      }

      const method = normalizeHttpMethod(input.method);
      const timeoutMs = resolveTimeoutMs(input.timeoutMs, DEFAULT_NETWORK_POLL_TIMEOUT_MS, MAX_NETWORK_POLL_TIMEOUT_MS);
      const includeBodies = input.includeBodies === true;
      const startedAt = Date.now();
      const deadline = startedAt + timeoutMs;
      const urlRegex = compileSafeRegex(urlPattern);
      if (!urlRegex) {
        throw new Error('urlPattern is required');
      }

      while (Date.now() <= deadline) {
        const where: string[] = ['session_id = ?', 'ts_start >= ?'];
        const params: unknown[] = [sessionId, startedAt];
        if (method) {
          where.push('method = ?');
          params.push(method);
        }

        const rows = db.prepare(
          `SELECT ${NETWORK_CALL_SELECT_COLUMNS}
           FROM network
           WHERE ${where.join(' AND ')}
           ORDER BY ts_start ASC
           LIMIT 200`
        ).all(...params) as NetworkCallRow[];

        const matched = rows.find((row) => urlRegex.test(row.url));
        if (matched) {
          return {
            ...createBaseResponse(sessionId),
            limitsApplied: {
              maxResults: 1,
              truncated: false,
            },
            waitedMs: Date.now() - startedAt,
            filter: {
              urlPattern,
              method,
              timeoutMs,
              includeBodies,
            },
            call: mapNetworkCallRecord(matched, includeBodies),
          };
        }

        await sleep(DEFAULT_NETWORK_POLL_INTERVAL_MS);
      }

      throw new Error(`No matching network call for pattern "${urlPattern}" within ${timeoutMs}ms.`);
    },

    get_request_trace: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      const includeBodies = input.includeBodies === true;
      const requestId = normalizeOptionalString(input.requestId);
      const traceIdInput = normalizeOptionalString(input.traceId);
      const eventLimit = resolveLimit(input.eventLimit, DEFAULT_EVENT_LIMIT);

      if (!requestId && !traceIdInput) {
        throw new Error('requestId or traceId is required');
      }

      let anchor: NetworkCallRow | undefined;
      if (requestId) {
        const params: unknown[] = [requestId];
        let sql = `SELECT ${NETWORK_CALL_SELECT_COLUMNS} FROM network WHERE request_id = ?`;
        if (sessionId) {
          sql += ' AND session_id = ?';
          params.push(sessionId);
        }
        sql += ' LIMIT 1';
        anchor = db.prepare(sql).get(...params) as NetworkCallRow | undefined;
        if (!anchor) {
          throw new Error(`Request not found: ${requestId}`);
        }
      }

      const traceId = traceIdInput ?? anchor?.trace_id ?? null;
      const traceSessionId = sessionId ?? anchor?.session_id;
      const networkWhere: string[] = [];
      const networkParams: unknown[] = [];
      if (traceId) {
        networkWhere.push('trace_id = ?');
        networkParams.push(traceId);
      } else if (requestId) {
        networkWhere.push('request_id = ?');
        networkParams.push(requestId);
      }
      if (traceSessionId) {
        networkWhere.push('session_id = ?');
        networkParams.push(traceSessionId);
      }

      const networkRows = db.prepare(
        `SELECT ${NETWORK_CALL_SELECT_COLUMNS}
         FROM network
         WHERE ${networkWhere.join(' AND ')}
         ORDER BY ts_start ASC
         LIMIT 500`
      ).all(...networkParams) as NetworkCallRow[];

      const eventRows = traceId
        ? db.prepare(
          `SELECT event_id, session_id, ts, type, payload_json, tab_id, origin
           FROM events
           WHERE json_extract(payload_json, '$.traceId') = ?
             ${traceSessionId ? 'AND session_id = ?' : ''}
           ORDER BY ts ASC
           LIMIT ?`
        ).all(...(traceSessionId ? [traceId, traceSessionId, eventLimit + 1] : [traceId, eventLimit + 1])) as EventRow[]
        : [];
      const eventsTruncated = eventRows.length > eventLimit;
      const correlatedEvents = eventRows.slice(0, eventLimit).map((row) => mapEventRecord(row));

      return {
        ...createBaseResponse(traceSessionId),
        limitsApplied: {
          maxResults: eventLimit,
          truncated: eventsTruncated,
        },
        traceId: traceId ?? undefined,
        requestId: requestId ?? anchor?.request_id ?? undefined,
        anchorRequest: anchor ? mapNetworkCallRecord(anchor, includeBodies) : undefined,
        networkCalls: networkRows.map((row) => mapNetworkCallRecord(row, includeBodies)),
        correlatedEvents,
      };
    },

    get_body_chunk: async (input) => {
      const db = getDb();
      const chunkRef = normalizeOptionalString(input.chunkRef);
      if (!chunkRef) {
        throw new Error('chunkRef is required');
      }

      const sessionId = getSessionId(input);
      const offset = resolveOffset(input.offset);
      const limit = resolveBodyChunkBytes(input.limit);
      const row = db.prepare(
        `SELECT chunk_ref, session_id, request_id, trace_id, body_kind, content_type, body_text, body_bytes, truncated, created_at
         FROM body_chunks
         WHERE chunk_ref = ?
           ${sessionId ? 'AND session_id = ?' : ''}
         LIMIT 1`
      ).get(...(sessionId ? [chunkRef, sessionId] : [chunkRef])) as BodyChunkRow | undefined;

      if (!row) {
        throw new Error(`Body chunk not found: ${chunkRef}`);
      }

      return {
        ...createBaseResponse(row.session_id),
        limitsApplied: {
          maxResults: limit,
          truncated: offset + limit < row.body_bytes,
        },
        ...mapBodyChunkRecord(row, offset, limit),
      };
    },

    get_element_refs: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const selector = typeof input.selector === 'string' ? input.selector : undefined;
      if (!selector) {
        throw new Error('selector is required');
      }

      const limit = resolveLimit(input.limit, DEFAULT_EVENT_LIMIT);
      const offset = resolveOffset(input.offset);
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);
      const rows = db
        .prepare(`
          SELECT event_id, session_id, ts, type, payload_json, tab_id, origin
          FROM events
          WHERE session_id = ?
            AND type IN ('ui', 'element_ref')
            AND json_extract(payload_json, '$.selector') = ?
          ORDER BY ts DESC
          LIMIT ? OFFSET ?
        `)
        .all(sessionId, selector, limit + 1, offset) as EventRow[];

      const truncatedByLimit = rows.length > limit;
      const refs = rows.slice(0, limit).map((row) => mapEventRecord(row));
      const bytePage = applyByteBudget(refs, maxResponseBytes);
      const truncated = truncatedByLimit || bytePage.truncatedByBytes;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
        responseBytes: bytePage.responseBytes,
        selector,
        refs: bytePage.items,
      };
    },

    explain_last_failure: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const lookbackSeconds = resolveWindowSeconds(input.lookbackSeconds, 30, 300);
      const windowMs = lookbackSeconds * 1000;

      const latestErrorEvent = db
        .prepare(`
          SELECT event_id, session_id, ts, type, payload_json, tab_id, origin
          FROM events
          WHERE session_id = ?
            AND (type = 'error' OR (type = 'console' AND json_extract(payload_json, '$.level') = 'error'))
          ORDER BY ts DESC
          LIMIT 1
        `)
        .get(sessionId) as EventRow | undefined;

      const latestNetworkFailure = db
        .prepare(`
          SELECT request_id, session_id, trace_id, tab_id, ts_start, duration_ms, method, url, origin, status, initiator, error_class
          FROM network
          WHERE session_id = ?
            AND (error_class IS NOT NULL OR COALESCE(status, 0) >= 400)
          ORDER BY ts_start DESC
          LIMIT 1
        `)
        .get(sessionId) as NetworkFailureRow | undefined;

      const eventFailureTs = latestErrorEvent?.ts ?? -1;
      const networkFailureTs = latestNetworkFailure?.ts_start ?? -1;

      if (eventFailureTs < 0 && networkFailureTs < 0) {
        return {
          ...createBaseResponse(sessionId),
          limitsApplied: {
            maxResults: 0,
            truncated: false,
          },
          explanation: 'No failure events found for this session.',
          timeline: [],
        };
      }

      const anchorIsEvent = eventFailureTs >= networkFailureTs;
      const anchorTs = anchorIsEvent ? eventFailureTs : networkFailureTs;
      const anchorType = anchorIsEvent ? latestErrorEvent?.type ?? 'error' : 'network';

      const windowStart = anchorTs - windowMs;
      const windowEnd = anchorTs + 1_000;

      const eventRows = db
        .prepare(`
          SELECT event_id, session_id, ts, type, payload_json, tab_id, origin
          FROM events
          WHERE session_id = ?
            AND ts BETWEEN ? AND ?
          ORDER BY ts ASC
        `)
        .all(sessionId, windowStart, windowEnd) as EventRow[];

      const networkRows = db
        .prepare(`
          SELECT request_id, session_id, trace_id, tab_id, ts_start, duration_ms, method, url, origin, status, initiator, error_class
          FROM network
          WHERE session_id = ?
            AND ts_start BETWEEN ? AND ?
            AND (error_class IS NOT NULL OR COALESCE(status, 0) >= 400)
          ORDER BY ts_start ASC
        `)
        .all(sessionId, windowStart, windowEnd) as NetworkFailureRow[];

      const timeline = [
        ...eventRows.map((row) => {
          const payload = readJsonPayload(row.payload_json);
          return {
            timestamp: row.ts,
            type: row.type,
            eventId: row.event_id,
            description: describeEvent(row.type, payload),
            payload,
          };
        }),
        ...networkRows.map((row) => ({
          timestamp: row.ts_start,
          type: 'network',
          eventId: row.request_id,
          description: describeNetworkFailure(row),
          payload: {
            method: row.method,
            url: row.url,
            status: row.status ?? undefined,
            errorType: classifyNetworkFailure(row.status, row.error_class),
          },
        })),
      ]
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(0, 60);

      const closestAction = timeline
        .filter((entry) => entry.type === 'ui' && entry.timestamp <= anchorTs)
        .at(-1);

      const closestNetworkFailure = timeline
        .filter((entry) => entry.type === 'network' && entry.timestamp <= anchorTs)
        .at(-1);

      let rootCause = '';
      if (anchorType === 'network' && latestNetworkFailure) {
        rootCause = describeNetworkFailure(latestNetworkFailure);
      } else if (anchorType === 'error' || anchorType === 'console') {
        if (closestNetworkFailure && anchorTs - closestNetworkFailure.timestamp <= 5_000) {
          rootCause = `Runtime failure likely connected to recent ${closestNetworkFailure.description.toLowerCase()}.`;
        } else if (closestAction && anchorTs - closestAction.timestamp <= 10_000) {
          rootCause = `Runtime failure likely triggered after user action (${closestAction.description.toLowerCase()}).`;
        } else {
          rootCause = 'Runtime failure occurred without a clear nearby trigger in the correlation window.';
        }
      }

      const explanation = `Latest failure at ${anchorTs} with a ${lookbackSeconds}s correlation window.`;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: timeline.length,
          truncated: timeline.length >= 60,
        },
        explanation,
        rootCause,
        anchor: {
          type: anchorType,
          timestamp: anchorTs,
        },
        timeline,
      };
    },

    get_event_correlation: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const eventId = typeof input.eventId === 'string' ? input.eventId : '';
      if (!eventId) {
        throw new Error('eventId is required');
      }

      const anchorEvent = db
        .prepare(`
          SELECT event_id, session_id, ts, type, payload_json, tab_id, origin
          FROM events
          WHERE session_id = ? AND event_id = ?
          LIMIT 1
        `)
        .get(sessionId, eventId) as EventRow | undefined;

      if (!anchorEvent) {
        throw new Error(`Event not found: ${eventId}`);
      }

      const windowSeconds = resolveWindowSeconds(input.windowSeconds, 5, 60);
      const windowMs = windowSeconds * 1000;
      const windowStart = anchorEvent.ts - windowMs;
      const windowEnd = anchorEvent.ts + windowMs;

      const nearbyEvents = db
        .prepare(`
          SELECT event_id, session_id, ts, type, payload_json, tab_id, origin
          FROM events
          WHERE session_id = ?
            AND event_id != ?
            AND ts BETWEEN ? AND ?
        `)
        .all(sessionId, eventId, windowStart, windowEnd) as EventRow[];

      const nearbyNetworkFailures = db
        .prepare(`
          SELECT request_id, session_id, trace_id, tab_id, ts_start, duration_ms, method, url, origin, status, initiator, error_class
          FROM network
          WHERE session_id = ?
            AND ts_start BETWEEN ? AND ?
            AND (error_class IS NOT NULL OR COALESCE(status, 0) >= 400)
        `)
        .all(sessionId, windowStart, windowEnd) as NetworkFailureRow[];

      const correlations: CorrelationCandidate[] = [
        ...nearbyEvents.map((row) => {
          const deltaMs = row.ts - anchorEvent.ts;
          return {
            eventId: row.event_id,
            type: row.type,
            timestamp: row.ts,
            payload: readJsonPayload(row.payload_json),
            correlationScore: scoreCorrelation(anchorEvent.type, row.type, deltaMs, windowMs),
            relationship: inferCorrelationRelationship(anchorEvent.type, row.type, deltaMs),
            deltaMs,
          };
        }),
        ...nearbyNetworkFailures.map((row) => {
          const deltaMs = row.ts_start - anchorEvent.ts;
          return {
            eventId: row.request_id,
            type: 'network',
            timestamp: row.ts_start,
            payload: {
              method: row.method,
              url: row.url,
              status: row.status ?? undefined,
              errorType: classifyNetworkFailure(row.status, row.error_class),
            },
            correlationScore: scoreCorrelation(anchorEvent.type, 'network', deltaMs, windowMs),
            relationship: inferCorrelationRelationship(anchorEvent.type, 'network', deltaMs),
            deltaMs,
          };
        }),
      ]
        .sort((a, b) => {
          if (b.correlationScore !== a.correlationScore) {
            return b.correlationScore - a.correlationScore;
          }
          return Math.abs(a.deltaMs) - Math.abs(b.deltaMs);
        })
        .slice(0, 50);

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 50,
          truncated: nearbyEvents.length + nearbyNetworkFailures.length > 50,
        },
        anchorEvent: {
          eventId: anchorEvent.event_id,
          type: anchorEvent.type,
          timestamp: anchorEvent.ts,
          payload: readJsonPayload(anchorEvent.payload_json),
        },
        windowSeconds,
        correlatedEvents: correlations,
      };
    },

    list_snapshots: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const trigger = typeof input.trigger === 'string' && input.trigger.length > 0 ? input.trigger : undefined;
      const sinceTimestamp = resolveOptionalTimestamp(input.sinceTimestamp);
      const untilTimestamp = resolveOptionalTimestamp(input.untilTimestamp);
      const limit = resolveLimit(input.limit, DEFAULT_LIST_LIMIT);
      const offset = resolveOffset(input.offset);
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);

      const where: string[] = ['session_id = ?'];
      const params: unknown[] = [sessionId];
      if (trigger) {
        where.push('trigger = ?');
        params.push(trigger);
      }
      if (sinceTimestamp !== undefined) {
        where.push('ts >= ?');
        params.push(sinceTimestamp);
      }
      if (untilTimestamp !== undefined) {
        where.push('ts <= ?');
        params.push(untilTimestamp);
      }

      const rows = db
        .prepare(
          `SELECT
            snapshot_id, session_id, trigger_event_id, ts, trigger, selector, url, mode, style_mode,
            dom_json, styles_json, png_path, png_mime, png_bytes,
            dom_truncated, styles_truncated, png_truncated, created_at
           FROM snapshots
           WHERE ${where.join(' AND ')}
           ORDER BY ts DESC
           LIMIT ? OFFSET ?`
        )
        .all(...params, limit + 1, offset) as SnapshotRow[];

      const truncatedByLimit = rows.length > limit;
      const snapshots = rows.slice(0, limit).map((row) => mapSnapshotMetadata(row));
      const bytePage = applyByteBudget(snapshots, maxResponseBytes);
      const truncated = truncatedByLimit || bytePage.truncatedByBytes;
      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
        responseBytes: bytePage.responseBytes,
        snapshots: bytePage.items,
      };
    },

    get_snapshot_for_event: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const eventId = typeof input.eventId === 'string' ? input.eventId : '';
      if (!eventId) {
        throw new Error('eventId is required');
      }

      const maxDeltaMs = resolveDurationMs(input.maxDeltaMs, 10_000, 60_000);
      const event = db
        .prepare('SELECT event_id, ts, type FROM events WHERE session_id = ? AND event_id = ? LIMIT 1')
        .get(sessionId, eventId) as { event_id: string; ts: number; type: string } | undefined;

      if (!event) {
        throw new Error(`Event not found: ${eventId}`);
      }

      const byTriggerLink = db
        .prepare(
          `SELECT
            snapshot_id, session_id, trigger_event_id, ts, trigger, selector, url, mode, style_mode,
            dom_json, styles_json, png_path, png_mime, png_bytes,
            dom_truncated, styles_truncated, png_truncated, created_at
           FROM snapshots
           WHERE session_id = ? AND trigger_event_id = ?
           ORDER BY ts ASC
           LIMIT 1`
        )
        .get(sessionId, eventId) as SnapshotRow | undefined;

      if (byTriggerLink) {
        return {
          ...createBaseResponse(sessionId),
          limitsApplied: {
            maxResults: 1,
            truncated: false,
          },
          event: {
            eventId: event.event_id,
            timestamp: event.ts,
            type: event.type,
          },
          matchReason: 'trigger_event_id',
          snapshot: mapSnapshotMetadata(byTriggerLink),
        };
      }

      const byTimestamp = db
        .prepare(
          `SELECT
            snapshot_id, session_id, trigger_event_id, ts, trigger, selector, url, mode, style_mode,
            dom_json, styles_json, png_path, png_mime, png_bytes,
            dom_truncated, styles_truncated, png_truncated, created_at
           FROM snapshots
           WHERE session_id = ? AND ts BETWEEN ? AND ?
           ORDER BY ABS(ts - ?) ASC, ts ASC
           LIMIT 1`
        )
        .get(sessionId, event.ts, event.ts + maxDeltaMs, event.ts) as SnapshotRow | undefined;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 1,
          truncated: false,
        },
        event: {
          eventId: event.event_id,
          timestamp: event.ts,
          type: event.type,
        },
        matchReason: byTimestamp ? 'nearest_timestamp' : 'none',
        snapshot: byTimestamp ? mapSnapshotMetadata(byTimestamp) : null,
      };
    },

    get_snapshot_asset: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const snapshotId = typeof input.snapshotId === 'string' ? input.snapshotId : '';
      if (!snapshotId) {
        throw new Error('snapshotId is required');
      }

      const assetType = input.asset === 'png' ? 'png' : 'png';
      const encoding = input.encoding === 'raw' ? 'raw' : 'base64';
      const offset = resolveOffset(input.offset);
      const maxBytes = resolveChunkBytes(input.maxBytes, DEFAULT_SNAPSHOT_ASSET_CHUNK_BYTES);

      const snapshot = db
        .prepare(
          `SELECT snapshot_id, session_id, png_path, png_mime, png_bytes
           FROM snapshots
           WHERE session_id = ? AND snapshot_id = ?
           LIMIT 1`
        )
        .get(sessionId, snapshotId) as {
        snapshot_id: string;
        session_id: string;
        png_path: string | null;
        png_mime: string | null;
        png_bytes: number | null;
      } | undefined;

      if (!snapshot) {
        throw new Error(`Snapshot not found: ${snapshotId}`);
      }

      if (assetType !== 'png' || !snapshot.png_path) {
        throw new Error('Requested snapshot asset is not available.');
      }

      const dbPath = getMainDbPath(db);
      const absolutePath = resolveSnapshotAbsolutePath(dbPath, snapshot.png_path);
      if (!existsSync(absolutePath)) {
        throw new Error(`Snapshot asset is missing on disk: ${snapshot.png_path}`);
      }

      const fullBuffer = readFileSync(absolutePath);
      if (offset >= fullBuffer.byteLength) {
        return {
          ...createBaseResponse(sessionId),
          limitsApplied: {
            maxResults: maxBytes,
            truncated: false,
          },
          snapshotId,
          asset: assetType,
          assetUri: `snapshot://${encodeURIComponent(sessionId)}/${encodeURIComponent(snapshotId)}/${assetType}`,
          mime: snapshot.png_mime ?? 'image/png',
          totalBytes: fullBuffer.byteLength,
          offset,
          returnedBytes: 0,
          hasMore: false,
          nextOffset: null,
          encoding,
          chunk: encoding === 'raw' ? [] : undefined,
          chunkBase64: encoding === 'base64' ? '' : undefined,
        };
      }

      const chunkBuffer = fullBuffer.subarray(offset, Math.min(offset + maxBytes, fullBuffer.byteLength));
      const returnedBytes = chunkBuffer.byteLength;
      const nextOffset = offset + returnedBytes;
      const hasMore = nextOffset < fullBuffer.byteLength;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: maxBytes,
          truncated: hasMore,
        },
        snapshotId,
        asset: assetType,
        assetUri: `snapshot://${encodeURIComponent(sessionId)}/${encodeURIComponent(snapshotId)}/${assetType}`,
        mime: snapshot.png_mime ?? 'image/png',
        totalBytes: fullBuffer.byteLength,
        offset,
        returnedBytes,
        hasMore,
        nextOffset: hasMore ? nextOffset : null,
        encoding,
        chunk: encoding === 'raw' ? Array.from(chunkBuffer.values()) : undefined,
        chunkBase64: encoding === 'base64' ? chunkBuffer.toString('base64') : undefined,
      };
    },

    run_lighthouse_report: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      const report = await runLighthouseReport(db, {
        sessionId,
        url: typeof input.url === 'string' ? input.url : undefined,
        formFactor: input.formFactor === 'desktop' ? 'desktop' : 'mobile',
        categories: Array.isArray(input.categories)
          ? input.categories.filter((entry): entry is string => typeof entry === 'string')
          : undefined,
        maxWaitForLoadMs: typeof input.maxWaitForLoadMs === 'number' ? input.maxWaitForLoadMs : undefined,
        chromeFlags: Array.isArray(input.chromeFlags)
          ? input.chromeFlags.filter((entry): entry is string => typeof entry === 'string')
          : undefined,
      });

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 1,
          truncated: false,
        },
        report,
      };
    },

    list_lighthouse_reports: async (input) => {
      const db = getDb();
      const result = listLighthouseReports(db, {
        sessionId: getSessionId(input),
        urlContains: typeof input.urlContains === 'string' ? input.urlContains : undefined,
        status: typeof input.status === 'string' ? input.status : undefined,
        limit: typeof input.limit === 'number' ? input.limit : undefined,
        offset: typeof input.offset === 'number' ? input.offset : undefined,
      });

      return {
        ...createBaseResponse(getSessionId(input)),
        limitsApplied: {
          maxResults: result.pagination.limit,
          truncated: result.pagination.hasMore,
        },
        pagination: result.pagination,
        reports: result.reports,
      };
    },

    get_lighthouse_report: async (input) => {
      const db = getDb();
      const reportId = typeof input.reportId === 'string' ? input.reportId : '';
      if (!reportId) {
        throw new Error('reportId is required');
      }
      const report = getLighthouseReport(db, reportId);

      return {
        ...createBaseResponse(report.sessionId),
        limitsApplied: {
          maxResults: 1,
          truncated: false,
        },
        report,
      };
    },

    get_lighthouse_report_asset: async (input) => {
      const db = getDb();
      const reportId = typeof input.reportId === 'string' ? input.reportId : '';
      if (!reportId) {
        throw new Error('reportId is required');
      }
      const asset = normalizeLighthouseAsset(input.asset);
      const chunk = getLighthouseReportAsset(db, {
        reportId,
        asset,
        offset: typeof input.offset === 'number' ? input.offset : undefined,
        maxBytes: typeof input.maxBytes === 'number' ? input.maxBytes : undefined,
        encoding: input.encoding === 'raw' ? 'raw' : 'base64',
      });

      return {
        ...createBaseResponse(),
        limitsApplied: {
          maxResults: typeof chunk.bytesReturned === 'number' ? chunk.bytesReturned : 0,
          truncated: chunk.hasMore === true,
        },
        ...chunk,
      };
    },

    plan_lighthouse_fixes: async (input) => {
      const db = getDb();
      const reportId = typeof input.reportId === 'string' ? input.reportId : '';
      if (!reportId) {
        throw new Error('reportId is required');
      }
      const plan = planLighthouseFixes(db, {
        reportId,
        minPriority:
          input.minPriority === 'critical' || input.minPriority === 'high' || input.minPriority === 'medium' || input.minPriority === 'low'
            ? input.minPriority
            : undefined,
        limit: typeof input.limit === 'number' ? input.limit : undefined,
        projectRoot: typeof input.projectRoot === 'string' ? input.projectRoot : undefined,
        routePath: typeof input.routePath === 'string' ? input.routePath : undefined,
        sourceCandidateLimit: typeof input.sourceCandidateLimit === 'number' ? input.sourceCandidateLimit : undefined,
      });

      return {
        ...createBaseResponse(plan.sessionId),
        limitsApplied: {
          maxResults: plan.itemCount,
          truncated: false,
        },
        plan,
      };
    },

    list_automation_runs: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const status = normalizeOptionalString(input.status);
      const action = normalizeOptionalString(input.action);
      const traceId = normalizeOptionalString(input.traceId);
      const limit = resolveLimit(input.limit, DEFAULT_LIST_LIMIT);
      const offset = resolveOffset(input.offset);
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);

      const where: string[] = ['r.session_id = ?'];
      const params: unknown[] = [sessionId];
      if (status) {
        where.push('r.status = ?');
        params.push(status);
      }
      if (action) {
        where.push('r.action = ?');
        params.push(action);
      }
      if (traceId) {
        where.push('r.trace_id = ?');
        params.push(traceId);
      }

      const rows = db.prepare(
        `SELECT
           r.run_id,
           r.session_id,
           r.trace_id,
           r.action,
           r.tab_id,
           r.selector,
           r.status,
           r.started_at,
           r.completed_at,
            r.stop_reason,
            r.target_summary_json,
            r.diagnostics_json,
            r.failure_json,
           r.redaction_json,
           r.created_at,
           r.updated_at,
           COALESCE(step_stats.step_count, 0) AS step_count,
           step_stats.last_step_at
         FROM automation_runs r
         LEFT JOIN (
           SELECT
             run_id,
             COUNT(*) AS step_count,
             MAX(COALESCE(finished_at, started_at, created_at)) AS last_step_at
           FROM automation_steps
           GROUP BY run_id
         ) step_stats ON step_stats.run_id = r.run_id
         WHERE ${where.join(' AND ')}
         ORDER BY r.started_at DESC, r.run_id DESC
         LIMIT ? OFFSET ?`
      ).all(...params, limit + 1, offset) as AutomationRunRow[];

      const truncatedByLimit = rows.length > limit;
      const runs = rows.slice(0, limit).map((row) => mapAutomationRunRecord(row));
      const bytePage = applyByteBudget(runs, maxResponseBytes);
      const truncated = truncatedByLimit || bytePage.truncatedByBytes;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        filtersApplied: {
          sessionId,
          status,
          action,
          traceId,
        },
        pagination: buildOffsetPagination(offset, bytePage.items.length, truncated, maxResponseBytes),
        responseBytes: bytePage.responseBytes,
        runs: bytePage.items,
      };
    },

    get_automation_run: async (input) => {
      const db = getDb();
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const runId = normalizeOptionalString(input.runId);
      if (!runId) {
        throw new Error('runId is required');
      }

      const stepLimit = resolveLimit(input.stepLimit, DEFAULT_LIST_LIMIT);
      const stepOffset = resolveOffset(input.stepOffset);
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);

      const run = db.prepare(
        `SELECT
           r.run_id,
           r.session_id,
           r.trace_id,
           r.action,
           r.tab_id,
           r.selector,
           r.status,
           r.started_at,
           r.completed_at,
            r.stop_reason,
            r.target_summary_json,
            r.diagnostics_json,
            r.failure_json,
           r.redaction_json,
           r.created_at,
           r.updated_at,
           COALESCE(step_stats.step_count, 0) AS step_count,
           step_stats.last_step_at
         FROM automation_runs r
         LEFT JOIN (
           SELECT
             run_id,
             COUNT(*) AS step_count,
             MAX(COALESCE(finished_at, started_at, created_at)) AS last_step_at
           FROM automation_steps
           GROUP BY run_id
         ) step_stats ON step_stats.run_id = r.run_id
         WHERE r.session_id = ? AND r.run_id = ?
         LIMIT 1`
      ).get(sessionId, runId) as AutomationRunRow | undefined;

      if (!run) {
        throw new Error(`Automation run not found: ${runId}`);
      }

      const stepRows = db.prepare(
        `SELECT
           step_id,
           run_id,
           session_id,
           step_order,
           trace_id,
           action,
           selector,
           status,
           started_at,
           finished_at,
           duration_ms,
            tab_id,
            target_summary_json,
            diagnostics_json,
            redaction_json,
           failure_json,
           input_metadata_json,
           event_type,
           event_id,
           created_at,
           updated_at
         FROM automation_steps
         WHERE session_id = ? AND run_id = ?
         ORDER BY step_order ASC, created_at ASC
         LIMIT ? OFFSET ?`
      ).all(sessionId, runId, stepLimit + 1, stepOffset) as AutomationStepRow[];

      const truncatedByLimit = stepRows.length > stepLimit;
      const steps = stepRows.slice(0, stepLimit).map((row) => mapAutomationStepRecord(row));
      const bytePage = applyByteBudget(steps, maxResponseBytes);
      const truncated = truncatedByLimit || bytePage.truncatedByBytes;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: stepLimit,
          truncated,
        },
        run: mapAutomationRunRecord(run),
        steps: bytePage.items,
        pagination: buildOffsetPagination(stepOffset, bytePage.items.length, truncated, maxResponseBytes),
        responseBytes: bytePage.responseBytes,
      };
    },
  };
}

export function createV2ToolHandlers(
  captureClient: CaptureCommandClient,
  getDb?: () => Database,
  getSessionConnectionState?: (sessionId: string) => SessionConnectionLookupResult | undefined,
): Partial<Record<string, ToolHandler>> {
  const capturePageState = async (
    sessionId: string,
    input: ToolInput,
  ): Promise<{ limitsApplied: { maxResults: number; truncated: boolean }; payload: Record<string, unknown> }> => {
    const maxItems = resolveStructuredMaxItems(input.maxItems, 40);
    const maxTextLength = resolveStructuredTextLength(input.maxTextLength, 80);
    const includeButtons = input.includeButtons !== false;
    const includeLinks = input.includeLinks !== false;
    const includeInputs = input.includeInputs !== false;
    const includeModals = input.includeModals !== false;
    const capture = await executeLiveCapture(
      captureClient,
      sessionId,
      'CAPTURE_PAGE_STATE',
      {
        maxItems,
        maxTextLength,
        includeButtons,
        includeLinks,
        includeInputs,
        includeModals,
      },
      4_000,
    );

    return {
      limitsApplied: {
        maxResults: maxItems,
        truncated: capture.truncated ?? false,
      },
      payload: ensureCaptureSuccess(capture, sessionId),
    };
  };

  return {
    observe_override_assets: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const tabId = resolveOptionalTabId(input.tabId);
      const { capture, payload } = await executeOverrideLiveCaptureWithDiagnostics({
        captureClient,
        sessionId,
        command: 'CAPTURE_OVERRIDE_OBSERVE_ASSETS',
        payload: { tabId, includePerformance: input.includePerformance !== false },
        timeoutMs: 5_000,
        getSessionConnectionState,
      });
      const assetCount = Array.isArray(payload.assets) ? payload.assets.length : 0;
      const persisted = getDb
        ? persistObservedOverrideAssets(getDb(), { ...payload, sessionId, tabId: payload.tabId ?? tabId })
        : undefined;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: assetCount,
          truncated: capture.truncated ?? false,
        },
        persisted,
        ...payload,
        nextActions: assetCount > 0
          ? [{ code: 'MAP_NEXT_ASSETS', message: 'Run map_next_override_assets with projectRoot and sourcePaths to score override candidates.' }]
          : [{ code: 'LOAD_ROUTE', message: 'Load or interact with the target route so document, asset, and fetch resources are requested, then observe again.' }],
      };
    },

    capture_override_response_body: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const targetUrl = normalizeOptionalString(input.targetUrl) ?? normalizeOptionalString(input.targetAssetUrl);
      if (!targetUrl) {
        throw new Error('targetUrl is required');
      }
      assertOverrideResponseRequestCaptureSafe({
        requestMethod: input.requestMethod,
        requestHeaders: input.requestHeaders,
        ruleType: input.ruleType,
        subject: 'Response body capture request',
      });

      const tabId = resolveOptionalTabId(input.tabId);
      const timeoutMs = resolveTimeoutMs(input.timeoutMs, 10_000, 60_000);
      const { capture, payload } = await executeOverrideLiveCaptureWithDiagnostics({
        captureClient,
        sessionId,
        command: 'CAPTURE_OVERRIDE_RESPONSE_BODY',
        payload: {
          targetUrl,
          tabId,
          captureMode: normalizeOptionalString(input.captureMode),
          triggerReload: typeof input.triggerReload === 'boolean' ? input.triggerReload : undefined,
          matchMode: normalizeOptionalString(input.matchMode),
          ruleType: normalizeOptionalString(input.ruleType),
          requestMethod: input.requestMethod,
          requestHeaders: isRecord(input.requestHeaders) ? input.requestHeaders : undefined,
          timeoutMs,
          maxBodyBytes: input.maxBodyBytes,
          includeBody: input.includeBody === true,
        },
        timeoutMs: timeoutMs + 2_000,
        getSessionConnectionState,
      });

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 1,
          truncated: capture.truncated ?? payload.truncated === true,
        },
        ...payload,
        nextActions: payload.bodyCaptured === true
          ? [{ code: 'PLAN_RESPONSE_PATCH', message: 'Run plan_override_response_patch with textPatches or jsonPatches to generate an exact response override.' }]
          : [{ code: 'UNSUPPORTED_RESPONSE_BODY', message: 'Only bounded text-like response bodies can be patched safely.' }],
      };
    },

    plan_override_response_patch: async (input) => {
      const sessionId = getSessionId(input);
      let plannerInput: ToolInput = input;
      let capturedFromLiveSession: Record<string, unknown> | undefined;
      const hasProvidedBody = typeof input.responseBodyText === 'string'
        || typeof input.bodyText === 'string'
        || typeof input.responseBodyBase64 === 'string'
        || typeof input.bodyBase64 === 'string';

      if (!hasProvidedBody && sessionId) {
        const targetUrl = normalizeOptionalString(input.targetUrl) ?? normalizeOptionalString(input.targetAssetUrl);
        if (!targetUrl) {
          throw new Error('targetUrl is required');
        }
        const tabId = resolveOptionalTabId(input.tabId);
        const timeoutMs = resolveTimeoutMs(input.timeoutMs, 10_000, 60_000);
        const { payload } = await executeOverrideLiveCaptureWithDiagnostics({
          captureClient,
          sessionId,
          command: 'CAPTURE_OVERRIDE_RESPONSE_BODY',
          payload: {
            targetUrl,
            tabId,
            captureMode: normalizeOptionalString(input.captureMode),
            triggerReload: typeof input.triggerReload === 'boolean' ? input.triggerReload : undefined,
            matchMode: normalizeOptionalString(input.matchMode),
            ruleType: normalizeOptionalString(input.ruleType),
            requestMethod: input.requestMethod,
            requestHeaders: isRecord(input.requestHeaders) ? input.requestHeaders : undefined,
            timeoutMs,
            maxBodyBytes: input.maxBodyBytes,
            includeBody: true,
          },
          timeoutMs: timeoutMs + 2_000,
          getSessionConnectionState,
        });
        if (payload.truncated === true) {
          throw new Error('Captured response body was truncated; increase maxBodyBytes before planning a patch.');
        }
        if (typeof payload.bodyText !== 'string') {
          throw new Error('Captured response did not include a text body that can be patched.');
        }
        plannerInput = {
          ...input,
          responseBodyText: payload.bodyText,
          contentType: input.contentType ?? payload.contentType,
          ruleType: input.ruleType ?? payload.ruleType,
          requestMethod: input.requestMethod ?? payload.requestMethod,
          captureMode: input.captureMode ?? payload.captureMode,
          source: payload.source,
          requestHeaders: payload.requestHeaders,
        };
        const variantContext = buildOverrideVariantContext({
          targetUrl: payload.targetUrl,
          requestMethod: input.requestMethod ?? payload.requestMethod,
          matchMode: payload.matchMode,
          ruleType: input.ruleType ?? payload.ruleType,
          captureMode: payload.captureMode,
          source: payload.source,
          triggerReload: payload.triggerReload,
          requestHeaders: payload.requestHeaders,
        });
        capturedFromLiveSession = {
          sessionId,
          targetUrl: payload.targetUrl,
          requestMethod: input.requestMethod ?? payload.requestMethod,
          statusCode: payload.statusCode,
          contentType: payload.contentType,
          bodyBytes: payload.bodyBytes,
          capturedBytes: payload.capturedBytes,
          truncated: payload.truncated === true,
          ruleType: payload.ruleType,
          matchMode: payload.matchMode,
          captureMode: payload.captureMode,
          source: payload.source,
          tabId: payload.tabId,
          triggerReload: payload.triggerReload,
          requestHeaders: payload.requestHeaders,
          variantContext,
        };
      }

      const plan = planOverrideResponsePatch(plannerInput);
      const variantContext = buildOverrideVariantContext({
        targetUrl: plan.targetUrl,
        requestMethod: plan.requestMethod,
        matchMode: plan.matchMode,
        ruleType: plan.ruleType,
        captureMode: plannerInput.captureMode,
        source: plannerInput.source,
        triggerReload: plannerInput.triggerReload,
        requestHeaders: plannerInput.requestHeaders,
      });
      const auditPlan = getDb
        ? persistResponsePlanAudit({
            db: getDb(),
            sessionId,
            input,
            plan,
            capturedFromLiveSession,
            variantContext,
          })
        : undefined;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: plan.rule ? 1 : 0,
          truncated: false,
        },
        capturedFromLiveSession,
        variantContext,
        audit: {
          persisted: auditPlan !== undefined,
          plans: auditPlan ? [auditPlan] : [],
        },
        ...plan,
      };
    },

    map_next_override_assets: async (input) => {
      const projectRoot = normalizeOptionalString(input.projectRoot);
      if (!projectRoot) {
        throw new Error('projectRoot is required');
      }

      const sessionId = getSessionId(input);
      let observedAssets = input.observedAssets;
      let observedFromLiveTab: Record<string, unknown> | undefined;
      let observedFromPersisted: { sessionId: string; assetCount: number } | undefined;
      if (!Array.isArray(observedAssets) && sessionId) {
        const tabId = resolveOptionalTabId(input.tabId);
        const command = 'CAPTURE_OVERRIDE_OBSERVE_ASSETS';
        const timeoutMs = 5_000;
        try {
          const capture = await executeLiveCapture(
            captureClient,
            sessionId,
            command,
            { tabId, includePerformance: true },
            timeoutMs,
          );
          observedFromLiveTab = ensureCaptureSuccess(capture, sessionId);
          observedAssets = observedFromLiveTab.assets;
          if (getDb) {
            persistObservedOverrideAssets(getDb(), { ...observedFromLiveTab, sessionId, tabId: observedFromLiveTab.tabId ?? tabId });
          }
        } catch (error) {
          if (getDb && isRecoverableOverrideLiveCommandError(error)) {
            observedAssets = listObservedOverrideAssets(getDb(), { sessionId });
            observedFromPersisted = { sessionId, assetCount: Array.isArray(observedAssets) ? observedAssets.length : 0 };
          } else if (isRecoverableOverrideLiveCommandError(error)) {
            throw createOverrideLiveCommandError({
              sessionId,
              command,
              timeoutMs,
              error,
              getSessionConnectionState,
            });
          } else {
            throw error;
          }
        }
      }

      const mapping = await mapNextOverrideAssetsWithDrift({
        projectRoot,
        nextDir: normalizeOptionalString(input.nextDir),
        observedAssets,
        sourcePaths: input.sourcePaths,
        route: input.route,
        maxResults: input.maxResults,
        fetchProductionAssets: input.fetchProductionAssets,
        productionFetchTimeoutMs: input.productionFetchTimeoutMs,
        maxProductionAssetBytes: input.maxProductionAssetBytes,
        maxDriftCandidates: input.maxDriftCandidates,
        productionFetchConcurrency: input.productionFetchConcurrency,
      });

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: mapping.candidates.length,
          truncated: false,
        },
        observedFromLiveTab: observedFromLiveTab
          ? {
              pageUrl: observedFromLiveTab.pageUrl,
              tabId: observedFromLiveTab.tabId,
              assetCount: Array.isArray(observedFromLiveTab.assets) ? observedFromLiveTab.assets.length : 0,
            }
          : undefined,
        observedFromPersisted,
        ...mapping,
      };
    },

    plan_next_source_override: async (input) => {
      const projectRoot = normalizeOptionalString(input.projectRoot);
      if (!projectRoot) {
        throw new Error('projectRoot is required');
      }

      const sessionId = getSessionId(input);
      let observedAssets = input.observedAssets;
      let observedFromLiveTab: Record<string, unknown> | undefined;
      let observedFromPersisted: { sessionId: string; assetCount: number } | undefined;
      if (!Array.isArray(observedAssets) && sessionId) {
        const tabId = resolveOptionalTabId(input.tabId);
        const command = 'CAPTURE_OVERRIDE_OBSERVE_ASSETS';
        const timeoutMs = 5_000;
        try {
          const capture = await executeLiveCapture(
            captureClient,
            sessionId,
            command,
            { tabId, includePerformance: true },
            timeoutMs,
          );
          observedFromLiveTab = ensureCaptureSuccess(capture, sessionId);
          observedAssets = observedFromLiveTab.assets;
          if (getDb) {
            persistObservedOverrideAssets(getDb(), { ...observedFromLiveTab, sessionId, tabId: observedFromLiveTab.tabId ?? tabId });
          }
        } catch (error) {
          if (getDb && isRecoverableOverrideLiveCommandError(error)) {
            observedAssets = listObservedOverrideAssets(getDb(), { sessionId });
            observedFromPersisted = { sessionId, assetCount: Array.isArray(observedAssets) ? observedAssets.length : 0 };
          } else if (isRecoverableOverrideLiveCommandError(error)) {
            throw createOverrideLiveCommandError({
              sessionId,
              command,
              timeoutMs,
              error,
              getSessionConnectionState,
            });
          } else {
            throw error;
          }
        }
      }

      const plan = await planNextSourceOverride({
        projectRoot,
        nextDir: normalizeOptionalString(input.nextDir),
        observedAssets,
        sourceEdits: input.sourceEdits,
        sourcePaths: input.sourcePaths,
        route: input.route,
        configPath: input.configPath,
        writeConfig: input.writeConfig,
        overwrite: input.overwrite,
        enabled: input.enabled,
        profileEnabled: input.profileEnabled,
        autoReload: input.autoReload,
        profileId: input.profileId,
        profileName: input.profileName,
        buildTimeoutMs: input.buildTimeoutMs,
        maxRules: input.maxRules,
        fetchProductionAssets: input.fetchProductionAssets,
        productionFetchTimeoutMs: input.productionFetchTimeoutMs,
        maxProductionAssetBytes: input.maxProductionAssetBytes,
        maxDriftCandidates: input.maxDriftCandidates,
        productionFetchConcurrency: input.productionFetchConcurrency,
        overlayTtlMs: input.overlayTtlMs,
      });
      const auditPlans = getDb
        ? persistNextSourcePlanAudits({
            db: getDb(),
            sessionId,
            input,
            plan,
          })
        : [];

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: plan.rules.length,
          truncated: false,
        },
        observedFromLiveTab: observedFromLiveTab
          ? {
              pageUrl: observedFromLiveTab.pageUrl,
              tabId: observedFromLiveTab.tabId,
              assetCount: Array.isArray(observedFromLiveTab.assets) ? observedFromLiveTab.assets.length : 0,
            }
          : undefined,
        observedFromPersisted,
        audit: {
          persisted: auditPlans.length > 0,
          plans: auditPlans,
        },
        ...plan,
      };
    },

    get_override_status: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const command = 'CAPTURE_OVERRIDE_POC_GET_STATUS';
      const timeoutMs = 3_000;
      let capture: CaptureClientResult;
      let payload: Record<string, unknown>;
      try {
        capture = await executeLiveCapture(
          captureClient,
          sessionId,
          command,
          {},
          timeoutMs,
        );
        payload = ensureCaptureSuccess(capture, sessionId);
      } catch (error) {
        if (!getDb || !isRecoverableOverrideLiveCommandError(error)) {
          throw error;
        }

        const persisted = buildPersistedOverrideStatus({
          db: getDb(),
          sessionId,
          profileId: input.profileId,
          getSessionConnectionState,
        });
        const liveStatus = buildOverrideLiveCommandFailure({
          sessionId,
          command,
          timeoutMs,
          error,
          getSessionConnectionState,
        });

        return {
          ...createBaseResponse(sessionId),
          limitsApplied: {
            maxResults: 1,
            truncated: false,
          },
          statusSource: 'persisted-audit',
          liveStatus,
          ...persisted,
          nextActions: [
            { code: 'RECONNECT_OR_RETRY_OVERRIDE_STATUS', message: 'Reconnect or rebind the top-level session, then retry get_override_status for live debugger state.' },
            { code: 'DIAGNOSE_OVERRIDES', message: 'Run diagnose_overrides to inspect persisted run and readiness signals while live status is unavailable.' },
          ],
        };
      }

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 1,
          truncated: capture.truncated ?? false,
        },
        statusSource: 'live',
        liveStatus: {
          available: true,
          command,
          timeoutMs,
        },
        preflight: getDb
          ? buildOverridePreflight({
              db: getDb(),
              sessionId,
              profileId: input.profileId,
              getSessionConnectionState,
            })
          : null,
        ...payload,
        nextActions: payload.lastErrorCode
          ? [{ code: 'DIAGNOSE_OVERRIDES', message: 'Run diagnose_overrides for the latest override failure.' }]
          : payload.active === true
            ? [{ code: 'GET_OVERRIDE_REQUEST_LOG', message: 'Inspect get_override_request_log after the target tab loads matching assets.' }]
            : [{ code: 'ENABLE_OVERRIDES', message: 'Enable overrides after validating the selected profile.' }],
      };
    },

    preflight_overrides: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }
      if (!getDb) {
        throw new Error('preflight_overrides requires database-backed override state');
      }

      return {
        ...createBaseResponse(sessionId),
        ...buildOverridePreflight({
          db: getDb(),
          sessionId,
          profileId: input.profileId,
          getSessionConnectionState,
        }),
      };
    },

    enable_overrides: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }
      const tabId = resolveOptionalTabId(input.tabId);
      let preflight = getDb
        ? buildOverridePreflight({
            db: getDb(),
            sessionId,
            profileId: input.profileId,
            getSessionConnectionState,
          })
        : null;
      let observedBeforeEnable: Record<string, unknown> | undefined;
      let observedAssetRefreshError: string | undefined;

      const initialBlockingCodes = getBlockingPreflightCodes(preflight);
      const initialProfile = isRecord(preflight?.profile) ? preflight.profile : {};
      const initialExperimentalBypass = canBypassPreflightForExperimentalRsc(initialProfile, initialBlockingCodes);

      if (preflight && getDb && !initialExperimentalBypass && shouldRefreshObservedAssetsForEnable(preflight)) {
        try {
          observedBeforeEnable = await refreshObservedAssetsForOverrideEnable({
            captureClient,
            db: getDb(),
            sessionId,
            tabId,
            getSessionConnectionState,
          });
          preflight = buildOverridePreflight({
            db: getDb(),
            sessionId,
            profileId: input.profileId,
            getSessionConnectionState,
          });
        } catch (error) {
          observedAssetRefreshError = error instanceof Error ? error.message : String(error);
        }
      }

      if (preflight && preflight.ready !== true) {
        const blockingCodes = getBlockingPreflightCodes(preflight);
        const profile = isRecord(preflight.profile) ? preflight.profile : {};
        if (!canBypassPreflightForExperimentalRsc(profile, blockingCodes)) {
          const refreshSuffix = observedAssetRefreshError
            ? `; observed asset refresh failed: ${observedAssetRefreshError}`
            : '';
          throw new Error(`Override preflight failed: ${blockingCodes.join(', ') || 'UNKNOWN'}${refreshSuffix}`);
        }
      }

      const command = 'CAPTURE_OVERRIDE_POC_ENABLE';
      const timeoutMs = 8_000;
      let capture: CaptureClientResult;
      let payload: Record<string, unknown>;
      try {
        capture = await executeLiveCapture(
          captureClient,
          sessionId,
          command,
          { tabId },
          timeoutMs,
        );
        payload = ensureCaptureSuccess(capture, sessionId);
      } catch (error) {
        throw createOverrideLiveCommandError({
          sessionId,
          command,
          timeoutMs,
          error,
          getSessionConnectionState,
        });
      }

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 1,
          truncated: capture.truncated ?? false,
        },
        preflight,
        observedBeforeEnable,
        ...payload,
        nextActions: [{ code: 'RELOAD_OR_INTERACT', message: 'Reload or interact with the tab so configured asset requests occur under the active override.' }],
      };
    },

    disable_overrides: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const command = 'CAPTURE_OVERRIDE_POC_DISABLE';
      const timeoutMs = 5_000;
      let capture: CaptureClientResult;
      let payload: Record<string, unknown>;
      try {
        capture = await executeLiveCapture(
          captureClient,
          sessionId,
          command,
          {},
          timeoutMs,
        );
        payload = ensureCaptureSuccess(capture, sessionId);
      } catch (error) {
        if (!getDb || !isRecoverableOverrideLiveCommandError(error)) {
          throw createOverrideLiveCommandError({
            sessionId,
            command,
            timeoutMs,
            error,
            getSessionConnectionState,
          });
        }

        const persisted = buildPersistedOverrideStatus({
          db: getDb(),
          sessionId,
          profileId: input.profileId,
          getSessionConnectionState,
        });
        const disableAttempt = buildOverrideLiveCommandFailure({
          sessionId,
          command,
          timeoutMs,
          error,
          getSessionConnectionState,
        });

        return {
          ...createBaseResponse(sessionId),
          limitsApplied: {
            maxResults: 1,
            truncated: false,
          },
          statusSource: 'persisted-audit',
          disableAttempt,
          ...persisted,
          nextActions: [
            { code: 'RECONNECT_OR_RETRY_DISABLE', message: 'Reconnect or rebind the top-level session, then retry disable_overrides to confirm debugger detachment.' },
            { code: 'GET_OVERRIDE_STATUS', message: 'Run get_override_status after reconnecting to verify whether the override is still active.' },
          ],
        };
      }

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 1,
          truncated: capture.truncated ?? false,
        },
        statusSource: 'live',
        disableAttempt: {
          ok: true,
          command,
          timeoutMs,
        },
        ...payload,
        nextActions: [{ code: 'VERIFY_DISABLED', message: 'Run get_override_status if you need to confirm the debugger override is inactive.' }],
      };
    },

    get_dom_subtree: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const selector = typeof input.selector === 'string' ? input.selector : '';
      if (!selector) {
        throw new Error('selector is required');
      }

      const maxDepth = resolveCaptureDepth(input.maxDepth, 3);
      const maxBytes = resolveCaptureBytes(input.maxBytes, 50_000);
      const capture = await executeLiveCapture(
        captureClient,
        sessionId,
        'CAPTURE_DOM_SUBTREE',
        { selector, maxDepth, maxBytes },
        4_000,
      );

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: maxBytes,
          truncated: capture.truncated ?? false,
        },
        ...ensureCaptureSuccess(capture, sessionId),
      };
    },

    get_dom_document: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const mode = input.mode === 'html' ? 'html' : 'outline';
      const maxBytes = resolveCaptureBytes(input.maxBytes, 200_000);
      const maxDepth = resolveCaptureDepth(input.maxDepth, 4);

      try {
        const capture = await executeLiveCapture(
          captureClient,
          sessionId,
          'CAPTURE_DOM_DOCUMENT',
          { mode, maxBytes, maxDepth },
          4_000,
        );

        return {
          ...createBaseResponse(sessionId),
          limitsApplied: {
            maxResults: maxBytes,
            truncated: capture.truncated ?? false,
          },
          ...ensureCaptureSuccess(capture, sessionId),
        };
      } catch (error) {
        const normalized = normalizeCaptureError(sessionId, error);
        if (mode !== 'html' || isLiveSessionDisconnectedError(normalized)) {
          throw normalized;
        }

        const fallback = await executeLiveCapture(
          captureClient,
          sessionId,
          'CAPTURE_DOM_DOCUMENT',
          { mode: 'outline', maxBytes, maxDepth },
          4_000,
        );

        return {
          ...createBaseResponse(sessionId),
          limitsApplied: {
            maxResults: maxBytes,
            truncated: true,
          },
          fallbackReason: 'timeout',
          ...ensureCaptureSuccess(fallback, sessionId),
        };
      }
    },

    get_computed_styles: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const selector = typeof input.selector === 'string' ? input.selector : '';
      if (!selector) {
        throw new Error('selector is required');
      }

      const properties = asStringArray(input.properties, 64);
      const frameId = typeof input.frameId === 'number' && Number.isFinite(input.frameId)
        ? Math.max(0, Math.floor(input.frameId))
        : 0;
      const capture = await executeLiveCapture(
        captureClient,
        sessionId,
        'CAPTURE_COMPUTED_STYLES',
        { selector, frameId, properties },
        3_000,
      );

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: properties.length || 8,
          truncated: capture.truncated ?? false,
        },
        ...ensureCaptureSuccess(capture, sessionId),
      };
    },

    get_layout_metrics: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const selector = typeof input.selector === 'string' ? input.selector : undefined;
      const frameId = typeof input.frameId === 'number' && Number.isFinite(input.frameId)
        ? Math.max(0, Math.floor(input.frameId))
        : 0;
      const capture = await executeLiveCapture(
        captureClient,
        sessionId,
        'CAPTURE_LAYOUT_METRICS',
        { selector, frameId },
        3_000,
      );

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 1,
          truncated: capture.truncated ?? false,
        },
        ...ensureCaptureSuccess(capture, sessionId),
      };
    },

    get_page_state: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const capture = await capturePageState(sessionId, input);

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: capture.limitsApplied,
        ...capture.payload,
      };
    },

    get_interactive_elements: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const kinds = resolveInteractiveKinds(input.kinds);
      const normalizedInput: ToolInput = {
        ...input,
        includeButtons: kinds.includes('buttons'),
        includeLinks: kinds.includes('links'),
        includeInputs: kinds.includes('inputs'),
        includeModals: kinds.includes('modals'),
      };
      const capture = await capturePageState(sessionId, normalizedInput);
      const refs = collectInteractiveElementRefs(capture.payload, kinds, capture.limitsApplied.maxResults);

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: capture.limitsApplied.maxResults,
          truncated: capture.limitsApplied.truncated || refs.length >= capture.limitsApplied.maxResults,
        },
        kinds,
        refs,
        page: {
          url: capture.payload.url,
          title: capture.payload.title,
          language: capture.payload.language,
          viewport: capture.payload.viewport,
        },
        pageSummary:
          typeof capture.payload.summary === 'object' && capture.payload.summary !== null
            ? capture.payload.summary
            : undefined,
      };
    },

    set_viewport: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const width = resolveViewportDimension(input.width, 'width');
      const height = resolveViewportDimension(input.height, 'height');
      const capture = await executeLiveCapture(
        captureClient,
        sessionId,
        'SET_VIEWPORT',
        {
          width,
          height,
        },
        5_000,
      );

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 1,
          truncated: capture.truncated ?? false,
        },
        ...ensureCaptureSuccess(capture, sessionId),
      };
    },

    assert_page_state: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const matcher = resolvePageStateMatcher(input);
      const capture = await capturePageState(sessionId, input);
      const assertion = evaluatePageStateAssertion(capture.payload, matcher);

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: capture.limitsApplied,
        matcher,
        matched: assertion.matched,
        matchCount: assertion.matchCount,
        expectedCount: assertion.expectedCount,
        sampledMatches: assertion.sampledMatches,
        pageSummary: assertion.summary,
        page: {
          url: capture.payload.url,
          title: capture.payload.title,
          language: capture.payload.language,
          viewport: capture.payload.viewport,
        },
      };
    },

    wait_for_page_state: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const waited = await waitForPageStateCondition(sessionId, input, capturePageState);
      return {
        ...createBaseResponse(sessionId),
        ...waited,
      };
    },

    preflight_automation_flow: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const preflight = await buildAutomationFlowPreflight({
        sessionId,
        input,
        capturePageState,
        getDb,
        getSessionConnectionState,
      });

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 1,
          truncated: false,
        },
        ...preflight,
      };
    },

    wait_for_url: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const wait = AutomationWaitUrlSchema.parse({ ...input, waitKind: 'url' });
      const waited = await waitForUrlCondition(sessionId, wait, capturePageState);
      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 1,
          truncated: false,
        },
        ...waited,
      };
    },

    wait_for_navigation: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }
      if (!getDb) {
        throw new Error('wait_for_navigation requires database access');
      }

      const wait = AutomationWaitNavigationSchema.parse({ ...input, waitKind: 'navigation' });
      const waited = await waitForNavigationCondition(sessionId, wait, getDb());
      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 10,
          truncated: false,
        },
        ...waited,
      };
    },

    wait_for_navigation_lifecycle: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const wait = AutomationWaitNavigationLifecycleSchema.parse({ ...input, waitKind: 'navigation_lifecycle' });
      const waited = await waitForNavigationLifecycleCondition(sessionId, wait, captureClient);
      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 1,
          truncated: false,
        },
        ...waited,
      };
    },

    wait_for_load_state: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const wait = AutomationWaitLoadStateSchema.parse({ ...input, waitKind: 'load_state' });
      const waited = await waitForLoadStateCondition(sessionId, wait, capturePageState);
      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 1,
          truncated: false,
        },
        ...waited,
      };
    },

    wait_for_selector_state: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const wait = AutomationWaitSelectorStateSchema.parse({ ...input, waitKind: 'selector_state' });
      const waited = await waitForSelectorStateCondition(sessionId, wait, captureClient);
      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 1,
          truncated: false,
        },
        ...waited,
      };
    },

    wait_for_request: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }
      if (!getDb) {
        throw new Error('wait_for_request requires database access');
      }

      const wait = AutomationWaitRequestSchema.parse({ ...input, waitKind: 'request' });
      const waited = await waitForNetworkMatchCondition(sessionId, wait, getDb());
      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 10,
          truncated: false,
        },
        ...waited,
      };
    },

    wait_for_response: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }
      if (!getDb) {
        throw new Error('wait_for_response requires database access');
      }

      const wait = AutomationWaitResponseSchema.parse({ ...input, waitKind: 'response' });
      const waited = await waitForNetworkMatchCondition(sessionId, wait, getDb());
      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 10,
          truncated: false,
        },
        ...waited,
      };
    },

    wait_for_console: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const wait = AutomationWaitConsoleSchema.parse({ ...input, waitKind: 'console' });
      const waited = await waitForConsoleCondition(sessionId, wait, captureClient);
      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 10,
          truncated: false,
        },
        ...waited,
      };
    },

    wait_for_dialog: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const wait = AutomationWaitDialogSchema.parse({ ...input, waitKind: 'dialog' });
      const waited = await waitForDialogCondition(sessionId, wait, captureClient);
      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 1,
          truncated: false,
        },
        ...waited,
      };
    },

    wait_for_stable_layout: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const wait = AutomationWaitStableLayoutSchema.parse({ ...input, waitKind: 'stable_layout' });
      const waited = await waitForStableLayoutCondition(sessionId, wait, captureClient);
      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 1,
          truncated: false,
        },
        ...waited,
      };
    },

    wait_for_download: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const wait = AutomationWaitDownloadSchema.parse({ ...input, waitKind: 'download' });
      const waited = await waitForDownloadCondition(sessionId, wait, captureClient);
      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 1,
          truncated: false,
        },
        ...waited,
      };
    },

    wait_for_popup: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const wait = AutomationWaitPopupSchema.parse({ ...input, waitKind: 'popup' });
      const waited = await waitForPopupCondition(sessionId, wait, captureClient);
      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 1,
          truncated: false,
        },
        ...waited,
      };
    },

    wait_for_network_quiet: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }
      if (!getDb) {
        throw new Error('wait_for_network_quiet requires database access');
      }

      const wait = AutomationWaitNetworkQuietSchema.parse({ ...input, waitKind: 'network_quiet' });
      const waited = await waitForNetworkQuietCondition(sessionId, wait, getDb());
      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 10,
          truncated: false,
        },
        ...waited,
      };
    },

    run_ui_steps: async (input) => {
      const request = RunUIStepsSchema.parse(input) as RunUIStepsRequest;
      const workflowTraceId = createUIWorkflowTraceId();
      const workflowStartedAt = Date.now();
      const stepResults: UIWorkflowStepResult[] = [];
      let lastPageCapture: PageStateCaptureResult | undefined;
      let failedStepId: string | undefined;
      let stoppedAtIndex = request.steps.length;
      let stateCaptureCount = 0;
      let failureCaptureCount = 0;
      let retryCount = 0;
      const workflowCapturePageState = async (sessionId: string, toolInput: ToolInput): Promise<PageStateCaptureResult> => {
        stateCaptureCount += 1;
        return capturePageState(sessionId, toolInput);
      };

      for (const [index, step] of request.steps.entries()) {
        const stepId = createWorkflowStepId(step, index);
        const failurePolicy = resolveWorkflowFailurePolicy(step, request.stopOnFailure);
        let executionAttempts = 0;
        let finalStepResult: UIWorkflowStepResult | undefined;
        let stepFailed = false;

        while (true) {
          executionAttempts += 1;
          const startedAt = Date.now();
          const previousCapture = lastPageCapture;

          try {
            if (step.kind === 'action') {
              const resolvedTarget = step.target?.locator
                ? {
                    target: step.target,
                    resolution: {
                      strategy: 'native_locator_pending',
                      matcher: summarizeWorkflowTargetMatcher(step.target),
                    },
                    pageCapture: undefined,
                  }
                : await resolveWorkflowActionTarget(
                  request.sessionId,
                  step.target,
                  workflowCapturePageState,
                  request.mode === 'fast' ? lastPageCapture : undefined,
                );
              const liveRequest = LiveUIActionRequestSchema.parse({
                action: step.action,
                target: resolvedTarget.target,
                traceId: step.traceId ?? `${workflowTraceId}:${stepId}`,
                ...(step.input ? { input: step.input } : {}),
              });
              const capture = await executeLiveCapture(
                captureClient,
                request.sessionId,
                'EXECUTE_UI_ACTION',
                liveRequest as unknown as Record<string, unknown>,
                5_000,
              );
              const payload = ensureCaptureSuccess(capture, request.sessionId);
              const actionResult = payload as LiveUIActionResult & Record<string, unknown>;
              const failed = actionResult.status === 'failed' || actionResult.status === 'rejected';
              const actionResultPayload = typeof actionResult.result === 'object' && actionResult.result !== null
                ? actionResult.result as Record<string, unknown>
                : undefined;
              const nativeLocatorResolution =
                typeof actionResultPayload?.locatorResolution === 'object' && actionResultPayload.locatorResolution !== null
                  ? actionResultPayload.locatorResolution as Record<string, unknown>
                  : undefined;
              let currentCapture = resolvedTarget.pageCapture ?? lastPageCapture;
              if (!failed && request.mode === 'fast') {
                await sleep(75);
                currentCapture = await captureWorkflowPageState(
                  request.sessionId,
                  workflowCapturePageState,
                  request.mode,
                );
              }
              lastPageCapture = currentCapture;

              finalStepResult = {
                id: stepId,
                kind: step.kind,
                status: failed ? 'failed' : 'succeeded',
                durationMs: Math.max(0, Date.now() - startedAt),
                action: step.action,
                traceId: actionResult.traceId,
                target: {
                  resolution: nativeLocatorResolution ?? resolvedTarget.resolution,
                  actionTarget:
                    typeof actionResult.target === 'object' && actionResult.target !== null
                      ? actionResult.target as Record<string, unknown>
                      : undefined,
                },
                error: failed && actionResult.failureReason
                  ? {
                      code: actionResult.failureReason.code,
                      message: actionResult.failureReason.message,
                    }
                  : undefined,
                pageChangeSummary: createPageChangeSummary(previousCapture, currentCapture),
              };
              if (failed && getDb && finalStepResult.traceId) {
                mergeAutomationDiagnosticsEvidence(getDb(), {
                  sessionId: request.sessionId,
                  traceId: finalStepResult.traceId,
                  failureEvidence: finalStepResult.failureEvidence,
                  cdpFailure: actionResult.failureReason as unknown as Record<string, unknown> | undefined,
                });
              }
            } else if (step.kind === 'waitFor') {
              const waitInput: ToolInput = {
                ...step.matcher,
                timeoutMs: step.matcher.timeoutMs ?? request.defaultTimeoutMs,
                pollIntervalMs: step.matcher.pollIntervalMs ?? request.defaultPollIntervalMs,
              };
              const waited = await waitForPageStateConditionDetailed(
                request.sessionId,
                waitInput,
                workflowCapturePageState,
                request.mode === 'fast' ? lastPageCapture : undefined,
              );
              lastPageCapture = waited.lastCapture ?? lastPageCapture;

              finalStepResult = {
                id: stepId,
                kind: step.kind,
                status: waited.matched ? 'succeeded' : 'failed',
                durationMs: Math.max(0, Date.now() - startedAt),
                matcher: waited.matcher as unknown as Record<string, unknown>,
                matchCount: waited.matchCount,
                waitedMs: waited.waitedMs,
                attempts: waited.attempts,
                error: waited.matched
                  ? undefined
                  : {
                      code: 'page_state_not_matched',
                      message: 'Workflow wait step timed out before the requested page state appeared.',
                    },
                pageChangeSummary: createPageChangeSummary(previousCapture, waited.lastCapture),
              };
            } else if (step.kind === 'wait') {
              const waitSpec = AutomationWaitSpecSchema.parse({
                ...step.wait,
                timeoutMs: step.wait.timeoutMs ?? request.defaultTimeoutMs,
                pollIntervalMs: step.wait.pollIntervalMs ?? request.defaultPollIntervalMs,
              });
              const waited = await runAutomationWait({
                sessionId: request.sessionId,
                wait: waitSpec,
                capturePageState: workflowCapturePageState,
                captureClient,
                getDb,
              });
              if (waited.waitKind === 'url' || waited.waitKind === 'navigation' || waited.waitKind === 'load_state') {
                lastPageCapture = await workflowCapturePageState(
                  request.sessionId,
                  {
                    includeButtons: true,
                    includeLinks: true,
                    includeInputs: true,
                    includeModals: true,
                    maxItems: request.mode === 'fast' ? 12 : 20,
                    maxTextLength: request.mode === 'fast' ? 60 : 80,
                  },
                ).catch(() => lastPageCapture);
              }

              finalStepResult = {
                id: stepId,
                kind: step.kind,
                status: waited.matched ? 'succeeded' : 'failed',
                durationMs: Math.max(0, Date.now() - startedAt),
                wait: {
                  ...(waitSpec as unknown as Record<string, unknown>),
                  waitKind: waited.waitKind,
                  matched: waited.matched,
                  timeoutMs: waited.timeoutMs,
                  pollIntervalMs: waited.pollIntervalMs,
                },
                waitedMs: waited.waitedMs,
                attempts: waited.attempts,
                error: waited.error,
                pageChangeSummary: createPageChangeSummary(previousCapture, lastPageCapture),
                target: waited.evidence,
              };
            } else {
              const capture = request.mode === 'fast' && lastPageCapture
                ? lastPageCapture
                : await workflowCapturePageState(request.sessionId, step.matcher);
              const assertion = evaluatePageStateAssertion(capture.payload, resolvePageStateMatcher(step.matcher as ToolInput));
              lastPageCapture = capture;

              finalStepResult = {
                id: stepId,
                kind: step.kind,
                status: assertion.matched ? 'succeeded' : 'failed',
                durationMs: Math.max(0, Date.now() - startedAt),
                matcher: step.matcher,
                matchCount: assertion.matchCount,
                error: assertion.matched
                  ? undefined
                  : {
                      code: 'page_state_assertion_failed',
                      message: 'Workflow assert step did not match the requested page state.',
                    },
                pageChangeSummary: createPageChangeSummary(previousCapture, capture),
              };
            }
          } catch (error) {
            const workflowError = error instanceof WorkflowTargetResolutionError ? error : undefined;
            finalStepResult = {
              id: stepId,
              kind: step.kind,
              status: 'failed',
              durationMs: Math.max(0, Date.now() - startedAt),
              action: step.kind === 'action' ? step.action : undefined,
              target:
                step.kind === 'action' && workflowError
                  ? workflowError.details
                  : undefined,
              matcher: step.kind === 'assert' || step.kind === 'waitFor' ? step.matcher : undefined,
              wait: step.kind === 'wait' ? step.wait as unknown as Record<string, unknown> : undefined,
              error: normalizeWorkflowError(error),
            };
          }

          stepFailed = finalStepResult.status === 'failed';
          if (stepFailed && failurePolicy.strategy === 'retry_once' && executionAttempts === 1) {
            retryCount += 1;
            await sleep(100);
            continue;
          }

          break;
        }

        finalStepResult.executionAttempts = executionAttempts;
        finalStepResult.failurePolicy = {
          strategy: failurePolicy.strategy,
          captureEnabled: Boolean(failurePolicy.captureOptions?.enabled),
        };
        finalStepResult.recommendedAction = resolveWorkflowRecommendedAction(finalStepResult.error);

        if (stepFailed && failurePolicy.captureOptions) {
          const evidence = await captureFailureSnapshot(
            captureClient,
            request.sessionId,
            resolveWorkflowFailureSelector(step, finalStepResult.target),
            failurePolicy.captureOptions,
          );
          if (evidence) {
            failureCaptureCount += 1;
            finalStepResult.failureEvidence = evidence;
            if (getDb && finalStepResult.traceId) {
              mergeAutomationDiagnosticsEvidence(getDb(), {
                sessionId: request.sessionId,
                traceId: finalStepResult.traceId,
                failureEvidence: evidence,
                cdpFailure: finalStepResult.error as unknown as Record<string, unknown> | undefined,
              });
            }
          }
        }

        stepResults.push(finalStepResult);

        if (stepFailed) {
          failedStepId ??= stepId;
          if (failurePolicy.strategy !== 'continue') {
            stoppedAtIndex = index + 1;
            break;
          }
        }
      }

      if (failedStepId && stoppedAtIndex < request.steps.length) {
        for (const [index, step] of request.steps.slice(stoppedAtIndex).entries()) {
          stepResults.push({
            id: createWorkflowStepId(step, stoppedAtIndex + index),
            kind: step.kind,
            status: 'skipped',
            durationMs: 0,
            action: step.kind === 'action' ? step.action : undefined,
            matcher: step.kind === 'assert' || step.kind === 'waitFor' ? step.matcher : undefined,
            wait: step.kind === 'wait' ? step.wait as unknown as Record<string, unknown> : undefined,
            pageChangeSummary: undefined,
            error: {
              code: 'workflow_stopped_early',
              message: `Skipped because workflow stopped after failed step "${failedStepId}".`,
            },
          });
        }
      }

      let finalPageSummary: Record<string, unknown> | undefined;
      let finalPage:
        | {
          url: unknown;
          title: unknown;
          language: unknown;
          viewport: unknown;
        }
        | undefined;
      let finalCaptureTruncated = false;
      try {
        const finalCapture = lastPageCapture ?? await captureWorkflowPageState(
          request.sessionId,
          workflowCapturePageState,
          request.mode,
        );
        finalPageSummary =
          typeof finalCapture.payload.summary === 'object' && finalCapture.payload.summary !== null
            ? finalCapture.payload.summary as Record<string, unknown>
            : undefined;
        finalPage = {
          url: finalCapture.payload.url,
          title: finalCapture.payload.title,
          language: finalCapture.payload.language,
          viewport: finalCapture.payload.viewport,
        };
        finalCaptureTruncated = finalCapture.limitsApplied.truncated;
      } catch {
        finalPageSummary = undefined;
        finalPage = undefined;
      }
      const workflowFinishedAt = Date.now();
      const succeededSteps = stepResults.filter((step) => step.status === 'succeeded').length;
      const failedSteps = stepResults.filter((step) => step.status === 'failed').length;
      const skippedSteps = stepResults.filter((step) => step.status === 'skipped').length;
      const failedStep = failedStepId
        ? stepResults.find((step) => step.id === failedStepId && step.status === 'failed')
        : undefined;

      return {
        ...createBaseResponse(request.sessionId),
        limitsApplied: {
          maxResults: request.steps.length,
          truncated: finalCaptureTruncated,
        },
        traceId: workflowTraceId,
        mode: request.mode,
        status: failedStepId ? 'failed' : 'succeeded',
        startedAt: workflowStartedAt,
        finishedAt: workflowFinishedAt,
        durationMs: Math.max(0, workflowFinishedAt - workflowStartedAt),
        requestedStepCount: request.steps.length,
        completedStepCount: succeededSteps,
        failedStepId,
        stoppedEarly: Boolean(failedStepId && stoppedAtIndex < request.steps.length),
        recommendedAction: failedStep?.recommendedAction,
        stepCounts: {
          succeeded: succeededSteps,
          failed: failedSteps,
          skipped: skippedSteps,
        },
        workflowDiagnostics: {
          retryCount,
          stateCaptureCount,
          failureCaptureCount,
          usedCachedState: request.mode === 'fast',
        },
        steps: stepResults,
        finalPageSummary,
        finalPage,
      };
    },

    capture_ui_snapshot: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const trigger =
        input.trigger === 'click' || input.trigger === 'manual' || input.trigger === 'navigation' || input.trigger === 'error'
          ? input.trigger
          : 'manual';
      const mode = input.mode === 'dom' || input.mode === 'png' || input.mode === 'both' ? input.mode : 'dom';
      const styleMode = input.styleMode === 'computed-full' || input.styleMode === 'computed-lite'
        ? input.styleMode
        : 'computed-lite';
      const explicitStyleMode = input.styleMode === 'computed-full' || input.styleMode === 'computed-lite';
      const selector = typeof input.selector === 'string' && input.selector.trim().length > 0
        ? input.selector.trim()
        : undefined;
      const maxDepth = resolveCaptureDepth(input.maxDepth, 3);
      const maxBytes = resolveCaptureBytes(input.maxBytes, 50_000);
      const maxAncestors = resolveCaptureAncestors(input.maxAncestors, 4);
      const includeDom = typeof input.includeDom === 'boolean' ? input.includeDom : mode !== 'png';
      const includeStyles = typeof input.includeStyles === 'boolean' ? input.includeStyles : mode !== 'png';
      const includePngDataUrl = typeof input.includePngDataUrl === 'boolean' ? input.includePngDataUrl : mode !== 'png';

      const capture = await executeLiveCapture(
        captureClient,
        sessionId,
        'CAPTURE_UI_SNAPSHOT',
        {
          selector,
          trigger,
          mode,
          styleMode,
          explicitStyleMode,
          maxDepth,
          maxBytes,
          maxAncestors,
          includeDom,
          includeStyles,
          includePngDataUrl,
          llmRequested: true,
        },
        5_000,
      );

      const payload = ensureCaptureSuccess(capture, sessionId);
      const snapshotRecord = normalizeSnapshotResponsePayload(payload, {
        includeDom,
        includeStyles,
        includePngDataUrl,
      });

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: maxBytes,
          truncated: capture.truncated ?? false,
        },
        includeDom,
        includeStyles,
        includePngDataUrl,
        ...snapshotRecord,
      };
    },

    get_live_console_logs: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const origin = normalizeRequestedOrigin(input.url);
      const tabId = resolveOptionalTabId(input.tabId);
      const levels = resolveLiveConsoleLevels(input.levels);
      const contains = typeof input.contains === 'string' && input.contains.trim().length > 0
        ? input.contains.trim()
        : undefined;
      const sinceTs = resolveOptionalTimestamp(input.sinceTs);
      const includeRuntimeErrors = input.includeRuntimeErrors !== false;
      const limit = resolveLimit(input.limit, DEFAULT_EVENT_LIMIT);
      const responseProfile = resolveResponseProfile(input.responseProfile);
      const includeArgs = responseProfile === 'compact' && input.includeArgs === true;
      const maxResponseBytes = resolveMaxResponseBytes(input.maxResponseBytes);
      const dedupeWindowMs = resolveDurationMs(input.dedupeWindowMs, 0, 60_000);
      const capture = await executeLiveCapture(
        captureClient,
        sessionId,
        'CAPTURE_GET_LIVE_CONSOLE_LOGS',
        {
          origin,
          tabId,
          levels,
          contains,
          sinceTs,
          includeRuntimeErrors,
          dedupeWindowMs,
          limit,
        },
        3_000,
      );

      const payload = ensureCaptureSuccess(capture, sessionId);
      const rawLogs = asRecordArray(payload.logs);
      const logs = rawLogs.map((entry) => mapLiveConsoleLogRecord(entry, responseProfile, { includeArgs }));
      const bytePage = applyByteBudget(logs, maxResponseBytes);
      const truncated = (capture.truncated ?? false) || bytePage.truncatedByBytes;
      const paginationRecord =
        typeof payload.pagination === 'object' && payload.pagination !== null
          ? payload.pagination as Record<string, unknown>
          : {};
      const matched = typeof paginationRecord.matched === 'number'
        ? Math.max(0, Math.floor(paginationRecord.matched))
        : rawLogs.length;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: limit,
          truncated,
        },
        responseProfile,
        responseBytes: bytePage.responseBytes,
        logs: bytePage.items,
        pagination: {
          returned: bytePage.items.length,
          matched,
          hasMore: truncated,
          maxResponseBytes,
        },
        filtersApplied:
          typeof payload.filtersApplied === 'object' && payload.filtersApplied !== null
            ? payload.filtersApplied
            : {
              tabId,
              origin,
              levels,
              contains,
              sinceTs,
              includeRuntimeErrors,
              dedupeWindowMs,
            },
        bufferStats: payload.bufferStats,
      };
    },

    execute_ui_action: async (input) => {
      const sessionId = getSessionId(input);
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const actionInput: Record<string, unknown> = { ...input };
      delete actionInput.sessionId;
      delete actionInput.captureOnFailure;

      let request = LiveUIActionRequestSchema.parse(actionInput);
      let targetResolution: Record<string, unknown> | undefined;
      try {
        if (request.target?.locator) {
          targetResolution = {
            strategy: 'native_locator_pending',
            matcher: summarizeWorkflowTargetMatcher(request.target as UIWorkflowActionTarget),
          };
        } else if (hasSemanticActionTargetMatcher(request.target)) {
          const resolvedTarget = await resolveWorkflowActionTarget(
            sessionId,
            request.target as UIWorkflowActionTarget,
            capturePageState,
          );
          targetResolution = resolvedTarget.resolution;
          request = LiveUIActionRequestSchema.parse({
            ...request,
            target: resolvedTarget.target,
          });
        }
      } catch (error) {
        if (error instanceof WorkflowTargetResolutionError) {
          const traceId = request.traceId ?? `uiaction-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
          return {
            ...createBaseResponse(sessionId),
            limitsApplied: {
              maxResults: 1,
              truncated: false,
            },
            action: request.action,
            status: 'rejected',
            traceId,
            startedAt: Date.now(),
            finishedAt: Date.now(),
            durationMs: 0,
            target: {
              matched: false,
            },
            tabContext: {
              frameId: 0,
            },
            failureDetails: {
              code: error.code,
              message: error.message,
            },
            targetResolution: {
              ...error.details,
              strategy: 'semantic_failed',
            },
            supportedScopes: {
              executionScope: 'top-document-v1',
              topDocumentOnly: false,
              opensNewBrowserSession: false,
            },
          };
        }
        throw error;
      }
      const failureCaptureOptions = resolveFailureEvidenceCaptureOptions(input);
      const capture = await executeLiveCapture(
        captureClient,
        sessionId,
        'EXECUTE_UI_ACTION',
        request as unknown as Record<string, unknown>,
        5_000,
      );
      const payload = ensureCaptureSuccess(capture, sessionId);
      const actionResult = payload as LiveUIActionResult & Record<string, unknown>;
      const failed = actionResult.status === 'failed' || actionResult.status === 'rejected';
      const failureEvidence = failed
        ? await captureFailureEvidence(captureClient, sessionId, request, failureCaptureOptions)
        : undefined;
      const postActionWaitInput =
        typeof input.waitForPageState === 'object' && input.waitForPageState !== null
          ? {
              ...input.waitForPageState as Record<string, unknown>,
            }
          : undefined;
      const postActionState =
        actionResult.status === 'succeeded' && postActionWaitInput
          ? await waitForPageStateCondition(sessionId, postActionWaitInput, capturePageState)
          : undefined;
      const evidenceTruncated = Boolean(
        failureEvidence
        && typeof failureEvidence === 'object'
        && failureEvidence !== null
        && typeof (failureEvidence as { limitsApplied?: { truncated?: unknown } }).limitsApplied?.truncated === 'boolean'
        && (failureEvidence as { limitsApplied: { truncated: boolean } }).limitsApplied.truncated,
      );
      const target = typeof actionResult.target === 'object' && actionResult.target !== null
        ? actionResult.target as Record<string, unknown>
        : {};
      const actionResultRecord = actionResult as Record<string, unknown>;
      const nativeResult = typeof actionResultRecord.result === 'object' && actionResultRecord.result !== null
        ? actionResultRecord.result as Record<string, unknown>
        : undefined;
      const nativeLocatorResolution = typeof nativeResult?.locatorResolution === 'object' && nativeResult.locatorResolution !== null
        ? nativeResult.locatorResolution as Record<string, unknown>
        : undefined;
      if (nativeLocatorResolution) {
        targetResolution = nativeLocatorResolution;
      }
      if (failed && getDb && actionResult.traceId) {
        mergeAutomationDiagnosticsEvidence(getDb(), {
          sessionId,
          traceId: actionResult.traceId,
          failureEvidence,
          cdpFailure: actionResult.failureReason as unknown as Record<string, unknown> | undefined,
        });
      }

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 1,
          truncated:
            (capture.truncated ?? false)
            || evidenceTruncated
            || Boolean(postActionState?.limitsApplied.truncated),
        },
        action: actionResult.action,
        status: actionResult.status,
        traceId: actionResult.traceId,
        startedAt: actionResult.startedAt,
        finishedAt: actionResult.finishedAt,
        durationMs:
          typeof actionResult.startedAt === 'number' && typeof actionResult.finishedAt === 'number'
            ? Math.max(0, actionResult.finishedAt - actionResult.startedAt)
            : undefined,
        actionResult,
        target,
        targetResolution,
        tabContext: {
          tabId: typeof target.tabId === 'number' ? target.tabId : undefined,
          frameId: typeof target.frameId === 'number' ? target.frameId : 0,
          url: typeof target.url === 'string' ? target.url : undefined,
        },
        failureDetails: actionResult.failureReason,
        postActionEvidence: failureEvidence,
        postActionState,
        supportedScopes: {
          executionScope: actionResult.executionScope,
          topDocumentOnly: false,
          opensNewBrowserSession: false,
        },
      };
    },
  };
}

function isRecord(value: unknown): value is ToolInput {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getSessionId(input: ToolInput): string | undefined {
  return typeof input.sessionId === 'string' ? input.sessionId : undefined;
}

function createBaseResponse(sessionId?: string): BaseToolResponse {
  return {
    sessionId,
    limitsApplied: {
      maxResults: 0,
      truncated: false,
    },
    redactionSummary: DEFAULT_REDACTION_SUMMARY,
  };
}

function createDefaultHandler(toolName: string): ToolHandler {
  return async (input) => {
    return {
      ...createBaseResponse(getSessionId(input)),
      tool: toolName,
      status: 'not_implemented',
    };
  };
}

function attachResponseBytes(response: ToolResponse): ToolResponse {
  if (typeof response.responseBytes === 'number' && Number.isFinite(response.responseBytes)) {
    return response;
  }

  return {
    ...response,
    responseBytes: estimateJsonBytes(response),
  };
}

export function createToolRegistry(overrides: Partial<Record<string, ToolHandler>> = {}): RegisteredTool[] {
  return ALL_TOOLS.map((toolName) => {
    const schema = TOOL_SCHEMAS[toolName] ?? { type: 'object', properties: {} };

    return {
      name: toolName,
      description: TOOL_DESCRIPTIONS[toolName] ?? `Execute ${toolName}`,
      inputSchema: schema,
      handler: overrides[toolName] ?? createDefaultHandler(toolName),
    };
  });
}

export async function routeToolCall(
  tools: RegisteredTool[],
  toolName: string,
  input: unknown,
  options: { loopGuard?: ToolLoopGuard } = {},
): Promise<ToolResponse> {
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (!tool) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  const normalizedInput = isRecord(input) ? input : {};
  const guardCall = options.loopGuard?.prepareCall(toolName, normalizedInput);
  const beforeCall = guardCall ? await options.loopGuard?.beforeCall(guardCall) : undefined;
  if (beforeCall?.blocked) {
    return attachResponseBytes(beforeCall.response as ToolResponse);
  }

  const startedAt = Date.now();
  try {
    const response = await tool.handler(normalizedInput);
    const guarded = guardCall
      ? await options.loopGuard?.afterCall(guardCall, {
          response,
          durationMs: Date.now() - startedAt,
        })
      : undefined;
    return attachResponseBytes((guarded?.response ?? response) as ToolResponse);
  } catch (error) {
    if (guardCall) {
      await options.loopGuard?.afterCall(guardCall, {
        error,
        durationMs: Date.now() - startedAt,
      });
    }
    throw error;
  }
}

export function createMCPServer(
  overrides: Partial<Record<string, ToolHandler>> = {},
  options: MCPServerOptions = {},
): MCPServerRuntime {
  const logger = options.logger ?? createDefaultMcpLogger();
  const v2Handlers = options.captureClient
    ? createV2ToolHandlers(options.captureClient, () => getConnection().db, options.getSessionConnectionState)
    : {};
  const tools = createToolRegistry({
    ...createV1ToolHandlers(() => getConnection().db, options.getSessionConnectionState),
    ...v2Handlers,
    ...overrides,
  });
  const loopGuard = options.loopGuard === false
    ? undefined
    : options.loopGuard ?? createToolLoopGuard({
        getDb: () => getConnection().db,
        onEvent: (event) => {
          logger.info(
            {
              component: 'mcp',
              ...event,
            },
            `[MCPServer][MCP] ${event.event}`,
          );
        },
      });
  const server = new Server(
    {
      name: 'browser-debug-mcp-bridge',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logger.debug({ component: 'mcp', event: 'list_tools' }, '[MCPServer][MCP] list_tools request');
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const startedAt = Date.now();

    logger.info(
      { component: 'mcp', event: 'tool_call_started', toolName },
      '[MCPServer][MCP] Tool call started',
    );

    try {
      const response = await routeToolCall(tools, toolName, request.params.arguments, { loopGuard });
      logger.info(
        {
          component: 'mcp',
          event: 'tool_call_completed',
          toolName,
          durationMs: Date.now() - startedAt,
        },
        '[MCPServer][MCP] Tool call completed',
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown MCP tool error';
      logger.error(
        {
          component: 'mcp',
          event: 'tool_call_failed',
          toolName,
          durationMs: Date.now() - startedAt,
          error: message,
        },
        '[MCPServer][MCP] Tool call failed',
      );
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: message,
          },
        ],
      };
    }
  });

  const transport = new StdioServerTransport();

  return {
    server,
    transport,
    tools,
    start: async () => {
      await server.connect(transport);
    },
  };
}

export { createBaseResponse };
