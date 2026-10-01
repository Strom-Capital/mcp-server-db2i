/**
 * Tests for SQL Security Validator
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  SqlSecurityValidator,
  isReadOnlyQuery,
  validateQuery,
  DANGEROUS_OPERATIONS,
  DANGEROUS_FUNCTIONS,
  IBM_I_DANGEROUS_OPERATIONS,
  unqualifiedTableFunctions,
} from '../src/utils/security/sqlSecurityValidator.js';

describe('SqlSecurityValidator', () => {
  describe('ALLOW - Valid read-only queries', () => {
    it('should allow simple SELECT statements', () => {
      const result = SqlSecurityValidator.validateQuery('SELECT * FROM users');
      expect(result.isValid).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should allow SELECT with WHERE clause', () => {
      const result = SqlSecurityValidator.validateQuery(
        "SELECT id, name FROM users WHERE status = 'active'"
      );
      expect(result.isValid).toBe(true);
    });

    it('should allow SELECT with JOINs', () => {
      const result = SqlSecurityValidator.validateQuery(`
        SELECT u.name, o.order_id 
        FROM users u 
        INNER JOIN orders o ON u.id = o.user_id
        WHERE u.status = 'active'
      `);
      expect(result.isValid).toBe(true);
    });

    it('should allow SELECT with subqueries', () => {
      const result = SqlSecurityValidator.validateQuery(`
        SELECT * FROM users 
        WHERE id IN (SELECT user_id FROM orders WHERE total > 100)
      `);
      expect(result.isValid).toBe(true);
    });

    it('should allow WITH (CTE) queries', () => {
      const result = SqlSecurityValidator.validateQuery(`
        WITH active_users AS (
          SELECT * FROM users WHERE status = 'active'
        )
        SELECT * FROM active_users
      `);
      expect(result.isValid).toBe(true);
    });

    it('should allow SELECT with aggregations', () => {
      const result = SqlSecurityValidator.validateQuery(`
        SELECT department, COUNT(*) as count, AVG(salary) as avg_salary
        FROM employees
        GROUP BY department
        HAVING COUNT(*) > 5
        ORDER BY avg_salary DESC
      `);
      expect(result.isValid).toBe(true);
    });

    it('should allow SELECT with CASE statements', () => {
      const result = SqlSecurityValidator.validateQuery(`
        SELECT name,
          CASE 
            WHEN age < 18 THEN 'minor'
            WHEN age >= 65 THEN 'senior'
            ELSE 'adult'
          END as age_group
        FROM users
      `);
      expect(result.isValid).toBe(true);
    });

    it('should allow SELECT with FETCH FIRST (Db2 pagination)', () => {
      const result = SqlSecurityValidator.validateQuery(`
        SELECT * FROM users ORDER BY created_at DESC FETCH FIRST 10 ROWS ONLY
      `);
      expect(result.isValid).toBe(true);
    });

    // False positive test - keywords inside string literals
    it('should allow SELECT where "DELETE" appears in string literal', () => {
      const result = SqlSecurityValidator.validateQuery(
        "SELECT * FROM logs WHERE action = 'DELETE'"
      );
      expect(result.isValid).toBe(true);
    });

    it('should allow SELECT where "DROP" appears in string literal', () => {
      const result = SqlSecurityValidator.validateQuery(
        "SELECT * FROM events WHERE type = 'DROP TABLE' AND status = 'pending'"
      );
      expect(result.isValid).toBe(true);
    });

    it('should allow SELECT with UPDATE keyword in column alias', () => {
      const result = SqlSecurityValidator.validateQuery(
        "SELECT last_modified as last_update FROM users"
      );
      expect(result.isValid).toBe(true);
    });

    // False positive test - function names inside string literals
    it('should allow SELECT where "SYSTEM(" appears in string literal', () => {
      const result = SqlSecurityValidator.validateQuery(
        "SELECT * FROM logs WHERE message LIKE '%SYSTEM(command)%'"
      );
      expect(result.isValid).toBe(true);
    });

    it('should allow SELECT where "QCMDEXC(" appears in string literal', () => {
      const result = SqlSecurityValidator.validateQuery(
        "SELECT * FROM audit WHERE details = 'QCMDEXC(CALL PGM)'"
      );
      expect(result.isValid).toBe(true);
    });

    it('should allow SELECT where "LOAD_EXTENSION(" appears in string literal', () => {
      const result = SqlSecurityValidator.validateQuery(
        "SELECT * FROM config WHERE setting = 'LOAD_EXTENSION(test)'"
      );
      expect(result.isValid).toBe(true);
    });
  });

  describe('BLOCK - Dangerous operations', () => {
    it('should block INSERT statements', () => {
      const result = SqlSecurityValidator.validateQuery(
        "INSERT INTO users (name) VALUES ('test')"
      );
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('INSERT'))).toBe(true);
    });

    it('should block UPDATE statements', () => {
      const result = SqlSecurityValidator.validateQuery(
        "UPDATE users SET status = 'inactive' WHERE id = 1"
      );
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('UPDATE'))).toBe(true);
    });

    it('should block DELETE statements', () => {
      const result = SqlSecurityValidator.validateQuery('DELETE FROM users WHERE id = 1');
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('DELETE'))).toBe(true);
    });

    it('should report every dangerous call, not just the statement type', () => {
      const result = SqlSecurityValidator.validateQuery(
        "DELETE FROM MYLIB.ORDERS WHERE ORDERNO = HTTP_GET('https://ibmi.example.com')"
      );
      expect(result.violations.filter(v => v.includes('DELETE'))).toHaveLength(1);
      expect(result.violations.some(v => v.includes('HTTP_'))).toBe(true);
    });

    it('should report multiple statements once', () => {
      const result = SqlSecurityValidator.validateQuery(
        'SELECT 1 FROM SYSIBM.SYSDUMMY1; SELECT 2 FROM SYSIBM.SYSDUMMY1; SELECT 3 FROM SYSIBM.SYSDUMMY1'
      );
      expect(result.violations.filter(v => v.startsWith('Multiple statements'))).toHaveLength(1);
    });

    it('should block DROP TABLE', () => {
      const result = SqlSecurityValidator.validateQuery('DROP TABLE users');
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('DROP'))).toBe(true);
    });

    it('should block DROP INDEX', () => {
      const result = SqlSecurityValidator.validateQuery('DROP INDEX idx_users ON users');
      expect(result.isValid).toBe(false);
    });

    it('should block CREATE TABLE', () => {
      const result = SqlSecurityValidator.validateQuery(
        'CREATE TABLE test (id INT PRIMARY KEY)'
      );
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('CREATE'))).toBe(true);
    });

    it('should block ALTER TABLE', () => {
      const result = SqlSecurityValidator.validateQuery(
        'ALTER TABLE users ADD COLUMN email VARCHAR(255)'
      );
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('ALTER'))).toBe(true);
    });

    it('should block TRUNCATE', () => {
      const result = SqlSecurityValidator.validateQuery('TRUNCATE TABLE users');
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('TRUNCATE'))).toBe(true);
    });

    it('should block GRANT', () => {
      const result = SqlSecurityValidator.validateQuery(
        'GRANT SELECT ON users TO public'
      );
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('GRANT'))).toBe(true);
    });

    it('should block REVOKE', () => {
      const result = SqlSecurityValidator.validateQuery(
        'REVOKE SELECT ON users FROM public'
      );
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('REVOKE'))).toBe(true);
    });

    it('should block CALL procedure', () => {
      const result = SqlSecurityValidator.validateQuery('CALL my_procedure()');
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('CALL'))).toBe(true);
    });

    it('should block EXECUTE', () => {
      const result = SqlSecurityValidator.validateQuery("EXECUTE sp_help 'users'");
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('EXEC'))).toBe(true);
    });
  });

  describe('BLOCK - IBM i specific operations', () => {
    it('should block QCMDEXC function calls', () => {
      const result = SqlSecurityValidator.validateQuery(
        "SELECT QCMDEXC('DLTF FILE(MYLIB/MYFILE)') FROM SYSIBM.SYSDUMMY1"
      );
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('QCMDEXC'))).toBe(true);
    });

    it('should block a call hidden behind an earlier string that contains the same name', () => {
      const result = SqlSecurityValidator.validateQuery(
        "SELECT 'QCMDEXC' AS label, QSYS2.QCMDEXC('DLTLIB X') FROM SYSIBM.SYSDUMMY1"
      );
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('QCMDEXC'))).toBe(true);
    });

    it('should block a delimited identifier used as a function name', () => {
      const result = SqlSecurityValidator.validateQuery(
        'SELECT QSYS2."QCMDEXC"(\'DLTLIB X\') FROM SYSIBM.SYSDUMMY1'
      );
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('QCMDEXC'))).toBe(true);
    });

    it('should block QCMDEXC inside a CASE expression', () => {
      const result = SqlSecurityValidator.validateQuery(
        "SELECT CASE WHEN 1 = 1 THEN QSYS2.QCMDEXC('DLTLIB X') END FROM SYSIBM.SYSDUMMY1"
      );
      expect(result.isValid).toBe(false);
    });

    it('should block QCMDEXC inside a subquery', () => {
      const result = SqlSecurityValidator.validateQuery(
        "SELECT * FROM (SELECT QSYS2.QCMDEXC('DLTLIB X') AS c FROM SYSIBM.SYSDUMMY1) s"
      );
      expect(result.isValid).toBe(false);
    });

    it('should block QCMDEXC used as a table function', () => {
      const result = SqlSecurityValidator.validateQuery(
        "SELECT * FROM TABLE(QSYS2.QCMDEXC('DLTLIB X')) x"
      );
      expect(result.isValid).toBe(false);
    });

    it('should block HTTP services that can send data off the system', () => {
      for (const sql of [
        "SELECT QSYS2.HTTP_GET('http://example.test/x', '') FROM SYSIBM.SYSDUMMY1",
        "SELECT SYSTOOLS.HTTPGETCLOB('http://example.test/x', '') FROM SYSIBM.SYSDUMMY1",
        "SELECT QSYS2.HTTP_POST('http://example.test/x', '', '') FROM SYSIBM.SYSDUMMY1",
      ]) {
        expect(SqlSecurityValidator.validateQuery(sql).isValid).toBe(false);
      }
    });

    it('should block IFS write, spreadsheet, and email services', () => {
      for (const sql of [
        "SELECT QSYS2.IFS_WRITE_UTF8(PATH_NAME => '/tmp/x', LINE => 'a') FROM SYSIBM.SYSDUMMY1",
        "SELECT * FROM TABLE(QSYS2.IFS_WRITE('/tmp/x', 'a')) x",
        "SELECT QSYS2.GENERATE_SPREADSHEET('a', 'b') FROM SYSIBM.SYSDUMMY1",
        "SELECT QSYS2.SEND_EMAIL('a@b.example', 'x', 'y') FROM SYSIBM.SYSDUMMY1",
      ]) {
        expect(SqlSecurityValidator.validateQuery(sql).isValid).toBe(false);
      }
    });

    it('should allow catalog table functions that only read metadata', () => {
      const result = SqlSecurityValidator.validateQuery(
        "SELECT * FROM TABLE(QSYS2.OBJECT_STATISTICS('QSYS', '*LIB')) x"
      );
      expect(result.isValid).toBe(true);
    });

    it('should allow a user-defined function that is not on the denylist', () => {
      const result = SqlSecurityValidator.validateQuery(
        'SELECT MYLIB.MYUDF(1) FROM SYSIBM.SYSDUMMY1'
      );
      expect(result.isValid).toBe(true);
    });
  });

  describe('BLOCK - Case insensitivity', () => {
    it('should block lowercase delete', () => {
      const result = SqlSecurityValidator.validateQuery('delete from users');
      expect(result.isValid).toBe(false);
    });

    it('should block mixed case DeLeTe', () => {
      const result = SqlSecurityValidator.validateQuery('DeLeTe FrOm users');
      expect(result.isValid).toBe(false);
    });

    it('should block uppercase DROP', () => {
      const result = SqlSecurityValidator.validateQuery('DROP TABLE USERS');
      expect(result.isValid).toBe(false);
    });
  });

  describe('BLOCK - SQL injection patterns', () => {
    it('should block multi-statement with semicolon', () => {
      const result = SqlSecurityValidator.validateQuery(
        'SELECT * FROM users; DROP TABLE users'
      );
      expect(result.isValid).toBe(false);
    });

    it('should block UNION-based injection with DELETE', () => {
      const result = SqlSecurityValidator.validateQuery(
        "SELECT * FROM users WHERE id = 1 UNION DELETE FROM users"
      );
      expect(result.isValid).toBe(false);
    });

    it('should ignore dangerous words that appear only inside a comment', () => {
      const result = SqlSecurityValidator.validateQuery(
        'SELECT * FROM users /* DROP TABLE users */'
      );
      expect(result.isValid).toBe(true);
    });

    it('should still block a statement that follows a comment', () => {
      const result = SqlSecurityValidator.validateQuery(
        'SELECT * FROM users /* note */; DROP TABLE users'
      );
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('DROP'))).toBe(true);
    });
  });

  describe('Configuration options', () => {
    it('should enforce query length limit', () => {
      const longQuery = 'SELECT ' + 'a'.repeat(10001) + ' FROM users';
      const result = SqlSecurityValidator.validateQuery(longQuery, {
        maxQueryLength: 10000,
      });
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('length'))).toBe(true);
    });

    it('should allow custom forbidden keywords', () => {
      const result = SqlSecurityValidator.validateQuery(
        'SELECT * FROM users WHERE CUSTOM_FORBIDDEN = 1',
        { forbiddenKeywords: ['CUSTOM_FORBIDDEN'] }
      );
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('CUSTOM_FORBIDDEN'))).toBe(true);
    });

    it('should respect maxQueryLength configuration', () => {
      const result = SqlSecurityValidator.validateQuery('SELECT * FROM users', {
        maxQueryLength: 5,
      });
      expect(result.isValid).toBe(false);
    });

    describe('QUERY_MAX_LENGTH', () => {
      const saved = process.env.QUERY_MAX_LENGTH;
      afterEach(() => {
        if (saved === undefined) delete process.env.QUERY_MAX_LENGTH;
        else process.env.QUERY_MAX_LENGTH = saved;
      });

      it('accepts statements up to 32768 characters by default', () => {
        delete process.env.QUERY_MAX_LENGTH;
        const sql = 'SELECT ORDERNO FROM MYLIB.ORDERS WHERE ' + 'ORDERNO = 1 OR '.repeat(2000) + 'ORDERNO = 2';
        expect(sql.length).toBeGreaterThan(10000);
        expect(sql.length).toBeLessThanOrEqual(32768);
        expect(validateQuery(sql).isValid).toBe(true);
      });

      it('uses QUERY_MAX_LENGTH and suggests how to shorten the query', () => {
        process.env.QUERY_MAX_LENGTH = '20';
        const result = validateQuery('SELECT ORDERNO FROM MYLIB.ORDERS');
        expect(result.isValid).toBe(false);
        expect(result.violations[0]).toContain('maximum length of 20 characters (QUERY_MAX_LENGTH)');
        expect(result.violations[0]).toContain('Split the work into smaller queries');
      });

      it('rejects a value outside 1 to 2097152', () => {
        process.env.QUERY_MAX_LENGTH = '0';
        expect(() => validateQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1')).toThrow('QUERY_MAX_LENGTH must be at least 1');
      });
    });
  });

  describe('ALLOW - Db2 for i functions and names that share a word with a statement', () => {
    it.each([
      ["REPLACE()", "SELECT REPLACE(ITEMNO, '-', '') FROM MYLIB.ORDERS"],
      ['columns named START, STOP, LOAD and LOCK', 'SELECT START, STOP, LOAD, LOCK FROM MYLIB.ORDERS'],
      ['a quoted column named DELETE', 'SELECT "DELETE" FROM MYLIB.ORDERS'],
      ['FOR UPDATE OF', 'SELECT ORDERNO FROM MYLIB.ORDERS FOR UPDATE OF ITEMNO'],
      ['GROUPING SETS', 'SELECT ITEMNO, SUM(QTY) FROM MYLIB.ORDERS GROUP BY GROUPING SETS ((ITEMNO), ())'],
      ['VALUES', 'VALUES 1'],
      ['a parenthesized query', '(SELECT ORDERNO FROM MYLIB.ORDERS) UNION (SELECT ORDERNO FROM MYLIB.ORDERHDR)'],
      ['a trailing semicolon', 'SELECT ORDERNO FROM MYLIB.ORDERS;  '],
    ])('allows %s', (_label, sql) => {
      const result = validateQuery(sql);
      expect(result.violations).toEqual([]);
      expect(result.isValid).toBe(true);
    });
  });

  describe('BLOCK - data-change table references with any separator', () => {
    const separators = [' ', '\t', '\n', '\r\n', '\u000b', '\u000c', '\u0085', '\u00a0', '\u2028', '\u3000', '/**/', ' -- x\n'];
    const forms = [
      (s: string) => `SELECT * FROM FINAL${s}TABLE${s}(${s}INSERT${s}INTO${s}MYLIB.ORDERS${s}VALUES${s}(1))`,
      (s: string) => `SELECT * FROM OLD${s}TABLE${s}(${s}DELETE${s}FROM${s}MYLIB.ORDERS)`,
      (s: string) => `SELECT * FROM OLD${s}TABLE${s}(${s}DELETE${s}MYLIB.ORDERS)`,
      (s: string) => `SELECT * FROM OLD${s}TABLE${s}(${s}UPDATE${s}MYLIB.ORDERS${s}SET${s}ITEMNO = 1)`,
      (s: string) => `SELECT * FROM FINAL${s}TABLE${s}(${s}INSERT${s}INTO"MYLIB"."ORDERS"${s}VALUES${s}(1))`,
    ];
    it.each(separators.flatMap((sep) => forms.map((form) => [JSON.stringify(sep), form(sep)] as const)))(
      'blocks with separator %s: %s',
      (_sep, sql) => {
        expect(validateQuery(sql).isValid).toBe(false);
      }
    );
  });

  describe('BLOCK - comments and strings that end differently in Db2 for i', () => {
    it.each([
      ['a -- comment ended by NEL', 'SELECT * FROM --x\u0085FINAL TABLE (INSERT INTO MYLIB.ORDERS VALUES (1))'],
      ['a -- comment ended by CR', 'SELECT * FROM --x\rFINAL TABLE (INSERT INTO MYLIB.ORDERS VALUES (1))'],
      ['a nested block comment hiding a quote', "SELECT * FROM /* /* */ ' */ FINAL TABLE (INSERT INTO MYLIB.ORDERS VALUES (1)) -- '"],
      ['an unterminated string', "SELECT 'x FROM SYSIBM.SYSDUMMY1"],
      ['an unterminated block comment', 'SELECT 1 FROM SYSIBM.SYSDUMMY1 /* x'],
      ['an unterminated delimited identifier', 'SELECT "X FROM SYSIBM.SYSDUMMY1'],
    ])('blocks %s', (_label, sql) => {
      expect(validateQuery(sql).isValid).toBe(false);
    });

    it('allows nested block comments that close', () => {
      expect(validateQuery('SELECT ORDERNO /* a /* b */ c */ FROM MYLIB.ORDERS').isValid).toBe(true);
    });
  });

  describe('BLOCK - writes recognized by their shape', () => {
    it.each([
      ['FINAL TABLE (INSERT INTO ...)', 'SELECT * FROM FINAL TABLE (INSERT INTO MYLIB.ORDERS (ORDERNO) VALUES (1))', 'INSERT'],
      ['OLD TABLE (UPDATE ... SET)', "SELECT * FROM OLD TABLE (UPDATE MYLIB.ORDERS O SET ITEMNO = 'X')", 'UPDATE'],
      ['OLD TABLE (DELETE FROM ...) in a CTE', 'WITH D AS (SELECT * FROM OLD TABLE (DELETE FROM MYLIB.ORDERS)) SELECT 1 FROM D', 'DELETE'],
      ['a write inside parentheses', '(DELETE FROM MYLIB.ORDERS)', 'DELETE'],
      ['NEL between the keywords', 'SELECT * FROM FINAL TABLE\u0085(INSERT\u0085INTO MYLIB.ORDERS VALUES (1))', 'INSERT'],
      ['a quoted table right after INTO', 'SELECT * FROM FINAL TABLE (INSERT INTO"MYLIB"."ORDERS" VALUES (1))', 'INSERT'],
      ['a quoted table right after UPDATE', 'SELECT * FROM OLD TABLE (UPDATE"MYLIB"."ORDERS"SET ITEMNO = 1)', 'UPDATE'],
      ['no-break space and ideographic space', 'SELECT * FROM FINAL TABLE\u00a0(INSERT\u3000INTO MYLIB.ORDERS VALUES (1))', 'INSERT'],
      ['a tab and a line separator', 'SELECT * FROM OLD TABLE\t(DELETE\u2028FROM MYLIB.ORDERS)', 'DELETE'],
      ['OLD TABLE (DELETE without FROM)', 'SELECT * FROM OLD TABLE (DELETE MYLIB.ORDERS)', 'data-change table reference'],
      ['OLD TABLE (UPDATE with a column list alias)', "SELECT * FROM OLD TABLE(UPDATE MYLIB.ORDERS O (A) SET A = 'X')", 'data-change table reference'],
      ['MERGE', 'MERGE INTO MYLIB.ORDERS T USING MYLIB.ORDERHDR S ON T.ORDERNO = S.ORDERNO WHEN MATCHED THEN DELETE', 'MERGE'],
      ['SET', 'SET CURRENT SCHEMA = OUTSIDELIB', 'SET'],
      ['LOCK TABLE', 'LOCK TABLE MYLIB.ORDERS IN EXCLUSIVE MODE', 'LOCK'],
      ['a second SELECT', 'SELECT 1 FROM SYSIBM.SYSDUMMY1; SELECT 2 FROM SYSIBM.SYSDUMMY1', 'Multiple statements'],
    ])('blocks %s', (_label, sql, named) => {
      const result = validateQuery(sql);
      expect(result.isValid).toBe(false);
      expect(result.violations.some((v) => v.includes(named))).toBe(true);
    });
  });

  describe('Convenience functions', () => {
    it('isReadOnlyQuery should return true for SELECT', () => {
      expect(isReadOnlyQuery('SELECT * FROM users')).toBe(true);
    });

    it('isReadOnlyQuery should return false for DELETE', () => {
      expect(isReadOnlyQuery('DELETE FROM users')).toBe(false);
    });

    it('validateQuery should return detailed results', () => {
      const result = validateQuery('DELETE FROM users');
      expect(result).toHaveProperty('isValid');
      expect(result).toHaveProperty('violations');
      expect(result).toHaveProperty('validationMethod');
      expect(result.isValid).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
    });
  });

  describe('Constants are properly defined', () => {
    it('should have DANGEROUS_OPERATIONS defined', () => {
      expect(DANGEROUS_OPERATIONS).toBeDefined();
      expect(DANGEROUS_OPERATIONS.length).toBeGreaterThan(0);
      expect(DANGEROUS_OPERATIONS).toContain('INSERT');
      expect(DANGEROUS_OPERATIONS).toContain('DELETE');
      expect(DANGEROUS_OPERATIONS).toContain('UPDATE');
      expect(DANGEROUS_OPERATIONS).toContain('DROP');
    });

    it('should have DANGEROUS_FUNCTIONS defined', () => {
      expect(DANGEROUS_FUNCTIONS).toBeDefined();
      expect(DANGEROUS_FUNCTIONS).toContain('QCMDEXC');
    });

    it('should have IBM_I_DANGEROUS_OPERATIONS defined', () => {
      expect(IBM_I_DANGEROUS_OPERATIONS).toBeDefined();
      expect(IBM_I_DANGEROUS_OPERATIONS).toContain('QCMDEXC');
      expect(IBM_I_DANGEROUS_OPERATIONS).toContain('SQL_EXECUTE_IMMEDIATE');
    });
  });
});

