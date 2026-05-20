export type TargetResolutionToolInput = Record<string, unknown>;

export type PageStateCaptureResult = {
  limitsApplied: { maxResults: number; truncated: boolean };
  payload: Record<string, unknown>;
};

export type UIActionTargetScope = 'buttons' | 'links' | 'inputs' | 'modals' | 'focused';

export type UIActionLocatorMatcher =
  | string
  | {
    pattern: string;
    flags?: string;
  };

export interface UIActionLocatorStep {
  kind: 'css' | 'role' | 'text' | 'label' | 'testId' | 'placeholder' | 'altText';
  value?: UIActionLocatorMatcher;
  role?: string;
  name?: UIActionLocatorMatcher;
  exact?: boolean;
  relation?: 'filter' | 'descendant' | 'ancestor';
}

export interface UIActionLocator {
  scope?: UIActionTargetScope;
  frame?: {
    selector?: string;
    urlContains?: string;
    titleContains?: string;
  };
  steps: UIActionLocatorStep[];
}

export interface UIWorkflowActionTarget {
  selector?: string;
  elementRef?: string;
  coordinates?: {
    x: number;
    y: number;
    frameId?: number;
  };
  tabId?: number;
  frameId?: number;
  url?: string;
  locator?: UIActionLocator;
  frameUrlContains?: string;
  frameTitleContains?: string;
  testId?: string;
  scope?: UIActionTargetScope;
  textContains?: string;
  labelContains?: string;
  titleContains?: string;
  role?: string;
  name?: string;
  placeholder?: string;
  altText?: string;
  tagName?: string;
  type?: string;
  exact?: boolean;
  nth?: number;
  first?: boolean;
  last?: boolean;
  strict?: boolean;
  visible?: boolean;
  disabled?: boolean;
  selected?: boolean;
  pressed?: boolean;
  expanded?: boolean;
  readOnly?: boolean;
  requiredField?: boolean;
}

export interface ResolvedWorkflowActionTarget {
  target?: {
    elementRef?: string;
    selector?: string;
    coordinates?: {
      x: number;
      y: number;
      frameId?: number;
    };
    tabId?: number;
    frameId?: number;
    url?: string;
  };
  resolution: Record<string, unknown>;
  pageCapture?: PageStateCaptureResult;
}

export class WorkflowTargetResolutionError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown>) {
    super(message);
    this.name = 'WorkflowTargetResolutionError';
    this.code = code;
    this.details = details;
  }
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null);
}

function includesNormalized(value: unknown, needle: string | undefined): boolean {
  if (!needle) {
    return true;
  }

  return typeof value === 'string' && value.toLowerCase().includes(needle.toLowerCase());
}

function matchesTextValue(value: unknown, expected: string | undefined, exact: boolean | undefined): boolean {
  if (!expected) {
    return true;
  }
  if (typeof value !== 'string') {
    return false;
  }

  const normalizedValue = value.trim().toLowerCase();
  const normalizedExpected = expected.trim().toLowerCase();
  return exact === true
    ? normalizedValue === normalizedExpected
    : normalizedValue.includes(normalizedExpected);
}

function equalsNormalized(value: unknown, expected: string | undefined): boolean {
  if (!expected) {
    return true;
  }

  return typeof value === 'string' && value.toLowerCase() === expected.toLowerCase();
}

function equalsOptionalBoolean(value: unknown, expected: boolean | undefined): boolean {
  if (expected === undefined) {
    return true;
  }

  return value === expected;
}

function pickPageStateScopeItems(
  payload: Record<string, unknown>,
  scope: UIActionTargetScope | 'page',
): Record<string, unknown>[] {
  if (scope === 'buttons' || scope === 'links' || scope === 'inputs' || scope === 'modals') {
    return asRecordArray(payload[scope]);
  }

  if (scope === 'focused') {
    const focused = payload.focused;
    return typeof focused === 'object' && focused !== null ? [focused as Record<string, unknown>] : [];
  }

  return [payload];
}

function candidateTextForWorkflowTarget(item: Record<string, unknown>): string {
  const parts = new Set(
    [item.text, item.label, item.title, item.name, item.placeholder, item.altText]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim()),
  );

  return Array.from(parts)
    .join(' ')
    .trim();
}

function locatorMatcherToDebugValue(matcher: UIActionLocatorMatcher | undefined): unknown {
  return matcher;
}

function matchesLocatorMatcher(
  value: unknown,
  matcher: UIActionLocatorMatcher | undefined,
  exact: boolean | undefined,
): boolean {
  if (matcher === undefined) {
    return true;
  }

  if (typeof value !== 'string') {
    return false;
  }

  if (typeof matcher === 'string') {
    return matchesTextValue(value, matcher, exact);
  }

  try {
    return new RegExp(matcher.pattern, matcher.flags).test(value);
  } catch {
    return false;
  }
}

