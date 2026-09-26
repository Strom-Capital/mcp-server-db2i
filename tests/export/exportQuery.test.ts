import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/db/connection.js', () => ({
  executeQuery: vi.fn(),
  executeProcedure: vi.fn(),
  openQueryCursor: vi.fn(),
}));

import { executeQuery, openQueryCursor } from '../../src/db/connection.js';
import type { DbColumn, RowCursor } from '../../src/db/driver.js';
import { resetCustomTools, setCustomTools } from '../../src/customTools/registry.js';
import {
  closeExportStore,
  initExportStore,
  peekExport,
  sweepExpired,
} from '../../src/export/store.js';
import { exportFilename, exportQueryTool, type ExportQueryInput } from '../../src/tools/exportQuery.js';

const openCursor = vi.mocked(openQueryCursor);
const query = vi.mocked(executeQuery);

const COLUMNS: DbColumn[] = [
  { name: 'ORDERNO', kind: 'int', dbType: 'INTEGER' },
  { name: 'NOTE', kind: 'string', dbType: 'VARCHAR' },
];

interface FakeCursor extends RowCursor {
  closed: number;
}

function fakeCursor(columns: DbColumn[], batches: unknown[][][]): FakeCursor {
  let index = 0;
  const cursor: FakeCursor = {
    columns,
    closed: 0,
    async next() {
      const batch = batches[index];
      index += 1;
      return batch ?? null;
    },
    async close() {
      cursor.closed += 1;
    },
  };
  return cursor;
}

function rows(count: number, start = 1001): unknown[][] {
  return Array.from({ length: count }, (_, i) => [start + i, `Order ${start + i}`]);
}

function input(overrides: Partial<ExportQueryInput> = {}): ExportQueryInput {
  return {
    sql: 'SELECT ORDERNO, NOTE FROM MYLIB.ORDERS',
    delivery: 'path',
    owner: 'stdio',
    format: 'csv',
    ...overrides,
  };
}

const previousEnv = process.env;
let dir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  resetCustomTools();
  process.env = { ...previousEnv };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('EXPORT_') || key.startsWith('QUERY_') || key === 'MCP_PUBLIC_URL') {
      delete process.env[key];
    }
  }
  dir = await mkdtemp(join(tmpdir(), 'db2i-export-'));
  process.env.EXPORT_ENABLED = 'true';
  process.env.EXPORT_DIR = join(dir, 'exports');
  process.env.QUERY_PARSE_CHECK = 'false';
  await initExportStore();
});

afterEach(async () => {
  await closeExportStore();
  process.env = previousEnv;
  resetCustomTools();
  await rm(dir, { recursive: true, force: true });
});

async function exportFiles(): Promise<string[]> {
  return readdir(join(dir, 'exports'));
}

describe('exportFilename', () => {
  it('keeps safe characters, drops a repeated extension, and falls back to a timestamp', () => {
    expect(exportFilename('open orders/1001', 'csv')).toBe('open_orders_1001.csv');
    expect(exportFilename('report.xlsx', 'xlsx')).toBe('report.xlsx');
    expect(exportFilename('../../etc/passwd', 'csv')).toBe('etc_passwd.csv');
    expect(exportFilename(undefined, 'xlsx', new Date('2026-09-26T17:30:05Z'))).toBe('export-20260926-173005.xlsx');
    expect(exportFilename('x'.repeat(200), 'csv')).toHaveLength(84);
  });
});

