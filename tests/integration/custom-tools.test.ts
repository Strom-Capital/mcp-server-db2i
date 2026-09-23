/**
 * Custom business tools registered from the example ERP pack.
 * Database calls go through the mocked JT400 pool.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/client';

const mockQuery = vi.fn();
vi.mock('node-jt400', () => ({
  pool: vi.fn(() => ({
    query: mockQuery,
  })),
}));

vi.mock('../../src/utils/rateLimiter.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/utils/rateLimiter.js')>();
  return {
    ...original,
    getRateLimiter: vi.fn(() => ({
      checkLimit: vi.fn(() => ({ allowed: true, remaining: 99 })),
      formatError: vi.fn(() => ({
        error: 'Rate limit exceeded',
        waitTimeSeconds: 60,
        limit: 100,
        windowMs: 900000,
      })),
    })),
  };
});

import { TOOL_NAMES } from '../../src/config.js';
import { loadCustomTools } from '../../src/customTools/loader.js';
import { resetCustomTools, setCustomTools } from '../../src/customTools/registry.js';
import { initializePool } from '../../src/db/connection.js';
import { createServer } from '../../src/server.js';

function textOf(result: CallToolResult): string {
  return (result.content[0] as { type: 'text'; text: string }).text;
}

describe('Custom ERP tools', () => {
  let client: Client;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;
  const originalEnv = process.env;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockQuery.mockReset();
    process.env = {
      ...originalEnv,
      DB2I_HOSTNAME: 'ibmi.example.com',
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

    setCustomTools(loadCustomTools(['examples/erp-tools'], {
      allowedSchemas: ['MYLIB'],
      defaultSchema: 'MYLIB',
    }));

    initializePool({
      hostname: 'ibmi.example.com',
      port: 446,
      username: 'test-user',
      password: 'test-pass',
      database: '*LOCAL',
      schema: 'MYLIB',
      jdbcOptions: {},
    });

    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(serverTransport);
    client = new Client({ name: 'custom-tools-test', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    process.env = originalEnv;
    resetCustomTools();
    await client.close();
    await clientTransport.close();
    await serverTransport.close();
  });

  it('registers the example pack as read-only tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toContain('search_sales_orders');
    expect(names).toContain('explode_bill_of_materials');
    expect(names).toContain('get_gl_balance');
    expect(names.length).toBeGreaterThan(TOOL_NAMES.length);

    const search = tools.find((tool) => tool.name === 'search_sales_orders');
    expect(search?.annotations?.readOnlyHint).toBe(true);
    expect(search?.description).toContain('customer');
  });

  it('runs a sales-order search with bound parameters', async () => {
    mockQuery.mockResolvedValueOnce([
      { ORDERNO: 1001, CUSTNO: '1001', ORDERDATE: '2024-01-15', STATUS: 'O' },
    ]);

    const result = await client.callTool({
      name: 'search_sales_orders',
      arguments: { text: '1001' },
    }) as CallToolResult;

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(textOf(result)) as { success: boolean; rowCount: number; limitApplied: number };
    expect(body.success).toBe(true);
    expect(body.rowCount).toBe(1);
    expect(body.limitApplied).toBe(50);

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('MYLIB.ORDERHDR');
    expect(sql).toContain('FETCH FIRST 50 ROWS ONLY');
    expect(params).toContain('1001');
  });

  it('returns annotations from get_business_context and describe_table', async () => {
    const context = await client.callTool({
      name: 'get_business_context',
      arguments: { entity: 'sales_order' },
    }) as CallToolResult;
    const contextBody = JSON.parse(textOf(context)) as {
      data: Array<{ table: string; relations: unknown[] }>;
    };
    expect(contextBody.data).toEqual([
      expect.objectContaining({
        table: 'MYLIB.ORDERHDR',
        entity: 'sales_order',
      }),
    ]);
    expect(contextBody.data[0].relations.length).toBeGreaterThan(0);

    mockQuery.mockResolvedValueOnce([
      {
        COLUMN_NAME: 'STATUS',
        ORDINAL_POSITION: 1,
        DATA_TYPE: 'CHAR',
        LENGTH: 1,
        NUMERIC_SCALE: null,
        IS_NULLABLE: 'N',
        COLUMN_DEFAULT: null,
        COLUMN_TEXT: 'Status',
        SYSTEM_COLUMN_NAME: 'STATUS',
        CCSID: 37,
      },
    ]);

    const described = await client.callTool({
      name: 'describe_table',
      arguments: { schema: 'MYLIB', table: 'ORDERHDR' },
    }) as CallToolResult;
    const describedBody = JSON.parse(textOf(described)) as {
      business_description: string;
      relations: unknown[];
      data: Array<{ column_name: string; business_description?: string }>;
    };
    expect(describedBody.business_description).toContain('Sales order header');
    expect(describedBody.relations.length).toBeGreaterThan(0);
    expect(describedBody.data[0].business_description).toContain('open');
  });

  it('adds a business description when listing tables', async () => {
    mockQuery.mockResolvedValueOnce([
      { TABLE_NAME: 'ORDERHDR', TABLE_TYPE: 'T', TABLE_TEXT: 'Orders' },
      { TABLE_NAME: 'NOTANNOTATED', TABLE_TYPE: 'T', TABLE_TEXT: null },
    ]);

    const result = await client.callTool({
      name: 'list_tables',
      arguments: { schema: 'MYLIB' },
    }) as CallToolResult;
    const body = JSON.parse(textOf(result)) as {
      data: Array<{ table_name: string; business_description?: string }>;
    };

    expect(body.data[0].business_description).toContain('Sales order header');
    expect(body.data[1].business_description).toBeUndefined();
  });

  it('limits registration to one toolset', async () => {
    process.env.MCP_TOOLS_ENABLED = 'toolset:sales,get_business_context';

    const [filteredClientTransport, filteredServerTransport] = InMemoryTransport.createLinkedPair();
    const filteredServer = createServer();
    await filteredServer.connect(filteredServerTransport);
    const filteredClient = new Client({ name: 'filtered-custom', version: '1.0.0' });
    await filteredClient.connect(filteredClientTransport);

    const { tools } = await filteredClient.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('search_sales_orders');
    expect(names).toContain('get_business_context');
    expect(names).not.toContain('execute_query');
    expect(names).not.toContain('list_purchase_orders');

    await filteredClient.close();
    await filteredClientTransport.close();
    await filteredServerTransport.close();
  });
});
