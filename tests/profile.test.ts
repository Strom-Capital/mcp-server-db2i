/**
 * Tests for profile_table. Database calls are mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/connection.js', () => ({
  executeQuery: vi.fn(),
  executeProcedure: vi.fn(),
}));

import { executeQuery } from '../src/db/connection.js';
import { buildProfileSql, MAX_COMPUTED_COLUMNS } from '../src/db/profile.js';
import { resetCustomTools, setCustomTools } from '../src/customTools/registry.js';
import { profileTableTool } from '../src/tools/profile.js';

const query = vi.mocked(executeQuery);

const COLUMNS = [
  { COLUMN_NAME: 'CUSTNO', DATA_TYPE: 'DECIMAL' },
  { COLUMN_NAME: 'EMAIL', DATA_TYPE: 'VARCHAR' },
  { COLUMN_NAME: 'NOTES', DATA_TYPE: 'CLOB' },
];

const TABLE_STATS = {
  NUMBER_ROWS: '1200',
  NUMBER_DELETED_ROWS: '3',
  DATA_SIZE: '65536',
  LAST_CHANGE_TIMESTAMP: '2026-09-20 10:00:00.000000',
  LAST_USED_TIMESTAMP: '2026-09-23 00:00:00.000000',
};

function catalog(options: { columns?: Record<string, unknown>[]; stored?: Record<string, unknown>[]; computed?: Record<string, unknown> } = {}) {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('QSYS2.SYSCOLUMNSTAT')) {
      return { rows: options.stored ?? [] };
    }
    if (sql.includes('QSYS2.SYSCOLUMNS')) {
      return { rows: options.columns ?? COLUMNS };
    }
    if (sql.includes('QSYS2.SYSTABLESTAT')) {
      return { rows: [TABLE_STATS] };
    }
    return { rows: [options.computed ?? {}] };
  });
}

describe('profile_table', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.QUERY_ALLOWED_SCHEMAS;
    resetCustomTools();
  });

  afterEach(() => {
    resetCustomTools();
  });

  describe('stored mode', () => {
    it('should return table stats and stored column stats without scanning the table', async () => {
      catalog({
        stored: [
          {
            COLUMN_NAME: 'CUSTNO',
            NUMBER_DISTINCT_VALUES: '1200',
            NUMBER_NULLS: '0',
            LOW2KEY: '1002',
            HIGH2KEY: '9998',
            STATISTIC_LAST_UPDATED: '2026-09-01 00:00:00.000000',
          },
        ],
      });

      const result = await profileTableTool({ schema: 'mylib', table: 'customers' });

      expect(result.success).toBe(true);
      expect(result.mode).toBe('stored');
      expect(result.schema).toBe('MYLIB');
      expect(result.table).toBe('CUSTOMERS');
      expect(result.table_stats).toEqual({
        number_rows: 1200,
        number_deleted_rows: 3,
        data_size: 65536,
        last_change: '2026-09-20 10:00:00.000000',
        last_used: '2026-09-23 00:00:00.000000',
      });
      expect(result.data?.[0]).toEqual({
        column_name: 'CUSTNO',
        data_type: 'DECIMAL',
        source: 'stored',
        distinct_values: 1200,
        null_count: 0,
        low: '1002',
        high: '9998',
        statistics_updated: '2026-09-01 00:00:00.000000',
      });
      expect(result.data?.[1]).toMatchObject({ column_name: 'EMAIL', source: 'none', distinct_values: null });
      expect(result.sql).toBeUndefined();
      expect(query.mock.calls.every(([sql]) => sql.includes('QSYS2.'))).toBe(true);
    });

    it('should keep the most recent statistic when a column has two', async () => {
      catalog({
        stored: [
          { COLUMN_NAME: 'CUSTNO', NUMBER_DISTINCT_VALUES: '1200', NUMBER_NULLS: '0' },
          { COLUMN_NAME: 'CUSTNO', NUMBER_DISTINCT_VALUES: '900', NUMBER_NULLS: '0' },
        ],
      });

      const result = await profileTableTool({ schema: 'MYLIB', table: 'CUSTOMERS', columns: ['custno'] });

      expect(result.count).toBe(1);
      expect(result.data?.[0]?.distinct_values).toBe(1200);
    });
  });

  describe('compute mode', () => {
    it('should build one aggregate over quoted catalog names', () => {
      const sql = buildProfileSql(
        'MYLIB',
        'ORDERS',
        [
          { column_name: 'ORDERNO', data_type: 'DECIMAL' },
          { column_name: 'A"B', data_type: 'CHAR' },
          { column_name: 'NOTES', data_type: 'CLOB' },
        ],
        new Set()
      );

      expect(sql).toBe(
        'SELECT COUNT(*) AS PROFILE_ROWS, ' +
          'COUNT(*) - COUNT("ORDERNO") AS C0_NULLS, COUNT(DISTINCT "ORDERNO") AS C0_DISTINCT, MIN("ORDERNO") AS C0_MIN, MAX("ORDERNO") AS C0_MAX, ' +
          'COUNT(*) - COUNT("A""B") AS C1_NULLS, COUNT(DISTINCT "A""B") AS C1_DISTINCT, MIN("A""B") AS C1_MIN, MAX("A""B") AS C1_MAX, ' +
          'COUNT(*) - COUNT("NOTES") AS C2_NULLS ' +
          'FROM "MYLIB"."ORDERS"'
      );
    });

    it('should return computed numbers and the SQL it ran', async () => {
      catalog({
        computed: {
          PROFILE_ROWS: '1197',
          C0_NULLS: '0',
          C0_DISTINCT: '1197',
          C0_MIN: '1001',
          C0_MAX: '9999',
          C1_NULLS: '12',
          C1_DISTINCT: '1180',
          C2_NULLS: '400',
        },
      });

      const result = await profileTableTool({ schema: 'MYLIB', table: 'CUSTOMERS', compute: true });

      expect(result.mode).toBe('computed');
      expect(result.computed_rows).toBe(1197);
      expect(result.sql).toContain('FROM "MYLIB"."CUSTOMERS"');
      expect(result.data?.[0]).toEqual({
        column_name: 'CUSTNO',
        data_type: 'DECIMAL',
        source: 'computed',
        distinct_values: 1197,
        null_count: 0,
        low: '1001',
        high: '9999',
      });
      expect(result.data?.[2]).toMatchObject({ column_name: 'NOTES', null_count: 400, distinct_values: null, low: null });
      expect(query.mock.calls.some(([sql]) => sql.includes('SYSCOLUMNSTAT'))).toBe(false);
    });

    it(`should scan at most ${MAX_COMPUTED_COLUMNS} columns and report truncation`, async () => {
      const wide = Array.from({ length: MAX_COMPUTED_COLUMNS + 5 }, (_, index) => ({
        COLUMN_NAME: `COL${index}`,
        DATA_TYPE: 'INTEGER',
      }));
      catalog({ columns: wide });

      const result = await profileTableTool({ schema: 'MYLIB', table: 'ORDERS', compute: true });

      expect(result.count).toBe(MAX_COMPUTED_COLUMNS);
      expect(result.truncated).toBe(true);
      expect(result.sql).toContain(`C${MAX_COMPUTED_COLUMNS - 1}_NULLS`);
      expect(result.sql).not.toContain(`C${MAX_COMPUTED_COLUMNS}_NULLS`);
    });
  });

  describe('masking', () => {
    beforeEach(() => {
      setCustomTools({
        tools: [],
        annotations: [],
        masking: new Map([['MYLIB.CUSTOMERS', new Map([['EMAIL', 'redact' as const]])]]),
      });
    });

    it('should never select MIN or MAX of a masked column', async () => {
      catalog({ computed: { PROFILE_ROWS: '10', C1_NULLS: '1', C1_DISTINCT: '9' } });

      const result = await profileTableTool({ schema: 'MYLIB', table: 'CUSTOMERS', compute: true });

      expect(result.sql).not.toContain('MIN("EMAIL")');
      expect(result.sql).not.toContain('MAX("EMAIL")');
      expect(result.sql).toContain('COUNT(DISTINCT "EMAIL")');
      expect(result.data?.[1]).toMatchObject({
        column_name: 'EMAIL',
        masked: 'redact',
        distinct_values: 9,
        null_count: 1,
        low: null,
        high: null,
      });
    });

    it('should drop stored low and high values of a masked column', async () => {
      catalog({
        stored: [{ COLUMN_NAME: 'EMAIL', NUMBER_DISTINCT_VALUES: '9', NUMBER_NULLS: '1', LOW2KEY: 'a@example.com', HIGH2KEY: 'z@example.com' }],
      });

      const result = await profileTableTool({ schema: 'MYLIB', table: 'CUSTOMERS' });

      expect(result.data?.[1]).toMatchObject({ masked: 'redact', distinct_values: 9, low: null, high: null });
      expect(JSON.stringify(result)).not.toContain('example.com');
    });
  });

  describe('errors', () => {
    it('should reject a schema outside the allowlist without querying', async () => {
      process.env.QUERY_ALLOWED_SCHEMAS = 'MYLIB';

      const result = await profileTableTool({ schema: 'OTHERLIB', table: 'ORDERS' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('OTHERLIB');
      expect(query).not.toHaveBeenCalled();
    });

    it('should report a table that is not in the catalog', async () => {
      catalog({ columns: [] });

      const result = await profileTableTool({ schema: 'MYLIB', table: 'NOSUCH' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Table MYLIB.NOSUCH was not found.');
    });

    it('should reject an unknown column before scanning', async () => {
      catalog();

      const result = await profileTableTool({ schema: 'MYLIB', table: 'CUSTOMERS', compute: true, columns: ['CUSTNO', 'ITEMNO'] });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown column(s): ITEMNO.');
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('should require a schema when there is no default', async () => {
      const result = await profileTableTool({ table: 'ORDERS' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Schema is required');
    });
  });
});
