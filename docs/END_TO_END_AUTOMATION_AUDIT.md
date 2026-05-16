# End-to-End Automation Capability Audit

Date: 2026-05-11
Deep audit update: 2026-05-16
Implementation update: 2026-05-16

## Executive Summary

The project has a real-browser live automation feature, but the current implementation is not equivalent to Playwright or Cypress behavior. It reuses the bound Chrome extension session, which is the right product direction, and the primary top-document plus same-origin iframe actions now use a CDP-backed native execution backend. The remaining gaps are cross-origin/sandboxed frame policy, locator parity, stronger waits, nested frame stability, and broader actionability diagnostics.

Playwright-like reliability requires browser-level input synthesis, element actionability checks, frame-aware targeting, deterministic waits, and e2e coverage proving actions against real pages. The current feature has useful scaffolding around sessions, safety, history, and workflow orchestration, but the action engine is still closer to "dispatch events into the DOM" than "perform the user action the browser would perform."

The 2026-05-16 deep audit added a full-path Playwright spec at `apps/e2e-playwright/tests/full.live-automation.spec.ts`. It proves MCP -> extension -> bound tab execution for top-document click, input, key press, focus, blur, scroll, submit, same-origin iframe click/input, `run_ui_steps`, `get_interactive_elements`, native actionability rejections, stale frame diagnostics, and automation-history trace lookup. The first implementation slice now routes `click`, `input`, `press_key`, `focus`, `blur`, `scroll`, and `submit` through a CDP-backed native backend (`cdp-native-v2`) in `apps/chrome-extension/src/automation-native.ts`. Same-origin frame discovery is implemented in `get_page_state` and `get_interactive_elements`. Cross-origin frame policy, richer locators, broader waits, and complete actionability parity remain open.

## Current Capability Map

### Good

- MCP tool surface exists for one-shot actions and workflows:
  - `execute_ui_action`
  - `run_ui_steps`
  - `assert_page_state`
  - `wait_for_page_state`
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
- Automation lifecycle events are persisted into dedicated `automation_runs` and `automation_steps` tables, which is the right basis for historical debugging.
- Automation trace IDs are preserved through extension outbound redaction, so tool responses and history queries can correlate the same run.
- Documentation describes the current V1 limits clearly: top document and same-origin iframe targets, one action at a time, no new browser runtime.
- `get_page_state` and `get_interactive_elements` discover same-origin frame content and return frame-aware refs with `frameId` and `frameUrl`.

### Not Good Enough

- Click, input, keyboard, focus, blur, scroll, and submit actions now have a CDP-backed native backend for top-document and same-origin iframe targets.
- The native actionability model now covers visibility, disabled state, readonly/editable input policy, pointer-events, viewport intersection, stable layout, and hit-target mismatch diagnostics, but still needs parity coverage for offscreen scroll semantics, detached targets, overlay edge cases, and retry-on-detach.
- Same-origin iframe click/input is now covered end to end. Cross-origin or inaccessible iframe pointer actions remain diagnostic because the native click driver must translate frame-local coordinates into top-document CDP coordinates.
- Targeting supports CSS selectors, frame-aware element refs, and compact semantic matching, but not coordinates, roles, accessible names, chained locators, nth/first/last, shadow DOM, or strict/non-strict semantics comparable to modern browser test tools.
- Waits understand compact page-state summaries, including visible/hidden structured refs. They cannot wait for network idle, navigation lifecycle, URL exact/regex, response predicates, arbitrary element attached/detached, animation stability, or console/request side effects as first-class workflow steps.
- The e2e suite now has a full-path proof for native top-document actions, same-origin iframe click/input, and common actionability rejections, but does not yet cover Playwright/Cypress parity cases such as cross-origin frame policy, locator semantics, richer waits, and deeper actionability edges.
- The remaining compatibility actions and missing actionability/frame/locator/wait features still prevent full Playwright/Cypress parity.

Deep audit update: the full-path action proof now asserts `cdp-native-v2` for click, input, key press, focus, blur, scroll, submit, and same-origin iframe click/input using frame refs returned by `get_interactive_elements`. It also asserts direct semantic action targeting, visible/hidden page-state assertions, readonly input rejection, disabled, hidden, pointer-events none, covered target, stale frame, workflow, and automation-history trace lookup behavior. The remaining coverage gap is deeper actionability edge cases, cross-origin/sandboxed frame policy, nested frame stability, full locator parity, and richer waits.

## Root Cause

The central execution path is:

1. MCP server receives `execute_ui_action`.
2. Server forwards `EXECUTE_UI_ACTION` to the extension through the live capture channel.
3. Extension background validates config/session/allowlist and sends a message to the content script.
4. Extension background uses the CDP-backed native backend for migrated top-document actions, with the older content-script execution path retained as compatibility scaffolding.

That fourth step was the original wrong abstraction for Playwright/Cypress-level behavior. The native backend now performs the primary top-document actions through browser-level input where appropriate, but the engine still needs frame-aware targeting, richer locators, and stronger waits.

## Specific Findings

### 1. Click Is Now Native for Top-Document Targets

Current native click execution resolves the target, scrolls it into view, checks actionability, hit-tests the click point, translates same-origin frame coordinates when needed, and dispatches mouse input through CDP.

Remaining impact:

- Cross-origin and inaccessible frame pointer actions are diagnostic rather than executable.
- Deeper parity cases such as detach/retry, unusual overlays, pointer capture, nested frames, and some scroll edge cases still need coverage.
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

