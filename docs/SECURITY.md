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

## Live automation guardrails

- Live automation is OFF by default and must be armed explicitly from the extension popup
- Sensitive-field automation is separately OFF by default; password, payment, auth, token, email, and similar selectors stay blocked until the second opt-in is enabled
- The extension shows a visible red in-page indicator whenever automation is armed or executing so operators can see risk state immediately
- Emergency stop is available from both the popup and the page overlay; using it disables automation before more actions can run
- Automation persistence keeps only redacted metadata for inputs and stores the raw typed value nowhere in events or MCP responses
