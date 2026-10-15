/**
 * The result view's pure modules (ui/result): column roles, chart selection,
 * chart building and the MCP Apps bridge. The page itself runs in a browser;
 * none of these need a DOM.
 */

import { describe, expect, it, vi } from 'vitest';

import { connect, PROTOCOL_VERSION } from '../../ui/result/bridge.js';
import { buildChart, histogramBins } from '../../ui/result/build.js';
import { numericDate, readResult, type ResultTable } from '../../ui/result/data.js';
import { availableTypes, planFromHint, ruleChart, selectChart } from '../../ui/result/select.js';
import { fallbackFonts, themeFor } from '../../ui/result/theme.js';

function table(structured: Record<string, unknown>): ResultTable {
  const result = readResult({ success: true, ...structured });
  if (!result || 'error' in result) {
    throw new Error('expected a table');
  }
  return result;
}

const roles = (t: ResultTable) => Object.fromEntries(t.columns.map((c) => [c.name, c.role]));

describe('readResult', () => {
  it('returns the tool error, and null for a result without rows', () => {
    expect(readResult({ success: false, error: 'SQL0204: ORDERS in MYLIB not found' })).toEqual({
      error: 'SQL0204: ORDERS in MYLIB not found',
    });
    expect(readResult({ success: true, tables: [] })).toBeNull();
    expect(readResult('text')).toBeNull();
  });

  it('keeps the column order and kinds the server sent', () => {
    const t = table({
      data: [{ STATUS: 'OPEN', TOTAL: '12.50' }],
      columns: [{ name: 'STATUS', kind: 'string' }, { name: 'TOTAL', kind: 'decimal' }],
    });
    expect(t.columns.map((c) => [c.name, c.kind, c.role])).toEqual([
      ['STATUS', 'string', 'category'],
      ['TOTAL', 'decimal', 'measure'],
    ]);
  });

  it('infers kinds from the values when the server sent no columns', () => {
    const t = table({ data: [{ D: '2026-01-31', N: 3, X: 1.5, S: 'a' }] });
    expect(t.columns.map((c) => c.kind)).toEqual(['date', 'int', 'decimal', 'string']);
  });

  it('treats numeric codes as categories and period columns as time', () => {
    const t = table({
      data: [
        { ITEMNO: 100, YEAR: 2025, QTY: 5, AMTPAID: 10 },
        { ITEMNO: 200, YEAR: 2026, QTY: 7, AMTPAID: 12 },
      ],
      columns: [
        { name: 'ITEMNO', kind: 'decimal' },
        { name: 'YEAR', kind: 'int' },
        { name: 'QTY', kind: 'decimal' },
        { name: 'AMTPAID', kind: 'decimal' },
      ],
    });
    expect(roles(t)).toEqual({ ITEMNO: 'category', YEAR: 'time', QTY: 'measure', AMTPAID: 'measure' });
  });

  it('treats YYYYMMDD and, for a date-named column, CYYMMDD numbers as time', () => {
    const t = table({
      data: [
        { ORDDATE: 1260131, SHIPPED: 20260205, AMOUNT: 5 },
        { ORDDATE: 1260201, SHIPPED: 20260210, AMOUNT: 6 },
      ],
      columns: [
        { name: 'ORDDATE', kind: 'decimal' },
        { name: 'SHIPPED', kind: 'decimal' },
        { name: 'AMOUNT', kind: 'decimal' },
      ],
    });
    expect(roles(t)).toEqual({ ORDDATE: 'time', SHIPPED: 'time', AMOUNT: 'measure' });
  });

  it('labels the rows with a leading unique integer column', () => {
    const t = table({
      data: [{ C: 11, V: 1 }, { C: 12, V: 2 }, { C: 13, V: 2 }],
      columns: [{ name: 'C', kind: 'int' }, { name: 'V', kind: 'int' }],
    });
    expect(roles(t)).toEqual({ C: 'category', V: 'measure' });
  });
});

describe('numericDate', () => {
  it('reads YYYYMMDD and CYYMMDD, and rejects impossible dates', () => {
    expect(numericDate(20260131, false)).toBe('2026-01-31');
    expect(numericDate('20260131', false)).toBe('2026-01-31');
    expect(numericDate(1260131, true)).toBe('2026-01-31');
    expect(numericDate(991231, true)).toBe('1999-12-31');
    expect(numericDate(1260131, false)).toBeNull();
    expect(numericDate(20260230, false)).toBeNull();
    expect(numericDate(1001, false)).toBeNull();
  });
});

