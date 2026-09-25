/**
 * Tests for SQL service tools and the execute_query parse check.
 * Database calls are mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/connection.js', () => ({
  executeQuery: vi.fn(),
  executeProcedure: vi.fn(),
}));

import { executeProcedure, executeQuery } from '../src/db/connection.js';
import {
  clearRoutineCache,
  clearServicesCache,
  generateObjectDdl,
  SERVICES_CACHE_TTL_MS,
} from '../src/db/sqlServices.js';
import type { DbTarget } from '../src/systems.js';
import { executeQueryTool } from '../src/tools/query.js';
import {
  getJournalInfoTool,
  getObjectDdlTool,
  getRelatedObjectsTool,
  searchIbmiServicesTool,
  validateQueryTool,
} from '../src/tools/sqlServices.js';

const query = vi.mocked(executeQuery);
const procedure = vi.mocked(executeProcedure);

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

describe('SQL service tools', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    clearRoutineCache();
    clearServicesCache();
    process.env = { ...originalEnv };
    delete process.env.QUERY_ALLOWED_SCHEMAS;
    process.env.QUERY_PARSE_CHECK = 'false';
  });

  describe('validate_query', () => {
    it('should report a statement that does not parse', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const result = await validateQueryTool({ sql: 'SELECT FROM' });

      expect(result.success).toBe(true);
      expect(result.valid).toBe(false);
      expect(result.violations).toContain('The statement could not be parsed.');
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('should report a table that is not in the catalog', async () => {
      query.mockImplementation(async (sql: string) => {
        if (sql.includes('PARSE_STATEMENT')) {
          return {
            rows: [parsedRow({ NAME_TYPE: 'TABLE', SCHEMA: 'MYLIB', NAME: 'ORDERS' })],
          };
        }
        return { rows: [] };
      });

      const result = await validateQueryTool({
        sql: 'SELECT ORDERNO FROM MYLIB.ORDERS WHERE ORDERNO = 1001',
      });

      expect(result.valid).toBe(false);
      expect(result.missingTables).toEqual(['MYLIB.ORDERS']);
    });

    it('should report a column that is not on the named tables', async () => {
      query.mockImplementation(async (sql: string) => {
        if (sql.includes('PARSE_STATEMENT')) {
          return {
            rows: [
              parsedRow({ NAME_TYPE: 'TABLE', SCHEMA: 'MYLIB', NAME: 'ORDERS' }),
              parsedRow({ NAME_TYPE: 'COLUMN', COLUMN_NAME: 'ORDERNO' }),
            ],
          };
        }
        if (sql.includes('SYSTABLES')) {
          return { rows: [{ TABLE_SCHEMA: 'MYLIB', TABLE_NAME: 'ORDERS' }] };
        }
        return { rows: [] };
      });

      const result = await validateQueryTool({ sql: 'SELECT ORDERNO FROM MYLIB.ORDERS' });

      expect(result.valid).toBe(false);
      expect(result.missingTables).toEqual([]);
      expect(result.missingColumns).toEqual(['ORDERNO']);
    });

    it('should report an unqualified table when no default schema is set', async () => {
      query.mockResolvedValueOnce({
        rows: [parsedRow({ NAME_TYPE: 'TABLE', NAME: 'ORDERS' })],
      });

      const result = await validateQueryTool({ sql: 'SELECT * FROM ORDERS' });

      expect(result.valid).toBe(false);
      expect(result.violations?.join(' ')).toContain('no default schema');
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('should resolve an unqualified table to the default schema', async () => {
      query.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('PARSE_STATEMENT')) {
          return { rows: [parsedRow({ NAME_TYPE: 'TABLE', NAME: 'ORDERS' })] };
        }
        expect(sql).toContain('IN (VALUES (?, ?))');
        expect(params).toEqual(['MYLIB', 'ORDERS']);
        return { rows: [{ TABLE_SCHEMA: 'MYLIB', TABLE_NAME: 'ORDERS' }] };
      });

      const result = await validateQueryTool({
        sql: 'SELECT * FROM ORDERS',
        defaultSchema: 'MYLIB',
      });

      expect(result.valid).toBe(true);
      expect(result.missingTables).toEqual([]);
    });

    it('should skip unqualified built-in functions and flag a missing qualified routine', async () => {
      query.mockImplementation(async (sql: string) => {
        if (sql.includes('PARSE_STATEMENT')) {
          return {
            rows: [
              parsedRow({ NAME_TYPE: 'FUNCTION', NAME: 'UPPER' }),
              parsedRow({ NAME_TYPE: 'FUNCTION', SCHEMA: 'SYSIBM', NAME: 'NOT_A_FUNCTION' }),
              parsedRow({ NAME_TYPE: 'TABLE', SCHEMA: 'SYSIBM', NAME: 'SYSDUMMY1' }),
            ],
          };
        }
        if (sql.includes('SYSTABLES')) {
          return { rows: [{ TABLE_SCHEMA: 'SYSIBM', TABLE_NAME: 'SYSDUMMY1' }] };
        }
        if (sql.includes('SYSROUTINES')) {
          return { rows: [] };
        }
        return { rows: [] };
      });

      const result = await validateQueryTool({
        sql: 'SELECT UPPER(IBMREQD), SYSIBM.NOT_A_FUNCTION(1) FROM SYSIBM.SYSDUMMY1',
      });

      expect(result.missingRoutines).toEqual(['SYSIBM.NOT_A_FUNCTION']);
      expect(result.missingTables).toEqual([]);
    });

    it('should report a schema outside the allowlist and not look it up', async () => {
      process.env.QUERY_ALLOWED_SCHEMAS = 'MYLIB';
      query.mockResolvedValue({
        rows: [parsedRow({ NAME_TYPE: 'TABLE', SCHEMA: 'OTHERLIB', NAME: 'ORDERS' })],
      });

      const result = await validateQueryTool({ sql: 'SELECT * FROM OTHERLIB.ORDERS' });

      expect(result.valid).toBe(false);
      expect(result.violations?.join(' ')).toContain('OTHERLIB.ORDERS');
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0]?.[0]).toContain('PARSE_STATEMENT');
    });
  });

  describe('get_object_ddl', () => {
    it('should join GENERATE_SQL source lines in sequence order', async () => {
      procedure.mockResolvedValueOnce({
        rows: [
          { SRCSEQ: '2.00', SRCDTA: '  IBMREQD CHAR(1)   ' },
          { SRCSEQ: '1.00', SRCDTA: 'CREATE TABLE SYSIBM.SYSDUMMY1 (' },
        ],
      });

      const ddl = await generateObjectDdl({
        schema: 'sysibm',
        objectName: 'SYSDUMMY1',
        objectType: 'TABLE',
      });

      expect(ddl).toBe('CREATE TABLE SYSIBM.SYSDUMMY1 (\n  IBMREQD CHAR(1)');
      expect(procedure).toHaveBeenCalledWith(
        expect.stringContaining("DATABASE_OBJECT_NAME => 'SYSDUMMY1'"),
        [],
        undefined
      );
    });

    it('should reject a schema outside the allowlist before calling GENERATE_SQL', async () => {
      process.env.QUERY_ALLOWED_SCHEMAS = 'MYLIB';

      const result = await getObjectDdlTool({
        schema: 'OTHERLIB',
        object: 'ORDERS',
        type: 'TABLE',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('OTHERLIB');
      expect(procedure).not.toHaveBeenCalled();
    });

    it('should reject a name that is not a plain identifier', async () => {
      const result = await getObjectDdlTool({
        schema: 'MYLIB',
        object: "ORDERS'; CALL QSYS2.GENERATE_SQL('X', 'Y', 'TABLE')--",
        type: 'TABLE',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('unquoted IBM i name');
      expect(procedure).not.toHaveBeenCalled();
    });
  });

  describe('get_related_objects', () => {
    it('should explain when RELATED_OBJECTS is not installed', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const result = await getRelatedObjectsTool({ schema: 'MYLIB', table: 'ORDERS' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('7.3 Technology Refresh 9');
    });

    it('should drop dependents outside the allowlist', async () => {
      process.env.QUERY_ALLOWED_SCHEMAS = 'MYLIB';
      query.mockImplementation(async (sql: string) => {
        if (sql.includes('SYSROUTINES')) {
          return { rows: [{ ROUTINE_NAME: 'RELATED_OBJECTS' }] };
        }
        return {
          rows: [
            {
              SQL_OBJECT_TYPE: 'INDEX',
              SCHEMA_NAME: 'MYLIB',
              SQL_NAME: 'ORDERS_PK',
              LIBRARY_NAME: 'MYLIB',
              SYSTEM_NAME: 'ORDERS_PK',
              OBJECT_TEXT: null,
            },
            {
              SQL_OBJECT_TYPE: 'VIEW',
              SCHEMA_NAME: 'OTHERLIB',
              SQL_NAME: 'ORDERS_V',
              LIBRARY_NAME: 'OTHERLIB',
              SYSTEM_NAME: 'ORDERS_V',
              OBJECT_TEXT: null,
            },
          ],
        };
      });

      const result = await getRelatedObjectsTool({ schema: 'MYLIB', table: 'ORDERS' });

      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
      expect(result.data?.[0]?.sql_name).toBe('ORDERS_PK');
    });

    it('should reject the source schema when it is outside the allowlist', async () => {
      process.env.QUERY_ALLOWED_SCHEMAS = 'MYLIB';

      const result = await getRelatedObjectsTool({ schema: 'OTHERLIB', table: 'ORDERS' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('OTHERLIB');
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('get_journal_info', () => {
    function journalRow(row: Record<string, unknown>) {
      return {
        TABLE_NAME: 'ORDERS',
        SYSTEM_TABLE_NAME: 'ORDERS',
        JOURNALED: 'YES',
        JOURNAL_LIBRARY: 'MYLIB',
        JOURNAL_NAME: 'QSQJRN',
        JOURNAL_IMAGES: '*AFTER',
        OMIT_JOURNAL_ENTRY: '*OPNCLO',
        JOURNAL_START_TIMESTAMP: '2026-01-05 08:00:00.000000',
        PRIMARY_KEYS: '1',
        ...row,
      };
    }

    it('should normalize rows and flag tables a replication tool cannot use', async () => {
      query.mockResolvedValueOnce({
        rows: [
          journalRow({}),
          journalRow({ TABLE_NAME: 'ORDERHDR', SYSTEM_TABLE_NAME: 'ORDERHDR', PRIMARY_KEYS: '0' }),
          journalRow({ TABLE_NAME: 'CUSTOMERS', SYSTEM_TABLE_NAME: 'CUSTOMERS', PRIMARY_KEYS: '0', JOURNAL_IMAGES: '*BOTH' }),
          journalRow({
            TABLE_NAME: 'ORDERLINES',
            SYSTEM_TABLE_NAME: 'ORDERLIN',
            JOURNALED: 'NO',
            JOURNAL_LIBRARY: null,
            JOURNAL_NAME: null,
            JOURNAL_IMAGES: null,
            OMIT_JOURNAL_ENTRY: null,
            JOURNAL_START_TIMESTAMP: null,
          }),
        ],
      });

      const result = await getJournalInfoTool({ schema: 'mylib' });

      expect(result.success).toBe(true);
      expect(result.schema).toBe('MYLIB');
      expect(result.count).toBe(4);
      expect(result.needsAttention).toBe(2);
      expect(result.truncated).toBe(false);
      expect(result.data?.map((row) => [row.table_name, row.needs_attention])).toEqual([
        ['ORDERS', false],
        ['ORDERHDR', true],
        ['CUSTOMERS', false],
        ['ORDERLINES', true],
      ]);
      expect(result.data?.[0]).toMatchObject({
        journaled: true,
        journal_library: 'MYLIB',
        journal_name: 'QSQJRN',
        journal_images: '*AFTER',
        omit_entries: '*OPNCLO',
        has_primary_key: true,
      });
      expect(result.data?.[3]).toMatchObject({ system_table_name: 'ORDERLIN', journaled: false, journal_name: null });

      const [sql, params] = query.mock.calls[0] ?? [];
      expect(sql).toContain('QSYS2.OBJECT_STATISTICS(?,');
      expect(sql).toContain("O.OBJATTRIBUTE = 'PF'");
      expect(params).toEqual(['MYLIB', '%', '%']);
    });

    it('should use the default schema, the filter, and report truncation', async () => {
      process.env.QUERY_MAX_LIMIT = '1';
      query.mockResolvedValueOnce({ rows: [journalRow({}), journalRow({ TABLE_NAME: 'ORDERHDR' })] });

      const result = await getJournalInfoTool({ filter: 'ORD*', defaultSchema: 'MYLIB' });

      expect(result.count).toBe(1);
      expect(result.truncated).toBe(true);
      expect(query.mock.calls[0]?.[0]).toContain('FETCH FIRST 2 ROWS ONLY');
      expect(query.mock.calls[0]?.[1]).toEqual(['MYLIB', 'ORD%', 'ORD%']);
    });

    it('should reject a schema outside the allowlist without querying', async () => {
      process.env.QUERY_ALLOWED_SCHEMAS = 'MYLIB';

      const result = await getJournalInfoTool({ schema: 'OTHERLIB' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('OTHERLIB');
      expect(query).not.toHaveBeenCalled();
    });

    it('should report a library that does not exist', async () => {
      query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });

      const result = await getJournalInfoTool({ schema: 'nosuchlib' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Library NOSUCHLIB was not found.');
      expect(query.mock.calls[1]?.[0]).toContain('QSYS2.SYSSCHEMAS');
      expect(query.mock.calls[1]?.[1]).toEqual(['NOSUCHLIB', 'NOSUCHLIB']);
    });

    it('should return an empty list for a library with no data files', async () => {
      query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ FOUND: 1 }] });

      const result = await getJournalInfoTool({ schema: 'MYLIB', filter: 'NOMATCH*' });

      expect(result.success).toBe(true);
      expect(result.count).toBe(0);
      expect(result.needsAttention).toBe(0);
    });

    it('should not look up the library when rows come back', async () => {
      query.mockResolvedValueOnce({ rows: [journalRow({})] });

      await getJournalInfoTool({ schema: 'MYLIB' });

      expect(query).toHaveBeenCalledTimes(1);
    });

    it('should explain when OBJECT_STATISTICS has no journal columns', async () => {
      query.mockRejectedValueOnce(new Error('[SQL0206] Column or global variable JOURNALED not found.'));

      const result = await getJournalInfoTool({ schema: 'MYLIB' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('7.3 Technology Refresh 2');
    });
  });

  describe('search_ibmi_services', () => {
    function serviceRow(category: string, name: string, example: string | null = null) {
      return {
        SERVICE_CATEGORY: category,
        SERVICE_SCHEMA_NAME: 'QSYS2',
        SERVICE_NAME: name,
        SQL_OBJECT_TYPE: 'TABLE FUNCTION',
        SYSTEM_OBJECT_NAME: null,
        EARLIEST_POSSIBLE_RELEASE: 'V7R3M0',
        INITIAL_DB2_GROUP_LEVEL: '5',
        LATEST_DB2_GROUP_LEVEL: null,
        EXAMPLE: example,
      };
    }

    const catalog = {
      rows: [
        serviceRow('JOURNAL', 'DISPLAY_JOURNAL', '-- Description: Read entries\r\nSELECT * FROM TABLE(QSYS2.DISPLAY_JOURNAL(\'MYLIB\', \'QSQJRN\')) X'),
        serviceRow('JOURNAL', 'JOURNAL_INFO', 'SELECT * FROM QSYS2.JOURNAL_INFO'),
        serviceRow('SECURITY', 'USER_INFO', 'SELECT * FROM QSYS2.USER_INFO'),
        serviceRow('WORK MANAGEMENT', 'ACTIVE_JOB_INFO', 'SELECT * FROM TABLE(QSYS2.ACTIVE_JOB_INFO()) X'),
      ],
    };

    function target(system: string, username = 'MCPUSER'): DbTarget {
      return { poolKey: system, system, config: { username } } as unknown as DbTarget;
    }

    it('should list categories with counts when called with no filter', async () => {
      query.mockResolvedValueOnce(catalog);

      const result = await searchIbmiServicesTool({});

      expect(result.success).toBe(true);
      expect(result.categories).toEqual([
        { category: 'JOURNAL', count: 2 },
        { category: 'SECURITY', count: 1 },
        { category: 'WORK MANAGEMENT', count: 1 },
      ]);
      expect(result.count).toBe(3);
      expect(result.data).toBeUndefined();
      expect(query.mock.calls[0][0]).toContain('QSYS2.SERVICES_INFO');
    });

    it('should match every keyword against name and category, ignoring case', async () => {
      query.mockResolvedValueOnce(catalog);

      const result = await searchIbmiServicesTool({ query: 'journal  display' });

      expect(result.data?.map((row) => row.service_name)).toEqual(['DISPLAY_JOURNAL']);
      expect(result.data?.[0]).toMatchObject({
        category: 'JOURNAL',
        schema: 'QSYS2',
        sql_object_type: 'TABLE FUNCTION',
        earliest_release: 'V7R3M0',
        initial_db2_group_level: 5,
        latest_db2_group_level: null,
      });
      expect(result.data?.[0].example).toBe("-- Description: Read entries\nSELECT * FROM TABLE(QSYS2.DISPLAY_JOURNAL('MYLIB', 'QSQJRN')) X");
    });

    it('should search examples only when asked', async () => {
      query.mockResolvedValueOnce(catalog);

      const plain = await searchIbmiServicesTool({ query: 'MYLIB' });
      const withExamples = await searchIbmiServicesTool({ query: 'mylib', searchExamples: true });

      expect(plain.data).toEqual([]);
      expect(withExamples.data?.map((row) => row.service_name)).toEqual(['DISPLAY_JOURNAL']);
    });

    it('should filter by exact category, ignoring case', async () => {
      query.mockResolvedValueOnce(catalog);

      const result = await searchIbmiServicesTool({ category: 'work management' });
      const partial = await searchIbmiServicesTool({ category: 'WORK' });

      expect(result.data?.map((row) => row.service_name)).toEqual(['ACTIVE_JOB_INFO']);
      expect(partial.data).toEqual([]);
    });

    it('should leave out examples when include_example is false', async () => {
      query.mockResolvedValueOnce(catalog);

      const result = await searchIbmiServicesTool({ category: 'SECURITY', includeExample: false });

      expect(result.data?.[0].service_name).toBe('USER_INFO');
      expect(result.data?.[0]).not.toHaveProperty('example');
    });

    it('should cap results at the limit and report truncation', async () => {
      process.env.QUERY_MAX_LIMIT = '2';
      query.mockResolvedValueOnce(catalog);

      const result = await searchIbmiServicesTool({ query: 'info', limit: 10 });

      expect(result.data?.map((row) => row.service_name)).toEqual(['JOURNAL_INFO', 'USER_INFO']);
      expect(result.count).toBe(2);
      expect(result.truncated).toBe(true);
    });

    it('should read the catalog once per system and user within the cache time', async () => {
      query.mockResolvedValue(catalog);

      await searchIbmiServicesTool({ target: target('prod') });
      await searchIbmiServicesTool({ query: 'journal', target: target('prod') });
      expect(query).toHaveBeenCalledTimes(1);

      await searchIbmiServicesTool({ target: target('test') });
      await searchIbmiServicesTool({ target: target('prod', 'OTHERUSER') });
      expect(query).toHaveBeenCalledTimes(3);
    });

    it('should read the catalog again after the cache expires', async () => {
      vi.useFakeTimers();
      try {
        query.mockResolvedValue(catalog);

        await searchIbmiServicesTool({});
        vi.advanceTimersByTime(SERVICES_CACHE_TTL_MS + 1);
        await searchIbmiServicesTool({});

        expect(query).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should explain a missing SERVICES_INFO view and not cache the failure', async () => {
      query.mockRejectedValueOnce(new Error('Database query failed: [42704] SQL0204 - SERVICES_INFO in QSYS2 type *FILE not found.'));
      query.mockResolvedValueOnce(catalog);

      const failed = await searchIbmiServicesTool({});
      const retried = await searchIbmiServicesTool({});

      expect(failed.success).toBe(false);
      expect(failed.error).toContain('QSYS2.SERVICES_INFO is not available');
      expect(retried.success).toBe(true);
      expect(query).toHaveBeenCalledTimes(2);
    });

    it('should return other database errors as they are', async () => {
      query.mockRejectedValueOnce(new Error('Database query failed: connection reset'));

      const result = await searchIbmiServicesTool({});

      expect(result).toEqual({ success: false, error: 'Database query failed: connection reset' });
    });
  });

  describe('execute_query parse check', () => {
    it('should run the query when the check is off', async () => {
      query.mockResolvedValueOnce({ rows: [{ ORDERNO: 1001 }] });

      const result = await executeQueryTool({ sql: 'SELECT ORDERNO FROM MYLIB.ORDERS' });

      expect(result.success).toBe(true);
      expect(result.rowCount).toBe(1);
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0]?.[0]).not.toContain('PARSE_STATEMENT');
    });

    it('should reject a statement that does not parse when the check is on', async () => {
      process.env.QUERY_PARSE_CHECK = 'true';
      query.mockResolvedValueOnce({ rows: [] });

      const result = await executeQueryTool({ sql: 'SELECT ORDERNO FROM MYLIB.ORDERS' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('could not be parsed');
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('should reject a non-query statement type', async () => {
      process.env.QUERY_PARSE_CHECK = 'true';
      query.mockResolvedValueOnce({
        rows: [parsedRow({ NAME_TYPE: 'TABLE', SCHEMA: 'MYLIB', NAME: 'ORDERS', SQL_STATEMENT_TYPE: 'INSERT' })],
      });

      const result = await executeQueryTool({ sql: 'SELECT ORDERNO FROM MYLIB.ORDERS' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('INSERT');
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('should refuse to run when PARSE_STATEMENT is missing', async () => {
      process.env.QUERY_PARSE_CHECK = 'true';
      query.mockRejectedValueOnce(new Error('PARSE_STATEMENT in QSYS2 type *N not found. SQL0204'));

      const result = await executeQueryTool({ sql: 'SELECT ORDERNO FROM MYLIB.ORDERS' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('QUERY_PARSE_CHECK=false');
    });
  });
});
