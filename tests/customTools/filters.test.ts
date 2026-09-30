import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/connection.js', () => ({
  executeQuery: vi.fn(),
  executeProcedure: vi.fn(),
}));

import { executeQuery } from '../../src/db/connection.js';
import { getBusinessContextTool } from '../../src/customTools/context.js';
import { checkRowFilters, type ParsedReference } from '../../src/customTools/filters.js';
import { CustomToolsError, loadCustomTools, type StoredAnnotation } from '../../src/customTools/loader.js';
import { resetCustomTools, setCustomTools } from '../../src/customTools/registry.js';
import { executeQueryTool } from '../../src/tools/query.js';
import { validateQueryTool } from '../../src/tools/sqlServices.js';

const query = vi.mocked(executeQuery);

const LINES: StoredAnnotation = {
  table: 'MYLIB.ORDERS',
  filters: [{ sql: "LINESTAT <> 'D'", columns: ['LINESTAT'], reason: 'Deleted lines stay in the table' }],
  columns: {},
  relations: [],
};

const HEADERS: StoredAnnotation = {
  table: 'MYLIB.ORDERHDR',
  filters: [{ sql: "HDRSTAT <> 'D'", columns: ['HDRSTAT'] }],
  columns: {},
  relations: [],
};

function table(name: string, schema: string | null = 'MYLIB'): ParsedReference {
  return { nameType: 'TABLE', schema, name, columnName: null };
}

function column(columnName: string, name: string | null = null, schema: string | null = name ? 'MYLIB' : null): ParsedReference {
  return { nameType: 'COLUMN', schema, name, columnName };
}

describe('checkRowFilters', () => {
  it('warns when a filtered table is read without its filter column', () => {
    const result = checkRowFilters([table('ORDERS'), column('ORDERNO', 'ORDERS')], [LINES]);

    expect(result.tables).toEqual(['MYLIB.ORDERS']);
    expect(result.warnings).toEqual([
      "MYLIB.ORDERS has a filter LINESTAT <> 'D' (Deleted lines stay in the table). This query does not use LINESTAT. " +
        'Add the filter unless the question needs those rows.',
    ]);
  });

  it('accepts the column qualified with the table or unqualified', () => {
    expect(checkRowFilters([table('ORDERS'), column('LINESTAT', 'ORDERS')], [LINES]).tables).toEqual([]);
    // An unqualified column, as in a CTE, cannot be tied to a table, so it counts
    expect(checkRowFilters([table('ORDERS'), column('LINESTAT')], [LINES]).tables).toEqual([]);
  });

  it('does not count a column of the same name on another table', () => {
    const result = checkRowFilters(
      [table('ORDERS'), table('ORDERHDR'), column('HDRSTAT', 'ORDERHDR'), column('LINESTAT', 'ORDERHDR')],
      [LINES, HEADERS],
    );

    expect(result.tables).toEqual(['MYLIB.ORDERS']);
  });

  it('checks each annotated table in a join', () => {
    const result = checkRowFilters(
      [table('ORDERS'), table('ORDERHDR'), column('ORDERNO', 'ORDERS'), column('HDRSTAT', 'ORDERHDR')],
      [LINES, HEADERS],
    );

    expect(result.tables).toEqual(['MYLIB.ORDERS']);
    expect(result.warnings).toHaveLength(1);
  });

  it('resolves unqualified tables with the default schema, or by name without one', () => {
    expect(checkRowFilters([table('ORDERS', null)], [LINES], 'MYLIB').tables).toEqual(['MYLIB.ORDERS']);
    expect(checkRowFilters([table('ORDERS', null)], [LINES], 'OTHERLIB').tables).toEqual([]);
    expect(checkRowFilters([table('ORDERS', null)], [LINES]).tables).toEqual(['MYLIB.ORDERS']);
  });

  it('ignores tables without filters', () => {
    expect(checkRowFilters([table('CUSTOMERS')], [LINES, { ...HEADERS, filters: undefined }])).toEqual({
      tables: [],
      warnings: [],
    });
  });

  it('names every column of a filter that uses several', () => {
    const annotation = { ...LINES, filters: [{ sql: "LINESTAT <> 'D' AND VOIDED = 'N'", columns: ['LINESTAT', 'VOIDED'] }] };
    const result = checkRowFilters([table('ORDERS')], [annotation]);
    expect(result.warnings[0]).toContain('does not use LINESTAT or VOIDED');
    expect(checkRowFilters([table('ORDERS'), column('VOIDED')], [annotation]).tables).toEqual([]);
  });
});

