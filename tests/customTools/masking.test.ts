import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/connection.js', () => ({
  executeQuery: vi.fn(),
  executeProcedure: vi.fn(),
}));

import { executeQuery } from '../../src/db/connection.js';
import {
  checkMaskedColumns,
  maskRows,
  maskValue,
  requireMaskedColumns,
  tokenizeSql,
} from '../../src/customTools/masking.js';
import { resetCustomTools, setCustomTools } from '../../src/customTools/registry.js';
import { executeQueryTool, prepareReadQuery } from '../../src/tools/query.js';

const query = vi.mocked(executeQuery);
const masked = new Set(['EMAIL', 'PHONE']);

function parsedRow(row: Record<string, unknown>) {
  return {
    NAME_TYPE: null,
    SCHEMA: null,
    NAME: null,
    COLUMN_NAME: null,
    SQL_STATEMENT_TYPE: 'QUERY',
    ...row,
  };
}

describe('checkMaskedColumns', () => {
  it('allows a plain selected column, a qualifier, DISTINCT, and SELECT *', () => {
    for (const sql of [
      'SELECT EMAIL, PHONE FROM MYLIB.CUSTOMERS',
      'SELECT C.EMAIL FROM MYLIB.CUSTOMERS C',
      'SELECT MYLIB.CUSTOMERS.EMAIL FROM MYLIB.CUSTOMERS',
      'SELECT DISTINCT EMAIL FROM MYLIB.CUSTOMERS',
      'SELECT * FROM MYLIB.CUSTOMERS',
    ]) {
      const check = checkMaskedColumns(sql, masked);
      expect(check.violations, sql).toEqual([]);
    }
    expect(checkMaskedColumns('SELECT * FROM MYLIB.CUSTOMERS', masked).selected.sort()).toEqual(['EMAIL', 'PHONE']);
  });

  it('rejects aliases, expressions, predicates, joins, ordering, subqueries, and UNION', () => {
    const cases: Array<[string, RegExp]> = [
      ['SELECT EMAIL AS E FROM MYLIB.CUSTOMERS', /plain selected column/],
      ['SELECT UPPER(EMAIL) FROM MYLIB.CUSTOMERS', /plain selected column/],
      ['SELECT CUSTNO FROM MYLIB.CUSTOMERS WHERE EMAIL = ?', /plain selected column/],
      ['SELECT C.CUSTNO FROM MYLIB.CUSTOMERS C JOIN MYLIB.ORDERS O ON O.EMAIL = C.EMAIL', /plain selected column/],
      ['SELECT EMAIL FROM MYLIB.CUSTOMERS ORDER BY EMAIL', /plain selected column/],
      ['SELECT EMAIL, PHONE FROM MYLIB.CUSTOMERS ORDER BY 2', /ORDER BY position/],
      ['WITH c AS (SELECT EMAIL FROM MYLIB.CUSTOMERS) SELECT CUSTNO FROM c', /plain selected column/],
      ['SELECT CUSTNO FROM MYLIB.CUSTOMERS WHERE CUSTNO IN (SELECT CUSTNO FROM MYLIB.CUSTOMERS WHERE EMAIL = ?)', /plain selected column/],
      ['SELECT EMAIL FROM MYLIB.CUSTOMERS UNION SELECT EMAIL FROM MYLIB.CUSTOMERS', /UNION/],
    ];
    for (const [sql, pattern] of cases) {
      expect(checkMaskedColumns(sql, masked).violations.join(' '), sql).toMatch(pattern);
    }
  });

  it('ignores a masked name inside a string literal or a comment', () => {
    const sql = "SELECT CUSTNO FROM MYLIB.CUSTOMERS WHERE CUSTNAME = 'EMAIL' -- EMAIL\n /* PHONE */";
    expect(checkMaskedColumns(sql, masked).violations).toEqual([]);
    const kinds = tokenizeSql(sql).filter((token) => token.text.includes('EMAIL') || token.upper === 'EMAIL');
    expect(kinds.every((token) => token.kind === 'string' || token.kind === 'comment')).toBe(true);
  });
});

describe('maskRows', () => {
  const rules = new Map<string, 'redact' | 'last4'>([
    ['EMAIL', 'redact'],
    ['PHONE', 'last4'],
  ]);

  it('redacts, keeps the last four characters, and leaves null', () => {
    const result = maskRows(
      [{ EMAIL: 'ada@example.com', phone: '555-0100', NOTE: null }],
      rules,
    );
    expect(result).toEqual({
      ok: true,
      rows: [{ EMAIL: '****', phone: '****0100', NOTE: null }],
    });
  });

  it('masks a short value entirely', () => {
    const result = maskRows([{ PHONE: '1234' }], new Map([['PHONE', 'last4']]));
    expect(result).toEqual({ ok: true, rows: [{ PHONE: '****' }] });
  });

  it('returns an empty result without requiring keys', () => {
    expect(maskRows([], rules)).toEqual({ ok: true, rows: [] });
  });

  it('fails closed when a selected masked column is missing', () => {
    const result = maskRows([{ CUSTNO: '1001' }], rules);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/EMAIL/);
    }
  });
});

