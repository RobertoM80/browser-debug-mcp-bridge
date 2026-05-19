# End-to-End Automation Capability Audit

Date: 2026-05-11
Deep audit update: 2026-05-16
Implementation update: 2026-05-19

## Executive Summary

The project has a real-browser live automation feature, but the current implementation is not equivalent to Playwright or Cypress behavior. It reuses the bound Chrome extension session, which is the right product direction, and the primary top-document, open shadow-root, and same-origin iframe actions now use a CDP-backed native execution backend. Frame refs now carry URL/title metadata for stale-id recovery, unsupported cross-origin/sandboxed pointer frames return explicit policy diagnostics, `target.locator` now resolves through the extension's native DOM path for direct/workflow actions with ancestor and same-origin frame-selector composition, and the MCP server now has production-flow preflight plus URL/navigation/navigation-lifecycle/load-state/selector/console/dialog/stable-layout/download/popup/network-quiet/request/response waits. The remaining gaps are narrower locator parity, navigation-grade frame stability, broader frame edge coverage, and the last actionability/diagnostics refinements.

Playwright-like reliability requires browser-level input synthesis, element actionability checks, frame-aware targeting, deterministic waits, and e2e coverage proving actions against real pages. The current feature now has a native action foundation plus useful scaffolding around sessions, safety, history, and workflow orchestration, but it still lacks the complete locator, wait, and edge-case actionability model of a mature browser test runner.

The deep audit added a full-path Playwright spec at `apps/e2e-playwright/tests/full.live-automation.spec.ts`. It proves MCP -> extension -> bound tab execution for top-document click, hover, input, key press, focus, blur, scroll, submit, open shadow-root click, same-origin iframe click/input, nested same-origin iframe click, stale frame-ref recovery, ancestor/frame-selector native locator targeting, `run_ui_steps`, `get_interactive_elements`, native actionability rejections, first-class wait primitives, stale frame diagnostics, and automation-history trace lookup. The implementation now routes `click`, `hover`, `input`, `press_key`, `focus`, `blur`, `scroll`, and `submit` through a CDP-backed native backend (`cdp-native-v2`) in `apps/chrome-extension/src/automation-native.ts`. Same-origin frame and open shadow-root discovery is implemented in `get_page_state` and `get_interactive_elements`. Full DOM locator parity and complete actionability parity still remain open, but the missing wait primitives are no longer the main blocker.

The MCP server now also has an agent loop guard for repeated unchanged tool failures. Attempts are persisted, warnings are attached to responses before the loop becomes expensive, and repeated live automation or override attempts are blocked until real page/session/config state changes.

## Current Capability Map

### Good

- MCP tool surface exists for one-shot actions and workflows:
  - `execute_ui_action`
  - `run_ui_steps`
  - `preflight_automation_flow`
  - `assert_page_state`
  - `wait_for_page_state`
  - `wait_for_url`
  - `wait_for_navigation`
  - `wait_for_load_state`
  - `wait_for_selector_state`
  - `wait_for_console`
  - `wait_for_dialog`
  - `wait_for_stable_layout`
  - `wait_for_network_quiet`
  - `wait_for_request`
  - `wait_for_response`
  - `get_interactive_elements`
  - `list_automation_runs`
  - `get_automation_run`
- Actions run through the existing MCP server -> WebSocket -> Chrome extension -> bound tab path. They do not open a new Chromium/profile.
- Extension-side guardrails exist:
  - automation is off by default
  - sensitive field automation has a second opt-in
  - session tab binding is checked
  - allowlist is checked
  - an in-page indicator and emergency stop exist
