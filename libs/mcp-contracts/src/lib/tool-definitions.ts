export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
}

export interface MCPServerConfig {
  name: string;
  version: string;
  tools: ToolDefinition[];
}

export const SESSION_TOOLS = {
  LIST_SESSIONS: 'list_sessions',
  GET_SESSION_SUMMARY: 'get_session_summary',
  GET_RECENT_EVENTS: 'get_recent_events',
  GET_NAVIGATION_HISTORY: 'get_navigation_history',
  GET_CONSOLE_EVENTS: 'get_console_events',
} as const;

export const ERROR_TOOLS = {
  GET_ERROR_FINGERPRINTS: 'get_error_fingerprints',
  GET_NETWORK_FAILURES: 'get_network_failures',
} as const;

export const QUERY_TOOLS = {
  GET_ELEMENT_REFS: 'get_element_refs',
} as const;

export const CAPTURE_TOOLS = {
  GET_DOM_SUBTREE: 'get_dom_subtree',
  GET_DOM_DOCUMENT: 'get_dom_document',
  GET_COMPUTED_STYLES: 'get_computed_styles',
  GET_LAYOUT_METRICS: 'get_layout_metrics',
  CAPTURE_UI_SNAPSHOT: 'capture_ui_snapshot',
} as const;

export const CORRELATION_TOOLS = {
  EXPLAIN_LAST_FAILURE: 'explain_last_failure',
  GET_EVENT_CORRELATION: 'get_event_correlation',
} as const;

export const SNAPSHOT_TOOLS = {
  LIST_SNAPSHOTS: 'list_snapshots',
  GET_SNAPSHOT_FOR_EVENT: 'get_snapshot_for_event',
  GET_SNAPSHOT_ASSET: 'get_snapshot_asset',
} as const;

export const ALL_TOOLS = [
  ...Object.values(SESSION_TOOLS),
  ...Object.values(ERROR_TOOLS),
  ...Object.values(QUERY_TOOLS),
  ...Object.values(CAPTURE_TOOLS),
  ...Object.values(CORRELATION_TOOLS),
  ...Object.values(SNAPSHOT_TOOLS),
];
