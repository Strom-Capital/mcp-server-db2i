/**
 * Tests for the execute_query schema allowlist
 */

import { describe, it, expect } from 'vitest';
import { checkQuerySchemas, isSchemaAllowed } from '../src/utils/security/schemaAllowlist.js';

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

  describe('function calls', () => {
    const withCatalog = { allowed: ['MYLIB', 'SYSIBM'], defaultSchema: 'MYLIB' };

    it('should reject a qualified function outside the list', () => {
      const result = checkQuerySchemas('SELECT OUTSIDELIB.F(ORDERNO) FROM MYLIB.ORDERS', withCatalog);
      expect(result.ok).toBe(false);
      expect(result.violations).toEqual([
        'Function OUTSIDELIB.F is not in the allowed schemas (MYLIB, SYSIBM).',
      ]);
    });

    it('should reject a qualified function when every table is allowed', () => {
      const result = checkQuerySchemas('SELECT OUTSIDELIB.F(1) FROM SYSIBM.SYSDUMMY1', withCatalog);
      expect(result.ok).toBe(false);
      expect(result.violations[0]).toContain('OUTSIDELIB.F');
    });

    it.each([
      ['WHERE', 'SELECT ORDERNO FROM MYLIB.ORDERS WHERE OUTSIDELIB.F(ORDERNO) = 1'],
      ['an aggregate', 'SELECT SUM(OUTSIDELIB.F(ORDERNO)) FROM MYLIB.ORDERS'],
      ['CAST', 'SELECT CAST(OUTSIDELIB.F(ORDERNO) AS INT) FROM MYLIB.ORDERS'],
      ['ORDER BY', 'SELECT ORDERNO FROM MYLIB.ORDERS ORDER BY OUTSIDELIB.F(ORDERNO)'],
      [
        'a subquery',
        'SELECT * FROM MYLIB.ORDERS WHERE ORDERNO IN (SELECT OUTSIDELIB.F(1) FROM MYLIB.ORDERHDR)',
      ],
      [
        'a WITH clause',
        'WITH T AS (SELECT OUTSIDELIB.F(ORDERNO) AS X FROM MYLIB.ORDERS) SELECT X FROM T',
      ],
      ['a nested call', 'SELECT UPPER(OUTSIDELIB.F(ORDERNO)) FROM MYLIB.ORDERS'],
    ])('should reject a qualified function inside %s', (_where, sql) => {
      const result = check(sql);
      expect(result.ok).toBe(false);
      expect(result.violations.some((v) => v.includes('OUTSIDELIB.F'))).toBe(true);
    });

    it('should allow a qualified function in the list, case-insensitively', () => {
      expect(check('SELECT MYLIB.F(ORDERNO) FROM MYLIB.ORDERS').ok).toBe(true);
      expect(check('SELECT mylib.F(ORDERNO) FROM MYLIB.ORDERS').ok).toBe(true);
    });

    it('should require the schema of a qualified system function to be listed', () => {
      const sql = 'SELECT QSYS2.F(ORDERNO) FROM MYLIB.ORDERS';
      expect(check(sql).ok).toBe(false);
      expect(checkQuerySchemas(sql, { allowed: ['MYLIB', 'QSYS2'] }).ok).toBe(true);
    });

    it('should report each outside function once', () => {
      const result = check(
        'SELECT OUTSIDELIB.F(ORDERNO), OUTSIDELIB.F(LINENO), OTHERLIB.G(ITEMNO) FROM MYLIB.ORDERS'
      );
      expect(result.violations).toEqual([
        'Function OUTSIDELIB.F is not in the allowed schemas (MYLIB).',
        'Function OTHERLIB.G is not in the allowed schemas (MYLIB).',
      ]);
    });

    it('should allow unqualified built-in functions', () => {
      const sql =
        'SELECT UPPER(ITEMNO), SUBSTR(ITEMNO, 1, 2), COALESCE(LINENO, 0), COUNT(*), CURRENT_DATE ' +
        'FROM MYLIB.ORDERS GROUP BY ITEMNO, LINENO';
      expect(check(sql).ok).toBe(true);
    });
  });
});

describe('isSchemaAllowed', () => {
  it('should match names case-insensitively', () => {
    expect(isSchemaAllowed('mylib', ['MYLIB'])).toBe(true);
  });

  it('should reject a schema that is not listed', () => {
    expect(isSchemaAllowed('OTHERLIB', ['MYLIB'])).toBe(false);
  });

  it('should reject a blank schema', () => {
    expect(isSchemaAllowed('  ', ['MYLIB'])).toBe(false);
  });
});
