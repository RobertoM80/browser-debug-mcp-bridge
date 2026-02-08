# PROJECT_INFOS.md

## 1) Project vision

### Name
**Browser Debug MCP Bridge**

### Goal
Build a system that captures **real context from a user’s Chrome browser** during a debugging session and makes it queryable **on-demand** by an LLM through **MCP (Model Context Protocol)**.

The key idea is that the LLM shouldn’t guess. It should be able to request concrete evidence *only when needed* (console errors, failed requests, DOM subtree, computed styles, layout metrics, etc.) from the **real browser** (with the user’s session/login, extensions, feature flags, internal environments, etc.).

### Why it exists
Many existing solutions (Playwright/CDP-based) often:
- start a “clean” browser/profile without the user’s real session/extensions
- require setup (storage state, special profiles) that slows debugging
- return outputs that are not optimized for LLMs (too heavy, or not queryable)

This project aims to:
- store **lightweight telemetry that is always useful** (indexed, persistent)
- provide **heavy captures only on-demand** (full/subtree DOM, extended styles, screenshots, etc.)
- remain **privacy-first** with safe mode, allowlists, and redaction

---

## 2) Scope and non-scope

### In scope (V1–V3)
- **Chrome Extension (MV3)** that:
  - starts/stops debug sessions
  - captures “light” telemetry continuously
  - executes “heavy” captures on request (on-demand)
- **Local Server** that:
  - ingests events from the extension (stream)
  - persists them to SQLite
  - exposes an **MCP server** with query tools + heavy-capture tools
- **Security & privacy controls**
  - Safe mode by default
  - Domain allowlist
  - Redaction (tokens/PII)
  - Tool limits (maxBytes/maxDepth/timeouts)

### Out of scope (initially)
- Full automation like Playwright (LLM-driven click/type/navigation)
- Full cookie/storage capture (opt-in only, likely never by default)
- Response body capture by default (opt-in, selective)
- Rich UI dashboard: only a minimal viewer is optional

---

## 3) Architecture

### Components
1) **Chrome Extension (Manifest V3)**
   - **content script**: DOM observation, minimal user events, communication with injected script
   - **injected script**: hooks `fetch`/`XHR`, optional console overrides, access to page context
   - **background service worker**: session management, connection to local server, buffering/backpressure, client-side policy checks
   - Minimal UIs:
     - **popup (V1)**: start/stop session + toggles (safe mode, allowlist)
     - **devtools panel (V2 optional)**: event stream view + inspect/capture commands

2) **Local Server (Node.js/TS)**
   - WebSocket server: event ingestion
   - SQLite: session/event persistence + indexes
   - HTTP endpoints: health/debug (dev only)
   - MCP server: tools for queries and heavy capture
   - Centralized redaction + guardrail enforcement

3) **Optional Viewer (Web UI)**
   - session list + timeline + errors + network failures
   - import/export session packs (V3+)

### Data flow
- Extension → (WebSocket) → Server → SQLite
- LLM → (MCP tool call) → Server → (SQLite query **or** on-demand capture request to extension) → tool response

---

## 4) “Light in DB, heavy on-demand”

### Always stored (lightweight, indexable, always useful)
- Session metadata (sessionId, tabId, UA, viewport, timestamps)
- Navigation events (url, title, timestamp)
- Console events: `error/warn` (+ stack, source position) with fingerprinting
- Runtime errors: `window.onerror`, `unhandledrejection`
- Network metadata (no body): method, url, status, duration, initiator, error class
- Minimal user journey (event type + target selector + timestamp; **no typed text**)
- Element references (robust selectors from click/inspect)

### On-demand (heavy, requested via MCP)
- DOM subtree (or document outline)
- Full DOM (explicit request only, strict limits)
- Computed styles for specific properties
- Layout metrics (bounding boxes, visibility reasoning, z-index/stacking hints)
- Screenshot (optional)
- (Future) performance trace

---

## 5) Security, privacy, and guardrails

### Default: SAFE MODE (always ON in V1)
- NO cookie capture
- NO response body capture
- NO localStorage/sessionStorage capture
- NO typed text (input values)
- NO full DOM stored in DB
- Network = metadata only

### Domain allowlist
- The extension captures only on explicitly allowed domains.
- Default allowlist is empty (must be configured).

