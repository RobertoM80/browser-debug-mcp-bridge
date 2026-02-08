import { RedactionRule, RedactionResult, RedactionSummary, DEFAULT_REDACTION_RULES } from './patterns';

export class RedactionEngine {
  private rules: RedactionRule[];

  constructor(rules: RedactionRule[] = DEFAULT_REDACTION_RULES) {
    this.rules = rules;
  }

  addRule(rule: RedactionRule): void {
    this.rules.push(rule);
  }

  setRules(rules: RedactionRule[]): void {
    this.rules = rules;
  }

  redact(value: string): RedactionResult {
    let redactedValue = value;
    const rulesApplied: string[] = [];

    for (const rule of this.rules) {
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
      if (pattern.test(redactedValue)) {
        redactedValue = redactedValue.replace(pattern, rule.replacement);
        rulesApplied.push(rule.name);
      }
    }

    return {
      redacted: rulesApplied.length > 0,
      value: redactedValue,
      rulesApplied,
    };
  }

  redactObject<T extends Record<string, unknown>>(obj: T): { result: T; summary: RedactionSummary } {
    const rulesApplied = new Set<string>();
    let redactedFields = 0;
    let totalFields = 0;

    const redactValue = (value: unknown, key: string): unknown => {
      totalFields++;
      
      if (typeof value === 'string') {
        const redactionResult = this.redact(value);
        if (redactionResult.redacted) {
          redactedFields++;
          redactionResult.rulesApplied.forEach(rule => rulesApplied.add(rule));
        }
        return redactionResult.value;
      }
      
      if (Array.isArray(value)) {
        return value.map((item, index) => redactValue(item, `${key}[${index}]`));
      }
      
      if (value && typeof value === 'object') {
        const redacted: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
          redacted[k] = redactValue(v, k);
        }
        return redacted;
      }
      
      return value;
    };

    const result = redactValue(obj, 'root') as T;

    return {
      result,
      summary: {
        totalFields,
        redactedFields,
        rulesApplied: Array.from(rulesApplied),
      },
    };
  }

  createSummary(rulesApplied: string[]): RedactionSummary {
    return {
      totalFields: 0,
      redactedFields: 0,
      rulesApplied: [...new Set(rulesApplied)],
    };
  }
}

export function redact(value: string, rules?: RedactionRule[]): RedactionResult {
  const engine = new RedactionEngine(rules);
  return engine.redact(value);
}

export function redactObject<T extends Record<string, unknown>>(obj: T, rules?: RedactionRule[]): { result: T; summary: RedactionSummary } {
  const engine = new RedactionEngine(rules);
  return engine.redactObject(obj);
}
