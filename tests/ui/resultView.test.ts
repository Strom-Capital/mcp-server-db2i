/**
 * The result view (ui://db2i/result) through a client: the resource, the tool
 * metadata that points hosts at it, result columns, and chart hints from
 * execute_query and from a YAML tool's chart: block.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/client';

const mockQuery = vi.fn();
vi.mock('node-jt400', async () => {
  const { withExecute } = await import('../helpers/jt400Fake.js');
  return { pool: vi.fn(() => withExecute({ query: mockQuery })) };
});

vi.mock('../../src/utils/rateLimiter.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/utils/rateLimiter.js')>();
  return {
    ...original,
    getRateLimiter: vi.fn(() => ({
      checkLimit: vi.fn(() => ({ allowed: true, remaining: 99 })),
      formatError: vi.fn(() => ({ error: 'Rate limit exceeded', waitTimeSeconds: 60, limit: 100, windowMs: 900000 })),
    })),
  };
});

import { loadCustomTools } from '../../src/customTools/loader.js';
import { resetCustomTools, setCustomTools } from '../../src/customTools/registry.js';
import { initializePool } from '../../src/db/connection.js';
import { createServer } from '../../src/server.js';
import { chartSpecSchema, resultColumns, resultViewFields } from '../../src/ui/chartSpec.js';
import { MCP_APP_MIME_TYPE, RESULT_VIEW_URI } from '../../src/ui/resultView.js';

const ROWS = [
  { STATUS: 'OPEN', TOTAL: 120 },
  { STATUS: 'SHIPPED', TOTAL: 340 },
];

const CHART_TOOL_YAML = [
  'version: 1',
  'tools:',
  '  - name: orders_by_status',
  '    title: Orders by status',
  '    description: Order totals by status',
  '    chart:',
  '      type: pie',
  '      x: status',
  '      y: [total]',
  '    sql: SELECT STATUS, SUM(AMOUNT) AS TOTAL FROM MYLIB.ORDERS GROUP BY STATUS',
  '',
].join('\n');

describe('result view', () => {
  const originalEnv = process.env;
  let client: Client | undefined;
  let toolsDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockReset();
    mockQuery.mockResolvedValue(ROWS);
    process.env = {
      ...originalEnv,
      DB2I_HOSTNAME: 'ibmi.example.com',
      DB2I_DRIVER: 'jt400',
      DB2I_USERNAME: 'test-user',
      DB2I_PASSWORD: 'test-pass',
      DB2I_SCHEMA: 'MYLIB',
      QUERY_PARSE_CHECK: 'false',
      QUERY_ALLOWED_SCHEMAS: 'MYLIB',
      MCP_RESPONSE_FORMAT: 'json',
    };
    delete process.env.MCP_TOOLS_ENABLED;
    delete process.env.MCP_TOOLS_DISABLED;
    delete process.env.MCP_CUSTOM_TOOLS;
    delete process.env.MCP_UI_ENABLED;

    toolsDir = mkdtempSync(path.join(tmpdir(), 'db2i-ui-'));
    writeFileSync(path.join(toolsDir, 'tools.yaml'), CHART_TOOL_YAML);
    setCustomTools(loadCustomTools([toolsDir], { allowedSchemas: ['MYLIB'], defaultSchema: 'MYLIB' }));

    initializePool({
      hostname: 'ibmi.example.com',
      port: 446,
      username: 'test-user',
      password: 'test-pass',
      database: '*LOCAL',
      schema: 'MYLIB',
      driver: 'jt400',
      jdbcOptions: {},
      odbcOptions: {},
    });
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    process.env = originalEnv;
    resetCustomTools();
    rmSync(toolsDir, { recursive: true, force: true });
  });

  async function connect(): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverTransport);
    client = new Client({ name: 'result-view-test', version: '1.0.0' });
    await client.connect(clientTransport);
    return client;
  }

  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = (await (client ?? (await connect())).callTool({ name, arguments: args })) as CallToolResult;
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result.structuredContent as Record<string, unknown>;
  }

  it('serves one self-contained HTML page as an MCP Apps resource', async () => {
    const mcp = await connect();
    const { resources } = await mcp.listResources();
    expect(resources.find((r) => r.uri === RESULT_VIEW_URI)).toMatchObject({ mimeType: MCP_APP_MIME_TYPE });

    const { contents } = await mcp.readResource({ uri: RESULT_VIEW_URI });
    expect(contents).toHaveLength(1);
    const [page] = contents as Array<{ mimeType: string; text: string; _meta?: Record<string, unknown> }>;
    expect(page.mimeType).toBe(MCP_APP_MIME_TYPE);
    expect(page._meta).toEqual({ ui: { prefersBorder: true } });
    expect(page.text).toMatch(/^<!doctype html>/i);
    expect(page.text).toContain('<div id="app">');
    expect(page.text).not.toMatch(/<script[^>]+src=/i);
    expect(page.text).not.toMatch(/<link[^>]+href=/i);
    expect(Buffer.byteLength(page.text)).toBeLessThan(400 * 1024);
  });

  it('points execute_query, profile_table and YAML tools at the view', async () => {
    const { tools } = await (await connect()).listTools();
    for (const name of ['execute_query', 'profile_table', 'orders_by_status']) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?._meta, name).toMatchObject({ ui: { resourceUri: RESULT_VIEW_URI }, 'ui/resourceUri': RESULT_VIEW_URI });
    }
    expect(tools.find((t) => t.name === 'list_tables')?._meta?.ui).toBeUndefined();
    const executeQuery = tools.find((t) => t.name === 'execute_query');
    expect(executeQuery?.inputSchema.properties).toHaveProperty('chart');
    expect(executeQuery?.description).toContain('Pass chart');
  });

  it('returns columns and the chart hint with the result spelling of each column', async () => {
    const result = await call('execute_query', {
      sql: 'SELECT STATUS, SUM(AMOUNT) AS TOTAL FROM MYLIB.ORDERS GROUP BY STATUS',
      chart: { type: 'bar', x: 'status', y: ['total'], horizontal: true },
    });
    expect(result.columns).toEqual([{ name: 'STATUS', kind: 'string' }, { name: 'TOTAL', kind: 'string' }]);
    expect(result.chart).toEqual({ type: 'bar', x: 'STATUS', y: ['TOTAL'], horizontal: true });
    expect(result.chartError).toBeUndefined();
  });

  it('drops a chart hint that names a column the result lacks, and says why', async () => {
    const result = await call('execute_query', {
      sql: 'SELECT STATUS, SUM(AMOUNT) AS TOTAL FROM MYLIB.ORDERS GROUP BY STATUS',
      chart: { type: 'line', x: 'ORDDATE', y: ['TOTAL'] },
    });
    expect(result.chart).toBeUndefined();
    expect(result.chartError).toBe('Chart columns not in the result: ORDDATE. Result columns: STATUS, TOTAL.');
    expect(result.data).toEqual(ROWS);
  });

  it('refuses an unknown chart type or field before running the query', async () => {
    const mcp = await connect();
    const result = (await mcp.callTool({
      name: 'execute_query',
      arguments: { sql: 'SELECT STATUS FROM MYLIB.ORDERS', chart: { type: 'radar' } },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns a YAML tool chart: block with its result', async () => {
    const result = await call('orders_by_status', {});
    expect(result.chart).toEqual({ type: 'pie', x: 'STATUS', y: ['TOTAL'] });
    expect(result.columns).toHaveLength(2);
  });

  it('leaves out the tool metadata, the chart argument and the resource with MCP_UI_ENABLED=false', async () => {
    process.env.MCP_UI_ENABLED = 'false';
    const mcp = await connect();
    const { tools } = await mcp.listTools();
    const executeQuery = tools.find((t) => t.name === 'execute_query');
    expect(executeQuery?._meta?.ui).toBeUndefined();
    expect(executeQuery?._meta?.['ui/resourceUri']).toBeUndefined();
    expect(executeQuery?.inputSchema.properties).not.toHaveProperty('chart');
    expect(tools.find((t) => t.name === 'orders_by_status')?._meta?.ui).toBeUndefined();
    const { resources } = await mcp.listResources();
    expect(resources.map((r) => r.uri)).not.toContain(RESULT_VIEW_URI);

    const result = await call('execute_query', { sql: 'SELECT STATUS FROM MYLIB.ORDERS' });
    expect(result.columns).toBeDefined();
  });
});

describe('chart: block in YAML', () => {
  function load(chart: string[]): () => unknown {
    const dir = mkdtempSync(path.join(tmpdir(), 'db2i-ui-yaml-'));
    writeFileSync(path.join(dir, 'tools.yaml'), [
      'version: 1',
      'tools:',
      '  - name: orders_by_status',
      '    title: Orders by status',
      '    description: Order totals by status',
      '    chart:',
      ...chart.map((line) => `      ${line}`),
      '    sql: SELECT STATUS, COUNT(*) AS N FROM MYLIB.ORDERS GROUP BY STATUS',
      '',
    ].join('\n'));
    return () => {
      try {
        return loadCustomTools([dir], { allowedSchemas: ['MYLIB'], defaultSchema: 'MYLIB' });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
  }

  it('is stored on the tool', () => {
    const loaded = load(['type: bar', 'x: STATUS', 'stacked: true'])() as ReturnType<typeof loadCustomTools>;
    expect(loaded.tools[0].chart).toEqual({ type: 'bar', x: 'STATUS', stacked: true });
  });

  it('rejects an unknown type or field', () => {
    expect(load(['type: radar'])).toThrow();
    expect(load(['type: bar', 'colour: red'])).toThrow();
  });
});

describe('chart hints and columns', () => {
  it('rejects fields the schema does not know', () => {
    expect(chartSpecSchema.safeParse({ type: 'bar', x: 'STATUS' }).success).toBe(true);
    expect(chartSpecSchema.safeParse({ type: 'bar', color: 'red' }).success).toBe(false);
    expect(chartSpecSchema.safeParse({ type: 'bar', y: [] }).success).toBe(false);
  });

  it('lists a duplicate name once with the kind of the value rows hold, and masked columns as text', () => {
    const columns = resultColumns(
      [
        { name: 'ITEMNO', kind: 'string', dbType: 'CHAR' },
        { name: 'PRICE', kind: 'decimal', dbType: 'DECIMAL' },
        { name: 'ITEMNO', kind: 'decimal', dbType: 'DECIMAL' },
      ],
      new Set(['PRICE']),
    );
    expect(columns).toEqual([{ name: 'ITEMNO', kind: 'decimal' }, { name: 'PRICE', kind: 'string' }]);
    expect(resultColumns(undefined)).toBeUndefined();
  });

  it('passes a table hint through without columns', () => {
    expect(resultViewFields(undefined, new Set(), { type: 'table' })).toEqual({ chart: { type: 'table' } });
    expect(resultViewFields(undefined, new Set(), { type: 'bar', x: 'A' })).toEqual({
      chartError: 'The result has no column information.',
    });
  });
});
