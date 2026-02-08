# Extension

The MV3 extension contains:

- background service worker for session lifecycle and WebSocket transport
- content script for navigation and click capture
- injected script for fetch/XHR hooks and runtime/console errors
- popup UI for session controls, safe mode, and allowlist settings

## Privacy behavior

- Safe mode defaults to enabled.
- Sensitive fields are redacted before outbound transmission.
- Typed values are never captured for user journey events.

See [Security & Privacy controls](../security-privacy/controls.md).
