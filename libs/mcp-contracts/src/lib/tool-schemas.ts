import { z } from 'zod';
import { LiveUIActionRequestSchema } from './live-actions';
import { RunUIStepsSchema } from './ui-workflows';

export const ListSessionsSchema = z.object({
  sinceMinutes: z.number().int().min(1).max(1440).default(60)
    .describe('Number of minutes to look back for sessions'),
  limit: z.number().int().min(1).max(200).optional()
    .describe('Maximum number of results to return'),
  offset: z.number().int().min(0).optional()
    .describe('Pagination offset for result set'),
  maxResponseBytes: z.number().int().min(1024).max(524288).optional()
    .describe('Soft byte budget for returned rows before truncation'),
});

export const GetSessionSummarySchema = z.object({
  sessionId: z.string().describe('Unique session identifier'),
});

export const GetRecentEventsSchema = z.object({
  sessionId: z.string().optional().describe('Unique session identifier'),
  url: z.string().optional().describe('Optional absolute URL; normalized to origin filter'),
  eventTypes: z.array(
    z.enum(['navigation', 'console', 'error', 'network', 'click', 'scroll', 'input', 'change', 'submit', 'focus', 'blur', 'keydown'])
  ).optional()
    .describe('Filter by event types'),
  types: z.array(
    z.enum(['navigation', 'console', 'error', 'network', 'click', 'scroll', 'input', 'change', 'submit', 'focus', 'blur', 'keydown'])
  ).optional()
    .describe('Legacy alias for eventTypes'),
  limit: z.number().int().min(1).max(1000).default(100)
    .describe('Maximum number of events to return'),
  offset: z.number().int().min(0).optional()
    .describe('Pagination offset for result set'),
  responseProfile: z.enum(['legacy', 'compact']).optional()
    .describe('Response shape profile; compact omits large payloads by default'),
  includePayload: z.boolean().optional()
    .describe('When using compact profile, include full payload for each event'),
  maxResponseBytes: z.number().int().min(1024).max(524288).optional()
    .describe('Soft byte budget for returned event rows before truncation'),
});

export const GetNavigationHistorySchema = z.object({
  sessionId: z.string().optional().describe('Unique session identifier'),
  url: z.string().optional().describe('Optional absolute URL; normalized to origin filter'),
  limit: z.number().int().min(1).max(200).optional()
    .describe('Maximum number of navigation events to return'),
  offset: z.number().int().min(0).optional()
    .describe('Pagination offset for result set'),
  responseProfile: z.enum(['legacy', 'compact']).optional()
    .describe('Response shape profile; compact omits large payloads by default'),
  includePayload: z.boolean().optional()
    .describe('When using compact profile, include full payload for each event'),
  maxResponseBytes: z.number().int().min(1024).max(524288).optional()
    .describe('Soft byte budget for returned rows before truncation'),
});

export const GetConsoleEventsSchema = z.object({
  sessionId: z.string().optional().describe('Unique session identifier'),
  url: z.string().optional().describe('Optional absolute URL; normalized to origin filter'),
  level: z.enum(['log', 'info', 'warn', 'error', 'debug', 'trace']).optional()
    .describe('Filter by console level'),
  limit: z.number().int().min(1).max(200).optional()
    .describe('Maximum number of console events to return'),
  offset: z.number().int().min(0).optional()
    .describe('Pagination offset for result set'),
  responseProfile: z.enum(['legacy', 'compact']).optional()
    .describe('Response shape profile; compact omits large payloads by default'),
  includePayload: z.boolean().optional()
    .describe('When using compact profile, include full payload for each event'),
  maxResponseBytes: z.number().int().min(1024).max(524288).optional()
    .describe('Soft byte budget for returned rows before truncation'),
});

export const GetConsoleSummarySchema = z.object({
  sessionId: z.string().optional().describe('Optional session filter'),
  url: z.string().optional().describe('Optional absolute URL; normalized to origin filter'),
  level: z.enum(['log', 'info', 'warn', 'error', 'debug', 'trace']).optional()
    .describe('Filter by console level'),
  sinceMinutes: z.number().int().min(1).max(10080).optional()
    .describe('Only include console rows newer than N minutes'),
  limit: z.number().int().min(1).max(200).optional()
    .describe('Maximum number of top repeated messages to return'),
});