function locatorStepRoleValue(step: UIActionLocatorStep): string | undefined {
  if (typeof step.role === 'string') {
    return step.role;
  }

  return typeof step.value === 'string' ? step.value : undefined;
}

function matchesWorkflowLocatorStep(item: Record<string, unknown>, step: UIActionLocatorStep): boolean {
  if (step.kind === 'css') {
    return matchesLocatorMatcher(item.selector, step.value, step.exact ?? true);
  }

  if (step.kind === 'role') {
    const role = locatorStepRoleValue(step);
    return equalsNormalized(item.role, role?.toLowerCase())
      && matchesLocatorMatcher(item.name, step.name, step.exact);
  }

  if (step.kind === 'text') {
    return matchesLocatorMatcher(
      typeof item.text === 'string' && item.text.trim().length > 0 ? item.text : candidateTextForWorkflowTarget(item),
      step.value,
      step.exact,
    );
  }

  if (step.kind === 'label') {
    return matchesLocatorMatcher(item.label, step.value, step.exact);
  }

  if (step.kind === 'testId') {
    return matchesLocatorMatcher(item.testId, step.value, step.exact ?? true);
  }

  if (step.kind === 'placeholder') {
    return matchesLocatorMatcher(item.placeholder, step.value, step.exact);
  }

  return matchesLocatorMatcher(item.altText, step.value, step.exact);
}

function matchesWorkflowLocator(item: Record<string, unknown>, target: UIWorkflowActionTarget): boolean {
  const locator = target.locator;
  if (!locator) {
    return true;
  }

  return includesNormalized(item.frameUrl, locator.frame?.urlContains)
    && includesNormalized(item.frameTitle, locator.frame?.titleContains)
    && locator.steps.every((step) => matchesWorkflowLocatorStep(item, step));
}

function summarizeWorkflowLocator(target: UIWorkflowActionTarget): Record<string, unknown> | undefined {
  if (!target.locator) {
    return undefined;
  }

  return {
    scope: target.locator.scope,
    frame: target.locator.frame,
    steps: target.locator.steps.map((step) => ({
      kind: step.kind,
      value: locatorMatcherToDebugValue(step.value),
      role: step.role,
      name: locatorMatcherToDebugValue(step.name),
      exact: step.exact,
      relation: step.relation,
    })),
  };
}

function resolveWorkflowTargetScope(target: UIWorkflowActionTarget): UIWorkflowActionTarget['scope'] {
  return target.locator?.scope ?? target.scope;
}

function describeWorkflowTargetCandidate(item: Record<string, unknown>): Record<string, unknown> {
  return {
    text: candidateTextForWorkflowTarget(item) || undefined,
    testId: typeof item.testId === 'string' ? item.testId : undefined,
    selector: typeof item.selector === 'string' ? item.selector : undefined,
    frameId: typeof item.frameId === 'number' ? item.frameId : undefined,
    frameUrl: typeof item.frameUrl === 'string' ? item.frameUrl : undefined,
    frameTitle: typeof item.frameTitle === 'string' ? item.frameTitle : undefined,
    frameSameOriginWithTop: typeof item.frameSameOriginWithTop === 'boolean' ? item.frameSameOriginWithTop : undefined,
    role: typeof item.role === 'string' ? item.role : undefined,
    name: typeof item.name === 'string' ? item.name : undefined,
    tagName: typeof item.tagName === 'string' ? item.tagName : undefined,
    type: typeof item.type === 'string' ? item.type : undefined,
    placeholder: typeof item.placeholder === 'string' ? item.placeholder : undefined,
    altText: typeof item.altText === 'string' ? item.altText : undefined,
    disabled: typeof item.disabled === 'boolean' ? item.disabled : undefined,
    selected: typeof item.selected === 'boolean' ? item.selected : undefined,
  };
}

function pickWorkflowTargetItems(
  payload: Record<string, unknown>,
  scope: UIWorkflowActionTarget['scope'],
): Record<string, unknown>[] {
  if (scope) {
    return pickPageStateScopeItems(payload, scope);
  }

  return [
    ...pickPageStateScopeItems(payload, 'buttons'),
    ...pickPageStateScopeItems(payload, 'links'),
    ...pickPageStateScopeItems(payload, 'inputs'),
    ...pickPageStateScopeItems(payload, 'modals'),
    ...pickPageStateScopeItems(payload, 'focused'),
  ];
}

