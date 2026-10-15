import { describe, expect, it } from 'vitest';
import { compareCells, csvField, formatCell, groupDigits, inferColumns, toCsv, toTsv } from '@/lib/format';
import { exportSourceOf, readToolResult } from '@/lib/results';

describe('exportSourceOf', () => {
  it('takes the SQL and parameters of an execute_query call', () => {
    expect(exportSourceOf('execute_query', { sql: ' SELECT ORDERNO FROM MYLIB.ORDERS WHERE CUSTNO = ? ', params: [42], limit: 100 })).toEqual({
      sql: 'SELECT ORDERNO FROM MYLIB.ORDERS WHERE CUSTNO = ?',
      params: [42],
    });
    expect(exportSourceOf('execute_query', { sql: 'SELECT 1 FROM SYSIBM.SYSDUMMY1', params: [] })).toEqual({ sql: 'SELECT 1 FROM SYSIBM.SYSDUMMY1' });
  });

  it('has nothing for other tools or an empty query', () => {
    expect(exportSourceOf('list_sales_orders', { customer: 1001 })).toBeUndefined();
    expect(exportSourceOf('validate_query', { sql: 'SELECT 1 FROM SYSIBM.SYSDUMMY1' })).toBeUndefined();
    expect(exportSourceOf('execute_query', { sql: '  ' })).toBeUndefined();
    expect(exportSourceOf(undefined, undefined)).toBeUndefined();
  });
});

describe('inferColumns', () => {
  it('treats numbers and decimal strings as numbers, and ignores nulls', () => {
    const rows = [
      { ORDERNO: 1001, AMOUNT: '12345678901234567.25', ORDERDATE: '2026-09-24', NOTE: null },
      { ORDERNO: 1002, AMOUNT: null, ORDERDATE: '2026-09-25', NOTE: 'Rush' },
    ];

    expect(inferColumns(rows)).toEqual([
      { name: 'ORDERNO', kind: 'number', group: false },
      { name: 'AMOUNT', kind: 'number', group: true },
      { name: 'ORDERDATE', kind: 'date', group: false },
      { name: 'NOTE', kind: 'text', group: false },
    ]);
  });

  it('does not group keys or numeric dates', () => {
    const columns = inferColumns([{ ORDERNO: 1001, ORDDAT: 20261015, QUANTITY: 12500 }]);

    expect(columns.map((column) => column.group)).toEqual([false, false, true]);
    expect(formatCell(20261015, 'number', false)).toBe('20261015');
  });

  it('makes a column with mixed values text', () => {
    expect(inferColumns([{ ITEMNO: 1 }, { ITEMNO: 'A-1' }])).toEqual([{ name: 'ITEMNO', kind: 'text', group: false }]);
  });
});

describe('formatCell', () => {
  it('groups digits without converting long decimals to a double', () => {
    expect(groupDigits('-12345678901234567.25')).toBe('-12,345,678,901,234,567.25');
    expect(formatCell('12345678901234567.25', 'number')).toBe('12,345,678,901,234,567.25');
    expect(formatCell(1234.5, 'number')).toBe('1,234.5');
  });

  it('shows null as empty and objects as JSON', () => {
    expect(formatCell(null, 'text')).toBe('');
    expect(formatCell({ a: 1 }, 'text')).toBe('{"a":1}');
  });
});

describe('compareCells', () => {
  it('compares numeric strings as numbers and sorts nulls last', () => {
    const values = ['10', null, '9', '100'];

    expect([...values].sort((a, b) => compareCells(a, b, 'number'))).toEqual(['9', '10', '100', null]);
  });
});

describe('CSV and TSV', () => {
  it('quotes fields with commas, quotes and line breaks', () => {
    expect(toCsv(['A', 'B'], [{ A: 'x, y', B: 'say "hi"\nnow' }])).toBe('A,B\r\n"x, y","say ""hi""\nnow"');
  });

  it('defuses spreadsheet formulas but keeps negative numbers', () => {
    expect(csvField('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvField('-42.5')).toBe('-42.5');
    expect(csvField(-3)).toBe('-3');
  });

  it('writes TSV with tabs and line breaks flattened', () => {
    expect(toTsv(['A'], [{ A: 'one\ttwo\nthree' }])).toBe('A\none two three');
  });
});

describe('readToolResult', () => {
  it('reads rows, the row count and the limit from structured content', () => {
    const view = readToolResult({
      content: [{ type: 'text', text: '...' }],
      structuredContent: { success: true, data: [{ ORDERNO: 1001 }], rowCount: 1, truncated: true, limitApplied: 1 },
    });

    expect(view).toMatchObject({ ok: true, rows: [{ ORDERNO: 1001 }], rowCount: 1, truncated: true, limitApplied: 1 });
    expect(view.chartType).toBeUndefined();
  });

  it('reads the chart type the server resolved', () => {
    const view = readToolResult({
      structuredContent: { success: true, data: [{ STATUS: 'OPEN', TOTAL: 3 }], chart: { type: 'bar', x: 'STATUS', y: ['TOTAL'] } },
    });

    expect(view.chartType).toBe('bar');
  });

  it('reads a Db2 error with its details', () => {
    const view = readToolResult({
      isError: true,
      content: [{ type: 'text', text: 'Query failed' }],
      structuredContent: { success: false, error: 'Column ORDERNOX not found', sqlstate: '42703', sqlcode: -206 },
    });

    expect(view.ok).toBe(false);
    expect(view.error).toMatchObject({ message: 'Column ORDERNOX not found', sqlstate: '42703', sqlcode: -206 });
  });

  it('reads an export link and shows its sample rows', () => {
    const view = readToolResult({
      structuredContent: {
        success: true,
        url: 'http://mcp.example.com/exports/abc',
        filename: 'orders.xlsx',
        rowCount: 5000,
        sample: [{ ORDERNO: 1001 }],
        expiresAt: '2026-10-15T12:00:00.000Z',
      },
    });

    expect(view.exportFile).toMatchObject({ url: 'http://mcp.example.com/exports/abc', filename: 'orders.xlsx', rowCount: 5000 });
    expect(view.rows).toEqual([{ ORDERNO: 1001 }]);
  });

  it('parses JSON text when there is no structured content', () => {
    const view = readToolResult({ content: [{ type: 'text', text: '{"success":true,"data":[{"ITEMNO":"A1"}]}' }] });

    expect(view.rows).toEqual([{ ITEMNO: 'A1' }]);
  });

  it('keeps plain text as text', () => {
    expect(readToolResult({ content: [{ type: 'text', text: 'Hello' }] })).toMatchObject({ ok: true, text: 'Hello' });
  });
});
