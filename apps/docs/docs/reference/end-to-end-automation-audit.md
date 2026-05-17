---
sidebar_position: 20
---

# End-to-End Automation Capability Audit

Date: 2026-05-11

Deep audit update: 2026-05-16

Implementation update: 2026-05-17

## Summary

Live automation already uses the real bound browser session. It does not open a new Chromium instance, Playwright profile, or external browser runtime. That part is aligned with the product goal.

The action backend is not yet equivalent to Playwright or Cypress. The first native implementation slices now route top-document and same-origin iframe `click`, `hover`, `input`, `press_key`, `focus`, `blur`, `scroll`, and `submit` through the CDP-backed backend (`cdp-native-v2`). `reload` uses the extension tab API.

The deep audit added `apps/e2e-playwright/tests/full.live-automation.spec.ts`. It proves MCP to extension to bound-tab execution for top-document click, hover, input, key press, focus, blur, scroll, submit, same-origin iframe click/input, `run_ui_steps`, `get_interactive_elements`, native actionability rejections, stale frame diagnostics, and automation-history lookup by trace ID. That confirms the foundation works end to end, but it does not remove the need for the remaining refactor work.

## What Works

- `execute_ui_action`, `run_ui_steps`, `assert_page_state`, `wait_for_page_state`, and `get_interactive_elements` exist.
- The MCP server sends commands through the existing live extension session.
- Automation is guarded by extension settings, session tab binding, URL allowlist, sensitive-field opt-in, visible in-page indicator, and emergency stop.
- `execute_ui_action` and workflow orchestration can resolve compact semantic targets, run steps, retry once, capture failure evidence, and report structured diagnostics.
- Automation history is persisted in `automation_runs` and `automation_steps`.
- Automation trace IDs are preserved through outbound redaction so `list_automation_runs({ traceId })` can correlate real actions.

## Main Gaps

- Native top-document and same-origin iframe click, hover, input, key press, focus, blur, scroll, and submit now exist through CDP.
- `get_page_state` and `get_interactive_elements` now discover same-origin frame content and return frame-aware `elementRef` values with `frameId`/`frameUrl`.
- `reload` is not CDP native, but it is executed against the bound tab with the extension tab API.
- Cross-origin or inaccessible iframe pointer actions remain diagnostic because the native click driver must translate frame-local coordinates into top-document CDP coordinates.
- The native actionability model now covers visibility, disabled state, readonly/editable input policy, pointer-events, viewport intersection, stable layout, and hit-target mismatch diagnostics, but it still needs parity coverage for offscreen scroll semantics, detached targets, overlay edge cases, and retry-on-detach.
- Targeting supports CSS selector, `elementRef`, and compact semantic matching for direct actions and workflows, including role/name, placeholder/alt metadata where captured, exact text matching, and `nth` disambiguation. There is still no full locator engine for chained locators, first/last aliases, shadow DOM, frame-locator composition, strict/non-strict modes, or coordinate targeting.
- Waits are based on compact page-state polling, now including visible/hidden structured refs, and do not cover navigation, URL predicates, network, console, arbitrary selector attached/detached state, layout stability, dialogs, downloads, or popups as workflow primitives.
- Browser e2e coverage now has a full-path proof for the native top-document action set and common actionability rejections, but does not yet cover Playwright/Cypress parity cases.

Coverage update: the full-path e2e proof now asserts `cdp-native-v2` for click, hover, input, key press, focus, blur, scroll, submit, same-origin iframe click/input using refs returned by `get_interactive_elements`, direct semantic action targeting, role/name/nth link targeting, visible/hidden page-state assertions, and readonly input rejection. It also asserts disabled, hidden, pointer-events none, covered target, stale frame, workflow, and automation-history trace lookup behavior. The remaining test gaps are deeper actionability edge cases, cross-origin/sandboxed frame policy, nested frame stability, complete locator parity, and richer waits.

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
- `TargetResolver`: resolves selectors, element refs, semantic locators, coordinates, and frames.
- `ActionabilityChecker`: validates visible, stable, enabled/editable, in viewport, and hit-testable targets.
- `NativeInputDriver`: sends mouse and keyboard input with CDP, scrolls into view, and handles click/type/fill/clear/select semantics.
- `WaitEngine`: keeps page-state waits and adds selector, URL, navigation, network, console, and layout waits.
- `AutomationDiagnostics`: persists resolved target, actionability, hit-test, screenshot/snapshot, and CDP failure metadata.

## Phased Plan

1. Add full-path Playwright e2e tests for MCP `execute_ui_action` and `run_ui_steps` against a real extension session.
2. Move click execution to CDP `Input.dispatchMouseEvent` with scroll-into-view and hit testing.
3. Move keyboard/input execution to CDP keyboard events and explicit fill/type semantics.
4. Add frame-aware target resolution and diagnostics for unsupported frame cases.
5. Add locator semantics beyond CSS selectors and `elementRef`.
6. Expand workflow waits to navigation, URL, selector state, network, console, and layout stability.
7. Persist richer automation diagnostics in history tables.
8. Update docs and schemas so unsupported fields are not advertised as implemented behavior.

Phase 1 now has a full-path test. Phase 2 has native click/hover with actionability checks for top-document and same-origin iframe targets. Phase 3 has native input/key plus native focus/blur/scroll/submit. Phase 4 has same-origin iframe action support and frame-ref discovery, but still needs cross-origin/sandboxed policy and nested frame stability. Phase 5 has a compact locator baseline for role/name/exact/nth over page-state refs, but still needs a full locator engine. Phase 7 has baseline history persistence plus trace lookup. Phase 6 and the richer diagnostics portion of 7 remain open and should be treated as the next refactor scope.

## Additional Tests To Add

- Click actionability: hidden, disabled, covered, offscreen, zero-size, detached, and pointer-events targets.
- Native input: type/fill/clear, selection replacement, masked input, controlled inputs, contenteditable, Enter, and Tab.
- Keyboard: shortcuts, modifiers, focus movement, form submission, and non-character keys.
- Frames: cross-origin iframe diagnostics, sandboxed iframe diagnostics, nested same-origin frames, and frame ref stability.
- Locators: chained locators, first/last aliases, shadow DOM policy, frame locators, strict/non-strict modes, and richer ambiguity diagnostics beyond the current compact role/name/nth baseline.
- Waits: URL, navigation, selector state, request/response, console, and bounded network quiet windows.
- Diagnostics/history: deeper run details, failure evidence linkage, actionability metadata, and CDP failure metadata after real MCP-triggered actions.
- Safety: disabled automation, sensitive-field opt-in, unbound tab, disallowed URL, and emergency stop.

## Final Assessment

This is now a working real-browser automation foundation for top-document and same-origin iframe targets, including same-origin frame-ref discovery, but not a finished Playwright/Cypress-equivalent engine. The remaining required work is cross-origin/sandboxed frame policy, locator parity, stronger waits, deeper diagnostics, nested frame stability, and broader actionability parity.