describe('ruleChart', () => {
  it('draws one row of measures as KPI tiles', () => {
    const t = table({ data: [{ ORDERS: 12, REVENUE: 3400.5 }] });
    expect(ruleChart(t)).toMatchObject({ type: 'kpi', y: ['ORDERS', 'REVENUE'] });
  });

  it('draws a measure over time as a line, split by a small category', () => {
    const data = ['2026-01-01', '2026-02-01', '2026-03-01'].flatMap((MONTH) =>
      ['OPEN', 'SHIPPED'].map((STATUS, i) => ({ MONTH, STATUS, TOTAL: i + 1 })));
    expect(ruleChart(table({ data }))).toMatchObject({ type: 'line', x: 'MONTH', y: ['TOTAL'], series: 'STATUS' });
  });

  it('never splits a line by a column that is unique on each row', () => {
    const data = [1260105, 1260112, 1260119, 1260126].map((ORDDATE, i) => ({ ORDDATE, ORDERNO: 1001 + i, AMOUNT: 5 + i }));
    const plan = ruleChart(table({
      data,
      columns: [{ name: 'ORDDATE', kind: 'decimal' }, { name: 'ORDERNO', kind: 'decimal' }, { name: 'AMOUNT', kind: 'decimal' }],
    }));
    expect(plan).toMatchObject({ type: 'line', x: 'ORDDATE', y: ['AMOUNT'] });
    expect(plan?.series).toBeUndefined();
  });

  it('stacks bars for two categories, the smaller one as series', () => {
    const data = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].flatMap((REGION) =>
      ['OPEN', 'SHIPPED'].map((STATUS) => ({ REGION, STATUS, TOTAL: 1 })));
    expect(ruleChart(table({ data }))).toMatchObject({ type: 'bar', x: 'REGION', series: 'STATUS', stacked: true });
  });

  it('turns a ranking with many categories horizontal', () => {
    const data = Array.from({ length: 15 }, (_, i) => ({ CUSTOMER: `C${i}`, TOTAL: 100 - i }));
    expect(ruleChart(table({ data }))).toMatchObject({ type: 'bar', horizontal: true });
    expect(ruleChart(table({ data: data.slice(0, 5) }))).toMatchObject({ type: 'bar', horizontal: false });
  });

  it('bins a single measure with enough rows, and gives up on text only', () => {
    const data = Array.from({ length: 12 }, (_, i) => ({ AMOUNT: i * 3.5 }));
    expect(ruleChart(table({ data }))).toMatchObject({ type: 'histogram', y: ['AMOUNT'] });
    expect(ruleChart(table({ data: [{ NAME: 'a' }, { NAME: 'b' }] }))).toBeNull();
    expect(ruleChart(table({ data: [] }))).toBeNull();
  });
});

describe('selectChart', () => {
  const ranking = Array.from({ length: 5 }, (_, i) => ({ STATUS: `S${i}`, TOTAL: i + 1 }));

  it('opens on the chart for a small summary, and on the grid for detail rows', () => {
    expect(selectChart(table({ data: ranking })).showChart).toBe(true);
    const detail = ranking.map((row, i) => ({ ...row, A: 'x', B: 'y', C: 'z', ORDERNO: i }));
    const selection = selectChart(table({ data: detail }));
    expect(selection.plan).not.toBeNull();
    expect(selection.showChart).toBe(false);
  });

  it('follows a hint and fills in what it leaves out', () => {
    const selection = selectChart(table({ data: ranking, chart: { type: 'pie' } }));
    expect(selection).toEqual({
      showChart: true,
      plan: { type: 'pie', x: 'STATUS', y: ['TOTAL'], stacked: false, horizontal: false },
    });
  });

  it('opens on the grid for a table hint but keeps a chart in the menu', () => {
    const selection = selectChart(table({ data: ranking, chart: { type: 'table' } }));
    expect(selection.showChart).toBe(false);
    expect(selection.plan?.type).toBe('bar');
  });

  it('falls back to the rules when a hint cannot be drawn', () => {
    const t = table({ data: [{ NAME: 'a' }, { NAME: 'b' }] });
    expect(planFromHint(t, { type: 'bar' })).toBeNull();
    expect(selectChart({ ...t, chart: { type: 'bar' } }).plan).toBeNull();
  });
});

describe('availableTypes', () => {
  it('offers pies only for short results and KPI tiles only for a few rows', () => {
    const short = table({ data: [{ S: 'a', V: 1 }, { S: 'b', V: 2 }] });
    expect(availableTypes(short)).toEqual(expect.arrayContaining(['bar', 'pie', 'kpi']));
    const long = table({ data: Array.from({ length: 60 }, (_, i) => ({ S: `s${i}`, V: i })) });
    expect(availableTypes(long)).not.toContain('pie');
    expect(availableTypes(long)).not.toContain('kpi');
  });
});

