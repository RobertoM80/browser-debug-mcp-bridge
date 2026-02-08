# Security and Privacy Controls

This project is designed to be privacy-first by default.

## Default behavior

- Safe mode is ON by default
- Domain allowlist is required (default is empty)
- Only lightweight telemetry is stored continuously

## Data that is not captured by default

- Cookies
- localStorage and sessionStorage values
- Typed input values
- Network response bodies
- Full DOM snapshots in persistent storage

## Redaction policy

Sensitive values are redacted before storage, logging, and MCP responses.

Examples:

- Authorization bearer tokens
- JWT-like values
- API keys and generic access tokens
- Common PII patterns

Every MCP response includes `redactionSummary` to show masking activity.

## Heavy capture guardrails

On-demand tools such as DOM and style capture enforce:

- `maxBytes`
- depth/node caps where relevant
- execution timeouts
- outline fallback when limits are exceeded

## Operational guidance

- Keep allowlists narrow and explicit
- Treat exported logs as sensitive artifacts
- Do not commit secrets, credentials, or `.env` files

Additional details: `docs/SECURITY.md`
