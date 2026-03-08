import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Database } from 'better-sqlite3';
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { z } from 'zod';
import { getConnection } from '../db/connection.js';

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

const LiveUIActionTargetSchema = z.object({
  selector: z.string().min(1).optional(),
  elementRef: z.string().min(1).optional(),
  tabId: z.number().int().min(0).optional(),
  frameId: z.number().int().min(0).optional(),
  url: z.string().url().optional(),
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
const UIWorkflowActionTargetScopeSchema = z.enum(['buttons', 'inputs', 'modals', 'focused']);

const UIWorkflowActionTargetSchema = z.object({
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

const UIWorkflowStepSchema = z.discriminatedUnion('kind', [
  UIWorkflowActionStepSchema,
  UIWorkflowWaitForStepSchema,
  UIWorkflowAssertStepSchema,
]);

const RunUIStepsSchema = z.object({
  sessionId: z.string().min(1),
  mode: UIWorkflowModeSchema.default('safe'),
  stopOnFailure: z.boolean().default(true),
  defaultTimeoutMs: z.number().int().min(100).max(30000).optional(),
  defaultPollIntervalMs: z.number().int().min(50).max(2000).optional(),
  steps: z.array(UIWorkflowStepSchema).min(1).max(50),
});

type UIWorkflowActionTarget = z.infer<typeof UIWorkflowActionTargetSchema>;
type UIWorkflowActionStep = z.infer<typeof UIWorkflowActionStepSchema>;
type UIWorkflowStep = z.infer<typeof UIWorkflowStepSchema>;
type RunUIStepsRequest = z.infer<typeof RunUIStepsSchema>;

function createUIWorkflowTraceId(): string {
  return `uiworkflow-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

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
      properties: { type: 'array', items: { type: 'string' } },
    },
  },
  get_layout_metrics: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      selector: { type: 'string' },
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
        items: { type: 'string', enum: ['buttons', 'inputs', 'modals', 'focused'] },
      },
      maxItems: { type: 'number' },
      maxTextLength: { type: 'number' },
    },
  },
  get_live_session_health: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
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
      scope: { type: 'string', enum: ['buttons', 'inputs', 'modals', 'focused', 'page'] },
      selector: { type: 'string' },
      testId: { type: 'string' },
      textContains: { type: 'string' },
      labelContains: { type: 'string' },
      titleContains: { type: 'string' },
      urlContains: { type: 'string' },
      language: { type: 'string' },
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
      scope: { type: 'string', enum: ['buttons', 'inputs', 'modals', 'focused', 'page'] },
      selector: { type: 'string' },
      testId: { type: 'string' },
      textContains: { type: 'string' },
      labelContains: { type: 'string' },
      titleContains: { type: 'string' },
      urlContains: { type: 'string' },
      language: { type: 'string' },
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
  list_automation_runs: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string' },
      status: { type: 'string', enum: ['requested', 'started', 'succeeded', 'failed', 'rejected', 'stopped'] },
      action: { type: 'string', enum: ['click', 'input', 'focus', 'blur', 'scroll', 'press_key', 'submit', 'reload'] },
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
      action: { type: 'string', enum: ['click', 'input', 'focus', 'blur', 'scroll', 'press_key', 'submit', 'reload'] },
      traceId: { type: 'string' },
      target: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          elementRef: { type: 'string' },
          tabId: { type: 'number' },
          frameId: { type: 'number' },
          url: { type: 'string' },
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
          scope: { type: 'string', enum: ['buttons', 'inputs', 'modals', 'focused', 'page'] },
          selector: { type: 'string' },
          testId: { type: 'string' },
          textContains: { type: 'string' },
          labelContains: { type: 'string' },
          titleContains: { type: 'string' },
          urlContains: { type: 'string' },
          language: { type: 'string' },
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
            kind: { type: 'string', enum: ['action', 'waitFor', 'assert'] },
            action: { type: 'string' },
            traceId: { type: 'string' },
            target: {
              type: 'object',
              properties: {
                selector: { type: 'string' },
                elementRef: { type: 'string' },
                tabId: { type: 'number' },
                frameId: { type: 'number' },
                url: { type: 'string' },
                testId: { type: 'string' },
                scope: { type: 'string', enum: ['buttons', 'inputs', 'modals', 'focused'] },
                textContains: { type: 'string' },
                labelContains: { type: 'string' },
                titleContains: { type: 'string' },
                tagName: { type: 'string' },
                type: { type: 'string' },
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
                scope: { type: 'string', enum: ['buttons', 'inputs', 'modals', 'focused', 'page'] },
                selector: { type: 'string' },
                testId: { type: 'string' },
                textContains: { type: 'string' },
                labelContains: { type: 'string' },
                titleContains: { type: 'string' },
                urlContains: { type: 'string' },
                language: { type: 'string' },
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
  get_interactive_elements: 'Read compact live element references for buttons, inputs, modals, and focused elements',
  get_live_session_health: 'Read live transport health and session binding details for one session',
  set_viewport: 'Resize the live browser window for a session and return the resulting viewport metrics',
  assert_page_state: 'Assert compact page-state conditions without pulling raw DOM payloads',
  wait_for_page_state: 'Poll compact page state until a structured assertion becomes true',
  capture_ui_snapshot: 'Capture redacted UI snapshot (DOM/styles/optional PNG) and persist it',
  get_live_console_logs: 'Read in-memory live console logs for a connected session',
  explain_last_failure: 'Explain the latest failure timeline',
  get_event_correlation: 'Correlate related events by window',
  list_snapshots: 'List snapshot metadata by session/time/trigger',
  get_snapshot_for_event: 'Find snapshot most related to an event',
  get_snapshot_asset: 'Read bounded binary chunks for snapshot assets',
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
const LIVE_SESSION_DISCONNECTED_CODE = 'LIVE_SESSION_DISCONNECTED';
const NETWORK_CALL_SELECT_COLUMNS = `
  request_id, session_id, trace_id, tab_id, ts_start, duration_ms, method, url, origin, status, initiator, error_class, response_size_est,
  request_content_type, request_body_text, request_body_json, request_body_bytes, request_body_truncated, request_body_chunk_ref,
  response_content_type, response_body_text, response_body_json, response_body_bytes, response_body_truncated, response_body_chunk_ref
`;

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

export interface CaptureCommandClient {
  execute(
    sessionId: string,
    command:
      | 'CAPTURE_DOM_SUBTREE'
      | 'CAPTURE_DOM_DOCUMENT'
      | 'CAPTURE_COMPUTED_STYLES'
      | 'CAPTURE_LAYOUT_METRICS'
      | 'CAPTURE_PAGE_STATE'
      | 'CAPTURE_UI_SNAPSHOT'
      | 'CAPTURE_GET_LIVE_CONSOLE_LOGS'
      | 'SET_VIEWPORT'
      | 'EXECUTE_UI_ACTION',
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

type PageStateScope = 'buttons' | 'inputs' | 'modals' | 'focused' | 'page';

interface PageStateMatcher {
  scope: PageStateScope;
  selector?: string;
  testId?: string;
  textContains?: string;
  labelContains?: string;
  titleContains?: string;
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

type PageStateCaptureResult = {
  limitsApplied: { maxResults: number; truncated: boolean };
  payload: Record<string, unknown>;
};

interface DetailedPageStateWaitResult extends PageStateWaitResult {
  lastCapture?: PageStateCaptureResult;
}

class WorkflowTargetResolutionError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown>) {
    super(message);
    this.name = 'WorkflowTargetResolutionError';
    this.code = code;
    this.details = details;
  }
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
  if (value === 'buttons' || value === 'inputs' || value === 'modals' || value === 'focused' || value === 'page') {
    return value;
  }

  throw new Error('scope must be one of buttons, inputs, modals, focused, or page');
}

function resolvePageStateMatcher(input: ToolInput): PageStateMatcher {
  const matcher: PageStateMatcher = {
    scope: resolvePageStateScope(input.scope),
    selector: resolveOptionalMatcherString(input.selector),
    testId: resolveOptionalMatcherString(input.testId),
    textContains: resolveOptionalMatcherString(input.textContains),
    labelContains: resolveOptionalMatcherString(input.labelContains),
    titleContains: resolveOptionalMatcherString(input.titleContains),
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
  if (scope === 'buttons' || scope === 'inputs' || scope === 'modals') {
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
    && includesNormalized(item.text, matcher.textContains)
    && includesNormalized(item.label, matcher.labelContains)
    && includesNormalized(item.title, matcher.titleContains)
    && includesNormalized(item.url, matcher.urlContains)
    && equalsNormalized(item.language, matcher.language)
    && equalsNormalized(item.tagName, matcher.tagName)
    && equalsNormalized(item.type, matcher.type)
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

  for (const key of ['buttons', 'inputs', 'modals']) {
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

function resolveInteractiveKinds(value: unknown): Array<'buttons' | 'inputs' | 'modals' | 'focused'> {
  if (!Array.isArray(value) || value.length === 0) {
    return ['buttons', 'inputs', 'modals', 'focused'];
  }

  const allowed = new Set(['buttons', 'inputs', 'modals', 'focused']);
  const kinds = value
    .filter((entry): entry is string => typeof entry === 'string' && allowed.has(entry))
    .map((entry) => entry as 'buttons' | 'inputs' | 'modals' | 'focused');

  return kinds.length > 0 ? Array.from(new Set(kinds)) : ['buttons', 'inputs', 'modals', 'focused'];
}

function collectInteractiveElementRefs(
  payload: Record<string, unknown>,
  kinds: Array<'buttons' | 'inputs' | 'modals' | 'focused'>,
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

function candidateTextForWorkflowTarget(item: Record<string, unknown>): string {
  return [item.text, item.label, item.title]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .trim();
}

function describeWorkflowTargetCandidate(item: Record<string, unknown>): Record<string, unknown> {
  return {
    text: candidateTextForWorkflowTarget(item) || undefined,
    testId: typeof item.testId === 'string' ? item.testId : undefined,
    selector: typeof item.selector === 'string' ? item.selector : undefined,
    tagName: typeof item.tagName === 'string' ? item.tagName : undefined,
    type: typeof item.type === 'string' ? item.type : undefined,
    disabled: typeof item.disabled === 'boolean' ? item.disabled : undefined,
    selected: typeof item.selected === 'boolean' ? item.selected : undefined,
  };
}

function pickWorkflowTargetItems(
  payload: Record<string, unknown>,
  scope: UIWorkflowActionTarget['scope'],
): Record<string, unknown>[] {
  if (scope) {
    return pickPageStateScopeItems(payload, scope);
  }

  return [
    ...pickPageStateScopeItems(payload, 'buttons'),
    ...pickPageStateScopeItems(payload, 'inputs'),
    ...pickPageStateScopeItems(payload, 'modals'),
    ...pickPageStateScopeItems(payload, 'focused'),
  ];
}

function matchesWorkflowActionTarget(
  item: Record<string, unknown>,
  target: UIWorkflowActionTarget,
): boolean {
  return (
    equalsNormalized(item.testId, target.testId)
    && includesNormalized(item.text, target.textContains)
    && includesNormalized(item.label, target.labelContains)
    && includesNormalized(item.title, target.titleContains)
    && equalsNormalized(item.tagName, target.tagName)
    && equalsNormalized(item.type, target.type)
    && equalsOptionalBoolean(item.disabled, target.disabled)
    && equalsOptionalBoolean(item.selected, target.selected)
    && equalsOptionalBoolean(item.pressed, target.pressed)
    && equalsOptionalBoolean(item.expanded, target.expanded)
    && equalsOptionalBoolean(item.readOnly, target.readOnly)
    && equalsOptionalBoolean(item.required, target.requiredField)
    && (typeof item.elementRef === 'string' || typeof item.selector === 'string')
  );
}

function summarizeWorkflowTargetMatcher(target: UIWorkflowActionTarget): Record<string, unknown> {
  return {
    scope: target.scope,
    selector: target.selector,
    elementRef: target.elementRef,
    testId: target.testId,
    textContains: target.textContains,
    labelContains: target.labelContains,
    titleContains: target.titleContains,
    tagName: target.tagName,
    type: target.type,
    disabled: target.disabled,
    selected: target.selected,
    pressed: target.pressed,
    expanded: target.expanded,
    readOnly: target.readOnly,
    requiredField: target.requiredField,
  };
}

async function resolveWorkflowActionTarget(
  sessionId: string,
  target: UIWorkflowActionTarget | undefined,
  capturePageState: (
    sessionId: string,
    input: ToolInput,
  ) => Promise<PageStateCaptureResult>,
  existingCapture?: PageStateCaptureResult,
): Promise<{
  target?: z.infer<typeof LiveUIActionTargetSchema>;
  resolution: Record<string, unknown>;
  pageCapture?: PageStateCaptureResult;
}> {
  if (!target) {
    return {
      resolution: {
        strategy: 'none',
      },
    };
  }

  if (target.elementRef || target.selector) {
    return {
      target: {
        elementRef: target.elementRef,
        selector: target.selector,
        tabId: target.tabId,
        frameId: target.frameId,
        url: target.url,
      },
      resolution: {
        strategy: target.elementRef ? 'elementRef' : 'selector',
        matcher: summarizeWorkflowTargetMatcher(target),
      },
    };
  }

  const capture = existingCapture ?? await capturePageState(sessionId, {
    includeButtons: target.scope ? target.scope === 'buttons' : true,
    includeInputs: target.scope ? target.scope === 'inputs' : true,
    includeModals: target.scope ? target.scope === 'modals' : true,
    maxItems: 100,
    maxTextLength: 120,
  });
  const candidates = pickWorkflowTargetItems(capture.payload, target.scope)
    .filter((item) => matchesWorkflowActionTarget(item, target));

  if (candidates.length === 0) {
    throw new WorkflowTargetResolutionError(
      'workflow_target_not_found',
      'No interactive element matched the workflow target.',
      {
        matcher: summarizeWorkflowTargetMatcher(target),
        searchedScope: target.scope ?? 'all-interactive',
        sampledCandidates: pickWorkflowTargetItems(capture.payload, target.scope)
          .slice(0, 5)
          .map((item) => describeWorkflowTargetCandidate(item)),
      },
    );
  }

  if (candidates.length > 1) {
    throw new WorkflowTargetResolutionError(
      'workflow_target_ambiguous',
      `Workflow target matched ${candidates.length} elements; refine the matcher.`,
      {
        matcher: summarizeWorkflowTargetMatcher(target),
        matchedCandidateCount: candidates.length,
        sampledCandidates: candidates.slice(0, 5).map((item) => describeWorkflowTargetCandidate(item)),
      },
    );
  }

  const candidate = candidates[0];
    return {
      target: {
        elementRef: typeof candidate.elementRef === 'string' ? candidate.elementRef : undefined,
      selector: typeof candidate.selector === 'string' ? candidate.selector : undefined,
      tabId: target.tabId,
      frameId: target.frameId,
      url: target.url,
    },
      resolution: {
        strategy: typeof candidate.elementRef === 'string' ? 'semantic_elementRef' : 'semantic_selector',
        matcher: summarizeWorkflowTargetMatcher(target),
        matchedCandidateCount: candidates.length,
        matched: describeWorkflowTargetCandidate(candidate),
      },
      pageCapture: capture,
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

function isLiveSessionDisconnectedError(error: unknown): error is LiveSessionDisconnectedError {
  return error instanceof LiveSessionDisconnectedError;
}

async function executeLiveCapture(
  captureClient: CaptureCommandClient,
  sessionId: string,
  command:
    | 'CAPTURE_DOM_SUBTREE'
    | 'CAPTURE_DOM_DOCUMENT'
    | 'CAPTURE_COMPUTED_STYLES'
    | 'CAPTURE_LAYOUT_METRICS'
    | 'CAPTURE_PAGE_STATE'
    | 'CAPTURE_UI_SNAPSHOT'
    | 'CAPTURE_GET_LIVE_CONSOLE_LOGS'
    | 'SET_VIEWPORT'
    | 'EXECUTE_UI_ACTION',
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<CaptureClientResult> {
  try {
    return await captureClient.execute(sessionId, command, payload, timeoutMs);
  } catch (error) {
    throw normalizeCaptureError(sessionId, error);
  }
}

function ensureCaptureSuccess(result: CaptureClientResult, sessionId: string): Record<string, unknown> {
  if (!result.ok) {
    throw normalizeCaptureError(sessionId, new Error(result.error ?? 'Capture command failed'));
  }

  return result.payload ?? {};
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
        where.push('created_at >= ?');
        params.push(Date.now() - Math.floor(sinceMinutes * 60_000));
      }

      const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      const sql = `
        SELECT
          session_id,
          created_at,
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
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `;

      const rows = db.prepare(sql).all(...params, limit + 1, offset) as SessionRow[];
      const truncatedByLimit = rows.length > limit;
      const sessions = rows.slice(0, limit).map((row) => ({
        sessionId: row.session_id,
        createdAt: row.created_at,
        pausedAt: row.paused_at ?? undefined,
        endedAt: row.ended_at ?? undefined,
        status: row.ended_at ? 'ended' : row.paused_at ? 'paused' : 'active',
        tabId: row.tab_id ?? undefined,
        windowId: row.window_id ?? undefined,
        urlStart: row.url_start ?? undefined,
        urlLast: row.url_last ?? undefined,
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
        liveConnection: (() => {
          const state = getSessionConnectionState?.(row.session_id);
          if (!state) {
            return {
              connected: false,
              lastHeartbeatAt: undefined,
              disconnectReason: row.ended_at ? 'manual_stop' : undefined,
            };
          }

          return {
            connected: state.connected,
            connectedAt: state.connectedAt,
            lastHeartbeatAt: state.lastHeartbeatAt,
            disconnectedAt: state.disconnectedAt,
            disconnectReason: state.disconnectReason,
          };
        })(),
      }));
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
          LIMIT 1
        `)
        .get(sessionId) as SessionRow | undefined;

      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const connection = getSessionConnectionState?.(sessionId);
      const now = Date.now();
      const lastSeenAt = connection?.connected
        ? connection.lastHeartbeatAt
        : connection?.disconnectedAt ?? session.ended_at ?? session.paused_at ?? session.created_at;
      const staleForMs = lastSeenAt ? Math.max(0, now - lastSeenAt) : undefined;

      return {
        ...createBaseResponse(sessionId),
        limitsApplied: {
          maxResults: 1,
          truncated: false,
        },
        session: {
          sessionId: session.session_id,
          createdAt: session.created_at,
          pausedAt: session.paused_at ?? undefined,
          endedAt: session.ended_at ?? undefined,
          status: session.ended_at ? 'ended' : session.paused_at ? 'paused' : 'active',
          tabId: session.tab_id ?? undefined,
          windowId: session.window_id ?? undefined,
          urlStart: session.url_start ?? undefined,
          urlLast: session.url_last ?? undefined,
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
        },
        liveConnection: connection
          ? {
              connected: connection.connected,
              connectedAt: connection.connectedAt,
              lastHeartbeatAt: connection.lastHeartbeatAt,
              disconnectedAt: connection.disconnectedAt,
              disconnectReason: connection.disconnectReason,
              staleForMs,
            }
          : {
              connected: false,
              staleForMs,
            },
        recommendedAction: connection?.connected
          ? 'ready'
          : session.ended_at
            ? 'start_new_session'
            : 'reconnect_extension',
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

export function createV2ToolHandlers(captureClient: CaptureCommandClient): Partial<Record<string, ToolHandler>> {
  const capturePageState = async (
    sessionId: string,
    input: ToolInput,
  ): Promise<{ limitsApplied: { maxResults: number; truncated: boolean }; payload: Record<string, unknown> }> => {
    const maxItems = resolveStructuredMaxItems(input.maxItems, 40);
    const maxTextLength = resolveStructuredTextLength(input.maxTextLength, 80);
    const includeButtons = input.includeButtons !== false;
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
      const capture = await executeLiveCapture(
        captureClient,
        sessionId,
        'CAPTURE_COMPUTED_STYLES',
        { selector, properties },
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
      const capture = await executeLiveCapture(
        captureClient,
        sessionId,
        'CAPTURE_LAYOUT_METRICS',
        { selector },
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
              const resolvedTarget = await resolveWorkflowActionTarget(
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
                  resolution: resolvedTarget.resolution,
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
              matcher: step.kind === 'action' ? undefined : step.matcher,
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
            matcher: step.kind === 'action' ? undefined : step.matcher,
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

      const request = LiveUIActionRequestSchema.parse(actionInput);
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
          topDocumentOnly: true,
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
): Promise<ToolResponse> {
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (!tool) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  const response = await tool.handler(isRecord(input) ? input : {});
  return attachResponseBytes(response);
}

export function createMCPServer(
  overrides: Partial<Record<string, ToolHandler>> = {},
  options: MCPServerOptions = {},
): MCPServerRuntime {
  const logger = options.logger ?? createDefaultMcpLogger();
  const v2Handlers = options.captureClient ? createV2ToolHandlers(options.captureClient) : {};
  const tools = createToolRegistry({
    ...createV1ToolHandlers(() => getConnection().db, options.getSessionConnectionState),
    ...v2Handlers,
    ...overrides,
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
      const response = await routeToolCall(tools, toolName, request.params.arguments);
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
