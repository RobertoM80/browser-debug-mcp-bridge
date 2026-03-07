# Progress Log
# Ralph uses this file to track completed work across iterations.
# Delete this file when sprint is complete.

## Session Started

### Completed: 2026-02-08
- [Create shared library packages] - COMPLETED
  - Created libs/shared with common types (Session, Event, NetworkEvent, etc.)
  - Created libs/shared schemas with Zod validation schemas
  - Created libs/shared utilities (generateId, formatTimestamp, safeJsonParse, etc.)
  - Created libs/redaction with redaction engine for PII/sensitive data
  - Created libs/redaction patterns for Authorization, JWT, API keys, passwords, etc.
  - Created libs/selectors with DOM selector generation strategies
  - Created libs/selectors with id, data-attribute, class, and tag strategies
  - Created libs/mcp-contracts with MCP tool definitions
  - Created libs/mcp-contracts with Zod schemas for all tool inputs
  - Created libs/mcp-contracts with response type definitions
  - Created project.json and tsconfig files for all 4 libraries
  - Created vitest.config.ts for all 4 libraries
  - All tests pass (21 total across all libs)
  - Installed zod and jsdom dependencies

### Completed: 2026-02-08
- [Create Nx project structure for mcp-server app] - COMPLETED
  - Created apps/mcp-server directory structure
  - Created project.json with build, lint, test, serve targets
  - Created tsconfig.app.json and tsconfig.spec.json
  - Created src/main.ts with Fastify server stub
  - Created src/main.spec.ts with 3 unit tests
  - All tests pass (3/3)
  - Build verified successfully

### Completed: 2026-02-08
- Verified [Create Nx project structure for chrome-extension app] was already complete
  - Created apps/chrome-extension directory with src/ and public/ folders
  - Created project.json with build, lint, test, and pack targets
  - Set up Vite configuration for MV3 extension build
  - Created manifest.json in public/ with MV3 permissions
  - Added stub content script, injected script, and background service worker
  - Fixed TypeScript configuration (removed unavailable types)
  - Created vitest.config.ts for testing
  - Created tsconfig.json for test runner
  - All tests pass (3/3)
  - Build verified successfully

### Completed: 2026-02-08
- Verified [Set up testing infrastructure with Vitest] was already complete
  - Installed vitest@1.6.1 and @vitest/coverage-v8@4.0.18 as dev dependencies
  - Created root vitest.config.ts with shared coverage configuration
  - All apps and libs have individual vitest.config.ts files
  - Created example test files in all projects (6 .spec.ts files total)
  - All tests passing: 6/6 projects pass with 24 total tests
  - pnpm nx run-many -t test works correctly

### Completed: 2026-02-08
- [Implement SQLite database schema and connection] - COMPLETED
  - Created apps/mcp-server/src/db/connection.ts with connection singleton
  - Created apps/mcp-server/src/db/schema.ts with 4 tables (sessions, events, network, error_fingerprints)
  - Created apps/mcp-server/src/db/migrations.ts with migration system
  - Created apps/mcp-server/src/db/index.ts for exports
  - Created apps/mcp-server/src/db/db.spec.ts with 35 unit tests
  - All 38 tests pass (35 db tests + 3 main tests)
  - Schema includes proper indexes and foreign key constraints
  - better-sqlite3 native bindings compiled successfully