describe('requireMaskedColumns and maskValue', () => {
  const rules = new Map<string, 'redact' | 'last4'>([
    ['EMAIL', 'redact'],
    ['PHONE', 'last4'],
  ]);

  it('checks masked columns against a header, case-insensitively', () => {
    expect(requireMaskedColumns(['CUSTNO', 'email', 'Phone'], rules)).toBeUndefined();
    expect(requireMaskedColumns(['CUSTNO', 'EMAIL'], rules)).toMatch(/PHONE/);
    expect(requireMaskedColumns([], new Map())).toBeUndefined();
  });

  it('masks one value and leaves null and undefined alone', () => {
    expect(maskValue('ada@example.com', 'redact')).toBe('****');
    expect(maskValue('555-0100', 'last4')).toBe('****0100');
    expect(maskValue(5550100, 'last4')).toBe('***0100');
    expect(maskValue(null, 'redact')).toBeNull();
    expect(maskValue(undefined, 'last4')).toBeUndefined();
  });
});

describe('execute_query masking', () => {
  const previousEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    resetCustomTools();
    process.env = { ...previousEnv };
    delete process.env.QUERY_PARSE_CHECK;
    delete process.env.QUERY_ALLOWED_SCHEMAS;
  });

  afterEach(() => {
    process.env = previousEnv;
    resetCustomTools();
  });

  function loadMasking(): void {
    setCustomTools({
      tools: [],
      annotations: [],
      masking: new Map([['MYLIB.CUSTOMERS', new Map([['EMAIL', 'redact']])]]),
    });
  }

  it('refuses to run when QUERY_PARSE_CHECK is off', async () => {
    process.env.QUERY_PARSE_CHECK = 'false';
    loadMasking();

    const result = await executeQueryTool({ sql: 'SELECT EMAIL FROM MYLIB.CUSTOMERS' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/QUERY_PARSE_CHECK/);
    expect(result.error).toMatch(/masking/i);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects an alias', async () => {
    loadMasking();
    query.mockResolvedValueOnce({
      rows: [parsedRow({ NAME_TYPE: 'TABLE', SCHEMA: 'MYLIB', NAME: 'CUSTOMERS' })],
    });

    const result = await executeQueryTool({ sql: 'SELECT EMAIL AS E FROM MYLIB.CUSTOMERS' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/plain selected column/);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('masks a plainly selected column', async () => {
    loadMasking();
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('PARSE_STATEMENT')) {
        return { rows: [parsedRow({ NAME_TYPE: 'TABLE', SCHEMA: 'MYLIB', NAME: 'CUSTOMERS' })] };
      }
      return { rows: [{ EMAIL: 'ada@example.com' }] };
    });

    const result = await executeQueryTool({ sql: 'SELECT EMAIL FROM MYLIB.CUSTOMERS' });

    expect(result.success).toBe(true);
    expect(result.data).toEqual([{ EMAIL: '****' }]);
  });

  it('leaves a table with no rule untouched', async () => {
    loadMasking();
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('PARSE_STATEMENT')) {
        return { rows: [parsedRow({ NAME_TYPE: 'TABLE', SCHEMA: 'MYLIB', NAME: 'ORDERS' })] };
      }
      return { rows: [{ ORDERNO: 1001 }] };
    });

    const result = await executeQueryTool({ sql: 'SELECT ORDERNO FROM MYLIB.ORDERS' });

    expect(result.success).toBe(true);
    expect(result.data).toEqual([{ ORDERNO: 1001 }]);
  });
});

describe('prepareReadQuery', () => {
  const previousEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    resetCustomTools();
    process.env = { ...previousEnv };
    delete process.env.QUERY_PARSE_CHECK;
    delete process.env.QUERY_ALLOWED_SCHEMAS;
  });

  afterEach(() => {
    process.env = previousEnv;
    resetCustomTools();
  });

  it('rejects a write without reaching the IBM i', async () => {
    const result = await prepareReadQuery({ sql: 'DELETE FROM MYLIB.ORDERS' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Security validation failed/);
      expect(result.violations?.length).toBeGreaterThan(0);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('returns the mask rules for the selected columns and runs nothing but the parse check', async () => {
    setCustomTools({
      tools: [],
      annotations: [],
      masking: new Map([['MYLIB.CUSTOMERS', new Map([['EMAIL', 'redact']])]]),
    });
    query.mockResolvedValueOnce({
      rows: [parsedRow({ NAME_TYPE: 'TABLE', SCHEMA: 'MYLIB', NAME: 'CUSTOMERS' })],
    });

    const result = await prepareReadQuery({ sql: 'SELECT CUSTNO, EMAIL FROM MYLIB.CUSTOMERS' });

    expect(result).toEqual({ ok: true, maskRules: new Map([['EMAIL', 'redact']]) });
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0][0])).toMatch(/PARSE_STATEMENT/);
  });

  it('returns no rules when the parse check is off and nothing is masked', async () => {
    process.env.QUERY_PARSE_CHECK = 'false';

    const result = await prepareReadQuery({ sql: 'SELECT ORDERNO FROM MYLIB.ORDERS' });

    expect(result).toEqual({ ok: true, maskRules: new Map() });
    expect(query).not.toHaveBeenCalled();
  });
});