export const GetEventSummarySchema = z.object({
  sessionId: z.string().optional().describe('Optional session filter'),
  url: z.string().optional().describe('Optional absolute URL; normalized to origin filter'),
  eventTypes: z.array(
    z.enum(['navigation', 'console', 'error', 'network', 'click', 'scroll', 'input', 'change', 'submit', 'focus', 'blur', 'keydown'])
  ).optional()
    .describe('Filter summary by event types'),
  types: z.array(
    z.enum(['navigation', 'console', 'error', 'network', 'click', 'scroll', 'input', 'change', 'submit', 'focus', 'blur', 'keydown'])
  ).optional()
    .describe('Legacy alias for eventTypes'),
  sinceMinutes: z.number().int().min(1).max(10080).optional()
    .describe('Only include events newer than N minutes'),
  limit: z.number().int().min(1).max(200).optional()
    .describe('Maximum number of grouped event types to return'),
});

export const GetErrorFingerprintsSchema = z.object({
  sessionId: z.string().optional().describe('Filter by session ID'),
  sinceMinutes: z.number().int().min(1).max(10080).default(1440)
    .describe('Number of minutes to look back'),
  limit: z.number().int().min(1).max(200).optional()
    .describe('Maximum number of fingerprints to return'),
  offset: z.number().int().min(0).optional()
    .describe('Pagination offset for result set'),
  maxResponseBytes: z.number().int().min(1024).max(524288).optional()
    .describe('Soft byte budget for returned rows before truncation'),
});

export const GetNetworkFailuresSchema = z.object({
  sessionId: z.string().optional().describe('Filter by session ID'),
  errorType: z.enum(['timeout', 'cors', 'dns', 'blocked', 'http_error']).optional()
    .describe('Filter by error type'),
  groupBy: z.enum(['url', 'errorType', 'domain']).optional()
    .describe('Group results by field'),
  limit: z.number().int().min(1).max(200).optional()
    .describe('Maximum number of failures/groups to return'),
  offset: z.number().int().min(0).optional()
    .describe('Pagination offset for result set'),
  maxResponseBytes: z.number().int().min(1024).max(524288).optional()
    .describe('Soft byte budget for returned rows before truncation'),
});

export const GetNetworkCallsSchema = z.object({
  sessionId: z.string().describe('Session identifier'),
  urlContains: z.string().optional()
    .describe('Case-sensitive URL substring filter'),
  urlRegex: z.string().optional()
    .describe('Regular expression applied to URL'),
  method: z.string().optional()
    .describe('HTTP method filter'),
  statusIn: z.array(z.number().int().min(100).max(599)).optional()
    .describe('Allowed HTTP statuses'),
  tabId: z.number().int().min(0).optional()
    .describe('Optional tab identifier filter'),
  timeFrom: z.number().int().min(0).optional()
    .describe('Lower timestamp bound (ms epoch)'),
  timeTo: z.number().int().min(0).optional()
    .describe('Upper timestamp bound (ms epoch)'),
  includeBodies: z.boolean().optional()
    .describe('Include sanitized request/response body fields'),
  limit: z.number().int().min(1).max(200).optional()
    .describe('Maximum number of calls to return'),
  offset: z.number().int().min(0).optional()
    .describe('Pagination offset'),
  maxResponseBytes: z.number().int().min(1024).max(524288).optional()
    .describe('Soft byte budget for returned rows before truncation'),
});

export const WaitForNetworkCallSchema = z.object({
  sessionId: z.string().describe('Session identifier'),
  urlPattern: z.string().describe('URL regex pattern to wait for'),
  method: z.string().optional().describe('Optional HTTP method filter'),
  timeoutMs: z.number().int().min(100).max(120000).optional()
    .describe('Wait timeout in milliseconds'),
  includeBodies: z.boolean().optional()
    .describe('Include sanitized request/response body fields'),
});

export const GetRequestTraceSchema = z.object({
  sessionId: z.string().optional().describe('Optional session scope'),
  requestId: z.string().optional().describe('Anchor request identifier'),
  traceId: z.string().optional().describe('Existing trace identifier'),
  includeBodies: z.boolean().optional()
    .describe('Include sanitized request/response body fields'),
  eventLimit: z.number().int().min(1).max(200).optional()
    .describe('Maximum correlated events to return'),
});