describe('annotation filters in YAML', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
    resetCustomTools();
  });

  function writeYaml(contents: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'db2i-filters-'));
    dirs.push(dir);
    const file = path.join(dir, 'tools.yaml');
    writeFileSync(file, contents);
    return file;
  }

  it('loads filters with uppercased columns and lists them first in the business context', () => {
    const loaded = loadCustomTools([writeYaml(`
version: 1
annotations:
  mylib.orders:
    description: Order line
    columns:
      LINESTAT: "D = deleted"
    filters:
      - sql: "LINESTAT <> 'D'"
        columns: [linestat]
        reason: Deleted lines stay in the table
`)]);

    expect(loaded.annotations[0].filters).toEqual([
      { sql: "LINESTAT <> 'D'", columns: ['LINESTAT'], reason: 'Deleted lines stay in the table' },
    ]);
    setCustomTools(loaded);
    const context = getBusinessContextTool({ table: 'ORDERS' });
    expect(Object.keys(context.data?.[0] ?? {})).toEqual(['table', 'filters', 'description', 'columns', 'relations']);
  });

  it('rejects a filter without columns', () => {
    const file = writeYaml(`
version: 1
annotations:
  MYLIB.ORDERS:
    filters:
      - sql: "LINESTAT <> 'D'"
        columns: []
`);
    expect(() => loadCustomTools([file])).toThrow(CustomToolsError);
    expect(() => loadCustomTools([file])).toThrow(/List the columns the filter uses/);
  });
});

describe('row filters in execute_query and validate_query', () => {
  const previousEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...previousEnv };
    delete process.env.QUERY_PARSE_CHECK;
    delete process.env.QUERY_ALLOWED_SCHEMAS;
    setCustomTools({ tools: [], instructions: [], masking: new Map(), annotations: [LINES] });
  });

  afterEach(() => {
    process.env = previousEnv;
    resetCustomTools();
  });

  const parsed = (rows: ParsedReference[]) => ({
    rows: rows.map((row) => ({
      NAME_TYPE: row.nameType,
      SCHEMA: row.schema,
      NAME: row.name,
      COLUMN_NAME: row.columnName,
      SQL_STATEMENT_TYPE: 'QUERY',
    })),
  });

  it('runs the query and returns the warning with skippedFilters', async () => {
    query
      .mockResolvedValueOnce(parsed([table('ORDERS'), column('ORDERNO', 'ORDERS')]))
      .mockResolvedValueOnce({ rows: [{ ORDERNO: 1001 }] });

    const result = await executeQueryTool({ sql: 'SELECT ORDERNO FROM MYLIB.ORDERS' });

    expect(result.success).toBe(true);
    expect(result.data).toEqual([{ ORDERNO: 1001 }]);
    expect(result.skippedFilters).toEqual(['MYLIB.ORDERS']);
    expect(result.warnings).toEqual([expect.stringContaining("MYLIB.ORDERS has a filter LINESTAT <> 'D'")]);
  });

  it('returns no warning when the query uses the filter column', async () => {
    query
      .mockResolvedValueOnce(parsed([table('ORDERS'), column('ORDERNO', 'ORDERS'), column('LINESTAT', 'ORDERS')]))
      .mockResolvedValueOnce({ rows: [{ ORDERNO: 1001 }] });

    const result = await executeQueryTool({ sql: "SELECT ORDERNO FROM MYLIB.ORDERS WHERE LINESTAT <> 'D'" });

    expect(result.skippedFilters).toBeUndefined();
    expect(result.warnings).toBeUndefined();
  });

  it('does not check filters when the parse check is off', async () => {
    process.env.QUERY_PARSE_CHECK = 'false';
    query.mockResolvedValueOnce({ rows: [{ ORDERNO: 1001 }] });

    const result = await executeQueryTool({ sql: 'SELECT ORDERNO FROM MYLIB.ORDERS' });

    expect(result.success).toBe(true);
    expect(result.skippedFilters).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('reports the filter from validate_query without making the query invalid', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('PARSE_STATEMENT')) {
        return parsed([table('ORDERS'), column('ORDERNO', 'ORDERS')]) as Awaited<ReturnType<typeof executeQuery>>;
      }
      if (sql.includes('QSYS2.SYSTABLES')) {
        return { rows: [{ TABLE_SCHEMA: 'MYLIB', TABLE_NAME: 'ORDERS' }] } as Awaited<ReturnType<typeof executeQuery>>;
      }
      return {
        rows: [{ TABLE_SCHEMA: 'MYLIB', TABLE_NAME: 'ORDERS', COLUMN_NAME: 'ORDERNO' }],
      } as Awaited<ReturnType<typeof executeQuery>>;
    });

    const result = await validateQueryTool({ sql: 'SELECT ORDERNO FROM MYLIB.ORDERS' });

    expect(result.success).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.skippedFilters).toEqual(['MYLIB.ORDERS']);
    expect(result.warnings).toEqual([expect.stringContaining('does not use LINESTAT')]);
  });
});