function matchesWorkflowActionTarget(
  item: Record<string, unknown>,
  target: UIWorkflowActionTarget,
): boolean {
  return (
    matchesWorkflowLocator(item, target)
    && equalsNormalized(item.testId, target.testId)
    && matchesTextValue(item.text, target.textContains, target.exact)
    && matchesTextValue(item.label, target.labelContains, target.exact)
    && matchesTextValue(item.title, target.titleContains, target.exact)
    && equalsNormalized(item.role, target.role?.toLowerCase())
    && matchesTextValue(item.name, target.name, target.exact)
    && matchesTextValue(item.placeholder, target.placeholder, target.exact)
    && matchesTextValue(item.altText, target.altText, target.exact)
    && includesNormalized(item.frameUrl, target.frameUrlContains)
    && includesNormalized(item.frameTitle, target.frameTitleContains)
    && equalsNormalized(item.tagName, target.tagName)
    && equalsNormalized(item.type, target.type)
    && equalsOptionalBoolean(item.visible, target.visible)
    && equalsOptionalBoolean(item.disabled, target.disabled)
    && equalsOptionalBoolean(item.selected, target.selected)
    && equalsOptionalBoolean(item.pressed, target.pressed)
    && equalsOptionalBoolean(item.expanded, target.expanded)
    && equalsOptionalBoolean(item.readOnly, target.readOnly)
    && equalsOptionalBoolean(item.required, target.requiredField)
    && (typeof item.elementRef === 'string' || typeof item.selector === 'string')
  );
}

export function summarizeWorkflowTargetMatcher(target: UIWorkflowActionTarget): Record<string, unknown> {
  return {
    scope: target.scope,
    locator: summarizeWorkflowLocator(target),
    selector: target.selector,
    elementRef: target.elementRef,
    coordinates: target.coordinates,
    testId: target.testId,
    frameId: target.frameId,
    frameUrlContains: target.frameUrlContains,
    frameTitleContains: target.frameTitleContains,
    textContains: target.textContains,
    labelContains: target.labelContains,
    titleContains: target.titleContains,
    role: target.role,
    name: target.name,
    placeholder: target.placeholder,
    altText: target.altText,
    tagName: target.tagName,
    type: target.type,
    exact: target.exact,
    nth: target.nth,
    first: target.first,
    last: target.last,
    strict: target.strict,
    visible: target.visible,
    disabled: target.disabled,
    selected: target.selected,
    pressed: target.pressed,
    expanded: target.expanded,
    readOnly: target.readOnly,
    requiredField: target.requiredField,
  };
}

export function hasSemanticActionTargetMatcher(target: UIWorkflowActionTarget | undefined): boolean {
  return Boolean(
    target
    && !target.selector
    && !target.elementRef
    && !target.coordinates
    && (
      target.locator
      || target.scope
      || target.frameUrlContains
      || target.frameTitleContains
      || target.testId
      || target.textContains
      || target.labelContains
      || target.titleContains
      || target.role
      || target.name
      || target.placeholder
      || target.altText
      || target.tagName
      || target.type
      || target.first === true
      || target.last === true
      || target.nth !== undefined
      || target.strict === false
      || target.visible !== undefined
      || target.disabled !== undefined
      || target.selected !== undefined
      || target.pressed !== undefined
      || target.expanded !== undefined
      || target.readOnly !== undefined
      || target.requiredField !== undefined
    ),
  );
}

function selectWorkflowTargetCandidate(
  candidates: Record<string, unknown>[],
  target: UIWorkflowActionTarget,
): {
  candidate?: Record<string, unknown>;
  selectedCandidates: Record<string, unknown>[];
  selectedIndex?: number;
  selectionStrategy: 'strict-single' | 'nth' | 'first' | 'last' | 'first-non-strict';
  outOfRange: boolean;
} {
  if (typeof target.nth === 'number') {
    return {
      candidate: candidates[target.nth],
      selectedCandidates: candidates[target.nth] ? [candidates[target.nth] as Record<string, unknown>] : [],
      selectedIndex: target.nth,
      selectionStrategy: 'nth',
      outOfRange: candidates[target.nth] === undefined,
    };
  }

  if (target.last === true) {
    const selectedIndex = candidates.length - 1;
    return {
      candidate: selectedIndex >= 0 ? candidates[selectedIndex] : undefined,
      selectedCandidates: selectedIndex >= 0 ? [candidates[selectedIndex] as Record<string, unknown>] : [],
      selectedIndex,
      selectionStrategy: 'last',
      outOfRange: selectedIndex < 0,
    };
  }

  if (target.first === true || target.strict === false) {
    return {
      candidate: candidates[0],
      selectedCandidates: candidates[0] ? [candidates[0] as Record<string, unknown>] : [],
      selectedIndex: 0,
      selectionStrategy: target.strict === false && target.first !== true ? 'first-non-strict' : 'first',
      outOfRange: candidates[0] === undefined,
    };
  }

  return {
    candidate: candidates.length === 1 ? candidates[0] : undefined,
    selectedCandidates: candidates,
    selectedIndex: candidates.length === 1 ? 0 : undefined,
    selectionStrategy: 'strict-single',
    outOfRange: false,
  };
}

