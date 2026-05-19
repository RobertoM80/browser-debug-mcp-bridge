---
sidebar_position: 20
---

# End-to-End Automation Capability Audit

Date: 2026-05-11

Deep audit update: 2026-05-16

Implementation update: 2026-05-18

## Summary

Live automation already uses the real bound browser session. It does not open a new Chromium instance, Playwright profile, or external browser runtime. That part is aligned with the product goal.

The action backend is not yet equivalent to Playwright or Cypress. The first native implementation slices now route top-document and same-origin iframe `click`, `hover`, `input`, `press_key`, `focus`, `blur`, `scroll`, and `submit` through the CDP-backed backend (`cdp-native-v2`). `reload` uses the extension tab API.

The deep audit added `apps/e2e-playwright/tests/full.live-automation.spec.ts`. It proves MCP to extension to bound-tab execution for top-document click, hover, input, key press, focus, blur, scroll, submit, open shadow-root click, same-origin iframe click/input, nested same-origin iframe click, stale frame-ref recovery, `run_ui_steps`, `get_interactive_elements`, native actionability rejections, stale frame diagnostics, and automation-history lookup by trace ID. That confirms the foundation works end to end, but it does not remove the need for the remaining refactor work.

The server now also guards against repeated unchanged tool failures. Guarded MCP calls persist attempts, warn before a loop becomes expensive, and block repeated live automation or override attempts until real page/session/config state changes.

## What Works

- `execute_ui_action`, `run_ui_steps`, `preflight_automation_flow`, `assert_page_state`, `wait_for_page_state`, first-class URL/navigation/selector/console/network-quiet/request/response waits, and `get_interactive_elements` exist.
- The MCP server sends commands through the existing live extension session.
- Automation is guarded by extension settings, session tab binding, URL allowlist, sensitive-field opt-in, visible in-page indicator, and emergency stop.
- `execute_ui_action` and workflow orchestration can resolve compact semantic targets and locator-style targets, run steps, retry once, capture failure evidence, and report structured diagnostics.
- Automation history is persisted in `automation_runs` and `automation_steps`.
- Automation trace IDs are preserved through outbound redaction so `list_automation_runs({ traceId })` can correlate real actions.
- Repeated unchanged live action failures are persisted in `mcp_tool_invocations` and can be blocked through `mcp_loop_incidents` before another identical browser action is sent.

## Main Gaps

- Native top-document and same-origin iframe click, hover, input, key press, focus, blur, scroll, and submit now exist through CDP.
- `get_page_state` and `get_interactive_elements` now discover frame content and open shadow-root content, returning frame-aware `elementRef` values with `frameId`/`frameUrl`/`frameTitle`, frame policy diagnostics, and shadow selectors using `host >> target` syntax.
- `reload` is not CDP native, but it is executed against the bound tab with the extension tab API.
- Cross-origin, sandboxed opaque-origin, or inaccessible iframe pointer actions remain diagnostic because the native click driver must translate frame-local coordinates into top-document CDP coordinates. Native results now include frame policy metadata and explicit coordinate-resolution diagnostics.
- The native actionability model now covers visibility, disabled state, readonly/editable input policy, pointer-events, viewport intersection, stable layout, hit-target mismatch diagnostics, shadow-host hit testing, and a short retry loop for transient inspection/actionability failures. It still needs parity coverage for offscreen scroll semantics, detached targets, overlay edge cases, and retry-on-detach.
- Targeting supports CSS selector, frame-aware `elementRef`, shadow selectors, compact semantic matching, and native DOM `target.locator` resolution for direct actions and workflow action steps. Locator steps support `css`, `role`, `text`, `label`, `testId`, `placeholder`, `altText`, regex matchers, frame URL/title filters, exact text matching, `nth`, `first`, `last`, and `strict:false` disambiguation. There is still no full DOM locator engine for true ancestor/descendant chaining, closed shadow DOM, arbitrary selector state, or coordinate targeting.
- Waits now cover compact page-state polling, URL predicates, persisted navigation events, arbitrary selector attached/detached/visible/hidden state, live console messages, persisted network quiet windows, and request/response predicates as workflow primitives. They still do not cover navigation lifecycle/load states, layout stability, dialogs, downloads, or popups.
- Browser e2e coverage now has a full-path proof for the native top-document action set and common actionability rejections, but does not yet cover Playwright/Cypress parity cases.

Coverage update: the full-path e2e proof now asserts `cdp-native-v2` for click, hover, input, key press, focus, blur, scroll, submit, open shadow-root click, same-origin iframe click/input, nested same-origin iframe click, stale frame-ref recovery, and native DOM locator targeting using refs returned by the extension resolver. It also asserts direct semantic action targeting, role/name positional link targeting, visible/hidden page-state assertions, readonly input rejection, disabled, hidden, pointer-events none, covered target, stale frame rejection, workflow, current first-class waits, and automation-history trace lookup behavior. The remaining test gaps are deeper actionability edge cases, full DOM locator parity, navigation lifecycle/load-state waits, and broader cross-origin/sandboxed frame coverage.

## Root Cause

The current execution path is:

1. MCP tool receives the action.
2. Server forwards `EXECUTE_UI_ACTION` through the live capture channel.
3. Extension background validates session and settings.
4. Extension background uses the native backend for the migrated top-document actions, with the older content-script execution path retained as compatibility scaffolding for non-migrated behavior and lower-level tests.

The fourth step was the original mismatch. The native backend is now the default for the primary top-document action set, but Playwright/Cypress-like behavior still requires frame-aware targeting, richer locators, stronger wait primitives, and broader actionability parity.

## Recommended Refactor

Keep the real-browser extension architecture and replace the default action backend with a CDP-backed automation engine.

Recommended layers:

- `AutomationController`: owns one action at a time, CDP attach/reuse, emergency stop, and lifecycle events.
- `TargetResolver`: resolves selectors, element refs, semantic locators, coordinates, and frames. The compact MCP-side resolver is now extracted to `apps/mcp-server/src/mcp/target-resolution.ts` with focused unit coverage, and direct/workflow locator actions now use extension-side native DOM resolution. The next step is adding full DOM locator relationships beyond same-element structured filters.
- `ActionabilityChecker`: validates visible, stable, enabled/editable, in viewport, and hit-testable targets.
- `NativeInputDriver`: sends mouse and keyboard input with CDP, scrolls into view, and handles click/type/fill/clear/select semantics.
- `WaitEngine`: keeps page-state waits and now has URL, persisted navigation-event, selector-state, console, network-quiet, request, and response primitives. The remaining work is navigation lifecycle/load-state, layout stability, dialogs, downloads, and popups.
- `AutomationDiagnostics`: persists resolved target, actionability, hit-test, screenshot/snapshot, and CDP failure metadata.

## Phased Plan

1. Add full-path Playwright e2e tests for MCP `execute_ui_action` and `run_ui_steps` against a real extension session.
2. Move click execution to CDP `Input.dispatchMouseEvent` with scroll-into-view and hit testing.
3. Move keyboard/input execution to CDP keyboard events and explicit fill/type semantics.
4. Add frame-aware target resolution and diagnostics for unsupported frame cases.
5. Add locator semantics beyond CSS selectors and `elementRef`.
6. Expand workflow waits to navigation lifecycle/load-state, layout stability, dialogs, downloads, and popups. URL, persisted navigation-event, selector-state, console, network-quiet, request, and response waits now exist.
7. Persist richer automation diagnostics in history tables.
8. Update docs and schemas so unsupported fields are not advertised as implemented behavior.

Phase 1 now has a full-path test. Phase 2 has native click/hover with actionability checks for top-document and same-origin iframe targets. Phase 3 has native input/key plus native focus/blur/scroll/submit. Phase 4 has same-origin iframe action support, nested same-origin coverage, frame-ref discovery, stale frame-ref recovery by URL/title, and explicit cross-origin/sandboxed frame policy diagnostics. Phase 5 now has native DOM locator resolution for same-element structured filters, role/name/exact/regex/positional matching, frame URL/title filters, open shadow-root selectors, and an extracted MCP-side target-resolution module. It still needs full DOM locator relationships and frame-locator composition. Phase 6 now has production-useful waits: URL, persisted navigation-event, selector-state, console, network-quiet, request, and response waits can run standalone and inside `run_ui_steps`. Phase 7 has baseline history persistence plus trace lookup. Remaining Phase 6 lifecycle/load-state waits and the richer diagnostics portion of 7 remain open and should be treated as the next refactor scope.

## Additional Tests To Add

- Click actionability: hidden, disabled, covered, offscreen, zero-size, detached, and pointer-events targets.
- Native input: type/fill/clear, selection replacement, masked input, controlled inputs, contenteditable, Enter, and Tab.
- Keyboard: shortcuts, modifiers, focus movement, form submission, and non-character keys.
- Frames: broader cross-origin/sandboxed fixture coverage, multi-match frame ambiguity diagnostics, and frame ref stability across reloads/navigation beyond the current URL/title recovery baseline.
- Locators: true DOM ancestor/descendant chained locators, full frame-locator composition, closed shadow DOM policy, coordinate targets, arbitrary selector state, and richer ambiguity diagnostics beyond the current same-element native locator baseline.
- Waits: navigation lifecycle/load states, layout stability, dialogs, downloads, popups, and deeper timeout/diagnostic e2e coverage for the current URL/navigation-event/selector/console/network/request/response MCP waits.
- Diagnostics/history: deeper run details, failure evidence linkage, actionability metadata, and CDP failure metadata after real MCP-triggered actions.
- Safety: disabled automation, sensitive-field opt-in, unbound tab, disallowed URL, and emergency stop.

## Final Assessment

This is now a working real-browser automation foundation for top-document, open shadow-root, and same-origin iframe targets, including nested same-origin frame coverage, frame-ref discovery, stale frame-ref recovery, explicit unsupported-frame diagnostics, production-flow preflight, and first-class URL/navigation-event/selector/console/network-quiet/request/response waits. It is still not a finished Playwright/Cypress-equivalent engine. The remaining required work is full locator parity, navigation lifecycle/load-state waits, deeper diagnostics, broader frame edge coverage, navigation-grade frame stability, and broader actionability parity.