- The server can resolve compact semantic targets for direct actions and workflows, run sequential steps, retry once, capture failure evidence, and report structured step diagnostics.
- Automation lifecycle events are persisted into dedicated `automation_runs` and `automation_steps` tables, including native diagnostics JSON for backend, actionability, frame policy, locator resolution, and point metadata when available.
- Automation trace IDs are preserved through extension outbound redaction, so tool responses and history queries can correlate the same run.
- Repeated unchanged live action failures are persisted in `mcp_tool_invocations` and can be blocked through `mcp_loop_incidents` before another identical browser action is sent.
- Documentation describes the current V1 limits clearly: top document and same-origin iframe targets, one action at a time, no new browser runtime.
- `get_page_state` and `get_interactive_elements` discover frame and open shadow-root content and return frame-aware refs with `frameId`, `frameUrl`, `frameTitle`, and frame policy diagnostics.
- Compact semantic targeting now supports role/name, placeholder/alt metadata where captured, frame URL/title filters, exact text matching, `nth`, `first`, `last`, and `strict:false` disambiguation for non-locator semantic targets. `target.locator` now routes direct actions and workflow action steps through extension-side native DOM resolution for `css`, `role`, `text`, `label`, `testId`, `placeholder`, and `altText`, including regex matchers, explicit ancestor/descendant relations, same-origin frame selector paths, and frame filters.

### Not Good Enough

- Click, hover, input, keyboard, focus, blur, scroll, and submit actions now have a CDP-backed native backend for top-document and same-origin iframe targets.
- The native actionability model now covers visibility, disabled state, readonly/editable input policy, pointer-events, viewport intersection, stable layout, offscreen scroll-into-view semantics, detached-target retry, hit-target mismatch diagnostics, shadow-host hit testing, and structured retry metadata, but still needs parity coverage for deeper overlay/pointer-capture cases and some broader frame-action surfaces.
- Same-origin iframe click/input and nested same-origin iframe click are now covered end to end. Cross-origin, sandboxed opaque-origin, or inaccessible iframe pointer actions remain diagnostic because the native click driver must translate frame-local coordinates into top-document CDP coordinates. Native results include `framePolicy` and `frameCoordinateResolved` diagnostics for these cases.
- Targeting supports CSS selectors, frame-aware element refs, open shadow-root selectors, compact semantic matching, and native DOM locator resolution for same-element role/name/exact/regex/positional helpers plus explicit ancestor/descendant relations and same-origin frame-selector composition, but not coordinates, closed shadow DOM, arbitrary selector state, or full locator semantics comparable to modern browser test tools.
- Waits understand compact page-state summaries, URL exact/contains/regex predicates, persisted navigation events, live navigation lifecycle states, live document readiness for `domcontentloaded`/`load`, selector attached/detached/visible/hidden state, live console messages, native JavaScript dialogs, stable layout windows, downloads, popups, bounded persisted network quiet windows, and request/response predicates. The remaining gap is depth of diagnostics and fixture coverage, not missing wait primitives.
- The e2e suite now has a full-path proof for native top-document actions, same-origin iframe click/input, stale frame-ref recovery, ancestor/frame-selector native DOM locator targeting, offscreen scroll success, detached-target retry, common actionability rejections, and the current wait primitives, but does not yet cover Playwright/Cypress parity cases such as closed-shadow/coordinate locators, broad cross-origin/sandboxed frame fixtures, and deeper overlay/actionability edges.
- The remaining compatibility actions and missing actionability/frame/locator/wait features still prevent full Playwright/Cypress parity.

Deep audit update: the full-path action proof now asserts `cdp-native-v2` for click, hover, input, key press, focus, blur, scroll, submit, open shadow-root click, same-origin iframe click/input, nested same-origin iframe click, stale frame-ref recovery, ancestor/frame-selector native DOM locator targeting, offscreen scroll success, detached-target retry, workflow, current first-class waits, and automation-history trace lookup behavior. The remaining coverage gap is deeper actionability edge cases, broader cross-origin/sandboxed frame fixtures, and the remaining locator parity surface.

## Root Cause

The central execution path is:

1. MCP server receives `execute_ui_action`.
2. Server forwards `EXECUTE_UI_ACTION` to the extension through the live capture channel.
3. Extension background validates config/session/allowlist and sends a message to the content script.
4. Extension background uses the CDP-backed native backend for migrated top-document actions, with the older content-script execution path retained as compatibility scaffolding.

That fourth step was the original wrong abstraction for Playwright/Cypress-level behavior. The native backend now performs the primary top-document actions through browser-level input where appropriate, but the engine still needs deeper frame-aware targeting, richer locators, and the remaining parity/diagnostic refinements.

## Specific Findings

### 1. Click Is Now Native for Top-Document Targets

Current native click execution resolves the target, scrolls it into view, checks actionability, hit-tests the click point, translates same-origin frame coordinates when needed, and dispatches mouse input through CDP.