describe('export_query', () => {
  it('refuses to run when exports are off', async () => {
    await closeExportStore();
    delete process.env.EXPORT_ENABLED;

    const result = await exportQueryTool(input());
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/EXPORT_ENABLED/) });
    expect(openCursor).not.toHaveBeenCalled();
  });

  it('writes a CSV file and returns its path, the row count and a sample', async () => {
    const cursor = fakeCursor(COLUMNS, [rows(3), rows(4, 1004)]);
    openCursor.mockResolvedValueOnce(cursor);

    const result = await exportQueryTool(input({ filename: 'open-orders' }));

    expect(result).toMatchObject({
      success: true,
      format: 'csv',
      filename: 'open-orders.csv',
      rowCount: 7,
      truncated: false,
      columns: [
        { name: 'ORDERNO', kind: 'int' },
        { name: 'NOTE', kind: 'string' },
      ],
    });
    expect(result.sample).toHaveLength(5);
    expect(result.sample?.[0]).toEqual({ ORDERNO: 1001, NOTE: 'Order 1001' });
    expect(result.url).toBeUndefined();
    const text = await readFile(result.path!, 'utf8');
    expect(text.split('\r\n')).toHaveLength(9);
    expect(result.bytes).toBe(Buffer.byteLength(text, 'utf8'));
    expect(cursor.closed).toBeGreaterThan(0);
    expect(await exportFiles()).toEqual([result.path!.split('/').pop()]);
  });

  it('writes XLSX by default', async () => {
    openCursor.mockResolvedValueOnce(fakeCursor(COLUMNS, [rows(2)]));

    const result = await exportQueryTool(input({ format: undefined }));

    expect(result.success).toBe(true);
    expect(result.format).toBe('xlsx');
    expect(result.path).toMatch(/\.xlsx$/);
    const bytes = await readFile(result.path!);
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
  });

  it('asks for one row past the cap and stops at the cap', async () => {
    openCursor.mockResolvedValueOnce(fakeCursor(COLUMNS, [rows(3), rows(3, 1004)]));

    const result = await exportQueryTool(input({ maxRows: 4 }));

    expect(result).toMatchObject({ success: true, rowCount: 4, truncated: 'rows' });
    expect(openCursor.mock.calls[0][0]).toMatch(/FETCH FIRST 5 ROWS ONLY/i);
  });

  it('caps max_rows at EXPORT_MAX_ROWS', async () => {
    process.env.EXPORT_MAX_ROWS = '2';
    openCursor.mockResolvedValueOnce(fakeCursor(COLUMNS, [rows(3)]));

    const result = await exportQueryTool(input({ maxRows: 1000 }));
    expect(result).toMatchObject({ success: true, rowCount: 2, truncated: 'rows' });
  });

  it('stops after the batch that reaches EXPORT_MAX_BYTES', async () => {
    process.env.EXPORT_MAX_BYTES = '1024';
    openCursor.mockResolvedValueOnce(fakeCursor(COLUMNS, [rows(100), rows(100, 2001), rows(100, 3001)]));

    const result = await exportQueryTool(input());
    expect(result).toMatchObject({ success: true, rowCount: 100, truncated: 'bytes' });
  });

  it('masks masked columns in the file and in the sample', async () => {
    process.env.QUERY_PARSE_CHECK = 'true';
    setCustomTools({
      tools: [],
      annotations: [],
      masking: new Map([['MYLIB.CUSTOMERS', new Map([['EMAIL', 'redact']])]]),
    });
    query.mockResolvedValueOnce({
      rows: [{ NAME_TYPE: 'TABLE', SCHEMA: 'MYLIB', NAME: 'CUSTOMERS', COLUMN_NAME: null, SQL_STATEMENT_TYPE: 'QUERY' }],
    });
    const columns: DbColumn[] = [
      { name: 'CUSTNO', kind: 'int', dbType: 'INTEGER' },
      { name: 'EMAIL', kind: 'string', dbType: 'VARCHAR' },
    ];
    openCursor.mockResolvedValueOnce(fakeCursor(columns, [[[1001, 'ada@example.com']]]));

    const result = await exportQueryTool(input({ sql: 'SELECT CUSTNO, EMAIL FROM MYLIB.CUSTOMERS' }));

    expect(result.success).toBe(true);
    expect(result.sample).toEqual([{ CUSTNO: 1001, EMAIL: '****' }]);
    const text = await readFile(result.path!, 'utf8');
    expect(text).toContain('1001,****');
    expect(text).not.toContain('ada@example.com');
  });

  it('fails closed, and leaves no file, when a masked column is missing from the result', async () => {
    process.env.QUERY_PARSE_CHECK = 'true';
    setCustomTools({
      tools: [],
      annotations: [],
      masking: new Map([['MYLIB.CUSTOMERS', new Map([['EMAIL', 'redact']])]]),
    });
    query.mockResolvedValueOnce({
      rows: [{ NAME_TYPE: 'TABLE', SCHEMA: 'MYLIB', NAME: 'CUSTOMERS', COLUMN_NAME: null, SQL_STATEMENT_TYPE: 'QUERY' }],
    });
    // The statement selects EMAIL, but the result (for example a view change) does not have it
    openCursor.mockResolvedValueOnce(fakeCursor([{ name: 'CUSTNO', kind: 'int', dbType: 'INTEGER' }], []));

    const result = await exportQueryTool(input({ sql: 'SELECT CUSTNO, EMAIL FROM MYLIB.CUSTOMERS' }));

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/EMAIL/) });
    expect(await exportFiles()).toEqual([]);
  });

  it('warns about columns the driver rounded', async () => {
    openCursor.mockResolvedValueOnce(
      fakeCursor(
        [
          { name: 'ORDERNO', kind: 'int', dbType: 'INTEGER' },
          { name: 'TOTAL', kind: 'decimal', dbType: 'DECIMAL', precision: 31, lossy: true },
        ],
        [[[1001, 12.5]]]
      )
    );

    const result = await exportQueryTool(input());

    expect(result.success).toBe(true);
    expect(result.warnings?.[0]).toMatch(/TOTAL may not be exact.*CAST\(<column> AS VARCHAR\(40\)\)/);
  });

  it('rejects a result with two columns of the same name', async () => {
    const cursor = fakeCursor(
      [
        { name: 'ORDERNO', kind: 'int', dbType: 'INTEGER' },
        { name: 'ORDERNO', kind: 'int', dbType: 'INTEGER' },
      ],
      [[[1, 1]]]
    );
    openCursor.mockResolvedValueOnce(cursor);

    const result = await exportQueryTool(input());

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/ORDERNO appears more than once/) });
    expect(cursor.closed).toBeGreaterThan(0);
  });

  it('passes validation errors through without opening a cursor', async () => {
    const result = await exportQueryTool(input({ sql: 'DELETE FROM MYLIB.ORDERS' }));

    expect(result.success).toBe(false);
    expect(result.violations?.length).toBeGreaterThan(0);
    expect(openCursor).not.toHaveBeenCalled();
  });

  it('needs MCP_PUBLIC_URL for a download link', async () => {
    const result = await exportQueryTool(input({ delivery: 'link', owner: 'TESTUSER' }));
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/MCP_PUBLIC_URL/) });
  });

  it('returns a download link and no host path in HTTP mode', async () => {
    process.env.MCP_PUBLIC_URL = 'https://mcp.example.com';
    openCursor.mockResolvedValueOnce(fakeCursor(COLUMNS, [rows(2)]));

    const result = await exportQueryTool(input({ delivery: 'link', owner: 'TESTUSER' }));

    expect(result.success).toBe(true);
    expect(result.path).toBeUndefined();
    expect(result.singleUse).toBe(true);
    const match = /^https:\/\/mcp\.example\.com\/exports\/([A-Za-z0-9_-]{43})$/.exec(result.url ?? '');
    expect(match).not.toBeNull();
    expect(peekExport(match![1])).toMatchObject({ owner: 'TESTUSER', rows: 2, filename: result.filename });
  });

  it('cancels at EXPORT_TIMEOUT, reports it, and removes the partial file', async () => {
    process.env.EXPORT_TIMEOUT = '1';
    openCursor.mockImplementationOnce(async (_sql, _params, _target, options) => {
      let first = true;
      return {
        columns: COLUMNS,
        async next() {
          if (first) {
            first = false;
            return rows(2);
          }
          // Hangs until the deadline aborts, like a slow fetch that gets cancelled
          await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve()));
          throw new Error('[HY008] Operation canceled');
        },
        async close() {},
      };
    });

    const result = await exportQueryTool(input());

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/EXPORT_TIMEOUT/) });
    expect(await exportFiles()).toEqual([]);
  });

  it('refuses a new export above EXPORT_MAX_CONCURRENT', async () => {
    await closeExportStore();
    process.env.EXPORT_MAX_CONCURRENT = '1';
    await initExportStore();
    let release: () => void = () => undefined;
    openCursor.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return fakeCursor(COLUMNS, [rows(1)]);
    });

    const first = exportQueryTool(input());
    await vi.waitFor(() => expect(openCursor).toHaveBeenCalledTimes(1));
    const second = await exportQueryTool(input());
    release();

    expect(second).toMatchObject({ success: false, error: expect.stringMatching(/EXPORT_MAX_CONCURRENT/) });
    expect((await first).success).toBe(true);
  });
});

