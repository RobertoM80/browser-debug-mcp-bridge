export const BRIDGE_SOURCE = 'browser-debug-mcp-bridge';
export const BRIDGE_KIND = 'bridge-event';
export const BRIDGE_CONTROL_KIND = 'bridge-control';

type LiveUIAction = 'click' | 'hover' | 'input' | 'focus' | 'blur' | 'scroll' | 'press_key' | 'submit' | 'reload';

interface LiveUIActionTarget {
  selector?: string;
  elementRef?: string;
  tabId?: number;
  frameId?: number;
  url?: string;
}

interface LiveUIActionBaseRequest {
  action: LiveUIAction;
  traceId?: string;
  target?: LiveUIActionTarget;
}

type LiveUIActionRequest =
  | (LiveUIActionBaseRequest & {
      action: 'click';
      input?: {
        button?: 'left' | 'middle' | 'right';
        clickCount?: number;
      };
    })
  | (LiveUIActionBaseRequest & {
      action: 'hover';
      input?: Record<string, never>;
    })
  | (LiveUIActionBaseRequest & {
      action: 'input';
      input: {
        value: string;
      };
    })
  | (LiveUIActionBaseRequest & {
      action: 'focus';
      input?: Record<string, never>;
    })
  | (LiveUIActionBaseRequest & {
      action: 'blur';
      input?: Record<string, never>;
    })
  | (LiveUIActionBaseRequest & {
      action: 'scroll';
      input?: {
        x?: number;
        y?: number;
        behavior?: 'auto' | 'smooth';
      };
    })
  | (LiveUIActionBaseRequest & {
      action: 'press_key';
      input: {
        key: string;
        altKey?: boolean;
        ctrlKey?: boolean;
        metaKey?: boolean;
        shiftKey?: boolean;
      };
    })
  | (LiveUIActionBaseRequest & {
      action: 'submit';
      input?: Record<string, never>;
    })
  | (LiveUIActionBaseRequest & {
      action: 'reload';
      input?: {
        ignoreCache?: boolean;
      };
    });

interface LiveUIActionFailureReason {
  code: string;
  message: string;
}

interface LiveUIActionTargetSummary {
  matched: boolean;
  selector?: string;
  resolvedSelector?: string;
  tagName?: string;
  textPreview?: string;
  tabId?: number;
  frameId: number;
  url?: string;
}

interface LiveUIActionResult {
  [key: string]: unknown;
  action: LiveUIAction;
  traceId: string;
  status: 'succeeded' | 'rejected' | 'failed';
  executionScope: 'top-document-v1';
  startedAt: number;
  finishedAt: number;
  target: LiveUIActionTargetSummary;
  failureReason?: LiveUIActionFailureReason;
  result?: Record<string, unknown>;
}

function createLiveUIActionTraceId(): string {
  return `uiaction-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseLiveUIActionTarget(value: unknown): LiveUIActionTarget | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const target: LiveUIActionTarget = {};
  if (typeof value.selector === 'string' && value.selector.length > 0) {
    target.selector = value.selector;
  }
  if (typeof value.elementRef === 'string' && value.elementRef.length > 0) {
    target.elementRef = value.elementRef;
  }
  if (isFiniteNumber(value.tabId) && Number.isInteger(value.tabId) && value.tabId >= 0) {
    target.tabId = value.tabId;
  }
  if (isFiniteNumber(value.frameId) && Number.isInteger(value.frameId) && value.frameId >= 0) {
    target.frameId = value.frameId;
  }
  if (typeof value.url === 'string' && value.url.length > 0) {
    try {
      new URL(value.url);
      target.url = value.url;
    } catch {
      return undefined;
    }
  }

  return target;
}

interface LiveElementRefPayload {
  selector?: string;
  testId?: string;
  text?: string;
  label?: string;
  title?: string;
  role?: string;
  name?: string;
  placeholder?: string;
  altText?: string;
  tagName?: string;
  type?: string;
}

function encodeElementRef(payload: LiveElementRefPayload): string {
  return `ref:${btoa(JSON.stringify(payload))}`;
}

function decodeElementRef(value: string): LiveElementRefPayload | undefined {
  if (!value.startsWith('ref:')) {
    return undefined;
  }

  try {
    const decoded = JSON.parse(atob(value.slice(4))) as Record<string, unknown>;
    const result: LiveElementRefPayload = {};
    if (typeof decoded.selector === 'string' && decoded.selector.length > 0) {
      result.selector = decoded.selector;
    }
    if (typeof decoded.testId === 'string' && decoded.testId.length > 0) {
      result.testId = decoded.testId;
    }
    if (typeof decoded.text === 'string' && decoded.text.length > 0) {
      result.text = decoded.text;
    }
    if (typeof decoded.label === 'string' && decoded.label.length > 0) {
      result.label = decoded.label;
    }
    if (typeof decoded.title === 'string' && decoded.title.length > 0) {
      result.title = decoded.title;
    }
    if (typeof decoded.role === 'string' && decoded.role.length > 0) {
      result.role = decoded.role.toLowerCase();
    }
    if (typeof decoded.name === 'string' && decoded.name.length > 0) {
      result.name = decoded.name;
    }
    if (typeof decoded.placeholder === 'string' && decoded.placeholder.length > 0) {
      result.placeholder = decoded.placeholder;
    }
    if (typeof decoded.altText === 'string' && decoded.altText.length > 0) {
      result.altText = decoded.altText;
    }
    if (typeof decoded.tagName === 'string' && decoded.tagName.length > 0) {
      result.tagName = decoded.tagName.toLowerCase();
    }
    if (typeof decoded.type === 'string' && decoded.type.length > 0) {
      result.type = decoded.type.toLowerCase();
    }
    return result;
  } catch {
    return undefined;
  }
}

function parseLiveUIActionRequest(payload: unknown): { success: true; data: LiveUIActionRequest } | { success: false; error: string } {
  if (!isRecord(payload) || typeof payload.action !== 'string') {
    return { success: false, error: 'action is required' };
  }

  const traceId = typeof payload.traceId === 'string' && payload.traceId.length > 0 ? payload.traceId : undefined;
  const target = parseLiveUIActionTarget(payload.target);
  const base = target ? { traceId, target } : { traceId };

  switch (payload.action) {
    case 'click': {
      if (payload.input !== undefined && !isRecord(payload.input)) {
        return { success: false, error: 'click input must be an object' };
      }
      const button = payload.input?.button;
      const clickCount = payload.input?.clickCount;
      if (button !== undefined && button !== 'left' && button !== 'middle' && button !== 'right') {
        return { success: false, error: 'click input.button must be left, middle, or right' };
      }
      if (clickCount !== undefined && (!isFiniteNumber(clickCount) || !Number.isInteger(clickCount) || clickCount < 1 || clickCount > 3)) {
        return { success: false, error: 'click input.clickCount must be an integer between 1 and 3' };
      }
      return { success: true, data: { action: 'click', ...base, input: payload.input ? { button, clickCount } : undefined } };
    }
    case 'hover':
      return { success: true, data: { action: 'hover', ...base } };
    case 'input': {
      if (!isRecord(payload.input) || typeof payload.input.value !== 'string') {
        return { success: false, error: 'input action requires input.value' };
      }
      return { success: true, data: { action: 'input', ...base, input: { value: payload.input.value } } };
    }
    case 'focus':
    case 'blur':
    case 'submit':
      return { success: true, data: { action: payload.action, ...base } };
    case 'scroll': {
      if (payload.input !== undefined && !isRecord(payload.input)) {
        return { success: false, error: 'scroll input must be an object' };
      }
      const x = payload.input?.x;
      const y = payload.input?.y;
      const behavior = payload.input?.behavior;
      if (x !== undefined && !isFiniteNumber(x)) {
        return { success: false, error: 'scroll input.x must be a number' };
      }
      if (y !== undefined && !isFiniteNumber(y)) {
        return { success: false, error: 'scroll input.y must be a number' };
      }
      if (behavior !== undefined && behavior !== 'auto' && behavior !== 'smooth') {
        return { success: false, error: 'scroll input.behavior must be auto or smooth' };
      }
      return { success: true, data: { action: 'scroll', ...base, input: payload.input ? { x, y, behavior } : undefined } };
    }
    case 'press_key': {
      if (!isRecord(payload.input) || typeof payload.input.key !== 'string' || payload.input.key.length === 0) {
        return { success: false, error: 'press_key action requires input.key' };
      }
      for (const flag of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const) {
        const value = payload.input[flag];
        if (value !== undefined && typeof value !== 'boolean') {
          return { success: false, error: `press_key input.${flag} must be a boolean` };
        }
      }
      return {
        success: true,
        data: {
          action: 'press_key',
          ...base,
          input: {
            key: payload.input.key,
            altKey: payload.input.altKey as boolean | undefined,
            ctrlKey: payload.input.ctrlKey as boolean | undefined,
            metaKey: payload.input.metaKey as boolean | undefined,
            shiftKey: payload.input.shiftKey as boolean | undefined,
          },
        },
      };
    }
    case 'reload': {
      if (payload.input !== undefined && !isRecord(payload.input)) {
        return { success: false, error: 'reload input must be an object' };
      }
      const ignoreCache = payload.input?.ignoreCache;
      if (ignoreCache !== undefined && typeof ignoreCache !== 'boolean') {
        return { success: false, error: 'reload input.ignoreCache must be a boolean' };
      }
      return { success: true, data: { action: 'reload', ...base, input: payload.input ? { ignoreCache } : undefined } };
    }
    default:
      return { success: false, error: `unsupported action: ${payload.action}` };
  }
}

export interface BridgePayload {
  source: string;
  kind: string;
  eventType: string;
  data: Record<string, unknown>;
}

type CaptureCommandType =
  | 'CAPTURE_DOM_SUBTREE'
  | 'CAPTURE_DOM_DOCUMENT'
  | 'CAPTURE_COMPUTED_STYLES'
  | 'CAPTURE_LAYOUT_METRICS'
  | 'CAPTURE_MEDIA_STATE'
  | 'CAPTURE_PAGE_STATE'
  | 'CAPTURE_UI_SNAPSHOT'
  | 'SET_VIEWPORT'
  | 'EXECUTE_UI_ACTION';

type SnapshotStyleMode = 'computed-lite' | 'computed-full';

interface CaptureCommandRequest {
  type: 'CAPTURE_EXECUTE';
  command: CaptureCommandType;
  payload?: Record<string, unknown>;
}

interface CapturePingRequest {
  type: 'CAPTURE_PING';
}

interface CaptureConfigUpdateRequest {
  type: 'CAPTURE_CONFIG_UPDATE';
  payload?: {
    captureEnabled?: unknown;
    network?: {
      captureBodies?: unknown;
      maxBodyBytes?: unknown;
    };
    automation?: {
      enabled?: unknown;
      allowSensitiveFields?: unknown;
      status?: unknown;
      sessionId?: unknown;
      traceId?: unknown;
      action?: unknown;
    };
  };
}

interface BridgeControlPayload {
  source: string;
  kind: string;
  controlType: string;
  data: Record<string, unknown>;
}

interface CaptureCommandResponse {
  ok: boolean;
  result?: Record<string, unknown>;
  truncated?: boolean;
  error?: string;
}

interface AutomationIndicatorState {
  enabled: boolean;
  allowSensitiveFields: boolean;
  status: 'idle' | 'armed' | 'executing';
  sessionId?: string;
  traceId?: string;
  action?: string;
}

const AUTOMATION_INDICATOR_ID = '__bdmcp_automation_indicator__';

type EditableActionTarget = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement;

function getClickableTarget(event: Event): Element | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  const firstPathTarget = path.find((entry) => entry instanceof Element);
  if (firstPathTarget instanceof Element) {
    return firstPathTarget;
  }

  if (event.target instanceof Element) {
    return event.target;
  }

  return null;
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

const SHADOW_SELECTOR_SEPARATOR = ' >> ';

function getLocalElementSelector(target: Element): string | null {
  if (target.id) {
    return `#${cssEscape(target.id)}`;
  }

  const testId = target.getAttribute('data-testid');
  if (testId) {
    return `[data-testid="${cssEscape(testId)}"]`;
  }

  const classes = Array.from(target.classList).filter((entry) => !/^\d/.test(entry));
  if (classes.length > 0) {
    return `${target.tagName.toLowerCase()}.${cssEscape(classes[0])}`;
  }

  const tagName = target.tagName.toLowerCase();
  return tagName || null;
}

