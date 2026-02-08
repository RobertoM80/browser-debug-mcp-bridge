export interface BaseResponse {
  sessionId?: string;
  limitsApplied?: {
    maxResults?: number;
    truncated?: boolean;
  };
  redactionSummary?: {
    totalFields: number;
    redactedFields: number;
    rulesApplied: string[];
  };
}

export interface ListSessionsResponse extends BaseResponse {
  sessions: Array<{
    id: string;
    url: string;
    startedAt: string;
    endedAt?: string;
    status: 'active' | 'closed';
  }>;
}

export interface SessionSummaryResponse extends BaseResponse {
  sessionId: string;
  url: string;
  timeRange: {
    startedAt: string;
    endedAt?: string;
    durationMs: number;
  };
  counts: {
    navigation: number;
    console: number;
    errors: number;
    network: number;
    clicks: number;
  };
}

export interface EventsResponse extends BaseResponse {
  events: Array<{
    id: string;
    type: string;
    timestamp: string;
    data: Record<string, unknown>;
  }>;
}

export interface NavigationHistoryResponse extends BaseResponse {
  navigations: Array<{
    from?: string;
    to: string;
    timestamp: string;
  }>;
}

export interface ConsoleEventsResponse extends BaseResponse {
  events: Array<{
    level: string;
    message: string;
    timestamp: string;
  }>;
}

export interface ErrorFingerprintsResponse extends BaseResponse {
  fingerprints: Array<{
    hash: string;
    count: number;
    sampleMessage: string;
    sampleStack?: string;
    firstSeen: string;
    lastSeen: string;
  }>;
}

export interface NetworkFailuresResponse extends BaseResponse {
  failures: Array<{
    url: string;
    errorType: string;
    count: number;
    lastOccurred: string;
  }>;
}

export interface ElementRefsResponse extends BaseResponse {
  elements: Array<{
    selector: string;
    tagName: string;
    attributes: Record<string, string>;
  }>;
}

export interface DOMSubtreeResponse extends BaseResponse {
  html?: string;
  outline?: string;
  truncated: boolean;
  bytesReturned: number;
}

export interface DOMDocumentResponse extends BaseResponse {
  title: string;
  url: string;
  content: string;
  mode: 'outline' | 'html';
}

export interface ComputedStylesResponse extends BaseResponse {
  selector: string;
  styles: Record<string, string>;
}

export interface LayoutMetricsResponse extends BaseResponse {
  selector?: string;
  viewport: {
    width: number;
    height: number;
  };
  element?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface ExplainLastFailureResponse extends BaseResponse {
  explanation: string;
  timeline: Array<{
    timestamp: string;
    type: string;
    description: string;
  }>;
  rootCause?: string;
}

export interface EventCorrelationResponse extends BaseResponse {
  correlatedEvents: Array<{
    eventId: string;
    type: string;
    timestamp: string;
    correlationScore: number;
    relationship: string;
  }>;
}
