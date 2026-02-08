# Security & Privacy

## Safe Mode

Safe mode is **ON by default**.

## Privacy Rules

- Never capture cookies, localStorage, or response bodies without explicit opt-in
- Redact tokens, JWTs, and PII from all outputs
- Domain allowlist required - default is empty

## Redaction

The `libs/redaction` package handles sensitive data removal:

- Tokens and JWTs
- Personal identifiable information (PII)
- Authentication credentials

Always use redaction utilities before logging or sending data over MCP.
