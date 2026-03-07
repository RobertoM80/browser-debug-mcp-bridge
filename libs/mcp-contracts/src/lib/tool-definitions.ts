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
  GET_CONSOLE_SUMMARY: 'get_console_summary',
  GET_EVENT_SUMMARY: 'get_event_summary',
} as const;

export const ERROR_TOOLS = {
  GET_ERROR_FINGERPRINTS: 'get_error_fingerprints',
  GET_NETWORK_FAILURES: 'get_network_failures',
  GET_NETWORK_CALLS: 'get_network_calls',
  WAIT_FOR_NETWORK_CALL: 'wait_for_network_call',
  GET_REQUEST_TRACE: 'get_request_trace',
  GET_BODY_CHUNK: 'get_body_chunk',
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
  GET_LIVE_CONSOLE_LOGS: 'get_live_console_logs',
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

export const AUTOMATION_TOOLS = {
  LIST_AUTOMATION_RUNS: 'list_automation_runs',
  GET_AUTOMATION_RUN: 'get_automation_run',
  EXECUTE_UI_ACTION: 'execute_ui_action',
} as const;

export const ALL_TOOLS = [
  ...Object.values(SESSION_TOOLS),
  ...Object.values(ERROR_TOOLS),
  ...Object.values(QUERY_TOOLS),
  ...Object.values(CAPTURE_TOOLS),
  ...Object.values(CORRELATION_TOOLS),
  ...Object.values(SNAPSHOT_TOOLS),
  ...Object.values(AUTOMATION_TOOLS),
];
