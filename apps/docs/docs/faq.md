# FAQ

## Why not use full browser automation?

This project focuses on real-user browser context and evidence capture, not automation scripting.

## Does it capture sensitive data?

By default, safe mode and redaction reduce sensitive exposure. Full bodies and typed values are not captured.

## Are heavy captures always on?

No. Heavy captures are on-demand MCP requests with strict limits.

## How should docs be versioned?

Use docs snapshots per release train (for example `v1`, `v2`, `v3`) while keeping `current` aligned to main branch behavior.
