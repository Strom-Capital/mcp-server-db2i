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

  it('drops a trailing -- comment so the cap is not commented out', () => {
    expect(applySqlRowLimit('SELECT * FROM MYLIB.ORDERS -- open orders', 50)).toBe(
      'SELECT * FROM MYLIB.ORDERS FETCH FIRST 50 ROWS ONLY'
    );
  });

  it('ignores a limit inside a trailing comment', () => {
    for (const sql of [
      'SELECT * FROM MYLIB.ORDERS -- FETCH FIRST 5 ROWS ONLY',
      'SELECT * FROM MYLIB.ORDERS /* LIMIT 5 */',
      'SELECT * FROM MYLIB.ORDERS --x\u0085',
    ]) {
      expect(applySqlRowLimit(sql, 50)).toBe('SELECT * FROM MYLIB.ORDERS FETCH FIRST 50 ROWS ONLY');
    }
  });

  it('ignores a clause inside a trailing string literal', () => {
    expect(applySqlRowLimit("SELECT * FROM MYLIB.ORDERS WHERE NOTE = 'FOR READ ONLY'", 50)).toBe(
      "SELECT * FROM MYLIB.ORDERS WHERE NOTE = 'FOR READ ONLY' FETCH FIRST 50 ROWS ONLY"
    );
  });

  it.each([
    ['FOR READ ONLY', 'FOR READ ONLY'],
    ['FOR FETCH ONLY', 'FOR FETCH ONLY'],
    ['FOR UPDATE', 'FOR UPDATE'],
    ['FOR UPDATE OF a list', 'FOR UPDATE OF ITEMNO, "QTY"'],
    ['OPTIMIZE FOR n ROWS', 'OPTIMIZE FOR 20 ROWS'],
    ['WITH UR', 'WITH UR'],
    ['WITH RS USE AND KEEP EXCLUSIVE LOCKS', 'WITH RS USE AND KEEP EXCLUSIVE LOCKS'],
    ['SKIP LOCKED DATA', 'SKIP LOCKED DATA'],
    ['WAIT FOR OUTCOME', 'WAIT FOR OUTCOME'],
    ['several clauses', 'FOR READ ONLY OPTIMIZE FOR 5 ROWS WITH NC'],
    ['lower case', 'for read only with ur'],
  ])('puts the cap before %s', (_label, clauses) => {
    expect(applySqlRowLimit(`SELECT * FROM MYLIB.ORDERS ORDER BY ORDERNO ${clauses};`, 50)).toBe(
      `SELECT * FROM MYLIB.ORDERS ORDER BY ORDERNO FETCH FIRST 50 ROWS ONLY ${clauses}`
    );
  });

  it('clamps an existing FETCH FIRST that sits before the trailing clauses', () => {
    expect(applySqlRowLimit('SELECT * FROM MYLIB.ORDERS FETCH FIRST 5 ROWS ONLY FOR READ ONLY', 100)).toBe(
      'SELECT * FROM MYLIB.ORDERS FETCH FIRST 5 ROWS ONLY FOR READ ONLY'
    );
    expect(applySqlRowLimit('SELECT * FROM MYLIB.ORDERS FETCH FIRST 5000 ROWS ONLY WITH UR', 100)).toBe(
      'SELECT * FROM MYLIB.ORDERS FETCH FIRST 100 ROWS ONLY WITH UR'
    );
  });

  it('keeps a comment between the statement and its trailing clauses out of the way', () => {
    expect(applySqlRowLimit('SELECT * FROM MYLIB.ORDERS /* c */ FOR READ ONLY -- done', 10)).toBe(
      'SELECT * FROM MYLIB.ORDERS FETCH FIRST 10 ROWS ONLY FOR READ ONLY'
    );
  });

  it('does not take a CTE or a column named like a clause for one', () => {
    expect(applySqlRowLimit('WITH UR AS (SELECT 1 AS N FROM SYSIBM.SYSDUMMY1) SELECT N FROM UR', 10)).toBe(
      'WITH UR AS (SELECT 1 AS N FROM SYSIBM.SYSDUMMY1) SELECT N FROM UR FETCH FIRST 10 ROWS ONLY'
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
