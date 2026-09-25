/**
 * Tests for index_advice. Database calls are mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/connection.js', () => ({
  executeQuery: vi.fn(),
  executeProcedure: vi.fn(),
}));

import { executeQuery } from '../src/db/connection.js';
import { parseSince, splitKeyColumns } from '../src/db/indexAdvice.js';
import { indexAdviceTool } from '../src/tools/indexAdvice.js';

const query = vi.mocked(executeQuery);

function adviceRow(row: Record<string, unknown>) {
  return {
    TABLE_SCHEMA: 'MYLIB',
    TABLE_NAME: 'ORDERS',
    KEY_COLUMNS_ADVISED: 'ORDERNO',
    INDEX_TYPE: 'RADIX         ',
    TIMES_ADVISED: 10,
    MTI_USED: 0,
    MTI_CREATED: 0,
    LAST_ADVISED: '2026-09-01 08:00:00.000000',
    LAST_MTI_USED: null,
    REASONS: 'I1',
    ROWS_MERGED: 1,
    ...row,
  };
}

describe('index_advice', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.QUERY_ALLOWED_SCHEMAS;
    delete process.env.QUERY_MAX_LIMIT;
    delete process.env.QUERY_DEFAULT_LIMIT;
  });

  it('should group advice in SQL and normalize each row', async () => {
    query.mockResolvedValueOnce({
      rows: [
        adviceRow({
          KEY_COLUMNS_ADVISED: 'ORDERNO, LINENO DESC',
          TIMES_ADVISED: '9007199',
          MTI_USED: '812345',
          MTI_CREATED: '7',
          LAST_MTI_USED: '2026-09-02 09:30:00.000000',
          REASONS: 'I6,I1,I1',
          ROWS_MERGED: '3',
        }),
        adviceRow({ TABLE_NAME: 'ORDERHDR', INDEX_TYPE: 'ENCODED VECTOR', REASONS: 'I2' }),
      ],
    });

    const result = await indexAdviceTool({ schema: 'mylib' });

    expect(result.success).toBe(true);
    expect(result.schema).toBe('MYLIB');
    expect(result.count).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.data?.[0]).toEqual({
      schema: 'MYLIB',
      table: 'ORDERS',
      key_columns: ['ORDERNO', 'LINENO DESC'],
      index_type: 'RADIX',
      times_advised: 9007199,
      mti_used: 812345,
      mti_created: 7,
      last_advised: '2026-09-01 08:00:00.000000',
      last_mti_used: '2026-09-02 09:30:00.000000',
      reasons: [
        { code: 'I1', description: 'Row selection' },
        { code: 'I6', description: 'Source of statistics' },
      ],
      rows_merged: 3,
    });
    expect(result.data?.[1]).toMatchObject({ index_type: 'ENCODED VECTOR', reasons: [{ code: 'I2', description: 'Ordering or grouping' }] });

    const [sql, params] = query.mock.calls[0] ?? [];
    expect(sql).toContain('FROM QSYS2.SYSIXADV');
    expect(sql).toContain('(TABLE_SCHEMA = ? OR SYSTEM_TABLE_SCHEMA = ?)');
    expect(sql).toContain('GROUP BY TABLE_SCHEMA, TABLE_NAME, KEY_COLUMNS_ADVISED, INDEX_TYPE');
    expect(sql).toContain('LISTAGG(REASON_ADVISED');
    expect(sql).toContain('ORDER BY MTI_USED DESC, TIMES_ADVISED DESC');
    expect(sql).not.toContain('LAST_ADVISED >=');
    expect(params).toEqual(['MYLIB', 'MYLIB']);
  });

  it('should keep an unknown reason code without a description', async () => {
    query.mockResolvedValueOnce({ rows: [adviceRow({ REASONS: 'I1,Z9' })] });

    const result = await indexAdviceTool({ schema: 'MYLIB' });

    expect(result.data?.[0]?.reasons).toEqual([
      { code: 'I1', description: 'Row selection' },
      { code: 'Z9', description: null },
    ]);
  });

  it('should filter by table and since, and pass since as local timestamp text', async () => {
    query.mockResolvedValueOnce({ rows: [adviceRow({})] });

    const result = await indexAdviceTool({ schema: 'MYLIB', table: ' orders ', since: '2026-09-01T08:15' });

    expect(result.success).toBe(true);
    expect(result.table).toBe('ORDERS');
    expect(result.since).toBe('2026-09-01 08:15:00.000000');
    const [sql, params] = query.mock.calls[0] ?? [];
    expect(sql).toContain('(TABLE_NAME = ? OR SYSTEM_TABLE_NAME = ?)');
    expect(sql).toContain('LAST_ADVISED >= CAST(? AS TIMESTAMP)');
    expect(params).toEqual(['MYLIB', 'MYLIB', 'ORDERS', 'ORDERS', '2026-09-01 08:15:00.000000']);
  });

  it('should reject a bad since value without querying', async () => {
    for (const since of ['yesterday', '2026-02-30', '2026-09-01T00:00:00Z', '2026-09-01 08:00:00+02:00', '2026-09-01 24:00']) {
      const result = await indexAdviceTool({ schema: 'MYLIB', since });
      expect(result.success, since).toBe(false);
      expect(result.error, since).toContain('since');
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('should use the default schema and report truncation', async () => {
    process.env.QUERY_MAX_LIMIT = '1';
    query.mockResolvedValueOnce({ rows: [adviceRow({}), adviceRow({ TABLE_NAME: 'ORDERHDR' })] });

    const result = await indexAdviceTool({ defaultSchema: 'MYLIB', limit: 50 });

    expect(result.count).toBe(1);
    expect(result.truncated).toBe(true);
    expect(query.mock.calls[0]?.[0]).toContain('FETCH FIRST 2 ROWS ONLY');
    expect(query.mock.calls[0]?.[1]).toEqual(['MYLIB', 'MYLIB']);
  });

  it('should require a schema when there is no default', async () => {
    const result = await indexAdviceTool({});

    expect(result.success).toBe(false);
    expect(result.error).toContain('Schema is required');
    expect(query).not.toHaveBeenCalled();
  });

  it('should reject a schema outside the allowlist without querying', async () => {
    process.env.QUERY_ALLOWED_SCHEMAS = 'MYLIB';

    const result = await indexAdviceTool({ schema: 'OTHERLIB' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('OTHERLIB');
    expect(query).not.toHaveBeenCalled();
  });

  it('should read an allowed schema without QSYS2 in the allowlist', async () => {
    process.env.QUERY_ALLOWED_SCHEMAS = 'MYLIB';
    query.mockResolvedValueOnce({ rows: [adviceRow({})] });

    const result = await indexAdviceTool({ schema: 'MYLIB' });

    expect(result.success).toBe(true);
    expect(query.mock.calls[0]?.[1]).toEqual(['MYLIB', 'MYLIB']);
  });

  it('should report a library that does not exist', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });

    const result = await indexAdviceTool({ schema: 'nosuchlib' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Library NOSUCHLIB was not found.');
    expect(query.mock.calls[1]?.[0]).toContain('QSYS2.SYSSCHEMAS');
  });

  it('should return an empty list for a library with no advice', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ FOUND: 1 }] });

    const result = await indexAdviceTool({ schema: 'MYLIB' });

    expect(result).toMatchObject({ success: true, count: 0, data: [], truncated: false });
  });

  it('should return SQL error details from Db2', async () => {
    query.mockRejectedValueOnce(Object.assign(new Error('[SQL0551] Not authorized to object SYSIXADV in QSYS2 type *FILE.'), {
      sqlstate: '42501',
      sqlcode: -551,
    }));

    const result = await indexAdviceTool({ schema: 'MYLIB' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('SQL0551');
  });
});

describe('splitKeyColumns', () => {
  it('should split on commas and keep DESC and ASC', () => {
    expect(splitKeyColumns('ORDERNO, LINENO DESC,ITEMNO ASC')).toEqual(['ORDERNO', 'LINENO DESC', 'ITEMNO ASC']);
  });

  it('should keep commas and spaces inside quoted names', () => {
    expect(splitKeyColumns('"Order, No" DESC, "Line ""A""", ITEMNO')).toEqual(['"Order, No" DESC', '"Line ""A"""', 'ITEMNO']);
  });

  it('should return no keys for an empty value', () => {
    expect(splitKeyColumns('  ')).toEqual([]);
  });
});

describe('parseSince', () => {
  it('should accept a date, a minute, and a fraction', () => {
    expect(parseSince('2026-01-31')).toBe('2026-01-31 00:00:00.000000');
    expect(parseSince(' 2026-01-31 08:05 ')).toBe('2026-01-31 08:05:00.000000');
    expect(parseSince('2026-01-31T08:05:09.12')).toBe('2026-01-31 08:05:09.120000');
  });
});
