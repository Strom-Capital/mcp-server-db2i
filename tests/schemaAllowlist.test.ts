/**
 * Tests for the execute_query schema allowlist
 */

import { describe, it, expect } from 'vitest';
import {
  checkQuerySchemas,
  isSchemaAllowed,
  normalizeForParsing,
} from '../src/utils/security/schemaAllowlist.js';

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

  it('should say what failed and where, then list the possible causes', () => {
    const [message] = check('SELECT * FROM MYLIB/ORDERS').violations;
    expect(message).toMatch(/^The query could not be parsed, so its libraries could not be checked/);
    expect(message).toContain('near line 1: "/ORDERS"');
    expect(message).toContain('system naming (LIB/FILE)');
    expect(message).toContain('Db2 syntax the checker does not support yet');
  });

  describe('Db2 for i cast syntax', () => {
    it.each([
      'SELECT CAST(NOTE AS VARCHAR(60) CCSID 1208) FROM MYLIB.ORDERHDR',
      'SELECT CAST(NOTE AS NVARCHAR(30)) FROM MYLIB.ORDERHDR',
      'SELECT CAST(ITEMNO AS NCHAR(10)) FROM MYLIB.ORDERS',
    ])('should accept %s and still check its library', (sql) => {
      expect(check(sql).ok).toBe(true);
      const outside = check(sql.replace('MYLIB.', 'OTHERLIB.'));
      expect(outside.ok).toBe(false);
      expect(outside.violations[0]).toMatch(/^Table OTHERLIB\./);
    });

    it.each([
      'CHAR(10) CCSID 37',
      'VARCHAR(10) FOR BIT DATA',
      'CHAR(10) FOR SBCS DATA',
      'NCLOB(1000)',
      'CLOB(1M)',
      'CLOB(64 K)',
      'DBCLOB(100)',
      'GRAPHIC(10) CCSID 1200',
      'VARGRAPHIC(10)',
      'DECFLOAT(34)',
      'DECFLOAT',
      'TIMESTAMP(12)',
      'vargraphic(30) ccsid 1200',
    ])('should accept a cast to %s', (type) => {
      expect(check(`SELECT CAST(NOTE AS ${type}) FROM MYLIB.ORDERS`).ok).toBe(true);
    });

    it('should accept a Db2 cast together with parameters and FETCH FIRST', () => {
      const sql =
        'SELECT CAST(NOTE AS VARCHAR(60) CCSID 1208) AS NOTE FROM MYLIB.ORDERHDR ' +
        'WHERE ORDERNO = ? FETCH FIRST 5 ROWS ONLY';
      expect(check(sql).ok).toBe(true);
    });

    it('should still catch a qualified function inside a Db2 cast', () => {
      const result = check(
        'SELECT CAST(OUTSIDELIB.F(NOTE) AS VARGRAPHIC(10) CCSID 1200) FROM MYLIB.ORDERS'
      );
      expect(result.ok).toBe(false);
      expect(result.violations).toEqual([
        'Function OUTSIDELIB.F is not in the allowed schemas (MYLIB).',
      ]);
    });

    it('should not rename a qualified function that shares a type name', () => {
      expect(normalizeForParsing('SELECT X AS OUTSIDELIB.CLOB(1)')).toContain('OUTSIDELIB.CLOB');
      expect(normalizeForParsing('SELECT CAST(X AS NCHAR.F)')).toContain('NCHAR.F');
    });

    it('should leave string literals, quoted names and comments alone', () => {
      const sql =
        "SELECT CAST(NOTE AS VARGRAPHIC(30) CCSID 1200) -- AS NCHAR(1) CCSID 37 ?\n" +
        "FROM MYLIB.ORDERS /* AS CLOB(1M) FOR BIT DATA ? */ " +
        `WHERE DESCR = 'AS NVARCHAR CCSID 1208 ?' AND "AS NCHAR" = 1`;
      expect(normalizeForParsing(sql)).toBe(
        "SELECT CAST(NOTE AS VARCHAR(30) ) -- AS NCHAR(1) CCSID 37 ?\n" +
          "FROM MYLIB.ORDERS /* AS CLOB(1M) FOR BIT DATA ? */ " +
          `WHERE DESCR = 'AS NVARCHAR CCSID 1208 ?' AND "AS NCHAR" = 1`
      );
    });

    it('should keep quotes with doubled quote escapes intact', () => {
      const sql = "SELECT * FROM MYLIB.ORDERS WHERE DESCR = 'IT''S ? CCSID 1' AND ORDERNO = ?";
      expect(normalizeForParsing(sql)).toBe(
        "SELECT * FROM MYLIB.ORDERS WHERE DESCR = 'IT''S ? CCSID 1' AND ORDERNO = NULL"
      );
    });

    it('should not touch FOR READ ONLY or FOR FETCH ONLY', () => {
      expect(normalizeForParsing('SELECT * FROM MYLIB.ORDERS FOR READ ONLY')).toBe(
        'SELECT * FROM MYLIB.ORDERS FOR READ ONLY'
      );
      expect(normalizeForParsing('SELECT * FROM MYLIB.ORDERS FOR FETCH ONLY')).toBe(
        'SELECT * FROM MYLIB.ORDERS FOR FETCH ONLY'
      );
    });
  });

  describe('Db2 for i special registers', () => {
    function checkWithSysibm(sql: string) {
      return checkQuerySchemas(sql, { allowed: ['SYSIBM', 'MYLIB'] });
    }

    it.each([
      'SELECT CURRENT USER AS U FROM SYSIBM.SYSDUMMY1',
      'SELECT CURRENT USER U FROM SYSIBM.SYSDUMMY1',
      'SELECT CURRENT_USER AS U FROM SYSIBM.SYSDUMMY1',
      'SELECT CURRENT TIMESTAMP AS TS FROM SYSIBM.SYSDUMMY1',
      'SELECT CURRENT TIMESTAMP FROM SYSIBM.SYSDUMMY1',
      'SELECT CURRENT TIMESTAMP(12) AS TS, CURRENT TIME ZONE AS TZ FROM SYSIBM.SYSDUMMY1',
      'SELECT CURRENT DATE AS D FROM SYSIBM.SYSDUMMY1',
      'SELECT CURRENT SCHEMA AS S, CURRENT SERVER AS SRV, CURRENT PATH AS P FROM SYSIBM.SYSDUMMY1',
      'SELECT current date as d, current_time as t FROM SYSIBM.SYSDUMMY1',
      'SELECT USER AS U, SESSION_USER AS SU FROM SYSIBM.SYSDUMMY1',
    ])('should accept %s', (sql) => {
      expect(checkWithSysibm(sql).ok).toBe(true);
    });

    it.each([
      'SELECT ORDERNO, CURRENT DATE AS D FROM MYLIB.ORDERS',
      'SELECT ORDERNO FROM MYLIB.ORDERS WHERE ORDERDATE < CURRENT DATE',
      'SELECT ORDERNO FROM MYLIB.ORDERS WHERE ORDERDATE > CURRENT DATE - 30 DAYS',
      'SELECT ORDERNO FROM MYLIB.ORDERS WHERE CHANGED > CURRENT TIMESTAMP - 2 HOURS - (1 + 1) MINUTES',
      'SELECT ORDERNO, VARCHAR_FORMAT(CURRENT TIMESTAMP, \'YYYY-MM-DD\') AS TODAY FROM MYLIB.ORDERS',
      'SELECT ORDERNO, CAST(CURRENT DATE AS CHAR(10)) AS TODAY FROM MYLIB.ORDERS',
    ])('should accept %s and still check its library', (sql) => {
      expect(check(sql).ok).toBe(true);
      const outside = check(sql.replace('MYLIB.', 'OTHERLIB.'));
      expect(outside.ok).toBe(false);
      expect(outside.violations[0]).toMatch(/^Table OTHERLIB\./);
    });

    it('should still refuse a library outside the list next to a special register', () => {
      const result = check(
        'SELECT ORDERNO, CURRENT DATE AS D FROM MYLIB.ORDERS ' +
          'WHERE ORDERNO IN (SELECT ORDERNO FROM OTHERLIB.ORDERHDR WHERE ORDERDATE = CURRENT DATE - 1 DAY)'
      );
      expect(result.ok).toBe(false);
      expect(result.violations).toEqual([
        'Table OTHERLIB.ORDERHDR is not in the allowed schemas (MYLIB).',
      ]);
    });

    it('should not hide a table whose name looks like a special register', () => {
      const qualified = check('SELECT * FROM OTHERLIB.CURRENT USER');
      expect(qualified.ok).toBe(false);
      expect(qualified.violations[0]).toMatch(/^Table OTHERLIB\.CURRENT /);
      // An unqualified table named CURRENT with an alias no longer parses, so it is refused
      expect(check('SELECT * FROM CURRENT DATE').ok).toBe(false);
    });

    it('should only rewrite keywords, never qualified names or column names', () => {
      expect(
        normalizeForParsing('SELECT MYLIB.CURRENT_DATE, X.CURRENT DATE, T1 DAYS, 30 DAYS, CURRENT DATE.X')
      ).toBe('SELECT MYLIB.CURRENT_DATE, X.CURRENT DATE, T1 DAYS, 30, CURRENT DATE.X');
      expect(normalizeForParsing('SELECT A$CURRENT DATE, CURRENT DATES FROM MYLIB.ORDERS')).toBe(
        'SELECT A$CURRENT DATE, CURRENT DATES FROM MYLIB.ORDERS'
      );
    });

    it('should leave special registers in strings and comments alone', () => {
      const sql = "SELECT 'CURRENT DATE - 1 DAY' -- CURRENT USER\nFROM MYLIB.ORDERS /* 30 DAYS */";
      expect(normalizeForParsing(sql)).toBe(sql);
    });
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