function getElementSelector(target: Element): string {
  const localSelector = getLocalElementSelector(target) ?? target.tagName.toLowerCase();
  const root = target.getRootNode();
  if (root instanceof ShadowRoot) {
    return `${getElementSelector(root.host)}${SHADOW_SELECTOR_SEPARATOR}${localSelector}`;
  }

  return localSelector;
}

function getClickSelector(target: Element): string | null {
  return getElementSelector(target);
}

function queryElementInRoot(root: Document | ShadowRoot, selector: string): Element | null {
  const parts = selector
    .split(SHADOW_SELECTOR_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length === 0) {
    return null;
  }

  let currentRoot: Document | ShadowRoot = root;
  let currentElement: Element | null = null;
  for (const [index, part] of parts.entries()) {
    currentElement = currentRoot.querySelector(part);
    if (!currentElement) {
      return null;
    }
    if (index < parts.length - 1) {
      const shadowRoot = currentElement.shadowRoot;
      if (!shadowRoot) {
        return null;
      }
      currentRoot = shadowRoot;
    }
  }

  return currentElement;
}

function getRootForElement(target: Element): Document | ShadowRoot {
  const root = target.getRootNode();
  return root instanceof ShadowRoot ? root : target.ownerDocument;
}

function getElementTextPreview(target: Element | null): string | undefined {
  const text = target?.textContent?.replace(/\s+/g, ' ').trim();
  if (!text) {
    return undefined;
  }

  return text.slice(0, 80);
}

function clampPageStateItems(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 40;
  }

  const floored = Math.floor(value);
  if (floored < 1) {
    return 40;
  }

  return Math.min(floored, 100);
}

function clampPageStateTextLength(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 80;
  }

  const floored = Math.floor(value);
  if (floored < 8) {
    return 80;
  }

  return Math.min(floored, 200);
}

function truncatePreview(value: string | null | undefined, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.slice(0, maxLength);
}

function getElementTestId(target: Element): string | undefined {
  return truncatePreview(target.getAttribute('data-testid'), 120);
}

function getAriaBoolean(target: Element, attribute: 'aria-pressed' | 'aria-selected' | 'aria-expanded'): boolean | undefined {
  const value = target.getAttribute(attribute);
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return undefined;
}

function getNativeRole(target: Element): string | undefined {
  const explicitRole = truncatePreview(target.getAttribute('role'), 32);
  if (explicitRole) {
    return explicitRole.toLowerCase();
  }

  const tagName = target.tagName.toLowerCase();
  if (tagName === 'button') {
    return 'button';
  }
  if ((tagName === 'a' || tagName === 'area') && target.hasAttribute('href')) {
    return 'link';
  }
  if (tagName === 'textarea') {
    return 'textbox';
  }
  if (tagName === 'select') {
    return 'combobox';
  }
  if (target instanceof HTMLInputElement) {
    if (target.type === 'button' || target.type === 'submit' || target.type === 'reset') {
      return 'button';
    }
    if (target.type === 'checkbox' || target.type === 'radio') {
      return target.type;
    }
    if (target.type === 'range') {
      return 'slider';
    }
    return 'textbox';
  }
  if (tagName === 'img') {
    return 'img';
  }
  if (target.getAttribute('aria-modal') === 'true') {
    return 'dialog';
  }
  return undefined;
}

function getElementAltText(target: Element, maxTextLength: number): string | undefined {
  if (target instanceof HTMLImageElement || target instanceof HTMLAreaElement || target instanceof HTMLInputElement) {
    return truncatePreview(target.getAttribute('alt'), maxTextLength);
  }
  return undefined;
}

function resolveAriaLabelledBy(target: Element, maxTextLength: number): string | undefined {
  const labelledBy = target.getAttribute('aria-labelledby');
  if (!labelledBy) {
    return undefined;
  }

  const parts = labelledBy
    .split(/\s+/)
    .map((id) => {
      const root = getRootForElement(target);
      if (root instanceof Document) {
        return root.getElementById(id);
      }
      return root.getElementById(id);
    })
    .filter((element): element is HTMLElement => Boolean(element))
    .map((element) => truncatePreview(element.textContent, maxTextLength))
    .filter((value): value is string => Boolean(value));
  return truncatePreview(parts.join(' '), maxTextLength);
}

function getElementAccessibleName(target: Element, maxTextLength: number): string | undefined {
  const ariaLabel = truncatePreview(target.getAttribute('aria-label'), maxTextLength);
  if (ariaLabel) {
    return ariaLabel;
  }

  const labelledBy = resolveAriaLabelledBy(target, maxTextLength);
  if (labelledBy) {
    return labelledBy;
  }

  const altText = getElementAltText(target, maxTextLength);
  if (altText) {
    return altText;
  }

  const label = resolveInputLabel(target, maxTextLength);
  if (label) {
    return label;
  }

  if (target instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(target.type)) {
    const valueName = truncatePreview(target.value || target.getAttribute('value'), maxTextLength);
    if (valueName) {
      return valueName;
    }
  }

  const text = truncatePreview(target.textContent, maxTextLength);
  if (text) {
    return text;
  }

  return truncatePreview(target.getAttribute('title'), maxTextLength);
}

function isElementDisabled(target: Element): boolean {
  if (target instanceof HTMLButtonElement || target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) {
    return target.disabled;
  }

  const ariaDisabled = target.getAttribute('aria-disabled');
  return ariaDisabled === 'true';
}

function isElementVisibleForSummary(target: Element): boolean {
  if (!(target instanceof HTMLElement) && !(target instanceof SVGElement)) {
    return false;
  }

  const rect = target.getBoundingClientRect();
  const style = getComputedStyle(target);
  return rect.width > 0
    && rect.height > 0
    && style.display !== 'none'
    && style.visibility !== 'hidden'
    && Number(style.opacity || '1') > 0
    && target.getAttribute('aria-hidden') !== 'true';
}

function resolveInputLabel(target: Element, maxTextLength: number): string | undefined {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    const labels = target.labels ? Array.from(target.labels) : [];
    for (const label of labels) {
      const text = truncatePreview(label.textContent, maxTextLength);
      if (text) {
        return text;
      }
    }

    if (target.id) {
      const explicit = getRootForElement(target).querySelector(`label[for="${cssEscape(target.id)}"]`);
      if (explicit) {
        const text = truncatePreview(explicit.textContent, maxTextLength);
        if (text) {
          return text;
        }
      }
    }
  }

  const ariaLabel = truncatePreview(target.getAttribute('aria-label'), maxTextLength);
  if (ariaLabel) {
    return ariaLabel;
  }

  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return truncatePreview(target.placeholder, maxTextLength);
  }

  return undefined;
}

