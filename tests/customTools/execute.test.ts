import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/connection.js', () => ({
  executeQuery: vi.fn(async () => ({ rows: [{ ORDERNO: 1001 }] })),
}));

vi.mock('../../src/db/sqlServices.js', () => ({
  parseStatement: vi.fn(async () => [{ statementType: 'QUERY' }]),
  isParseStatementMissing: vi.fn(() => false),
  PARSE_STATEMENT_UNAVAILABLE: 'QSYS2.PARSE_STATEMENT is not available on this system.',
}));

import { executeQuery } from '../../src/db/connection.js';
import { isParseStatementMissing, parseStatement } from '../../src/db/sqlServices.js';
import { executeCustomTool } from '../../src/customTools/execute.js';
import { DatabaseQueryError } from '../../src/db/sqlErrorInfo.js';
import type { StoredTool } from '../../src/customTools/loader.js';
import { resetCustomTools } from '../../src/customTools/registry.js';

const tool: StoredTool = {
  name: 'search_sales_orders',
  title: 'Search sales orders',
  toolset: 'sales',
  description: 'Open sales orders for a customer.',
  parameters: {
    customer: { type: 'string', required: true, maxLength: 10, description: 'Customer number' },
    status: { type: 'string', enum: ['O', 'C'], default: 'O' },
    include_closed: { type: 'boolean', required: false },
  },
  maxRows: 25,
  sql: 'SELECT H.ORDERNO FROM MYLIB.ORDERHDR H WHERE H.CUSTNO = ? AND H.STATUS = ? AND (? = 1 OR H.STATUS = ?)',
  placeholderNames: ['customer', 'status', 'include_closed', 'status'],
  source: 'tools.yaml',
  maskedColumns: {},
};

describe('executeCustomTool', () => {
  const previousEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    resetCustomTools();
    process.env = { ...previousEnv, QUERY_PARSE_CHECK: 'false' };
    delete process.env.QUERY_ALLOWED_SCHEMAS;
    delete process.env.QUERY_MAX_LIMIT;
    delete process.env.QUERY_DEFAULT_LIMIT;
  });

  afterEach(() => {
    process.env = previousEnv;
  });

  it('binds defaults, repeats, and booleans, and applies maxRows', async () => {
    const result = await executeCustomTool(tool, { customer: '1001' });

    expect(result.success).toBe(true);
    expect(result.limitApplied).toBe(25);
    expect(executeQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = vi.mocked(executeQuery).mock.calls[0];
    expect(sql).toContain('FETCH FIRST 25 ROWS ONLY');
    expect(params).toEqual(['1001', 'O', null, 'O']);
    expect(parseStatement).not.toHaveBeenCalled();
  });

  it('masks a plainly selected column on a YAML tool', async () => {
    vi.mocked(executeQuery).mockResolvedValueOnce({
      rows: [{ EMAIL: 'ada@example.com', PHONE: '555-0100' }],
    });
    const masked = {
      ...tool,
      sql: 'SELECT EMAIL, PHONE FROM MYLIB.CUSTOMERS',
      parameters: {},
      placeholderNames: [],
      maskedColumns: { EMAIL: 'redact' as const, PHONE: 'last4' as const },
    };

    const result = await executeCustomTool(masked, {});

    expect(result.success).toBe(true);
    expect(result.data).toEqual([{ EMAIL: '****', PHONE: '****0100' }]);
  });

  it('returns the SQLSTATE, SQLCODE, cause and recovery when the statement fails', async () => {
    vi.mocked(executeQuery).mockRejectedValueOnce(
      new DatabaseQueryError('Database query failed: [42704] [SQL0204] ORDERHDR in MYLIB type *FILE not found.', {
        sqlstate: '42704',
        sqlcode: -204,
        cause: '&1 in &2 type *&3 was not found.',
        recovery: 'Change the name and try the request again.',
      })
    );
    const result = await executeCustomTool(tool, { customer: '1001' });

    expect(result).toEqual({
      success: false,
      error: 'Database query failed: [42704] [SQL0204] ORDERHDR in MYLIB type *FILE not found.',
      sqlstate: '42704',
      sqlcode: -204,
      cause: '&1 in &2 type *&3 was not found.',
      recovery: 'Change the name and try the request again.',
    });
  });

  it('rejects a missing required parameter before querying', async () => {
    const result = await executeCustomTool(tool, {});

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/customer/i);
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('caps maxRows at QUERY_MAX_LIMIT', async () => {
    process.env.QUERY_MAX_LIMIT = '10';
    const result = await executeCustomTool(tool, { customer: '1001', include_closed: true });

    expect(result.limitApplied).toBe(10);
    const [sql, params] = vi.mocked(executeQuery).mock.calls[0];
    expect(sql).toContain('FETCH FIRST 10 ROWS ONLY');
    expect(params).toEqual(['1001', 'O', 1, 'O']);
  });

  it('rejects a library outside QUERY_ALLOWED_SCHEMAS', async () => {
    process.env.QUERY_ALLOWED_SCHEMAS = 'OTHERLIB';
    const result = await executeCustomTool(tool, { customer: '1001' }, { defaultSchema: 'MYLIB' });

    expect(result.success).toBe(false);
    expect(result.violations?.join(' ')).toContain('MYLIB.ORDERHDR');
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('parses the statement once and reuses the result', async () => {
    process.env.QUERY_PARSE_CHECK = 'true';

    const first = await executeCustomTool(tool, { customer: '1001' });
    const second = await executeCustomTool(tool, { customer: '1001' });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(parseStatement).toHaveBeenCalledTimes(1);
  });

  it('caches a parse rejection', async () => {
    process.env.QUERY_PARSE_CHECK = 'true';
    vi.mocked(parseStatement).mockResolvedValueOnce([
      { nameType: '', schema: null, name: null, columnName: null, statementType: 'DELETE' },
    ]);

    const first = await executeCustomTool(tool, { customer: '1001' });
    const second = await executeCustomTool(tool, { customer: '1001' });

    expect(first.success).toBe(false);
    expect(first.error).toMatch(/DELETE/);
    expect(second.success).toBe(false);
    expect(parseStatement).toHaveBeenCalledTimes(1);
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('caches a missing PARSE_STATEMENT error', async () => {
    process.env.QUERY_PARSE_CHECK = 'true';
    vi.mocked(parseStatement).mockRejectedValueOnce(new Error('PARSE_STATEMENT not found SQL0204'));
    vi.mocked(isParseStatementMissing).mockReturnValueOnce(true);

    const result = await executeCustomTool(tool, { customer: '1001' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/PARSE_STATEMENT is not available/);
  });

  it('checks PARSE_STATEMENT separately on each system', async () => {
    process.env.QUERY_PARSE_CHECK = 'true';
    const target = (system: string) => ({
      poolKey: 'stdio',
      system,
      config: { hostname: `${system}.example.com`, port: 446, username: 'u', password: 'p', database: '*LOCAL', schema: '', driver: 'jt400' as const, jdbcOptions: {}, odbcOptions: {} },
    });
    vi.mocked(parseStatement).mockRejectedValueOnce(new Error('PARSE_STATEMENT not found SQL0204'));
    vi.mocked(isParseStatementMissing).mockReturnValueOnce(true);

    const old = await executeCustomTool(tool, { customer: '1001' }, { target: target('old') });
    const current = await executeCustomTool(tool, { customer: '1001' }, { target: target('current') });

    expect(old.success).toBe(false);
    expect(current.success).toBe(true);
    expect(parseStatement).toHaveBeenCalledTimes(2);
  });
});
