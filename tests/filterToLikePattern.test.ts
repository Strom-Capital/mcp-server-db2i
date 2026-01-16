/**
 * Tests for filterToLikePattern function
 */

import { describe, it, expect } from 'vitest';
import { filterToLikePattern } from '../src/db/queries.js';

describe('filterToLikePattern', () => {
  describe('undefined/empty input', () => {
    it('should return % for undefined filter', () => {
      expect(filterToLikePattern(undefined)).toBe('%');
    });

    it('should return % for empty string', () => {
      expect(filterToLikePattern('')).toBe('%');
    });
  });

  describe('contains search (default)', () => {
    it('should wrap term with % for contains search', () => {
      expect(filterToLikePattern('CUST')).toBe('%CUST%');
    });

    it('should uppercase the term', () => {
      expect(filterToLikePattern('customer')).toBe('%CUSTOMER%');
    });

    it('should handle mixed case', () => {
      expect(filterToLikePattern('CuStOmEr')).toBe('%CUSTOMER%');
    });
  });

  describe('wildcard patterns with *', () => {
    it('should convert trailing * to starts-with pattern', () => {
      expect(filterToLikePattern('CUST*')).toBe('CUST%');
    });

    it('should convert leading * to ends-with pattern', () => {
      expect(filterToLikePattern('*LOG')).toBe('%LOG');
    });

    it('should convert middle * to pattern', () => {
      expect(filterToLikePattern('ORD*FILE')).toBe('ORD%FILE');
    });

    it('should convert multiple * wildcards', () => {
      expect(filterToLikePattern('*ORD*FILE*')).toBe('%ORD%FILE%');
    });

    it('should uppercase with wildcards', () => {
      expect(filterToLikePattern('cust*')).toBe('CUST%');
    });
  });

  describe('pre-existing % patterns', () => {
    it('should pass through existing % pattern as-is', () => {
      expect(filterToLikePattern('%CUST%')).toBe('%CUST%');
    });

    it('should uppercase existing % pattern', () => {
      expect(filterToLikePattern('%cust%')).toBe('%CUST%');
    });

    it('should handle complex existing patterns', () => {
      expect(filterToLikePattern('PROD%_%TEST')).toBe('PROD%_%TEST');
    });
  });

  describe('edge cases', () => {
    it('should handle single character', () => {
      expect(filterToLikePattern('A')).toBe('%A%');
    });

    it('should handle numbers', () => {
      expect(filterToLikePattern('123')).toBe('%123%');
    });

    it('should handle mixed alphanumeric', () => {
      expect(filterToLikePattern('LIB001')).toBe('%LIB001%');
    });

    it('should handle underscores (SQL single char wildcard)', () => {
      expect(filterToLikePattern('TEST_TABLE')).toBe('%TEST_TABLE%');
    });
  });
});