### Completed: 2026-02-08
- Verified [Initialize git repository and Nx monorepo workspace with pnpm] was already complete
  - Initialized git repository
  - Created package.json with private: true
  - Installed Nx v20.8.4 and TypeScript
  - Configured pnpm-workspace.yaml with apps/* and libs/* patterns
  - Created root tsconfig.base.json with strict TypeScript settings
  - Created nx.json with build, lint, and test targets
  - Created apps/ and libs/ directories
  - Verified Nx installation works

### Completed: 2026-02-08
- Verified [Implement WebSocket server for event ingestion] was already complete

### Completed: 2026-02-08
- [Implement session management in extension] - COMPLETED
  - Added background session state management and runtime message handlers
  - Implemented start/stop session flow with generated session IDs
  - Added extension-to-server WebSocket connection (`ws://127.0.0.1:3000/ws`)
  - Implemented buffered outbound queue with backpressure and dropped-event tracking
  - Added popup UI controls for start/stop and live session status display
  - Added unit tests for session lifecycle and buffering behavior

### Completed: 2026-02-08
- [Capture navigation and console events] - COMPLETED
  - Implemented navigation capture in content script for init, `pushState`, `replaceState`, `popstate`, and `hashchange`
  - Added bridge forwarding from injected script to background worker via `SESSION_QUEUE_EVENT`
  - Hooked `console.warn` and `console.error` in injected script with structured payloads
  - Captured runtime errors from `window.onerror` and promise failures from `unhandledrejection`
  - Added unit tests for content-script navigation/forwarding and injected-script console/error capture

### Completed: 2026-02-08
- [Implement redaction engine for sensitive data] - COMPLETED
  - Added token redaction support alongside authorization, JWT, API key, and password redaction patterns
  - Applied recursive redaction to all outbound extension messages in `SessionManager`
  - Added `withRedactionSummary` helper and default summary contract for all MCP tool responses
  - Added unit tests for token pattern redaction, extension outbound-event redaction, and MCP response redaction summaries
  - Verified full test suite via `pnpm test` (all projects passing)

### Completed: 2026-02-08
- [Implement domain allowlist and safe mode controls] - COMPLETED
  - Added extension capture config storage with normalized allowlist + safe mode defaults
  - Implemented domain allowlist matching logic (exact + wildcard) used for session start and event capture decisions
  - Added safe mode controls to popup UI (toggle, allowlist input, and save action)
  - Enforced safe mode payload restrictions for cookies, storage fields, and input values
  - Added unit tests for allowlist parsing/matching, safe mode redaction, and config persistence

### Completed: 2026-02-08
- Verified [Implement robust selector generation] was already complete

### Completed: 2026-02-08
- [Capture network request metadata] - COMPLETED
  - Added network capture hooks for `fetch` and `XMLHttpRequest` in injected script
  - Captured method, URL, status, duration, initiator, response size estimate, and timestamp
  - Added network error classification for timeout, cors, dns, blocked, and http_error
  - Verified network events continue flowing through background session queue to server persistence
  - Added unit tests for fetch success, fetch failure classification, and xhr capture
  - Ran `pnpm test` successfully (all projects passing)

### Completed: 2026-02-08
- [Implement error fingerprinting and aggregation] - COMPLETED
  - Added deterministic fingerprinting utility using a message+stack SHA-256 hash (`fp-<hash>`)
  - Updated event ingestion to compute fingerprints when missing and upsert into `error_fingerprints`
  - Verified aggregation increments count for repeated errors while keeping sample message/stack
  - Added unit tests for fingerprint stability, stack sensitivity, and repository aggregation behavior
  - Ran `pnpm test` successfully (all projects passing)

### Completed: 2026-02-08
- [Capture minimal user journey events] - COMPLETED
  - Added click capture in content script with selector generation and timestamp-only payloads
  - Forwarded click events through existing `SESSION_QUEUE_EVENT` flow to background/session WebSocket pipeline
  - Verified no typed text or input values are captured in click payloads
  - Added unit tests for click capture payload shape and sensitive-value exclusion
  - Added WebSocket integration test to verify click events persist in SQLite `events` as user journey data

### Completed: 2026-02-08
- [Implement MCP server foundation] - COMPLETED
  - Added `@modelcontextprotocol/sdk` dependency to `apps/mcp-server`
  - Implemented MCP stdio runtime in `apps/mcp-server/src/mcp/server.ts`
  - Added tool registration for all planned MCP tool names with input schemas
  - Added tool routing with default not-implemented handlers and structured error responses
  - Added common response contract fields (`sessionId`, `limitsApplied`, `redactionSummary`)
  - Added unit tests for MCP runtime initialization, registration, routing, and unknown-tool handling
  - Verified with `pnpm test` (all projects passing)

### Completed: 2026-02-08
- [Implement V1 MCP query tools] - COMPLETED
  - Implemented live handlers for `list_sessions`, `get_session_summary`, `get_recent_events`, `get_navigation_history`, and `get_console_events`
  - Added SQLite-backed filtering, session summaries, event type mapping, and response limit/truncation behavior
  - Added integration tests covering all five V1 query tools against an initialized in-memory database
  - Updated MCP runtime to register V1 handlers by default while keeping non-V1 tools as not implemented
  - Verified with `pnpm test` (all projects passing)

### Completed: 2026-02-08
- [Implement error and network query tools] - COMPLETED
  - Implemented `get_error_fingerprints` with session/time filtering plus `limit`/`offset` pagination
  - Implemented `get_network_failures` with failure classification and grouping by `url`, `errorType`, or `domain`
  - Implemented `get_element_refs` selector-based lookup across `ui` and `element_ref` events
  - Added consistent pagination metadata to MCP query responses and extended query input schemas with `limit`/`offset`
  - Added unit/integration tests for error fingerprints, grouped network failures, and element ref lookup
  - Verified with `pnpm test` (all projects passing)

### Completed: 2026-02-08
- [Implement heavy capture on-demand (V2)] - COMPLETED
  - Added bidirectional WebSocket capture protocol messages (`capture_command` / `capture_result`) with typed command payloads
  - Implemented server-side capture command dispatch in `WebSocketManager` with timeout handling and pending request tracking
  - Added extension command handling pipeline: server command -> background -> content script capture execution -> response back over WebSocket
  - Implemented heavy capture logic for DOM subtree/document (with maxBytes/maxDepth controls and outline fallback), computed styles, and layout metrics
  - Added V2 MCP tool handlers (`get_dom_subtree`, `get_dom_document`, `get_computed_styles`, `get_layout_metrics`) with strict limits and html-to-outline fallback on timeout
  - Added/updated unit tests for SessionManager command handling, content script capture execution, WebSocket command roundtrips, and MCP V2 tools
  - Verified with `pnpm test` (all projects passing)

### Completed: 2026-02-08
- [Implement correlation engine tools (V3)] - COMPLETED
  - Implemented time-window correlation scoring for related events and network failures
  - Added `explain_last_failure` with a reasoned timeline and root-cause hint generation
  - Added `get_event_correlation` to link nearby events with correlation scores and relationships
  - Connected user actions to downstream network/error failures in correlation output
  - Added integration-style MCP server tests for both V3 tools
  - Verified with `pnpm test`

### Completed: 2026-02-08
- Verified [Create extension popup UI] was already complete

### Completed: 2026-02-08
- [Add health and debugging endpoints] - COMPLETED
  - Added `GET /stats` endpoint in `apps/mcp-server/src/main.ts` with uptime, memory usage, DB counts, and WebSocket connection metrics
  - Updated `GET /health` to reuse DB status helper and include active WebSocket connection/session data consistently
  - Added structured server-side WebSocket logs for connection lifecycle, message handling, stale connection termination, and capture command dispatch
  - Added structured MCP logging for `list_tools` and `call_tool` requests with start/completion/failure events and durations
  - Added extension-side log prefixes for background/content/injected scripts for easier debugging
  - Added unit test coverage for `/stats` endpoint response shape in `apps/mcp-server/src/main.spec.ts`

### Completed: 2026-02-08
- Verified [Create integration test suite for end-to-end flow] was already complete

### Completed: 2026-02-08
- [Optimize event buffering and backpressure] - COMPLETED
  - Added extension-side event batching in `SessionManager` with configurable batch size and `[mcpdbg] sent batch size=N dropped=M` debug logging
  - Preserved backpressure behavior with bounded queue + oldest-event dropping and warning logs when drops occur
  - Added WebSocket protocol support for `event_batch` messages and server-side ingestion handling
  - Added batched SQLite writes using a single transaction per batch via `EventsRepository.insertEventsBatch`
  - Added/updated unit and integration tests for extension batch emission and server batch ingestion/persistence
  - Measured verification by running `pnpm test` (all 6 projects passing, 107 tests total)

### Completed: 2026-02-08
- [Create documentation and usage guides] - COMPLETED
  - Added root `README.md` with installation, setup, extension loading, and docs map
  - Added root `SECURITY.md` with privacy defaults, redaction policy, and guardrails
  - Added `docs/MCP_TOOLS.md` with V1/V2/V3 tool references and request examples
  - Added `docs/TROUBLESHOOTING.md` with startup, connection, testing, and diagnostics guidance
  - Added `docs/ARCHITECTURE_DECISIONS.md` to record key architectural decisions and tradeoffs
  - Added unit tests in `libs/shared/src/lib/documentation.spec.ts` to verify required docs exist and contain expected content

### Completed: 2026-02-08
- [Build full and comprehensive documentation platform with Docusaurus using a GitHub Docs-style structure] - COMPLETED
  - Added Nx `docs` application in `apps/docs` with serve/build/lint/ci targets
  - Added Docusaurus configuration with generated sidebars, local full-text search, and custom theming
  - Added structured docs sections: Getting Started, Architecture, MCP Tools, Extension, Server, Security & Privacy, Testing, Troubleshooting, FAQ, and Contributing
  - Migrated project and tool guidance into docs pages and linked troubleshooting plus workflow playbooks
  - Added reusable MDX components for note, warning, and limit callouts
  - Added docs quality gates with markdown linting, internal link checking, and CI docs verification target
  - Added documentation unit test coverage for Docusaurus platform presence and core page content

### Completed: 2026-02-20
- [Add snapshot capture controls with opt-in policy and recommended defaults] - COMPLETED
  - Extended extension capture configuration with snapshot settings (manual enable toggle, request opt-in gate, mode/style selectors, trigger list, PNG policy limits)
  - Added normalization and validation for snapshot settings with safe defaults (DOM + computed-lite, click/manual triggers, PNG off by default)
  - Added popup UI controls for snapshot settings in `popup.html` and `popup.css`, with persistence through existing save flow
  - Added unit tests for snapshot config normalization, bounds enforcement, and opt-in gating in `capture-controls.spec.ts`
  - Verified with `pnpm test` (all projects passing)

### Completed: 2026-02-20
- [Capture timestamped UI snapshots in extension for DOM, CSS, and optional PNG] - COMPLETED
  - Added `CAPTURE_UI_SNAPSHOT` command handling in content script and session manager command parsing
  - Implemented DOM snapshot capture with max byte limits, outline fallback, and truncation metadata
  - Added computed style chain capture for target plus ancestors with `computed-lite` default and explicit `computed-full` gating
  - Implemented optional PNG capture in background with throttle, per-session quota, and max-bytes enforcement
  - Emitted `ui_snapshot` records with timestamp, trigger, selector/url, mode, command/session IDs, and truncation metadata
  - Added/updated unit tests in `content-script.spec.ts` and `session-manager.spec.ts`
  - Verified with `pnpm test` (all projects passing)

### Completed: 2026-02-20
- [Persist snapshots in server storage with DB metadata and asset references] - COMPLETED
  - Added snapshot persistence schema (`snapshots` table + indexes) and migration v3 in `apps/mcp-server/src/db/schema.ts` and `apps/mcp-server/src/db/migrations.ts`
  - Implemented bounded snapshot write/list utilities with explicit payload limit errors and PNG asset file persistence in `apps/mcp-server/src/retention.ts`
  - Added server ingestion/read APIs `POST /sessions/:sessionId/snapshots` and `GET /sessions/:sessionId/snapshots` in `apps/mcp-server/src/main.ts`
  - Integrated retention cleanup with orphan snapshot asset pruning and added WebSocket `ui_snapshot` ingestion path to persist captured snapshots
  - Added unit/integration tests for schema/migration coverage, snapshot API behavior, payload limit validation, and orphan asset cleanup in `db.spec.ts`, `main.spec.ts`, and `retention.spec.ts`
  - Verified with `pnpm test` (all 6 projects passing)

### Completed: 2026-02-20
- [Support snapshot export/import with single-file packaging and compatibility mode] - COMPLETED
  - Added snapshot-aware export payloads and compatibility JSON mode with optional base64 PNG embedding in `apps/mcp-server/src/retention.ts`
  - Added zip package export/import (`manifest.json` + PNG assets), asset integrity checks, and deterministic snapshot import ordering in `apps/mcp-server/src/retention.ts`
  - Updated server routes to support format-aware export and zip import payloads in `apps/mcp-server/src/main.ts`
  - Updated extension export/import UX and messaging to handle zip packages in `apps/chrome-extension/src/popup.ts`, `apps/chrome-extension/src/db-viewer.ts`, and `apps/chrome-extension/public/popup.html`
  - Added unit/integration coverage for JSON compatibility export, zip roundtrip import/export, and missing-asset failures in `apps/mcp-server/src/retention.spec.ts` and `apps/mcp-server/src/main.spec.ts`
  - Verified with `pnpm test` (all 6 projects passing)

### Completed: 2026-02-20
- [Expose snapshot timeline and binary asset retrieval through MCP with safe limits] - COMPLETED
  - Added MCP tool contracts and schemas for `list_snapshots`, `get_snapshot_for_event`, and `get_snapshot_asset` in `libs/mcp-contracts/src/lib/tool-definitions.ts` and `libs/mcp-contracts/src/lib/tool-schemas.ts`
  - Implemented metadata-first snapshot timeline queries with trigger/time filters and pagination limits in `apps/mcp-server/src/mcp/server.ts`
  - Implemented event-to-snapshot correlation (`trigger_event_id` first, nearest timestamp fallback) in `apps/mcp-server/src/mcp/server.ts`
  - Implemented explicit bounded PNG asset retrieval with chunking, offset paging, and optional base64 output in `apps/mcp-server/src/mcp/server.ts`
  - Added unit/integration MCP tests for snapshot listing, event correlation lookup, and chunked asset retrieval in `apps/mcp-server/src/mcp/server.spec.ts`
  - Documented ingestion-vs-read contract and V4 snapshot MCP workflow in `apps/docs/docs/mcp-tools/v4-snapshot-tools.md` and `apps/docs/docs/mcp-tools/overview.md`

### Completed: 2026-02-20
- [Apply snapshot-specific privacy and redaction policy for DOM, CSS, and PNG] - COMPLETED
  - Added snapshot privacy configuration profile (`strict`/`standard`) with secure strict defaults in `apps/chrome-extension/src/capture-controls.ts`
  - Added selector- and attribute-aware snapshot redaction utility in `libs/redaction/src/lib/snapshot-redaction.ts` and exported it via `libs/redaction/src/index.ts`
  - Applied snapshot redaction before enqueueing `ui_snapshot` events and enforced strict safe-mode PNG blocking with redaction metadata in `apps/chrome-extension/src/background.ts`
  - Added snapshot sensitivity hints in `apps/chrome-extension/src/content-script.ts` to support deterministic selector-based masking decisions
  - Added/updated unit tests for privacy profile normalization and snapshot DOM/style/PNG redaction paths in `apps/chrome-extension/src/capture-controls.spec.ts` and `libs/redaction/src/lib/redaction-engine.spec.ts`
  - Verified with `pnpm test` (all 6 projects passing)

### Completed: 2026-02-20
- [Validate snapshot feature end-to-end with quotas, privacy, export, and MCP retrieval] - COMPLETED
  - Added snapshot capture policy helper module in `apps/chrome-extension/src/snapshot-capture.ts` and covered trigger/mode normalization, computed-full gating, PNG throttle, and quota behavior in `apps/chrome-extension/src/snapshot-capture.spec.ts`
  - Kept extension background capture flow aligned by reusing helper logic for trigger/mode resolution and PNG throttle/quota enforcement in `apps/chrome-extension/src/background.ts`
  - Added MCP integration test to validate click -> snapshot lookup -> failure timeline reconstruction in `apps/mcp-server/src/mcp/server.spec.ts`
  - Extended `docs/TROUBLESHOOTING.md` with snapshot-specific diagnosis guidance for opt-in, throttle/quota, truncation, privacy redaction, and MCP verification flow
  - Marked `PRD-107` as passing in `prd.json`

### Completed: 2026-03-07
- [Extend the existing live-session command pipeline so MCP can execute UI actions inside the currently bound extension session without opening any new browser session] - COMPLETED
  - Added shared live-action request/result schemas and trace-id helper in `libs/mcp-contracts/src/lib/live-actions.ts`
  - Extended websocket and extension command contracts to accept `EXECUTE_UI_ACTION` alongside the existing live-session command channel
  - Added extension-side policy checks for bound tabs and allowlist enforcement before forwarding live UI actions to the active session tab
  - Added top-document-only V1 rejection handling with structured action results including action, traceId, timestamps, target summary, and failure reason in `apps/chrome-extension/src/content-script.ts`
  - Added unit/integration coverage for contract parsing, session-manager command handling, content-script result shape, and websocket round-trips
  - Verified with `pnpm test`, `pnpm nx run-many -t lint`, and `pnpm nx run-many -t build`

### Completed: 2026-03-07
- [Add explicit user controls, second opt-in for sensitive fields, and visible warnings for dangerous live automation] - COMPLETED
  - Added persistent automation settings in `apps/chrome-extension/src/capture-controls.ts` with safe defaults: live automation OFF and sensitive-field automation OFF
  - Added popup controls, warning copy, live automation status, and an emergency-stop button in `apps/chrome-extension/public/popup.html`, `apps/chrome-extension/public/popup.css`, and `apps/chrome-extension/src/popup.ts`
  - Extended background config sync in `apps/chrome-extension/src/background.ts` so active session tabs receive automation policy/status updates, live actions are blocked unless enabled, sensitive selectors require the second opt-in, and emergency stop disables automation immediately
  - Added a red in-page automation indicator with an emergency-stop action in `apps/chrome-extension/src/content-script.ts` plus extension badge state for armed/executing automation
  - Added unit coverage for automation config normalization and indicator behavior in `apps/chrome-extension/src/capture-controls.spec.ts` and `apps/chrome-extension/src/content-script.spec.ts`
  - Verified with `pnpm test`, `pnpm nx run-many -t lint`, and `pnpm nx run-many -t build`

### Completed: 2026-03-07
- [Implement the async extension-side executor for real page interaction inside the existing debug session] - COMPLETED
  - Replaced the placeholder live-action rejection path in `apps/chrome-extension/src/content-script.ts` with a real top-document executor for `click`, `input`, `focus`, `blur`, `scroll`, `press_key`, and `submit`
  - Added realistic DOM event dispatch plus editable-field mutation so page code observes the same interaction flow as live users, while keeping input results redacted to metadata only
  - Routed `reload` through the background layer in `apps/chrome-extension/src/background.ts` so the active bound tab reloads without introducing a new browser session
  - Added unit coverage for successful live-action execution and non-editable target rejection in `apps/chrome-extension/src/content-script.spec.ts`
  - Verified with `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, and `pnpm test:e2e`

### Completed: 2026-03-07
- [Persist V1 automation activity using the existing events table with explicit automation event types] - COMPLETED
  - Added automation lifecycle payload builders in `apps/chrome-extension/src/automation-events.ts` so requested, started, succeeded, failed, and stopped events persist only redacted metadata for live actions
  - Updated `apps/chrome-extension/src/background.ts` to emit automation lifecycle events during policy rejection, execution start, success/failure completion, and emergency stop
  - Extended event contracts and persistence mapping for `automation_*` event types in `apps/mcp-server/src/websocket/messages.ts`, `apps/mcp-server/src/db/events-repository.ts`, and `libs/shared/src/lib/*`
  - Added unit coverage for automation payload redaction and stop events in `apps/chrome-extension/src/automation-events.spec.ts`, plus server persistence coverage in `apps/mcp-server/src/db/events-repository.spec.ts` and websocket validation coverage in `apps/mcp-server/src/websocket/websocket.spec.ts`
  - Verified with `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `pnpm test:e2e`

### Completed: 2026-03-07
- [Expose live UI automation through MCP so the LLM can drive and debug full flows in the existing session] - COMPLETED
  - Added `execute_ui_action` to MCP contracts and tool discovery in `libs/mcp-contracts/src/lib/tool-definitions.ts`, `libs/mcp-contracts/src/lib/tool-schemas.ts`, and `apps/e2e-playwright/tests/utils/mcp-client.ts`
  - Implemented the MCP handler in `apps/mcp-server/src/mcp/server.ts` to validate typed action payloads, execute actions over the existing live-session command channel, and return structured action/tab context plus failure details
  - Added optional `captureOnFailure` evidence capture that reuses the existing snapshot path when an action is rejected or fails
  - Added MCP server coverage for successful action execution and failure-evidence capture in `apps/mcp-server/src/mcp/server.spec.ts`
  - Documented the new live automation tool contract in `apps/docs/docs/mcp-tools/overview.md` and `apps/docs/docs/mcp-tools/v5-live-automation.md`
  - Verified `pnpm nx test mcp-contracts`, `pnpm nx test mcp-server`, and `pnpm nx build mcp-server`
  - Ran `pnpm test`; it still fails in unrelated existing e2e test `apps/e2e-playwright/tests/full.extension-db.spec.ts` (`Timed out waiting for expected DB entries`)

### Completed: 2026-03-07
- [Validate the extension-native automation flow end-to-end with policy checks, sensitive-field gating, observability, and MCP execution] - COMPLETED
  - Extended Playwright popup coverage in `apps/e2e-playwright/tests/full.extension-ui-controls.spec.ts` to validate live automation arming defaults, saved config state, status messaging, and emergency stop behavior
  - Updated `docs/MCP_TOOLS.md` with the `execute_ui_action` contract, top-document-only limitation, popup opt-ins, emergency stop, and failure evidence behavior
  - Extended `docs/TROUBLESHOOTING.md` with automation-specific rejection and recovery guidance for disabled automation, sensitive-field blocks, iframe limits, and post-failure debugging
  - Expanded `docs/SECURITY.md` with live automation guardrails covering default-off behavior, second opt-in requirements, visible warnings, emergency stop, and input redaction guarantees

### Completed: 2026-03-07
- [Add dedicated automation tables once the action model and result contract stabilize] - COMPLETED
  - Added dedicated `automation_runs` and `automation_steps` schema support in `apps/mcp-server/src/db/schema.ts` with migration/backfill logic in `apps/mcp-server/src/db/migrations.ts`
  - Added `apps/mcp-server/src/db/automation-repository.ts` to dual-write automation lifecycle events into first-class run/step records while keeping the existing `events` timeline intact
  - Updated `apps/mcp-server/src/db/events-repository.ts` to persist automation lifecycle events into both the generic UI event stream and the new dedicated automation tables
  - Added migration/schema/foreign-key coverage in `apps/mcp-server/src/db/db.spec.ts` and dual-write lifecycle coverage in `apps/mcp-server/src/db/events-repository.spec.ts`
  - Verified with `pnpm nx test mcp-server`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`