Same-origin iframe actions now execute for the native action set when a caller provides a frame-aware `elementRef` or target `frameId`. Pointer actions translate frame-local coordinates through same-origin iframe elements before CDP dispatch.

Impact:

- Cross-origin payment/auth fields and sandboxed frame surfaces still need explicit policy and diagnostics.
- Nested frame stability and cross-origin/sandboxed diagnostics need broader coverage.

### 5. Target Resolution Is Too Thin

Current targets are `selector`, frame-aware `elementRef`, or semantic resolution over compact page-state items. There is no full locator engine.

Missing:

- role/name locators
- label locators with accessible-name semantics
- text locators with strictness
- nth/first/last
- chained locators
- shadow DOM traversal strategy
- frame locators
- coordinate targets
- test id configuration
- action target preview with actionability failure reasons

### 6. Actionability Checks Are Missing

Before acting, the engine should determine whether the element is actionable.

Missing checks:

- attached to document
- visible and non-zero client rect
- not hidden by CSS
- not disabled/read-only when relevant
- stable bounding box
- scrolled into view
- hit-test target at click point
- no overlay intercepting target
- pointer-events compatibility
- editable checks including contenteditable and ARIA states
- retry when detached during resolution/action

### 7. Wait Model Is Useful But Too Narrow

`wait_for_page_state` and workflow wait steps poll compact state. This is useful for LLM ergonomics but not enough for e2e parity.

Missing wait primitives:

- wait for selector attached/detached/visible/hidden
- wait for URL
- wait for navigation/load/domcontentloaded
- wait for network request/response as workflow steps
- wait for console message/error
- wait for stable layout
- wait for download/dialog/popup
- expect-style assertions with diagnostics

### 8. E2E Coverage Does Not Prove the Feature End to End

The current tests around automation are strong at lower layers:

- content-script unit tests prove DOM event dispatch
- MCP server tests prove routing/response shape
- popup e2e tests prove settings controls
- database tests prove history persistence

But there is no strong Playwright fixture proving:

- enable automation in extension
- bind real tab/session
- call MCP `execute_ui_action`
- verify the real page changes because of the action
- verify input typing through the MCP path
- verify target failure on covered/disabled/offscreen elements
- verify iframe behavior or explicit unsupported diagnostics
- verify persisted automation run details after a real action

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

3. `ActionabilityChecker`
   - computes visibility, enabled/editable state, viewport, hit target, stability, and scroll requirements
   - returns structured failure codes before action execution

4. `NativeInputDriver`
   - sends CDP mouse/keyboard events
   - handles scroll into view
   - supports click, double click, hover, type, press, fill, clear, select option

5. `WaitEngine`
   - keeps current page-state waits
   - adds selector, URL, navigation, network, console, and layout-stability waits
   - can be reused by `execute_ui_action.waitFor...` and `run_ui_steps`

6. `AutomationDiagnostics`
   - persists actionability failures, resolved target data, hit-test details, screenshot/snapshot references, and CDP errors into automation history

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

- Add role/name/text/testId target schema.
- Add strict target resolution by default for semantic locators.
- Add workflow wait kinds for selector, URL, request/response, console, and navigation.
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
6. Expand waits beyond compact page-state polling.
7. Add locator semantics beyond raw CSS selectors and element refs.
8. Persist richer diagnostics into automation history.

Status update:

- Items 1, 2, 4, and 5 now have baseline implementation and e2e coverage for top-document and same-origin iframe actions.
- Item 3 has a first actionability baseline for native targets, including disabled, hidden, pointer-events none, and covered-target diagnostics.
- Item 8 has baseline full-path history persistence and trace lookup.
- Items 6, 7, cross-origin/sandboxed frame policy, nested frame stability, and the richer diagnostics portion of 8 remain open and are the evidence-backed refactor scope.

## Additional Tests To Add

The new full-path spec should be expanded after the native-input refactor starts. Recommended additions:

1. Click actionability: hidden, disabled, covered, offscreen, zero-size, detached-during-action, pointer-events none.
2. Native input: type/fill/clear, selection replacement, masked input, controlled React-style input, contenteditable, Enter/Tab behavior.
3. Keyboard: shortcuts, modifiers, Tab focus movement, Enter submit, non-character keys.
4. Frames: nested same-origin frames, cross-origin iframe diagnostics, sandboxed iframe diagnostics, and frame ref stability.
5. Locators: role/name, label, text, test id, strict ambiguity, nth/first/last, shadow DOM policy.
6. Waits: URL, navigation, selector visible/hidden/attached/detached, request/response, console, network idle or bounded quiet window.
7. Diagnostics/history: richer run details after real MCP-triggered actions, including failure evidence linkage, actionability metadata, and CDP failure metadata.
8. Safety: automation disabled, sensitive-field opt-in, unbound tab, disallowed URL, emergency stop during a long action.

## Compatibility Notes

The current DOM-simulation path should not be deleted immediately. It can remain as:

- a fallback for pages where CDP attach is unavailable
- a clearly labeled compatibility mode
- a test harness path for jsdom/unit tests

But it should not be the default path if the product goal is Playwright/Cypress-like behavior.

## Final Assessment

This feature does not need to open a new Chromium instance. The existing architecture supports real-browser top-document and same-origin iframe automation now, including frame-aware refs from page-state capture. The big remaining pieces are cross-origin/sandboxed frame policy, locator parity, stronger waits, deeper diagnostics, nested frame stability, and broader actionability parity.

This is a meaningful refactor, not a small bug fix.
