export interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

export interface RedactionResult {
  redacted: boolean;
  value: string;
  rulesApplied: string[];
}

export interface RedactionSummary {
  totalFields: number;
  redactedFields: number;
  rulesApplied: string[];
}

export const DEFAULT_REDACTION_RULES: RedactionRule[] = [
  {
    name: 'authorization-header',
    pattern: /(Authorization:\s*Bearer\s+)[\w\-\.=]+/gi,
    replacement: '$1[REDACTED]',
  },
  {
    name: 'jwt-token',
    pattern: /eyJ[\w-]*\.eyJ[\w-]*\.[\w-]*/g,
    replacement: '[JWT_TOKEN]',
  },
  {
    name: 'api-key',
    pattern: /((?:api[_-]?key|apikey)\s*[:=]\s*)[\w-]+/gi,
    replacement: '$1[API_KEY]',
  },
  {
    name: 'password',
    pattern: /((?:password|pwd)\s*[:=]\s*)\S+/gi,
    replacement: '$1[PASSWORD]',
  },
  {
    name: 'credit-card',
    pattern: /\b(?:\d[ -]*?){13,16}\b/g,
    replacement: '[CREDIT_CARD]',
  },
  {
    name: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    replacement: '[EMAIL]',
  },
];