### Redaction
- Mask common patterns:
  - `Authorization: Bearer ...`
  - JWT-like strings (`xxxxx.yyyyy.zzzzz`)
  - tokens in query strings (`token=`, `key=`, `session=`)
- Every MCP response includes `redactionSummary` (counts/masks applied).

### Guardrails for heavy tools
Every heavy tool must support:
- `maxBytes` (hard cap)
- `maxDepth` / `maxNodes` (DOM-related)
- `timeoutMs`
- “outline mode” fallback if limits are exceeded

---

## 6) Tech stack

### Language
- **TypeScript** (server, extension, shared libraries)

### Monorepo
- **Nx** (monorepo orchestration)
- **pnpm** (workspace)
- Nx targets for build/test/lint/pack

### Extension build
- **Vite** (fast bundling, MV3-friendly)
- React is **not required** for V1

### Server
- **Node.js LTS**
- HTTP: **Fastify** (recommended) or Express
- WebSocket: `ws`
- Validation/schema: `zod`

### Database
- **SQLite**
- Driver: `better-sqlite3` (recommended) or equivalent

### Testing
- `vitest`
- Integration tests for:
  - WS ingest with mocked event stream
  - MCP tool responses (limits, redaction, correctness)

---

## 7) Repository structure (Nx)

> Note: this is the project-only structure (no workflow/loop-specific files).

```
/
  apps/
    mcp-server/
      src/
      project.json
    chrome-extension/
      src/
      public/             # manifest.json, icons
      project.json
    viewer/               # optional (V3+)
      src/
      project.json
  libs/
    shared/
      src/
      project.json
    redaction/
      src/
      project.json
    selectors/
      src/
      project.json
    mcp-contracts/        # optional but recommended
      src/
      project.json
  docs/
    PROJECT_INFOS.md
    SECURITY.md
  nx.json
  package.json
  pnpm-lock.yaml
  tsconfig.base.json
```

### Nx conventions (minimum targets)
For each app/lib:
- `lint`
- `test`
- `build`

Specific:
- `apps/chrome-extension`: `pack` target (installable zip)
- `apps/mcp-server`: `serve` target (dev)

---

## 8) Logging and “how to know it works”

### Extension-side logs (V1)
- Prefixed logs:
  - `[mcpdbg] session started: <id>`
  - `[mcpdbg] ws connected/disconnected`
  - `[mcpdbg] sent batch size=N dropped=M`
- Health ping:
  - server → `PING`, extension → `PONG`
  - popup shows connection status

### Server-side logs (V1)
- Structured logs:
  - WS connections
  - ingest rate
  - parsing/schema errors
  - MCP tool calls + duration
- Endpoints:
  - `GET /health` (OK + db connected)
  - `GET /stats` (dev only: sessions, events, backlog)

---

## 9) Data model (SQLite) – conceptual

### Core tables
1) `sessions`
- `session_id` (pk)
- `created_at`, `ended_at`
- `tab_id`, `window_id`
- `url_start`, `url_last`
- `user_agent`, `viewport_w`, `viewport_h`, `dpr`
- `safe_mode` (bool), `allowlist_hash`

2) `events`
- `event_id` (pk)
- `session_id` (idx)
- `ts` (idx)
- `type` (idx) — `console|error|network|nav|ui|element_ref`
- `payload_json` (text) — validated via zod (shared schema)

3) `network`
- `request_id` (pk)
- `session_id` (idx)
- `ts_start`, `duration_ms`
- `method`, `url` (idx), `status`
- `initiator` (`fetch|xhr|img|script|other`)
- `error_class` (`timeout|cors|dns|blocked|http_error|unknown`)
- (optional) `response_size_est`

4) `error_fingerprints`
- `fingerprint` (pk)
- `session_id` (idx)
- `count`
- `sample_message`
- `sample_stack`

---

## 10) MCP tools – V1 (light telemetry)

### Core tools
1) `list_sessions({ sinceMinutes?: number })`
2) `get_session_summary({ sessionId })`
   - counts: errors, warnings, networkFails, lastUrl, timeRange
3) `get_recent_events({ sessionId, types?: string[], limit?: number })`
4) `get_navigation_history({ sessionId, limit?: number })`
5) `get_console_events({ sessionId, level?: "error"|"warn"|"info", limit?: number })`
6) `get_error_fingerprints({ sessionId, limit?: number })`
7) `get_network_failures({ sessionId, statusMin?: number, groupBy?: "url"|"status", limit?: number })`
8) `get_element_refs({ sessionId, limit?: number })`

