<!-- markdownlint-disable MD041 MD033 -->

import { DocNote } from '../../src/components/DocNote';

# Limits and Redaction Reference

## Common response metadata

All tool responses include:

- `sessionId`
- `limitsApplied`
- `redactionSummary`

## Heavy capture limits

- `maxBytes`: hard payload cap
- `maxDepth` and related node-depth controls
- `timeoutMs` with outline fallback when exceeded

## Redaction behavior

- Redacts authorization headers and bearer tokens
- Redacts JWT-like values
- Redacts common query/body secret keys (`token`, `key`, `session`, etc.)
- Replaces broad 13-16 digit sensitive number sequences with neutral placeholders

<DocNote>
`redactionSummary` allows clients to audit what was masked without seeing the secret values.
</DocNote>