function collectUniqueElements(selectors: string[], root: Document | ShadowRoot = document): Element[] {
  const seen = new Set<Element>();
  const elements: Element[] = [];
  const visitRoot = (currentRoot: Document | ShadowRoot): void => {
    for (const selector of selectors) {
      for (const element of Array.from(currentRoot.querySelectorAll(selector))) {
        if (seen.has(element)) {
          continue;
        }
        seen.add(element);
        elements.push(element);
      }
    }

    for (const element of Array.from(currentRoot.querySelectorAll('*'))) {
      if (element.shadowRoot) {
        visitRoot(element.shadowRoot);
      }
    }
  };

  visitRoot(root);
  return elements;
}

function summarizeButtonElement(target: Element, maxTextLength: number): Record<string, unknown> {
  const text = truncatePreview(
    target instanceof HTMLInputElement ? (target.value || target.getAttribute('value')) : target.textContent,
    maxTextLength,
  );
  const selector = getElementSelector(target);
  const testId = getElementTestId(target);
  const role = getNativeRole(target);
  const name = getElementAccessibleName(target, maxTextLength);
  return {
    text,
    name,
    selector,
    testId,
    elementRef: encodeElementRef({
      selector,
      testId,
      text,
      name,
      role,
      tagName: target.tagName.toLowerCase(),
      type: target instanceof HTMLInputElement ? resolveFieldType(target) : undefined,
    }),
    disabled: isElementDisabled(target),
    visible: isElementVisibleForSummary(target),
    pressed: getAriaBoolean(target, 'aria-pressed'),
    selected: getAriaBoolean(target, 'aria-selected'),
    expanded: getAriaBoolean(target, 'aria-expanded'),
    role,
    tagName: target.tagName.toLowerCase(),
  };
}

function summarizeLinkElement(target: Element, maxTextLength: number): Record<string, unknown> {
  const text = truncatePreview(target.textContent, maxTextLength);
  const selector = getElementSelector(target);
  const testId = getElementTestId(target);
  const role = getNativeRole(target);
  const name = getElementAccessibleName(target, maxTextLength);
  return {
    text,
    name,
    selector,
    testId,
    href: target instanceof HTMLAnchorElement || target instanceof HTMLAreaElement
      ? truncatePreview(target.href, maxTextLength)
      : undefined,
    elementRef: encodeElementRef({
      selector,
      testId,
      text,
      name,
      role,
      tagName: target.tagName.toLowerCase(),
    }),
    disabled: isElementDisabled(target),
    visible: isElementVisibleForSummary(target),
    role,
    tagName: target.tagName.toLowerCase(),
  };
}

function summarizeInputElement(target: Element, maxTextLength: number): Record<string, unknown> {
  const editable = isEditableElement(target);
  const formField = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
  const valueLength = editable ? getEditableElementValueLength(target) : undefined;
  const label = resolveInputLabel(target, maxTextLength);
  const selector = getElementSelector(target);
  const testId = getElementTestId(target);
  const type = formField ? resolveFieldType(target as FormFieldElement) : (target instanceof HTMLElement && target.isContentEditable ? 'contenteditable' : target.tagName.toLowerCase());
  const role = getNativeRole(target);
  const placeholder = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    ? truncatePreview(target.placeholder, maxTextLength)
    : undefined;
  const name = getElementAccessibleName(target, maxTextLength);
  return {
    label,
    name,
    selector,
    testId,
    elementRef: encodeElementRef({
      selector,
      testId,
      label,
      name,
      placeholder,
      role,
      tagName: target.tagName.toLowerCase(),
      type,
    }),
    type,
    placeholder,
    role,
    disabled: isElementDisabled(target),
    visible: isElementVisibleForSummary(target),
    readOnly:
      target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
        ? target.readOnly
        : undefined,
    required:
      target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
        ? target.required
        : undefined,
    valueLength,
  };
}

function summarizeModalElement(target: Element, maxTextLength: number): Record<string, unknown> {
  const heading = target.querySelector('h1, h2, h3, [role="heading"]');
  const firstButton = target.querySelector('button, [role="button"]');
  const fieldCount = target.querySelectorAll('input, textarea, select, [contenteditable="true"], [contenteditable=""]').length;
  const title = truncatePreview(heading?.textContent ?? target.getAttribute('aria-label') ?? target.getAttribute('data-testid'), maxTextLength);
  const selector = getElementSelector(target);
  const testId = getElementTestId(target);
  const role = getNativeRole(target);
  const name = getElementAccessibleName(target, maxTextLength);
  return {
    title,
    name,
    selector,
    testId,
    elementRef: encodeElementRef({
      selector,
      testId,
      title,
      name,
      role,
      tagName: target.tagName.toLowerCase(),
    }),
    role,
    visible: isElementVisibleForSummary(target),
    buttonCount: target.querySelectorAll('button, [role="button"]').length,
    fieldCount,
    primaryAction: truncatePreview(firstButton?.textContent, maxTextLength),
  };
}

function resolveElementFromRef(win: Window, elementRef: string): Element | null {
  const ref = decodeElementRef(elementRef);
  if (!ref) {
    return null;
  }

  const matches = (target: Element): boolean => {
    if (ref.tagName && target.tagName.toLowerCase() !== ref.tagName) {
      return false;
    }
    if (ref.testId && target.getAttribute('data-testid') !== ref.testId) {
      return false;
    }
    if (ref.type && target instanceof HTMLInputElement && resolveFieldType(target) !== ref.type) {
      return false;
    }
    if (ref.text && !truncatePreview(target.textContent, 200)?.toLowerCase().includes(ref.text.toLowerCase())) {
      return false;
    }
    if (ref.label && !resolveInputLabel(target, 200)?.toLowerCase().includes(ref.label.toLowerCase())) {
      return false;
    }
    if (ref.title) {
      const heading = target.querySelector('h1, h2, h3, [role="heading"]');
      const title = truncatePreview(heading?.textContent ?? target.getAttribute('aria-label') ?? target.getAttribute('data-testid'), 200);
      if (!title?.toLowerCase().includes(ref.title.toLowerCase())) {
        return false;
      }
    }
    if (ref.role && getNativeRole(target) !== ref.role) {
      return false;
    }
    if (ref.name && !getElementAccessibleName(target, 200)?.toLowerCase().includes(ref.name.toLowerCase())) {
      return false;
    }
    if (ref.placeholder) {
      const placeholder = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
        ? truncatePreview(target.placeholder, 200)
        : undefined;
      if (!placeholder?.toLowerCase().includes(ref.placeholder.toLowerCase())) {
        return false;
      }
    }
    if (ref.altText && !getElementAltText(target, 200)?.toLowerCase().includes(ref.altText.toLowerCase())) {
      return false;
    }
    return true;
  };

  if (ref.testId) {
    const selector = `[data-testid="${cssEscape(ref.testId)}"]`;
    for (const target of collectUniqueElements([selector], win.document)) {
      if (matches(target)) {
        return target;
      }
    }
  }

  if (ref.selector) {
    const target = queryElementInRoot(win.document, ref.selector);
    if (target && matches(target)) {
      return target;
    }
  }

  const candidates = collectUniqueElements([
    'button',
    '[role="button"]',
    'a[href]',
    'area[href]',
    '[role="link"]',
    'input',
    'textarea',
    'select',
    '[role="dialog"]',
    '[aria-modal="true"]',
    '[contenteditable="true"]',
    '[contenteditable=""]',
  ]);

  return candidates.find((target) => matches(target)) ?? null;
}

function getDeepActiveElement(root: Document | ShadowRoot): Element | null {
  let activeElement = root.activeElement;
  while (activeElement?.shadowRoot?.activeElement) {
    activeElement = activeElement.shadowRoot.activeElement;
  }
  return activeElement;
}

function capturePageState(win: Window, payload: Record<string, unknown>): { result: Record<string, unknown>; truncated: boolean } {
  const maxItems = clampPageStateItems(payload.maxItems);
  const maxTextLength = clampPageStateTextLength(payload.maxTextLength);
  const includeButtons = payload.includeButtons !== false;
  const includeLinks = payload.includeLinks !== false;
  const includeInputs = payload.includeInputs !== false;
  const includeModals = payload.includeModals !== false;

  const buttonElements = includeButtons
    ? collectUniqueElements([
        'button',
        '[role="button"]',
        'input[type="button"]',
        'input[type="submit"]',
        'input[type="reset"]',
      ])
    : [];
  const linkElements = includeLinks
    ? collectUniqueElements([
        'a[href]',
        'area[href]',
        '[role="link"]',
      ])
    : [];
  const inputElements = includeInputs
    ? collectUniqueElements([
        'input',
        'textarea',
        'select',
        '[contenteditable="true"]',
        '[contenteditable=""]',
      ])
    : [];
  const modalElements = includeModals
    ? collectUniqueElements([
        '[role="dialog"]',
        '[aria-modal="true"]',
        '[data-testid="modal-surface"]',
        '[data-testid="modal"]',
      ])
    : [];

  const buttons = buttonElements.slice(0, maxItems).map((element) => summarizeButtonElement(element, maxTextLength));
  const links = linkElements.slice(0, maxItems).map((element) => summarizeLinkElement(element, maxTextLength));
  const inputs = inputElements.slice(0, maxItems).map((element) => summarizeInputElement(element, maxTextLength));
  const modals = modalElements.slice(0, maxItems).map((element) => summarizeModalElement(element, maxTextLength));
  const activeElement = getDeepActiveElement(win.document);
  const focused = activeElement instanceof Element
    ? {
        selector: getElementSelector(activeElement),
        testId: getElementTestId(activeElement),
        elementRef: encodeElementRef({
          selector: getElementSelector(activeElement),
          testId: getElementTestId(activeElement),
          text: truncatePreview(activeElement.textContent, maxTextLength),
          name: getElementAccessibleName(activeElement, maxTextLength),
          role: getNativeRole(activeElement),
          tagName: activeElement.tagName.toLowerCase(),
        }),
        tagName: activeElement.tagName.toLowerCase(),
        text: truncatePreview(activeElement.textContent, maxTextLength),
        name: getElementAccessibleName(activeElement, maxTextLength),
        role: getNativeRole(activeElement),
        visible: isElementVisibleForSummary(activeElement),
      }
    : undefined;

  const truncated = buttonElements.length > buttons.length || linkElements.length > links.length || inputElements.length > inputs.length || modalElements.length > modals.length;

  return {
    truncated,
    result: {
      url: win.location.href,
      title: truncatePreview(win.document.title, maxTextLength),
      readyState: win.document.readyState,
      language: truncatePreview(win.document.documentElement.lang || navigator.language, 32),
      viewport: {
        width: win.innerWidth,
        height: win.innerHeight,
        scrollX: win.scrollX,
        scrollY: win.scrollY,
      },
      focused,
      summary: {
        buttons: buttonElements.length,
        links: linkElements.length,
        inputs: inputElements.length,
        modals: modalElements.length,
      },
      buttons: includeButtons ? buttons : undefined,
      links: includeLinks ? links : undefined,
      inputs: includeInputs ? inputs : undefined,
      modals: includeModals ? modals : undefined,
      truncation: {
        buttons: buttonElements.length > buttons.length,
        links: linkElements.length > links.length,
        inputs: inputElements.length > inputs.length,
        modals: modalElements.length > modals.length,
      },
    },
  };
}