export const GetBodyChunkSchema = z.object({
  chunkRef: z.string().describe('Chunk reference identifier'),
  sessionId: z.string().optional().describe('Optional session scope'),
  offset: z.number().int().min(0).optional().describe('Byte offset'),
  limit: z.number().int().min(1).max(262144).optional().describe('Chunk size in bytes'),
});

export const GetElementRefsSchema = z.object({
  sessionId: z.string().describe('Unique session identifier'),
  selector: z.string().describe('CSS selector to find elements'),
  limit: z.number().int().min(1).max(200).optional()
    .describe('Maximum number of matching element refs to return'),
  offset: z.number().int().min(0).optional()
    .describe('Pagination offset for result set'),
  maxResponseBytes: z.number().int().min(1024).max(524288).optional()
    .describe('Soft byte budget for returned rows before truncation'),
});

export const GetInteractiveElementsSchema = z.object({
  sessionId: z.string().describe('Connected session identifier'),
  kinds: z.array(z.enum(['buttons', 'inputs', 'modals', 'focused'])).optional()
    .describe('Optional element kinds to include; defaults to all live interactive categories'),
  maxItems: z.number().int().min(1).max(100).optional()
    .describe('Maximum number of structured refs to return'),
  maxTextLength: z.number().int().min(8).max(200).optional()
    .describe('Per-field text truncation budget for returned refs'),
});

export const GetDOMSubtreeSchema = z.object({
  sessionId: z.string().describe('Unique session identifier'),
  selector: z.string().describe('Root element selector'),
  maxDepth: z.number().int().min(1).max(10).default(3)
    .describe('Maximum depth to traverse'),
  maxBytes: z.number().int().min(1000).max(1000000).default(50000)
    .describe('Maximum response size in bytes'),
});

export const GetDOMDocumentSchema = z.object({
  sessionId: z.string().describe('Unique session identifier'),
  mode: z.enum(['outline', 'html']).default('outline')
    .describe('Output mode: outline (minimal) or html (full)'),
});

export const GetComputedStylesSchema = z.object({
  sessionId: z.string().describe('Unique session identifier'),
  selector: z.string().describe('Element selector'),
  properties: z.array(z.string()).optional()
    .describe('Specific properties to return (all if omitted)'),
});

export const GetLayoutMetricsSchema = z.object({
  sessionId: z.string().describe('Unique session identifier'),
  selector: z.string().optional()
    .describe('Element selector (viewport if omitted)'),
});

export const CaptureUISnapshotSchema = z.object({
  sessionId: z.string().describe('Unique session identifier'),
  selector: z.string().optional()
    .describe('Optional selector; active element/body fallback is used when omitted'),
  trigger: z.enum(['click', 'manual', 'navigation', 'error']).default('manual')
    .describe('Snapshot trigger label used for filtering and attribution'),
  mode: z.enum(['dom', 'png', 'both']).default('dom')
    .describe('Capture mode: DOM only, PNG only, or both'),
  styleMode: z.enum(['computed-lite', 'computed-full']).optional()
    .describe('Computed style detail level; full mode must be explicitly requested'),
  maxDepth: z.number().int().min(1).max(10).optional()
    .describe('Maximum DOM outline depth when html capture is truncated'),
  maxBytes: z.number().int().min(1000).max(1000000).optional()
    .describe('Maximum bytes for DOM/style payload sections'),
  maxAncestors: z.number().int().min(0).max(8).optional()
    .describe('Maximum ancestor chain length for computed style capture'),
  includeDom: z.boolean().optional()
    .describe('Include captured DOM section in response payload'),
  includeStyles: z.boolean().optional()
    .describe('Include captured computed styles section in response payload'),
  includePngDataUrl: z.boolean().optional()
    .describe('Include inline PNG dataUrl in response payload when PNG is captured'),
});

