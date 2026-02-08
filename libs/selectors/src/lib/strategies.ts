function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && CSS.escape) {
    return CSS.escape(value);
  }
  
  return value
    .replace(/([\x00-\x1f\x7f])/g, '\$1')
    .replace(/([!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~])/g, '\\$1')
    .replace(/^(\d)/, '\\3$1 ')
    .replace(/^(-\d)/, '\\$1');
}

export interface SelectorStrategy {
  name: string;
  generate(element: Element): string | null;
}

export interface SelectorResult {
  selector: string;
  strategy: string;
  confidence: number;
}

export const ID_STRATEGY: SelectorStrategy = {
  name: 'id',
  generate(element: Element): string | null {
    if (element.id && !element.id.match(/^\d/)) {
      return `#${cssEscape(element.id)}`;
    }
    return null;
  },
};

export const DATA_ATTRIBUTE_STRATEGY: SelectorStrategy = {
  name: 'data-attribute',
  generate(element: Element): string | null {
    const dataAttrs = Array.from(element.attributes)
      .filter(attr => attr.name.startsWith('data-'))
      .sort((a, b) => a.name.localeCompare(b.name));
    
    for (const attr of dataAttrs) {
      const selector = `[${cssEscape(attr.name)}="${cssEscape(attr.value)}"]`;
      if (document.querySelectorAll(selector).length === 1) {
        return selector;
      }
    }
    return null;
  },
};

export const CLASS_STRATEGY: SelectorStrategy = {
  name: 'class',
  generate(element: Element): string | null {
    const classes = Array.from(element.classList)
      .filter(c => !c.match(/^[0-9]/) && !c.match(/^(css-|styled|sc-)/));
    
    if (classes.length > 0) {
      const selector = `.${classes.map(c => cssEscape(c)).join('.')}`;
      const matches = document.querySelectorAll(selector);
      if (matches.length === 1) {
        return selector;
      }
      if (matches.length <= 3 && classes.length > 1) {
        return `.${cssEscape(classes[0])}`;
      }
    }
    return null;
  },
};

export const TAG_STRATEGY: SelectorStrategy = {
  name: 'tag',
  generate(element: Element): string | null {
    const tagName = element.tagName.toLowerCase();
    const parent = element.parentElement;
    
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        child => child.tagName.toLowerCase() === tagName
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(element) + 1;
        return `${tagName}:nth-of-type(${index})`;
      }
    }
    
    return tagName;
  },
};

export const DEFAULT_STRATEGIES: SelectorStrategy[] = [
  ID_STRATEGY,
  DATA_ATTRIBUTE_STRATEGY,
  CLASS_STRATEGY,
  TAG_STRATEGY,
];