describe('unqualifiedTableFunctions', () => {
  it.each([
    ["SELECT * FROM TABLE(DISPLAY_JOURNAL('OUTSIDELIB', 'QSQJRN')) J", ['DISPLAY_JOURNAL']],
    ['SELECT * FROM MYLIB.ORDERS O, LATERAL (SELECT * FROM TABLE ( ACTIVE_JOB_INFO () ) Z) Y', ['ACTIVE_JOB_INFO']],
    ["SELECT * FROM TABLE(IFS_READ(PATH_NAME => '/x')) X, TABLE(IFS_READ(PATH_NAME => '/y')) Y", ['IFS_READ']],
    ['SELECT * FROM TABLE("MYTF"(1)) X', ['a quoted name']],
    ["select entry_data from table(display_journal('OUTSIDELIB', 'QSQJRN')) j", ['DISPLAY_JOURNAL']],
    ["SELECT * FROM Table(Ifs_Read(PATH_NAME => '/x')) X", ['IFS_READ']],
    ['SELECT * FROM TABLE(\u00c4CTIVE_JOB_INFO()) X', ['\u00c4CTIVE_JOB_INFO']],
    ['SELECT * FROM LATERAL(TABLE(\nACTIVE_JOB_INFO())) X', ['ACTIVE_JOB_INFO']],
    ['SELECT * FROM TABLE/* c */(OBJECT_STATISTICS(\'MYLIB\', \'*FILE\')) X', ['OBJECT_STATISTICS']],
  ])('finds the unqualified call in %s', (sql, names) => {
    expect(unqualifiedTableFunctions(sql)).toEqual(names);
  });

  it.each([
    ["SELECT * FROM TABLE(QSYS2.DISPLAY_JOURNAL('MYLIB', 'QSQJRN')) J"],
    ['SELECT * FROM TABLE("QSYS2"."ACTIVE_JOB_INFO"()) X'],
    ['SELECT * FROM TABLE(VALUES (1), (2)) AS T (N)'],
    ['SELECT * FROM FINAL TABLE (INSERT INTO MYLIB.ORDERS VALUES (1))'],
    ["SELECT * FROM JSON_TABLE('{}', '$' COLUMNS (A INT PATH '$.a')) J"],
    ["SELECT 'TABLE(DISPLAY_JOURNAL(' FROM SYSIBM.SYSDUMMY1"],
    ['SELECT UPPER(ITEMNO) FROM MYLIB.ORDERS'],
    ["select * from table(qsys2.display_journal('MYLIB', 'QSQJRN')) j"],
    ['SELECT * FROM xmltable(\'$d\' PASSING X COLUMNS A INT) T'],
  ])('finds nothing in %s', (sql) => {
    expect(unqualifiedTableFunctions(sql)).toEqual([]);
  });
});