export const GetLiveConsoleLogsSchema = z.object({
  sessionId: z.string().describe('Connected session identifier'),
  url: z.string().optional()
    .describe('Optional absolute URL; normalized to origin filter'),
  tabId: z.number().int().min(0).optional()
    .describe('Optional tab scope filter'),
  levels: z.array(z.enum(['log', 'info', 'warn', 'error', 'debug', 'trace'])).optional()
    .describe('Optional console level filters'),
  contains: z.string().optional()
    .describe('Optional case-insensitive message substring match'),
  sinceTs: z.number().int().min(0).optional()
    .describe('Optional timestamp lower bound (ms epoch)'),
  includeRuntimeErrors: z.boolean().optional()
    .describe('Include runtime error events in the live stream (default true)'),
  dedupeWindowMs: z.number().int().min(0).max(60000).optional()
    .describe('Collapse repeated identical logs within this time window'),
  limit: z.number().int().min(1).max(200).optional()
    .describe('Maximum number of live logs to return'),
  responseProfile: z.enum(['legacy', 'compact']).optional()
    .describe('Response shape profile; compact returns minimal fields'),
  includeArgs: z.boolean().optional()
    .describe('When using compact profile, include original console args arrays'),
  maxResponseBytes: z.number().int().min(1024).max(524288).optional()
    .describe('Soft byte budget for returned log rows before truncation'),
});

export const ExplainLastFailureSchema = z.object({
  sessionId: z.string().describe('Unique session identifier'),
  lookbackSeconds: z.number().int().min(1).max(300).default(30)
    .describe('Seconds to look back from last error'),
});

export const GetEventCorrelationSchema = z.object({
  sessionId: z.string().describe('Unique session identifier'),
  eventId: z.string().describe('Event ID to correlate from'),
  windowSeconds: z.number().int().min(1).max(60).default(5)
    .describe('Time window for correlation'),
});

export const ListSnapshotsSchema = z.object({
  sessionId: z.string().describe('Unique session identifier'),
  trigger: z.enum(['click', 'manual', 'navigation', 'error']).optional()
    .describe('Filter by snapshot trigger type'),
  sinceTimestamp: z.number().int().min(0).optional()
    .describe('Only include snapshots at or after this timestamp (ms)'),
  untilTimestamp: z.number().int().min(0).optional()
    .describe('Only include snapshots at or before this timestamp (ms)'),
  limit: z.number().int().min(1).max(200).optional()
    .describe('Maximum number of snapshots to return'),
  offset: z.number().int().min(0).optional()
    .describe('Pagination offset for result set'),
  maxResponseBytes: z.number().int().min(1024).max(524288).optional()
    .describe('Soft byte budget for returned rows before truncation'),
});

export const GetSnapshotForEventSchema = z.object({
  sessionId: z.string().describe('Unique session identifier'),
  eventId: z.string().describe('Anchor event ID'),
  maxDeltaMs: z.number().int().min(100).max(60000).default(10000)
    .describe('Max allowed distance from event timestamp when no direct trigger link exists'),
});

export const GetSnapshotAssetSchema = z.object({
  sessionId: z.string().describe('Unique session identifier'),
  snapshotId: z.string().describe('Snapshot identifier'),
  asset: z.enum(['png']).default('png')
    .describe('Snapshot binary asset kind to retrieve'),
  offset: z.number().int().min(0).optional()
    .describe('Starting byte offset for chunked retrieval'),
  maxBytes: z.number().int().min(1).max(262144).default(65536)
    .describe('Maximum chunk size to return in bytes'),
  encoding: z.enum(['raw', 'base64']).default('base64')
    .describe('Chunk encoding mode'),
});

export const ListAutomationRunsSchema = z.object({
  sessionId: z.string().describe('Session identifier'),
  status: z.enum(['requested', 'started', 'succeeded', 'failed', 'rejected', 'stopped']).optional()
    .describe('Optional run status filter'),
  action: z.enum(['click', 'input', 'focus', 'blur', 'scroll', 'press_key', 'submit', 'reload']).optional()
    .describe('Optional action filter'),
  traceId: z.string().optional()
    .describe('Optional trace identifier filter'),
  limit: z.number().int().min(1).max(200).optional()
    .describe('Maximum number of automation runs to return'),
  offset: z.number().int().min(0).optional()
    .describe('Pagination offset for result set'),
  maxResponseBytes: z.number().int().min(1024).max(524288).optional()
    .describe('Soft byte budget for returned rows before truncation'),
});

