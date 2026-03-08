# Extension

The MV3 extension contains:

- background service worker for session lifecycle and WebSocket transport
- content script for navigation and click capture
- injected script for fetch/XHR hooks and runtime/console errors
- popup UI for session controls, safe mode, allowlist settings, and live `Bridge Health` diagnostics

## Session tab isolation

- Starting a session binds capture to the current active tab.
- Events from other tabs are ignored unless explicitly added.
- The popup `Session Tabs` panel lets you add/remove tabs for the active session.
- If the last bound tab is closed or removed from scope, the session auto-stops.
- This prevents mixed telemetry from unrelated tabs and base URLs.
- Live console buffers are session-scoped in memory and queried via `get_live_console_logs`.

## Popup bridge health

- The popup `Bridge Health` panel updates live while the popup is open.
- It summarizes:
  - transport connection state
  - active session id / paused state
  - content-script readiness and fallback injection status
  - guardrail state (`safe mode` plus allowlist count)
  - capture accept/reject counters
  - last event, sender, and update time
- It also exposes quick recovery actions:
  - `Recover session`
  - `Retry content script`
  - `Open bound tab`
- Use it as the first troubleshooting surface before moving to background logs or MCP-side diagnostics.

## Privacy behavior

- Safe mode defaults to enabled.
- Sensitive fields are redacted before outbound transmission.
- Typed values are never captured for user journey events.

See [Security & Privacy controls](../security-privacy/controls.md).
