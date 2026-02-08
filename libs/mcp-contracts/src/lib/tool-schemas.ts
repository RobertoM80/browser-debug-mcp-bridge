import { z } from 'zod';

export const ListSessionsSchema = z.object({
  sinceMinutes: z.number().int().min(1).max(1440).default(60)
    .describe('Number of minutes to look back for sessions'),
});

export const GetSessionSummarySchema = z.object({
  sessionId: z.string().describe('Unique session identifier'),
});

export const GetRecentEventsSchema = z.object({
  sessionId: z.string().describe('Unique session identifier'),
  eventTypes: z.array(z.enum(['navigation', 'console', 'error', 'network', 'click'])).optional()
    .describe('Filter by event types'),
  limit: z.number().int().min(1).max(1000).default(100)
    .describe('Maximum number of events to return'),
});

export const GetNavigationHistorySchema = z.object({
  sessionId: z.string().describe('Unique session identifier'),
});

export const GetConsoleEventsSchema = z.object({
  sessionId: z.string().describe('Unique session identifier'),
  level: z.enum(['error', 'warn', 'info', 'debug']).optional()
    .describe('Filter by console level'),
});

export const GetErrorFingerprintsSchema = z.object({
  sessionId: z.string().optional().describe('Filter by session ID'),
  sinceMinutes: z.number().int().min(1).max(10080).default(1440)
    .describe('Number of minutes to look back'),
});

export const GetNetworkFailuresSchema = z.object({
  sessionId: z.string().optional().describe('Filter by session ID'),
  errorType: z.enum(['timeout', 'cors', 'dns', 'blocked', 'http_error']).optional()
    .describe('Filter by error type'),
  groupBy: z.enum(['url', 'errorType', 'domain']).optional()
    .describe('Group results by field'),
});

export const GetElementRefsSchema = z.object({
  sessionId: z.string().describe('Unique session identifier'),
  selector: z.string().describe('CSS selector to find elements'),
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
