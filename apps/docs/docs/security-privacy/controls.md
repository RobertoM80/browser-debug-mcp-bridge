<!-- markdownlint-disable MD041 MD033 -->

import { DocWarning } from '../../src/components/DocWarning';
import { DocLimit } from '../../src/components/DocLimit';

# Security & Privacy Controls

Safe mode and allowlisting are mandatory defaults for this project.

## Defaults

- Safe mode is ON by default
- Domain allowlist is required
- Response body capture is disabled by default
- Cookie/storage capture is blocked in safe mode
- Live network blocking is off by default and must be enabled explicitly per session

<DocWarning title="Production safety">
Never disable safe mode globally. If a task needs richer capture, scope it to a specific
session and domain and keep limits strict.
</DocWarning>

## Redaction

Redaction patterns include authorization headers, token-like strings, and common secret fields.

Every MCP response includes `redactionSummary`.

## State-changing Live Controls

`enable_network_blocking`, `enable_overrides`, and live automation tools change page behavior. Use a connected session, keep scope to a bound tab, and disable the feature immediately after the diagnostic step.

Network blocking does not capture additional secrets by itself, but it can alter application behavior and produce synthetic `blocked` network failure rows for auditability.

<DocLimit>
Heavy capture is bounded by byte/depth/time limits and may fallback to outline output.
</DocLimit>

See [Limits and redaction reference](../reference/limits-and-redaction.md).
