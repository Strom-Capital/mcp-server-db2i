/**
 * Tests for search_columns and search_tables.
 * Database calls are mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/connection.js', () => ({
  executeQuery: vi.fn(),
}));

import { executeQuery } from '../src/db/connection.js';
import { resetCustomTools, setCustomTools } from '../src/customTools/registry.js';
import { searchColumnsTool, searchTablesTool } from '../src/tools/metadata.js';

const query = vi.mocked(executeQuery);

function sqlOf(): string {
  const sql = query.mock.calls[0]?.[0];
  expect(sql).toEqual(expect.any(String));
  return sql as string;
}

function paramsOf(): unknown[] {
  return query.mock.calls[0]?.[1] as unknown[];
}

describe('catalog search', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    resetCustomTools();
    process.env = { ...originalEnv };
    delete process.env.QUERY_ALLOWED_SCHEMAS;
    delete process.env.QUERY_DEFAULT_LIMIT;
    delete process.env.QUERY_MAX_LIMIT;
  });

  describe('search_columns', () => {
    it('matches column name, system name, and text', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const result = await searchColumnsTool({ filter: 'ITEM*' });

      expect(result.success).toBe(true);
      const sql = sqlOf();
      expect(sql).toContain('FROM QSYS2.SYSCOLUMNS');
      expect(sql).toContain('COLUMN_NAME LIKE ?');
      expect(sql).toContain('SYSTEM_COLUMN_NAME LIKE ?');
      expect(sql).toContain('UPPER(COLUMN_TEXT) LIKE ?');
      expect(paramsOf().slice(0, 3)).toEqual(['ITEM%', 'ITEM%', 'ITEM%']);
    });

    it('limits an allowlist search to those libraries', async () => {
      process.env.QUERY_ALLOWED_SCHEMAS = 'mylib,otherlib';
      query.mockResolvedValueOnce({ rows: [] });

      await searchColumnsTool({ filter: 'ITEMNO' });

      const sql = sqlOf();
      expect(sql).toContain('TABLE_SCHEMA IN (?, ?)');
      expect(sql).not.toContain("NOT LIKE 'Q%'");
      expect(paramsOf()).toEqual(['%ITEMNO%', '%ITEMNO%', '%ITEMNO%', 'MYLIB', 'OTHERLIB']);
    });

    it('rejects a schema outside the allowlist', async () => {
      process.env.QUERY_ALLOWED_SCHEMAS = 'MYLIB';

      const result = await searchColumnsTool({ filter: 'ITEMNO', schema: 'outsidelib' });

      expect(result).toEqual({
        success: false,
        error: 'Schema OUTSIDELIB is not in QUERY_ALLOWED_SCHEMAS (MYLIB).',
      });
      expect(query).not.toHaveBeenCalled();
    });

    it('skips system libraries unless include_system is set', async () => {
      query.mockResolvedValue({ rows: [] });

      await searchColumnsTool({ filter: 'ITEMNO' });
      expect(sqlOf()).toContain("TABLE_SCHEMA NOT LIKE 'Q%'");
      expect(sqlOf()).toContain("TABLE_SCHEMA NOT LIKE 'SYS%'");

      vi.clearAllMocks();
      await searchColumnsTool({ filter: 'ITEMNO', includeSystem: true });
      expect(sqlOf()).not.toContain("NOT LIKE 'Q%'");
    });

    it('searches one library when schema is set and there is no allowlist', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      await searchColumnsTool({ filter: 'ITEMNO', schema: 'mylib' });

      expect(sqlOf()).toContain('TABLE_SCHEMA IN (?)');
      expect(sqlOf()).not.toContain("NOT LIKE 'Q%'");
      expect(paramsOf()).toEqual(['%ITEMNO%', '%ITEMNO%', '%ITEMNO%', 'MYLIB']);
    });

    it('rejects a wildcard-only filter', async () => {
      const result = await searchColumnsTool({ filter: '*' });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/only \* or %/);
      }
      expect(query).not.toHaveBeenCalled();
    });

    it('caps the requested limit and reports truncation', async () => {
      process.env.QUERY_MAX_LIMIT = '5';
      query.mockResolvedValueOnce({
        rows: Array.from({ length: 6 }, (_, index) => ({
          TABLE_SCHEMA: 'MYLIB',
          TABLE_NAME: 'ORDERS',
          COLUMN_NAME: `C${index}`,
          SYSTEM_COLUMN_NAME: `C${index}`,
          DATA_TYPE: 'CHAR',
          LENGTH: 10,
          NUMERIC_SCALE: 0,
          COLUMN_TEXT: null,
        })),
      });

      const result = await searchColumnsTool({ filter: 'C*', limit: 100 });

      expect(sqlOf()).toContain('FETCH FIRST 6 ROWS ONLY');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.count).toBe(5);
        expect(result.truncated).toBe(true);
      }
    });

    it('adds the YAML column description', async () => {
      setCustomTools({
        tools: [],
        masking: new Map(),
        annotations: [{
          table: 'MYLIB.ORDERS',
          description: 'Sales order lines',
          columns: { ITEMNO: 'Item on the line' },
          relations: [],
        }],
      });
      query.mockResolvedValueOnce({
        rows: [{
          TABLE_SCHEMA: 'MYLIB',
          TABLE_NAME: 'ORDERS',
          COLUMN_NAME: 'ITEMNO',
          SYSTEM_COLUMN_NAME: 'ITEMNO',
          DATA_TYPE: 'CHAR',
          LENGTH: 15,
          NUMERIC_SCALE: 0,
          COLUMN_TEXT: 'Item',
        }],
      });

      const result = await searchColumnsTool({ filter: 'ITEMNO', schema: 'MYLIB' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data[0]?.business_description).toBe('Item on the line');
        expect(result.truncated).toBe(false);
      }
    });
  });

  describe('search_tables', () => {
    it('matches table name, system name, and text inside the allowlist', async () => {
      process.env.QUERY_ALLOWED_SCHEMAS = 'MYLIB';
      query.mockResolvedValueOnce({
        rows: [{
          TABLE_SCHEMA: 'MYLIB',
          TABLE_NAME: 'ORDERS',
          TABLE_TYPE: 'T',
          TABLE_TEXT: 'Order lines',
        }],
      });
      setCustomTools({
        tools: [],
        masking: new Map(),
        annotations: [{
          table: 'MYLIB.ORDERS',
          description: 'Sales order lines',
          columns: {},
          relations: [],
        }],
      });

      const result = await searchTablesTool({ filter: '*ORDER*', schema: 'MYLIB' });

      const sql = sqlOf();
      expect(sql).toContain('FROM QSYS2.SYSTABLES');
      expect(sql).toContain('TABLE_NAME LIKE ?');
      expect(sql).toContain('SYSTEM_TABLE_NAME LIKE ?');
      expect(sql).toContain('UPPER(TABLE_TEXT) LIKE ?');
      expect(paramsOf()).toEqual(['%ORDER%', '%ORDER%', '%ORDER%', 'MYLIB']);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data[0]).toMatchObject({
          schema_name: 'MYLIB',
          table_name: 'ORDERS',
          table_text: 'Order lines',
          business_description: 'Sales order lines',
        });
      }
    });
  });
});