Remaining impact:

- Cross-origin, sandboxed opaque-origin, and inaccessible frame pointer actions are diagnostic rather than executable, with explicit frame policy metadata in the result.
- Deeper parity cases such as detach/retry, unusual overlays, pointer capture, and some scroll edge cases still need coverage.
- Browser features gated behind trusted user activation may still need targeted validation.

### 2. Text Input Is Native Fill-Like Behavior, Not Full Typing Parity

Current native input focuses/selects the editable target and inserts text through CDP. This is materially closer to a browser action than direct value assignment, but it is still fill-like behavior rather than a full typed sequence model.

Impact:

- It does not fully model IME/composition, per-character typing delays, masks, complex selection ranges, or every controlled-input edge case.
- It cannot faithfully model paste, clear, fill, type, select option, upload file, or contenteditable editing.

### 3. Keyboard Input Uses CDP But Needs Broader Semantics

Current key execution uses CDP keyboard events.

Impact:

- Shortcuts, modifiers, repeat behavior, platform-specific mapping, focus movement, and Enter/Tab workflows need broader coverage.

### 4. Frame Support Is Partial

Same-origin iframe actions now execute for the native action set when a caller provides a frame-aware `elementRef` or target `frameId`. Pointer actions translate frame-local coordinates through same-origin iframe elements before CDP dispatch. Nested same-origin iframe click is covered by e2e.

Impact:

- Cross-origin payment/auth fields and sandboxed frame surfaces now get explicit unsupported-frame diagnostics for native pointer actions, but broader real-world fixture coverage is still needed.
- Frame refs can recover from stale ids when URL/title metadata and selector resolution are unique; reload/navigation stability still needs broader coverage.

### 5. Target Resolution Is Too Thin

Current targets are `selector`, frame-aware `elementRef`, open shadow-root selectors, semantic resolution over compact page-state items, or `target.locator` through extension-side DOM resolution for direct/workflow actions. This is a useful locator baseline, not a full DOM locator engine.

Remaining gaps:

- richer first/last/nth strict-mode aliases beyond the compact baseline
- closed shadow DOM policy
- coordinate targets
- test id configuration
- broader ambiguity diagnostics
- action target preview with actionability failure reasons

### 6. Actionability Checks Need More Parity

Before acting, the engine now determines whether the element is actionable for the primary native action path. The remaining gap is parity with mature browser test runners across every edge case.

Remaining checks:

- unusual overlay and pointer-capture cases
- zero-size and obscured-hit-target edge diagnostics
- animation and layout-stability windows beyond the current short retry loop
- editable checks including contenteditable and ARIA states
- broader frame-action surfaces where top-document coordinate translation is unavailable

### 7. Wait Model Has First-Class Primitives But Still Needs Deeper Diagnostics

`wait_for_page_state` and workflow `waitFor` steps poll compact state. The dedicated wait engine now adds standalone and workflow waits for URL, persisted navigation events, navigation lifecycle states, document load state, selector state, console messages, native JavaScript dialogs, stable layout windows, downloads, popups, network quiet windows, requests, and responses. This is now production-useful for common flows, but not enough for full e2e parity.

Remaining wait gaps:

- expect-style assertions with richer diagnostics
- deeper timeout evidence for long-running waits
- broader cross-origin and sandboxed fixture coverage for the current wait set

### 8. E2E Coverage Proves the Core Path But Still Has Gaps

The current tests around automation are strong at lower layers:

- content-script unit tests prove DOM event dispatch
- MCP server tests prove routing/response shape
- popup e2e tests prove settings controls
- database tests prove history persistence

There is now a strong Playwright fixture proving the end-to-end MCP path for the core native action and wait set. The remaining coverage gaps are:

- broader cross-origin and sandboxed frame fixtures
- closed-shadow and coordinate-target locator gaps
- deeper overlay and pointer-capture actionability edges
- broader timeout and diagnostic assertions for wait failures
- more explicit history assertions for linked failure evidence and raw CDP errors

## Refactor Recommendation

### Direction

Keep the real-browser/extension architecture. Replace the content-script event simulation engine with a browser-level action driver in the extension background using Chrome DevTools Protocol where possible.

The extension already uses `chrome.debugger` for the override feature. The automation feature should use the same real-tab CDP attachment model for actions:

