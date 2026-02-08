import { describe, it, expect } from 'vitest';
import { generateId, formatTimestamp, safeJsonParse, safeJsonStringify, truncateString, isValidUrl } from './utilities';

describe('utilities', () => {
  describe('generateId', () => {
    it('should generate unique IDs', () => {
      const id1 = generateId();
      const id2 = generateId();
      expect(id1).not.toBe(id2);
      expect(id1).toContain('-');
      expect(id1.length).toBeGreaterThan(10);
    });
  });

  describe('formatTimestamp', () => {
    it('should format date to ISO string', () => {
      const date = new Date('2024-01-15T10:30:00.000Z');
      expect(formatTimestamp(date)).toBe('2024-01-15T10:30:00.000Z');
    });
  });

  describe('safeJsonParse', () => {
    it('should parse valid JSON', () => {
      expect(safeJsonParse('{"key":"value"}', {})).toEqual({ key: 'value' });
    });

    it('should return fallback for invalid JSON', () => {
      expect(safeJsonParse('invalid', { fallback: true })).toEqual({ fallback: true });
    });
  });

  describe('safeJsonStringify', () => {
    it('should stringify valid objects', () => {
      expect(safeJsonStringify({ key: 'value' })).toBe('{"key":"value"}');
    });

    it('should return empty object for circular references', () => {
      const obj: Record<string, unknown> = {};
      obj.self = obj;
      expect(safeJsonStringify(obj)).toBe('{}');
    });
  });

  describe('truncateString', () => {
    it('should return original string if under max length', () => {
      expect(truncateString('hello', 10)).toBe('hello');
    });

    it('should truncate string and add ellipsis if over max length', () => {
      expect(truncateString('hello world', 5)).toBe('hello...');
    });
  });

  describe('isValidUrl', () => {
    it('should return true for valid URLs', () => {
      expect(isValidUrl('https://example.com')).toBe(true);
      expect(isValidUrl('http://localhost:3000')).toBe(true);
    });

    it('should return false for invalid URLs', () => {
      expect(isValidUrl('not-a-url')).toBe(false);
      expect(isValidUrl('')).toBe(false);
    });
  });
});
