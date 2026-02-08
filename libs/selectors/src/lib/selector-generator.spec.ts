import { describe, it, expect, beforeEach } from 'vitest';
import { SelectorGenerator, generateSelector, generateSelectorWithFallback } from './selector-generator';

describe('selector-generator', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('SelectorGenerator', () => {
    it('should generate id selector when element has id', () => {
      document.body.innerHTML = '<div id="test-element">Test</div>';
      const element = document.getElementById('test-element')!;
      const generator = new SelectorGenerator();
      const result = generator.generate(element);
      expect(result).not.toBeNull();
      expect(result!.selector).toBe('#test-element');
      expect(result!.strategy).toBe('id');
      expect(result!.confidence).toBe(1.0);
    });

    it('should generate data attribute selector', () => {
      document.body.innerHTML = '<div data-testid="unique-button">Test</div>';
      const element = document.querySelector('[data-testid="unique-button"]')!;
      const generator = new SelectorGenerator();
      const result = generator.generate(element);
      expect(result).not.toBeNull();
      expect(result!.selector).toBe('[data-testid="unique-button"]');
      expect(result!.strategy).toBe('data-attribute');
    });

    it('should generate class selector', () => {
      document.body.innerHTML = '<div class="unique-class">Test</div>';
      const element = document.querySelector('.unique-class')!;
      const generator = new SelectorGenerator();
      const result = generator.generate(element);
      expect(result).not.toBeNull();
      expect(result!.strategy).toBe('class');
    });

    it('should fallback to tag selector', () => {
      document.body.innerHTML = '<span>Test</span>';
      const element = document.querySelector('span')!;
      const generator = new SelectorGenerator();
      const result = generator.generate(element);
      expect(result).not.toBeNull();
      expect(result!.strategy).toBe('tag');
    });
  });

  describe('generateSelector helper', () => {
    it('should use default strategies', () => {
      document.body.innerHTML = '<div id="helper-test">Test</div>';
      const element = document.getElementById('helper-test')!;
      const result = generateSelector(element);
      expect(result).not.toBeNull();
      expect(result!.selector).toBe('#helper-test');
    });
  });

  describe('generateSelectorWithFallback', () => {
    it('should generate path with fallback', () => {
      document.body.innerHTML = `
        <div id="parent">
          <div class="child">
            <span>Target</span>
          </div>
        </div>
      `;
      const element = document.querySelector('span')!;
      const result = generateSelectorWithFallback(element, 3);
      expect(result).not.toBeNull();
      expect(result).toContain('span');
    });
  });
});
