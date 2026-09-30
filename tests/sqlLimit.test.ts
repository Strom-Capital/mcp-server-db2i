/**
 * Tests for SQL row-limit application
 */

import { describe, it, expect } from 'vitest';
import { applySqlRowLimit, rowLimitWarning, takeRowsWithinLimit } from '../src/tools/sqlLimit.js';

describe('applySqlRowLimit', () => {
  it('appends FETCH FIRST when no trailing limit exists', () => {
    expect(applySqlRowLimit('SELECT * FROM MYLIB.USERS', 50)).toBe(
      'SELECT * FROM MYLIB.USERS FETCH FIRST 50 ROWS ONLY'
    );
  });

  it('strips a trailing semicolon before appending', () => {
    expect(applySqlRowLimit('SELECT * FROM MYLIB.USERS;', 25)).toBe(
      'SELECT * FROM MYLIB.USERS FETCH FIRST 25 ROWS ONLY'
    );
  });

  it('still applies a cap when a column name contains LIMIT', () => {
    expect(applySqlRowLimit('SELECT CREDIT_LIMIT FROM MYLIB.ACCOUNTS', 100)).toBe(
      'SELECT CREDIT_LIMIT FROM MYLIB.ACCOUNTS FETCH FIRST 100 ROWS ONLY'
    );
  });

  it('still applies a cap when a string literal contains LIMIT', () => {
    const sql = "SELECT * FROM MYLIB.USERS WHERE NOTE = 'HAS LIMIT CLAUSE'";
    expect(applySqlRowLimit(sql, 10)).toBe(
      "SELECT * FROM MYLIB.USERS WHERE NOTE = 'HAS LIMIT CLAUSE' FETCH FIRST 10 ROWS ONLY"
    );
  });

  it('clamps an oversized trailing FETCH FIRST', () => {
    expect(
      applySqlRowLimit('SELECT * FROM MYLIB.USERS FETCH FIRST 10000000 ROWS ONLY', 1000)
    ).toBe('SELECT * FROM MYLIB.USERS FETCH FIRST 1000 ROWS ONLY');
  });

  it('clamps an oversized trailing LIMIT', () => {
    expect(applySqlRowLimit('SELECT * FROM MYLIB.USERS LIMIT 999999', 100)).toBe(
      'SELECT * FROM MYLIB.USERS FETCH FIRST 100 ROWS ONLY'
    );
  });

  it('keeps a trailing FETCH FIRST that is already within the cap', () => {
    expect(
      applySqlRowLimit('SELECT * FROM MYLIB.USERS FETCH FIRST 10 ROWS ONLY', 1000)
    ).toBe('SELECT * FROM MYLIB.USERS FETCH FIRST 10 ROWS ONLY');
  });

  it('puts the cap on its own line after a trailing -- comment', () => {
    expect(applySqlRowLimit('SELECT * FROM MYLIB.ORDERS -- open orders', 50)).toBe(
      'SELECT * FROM MYLIB.ORDERS -- open orders\nFETCH FIRST 50 ROWS ONLY'
    );
  });

  it('clamps a trailing FETCH NEXT', () => {
    expect(applySqlRowLimit('SELECT * FROM MYLIB.ORDERS FETCH NEXT 5000 ROWS ONLY', 100)).toBe(
      'SELECT * FROM MYLIB.ORDERS FETCH FIRST 100 ROWS ONLY'
    );
  });

  it('treats FETCH FIRST ROW ONLY as one row', () => {
    expect(applySqlRowLimit('SELECT * FROM MYLIB.ORDERS FETCH FIRST ROW ONLY', 100)).toBe(
      'SELECT * FROM MYLIB.ORDERS FETCH FIRST 1 ROWS ONLY'
    );
  });

  it('clamps LIMIT and keeps its OFFSET', () => {
    expect(applySqlRowLimit('SELECT * FROM MYLIB.ORDERS LIMIT 5000 OFFSET 20', 100)).toBe(
      'SELECT * FROM MYLIB.ORDERS LIMIT 100 OFFSET 20'
    );
  });
});

describe('takeRowsWithinLimit', () => {
  it('cuts the probe row and reports truncation', () => {
    expect(takeRowsWithinLimit([1, 2, 3], 2)).toEqual({ rows: [1, 2], truncated: true });
  });

  it('does not report truncation when every row fits', () => {
    expect(takeRowsWithinLimit([1, 2], 2)).toEqual({ rows: [1, 2], truncated: false });
    expect(takeRowsWithinLimit([], 2)).toEqual({ rows: [], truncated: false });
  });
});

describe('rowLimitWarning', () => {
  it('names the limit', () => {
    expect(rowLimitWarning(200)).toContain('stopped at 200 rows');
  });
});