function buildLiveActionTargetSummary(
  target: Element | null,
  request: LiveUIActionRequest,
): LiveUIActionResult['target'] {
  return {
    matched: target instanceof Element,
    selector: request.target?.selector,
    resolvedSelector: target instanceof Element ? getElementSelector(target) : undefined,
    tagName: target instanceof Element ? target.tagName.toLowerCase() : undefined,
    textPreview: getElementTextPreview(target),
    frameId: request.target?.frameId ?? 0,
    url: request.target?.url,
  };
}

function buildRejectedLiveActionResult(
  request: LiveUIActionRequest,
  target: Element | null,
  startedAt: number,
  code: string,
  message: string,
): LiveUIActionResult {
  return {
    action: request.action,
    traceId: request.traceId ?? createLiveUIActionTraceId(),
    status: 'rejected',
    executionScope: 'top-document-v1',
    startedAt,
    finishedAt: Date.now(),
    target: buildLiveActionTargetSummary(target, request),
    failureReason: {
      code,
      message,
    },
  };
}

function buildSucceededLiveActionResult(
  request: LiveUIActionRequest,
  target: Element | null,
  startedAt: number,
  result: Record<string, unknown> = {},
): LiveUIActionResult {
  return {
    action: request.action,
    traceId: request.traceId ?? createLiveUIActionTraceId(),
    status: 'succeeded',
    executionScope: 'top-document-v1',
    startedAt,
    finishedAt: Date.now(),
    target: buildLiveActionTargetSummary(target, request),
    result,
  };
}

function buildFailedLiveActionResult(
  request: LiveUIActionRequest,
  target: Element | null,
  startedAt: number,
  code: string,
  message: string,
): LiveUIActionResult {
  return {
    action: request.action,
    traceId: request.traceId ?? createLiveUIActionTraceId(),
    status: 'failed',
    executionScope: 'top-document-v1',
    startedAt,
    finishedAt: Date.now(),
    target: buildLiveActionTargetSummary(target, request),
    failureReason: {
      code,
      message,
    },
  };
}

function isSensitiveSelector(selector: string): boolean {
  return /(password|passwd|pwd|token|secret|auth|session|email|card|cvv|cvc|ssn|iban|payment)/i.test(selector);
}

function isEditableElement(target: Element | null): target is EditableActionTarget {
  return Boolean(
    target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable),
  );
}

function getNativeValueSetter(target: HTMLInputElement | HTMLTextAreaElement): ((this: HTMLInputElement | HTMLTextAreaElement, value: string) => void) | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'value');
  return descriptor?.set as ((this: HTMLInputElement | HTMLTextAreaElement, value: string) => void) | undefined;
}

function setEditableElementValue(target: EditableActionTarget, value: string): void {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const setter = getNativeValueSetter(target);
    if (setter) {
      setter.call(target, value);
    } else {
      target.value = value;
    }
    return;
  }

  if (target instanceof HTMLSelectElement) {
    const matchingOption = Array.from(target.options).find((option) => option.value === value || option.text === value);
    if (matchingOption) {
      target.value = matchingOption.value;
      return;
    }

    target.value = value;
    return;
  }

  target.textContent = value;
}

function getEditableElementValueLength(target: EditableActionTarget): number {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return target.value.length;
  }

  return target.textContent?.length ?? 0;
}

function dispatchBubbledEvent(target: EventTarget, event: Event): boolean {
  return target.dispatchEvent(event);
}

function dispatchMouseClick(target: Element, button: 'left' | 'middle' | 'right' = 'left', clickCount = 1): void {
  const buttonCode = button === 'middle' ? 1 : button === 'right' ? 2 : 0;

  if (target instanceof HTMLElement) {
    target.focus();
  }

  for (let index = 1; index <= clickCount; index += 1) {
    dispatchBubbledEvent(target, new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: buttonCode, buttons: 1, detail: index }));
    dispatchBubbledEvent(target, new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: buttonCode, buttons: 0, detail: index }));
    if (button === 'left' && target instanceof HTMLElement && typeof target.click === 'function') {
      target.click();
    } else {
      dispatchBubbledEvent(target, new MouseEvent('click', { bubbles: true, cancelable: true, button: buttonCode, detail: index }));
    }
  }

  if (clickCount >= 2) {
    dispatchBubbledEvent(target, new MouseEvent('dblclick', { bubbles: true, cancelable: true, button: buttonCode, detail: clickCount }));
  }
}

function dispatchMouseHover(target: Element): void {
  const rect = target.getBoundingClientRect();
  const eventInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
  dispatchBubbledEvent(target, new MouseEvent('mouseover', eventInit));
  dispatchBubbledEvent(target, new MouseEvent('mouseenter', { ...eventInit, bubbles: false }));
  dispatchBubbledEvent(target, new MouseEvent('mousemove', eventInit));
}

function dispatchInputValue(target: EditableActionTarget, value: string): { fieldType: string; valueLength: number } {
  setEditableElementValue(target, value);

  const beforeInput = typeof InputEvent === 'function'
    ? new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: value, inputType: 'insertText' })
    : new Event('beforeinput', { bubbles: true, cancelable: true });
  dispatchBubbledEvent(target, beforeInput);

  const inputEvent = typeof InputEvent === 'function'
    ? new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' })
    : new Event('input', { bubbles: true });
  dispatchBubbledEvent(target, inputEvent);
  dispatchBubbledEvent(target, new Event('change', { bubbles: true }));

  const fieldType = target instanceof HTMLElement && target.isContentEditable
    ? 'contenteditable'
    : resolveFieldType(target as FormFieldElement);

  return {
    fieldType,
    valueLength: getEditableElementValueLength(target),
  };
}

function dispatchFocusAction(target: Element): void {
  if (target instanceof HTMLElement) {
    target.focus();
  }
  dispatchBubbledEvent(target, new FocusEvent('focus', { bubbles: false }));
  dispatchBubbledEvent(target, new FocusEvent('focusin', { bubbles: true }));
}

function dispatchBlurAction(target: Element): void {
  if (target instanceof HTMLElement) {
    target.blur();
  }
  dispatchBubbledEvent(target, new FocusEvent('blur', { bubbles: false }));
  dispatchBubbledEvent(target, new FocusEvent('focusout', { bubbles: true }));
}

function dispatchScrollAction(win: Window, target: Element | null, x?: number, y?: number, behavior: ScrollBehavior = 'auto'): Record<string, unknown> {
  const resolvedX = typeof x === 'number' && Number.isFinite(x) ? x : 0;
  const resolvedY = typeof y === 'number' && Number.isFinite(y) ? y : 0;

  if (!target || target === win.document.documentElement || target === win.document.body) {
    win.scrollTo({ left: resolvedX, top: resolvedY, behavior });
    return {
      scrollTarget: 'window',
      x: win.scrollX,
      y: win.scrollY,
      behavior,
    };
  }

  if (target instanceof HTMLElement) {
    target.scrollTo({ left: resolvedX, top: resolvedY, behavior });
    dispatchBubbledEvent(target, new Event('scroll', { bubbles: true }));
    return {
      scrollTarget: getElementSelector(target),
      x: target.scrollLeft,
      y: target.scrollTop,
      behavior,
    };
  }

  throw new Error('Resolved target does not support scrolling');
}

function applyKeyboardMutation(target: EditableActionTarget, key: string): void {
  if (target instanceof HTMLSelectElement) {
    return;
  }

  const currentValue = target instanceof HTMLElement && target.isContentEditable
    ? (target.textContent ?? '')
    : (target as HTMLInputElement | HTMLTextAreaElement).value;

  let nextValue = currentValue;
  if (key === 'Backspace') {
    nextValue = currentValue.slice(0, -1);
  } else if (key === 'Enter') {
    nextValue = `${currentValue}${target instanceof HTMLInputElement ? '' : '\n'}`;
  } else if (key.length === 1) {
    nextValue = `${currentValue}${key}`;
  } else {
    return;
  }

  setEditableElementValue(target, nextValue);
  dispatchBubbledEvent(
    target,
    typeof InputEvent === 'function'
      ? new InputEvent('input', { bubbles: true, data: key.length === 1 ? key : null, inputType: key === 'Backspace' ? 'deleteContentBackward' : 'insertText' })
      : new Event('input', { bubbles: true }),
  );
}