export async function resolveWorkflowActionTarget(
  sessionId: string,
  target: UIWorkflowActionTarget | undefined,
  capturePageState: (
    sessionId: string,
    input: TargetResolutionToolInput,
  ) => Promise<PageStateCaptureResult>,
  existingCapture?: PageStateCaptureResult,
): Promise<ResolvedWorkflowActionTarget> {
  if (!target) {
    return {
      resolution: {
        strategy: 'none',
      },
    };
  }

  if (target.elementRef || target.selector) {
    return {
      target: {
        elementRef: target.elementRef,
        selector: target.selector,
        tabId: target.tabId,
        frameId: target.frameId,
        url: target.url,
      },
      resolution: {
        strategy: target.elementRef ? 'elementRef' : 'selector',
        matcher: summarizeWorkflowTargetMatcher(target),
      },
    };
  }

  if (target.coordinates) {
    return {
      target: {
        tabId: target.tabId,
        frameId: target.frameId ?? target.coordinates.frameId,
        url: target.url,
        coordinates: target.coordinates,
      },
      resolution: {
        strategy: 'coordinates',
        matcher: summarizeWorkflowTargetMatcher(target),
      },
    };
  }

  const searchedScope = resolveWorkflowTargetScope(target);
  const capture = existingCapture ?? await capturePageState(sessionId, {
    includeButtons: searchedScope ? searchedScope === 'buttons' : true,
    includeLinks: searchedScope ? searchedScope === 'links' : true,
    includeInputs: searchedScope ? searchedScope === 'inputs' : true,
    includeModals: searchedScope ? searchedScope === 'modals' : true,
    maxItems: 100,
    maxTextLength: 120,
  });
  const candidates = pickWorkflowTargetItems(capture.payload, searchedScope)
    .filter((item) => matchesWorkflowActionTarget(item, target));
  const selection = selectWorkflowTargetCandidate(candidates, target);

  if (candidates.length === 0 || selection.outOfRange) {
    throw new WorkflowTargetResolutionError(
      'workflow_target_not_found',
      'No interactive element matched the workflow target.',
      {
        matcher: summarizeWorkflowTargetMatcher(target),
        searchedScope: searchedScope ?? 'all-interactive',
        matchedCandidateCount: candidates.length,
        selectionStrategy: selection.selectionStrategy,
        selectedIndex: selection.selectedIndex,
        sampledCandidates: pickWorkflowTargetItems(capture.payload, searchedScope)
          .slice(0, 5)
          .map((item) => describeWorkflowTargetCandidate(item)),
      },
    );
  }

  if (!selection.candidate || selection.selectedCandidates.length > 1) {
    throw new WorkflowTargetResolutionError(
      'workflow_target_ambiguous',
      `Workflow target matched ${selection.selectedCandidates.length} elements; refine the matcher or provide nth, first, last, or strict:false.`,
      {
        matcher: summarizeWorkflowTargetMatcher(target),
        matchedCandidateCount: selection.selectedCandidates.length,
        totalMatchedCandidateCount: candidates.length,
        selectionStrategy: selection.selectionStrategy,
        sampledCandidates: selection.selectedCandidates.slice(0, 5).map((item) => describeWorkflowTargetCandidate(item)),
      },
    );
  }

  const candidate = selection.candidate;
  return {
    target: {
      elementRef: typeof candidate.elementRef === 'string' ? candidate.elementRef : undefined,
      selector: typeof candidate.selector === 'string' ? candidate.selector : undefined,
      tabId: target.tabId,
      frameId: target.frameId ?? (typeof candidate.frameId === 'number' ? candidate.frameId : undefined),
      url: target.url,
    },
    resolution: {
      strategy: typeof candidate.elementRef === 'string' ? 'semantic_elementRef' : 'semantic_selector',
      matcher: summarizeWorkflowTargetMatcher(target),
      matchedCandidateCount: candidates.length,
      selectedIndex: selection.selectedIndex ?? 0,
      selectionStrategy: selection.selectionStrategy,
      matched: describeWorkflowTargetCandidate(candidate),
    },
    pageCapture: capture,
  };
}
