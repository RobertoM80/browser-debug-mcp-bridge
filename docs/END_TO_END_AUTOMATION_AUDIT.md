# End-to-End Automation Capability Audit

Date: 2026-05-11  
Deep audit update: 2026-05-16  
Implementation closure: 2026-05-20

## Executive Summary

The automation feature now runs through the real bound Chrome session instead of opening a separate browser runtime. The extension background owns execution, the MCP server routes actions and waits through the live bridge, and the primary action set uses the CDP-backed native backend (`cdp-native-v2`).

This document is now a capability reference, not an open phased plan. The prior implementation slices are complete for the currently supported surface. What is intentionally outside that surface is listed under explicit non-goals.

## Implemented Capability Map

### Action execution

- `click`, `hover`, `input`, `press_key`, `focus`, `blur`, `scroll`, and `submit` use the native CDP-backed execution path
- `reload` uses the extension tab API against the bound tab
- one action is driven at a time per session
- repeated unchanged failures are loop-guarded before another identical action is dispatched

### Targeting

- CSS selector targets
- frame-aware `elementRef` targets with encoded frame metadata
- compact semantic targets resolved from page-state data
- native DOM `target.locator` resolution for direct actions and workflow action steps
- `target.coordinates` for top-document points and frame-local points

### Locator features

- locator steps: `css`, `role`, `text`, `label`, `testId`, `placeholder`, `altText`
- string and regex matchers
- explicit `ancestor` and `descendant` relations
- frame selector paths
- frame URL/title filters
- `nth`, `first`, `last`, `strict:false`
- state filters:
  - `visible`
  - `enabled`
  - `disabled`
  - `editable`
  - `checked`
  - `selected`
  - `pressed`
  - `expanded`
  - `readOnly`
  - `requiredField`
- explicit closed-shadow rejection with `closed_shadow_root_unsupported`

### Frame handling

- same-origin iframe pointer/input/key/focus/scroll/submit support
- nested same-origin iframe pointer support
- stale frame-id recovery across iframe reload/replacement using frame URL/title/selector context
- translated pointer execution for cross-origin and sandboxed opaque-origin frames when the frame-local point can be mapped into top-document coordinates
- explicit structured rejection when a frame cannot be resolved or translated

### Actionability and diagnostics

- visibility checks
- disabled/editable/readonly policy checks
- pointer-events checks
- viewport intersection checks
- stable layout checks
- offscreen scroll-into-view
- zero-size geometry classification
- obscured hit-target diagnostics
- detached-target retry metadata
- frame policy diagnostics
- frame resolution diagnostics
- locator resolution diagnostics
- linked failure evidence and related snapshot summaries
- persisted CDP failure metadata when available

### Wait engine

- page state
- URL predicates
- persisted navigation events
- navigation lifecycle states
- document load states
- selector states
- console messages
- native JavaScript dialogs
- stable layout windows
- downloads
- popups
- network quiet windows
- request predicates
- response predicates
- structured timeout diagnostics with matcher summaries and last observed evidence

### Persistence and history

- `automation_runs` and `automation_steps` persist action and workflow history
- native diagnostics JSON is stored with runs/steps
- trace IDs remain stable across response redaction and history lookup
- `get_automation_run` exposes linked failure evidence, linked snapshot summaries, and persisted diagnostics

## Verified End-to-End Coverage

The live Playwright fixture at `apps/e2e-playwright/tests/full.live-automation.spec.ts` now proves:

- top-document click, hover, input, contenteditable input, key press, focus, blur, scroll, submit
- top-document coordinate click and hover
- Tab and Shift+Tab focus navigation
- same-origin iframe click
- nested same-origin iframe click
- stale frame-ref recovery
- iframe reload/replacement recovery
- ancestor and frame-selector locator targeting
- locator state filtering for readonly and required-field targets
- cross-origin iframe pointer clicks through translated top-document coordinates
- sandboxed opaque-origin iframe pointer clicks through translated top-document coordinates
- frame-local coordinate clicks inside translated cross-origin and sandboxed frames
- closed-shadow rejection
- zero-size geometry rejection
- detached-target retry
- workflow execution
- current first-class waits
- wait timeout diagnostics
- automation-history lookup with linked failure evidence

## Safety Model

- automation is disabled by default
- sensitive field automation requires a second opt-in
- session tab binding is enforced
- URL allowlist policy is enforced
- the extension exposes an in-page armed/executing indicator
- the extension popup and page overlay expose an emergency stop
- MCP loop guard blocks repeated unchanged failures

## Explicit Non-Goals

These are current product boundaries, not unfinished engineering phases:

- closed shadow-root internals
- opening a separate automation browser/runtime instead of using the bound real browser
- full Playwright/Cypress API parity
- IME/composition fidelity and per-character typing simulation
- general file upload orchestration
- select-option orchestration beyond the current native text/input/focus/key model
- arbitrary browser-security bypass when a frame selector chain or top-document coordinate translation cannot be resolved

## Final Assessment

The real-browser automation feature is now complete for its documented contract. It supports bound-tab native actions, frame-aware targeting, translated pointer actions across supported frame surfaces, first-class waits, persisted diagnostics, and verified live e2e coverage. Any future work from here is optional scope expansion, not a required completion phase for the current implementation.