- `Input.dispatchMouseEvent`
- `Input.dispatchKeyEvent`
- `Runtime.evaluate` for bounded element lookup/actionability metadata
- `DOM.getDocument`, `DOM.querySelector`, `DOM.describeNode`, `DOM.getBoxModel` where useful
- `Page.navigate` / tab reload for navigation actions
- `Runtime.callFunctionOn` only for safe inspection and fallback operations, not primary click/key synthesis

This still does not open a new browser. It attaches to and drives the existing bound tab.

### Proposed Architecture

Introduce a dedicated automation engine with clear layers:

1. `AutomationController` in extension background
   - owns one action at a time
   - manages CDP attach/detach/reuse
   - enforces emergency stop
   - emits lifecycle events

2. `TargetResolver`
   - resolves selector, elementRef, role/name/text/testId, coordinates, and frame targets
   - returns a stable target descriptor, frame context, backend node/object id, bounding box, and sampled diagnostics
   - current compact MCP-side target resolution is extracted to `apps/mcp-server/src/mcp/target-resolution.ts`; direct/workflow locator actions now use extension-side native DOM resolution with explicit ancestor/descendant relations and same-origin frame-selector composition, while closed-shadow/coordinate/state gaps remain

3. `ActionabilityChecker`
   - computes visibility, enabled/editable state, viewport, hit target, stability, and scroll requirements
   - returns structured failure codes before action execution

4. `NativeInputDriver`
   - sends CDP mouse/keyboard events
   - handles scroll into view
   - supports click, double click, hover, type, press, fill, clear, select option

5. `WaitEngine`
   - keeps current page-state waits
  - now includes URL, persisted navigation-event, navigation-lifecycle, document load-state, selector-state, console, dialog, stable-layout, download, popup, network-quiet, request, and response waits
  - still needs better timeout diagnostics and broader fixture coverage
   - can be reused by `execute_ui_action.waitFor...` and `run_ui_steps`

6. `AutomationDiagnostics`
   - persists actionability failures, resolved target data, frame policy, locator resolution, backend, point metadata, and linked failure evidence/snapshot/CDP metadata into automation history
   - still needs broader end-to-end assertions and some deeper raw CDP error coverage

### Phased Plan

#### Phase 1: Prove Real E2E Path

- Add Playwright fixture page with buttons, inputs, disabled/covered/offscreen targets, form submit, URL change, iframe, and network call.
- Add full e2e tests that call MCP tools against the running extension session.
- Include tests for success and expected failure diagnostics.

This phase should happen before the big refactor so regressions are visible.

#### Phase 2: Move Click to CDP

- Implement CDP attach/reuse for automation actions.
- Resolve selector/elementRef to center point in the correct frame.
- Scroll into view.
- Hit-test center point.
- Dispatch mouse move/down/up via CDP.
- Record actionability diagnostics.
- Keep content-script click as a temporary fallback behind an explicit compatibility path.

#### Phase 3: Move Keyboard and Input to CDP

- Implement `press_key` via `Input.dispatchKeyEvent`.
- Split `input` into explicit `fill` semantics internally:
  - focus target
  - select existing text
  - type characters or set value only as controlled fallback
- Add `clear`, `type`, and `select_option` as new actions if the product wants Playwright-style coverage.

#### Phase 4: Frame-Aware Targeting

- Track frame tree and execution contexts.
- Include frame metadata in page-state and element refs. Baseline same-origin discovery is implemented.
- Allow actions in iframes when the session/allowlist permits it. Baseline same-origin iframe actions are implemented.
- Make unsupported sandbox/cross-origin cases diagnostic, not generic failure.

#### Phase 5: Locator and Wait Upgrade

- Add full locator semantics beyond the compact role/name/exact/positional baseline.
- Add full strict target resolution modes for semantic locators. Baseline `strict:false`, `first`, `last`, and `nth` are implemented for compact page-state refs and native DOM locator action targets.
- Add workflow wait kinds for broader navigation lifecycle semantics, layout stability, dialogs, downloads, and popups. URL, persisted navigation-event, navigation-lifecycle, document load-state, selector-state, console, native JavaScript dialog, stable-layout, download, popup, network-quiet, request, and response waits now exist.
- Add better failure suggestions based on actual actionability failures.