export const GetAutomationRunSchema = z.object({
  sessionId: z.string().describe('Session identifier'),
  runId: z.string().describe('Automation run identifier'),
  stepLimit: z.number().int().min(1).max(200).optional()
    .describe('Maximum number of steps to return'),
  stepOffset: z.number().int().min(0).optional()
    .describe('Pagination offset for steps'),
  maxResponseBytes: z.number().int().min(1024).max(524288).optional()
    .describe('Soft byte budget for returned step rows before truncation'),
});

const ExecuteUIActionFailureCaptureSchema = z.object({
  enabled: z.boolean().optional()
    .describe('Capture snapshot evidence only when the action result is rejected or failed'),
  selector: z.string().optional()
    .describe('Optional selector override for failure snapshot capture'),
  mode: z.enum(['dom', 'png', 'both']).optional()
    .describe('Failure snapshot mode; defaults to dom'),
  styleMode: z.enum(['computed-lite', 'computed-full']).optional()
    .describe('Failure snapshot style detail level; full mode must be explicitly requested'),
  maxDepth: z.number().int().min(1).max(10).optional()
    .describe('Maximum DOM depth for failure capture'),
  maxBytes: z.number().int().min(1000).max(1000000).optional()
    .describe('Maximum bytes for failure capture payload sections'),
  maxAncestors: z.number().int().min(0).max(8).optional()
    .describe('Maximum ancestor chain length for failure style capture'),
  includeDom: z.boolean().optional()
    .describe('Include DOM section in failure capture response payload'),
  includeStyles: z.boolean().optional()
    .describe('Include styles section in failure capture response payload'),
  includePngDataUrl: z.boolean().optional()
    .describe('Include inline PNG data URL in failure capture response payload'),
});

const ExecuteUIActionWaitForPageStateSchema = z.object({
  scope: z.enum(['buttons', 'inputs', 'modals', 'focused', 'page'])
    .describe('Structured page-state scope to evaluate after the action'),
  selector: z.string().optional().describe('Optional selector substring matcher'),
  testId: z.string().optional().describe('Optional exact data-testid matcher'),
  textContains: z.string().optional().describe('Optional text substring matcher'),
  labelContains: z.string().optional().describe('Optional input label substring matcher'),
  titleContains: z.string().optional().describe('Optional modal title substring matcher'),
  urlContains: z.string().optional().describe('Optional page URL substring matcher'),
  language: z.string().optional().describe('Optional exact page language matcher'),
  disabled: z.boolean().optional().describe('Optional disabled-state matcher'),
  selected: z.boolean().optional().describe('Optional selected-state matcher'),
  pressed: z.boolean().optional().describe('Optional pressed-state matcher'),
  expanded: z.boolean().optional().describe('Optional expanded-state matcher'),
  readOnly: z.boolean().optional().describe('Optional readonly-state matcher'),
  requiredField: z.boolean().optional().describe('Optional required-field matcher'),
  tagName: z.string().optional().describe('Optional exact tag name matcher'),
  type: z.string().optional().describe('Optional exact input type matcher'),
  countExactly: z.number().int().min(0).optional().describe('Require an exact number of matches'),
  countAtLeast: z.number().int().min(0).optional().describe('Require at least this many matches'),
  maxItems: z.number().int().min(1).max(100).optional().describe('Structured page-state item budget'),
  maxTextLength: z.number().int().min(8).max(200).optional().describe('Per-field text truncation budget'),
  timeoutMs: z.number().int().min(100).max(30000).optional().describe('Maximum wait duration in milliseconds'),
  pollIntervalMs: z.number().int().min(50).max(2000).optional().describe('Polling interval in milliseconds'),
});

export const ExecuteUIActionSchema = z.intersection(
  z.object({
    sessionId: z.string().describe('Connected session identifier'),
    captureOnFailure: ExecuteUIActionFailureCaptureSchema.optional(),
    waitForPageState: ExecuteUIActionWaitForPageStateSchema.optional(),
  }),
  LiveUIActionRequestSchema,
);

export { RunUIStepsSchema };
