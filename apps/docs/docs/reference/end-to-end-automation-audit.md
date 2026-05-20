---
sidebar_position: 20
---

# End-to-End Automation Capability Audit

Date: 2026-05-11  
Deep audit update: 2026-05-16  
Implementation closure: 2026-05-20

## Summary

Live automation uses the real bound browser session. It does not open a separate Chromium instance, Playwright profile, or external browser runtime.

The current automation surface is implemented around the CDP-backed native backend (`cdp-native-v2`) for `click`, `hover`, `input`, `press_key`, `focus`, `blur`, `scroll`, and `submit`. `reload` stays on the extension tab API. The MCP server routes actions and waits through the existing live extension connection, persists automation history, attaches diagnostics, and guards repeated unchanged failures.

This audit is now closed as an implementation plan. What remains below are explicit product boundaries, not open engineering phases.

## Supported Surface

- Bound-tab real-browser execution through `execute_ui_action` and `run_ui_steps`
- Native pointer and keyboard execution for:
  - top-document targets
  - same-origin iframe targets
  - nested same-origin iframe targets
  - cross-origin and sandboxed opaque-origin iframe pointer targets when the frame-local point can be translated into top-document coordinates
- Frame-aware `elementRef` targets with stale-frame recovery across iframe reload/replacement
- Direct and workflow `target.locator` resolution with:
  - `css`, `role`, `text`, `label`, `testId`, `placeholder`, `altText`
  - regex matchers
  - `ancestor` and `descendant` relations
  - frame selector paths and frame URL/title filters
  - `nth`, `first`, `last`, `strict:false`
  - state filters: `visible`, `enabled`, `disabled`, `editable`, `checked`, `selected`, `pressed`, `expanded`, `readOnly`, `requiredField`
- Coordinate click/hover targets for:
  - top-document points
  - frame-local points when the current frame can be translated through its selector chain
- Open shadow-root discovery and action targeting with `host >> target` selectors
- Explicit closed-shadow rejection with `closed_shadow_root_unsupported`
- Native actionability diagnostics for visibility, disabled state, readonly/editable policy, pointer-events, viewport intersection, layout stability, zero-size geometry, obscured hit targets, offscreen scroll, and detached-target retry
- First-class waits for:
  - page state
  - URL
  - persisted navigation events
  - navigation lifecycle
  - load state
  - selector state
  - console
  - native dialogs
  - stable layout
  - downloads
  - popups
  - network quiet
  - requests
  - responses
- Structured timeout diagnostics with matcher summaries and last observed evidence
- Persisted automation history with linked failure evidence, related snapshots, frame/locator/actionability diagnostics, and CDP failure metadata when present

## Verified End to End

The live Playwright proof in `apps/e2e-playwright/tests/full.live-automation.spec.ts` now covers:

- top-document click, hover, input, contenteditable input, key press, Tab, Shift+Tab, focus, blur, scroll, submit
- top-document coordinate click/hover
- same-origin iframe click and nested same-origin iframe click
- cross-origin iframe pointer clicks through translated top-document coordinates
- sandboxed opaque-origin iframe pointer clicks through translated top-document coordinates
- frame-local coordinate clicks for translated cross-origin and sandboxed frames
- stale frame-ref recovery and iframe reload/replacement recovery
- ancestor and frame-selector locator targeting
- locator state filtering for readonly and required-field targets
- closed-shadow rejection
- zero-size geometry rejection
- detached-target retry
- workflow execution and current first-class waits
- timeout diagnostics
- automation-history run lookup with linked failure evidence

## Guardrails

- automation enablement is explicit
- sensitive field automation requires a second opt-in
- session tab binding and URL allowlist are enforced
- the extension shows an in-page indicator and exposes an emergency stop
- repeated unchanged failures are loop-guarded before another identical browser action is sent

## Explicit Non-Goals

These are deliberate boundaries of the current feature, not unfinished phases:

- closed shadow-root internals
- browser-runner parity for every Playwright/Cypress API surface
- IME/composition fidelity, per-character typing simulation, file upload, select-option orchestration, and full paste semantics
- arbitrary browser-security bypass for frames whose selector chain or top-document coordinate translation cannot be resolved
- opening a separate test browser/runtime instead of using the bound real browser session

## Assessment

This is a production-usable real-browser automation layer for the documented surface above. The earlier phase plan is complete. Further work is optional expansion of scope, not required completion work for the current end-to-end automation contract.