#### Phase 6: Documentation and Tool Contract Cleanup

- Update docs so the capability contract is explicit:
  - V1 DOM-simulated actions, or
  - V2 CDP-backed native input actions
- Remove confusing API affordances until implemented, or mark them as unsupported in schema descriptions.
- Document when real-browser constraints differ from isolated Playwright contexts.

## Priority Fix List

1. Add true full-path e2e tests for `execute_ui_action` and `run_ui_steps`.
2. Replace click execution with CDP `Input.dispatchMouseEvent`.
3. Add actionability checks and structured failure codes.
4. Add frame-aware target resolution and frame-ref discovery.
5. Replace synthetic keyboard with CDP keyboard events.
6. Expand waits beyond the current page-state, URL, navigation-event, selector-state, console, network-quiet, request, and response primitives.
7. Add locator semantics beyond raw CSS selectors and element refs.
8. Persist richer diagnostics into automation history.

Status update:

- Items 1, 2, 4, and 5 now have baseline implementation and e2e coverage for top-document and same-origin iframe actions, including stale frame-ref recovery by URL/title metadata.
- Item 3 has a first actionability baseline for native targets, including disabled, hidden, pointer-events none, and covered-target diagnostics.
- Item 7 has extension-side native DOM locator resolution for role/name/exact/regex/positional same-element filters plus open shadow-root selectors, ancestor/descendant relations, and same-origin frame-selector composition. The MCP-side resolver is isolated behind focused unit tests, but full DOM locator parity is still open.
- Item 8 has baseline full-path history persistence, trace lookup, native action diagnostics, and linked failure evidence/snapshot/CDP metadata in diagnostics.
- Item 6 has the wait-engine slice for URL, navigation-event, navigation-lifecycle, document load-state, selector-state, console, dialog, stable-layout, download, popup, network-quiet, request, and response waits, including workflow integration. Remaining scope is narrower locator parity, broader frame edge coverage, navigation-grade frame stability, deeper wait diagnostics, and broader raw CDP failure coverage.

## Additional Tests To Add

The new full-path spec should be expanded after the native-input refactor starts. Recommended additions:

1. Click actionability: deeper overlay/pointer-capture cases, zero-size edge diagnostics, and broader cross-origin frame surface coverage.
2. Native input: type/fill/clear, selection replacement, masked input, controlled React-style input, contenteditable, Enter/Tab behavior.
3. Keyboard: shortcuts, modifiers, Tab focus movement, Enter submit, non-character keys.
4. Frames: broader cross-origin/sandboxed fixture coverage, multi-match frame ambiguity diagnostics, and frame ref stability across reload/navigation beyond the current URL/title recovery baseline.
5. Locators: closed shadow DOM policy, coordinate targets, arbitrary selector state, and richer ambiguity diagnostics beyond the current ancestor/descendant/frame-selector native locator baseline.
6. Waits: deeper timeout/diagnostic e2e coverage and broader cross-origin/sandboxed fixture coverage for the current wait set.
7. Diagnostics/history: broader end-to-end assertions for linked failure evidence and deeper raw CDP failure metadata after real MCP-triggered actions.
8. Safety: automation disabled, sensitive-field opt-in, unbound tab, disallowed URL, emergency stop during a long action.

## Compatibility Notes

The current DOM-simulation path should not be deleted immediately. It can remain as:

- a fallback for pages where CDP attach is unavailable
- a clearly labeled compatibility mode
- a test harness path for jsdom/unit tests

But it should not be the default path if the product goal is Playwright/Cypress-like behavior.

## Final Assessment

This feature does not need to open a new Chromium instance. The existing architecture supports real-browser top-document, open shadow-root, and same-origin iframe automation now, including frame-aware refs from page-state capture, stale frame-ref recovery, ancestor/frame-selector native locator targeting, explicit unsupported-frame diagnostics, production-flow preflight, and first-class URL/navigation-event/navigation-lifecycle/load-state/selector/console/dialog/stable-layout/download/popup/network-quiet/request/response waits. The big remaining pieces are narrower locator parity, deeper diagnostics coverage, navigation-grade frame stability, broader frame edge coverage, and the last actionability edge cases.

This is a meaningful refactor, not a small bug fix.