### Common response contract
Every tool response should include:
- `limitsApplied` (limits/timeouts actually used)
- `redactionSummary`
- `sessionId`

---

## 11) MCP tools – V2 (heavy on-demand capture)

9) `get_dom_subtree({ sessionId, selector, depth?: number, maxBytes?: number })`
10) `get_dom_document({ sessionId, mode: "outline"|"html", maxBytes?: number })`
11) `get_computed_styles({ sessionId, selector, properties: string[] })`
12) `get_layout_metrics({ sessionId, selector })`
13) `capture_screenshot({ sessionId, selector?: string, fullPage?: boolean, maxBytes?: number })` (optional)

### Execution model for heavy capture
- Server sends a command to extension via WS:
  - `CAPTURE_DOM_SUBTREE`, `CAPTURE_STYLES`, etc.
- Extension responds with:
  - already reduced/compressed payload
- Server applies additional redaction/limits before returning the tool result

---

## 12) Correlation engine – V3 (differentiator)

### Goal
Connect causally:
**user action → network → errors → UI evidence**

### Tools
14) `explain_last_failure({ sessionId })`
- returns a reasoned timeline:
  - last user action
  - correlated network failures (time window)
  - correlated error fingerprints
  - suggested next evidence to request (e.g., computed styles for selector X)

15) `get_event_correlation({ sessionId, eventId })`
- exposes links between an event and related network/errors

---

## 13) Development phases (with dependencies & deliverables)

### Phase 0 — Nx bootstrap
**Depends on:** none  
**Deliverables**
- Nx workspace working
- Nx projects created: `mcp-server`, `chrome-extension`, `shared`, `redaction`, `selectors`
- Targets:
  - `nx build mcp-server`
  - `nx serve mcp-server`
  - `nx build chrome-extension`
  - `nx run chrome-extension:pack` → installable zip

**Acceptance**
- build and lint pass
- server is runnable
- extension can be installed (unpacked/zip)

---

### Phase 1 — End-to-end light telemetry (V1)
**Depends on:** Phase 0  
**Extension deliverables**
- start/stop session + WS connect
- capture: navigations, runtime errors, console error/warn, minimal user events
- buffering + backpressure (no crashes)

**Server deliverables**
- WS ingest + SQLite persist
- MCP server with core tools (V1)
- `/health` + logging

**Acceptance**
- a session is visible via MCP tools (summary + events)
- console errors and navigation events are persisted and queryable

---

### Phase 2 — Robust network metadata (V1.5/V2)
**Depends on:** Phase 1  
**Deliverables**
- hook fetch/xhr (injected)
- populate `network` table
- tools: `get_network_failures`, `get_network_entry` (metadata only)

**Acceptance**
- failed requests are visible with grouping
- bodies are not captured by default

---

### Phase 3 — Heavy capture on-demand (V2)
**Depends on:** Phase 1 (Phase 2 strongly recommended)  
**Deliverables**
- server→extension commands via WS
- tools: DOM subtree, outline, computed styles, layout metrics
- strict limits + redaction + safe fallback

**Acceptance**
- request “DOM subtree for selector X” returns within `maxBytes`
- computed styles returns only requested properties

---

### Phase 4 — Correlation engine (V3)
**Depends on:** Phase 2 + (preferably) Phase 3  
**Deliverables**
- basic time-window correlation
- tools: `explain_last_failure`, `get_event_correlation`

**Acceptance**
- `explain_last_failure` returns a coherent, actionable timeline

---

### Phase 5 — Export / Viewer (optional)
**Depends on:** Phase 1+  
**Deliverables**
- export session pack (jsonl + manifest)
- minimal viewer UI to browse exports

---

## 14) Default operational decisions
- DB location: SQLite (server-first)
- Safe mode: ON by default
- Allowlist: required
- Full DOM: never stored; only on-demand with strict limits
- React: not required for V1; optional viewer in V3+

---

## 15) Expected outcome
By V2–V3 the LLM can:
- ask “what happened?” → session summary, timeline events, error fingerprints
- ask “why is this UI element invisible?” → computed styles + layout metrics
- ask “why did the API fail?” → grouped network failures, correlated user action
- debug using the **real browser context**, without heavy setup
