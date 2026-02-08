import { SelectorStrategy, SelectorResult, DEFAULT_STRATEGIES } from './strategies';

export class SelectorGenerator {
  private strategies: SelectorStrategy[];

  constructor(strategies: SelectorStrategy[] = DEFAULT_STRATEGIES) {
    this.strategies = strategies;
  }

  setStrategies(strategies: SelectorStrategy[]): void {
    this.strategies = strategies;
  }

  addStrategy(strategy: SelectorStrategy): void {
    this.strategies.push(strategy);
  }

  generate(element: Element): SelectorResult | null {
    for (const strategy of this.strategies) {
      const selector = strategy.generate(element);
      if (selector) {
        const confidence = this.calculateConfidence(strategy.name, element);
        return {
          selector,
          strategy: strategy.name,
          confidence,
        };
      }
    }
    return null;
  }

  generateWithFallback(element: Element, maxDepth: number = 3): string | null {
    const result = this.generate(element);
    if (result && result.confidence > 0.8) {
      return result.selector;
    }

    let current: Element | null = element;
    const path: string[] = [];

    while (current && path.length < maxDepth) {
      const segment = this.getSegment(current);
      if (segment) {
        path.unshift(segment);
        const fullSelector = path.join(' > ');
        try {
          if (document.querySelectorAll(fullSelector).length === 1) {
            return fullSelector;
          }
        } catch {
          continue;
        }
      }
      current = current.parentElement;
    }

    return path.length > 0 ? path.join(' > ') : null;
  }

  private getSegment(element: Element): string | null {
    if (element.id && !element.id.match(/^\d/)) {
      return `#${CSS.escape(element.id)}`;
    }

    const tagName = element.tagName.toLowerCase();
    const dataAttrs = Array.from(element.attributes)
      .filter(attr => attr.name.startsWith('data-testid') || attr.name.startsWith('data-id'));
    
    if (dataAttrs.length > 0) {
      const attr = dataAttrs[0];
      return `${tagName}[${CSS.escape(attr.name)}="${CSS.escape(attr.value)}"]`;
    }

    const classes = Array.from(element.classList)
      .filter(c => !c.match(/^[0-9]/) && !c.match(/^(css-|styled|sc-)/));
    
    if (classes.length > 0) {
      return `${tagName}.${CSS.escape(classes[0])}`;
    }

    const parent = element.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        child => child.tagName === element.tagName
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(element) + 1;
        return `${tagName}:nth-of-type(${index})`;
      }
    }

    return tagName;
  }

  private calculateConfidence(strategyName: string, _element: Element): number {
    switch (strategyName) {
      case 'id':
        return 1.0;
      case 'data-attribute':
        return 0.9;
      case 'class':
        return 0.7;
      case 'tag':
        return 0.4;
      default:
        return 0.5;
    }
  }
}

export function generateSelector(element: Element): SelectorResult | null {
  const generator = new SelectorGenerator();
  return generator.generate(element);
}

export function generateSelectorWithFallback(element: Element, maxDepth?: number): string | null {
  const generator = new SelectorGenerator();
  return generator.generateWithFallback(element, maxDepth);
}