function dispatchKeyboardAction(target: Element, payload: Extract<LiveUIActionRequest, { action: 'press_key' }>['input']): Record<string, unknown> {
  if (target instanceof HTMLElement) {
    target.focus();
  }

  const eventInit: KeyboardEventInit = {
    bubbles: true,
    cancelable: true,
    key: payload.key,
    altKey: payload.altKey === true,
    ctrlKey: payload.ctrlKey === true,
    metaKey: payload.metaKey === true,
    shiftKey: payload.shiftKey === true,
  };

  dispatchBubbledEvent(target, new KeyboardEvent('keydown', eventInit));
  if (payload.key.length === 1 || payload.key === 'Enter') {
    dispatchBubbledEvent(target, new KeyboardEvent('keypress', eventInit));
  }

  if (!eventInit.altKey && !eventInit.ctrlKey && !eventInit.metaKey && isEditableElement(target)) {
    applyKeyboardMutation(target, payload.key);
  }

  dispatchBubbledEvent(target, new KeyboardEvent('keyup', eventInit));

  return {
    key: payload.key,
    modifiers: {
      altKey: eventInit.altKey,
      ctrlKey: eventInit.ctrlKey,
      metaKey: eventInit.metaKey,
      shiftKey: eventInit.shiftKey,
    },
  };
}

function resolveFormTarget(target: Element): HTMLFormElement | null {
  if (target instanceof HTMLFormElement) {
    return target;
  }

  if (target instanceof HTMLButtonElement || target instanceof HTMLInputElement) {
    return target.form;
  }

  return target.closest('form');
}

function requestFormSubmit(form: HTMLFormElement): void {
  if (typeof form.requestSubmit === 'function') {
    form.requestSubmit();
    return;
  }

  const event = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: undefined });
  dispatchBubbledEvent(form, event);
}

function executeLiveUiAction(win: Window, request: LiveUIActionRequest, startedAt: number, target: Element | null): LiveUIActionResult {
  try {
    if (request.action === 'click') {
      if (!target) {
        return buildRejectedLiveActionResult(request, null, startedAt, 'target_not_found', 'No matching top-document element was found for this live UI action.');
      }

      dispatchMouseClick(target, request.input?.button, request.input?.clickCount ?? 1);
      return buildSucceededLiveActionResult(request, target, startedAt, {
        clickCount: request.input?.clickCount ?? 1,
        button: request.input?.button ?? 'left',
      });
    }

    if (request.action === 'hover') {
      if (!target) {
        return buildRejectedLiveActionResult(request, null, startedAt, 'target_not_found', 'No matching top-document element was found for this live UI action.');
      }

      dispatchMouseHover(target);
      return buildSucceededLiveActionResult(request, target, startedAt, {
        hovered: true,
      });
    }

    if (request.action === 'input') {
      if (!target) {
        return buildRejectedLiveActionResult(request, null, startedAt, 'target_not_found', 'No matching top-document element was found for this live UI action.');
      }
      if (!isEditableElement(target)) {
        return buildRejectedLiveActionResult(request, target, startedAt, 'target_not_editable', 'The resolved target does not accept text input.');
      }

      if (target instanceof HTMLElement) {
        target.focus();
      }
      const inputResult = dispatchInputValue(target, request.input.value);
      return buildSucceededLiveActionResult(request, target, startedAt, inputResult);
    }

    if (request.action === 'focus') {
      if (!target) {
        return buildRejectedLiveActionResult(request, null, startedAt, 'target_not_found', 'No matching top-document element was found for this live UI action.');
      }

      dispatchFocusAction(target);
      return buildSucceededLiveActionResult(request, target, startedAt, {
        focused: true,
      });
    }

    if (request.action === 'blur') {
      if (!target) {
        return buildRejectedLiveActionResult(request, null, startedAt, 'target_not_found', 'No matching top-document element was found for this live UI action.');
      }

      dispatchBlurAction(target);
      return buildSucceededLiveActionResult(request, target, startedAt, {
        blurred: true,
      });
    }

    if (request.action === 'scroll') {
      const scrollResult = dispatchScrollAction(win, target, request.input?.x, request.input?.y, request.input?.behavior ?? 'auto');
      return buildSucceededLiveActionResult(request, target, startedAt, scrollResult);
    }

    if (request.action === 'press_key') {
      const keyboardTarget = target ?? (win.document.activeElement instanceof Element ? win.document.activeElement : null) ?? win.document.body;
      if (!keyboardTarget) {
        return buildRejectedLiveActionResult(request, null, startedAt, 'target_not_found', 'No keyboard target is available for this live UI action.');
      }

      const keyResult = dispatchKeyboardAction(keyboardTarget, request.input);
      return buildSucceededLiveActionResult(request, keyboardTarget, startedAt, keyResult);
    }

    if (request.action === 'submit') {
      if (!target) {
        return buildRejectedLiveActionResult(request, null, startedAt, 'target_not_found', 'No matching top-document element was found for this live UI action.');
      }

      const form = resolveFormTarget(target);
      if (!form) {
        return buildRejectedLiveActionResult(request, target, startedAt, 'form_not_found', 'The resolved target is not associated with a form.');
      }

      requestFormSubmit(form);
      return buildSucceededLiveActionResult(request, form, startedAt, {
        submitted: true,
        method: (form.method || 'get').toLowerCase(),
        action: form.action || win.location.href,
      });
    }

    return buildRejectedLiveActionResult(
      request,
      target,
      startedAt,
      'action_not_supported',
      `Live UI action "${request.action}" is not supported in the top-document executor.`,
    );
  } catch (error) {
    return buildFailedLiveActionResult(
      request,
      target,
      startedAt,
      'action_execution_failed',
      error instanceof Error ? error.message : 'Live UI action execution failed.',
    );
  }
}

function normalizeAutomationIndicatorState(value: CaptureConfigUpdateRequest['payload']): AutomationIndicatorState {
  const input = value?.automation;
  const rawStatus = input?.status;
  return {
    enabled: input?.enabled === true,
    allowSensitiveFields: input?.allowSensitiveFields === true,
    status: rawStatus === 'armed' || rawStatus === 'executing' ? rawStatus : 'idle',
    sessionId: typeof input?.sessionId === 'string' ? input.sessionId : undefined,
    traceId: typeof input?.traceId === 'string' ? input.traceId : undefined,
    action: typeof input?.action === 'string' ? input.action : undefined,
  };
}

function removeAutomationIndicator(win: Window): void {
  win.document.getElementById(AUTOMATION_INDICATOR_ID)?.remove();
}

function renderAutomationIndicator(win: Window, runtime: RuntimeMessenger, state: AutomationIndicatorState): void {
  if (state.status === 'idle') {
    removeAutomationIndicator(win);
    return;
  }

  const doc = win.document;
  const root = doc.documentElement ?? doc.body;
  if (!root) {
    return;
  }

  let container = doc.getElementById(AUTOMATION_INDICATOR_ID) as HTMLDivElement | null;
  if (!container) {
    container = doc.createElement('div');
    container.id = AUTOMATION_INDICATOR_ID;
    root.appendChild(container);
  }

  const heading = state.status === 'executing' ? 'Automation executing' : 'Automation armed';
  const detail = state.status === 'executing'
    ? `Action in progress${state.action ? `: ${state.action}` : ''}.`
    : state.allowSensitiveFields
      ? 'Sensitive-field automation is enabled.'
      : 'Sensitive-field automation is still blocked.';

  container.setAttribute('style', [
    'position:fixed',
    'right:12px',
    'bottom:12px',
    'z-index:2147483647',
    'max-width:280px',
    'padding:12px',
    'border:2px solid #8f261d',
    'border-radius:12px',
    'background:#fff3f1',
    'color:#441611',
    'box-shadow:0 14px 28px rgba(40, 10, 8, 0.25)',
    'font:12px/1.4 "Segoe UI", sans-serif',
  ].join(';'));
  container.innerHTML = '';

  const title = doc.createElement('div');
  title.textContent = heading;
  title.setAttribute('style', 'font-weight:700; text-transform:uppercase; letter-spacing:0.04em; margin-bottom:4px;');

  const text = doc.createElement('div');
  text.textContent = detail;
  text.setAttribute('style', 'margin-bottom:8px;');

  const stopButton = doc.createElement('button');
  stopButton.type = 'button';
  stopButton.textContent = 'Emergency stop';
  stopButton.setAttribute('style', [
    'border:0',
    'border-radius:8px',
    'padding:8px 10px',
    'background:#8f261d',
    'color:#ffffff',
    'font:700 12px/1.2 "Segoe UI", sans-serif',
    'cursor:pointer',
  ].join(';'));
  stopButton.addEventListener('click', () => {
    runtime.sendMessage({ type: 'AUTOMATION_EMERGENCY_STOP' }, () => undefined);
  });

  container.append(title, text, stopButton);
}

export function applyAutomationIndicatorUpdate(
  win: Window,
  runtime: RuntimeMessenger,
  payload?: CaptureConfigUpdateRequest['payload'],
): void {
  renderAutomationIndicator(win, runtime, normalizeAutomationIndicatorState(payload));
}

