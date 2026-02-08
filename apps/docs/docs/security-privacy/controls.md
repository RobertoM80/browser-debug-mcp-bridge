import { DocWarning } from '../../src/components/DocWarning';
import { DocLimit } from '../../src/components/DocLimit';

# Security & Privacy Controls

Safe mode and allowlisting are mandatory defaults for this project.

## Defaults

- Safe mode is ON by default
- Domain allowlist is required
- Response body capture is disabled by default
- Cookie/storage capture is blocked in safe mode

<DocWarning title="Production safety">
Never disable safe mode globally. If a task needs richer capture, scope it to a specific
session and domain and keep limits strict.
</DocWarning>

## Redaction

Redaction patterns include authorization headers, token-like strings, and common secret fields.

Every MCP response includes `redactionSummary`.

<DocLimit>
Heavy capture is bounded by byte/depth/time limits and may fallback to outline output.
</DocLimit>

See [Limits and redaction reference](../reference/limits-and-redaction.md).
