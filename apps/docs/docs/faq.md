# FAQ

## Why not use full browser automation?

This project focuses on real-user browser context and evidence capture, not automation scripting.

## Does it capture sensitive data?

By default, safe mode and redaction reduce sensitive exposure. Full bodies and typed values are not captured.

## Are heavy captures always on?

No. Heavy captures are on-demand MCP requests with strict limits.

## Does it capture every row visible in Chrome DevTools Console?

Not exactly.

It captures page-level JavaScript console calls (`console.log`, `console.warn`, `console.error`) plus runtime JS errors (`window.onerror`, `unhandledrejection`).

Browser-internal/DevTools UI-only rows are not guaranteed to be captured.

## Why does MCP return no sessions?

Most common causes:

1. No active session was started in the extension popup.
2. The current site is not allowlisted.
3. MCP server was launched from a different config than expected.

## Can I filter console logs by URL or string?

URL: yes. Persisted query tools support origin filtering with `url`, and live tool `get_live_console_logs` also supports `url`.

String contains: yes, via `get_live_console_logs` with `contains` (for example `"[auth]"`).
