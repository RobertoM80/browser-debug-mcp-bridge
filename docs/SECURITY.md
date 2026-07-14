# Security & Privacy

## Safe Mode

Safe mode is **ON by default**.

## Privacy Rules

- Page, network, console, navigation, and UI event processing stays disabled until a bound session is active; pausing or stopping disables it again
- Never capture cookies, localStorage, or response bodies without explicit opt-in
- Redact tokens, JWTs, and PII from all outputs
- Domain allowlist required - default is empty

## Redaction

The `libs/redaction` package handles sensitive data removal:

- Tokens and JWTs
- Personal identifiable information (PII)
- Authentication credentials

Always use redaction utilities before logging or sending data over MCP.

## Local transport

- The bridge binds to `127.0.0.1` by default.
- Browser WebSocket upgrades are accepted only from Chrome extension origins; ordinary `http:` and `https:` page origins are rejected.
- When an extension reconnects with an existing session ID, the newest connection becomes the sole owner and the stale socket is closed.
- The packaged CLI gateway requires its user-local bearer token.

## Live automation guardrails

- Live automation is OFF by default and must be armed explicitly from the extension popup
- Sensitive-field automation is separately OFF by default; password, payment, auth, token, email, and similar selectors stay blocked until the second opt-in is enabled
- The extension shows a visible red in-page indicator whenever automation is armed or executing so operators can see risk state immediately
- Emergency stop is available from both the popup and the page overlay; using it disables automation before more actions can run
- Automation persistence keeps only redacted metadata for inputs and stores the raw typed value nowhere in events or MCP responses
