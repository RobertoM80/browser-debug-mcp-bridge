import { describe, it, expect } from 'vitest';
import {
  ALL_TOOLS,
  SESSION_TOOLS,
  ERROR_TOOLS,
  QUERY_TOOLS,
  CAPTURE_TOOLS,
  CORRELATION_TOOLS,
  SNAPSHOT_TOOLS,
} from './tool-definitions';

describe('tool-definitions', () => {
  it('should have unique tool names', () => {
    const uniqueTools = new Set(ALL_TOOLS);
    expect(uniqueTools.size).toBe(ALL_TOOLS.length);
  });

  it('should define session tools', () => {
    expect(SESSION_TOOLS.LIST_SESSIONS).toBe('list_sessions');
    expect(SESSION_TOOLS.GET_SESSION_SUMMARY).toBe('get_session_summary');
    expect(SESSION_TOOLS.GET_RECENT_EVENTS).toBe('get_recent_events');
    expect(SESSION_TOOLS.GET_NAVIGATION_HISTORY).toBe('get_navigation_history');
    expect(SESSION_TOOLS.GET_CONSOLE_EVENTS).toBe('get_console_events');
  });

  it('should define error tools', () => {
    expect(ERROR_TOOLS.GET_ERROR_FINGERPRINTS).toBe('get_error_fingerprints');
    expect(ERROR_TOOLS.GET_NETWORK_FAILURES).toBe('get_network_failures');
  });

  it('should define query tools', () => {
    expect(QUERY_TOOLS.GET_ELEMENT_REFS).toBe('get_element_refs');
  });

  it('should define capture tools', () => {
    expect(CAPTURE_TOOLS.GET_DOM_SUBTREE).toBe('get_dom_subtree');
    expect(CAPTURE_TOOLS.GET_DOM_DOCUMENT).toBe('get_dom_document');
    expect(CAPTURE_TOOLS.GET_COMPUTED_STYLES).toBe('get_computed_styles');
    expect(CAPTURE_TOOLS.GET_LAYOUT_METRICS).toBe('get_layout_metrics');
    expect(CAPTURE_TOOLS.CAPTURE_UI_SNAPSHOT).toBe('capture_ui_snapshot');
  });

  it('should define correlation tools', () => {
    expect(CORRELATION_TOOLS.EXPLAIN_LAST_FAILURE).toBe('explain_last_failure');
    expect(CORRELATION_TOOLS.GET_EVENT_CORRELATION).toBe('get_event_correlation');
  });

  it('should define snapshot tools', () => {
    expect(SNAPSHOT_TOOLS.LIST_SNAPSHOTS).toBe('list_snapshots');
    expect(SNAPSHOT_TOOLS.GET_SNAPSHOT_FOR_EVENT).toBe('get_snapshot_for_event');
    expect(SNAPSHOT_TOOLS.GET_SNAPSHOT_ASSET).toBe('get_snapshot_asset');
  });
});
