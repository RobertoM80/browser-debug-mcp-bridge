import { RedactionEngine } from './redaction-engine';

export type SnapshotPrivacyProfile = 'strict' | 'standard';

export interface SnapshotRedactionMetadata {
  applied: boolean;
  profile: SnapshotPrivacyProfile;
  maskedFields: number;
  blockedPng: boolean;
  reasons: string[];
}

const SNAPSHOT_REDACTION = '[REDACTED_SNAPSHOT]';
const SENSITIVE_SELECTOR_PATTERN = /(password|passwd|pwd|token|secret|auth|session|email|card|cvv|cvc|ssn|iban|payment)/i;
const SENSITIVE_ATTRIBUTE_PATTERN = /\s((?:data-(?:token|auth|email|secret|password)|token|auth|authorization|password|value))(=)(["']).*?\3/gi;

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSensitiveSelector(selector: unknown): boolean {
  return typeof selector === 'string' && SENSITIVE_SELECTOR_PATTERN.test(selector);
}

function redactHtmlFragment(engine: RedactionEngine, html: string): { value: string; changed: boolean } {
  let changed = false;
  let next = html;

  const withInputValuesMasked = next.replace(/(<input\b[^>]*\bvalue=)(["']).*?\2/gi, (_m, prefix, quote) => {
    changed = true;
    return `${prefix}${quote}${SNAPSHOT_REDACTION}${quote}`;
  });
  next = withInputValuesMasked;

  const withTextareasMasked = next.replace(/(<textarea\b[^>]*>)([\s\S]*?)(<\/textarea>)/gi, (_m, start, body, end) => {
    if (body.length === 0) {
      return `${start}${body}${end}`;
    }
    changed = true;
    return `${start}${SNAPSHOT_REDACTION}${end}`;
  });
  next = withTextareasMasked;

  const withSensitiveAttributesMasked = next.replace(SENSITIVE_ATTRIBUTE_PATTERN, (_m, attribute, equals, quote) => {
    changed = true;
    return ` ${attribute}${equals}${quote}${SNAPSHOT_REDACTION}${quote}`;
  });
  next = withSensitiveAttributesMasked;

  const result = engine.redact(next);
  if (result.redacted) {
    changed = true;
  }

  return {
    value: result.value,
    changed,
  };
}

export function redactSnapshotRecord(
  snapshot: Record<string, unknown>,
  options: { safeMode: boolean; profile: SnapshotPrivacyProfile }
): { record: Record<string, unknown>; metadata: SnapshotRedactionMetadata } {
  const record = structuredClone(snapshot);
  const engine = new RedactionEngine();
  const reasons = new Set<string>();
  let maskedFields = 0;
  let blockedPng = false;

  const selectorSensitiveHint =
    (record as { sensitivityHint?: { selectorSensitive?: unknown } }).sensitivityHint?.selectorSensitive === true;
  const selectorSensitive = isSensitiveSelector(record.selector) || selectorSensitiveHint;

  const snapshotRoot = isObjectLike(record.snapshot) ? record.snapshot : null;
  if (snapshotRoot) {
    const dom = isObjectLike(snapshotRoot.dom) ? snapshotRoot.dom : null;
    if (dom && typeof dom.html === 'string') {
      const redacted = redactHtmlFragment(engine, dom.html);
      if (redacted.changed || selectorSensitive) {
        dom.html = selectorSensitive ? SNAPSHOT_REDACTION : redacted.value;
        maskedFields += 1;
        reasons.add(selectorSensitive ? 'selector_based_dom_masking' : 'attribute_based_dom_masking');
      }
    }

    const styles = isObjectLike(snapshotRoot.styles) ? snapshotRoot.styles : null;
    if (styles && Array.isArray(styles.chain)) {
      for (const node of styles.chain) {
        if (!isObjectLike(node)) {
          continue;
        }

        const nodeSensitive = selectorSensitive || isSensitiveSelector(node.selector);
        const properties = isObjectLike(node.properties) ? node.properties : null;
        if (!properties) {
          continue;
        }

        for (const [property, current] of Object.entries(properties)) {
          if (typeof current !== 'string') {
            continue;
          }

          if (nodeSensitive) {
            properties[property] = SNAPSHOT_REDACTION;
            maskedFields += 1;
            reasons.add('selector_based_style_masking');
            continue;
          }

          const redacted = engine.redact(current);
          if (redacted.redacted) {
            properties[property] = redacted.value;
            maskedFields += 1;
            reasons.add('style_value_redaction');
          }
        }
      }
    }
  }

  const png = isObjectLike(record.png) ? record.png : null;
  if (png && png.captured === true && options.safeMode && options.profile === 'strict') {
    png.captured = false;
    png.reason = 'blocked_by_privacy_profile';
    png.profile = 'strict';
    delete png.dataUrl;
    blockedPng = true;
    maskedFields += 1;
    reasons.add('strict_safe_mode_png_blocked');

    const truncation = isObjectLike(record.truncation) ? record.truncation : null;
    if (truncation) {
      truncation.png = true;
    }
  }

  const metadata: SnapshotRedactionMetadata = {
    applied: maskedFields > 0,
    profile: options.profile,
    maskedFields,
    blockedPng,
    reasons: Array.from(reasons),
  };

  record.redaction = metadata;
  return { record, metadata };
}
