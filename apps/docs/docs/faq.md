# FAQ

## Why not use full browser automation?

This project focuses on real-user browser context and evidence capture, not automation scripting.

## Does it capture sensitive data?

By default, safe mode and redaction reduce sensitive exposure. Full bodies and typed values are not captured.

## Are heavy captures always on?

No. Heavy captures are on-demand MCP requests with strict limits.

## Why does MCP return no sessions?

Most common causes:

1. No active session was started in the extension popup.
2. The current site is not allowlisted.
3. MCP server was launched from a different config than expected.
