---
sidebar_position: 20
---

# End-to-End Automation Capability Audit

Date: 2026-05-11

Deep audit update: 2026-05-16

Implementation update: 2026-05-19

## Summary

Live automation already uses the real bound browser session. It does not open a new Chromium instance, Playwright profile, or external browser runtime. That part is aligned with the product goal.

The action backend is not yet equivalent to Playwright or Cypress. The first native implementation slices now route top-document and same-origin iframe `click`, `hover`, `input`, `press_key`, `focus`, `blur`, `scroll`, and `submit` through the CDP-backed backend (`cdp-native-v2`). `reload` uses the extension tab API.

The deep audit added `apps/e2e-playwright/tests/full.live-automation.spec.ts`. It proves MCP to extension to bound-tab execution for top-document click, hover, input, key press, focus, blur, scroll, submit, open shadow-root click, same-origin iframe click, nested same-origin iframe click, stale frame-ref recovery, `run_ui_steps`, `get_interactive_elements`, native actionability rejections, stale frame diagnostics, and automation-history lookup by trace ID. That confirms the foundation works end to end, but it does not remove the need for the remaining refactor work.

The server now also guards against repeated unchanged tool failures. Guarded MCP calls persist attempts, warn before a loop becomes expensive, and block repeated live automation or override attempts until real page/session/config state changes.

## What Works

- `execute_ui_action`, `run_ui_steps`, `preflight_automation_flow`, `assert_page_state`, `wait_for_page_state`, first-class URL/navigation/navigation-lifecycle/load-state/selector/console/dialog/stable-layout/download/popup/network-quiet/request/response waits, and `get_interactive_elements` exist.
- The MCP server sends commands through the existing live extension session.
- Automation is guarded by extension settings, session tab binding, URL allowlist, sensitive-field opt-in, visible in-page indicator, and emergency stop.
- `execute_ui_action` and workflow orchestration can resolve compact semantic targets and locator-style targets, run steps, retry once, capture failure evidence, and report structured diagnostics.
- Automation history is persisted in `automation_runs` and `automation_steps`.
- Automation history now includes native diagnostics JSON for actionability, frame policy, locator resolution, backend, and point metadata when returned by the live action.
- Automation trace IDs are preserved through outbound redaction so `list_automation_runs({ traceId })` can correlate real actions.
- Repeated unchanged live action failures are persisted in `mcp_tool_invocations` and can be blocked through `mcp_loop_incidents` before another identical browser action is sent.

## Main Gaps

- Native top-document and same-origin iframe click, hover, input, key press, focus, blur, scroll, and submit now exist through CDP.
- `get_page_state` and `get_interactive_elements` now discover frame content and open shadow-root content, returning frame-aware `elementRef` values with `frameId`/`frameUrl`/`frameTitle`, frame policy diagnostics, and shadow selectors using `host >> target` syntax.
- `reload` is not CDP native, but it is executed against the bound tab with the extension tab API.
- Cross-origin, sandboxed opaque-origin, or inaccessible iframe pointer actions remain diagnostic because the native click driver must translate frame-local coordinates into top-document CDP coordinates. Native results now include frame policy metadata and explicit coordinate-resolution diagnostics.
- The native actionability model now covers visibility, disabled state, readonly/editable input policy, pointer-events, viewport intersection, stable layout, offscreen scroll-into-view semantics, detached-target retry, zero-size geometry classification, hit-target mismatch diagnostics, shadow-host hit testing, and retry metadata. The remaining gaps are deeper overlay/pointer-capture edge cases and broader cross-origin frame action coverage.
- Targeting supports CSS selector, frame-aware `elementRef`, shadow selectors, top-document coordinate targets for click/hover, compact semantic matching, and native DOM `target.locator` resolution for direct actions and workflow action steps. Locator steps support `css`, `role`, `text`, `label`, `testId`, `placeholder`, `altText`, regex matchers, explicit descendant and ancestor relations, same-origin frame selector paths, frame URL/title filters, exact text matching, `nth`, `first`, `last`, and `strict:false` disambiguation. Closed shadow-root traversal now fails explicitly with `closed_shadow_root_unsupported`. Frame-aware actions now emit `frameResolution` diagnostics with matcher inputs, sampled frame candidates, and whether a stale frame was recovered by direct frame context or selector narrowing. Remaining locator gaps are arbitrary selector state and broader ambiguity diagnostics.
- Waits now cover compact page-state polling, URL predicates, persisted navigation events, live navigation lifecycle states (`commit`, `same_document`, `domcontentloaded`, `load`, `network_idle`), arbitrary selector attached/detached/visible/hidden state, live console messages, native JavaScript dialogs, stable layout windows, downloads, popups, persisted network quiet windows, and request/response predicates as workflow primitives. Timed-out waits now return structured timeout diagnostics; the remaining wait work is broader fixture coverage and deeper raw-event diagnostics rather than missing wait primitives.
- Browser e2e coverage now has a full-path proof for coordinate click/hover, unsupported cross-origin/sandboxed frame diagnostics, closed-shadow rejection, zero-size geometry diagnostics, timed-out wait diagnostics, and `get_automation_run` history assertions in addition to the earlier native action set.