interface ContentCaptureOptions {
  win?: Window;
  runtime?: RuntimeMessenger;
  captureEnabled?: boolean;
}

interface RuntimeMessenger {
  sendMessage(message: unknown, callback?: () => void): void;
}

interface FormFieldElement extends Element {
  value?: string;
  checked?: boolean;
  files?: FileList | null;
  multiple?: boolean;
  selectedOptions?: { length: number };
  type?: string;
  tagName: string;
}

function sendToBackground(
  runtime: RuntimeMessenger,
  eventType: string,
  data: Record<string, unknown>
): void {
  try {
    runtime.sendMessage(
      {
        type: 'SESSION_QUEUE_EVENT',
        eventType,
        data,
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  } catch {
    // Ignore runtime messaging failures when no receiver is active.
  }
}

function createTraceId(prefix = 'trace'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function clampMaxDepth(value: unknown, fallback = 3): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const depth = Math.floor(value);
  if (depth < 1) {
    return fallback;
  }

  return Math.min(depth, 10);
}

function clampMaxBytes(value: unknown, fallback = 50_000): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const bytes = Math.floor(value);
  if (bytes < 1_000) {
    return fallback;
  }

  return Math.min(bytes, 1_000_000);
}

function byteSize(value: string): number {
  return new TextEncoder().encode(value).length;
}

function serializeWithinLimit(value: unknown, maxBytes: number): { text: string; truncated: boolean } {
  const serialized = JSON.stringify(value);
  if (byteSize(serialized) <= maxBytes) {
    return { text: serialized, truncated: false };
  }

  const limited = serialized.slice(0, Math.max(maxBytes - 40, 20));
  return { text: `${limited}...[TRUNCATED]`, truncated: true };
}

function clampMaxAncestors(value: unknown, fallback = 4): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const normalized = Math.floor(value);
  if (normalized < 0) {
    return fallback;
  }

  return Math.min(normalized, 8);
}

function getEventTargetElement(event: Event): Element | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  const fromPath = path.find((entry) => entry instanceof Element);
  if (fromPath instanceof Element) {
    return fromPath;
  }

  if (event.target instanceof Element) {
    return event.target;
  }

  return null;
}

function isEditableTarget(target: Element | null): boolean {
  if (!target) {
    return false;
  }

  if (target instanceof HTMLTextAreaElement) {
    return true;
  }

  if (target instanceof HTMLInputElement) {
    const inputType = target.type.toLowerCase();
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color'].includes(inputType);
  }

  return target instanceof HTMLElement && target.isContentEditable;
}

function classifyKey(event: KeyboardEvent): string {
  if (event.key.length === 1) {
    return 'character';
  }
  if (event.key.startsWith('Arrow')) {
    return 'arrow';
  }
  if (event.key.startsWith('F') && /^F\d{1,2}$/.test(event.key)) {
    return 'function';
  }
  if (event.key === 'Enter') return 'enter';
  if (event.key === 'Escape') return 'escape';
  if (event.key === 'Tab') return 'tab';
  if (event.key === 'Backspace') return 'backspace';
  if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta') {
    return 'modifier';
  }
  return 'other';
}

function resolveFieldType(target: FormFieldElement): string {
  const tag = target.tagName.toLowerCase();
  if (tag === 'input') {
    return (target.type ?? 'text').toLowerCase();
  }
  return tag;
}

function resolveValueLength(target: FormFieldElement): number {
  const fieldType = resolveFieldType(target);
  if (fieldType === 'checkbox' || fieldType === 'radio') {
    return target.checked ? 1 : 0;
  }
  if (fieldType === 'file') {
    return target.files?.length ?? 0;
  }
  if (fieldType === 'select' && target.multiple) {
    return target.selectedOptions?.length ?? 0;
  }

  const value = typeof target.value === 'string' ? target.value : '';
  return value.length;
}

function captureComputedStyleChain(
  win: Window,
  target: Element,
  mode: SnapshotStyleMode,
  maxAncestors: number
): { mode: SnapshotStyleMode; chain: Array<Record<string, unknown>>; truncated: boolean } {
  const liteProperties = [
    'display',
    'position',
    'visibility',
    'opacity',
    'width',
    'height',
    'z-index',
    'overflow',
    'color',
    'background-color',
    'font-size',
    'font-weight',
    'line-height',
  ];

  const chain: Array<Record<string, unknown>> = [];
  let current: Element | null = target;
  let depth = 0;
  let truncated = false;

  while (current && depth <= maxAncestors) {
    const computed = win.getComputedStyle(current);
    const properties: Record<string, string> = {};

    if (mode === 'computed-full') {
      const maxProperties = 256;
      const propertyCount = Math.min(computed.length, maxProperties);
      truncated = truncated || computed.length > maxProperties;
      for (let index = 0; index < propertyCount; index += 1) {
        const property = computed.item(index);
        if (property) {
          properties[property] = computed.getPropertyValue(property);
        }
      }
    } else {
      for (const property of liteProperties) {
        properties[property] = computed.getPropertyValue(property);
      }
    }

    chain.push({
      depth,
      tagName: current.tagName.toLowerCase(),
      selector: getElementSelector(current),
      properties,
    });

    current = current.parentElement;
    depth += 1;
  }

  return {
    mode,
    chain,
    truncated,
  };
}

function buildDomOutline(root: Element, maxDepth: number, maxNodes = 400): Record<string, unknown> {
  let visited = 0;
  let truncatedByDepth = false;
  let truncatedByNodes = false;

  const visit = (element: Element, depth: number): Record<string, unknown> | null => {
    if (visited >= maxNodes) {
      truncatedByNodes = true;
      return null;
    }

    visited += 1;
    const classes = Array.from(element.classList).slice(0, 3);
    const node: Record<string, unknown> = {
      tag: element.tagName.toLowerCase(),
    };

    if (element.id) {
      node.id = element.id;
    }
    if (classes.length > 0) {
      node.class = classes.join(' ');
    }

    if (depth >= maxDepth) {
      truncatedByDepth ||= element.children.length > 0;
      return node;
    }

    const children: Record<string, unknown>[] = [];
    for (const child of Array.from(element.children)) {
      if (visited >= maxNodes) {
        truncatedByNodes = true;
        break;
      }
      const next = visit(child, depth + 1);
      if (next) {
        children.push(next);
      }
    }

    if (children.length > 0) {
      node.children = children;
    }

    return node;
  };

  const outlineRoot = visit(root, 0);

  return {
    truncated: truncatedByDepth || truncatedByNodes,
    nodeCount: visited,
    root: outlineRoot,
  };
}

