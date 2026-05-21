# V7 Lighthouse Performance Tools

These tools run the official Lighthouse engine from the MCP server, persist JSON/HTML artifacts, and generate fix plans from stored reports. They produce DevTools-equivalent Lighthouse data, but they do not automate the Chrome DevTools Lighthouse panel UI.

When `sessionId` is supplied, the latest session URL is used as the target. The audit itself runs in an isolated Lighthouse-controlled Chrome instance.

## `run_lighthouse_report`

Run and persist a Lighthouse report.

```json
{
  "name": "run_lighthouse_report",
  "arguments": {
    "sessionId": "sess_123",
    "formFactor": "mobile",
    "categories": ["performance"]
  }
}
```

Use `url` instead of `sessionId` for direct audits. Supported categories are `performance`, `accessibility`, `best-practices`, `seo`, and `pwa`; the default is `performance`.

## `list_lighthouse_reports`

List stored report metadata by session, URL substring, status, limit, and offset.

```json
{
  "name": "list_lighthouse_reports",
  "arguments": {
    "sessionId": "sess_123",
    "status": "succeeded",
    "limit": 20
  }
}
```

## `get_lighthouse_report`

Read one stored report summary.

```json
{
  "name": "get_lighthouse_report",
  "arguments": { "reportId": "lhr-..." }
}
```

## `get_lighthouse_report_asset`

Read bounded chunks from the persisted `json` or `html` artifact.

```json
{
  "name": "get_lighthouse_report_asset",
  "arguments": {
    "reportId": "lhr-...",
    "asset": "html",
    "maxBytes": 65536,
    "encoding": "base64"
  }
}
```

## `plan_lighthouse_fixes`

Create a prioritized remediation plan from the stored Lighthouse JSON report. Add `projectRoot` to have the MCP server scan the local project for source files that correspond to Lighthouse resource URLs and the audited route.

```json
{
  "name": "plan_lighthouse_fixes",
  "arguments": {
    "reportId": "lhr-...",
    "minPriority": "medium",
    "limit": 50,
    "projectRoot": "C:/path/to/repo/apps/web",
    "routePath": "/pricing",
    "sourceCandidateLimit": 5
  }
}
```

The plan includes audit ids, titles, priorities, estimated savings when Lighthouse provides them, rationale, suggested action, resource URLs extracted from audit details, likely local source candidates, fix readiness, and next repair steps. Source edits are then made by the coding agent or developer against those candidates, followed by another Lighthouse run for comparison.