Coverage update: the full-path e2e proof now asserts `cdp-native-v2` for click, hover, coordinate click/hover, input, key press, focus, blur, scroll, submit, open shadow-root click, same-origin iframe click, nested same-origin iframe click, stale frame-ref recovery, iframe reload/replacement recovery, ancestor and frame-selector locator targeting, offscreen scroll success, detached-target retry, workflow waits, current first-class waits, unsupported cross-origin/sandboxed frame diagnostics, closed-shadow rejection, zero-size geometry rejection, timeout diagnostics, frame ambiguity diagnostics, and automation-history run lookup behavior. The remaining test gaps are deeper overlay/actionability edges, broader frame edge coverage, and raw CDP failure coverage.

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
- `TargetResolver`: resolves selectors, element refs, semantic locators, coordinates, and frames. The compact MCP-side resolver is now extracted to `apps/mcp-server/src/mcp/target-resolution.ts` with focused unit coverage, and direct/workflow locator actions now use extension-side native DOM resolution with ancestor relations and same-origin frame selector composition. Closed-shadow targeting now fails explicitly. Frame-aware direct actions now recover stale refs across iframe reload/replacement by re-evaluating frame URL/title/selector context before dispatch and report sampled ambiguity diagnostics. The remaining locator work is arbitrary selector state and richer ambiguity diagnostics.
- `ActionabilityChecker`: validates visible, stable, enabled/editable, in viewport, and hit-testable targets.
- `NativeInputDriver`: sends mouse and keyboard input with CDP, scrolls into view, and handles click/type/fill/clear/select semantics.
- `WaitEngine`: keeps page-state waits and now has URL, persisted navigation-event, navigation-lifecycle, document load-state, selector-state, console, dialog, stable-layout, download, popup, network-quiet, request, and response primitives. Timed-out waits now emit matcher summaries and last-observed diagnostics. The remaining work is broader fixture coverage and deeper raw-event detail.
- `AutomationDiagnostics`: persists resolved target, actionability, hit-test, screenshot/snapshot, and CDP failure metadata.

## Phased Plan

1. Add full-path Playwright e2e tests for MCP `execute_ui_action` and `run_ui_steps` against a real extension session.
2. Move click execution to CDP `Input.dispatchMouseEvent` with scroll-into-view and hit testing.
3. Move keyboard/input execution to CDP keyboard events and explicit fill/type semantics.
4. Add frame-aware target resolution and diagnostics for unsupported frame cases.
5. Add locator semantics beyond CSS selectors and `elementRef`.
6. Expand workflow waits to broader navigation lifecycle semantics, layout stability, dialogs, downloads, and popups. URL, persisted navigation-event, navigation-lifecycle, document load-state, selector-state, console, native JavaScript dialog, stable-layout, download, popup, network-quiet, request, and response waits now exist.
7. Persist richer automation diagnostics in history tables.
8. Update docs and schemas so unsupported fields are not advertised as implemented behavior.

Phase 1 now has a full-path test. Phase 2 has native click/hover with actionability checks for top-document and same-origin iframe targets. Phase 3 has native input/key plus native focus/blur/scroll/submit. Phase 4 has same-origin iframe action support, nested same-origin coverage, frame-ref discovery, stale frame-ref recovery by URL/title, and explicit cross-origin/sandboxed frame policy diagnostics. Phase 5 now has native DOM locator resolution for same-element structured filters, ancestor/descendant relations, role/name/exact/regex/positional matching, same-origin frame selector composition, frame URL/title filters, open shadow-root selectors, and an extracted MCP-side target-resolution module. Phase 6 now has production-useful waits: URL, persisted navigation-event, navigation-lifecycle, document load-state, selector-state, console, native JavaScript dialog, stable-layout, download, popup, network-quiet, request, and response waits can run standalone and inside `run_ui_steps`. Phase 7 has baseline history persistence, trace lookup, native diagnostics persistence, and linked failure evidence/snapshot/CDP metadata in diagnostics. Remaining work is narrower parity refinement rather than missing core wait or locator primitives.

## Additional Tests To Add

- Click actionability: deeper overlay/pointer-capture edge cases, zero-size edge diagnostics, and broader cross-origin frame surface coverage.
- Native input: type/fill/clear, selection replacement, masked input, controlled inputs, contenteditable, Enter, and Tab.
- Keyboard: shortcuts, modifiers, focus movement, form submission, and non-character keys.
- Frames: broader cross-origin/sandboxed fixture coverage and frame ref stability across more navigation patterns beyond the current URL/title/selector recovery baseline.
- Locators: arbitrary selector state and richer ambiguity diagnostics beyond the current ancestor/descendant/frame-selector native locator baseline.
- Waits: broader cross-origin/sandboxed fixture coverage for the current wait set and deeper raw-event diagnostics.
- Diagnostics/history: broader end-to-end assertions for linked failure evidence snapshots and raw CDP failure metadata after real MCP-triggered actions.
- Safety: disabled automation, sensitive-field opt-in, unbound tab, disallowed URL, and emergency stop.

## Final Assessment

This is now a working real-browser automation foundation for top-document, open shadow-root, and same-origin iframe targets, including nested same-origin frame coverage, frame-ref discovery, stale frame-ref recovery across iframe reload/replacement, ancestor/frame-selector locators, explicit unsupported-frame diagnostics, production-flow preflight, and first-class URL/navigation-event/navigation-lifecycle/load-state/selector/console/dialog/stable-layout/download/popup/network-quiet/request/response waits. It is still not a finished Playwright/Cypress-equivalent engine. The remaining required work is narrower locator parity, deeper diagnostics coverage, broader frame-edge coverage, wider navigation-grade frame stability, and the last actionability edge cases.