describe('export store', () => {
  it('deletes expired exports', async () => {
    process.env.MCP_PUBLIC_URL = 'https://mcp.example.com';
    openCursor.mockResolvedValueOnce(fakeCursor(COLUMNS, [rows(1)]));
    const result = await exportQueryTool(input({ delivery: 'link', owner: 'TESTUSER' }));
    const id = result.url!.split('/').pop()!;

    expect(await sweepExpired(Date.now() + 16 * 60_000)).toBe(1);
    expect(peekExport(id)).toBeUndefined();
    expect(await exportFiles()).toEqual([]);
  });

  it('deletes export files left by an earlier run, and nothing else', async () => {
    await closeExportStore();
    const exportsDir = join(dir, 'exports');
    const leftover = `${'a'.repeat(43)}.csv.part`;
    await writeFile(join(exportsDir, leftover), 'x');
    await writeFile(join(exportsDir, 'notes.txt'), 'keep');

    await initExportStore();

    expect(await exportFiles()).toEqual(['notes.txt']);
  });

  it('refuses a symbolic link as EXPORT_DIR', async () => {
    await closeExportStore();
    const target = join(dir, 'real');
    await (await import('node:fs/promises')).mkdir(target);
    await symlink(target, join(dir, 'link'));
    process.env.EXPORT_DIR = join(dir, 'link');

    await expect(initExportStore()).rejects.toThrow(/symbolic link/);
  });
});
