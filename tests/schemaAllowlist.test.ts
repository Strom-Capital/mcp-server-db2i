/**
 * Tests for the execute_query schema allowlist
 */

import { describe, it, expect } from 'vitest';
import { checkQuerySchemas } from '../src/utils/security/schemaAllowlist.js';

const allowed = ['MYLIB'];

function check(sql: string, defaultSchema?: string) {
  return checkQuerySchemas(sql, { allowed, defaultSchema });
}

describe('checkQuerySchemas', () => {
  it('should allow a qualified table in the list', () => {
    expect(check('SELECT * FROM MYLIB.ORDERS WHERE ORDERNO = 1001').ok).toBe(true);
  });

  it('should reject a qualified table outside the list', () => {
    const result = check('SELECT * FROM OTHERLIB.ORDERS');
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toContain('OTHERLIB.ORDERS');
  });

  it('should match schema names case-insensitively', () => {
    expect(check('SELECT * FROM mylib.ORDERS').ok).toBe(true);
  });

  it('should resolve an unqualified name to the default schema', () => {
    expect(check('SELECT * FROM ORDERS WHERE ORDERNO = 1', 'mylib').ok).toBe(true);
  });

  it('should reject an unqualified name when the default schema is not allowed', () => {
    const result = check('SELECT * FROM ORDERS', 'OUTSIDELIB');
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toContain('OUTSIDELIB');
  });

  it('should reject an unqualified name when no default schema is configured', () => {
    const result = check('SELECT * FROM ORDERS');
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toContain('no default schema');
  });

  it('should check a schema that appears only inside a subquery', () => {
    const result = check(
      'SELECT * FROM MYLIB.ORDERHDR H WHERE H.ORDERNO IN (SELECT ORDERNO FROM OTHERLIB.ORDERS)'
    );
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.includes('OTHERLIB.ORDERS'))).toBe(true);
  });

  it('should ignore names defined in a WITH clause', () => {
    const sql = 'WITH T AS (SELECT ORDERNO FROM MYLIB.ORDERS) SELECT * FROM T';
    expect(check(sql).ok).toBe(true);
  });

  it('should accept a query that uses both parameters and FETCH FIRST', () => {
    const sql =
      'SELECT LINENO, ITEMNO FROM MYLIB.ORDERS WHERE ORDERNO = ? FETCH FIRST 10 ROWS ONLY';
    expect(check(sql).ok).toBe(true);
  });

  it('should not treat a question mark inside a string as a parameter', () => {
    const sql = "SELECT * FROM MYLIB.ORDERS WHERE DESCR = 'WHAT?'";
    expect(check(sql).ok).toBe(true);
  });

  it('should reject system naming while the allowlist is active', () => {
    const result = check('SELECT * FROM MYLIB/ORDERS');
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toContain('could not be parsed');
  });

  it('should reject TABLE() table functions while the allowlist is active', () => {
    const result = check('SELECT * FROM TABLE(QSYS2.ACTIVE_JOB_INFO()) X');
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toContain('could not be parsed');
  });

  it('should not allow catalog schemas unless they are listed', () => {
    const result = checkQuerySchemas('SELECT * FROM QSYS2.SYSTABLES', {
      allowed: ['MYLIB', 'QSYS2'],
    });
    expect(result.ok).toBe(true);
    expect(check('SELECT * FROM QSYS2.SYSTABLES').ok).toBe(false);
  });
});