describe('histogramBins', () => {
  it('uses round bin edges that cover every value', () => {
    const { edges, counts } = histogramBins([1, 2, 3, 7, 9, 10, 14, 19, 20, 22]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(10);
    expect(edges[0]).toBeLessThanOrEqual(1);
    expect(edges[edges.length - 1]).toBeGreaterThan(22);
    const step = edges[1] - edges[0];
    expect([1, 2, 2.5, 5, 10]).toContain(step);
  });

  it('puts equal values in one bin', () => {
    expect(histogramBins([4, 4, 4])).toEqual({ edges: [4, 5], counts: [3] });
  });
});

describe('buildChart', () => {
  const ctx = { theme: themeFor('light'), fonts: fallbackFonts, locale: 'en-US' };

  it('folds categories past the sixth series into Other', () => {
    const data = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((STATUS, i) => ({ STATUS, TOTAL: 10 - i }));
    const t = table({ data });
    const built = buildChart(t, { type: 'pie', x: 'STATUS', y: ['TOTAL'], stacked: false, horizontal: false }, ctx);
    expect(built.kind).toBe('chart');
    if (built.kind !== 'chart') return;
    expect(built.config.data.labels).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'Other']);
    expect(built.config.data.datasets[0].data).toEqual([10, 9, 8, 7, 6, 5, 7]);
  });

  it('builds KPI tiles from one row', () => {
    const t = table({ data: [{ ORDERS: 12 }] });
    const built = buildChart(t, { type: 'kpi', y: ['ORDERS'], stacked: false, horizontal: false }, ctx);
    expect(built).toMatchObject({ kind: 'kpi', items: [{ label: 'ORDERS' }] });
  });

  it('ends a waterfall with a total bar', () => {
    const data = [{ STEP: 'Start', AMOUNT: 100 }, { STEP: 'Sales', AMOUNT: 40 }, { STEP: 'Returns', AMOUNT: -15 }];
    const built = buildChart(table({ data }), { type: 'waterfall', x: 'STEP', y: ['AMOUNT'], stacked: false, horizontal: false }, ctx);
    expect(built.kind).toBe('chart');
    if (built.kind !== 'chart') return;
    expect(built.config.data.labels).toEqual(['Start', 'Sales', 'Returns', 'End']);
  });
});

describe('bridge', () => {
  function fakeHost() {
    const sent: Array<Record<string, unknown>> = [];
    let listener: ((event: { source: unknown; data: unknown }) => void) | undefined;
    const host = { postMessage: vi.fn((message: Record<string, unknown>) => sent.push(message)) };
    const source = {
      addEventListener: vi.fn((_: string, fn: (event: { source: unknown; data: unknown }) => void) => {
        listener = fn;
      }),
      removeEventListener: vi.fn(() => {
        listener = undefined;
      }),
    };
    const deliver = (data: unknown, from: unknown = host) => listener?.({ source: from, data });
    return { host, source, sent, deliver, listening: () => listener !== undefined };
  }

  it('does the handshake, then passes tool results and context changes on', async () => {
    const { host, source, sent, deliver, listening } = fakeHost();
    const onToolResult = vi.fn();
    const onHostContext = vi.fn();
    const connecting = connect(host, { name: 'test', version: '1.0.0' }, { onToolResult, onHostContext }, source as never);

    expect(sent[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      method: 'ui/initialize',
      params: { protocolVersion: PROTOCOL_VERSION, appInfo: { name: 'test', version: '1.0.0' } },
    });
    deliver({ jsonrpc: '2.0', id: 1, result: { protocolVersion: PROTOCOL_VERSION, hostContext: { theme: 'dark' } } });
    const bridge = await connecting;
    expect(onHostContext).toHaveBeenCalledWith({ theme: 'dark' });
    expect(sent[1]).toMatchObject({ method: 'ui/notifications/initialized' });

    const result = { content: [], structuredContent: { success: true, data: [] } };
    deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result });
    expect(onToolResult).toHaveBeenCalledWith(result);

    bridge.sizeChanged(120.2);
    expect(sent[2]).toMatchObject({ method: 'ui/notifications/size-changed', params: { height: 121 } });

    bridge.close();
    expect(listening()).toBe(false);
  });

  it('answers ping and teardown, refuses unknown requests, and ignores other windows', async () => {
    const { host, source, sent, deliver } = fakeHost();
    const onToolResult = vi.fn();
    const connecting = connect(host, { name: 'test', version: '1.0.0' }, { onToolResult }, source as never);
    deliver({ jsonrpc: '2.0', id: 1, result: {} });
    await connecting;

    deliver({ jsonrpc: '2.0', id: 'p', method: 'ping' });
    deliver({ jsonrpc: '2.0', id: 't', method: 'ui/resource-teardown', params: {} });
    deliver({ jsonrpc: '2.0', id: 'u', method: 'tools/call', params: {} });
    expect(sent.slice(-3)).toEqual([
      { jsonrpc: '2.0', id: 'p', result: {} },
      { jsonrpc: '2.0', id: 't', result: {} },
      { jsonrpc: '2.0', id: 'u', error: { code: -32601, message: 'Method not found: tools/call' } },
    ]);

    deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: {} }, { other: true });
    expect(onToolResult).not.toHaveBeenCalled();
  });

  it('rejects when the host refuses the handshake', async () => {
    const { host, source, deliver } = fakeHost();
    const connecting = connect(host, { name: 'test', version: '1.0.0' }, {}, source as never);
    deliver({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'unsupported version' } });
    await expect(connecting).rejects.toThrow('unsupported version');
  });
});