export function executeCaptureCommand(
  win: Window,
  command: CaptureCommandType,
  payload: Record<string, unknown> = {}
): { result: Record<string, unknown>; truncated: boolean } {
  const maxDepth = clampMaxDepth(payload.maxDepth);
  const maxBytes = clampMaxBytes(payload.maxBytes);

  if (command === 'CAPTURE_DOM_SUBTREE') {
    const selector = typeof payload.selector === 'string' ? payload.selector : '';
    if (!selector) {
      throw new Error('selector is required');
    }

    const target = queryElementInRoot(win.document, selector);
    if (!target) {
      throw new Error(`No element found for selector: ${selector}`);
    }

    const html = target.outerHTML;
    if (byteSize(html) <= maxBytes) {
      return {
        truncated: false,
        result: {
          mode: 'html',
          selector,
          html,
          maxBytes,
        },
      };
    }

    const outline = buildDomOutline(target, maxDepth);
    const serialized = serializeWithinLimit(outline, maxBytes);
    return {
      truncated: true,
      result: {
        mode: 'outline',
        selector,
        fallbackReason: 'maxBytes',
        outline: serialized.text,
        maxDepth,
        maxBytes,
      },
    };
  }

  if (command === 'CAPTURE_DOM_DOCUMENT') {
    const mode = payload.mode === 'html' ? 'html' : 'outline';
    const root = win.document.documentElement;
    const html = root?.outerHTML ?? '';

    if (mode === 'html' && byteSize(html) <= maxBytes) {
      return {
        truncated: false,
        result: {
          mode,
          html,
          maxBytes,
        },
      };
    }

    const outline = root ? buildDomOutline(root, maxDepth) : { root: null, truncated: false, nodeCount: 0 };
    const serialized = serializeWithinLimit(outline, maxBytes);
    return {
      truncated: mode === 'html' || outline.truncated === true || serialized.truncated,
      result: {
        mode: 'outline',
        fallbackReason: mode === 'html' ? 'maxBytes' : undefined,
        outline: serialized.text,
        maxDepth,
        maxBytes,
      },
    };
  }

  if (command === 'CAPTURE_COMPUTED_STYLES') {
    const selector = typeof payload.selector === 'string' ? payload.selector : '';
    if (!selector) {
      throw new Error('selector is required');
    }

    const target = queryElementInRoot(win.document, selector);
    if (!target) {
      throw new Error(`No element found for selector: ${selector}`);
    }

    const style = win.getComputedStyle(target);
    const requestedProperties = Array.isArray(payload.properties)
      ? payload.properties.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      : [];

    const properties = requestedProperties.length > 0
      ? requestedProperties
      : [
          'display',
          'position',
          'visibility',
          'opacity',
          'width',
          'height',
          'z-index',
          'overflow',
        ];

    const values: Record<string, string> = {};
    for (const property of properties.slice(0, 64)) {
      values[property] = style.getPropertyValue(property);
    }

    return {
      truncated: false,
      result: {
        selector,
        properties: values,
      },
    };
  }

  if (command === 'CAPTURE_LAYOUT_METRICS') {
    const selector = typeof payload.selector === 'string' ? payload.selector : undefined;
    const target = selector ? queryElementInRoot(win.document, selector) : win.document.documentElement;

    if (!target) {
      throw new Error(`No element found for selector: ${selector}`);
    }

    const rect = target.getBoundingClientRect();
    return {
      truncated: false,
      result: {
        selector,
        viewport: {
          width: win.innerWidth,
          height: win.innerHeight,
          scrollX: win.scrollX,
          scrollY: win.scrollY,
        },
        element: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          left: rect.left,
        },
      },
    };
  }

  if (command === 'CAPTURE_MEDIA_STATE') {
    const selector = typeof payload.selector === 'string' && payload.selector.trim().length > 0
      ? payload.selector.trim()
      : undefined;
    const allCandidates = collectUniqueElements(selector ? [selector] : ['video', 'audio'], win.document)
      .filter((element): element is HTMLMediaElement => element instanceof HTMLMediaElement);
    const candidates = allCandidates.slice(0, 20);

    const readRanges = (ranges: TimeRanges): Array<{ start: number; end: number }> => {
      const result: Array<{ start: number; end: number }> = [];
      for (let index = 0; index < Math.min(ranges.length, 20); index += 1) {
        try {
          result.push({ start: ranges.start(index), end: ranges.end(index) });
        } catch {
          break;
        }
      }
      return result;
    };
    const finiteOrNull = (value: number): number | null => Number.isFinite(value) ? value : null;
    const sanitizeMediaSource = (value: string): string | null => {
      if (!value) {
        return null;
      }
      try {
        const url = new URL(value, win.location.href);
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString();
      } catch {
        return null;
      }
    };

    const media = candidates.map((element) => ({
      selector: getElementSelector(element),
      tagName: element.tagName.toLowerCase(),
      paused: element.paused,
      ended: element.ended,
      seeking: element.seeking,
      muted: element.muted,
      defaultMuted: element.defaultMuted,
      volume: element.volume,
      currentTime: finiteOrNull(element.currentTime),
      duration: finiteOrNull(element.duration),
      readyState: element.readyState,
      networkState: element.networkState,
      playbackRate: element.playbackRate,
      defaultPlaybackRate: element.defaultPlaybackRate,
      autoplay: element.autoplay,
      controls: element.controls,
      loop: element.loop,
      preload: element.preload,
      currentSrc: sanitizeMediaSource(element.currentSrc || element.src),
      buffered: readRanges(element.buffered),
      seekable: readRanges(element.seekable),
      error: element.error
        ? { code: element.error.code, message: element.error.message || undefined }
        : null,
    }));

    return {
      truncated: allCandidates.length > candidates.length,
      result: {
        selector,
        count: media.length,
        media,
      },
    };
  }

  if (command === 'CAPTURE_PAGE_STATE') {
    return capturePageState(win, payload);
  }

  if (command === 'CAPTURE_UI_SNAPSHOT') {
    const selector = typeof payload.selector === 'string' ? payload.selector : '';
    const trigger = typeof payload.trigger === 'string' ? payload.trigger : 'manual';
    const styleMode: SnapshotStyleMode =
      payload.styleMode === 'computed-full' && payload.explicitStyleMode === true
        ? 'computed-full'
        : 'computed-lite';
    const includeDom = payload.includeDom !== false;
    const includeStyles = payload.includeStyles !== false;
    const maxAncestors = clampMaxAncestors(payload.maxAncestors);

    const selectedElement = selector ? queryElementInRoot(win.document, selector) : null;
    const target = selectedElement ?? getDeepActiveElement(win.document)
      ?? win.document.body
      ?? win.document.documentElement;

    if (!target) {
      throw new Error('No capture target available for UI snapshot');
    }

    const domHtml = target.outerHTML;
    const resolvedSelector = selector || getElementSelector(target);
    let domSnapshot: Record<string, unknown> | undefined;
    let domTruncated = false;

    if (includeDom) {
      if (byteSize(domHtml) <= maxBytes) {
        domSnapshot = {
          mode: 'html',
          html: domHtml,
          maxBytes,
        };
      } else {
        const outline = buildDomOutline(target, maxDepth);
        const serialized = serializeWithinLimit(outline, maxBytes);
        domTruncated = true;
        domSnapshot = {
          mode: 'outline',
          outline: serialized.text,
          maxDepth,
          maxBytes,
          fallbackReason: 'maxBytes',
        };
      }
    }

    const styleSnapshot = includeStyles ? captureComputedStyleChain(win, target, styleMode, maxAncestors) : undefined;
    const stylesTruncated = includeStyles ? Boolean(styleSnapshot?.truncated) : false;

    return {
      truncated: (includeDom && domTruncated) || stylesTruncated,
      result: {
        timestamp: Date.now(),
        trigger,
        selector: resolvedSelector,
        url: win.location.href,
        mode: {
          dom: includeDom,
          png: false,
        },
        snapshot: {
          dom: domSnapshot,
          styles: styleSnapshot,
        },
        sensitivityHint: {
          selectorSensitive: isSensitiveSelector(resolvedSelector),
          containsSensitiveInputs: /<input\b[^>]*(type=("|')?(password|email|tel|number)\2)?[^>]*>/i.test(domHtml),
        },
        truncation: {
          dom: includeDom ? domTruncated : false,
          styles: stylesTruncated,
        },
      },
    };
  }

  if (command === 'EXECUTE_UI_ACTION') {
    const parsed = parseLiveUIActionRequest(payload);
    if (!parsed.success) {
      throw new Error(`Invalid live UI action payload: ${parsed.error}`);
    }

    const request = parsed.data;
    const startedAt = Date.now();
    const selector = request.target?.selector;
    const target = request.target?.elementRef
      ? resolveElementFromRef(win, request.target.elementRef)
      : selector
        ? queryElementInRoot(win.document, selector)
        : getDeepActiveElement(win.document)
          ?? win.document.body
          ?? win.document.documentElement;

    if ((request.target?.frameId ?? 0) !== 0) {
      return {
        truncated: false,
        result: buildRejectedLiveActionResult(
          request,
          target,
          startedAt,
          'unsupported_target_frame',
          'V1 live UI actions only support the top document; iframe targets are unsupported.',
        ),
      };
    }

    if (!target && request.action !== 'reload') {
      return {
        truncated: false,
        result: buildRejectedLiveActionResult(
          request,
          null,
          startedAt,
          'target_not_found',
          'No matching top-document element was found for this live UI action.',
        ),
      };
    }

    return {
      truncated: false,
      result: executeLiveUiAction(win, request, startedAt, target),
    };
  }

  if (command === 'SET_VIEWPORT') {
    throw new Error('SET_VIEWPORT must be handled by the extension background context');
  }

  throw new Error(`Unsupported capture command: ${command}`);
}

export function installContentCapture(options: ContentCaptureOptions = {}): () => void {
  const win = options.win ?? window;
  const runtime = options.runtime ?? chrome.runtime;
  const originalPushState = win.history.pushState.bind(win.history);
  const originalReplaceState = win.history.replaceState.bind(win.history);
  let captureEnabled = options.captureEnabled ?? true;
  let latestCaptureConfig: CaptureConfigUpdateRequest['payload'];
  let lastUrl = win.location.href;
  let lastScrollEmitAt = 0;
  let lastScrollX = win.scrollX;
  let lastScrollY = win.scrollY;
  let lastKeydownEmitAt = 0;

  const emitNavigation = (trigger: string): void => {
    if (!captureEnabled) {
      return;
    }
    const nextUrl = win.location.href;
    sendToBackground(runtime, 'navigation', {
      from: lastUrl,
      to: nextUrl,
      trigger,
      timestamp: Date.now(),
    });
    lastUrl = nextUrl;
  };

  const onPopState = (): void => emitNavigation('popstate');
  const onHashChange = (): void => emitNavigation('hashchange');

  const injectPageScript = (): void => {
    if (!runtime || typeof chrome === 'undefined' || !chrome.runtime?.getURL) {
      return;
    }

    try {
      const root = win.document.documentElement;
      if (!root) {
        return;
      }

      if (root.dataset.bdmcpInjected === '1') {
        return;
      }

      if (win.document.getElementById('__bdmcp_injected_script__')) {
        root.dataset.bdmcpInjected = '1';
        return;
      }

      root.dataset.bdmcpInjected = '1';
      const script = win.document.createElement('script');
      script.id = '__bdmcp_injected_script__';
      script.src = chrome.runtime.getURL('injected-script.js');
      script.async = false;
      script.dataset.mcpBridge = 'injected';
      script.onload = () => {
        script.remove();
      };
      script.onerror = () => {
        script.remove();
      };
      (win.document.documentElement || win.document.head || win.document.body)?.appendChild(script);
    } catch {
      // Ignore injection failures on restricted pages.
    }
  };
  const onMessage = (event: MessageEvent<unknown>): void => {
    if (event.source && event.source !== win) {
      return;
    }

    const payload = event.data as Partial<BridgePayload> | null;
    if (!payload || payload.source !== BRIDGE_SOURCE || payload.kind !== BRIDGE_KIND) {
      return;
    }

    if (!payload.eventType || !payload.data) {
      return;
    }

    if (payload.eventType === 'custom' && payload.data.marker === 'injected_script_loaded') {
      postNetworkCaptureConfigToInjectedScript(latestCaptureConfig);
    }

    if (!captureEnabled) {
      return;
    }

    sendToBackground(runtime, payload.eventType, payload.data);
  };
  const postNetworkCaptureConfigToInjectedScript = (payload: CaptureConfigUpdateRequest['payload']): void => {
    const network = payload?.network;
    const captureBodies = network?.captureBodies === true;
    const rawMaxBodyBytes = network?.maxBodyBytes;
    const maxBodyBytes =
      typeof rawMaxBodyBytes === 'number' && Number.isFinite(rawMaxBodyBytes)
        ? Math.max(4096, Math.min(5 * 1024 * 1024, Math.floor(rawMaxBodyBytes)))
        : 262144;

    const controlPayload: BridgeControlPayload = {
      source: BRIDGE_SOURCE,
      kind: BRIDGE_CONTROL_KIND,
      controlType: 'network_config',
      data: {
        captureEnabled,
        captureBodies,
        maxBodyBytes,
      },
    };

    win.postMessage(controlPayload, '*');
  };
  const postTraceHintToInjectedScript = (traceId: string, eventType: string, selector?: string): void => {
    const controlPayload: BridgeControlPayload = {
      source: BRIDGE_SOURCE,
      kind: BRIDGE_CONTROL_KIND,
      controlType: 'trace_hint',
      data: {
        traceId,
        eventType,
        selector,
        timestamp: Date.now(),
      },
    };

    win.postMessage(controlPayload, '*');
  };
  const emitUiEventWithTrace = (eventType: string, data: Record<string, unknown>): void => {
    if (!captureEnabled) {
      return;
    }
    const traceId = createTraceId('ui');
    const selector = typeof data.selector === 'string' ? data.selector : undefined;
    sendToBackground(runtime, eventType, {
      ...data,
      traceId,
    });
    postTraceHintToInjectedScript(traceId, eventType, selector);
  };
  const onClick = (event: MouseEvent): void => {
    if (!captureEnabled) {
      return;
    }
    const target = getClickableTarget(event);
    if (!target) {
      return;
    }

    const selector = getClickSelector(target);
    if (!selector) {
      return;
    }

    emitUiEventWithTrace('click', {
      eventType: 'click',
      selector,
      timestamp: Date.now(),
    });
  };

  const onScroll = (event: Event): void => {
    if (!captureEnabled) {
      return;
    }
    const now = Date.now();
    if (now - lastScrollEmitAt < 350) {
      return;
    }

    const scrollX = win.scrollX;
    const scrollY = win.scrollY;
    const deltaX = scrollX - lastScrollX;
    const deltaY = scrollY - lastScrollY;
    if (Math.abs(deltaX) < 4 && Math.abs(deltaY) < 4) {
      return;
    }

    const target = getEventTargetElement(event);
    emitUiEventWithTrace('scroll', {
      eventType: 'scroll',
      selector: target ? getElementSelector(target) : 'window',
      scrollX,
      scrollY,
      deltaX,
      deltaY,
      timestamp: now,
    });

    lastScrollEmitAt = now;
    lastScrollX = scrollX;
    lastScrollY = scrollY;
  };

  const emitFormEvent = (eventType: 'input' | 'change', event: Event): void => {
    if (!captureEnabled) {
      return;
    }
    const target = getEventTargetElement(event);
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) {
      return;
    }

    const field = target as FormFieldElement;
    const payload: Record<string, unknown> = {
      eventType,
      selector: getElementSelector(target),
      fieldType: resolveFieldType(field),
      valueLength: resolveValueLength(field),
      editable: isEditableTarget(target),
      timestamp: Date.now(),
    };

    if (eventType === 'input' && event instanceof InputEvent && typeof event.inputType === 'string') {
      payload.inputType = event.inputType;
    }

    emitUiEventWithTrace(eventType, payload);
  };

  const onInputCapture = (event: Event): void => emitFormEvent('input', event);
  const onChangeCapture = (event: Event): void => emitFormEvent('change', event);

  const onSubmit = (event: SubmitEvent): void => {
    if (!captureEnabled) {
      return;
    }
    const target = event.target;
    if (!(target instanceof HTMLFormElement)) {
      return;
    }

    emitUiEventWithTrace('submit', {
      eventType: 'submit',
      selector: getElementSelector(target),
      method: (target.method || 'get').toLowerCase(),
      action: target.action || win.location.href,
      timestamp: Date.now(),
    });
  };

  const emitFocusEvent = (eventType: 'focus' | 'blur', event: FocusEvent): void => {
    if (!captureEnabled) {
      return;
    }
    const target = getEventTargetElement(event);
    if (!target) {
      return;
    }

    const payload: Record<string, unknown> = {
      eventType,
      selector: getElementSelector(target),
      tagName: target.tagName.toLowerCase(),
      editable: isEditableTarget(target),
      timestamp: Date.now(),
    };

    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
      payload.fieldType = resolveFieldType(target as FormFieldElement);
    }

    emitUiEventWithTrace(eventType, payload);
  };

  const onFocusInCapture = (event: FocusEvent): void => emitFocusEvent('focus', event);
  const onFocusOutCapture = (event: FocusEvent): void => emitFocusEvent('blur', event);

  const onKeydown = (event: KeyboardEvent): void => {
    if (!captureEnabled) {
      return;
    }
    const now = Date.now();
    if (now - lastKeydownEmitAt < 120) {
      return;
    }

    const target = getEventTargetElement(event);
    const keyClass = classifyKey(event);
    const payload: Record<string, unknown> = {
      eventType: 'keydown',
      selector: target ? getElementSelector(target) : 'window',
      keyClass,
      inEditable: isEditableTarget(target),
      modifiers: {
        alt: event.altKey,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        shift: event.shiftKey,
      },
      repeat: event.repeat,
      timestamp: now,
    };

    if (keyClass !== 'character') {
      payload.key = event.key;
      payload.code = event.code;
    }

    emitUiEventWithTrace('keydown', payload);
    lastKeydownEmitAt = now;
  };

  const onRuntimeCommand = (
    request: CaptureCommandRequest | CapturePingRequest | CaptureConfigUpdateRequest,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: CaptureCommandResponse | { ok: true; type: 'CAPTURE_PONG' } | { ok: true; updated: true }) => void
  ): boolean | void => {
    if (request && request.type === 'CAPTURE_PING') {
      sendResponse({ ok: true, type: 'CAPTURE_PONG' });
      return;
    }

    if (request && request.type === 'CAPTURE_CONFIG_UPDATE') {
      latestCaptureConfig = request.payload;
      captureEnabled = request.payload?.captureEnabled === true;
      postNetworkCaptureConfigToInjectedScript(request.payload);
      applyAutomationIndicatorUpdate(win, runtime, request.payload);
      sendResponse({ ok: true, updated: true });
      return true;
    }

    if (!request || request.type !== 'CAPTURE_EXECUTE') {
      return;
    }

    try {
      const output = executeCaptureCommand(win, request.command, request.payload ?? {});
      sendResponse({
        ok: true,
        result: output.result,
        truncated: output.truncated,
      });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : 'Capture command failed',
      });
    }

    return true;
  };

  win.history.pushState = function pushState(...args: Parameters<History['pushState']>): void {
    originalPushState(...args);
    emitNavigation('pushState');
  };

  win.history.replaceState = function replaceState(...args: Parameters<History['replaceState']>): void {
    originalReplaceState(...args);
    emitNavigation('replaceState');
  };

  win.addEventListener('popstate', onPopState);
  win.addEventListener('hashchange', onHashChange);
  win.addEventListener('message', onMessage);
  win.addEventListener('click', onClick, true);
  win.addEventListener('scroll', onScroll, { capture: true, passive: true });
  win.addEventListener('input', onInputCapture, true);
  win.addEventListener('change', onChangeCapture, true);
  win.addEventListener('submit', onSubmit, true);
  win.addEventListener('focusin', onFocusInCapture, true);
  win.addEventListener('focusout', onFocusOutCapture, true);
  win.addEventListener('keydown', onKeydown, true);
  injectPageScript();
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener(onRuntimeCommand);
  }

  if (captureEnabled) {
    sendToBackground(runtime, 'navigation', {
      from: null,
      to: win.location.href,
      trigger: 'init',
      timestamp: Date.now(),
    });

    sendToBackground(runtime, 'custom', {
      marker: 'content_script_loaded',
      url: win.location.href,
      timestamp: Date.now(),
    });
  }

  return () => {
    win.history.pushState = originalPushState;
    win.history.replaceState = originalReplaceState;
    win.removeEventListener('popstate', onPopState);
    win.removeEventListener('hashchange', onHashChange);
    win.removeEventListener('message', onMessage);
    win.removeEventListener('click', onClick, true);
    win.removeEventListener('scroll', onScroll, true);
    win.removeEventListener('input', onInputCapture, true);
    win.removeEventListener('change', onChangeCapture, true);
    win.removeEventListener('submit', onSubmit, true);
    win.removeEventListener('focusin', onFocusInCapture, true);
    win.removeEventListener('focusout', onFocusOutCapture, true);
    win.removeEventListener('keydown', onKeydown, true);
    removeAutomationIndicator(win);
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.removeListener(onRuntimeCommand);
    }
  };
}

if (typeof window !== 'undefined' && typeof chrome !== 'undefined' && !!chrome.runtime) {
  const guard = window as Window & { __BDMCP_CONTENT_CAPTURE_INSTALLED__?: boolean };
  if (!guard.__BDMCP_CONTENT_CAPTURE_INSTALLED__) {
    guard.__BDMCP_CONTENT_CAPTURE_INSTALLED__ = true;
    installContentCapture({ captureEnabled: false });
  }
  console.log('[BrowserDebug][ContentScript] Loaded');
}
