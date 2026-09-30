import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/connection.js', () => ({
  executeQuery: vi.fn(),
  executeProcedure: vi.fn(),
}));

import { executeQuery } from '../src/db/connection.js';
import { DatabaseQueryError } from '../src/db/sqlErrorInfo.js';
import { executeQueryTool } from '../src/tools/query.js';
import { isUnknownColumnError, unknownColumnHint, withUnknownColumnHint } from '../src/tools/unknownColumnHint.js';
import { referencedTables } from '../src/utils/security/schemaAllowlist.js';

const query = vi.mocked(executeQuery);

const GENERIC =
  'Check the column names with describe_table for the tables in the query before trying again, and put text values in single quotes, not double quotes.';

describe('referencedTables', () => {
  it('lists qualified and unqualified tables once, in order, without CTE names', () => {
    expect(referencedTables(
      'WITH T AS (SELECT ORDERNO FROM MYLIB.ORDERS) ' +
        'SELECT H.ORDERNO FROM MYLIB.ORDERHDR H JOIN T ON T.ORDERNO = H.ORDERNO JOIN customers C ON 1 = 1 ' +
        'WHERE H.ORDERNO IN (SELECT ORDERNO FROM MYLIB.ORDERS)'
    ).sort()).toEqual(['CUSTOMERS', 'MYLIB.ORDERHDR', 'MYLIB.ORDERS']);
  });

  it('returns nothing for a statement the parser cannot read', () => {
    expect(referencedTables('SELECT FROM WHERE')).toEqual([]);
  });
});

describe('isUnknownColumnError', () => {
  it('matches SQLCODE -206, SQLSTATE 42703 or 42S22, or the SQL0206 message ID', () => {
    expect(isUnknownColumnError({ sqlcode: -206 }, '')).toBe(true);
    expect(isUnknownColumnError({ sqlstate: '42703' }, '')).toBe(true);
    expect(isUnknownColumnError({ sqlstate: '42s22' }, '')).toBe(true);
    expect(isUnknownColumnError({}, 'Database query failed: [SQL0206] Column or global variable X not found.')).toBe(true);
  });

  it('does not match other errors', () => {
    expect(isUnknownColumnError({ sqlstate: '42704', sqlcode: -204 }, 'SQL0204 ORDERS in MYLIB type *FILE not found.')).toBe(false);
    expect(isUnknownColumnError({}, 'Connection refused')).toBe(false);
  });
});

describe('unknownColumnHint', () => {
  it('names the tables the statement reads', () => {
    expect(unknownColumnHint('SELECT H.ORDERNO FROM MYLIB.ORDERHDR H JOIN MYLIB.ORDERS L ON L.ORDERNO = H.ORDERNO')).toBe(
      'Check the column names with describe_table for MYLIB.ORDERHDR, MYLIB.ORDERS before trying again, and put text values in single quotes, not double quotes.'
    );
  });

  it('falls back to a generic hint when the statement cannot be parsed', () => {
    expect(unknownColumnHint('SELECT FROM WHERE')).toBe(GENERIC);
  });

  it('leaves out describe_table when it is not available', () => {
    expect(unknownColumnHint('SELECT ITEMNO FROM MYLIB.ORDERS', false)).toBe(
      'Check the column names for MYLIB.ORDERS before trying again, and put text values in single quotes, not double quotes.'
    );
  });

  it('names at most five tables', () => {
    const sql = `SELECT 1 FROM ${['A', 'B', 'C', 'D', 'E', 'F'].map((name) => `MYLIB.${name}`).join(', ')}`;
    expect(unknownColumnHint(sql)).toContain('for MYLIB.A, MYLIB.B, MYLIB.C, MYLIB.D, MYLIB.E before');
  });
});

describe('withUnknownColumnHint', () => {
  it('puts the hint before the recovery Db2 gave', () => {
    expect(withUnknownColumnHint({ sqlcode: -206, recovery: 'Correct the column name.' }, '', 'SELECT ITEMNO FROM MYLIB.ORDERS')).toEqual({
      sqlcode: -206,
      recovery:
        'Check the column names with describe_table for MYLIB.ORDERS before trying again, and put text values in single quotes, not double quotes. Correct the column name.',
    });
  });

  it('returns other errors unchanged', () => {
    const fields = { sqlstate: '42704', sqlcode: -204, recovery: 'R' };
    expect(withUnknownColumnHint(fields, '', 'SELECT ITEMNO FROM MYLIB.ORDERS')).toBe(fields);
  });
});

describe('execute_query with an unknown column', () => {
  const previousEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...previousEnv, QUERY_PARSE_CHECK: 'false' };
    delete process.env.QUERY_ALLOWED_SCHEMAS;
  });

  afterEach(() => {
    process.env = previousEnv;
  });

  it('adds the hint to recovery for an ODBC SQLSTATE 42S22 error', async () => {
    query.mockRejectedValueOnce(new DatabaseQueryError(
      'Database query failed: [42S22] [IBM][System i Access ODBC Driver][DB2 for i5/OS]SQL0206 - Column or global variable ITEMNUM not found.',
      { sqlstate: '42S22', sqlcode: -206 },
    ));

    const result = await executeQueryTool({ sql: 'SELECT ITEMNUM FROM MYLIB.ORDERS WHERE ORDERNO = 1001' });

    expect(result.success).toBe(false);
    expect(result.sqlstate).toBe('42S22');
    expect(result.sqlcode).toBe(-206);
    expect(result.recovery).toBe(
      'Check the column names with describe_table for MYLIB.ORDERS before trying again, and put text values in single quotes, not double quotes.'
    );
  });

  it('adds the hint for the native SQLSTATE 42703 and keeps the Db2 recovery', async () => {
    query.mockRejectedValueOnce(new DatabaseQueryError(
      'Database query failed: [SQL0206] Column or global variable ITEMNUM not found.',
      { sqlstate: '42703', sqlcode: -206, cause: '&1 is not a column of table &2.', recovery: 'Correct the column name.' },
    ));

    const result = await executeQueryTool({ sql: 'SELECT ITEMNUM FROM ORDERS', describeTable: false });

    expect(result.cause).toBe('&1 is not a column of table &2.');
    expect(result.recovery).toBe(
      'Check the column names for ORDERS before trying again, and put text values in single quotes, not double quotes. Correct the column name.'
    );
  });

  it('leaves other database errors as Db2 reported them', async () => {
    query.mockRejectedValueOnce(new DatabaseQueryError(
      'Database query failed: [42704] [SQL0204] ORDERS in MYLIB type *FILE not found.',
      { sqlstate: '42704', sqlcode: -204, recovery: 'Change the name.' },
    ));

    const result = await executeQueryTool({ sql: 'SELECT ORDERNO FROM MYLIB.ORDERS' });

    expect(result.recovery).toBe('Change the name.');
  });
});
