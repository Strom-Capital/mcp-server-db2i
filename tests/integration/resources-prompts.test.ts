/**
 * MCP resources and prompts, through InMemoryTransport with a mocked JT400 pool.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

const mockQuery = vi.fn();
vi.mock('node-jt400', () => ({
  pool: vi.fn(() => ({
    query: mockQuery,
  })),
}));

const checkLimit = vi.fn(() => ({ allowed: true, remaining: 99 }));
vi.mock('../../src/utils/rateLimiter.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/utils/rateLimiter.js')>();
  return {
    ...original,
    getRateLimiter: vi.fn(() => ({
      checkLimit,
      formatError: vi.fn(() => ({
        error: 'Rate limit exceeded',
        waitTimeSeconds: 60,
        limit: 100,
        windowMs: 900000,
      })),
    })),
  };
});

import { resetCustomTools, setCustomTools } from '../../src/customTools/registry.js';
import { initializePool } from '../../src/db/connection.js';
import { clearCompletionCache } from '../../src/resources.js';
import { createServer } from '../../src/server.js';
import { closeAuditLog, initAuditLog } from '../../src/utils/auditLog.js';

const ORDER_COLUMNS = [
  {
    COLUMN_NAME: 'ORDERNO',
    ORDINAL_POSITION: 1,
    DATA_TYPE: 'DECIMAL',
    LENGTH: 9,
    NUMERIC_SCALE: 0,
    IS_NULLABLE: 'N',
    COLUMN_DEFAULT: null,
    COLUMN_TEXT: 'Order number',
    SYSTEM_COLUMN_NAME: 'ORDERNO',
    CCSID: null,
  },
  {
    COLUMN_NAME: 'ITEMNO',
    ORDINAL_POSITION: 2,
    DATA_TYPE: 'CHAR',
    LENGTH: 15,
    NUMERIC_SCALE: null,
    IS_NULLABLE: 'Y',
    COLUMN_DEFAULT: null,
    COLUMN_TEXT: 'Item',
    SYSTEM_COLUMN_NAME: 'ITEMNO',
    CCSID: 37,
  },
];

function annotate(): void {
  setCustomTools({
    tools: [],
    masking: new Map(),
    annotations: [
      {
        table: 'MYLIB.ORDERS',
        entity: 'sales_order',
        description: 'Sales order lines',
        columns: { ITEMNO: 'Item sold on the line' },
        relations: [
          { table: 'MYLIB.CUSTOMERS', join: { CUSTNO: 'CUSTNO' }, cardinality: 'many-to-one', description: 'Ordering customer' },
        ],
      },
      {
        table: 'OTHERLIB.ORDERHDR',
        description: 'Order headers',
        columns: {},
        relations: [],
      },
    ],
  });
}

function textOf(result: { contents: Array<{ text?: string } | { blob?: string }> }): string {
  const first = result.contents[0] as { text?: string };
  return first.text ?? '';
}

describe('MCP resources and prompts', () => {
  let client: Client;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;
  const originalEnv = process.env;

  async function connect(): Promise<void> {
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(serverTransport);
    client = new Client({ name: 'resources-test', version: '1.0.0' });
    await client.connect(clientTransport);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mockQuery.mockReset();
    checkLimit.mockImplementation(() => ({ allowed: true, remaining: 99 }));
    clearCompletionCache();
    process.env = {
      ...originalEnv,
      DB2I_HOSTNAME: 'ibmi.example.com',
      DB2I_USERNAME: 'test-user',
      DB2I_PASSWORD: 'test-pass',
      DB2I_SCHEMA: 'MYLIB',
      QUERY_PARSE_CHECK: 'false',
      MCP_RESPONSE_FORMAT: 'json',
    };
    delete process.env.MCP_TOOLS_ENABLED;
    delete process.env.MCP_TOOLS_DISABLED;
    delete process.env.QUERY_ALLOWED_SCHEMAS;
    annotate();

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

    await connect();
  });

  afterEach(async () => {
    process.env = originalEnv;
    resetCustomTools();
    await client.close();
    await clientTransport.close();
    await serverTransport.close();
  });

  describe('registration', () => {
    it('registers the table templates and the business context resource', async () => {
      const { resourceTemplates } = await client.listResourceTemplates();
      expect(resourceTemplates.map((template) => template.uriTemplate).sort()).toEqual([
        'db2i://{schema}/{table}',
        'db2i://{schema}/{table}/ddl',
      ]);

      const { resources } = await client.listResources();
      const uris = resources.map((resource) => resource.uri);
      expect(uris).toContain('db2i://business-context');
      expect(uris).toContain('db2i://MYLIB/ORDERS');
      expect(uris).toContain('db2i://OTHERLIB/ORDERHDR');
    });

    it('lists only annotated tables inside QUERY_ALLOWED_SCHEMAS', async () => {
      process.env.QUERY_ALLOWED_SCHEMAS = 'MYLIB';
      const { resources } = await client.listResources();
      const uris = resources.map((resource) => resource.uri);
      expect(uris).toContain('db2i://MYLIB/ORDERS');
      expect(uris).not.toContain('db2i://OTHERLIB/ORDERHDR');
    });

    it('drops a resource when the tool it draws on is disabled', async () => {
      process.env.MCP_TOOLS_DISABLED = 'get_object_ddl,get_business_context';
      await client.close();
      await connect();

      const { resourceTemplates } = await client.listResourceTemplates();
      expect(resourceTemplates.map((template) => template.uriTemplate)).toEqual(['db2i://{schema}/{table}']);
      const { resources } = await client.listResources();
      expect(resources.map((resource) => resource.uri)).not.toContain('db2i://business-context');
    });

    it('registers no resources or prompts when only execute_query is enabled', async () => {
      process.env.MCP_TOOLS_ENABLED = 'execute_query';
      await client.close();
      await connect();

      expect(client.getServerCapabilities()?.resources).toBeUndefined();
      expect(client.getServerCapabilities()?.prompts).toBeUndefined();
    });

    it('lists the three prompts', async () => {
      const { prompts } = await client.listPrompts();
      expect(prompts.map((prompt) => prompt.name).sort()).toEqual(['explain_table', 'explore_library', 'write_query']);
    });

    it('drops explore_library when list_tables is disabled', async () => {
      process.env.MCP_TOOLS_DISABLED = 'list_tables';
      await client.close();
      await connect();

      const { prompts } = await client.listPrompts();
      expect(prompts.map((prompt) => prompt.name).sort()).toEqual(['explain_table', 'write_query']);
    });
  });

  describe('db2i://{schema}/{table}', () => {
    it('returns catalog columns with YAML notes and relations', async () => {
      mockQuery.mockResolvedValueOnce(ORDER_COLUMNS);

      const result = await client.readResource({ uri: 'db2i://mylib/orders' });
      expect(result.contents[0]).toMatchObject({ uri: 'db2i://mylib/orders', mimeType: 'application/json' });

      const body = JSON.parse(textOf(result));
      expect(body).toMatchObject({
        schema: 'MYLIB',
        table: 'ORDERS',
        entity: 'sales_order',
        business_description: 'Sales order lines',
        relations: [{ table: 'MYLIB.CUSTOMERS' }],
      });
      expect(body.columns).toHaveLength(2);
      expect(body.columns[1]).toMatchObject({ column_name: 'ITEMNO', business_description: 'Item sold on the line' });
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('SYSCOLUMNS'), expect.arrayContaining(['MYLIB', 'ORDERS']));
    });

    it('decodes percent-encoded names', async () => {
      mockQuery.mockResolvedValueOnce(ORDER_COLUMNS);
      await client.readResource({ uri: 'db2i://MYLIB/ORD%23X' });
      expect(mockQuery).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['ORD#X']));
    });

    it('rejects a library outside QUERY_ALLOWED_SCHEMAS without querying', async () => {
      process.env.QUERY_ALLOWED_SCHEMAS = 'MYLIB';
      await expect(client.readResource({ uri: 'db2i://OTHERLIB/ORDERHDR' })).rejects.toThrow(
        'Schema OTHERLIB is not in QUERY_ALLOWED_SCHEMAS (MYLIB).',
      );
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('reports a missing table as not found', async () => {
      mockQuery.mockResolvedValueOnce([]);
      await expect(client.readResource({ uri: 'db2i://MYLIB/NOPE' })).rejects.toThrow('MYLIB.NOPE was not found');
    });

    it('records the read in the audit log', async () => {
      process.env.MCP_AUDIT_LOG = 'stderr';
      initAuditLog();
      const writes: string[] = [];
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
      mockQuery.mockResolvedValueOnce(ORDER_COLUMNS);

      try {
        await client.readResource({ uri: 'db2i://MYLIB/ORDERS' });
      } finally {
        spy.mockRestore();
        closeAuditLog();
      }

      const entry = JSON.parse(writes.find((line) => line.includes('resource:table')) ?? '{}');
      expect(entry).toMatchObject({
        tool: 'resource:table',
        identity: 'stdio',
        sql: null,
        args: { schema: 'MYLIB', table: 'ORDERS' },
        outcome: 'success',
        rowCount: 2,
      });
    });

    it('fails when the rate limit is exhausted, before querying', async () => {
      checkLimit.mockImplementation(() => ({ allowed: false, remaining: 0 }));
      await expect(client.readResource({ uri: 'db2i://MYLIB/ORDERS' })).rejects.toThrow('Rate limit exceeded');
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('db2i://{schema}/{table}/ddl', () => {
    it('generates DDL with the object type from the catalog', async () => {
      mockQuery
        .mockResolvedValueOnce([{ TABLE_NAME: 'ORDERS_V', TABLE_TYPE: 'V', TABLE_TEXT: null }])
        .mockResolvedValueOnce([
          { SRCSEQ: 1, SRCDTA: 'CREATE VIEW MYLIB.ORDERS_V AS' },
          { SRCSEQ: 2, SRCDTA: '  SELECT ORDERNO FROM MYLIB.ORDERS;' },
        ]);

      const result = await client.readResource({ uri: 'db2i://MYLIB/ORDERS_V/ddl' });
      expect(result.contents[0]).toMatchObject({ mimeType: 'application/sql' });
      expect(textOf(result)).toBe('CREATE VIEW MYLIB.ORDERS_V AS\n  SELECT ORDERNO FROM MYLIB.ORDERS;');
      expect(mockQuery).toHaveBeenLastCalledWith(expect.stringContaining("DATABASE_OBJECT_TYPE => 'VIEW'"), []);
    });

    it('generates a DDS logical file as a view', async () => {
      mockQuery
        .mockResolvedValueOnce([{ TABLE_NAME: 'ORDERSL1', TABLE_TYPE: 'L', TABLE_TEXT: null }])
        .mockResolvedValueOnce([{ SRCSEQ: 1, SRCDTA: 'CREATE VIEW MYLIB.ORDERSL1 AS SELECT ORDERNO FROM MYLIB.ORDERS;' }]);

      await client.readResource({ uri: 'db2i://MYLIB/ORDERSL1/ddl' });
      expect(mockQuery).toHaveBeenLastCalledWith(expect.stringContaining("DATABASE_OBJECT_TYPE => 'VIEW'"), []);
    });

    it('generates a physical file as a table', async () => {
      mockQuery
        .mockResolvedValueOnce([{ TABLE_NAME: 'ORDERS', TABLE_TYPE: 'P', TABLE_TEXT: null }])
        .mockResolvedValueOnce([{ SRCSEQ: 1, SRCDTA: 'CREATE TABLE MYLIB.ORDERS (ORDERNO DECIMAL(9, 0));' }]);

      await client.readResource({ uri: 'db2i://MYLIB/ORDERS/ddl' });
      expect(mockQuery).toHaveBeenLastCalledWith(expect.stringContaining("DATABASE_OBJECT_TYPE => 'TABLE'"), []);
    });

    it('reports a missing table as not found', async () => {
      mockQuery.mockResolvedValueOnce([{ TABLE_NAME: 'ORDERS_OLD', TABLE_TYPE: 'T', TABLE_TEXT: null }]);
      await expect(client.readResource({ uri: 'db2i://MYLIB/ORDERS/ddl' })).rejects.toThrow('MYLIB.ORDERS was not found');
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('rejects a library outside QUERY_ALLOWED_SCHEMAS', async () => {
      process.env.QUERY_ALLOWED_SCHEMAS = 'MYLIB';
      await expect(client.readResource({ uri: 'db2i://OTHERLIB/ORDERHDR/ddl' })).rejects.toThrow('QUERY_ALLOWED_SCHEMAS');
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('db2i://business-context', () => {
    it('returns every loaded annotation without querying', async () => {
      const result = await client.readResource({ uri: 'db2i://business-context' });
      const body = JSON.parse(textOf(result));
      expect(body.count).toBe(2);
      expect(body.data[0]).toMatchObject({ table: 'MYLIB.ORDERS', entity: 'sales_order' });
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('completion', () => {
    it('completes schemas from QUERY_ALLOWED_SCHEMAS without querying', async () => {
      process.env.QUERY_ALLOWED_SCHEMAS = 'MYLIB,MYLIB2,QSYS2';
      const result = await client.complete({
        ref: { type: 'ref/resource', uri: 'db2i://{schema}/{table}' },
        argument: { name: 'schema', value: 'my' },
      });
      expect(result.completion.values).toEqual(['MYLIB', 'MYLIB2']);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('completes schemas from the catalog when no allowlist is set', async () => {
      mockQuery.mockResolvedValueOnce([
        { SCHEMA_NAME: 'MYLIB', SCHEMA_TEXT: null },
        { SCHEMA_NAME: 'OTHERLIB', SCHEMA_TEXT: null },
      ]);
      const result = await client.complete({
        ref: { type: 'ref/resource', uri: 'db2i://{schema}/{table}' },
        argument: { name: 'schema', value: 'MY' },
      });
      expect(result.completion.values).toEqual(['MYLIB']);
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('SYSSCHEMAS'), ['%']);
    });

    it('completes tables in the schema already chosen', async () => {
      mockQuery.mockResolvedValueOnce([
        { TABLE_NAME: 'CUSTOMERS', TABLE_TYPE: 'T', TABLE_TEXT: null },
        { TABLE_NAME: 'ORDERS', TABLE_TYPE: 'T', TABLE_TEXT: null },
      ]);
      const result = await client.complete({
        ref: { type: 'ref/prompt', name: 'explain_table' },
        argument: { name: 'table', value: 'ord' },
        context: { arguments: { schema: 'mylib' } },
      });
      expect(result.completion.values).toEqual(['ORDERS']);
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('SYSTABLES'), ['MYLIB', '%']);
    });

    it('answers later keystrokes from the cache', async () => {
      mockQuery.mockResolvedValueOnce([
        { TABLE_NAME: 'ORDERHDR', TABLE_TYPE: 'T', TABLE_TEXT: null },
        { TABLE_NAME: 'ORDERS', TABLE_TYPE: 'T', TABLE_TEXT: null },
      ]);
      const ask = (value: string) =>
        client.complete({
          ref: { type: 'ref/resource', uri: 'db2i://{schema}/{table}' },
          argument: { name: 'table', value },
          context: { arguments: { schema: 'MYLIB' } },
        });

      expect((await ask('O')).completion.values).toEqual(['ORDERHDR', 'ORDERS']);
      expect((await ask('ORDERS')).completion.values).toEqual(['ORDERS']);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(checkLimit).toHaveBeenCalledTimes(1);
    });

    it('offers nothing when the rate limit is used up', async () => {
      checkLimit.mockImplementation(() => ({ allowed: false, remaining: 0 }));
      const result = await client.complete({
        ref: { type: 'ref/resource', uri: 'db2i://{schema}/{table}' },
        argument: { name: 'schema', value: 'MY' },
      });
      expect(result.completion.values).toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('offers no tables for a library outside QUERY_ALLOWED_SCHEMAS', async () => {
      process.env.QUERY_ALLOWED_SCHEMAS = 'MYLIB';
      const result = await client.complete({
        ref: { type: 'ref/resource', uri: 'db2i://{schema}/{table}' },
        argument: { name: 'table', value: '' },
        context: { arguments: { schema: 'OTHERLIB' } },
      });
      expect(result.completion.values).toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('prompts', () => {
    function promptText(result: { messages: Array<{ content: unknown }> }): string {
      return (result.messages[0].content as { type: 'text'; text: string }).text;
    }

    it('explore_library names the tools to call and stays read-only', async () => {
      const result = await client.getPrompt({ name: 'explore_library', arguments: { schema: 'mylib' } });
      const text = promptText(result);
      expect(text).toContain('list_tables with schema "MYLIB"');
      expect(text).toContain('describe_table');
      expect(text).toContain('get_business_context');
      expect(text).toContain('Only read.');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('explain_table leaves out tools that are disabled', async () => {
      process.env.MCP_TOOLS_DISABLED = 'get_table_constraints,list_indexes';
      await client.close();
      await connect();

      const result = await client.getPrompt({ name: 'explain_table', arguments: { schema: 'MYLIB', table: 'ORDERS' } });
      const text = promptText(result);
      expect(text).toContain('describe_table with schema "MYLIB" and table "ORDERS"');
      expect(text).not.toContain('get_table_constraints');
      expect(text).not.toContain('list_indexes');
    });

    it('rejects a prompt for a library outside QUERY_ALLOWED_SCHEMAS', async () => {
      process.env.QUERY_ALLOWED_SCHEMAS = 'MYLIB';
      await expect(
        client.getPrompt({ name: 'explain_table', arguments: { schema: 'OTHERLIB', table: 'ORDERHDR' } }),
      ).rejects.toThrow('QUERY_ALLOWED_SCHEMAS');
    });

    it('write_query embeds real columns and YAML relations', async () => {
      mockQuery.mockResolvedValueOnce(ORDER_COLUMNS);
      const result = await client.getPrompt({
        name: 'write_query',
        arguments: { question: 'Which items sold most last month?', schema: 'MYLIB', table: 'ORDERS' },
      });
      const text = promptText(result);
      expect(text).toContain('Which items sold most last month?');
      expect(text).toContain('- ORDERNO DECIMAL(9): Order number');
      expect(text).toContain('- ITEMNO CHAR(15), nullable: Item. Item sold on the line');
      expect(text).toContain('What the table holds: Sales order lines');
      expect(text).toContain('MYLIB.ORDERS.CUSTNO = MYLIB.CUSTOMERS.CUSTNO');
      expect(text).toContain('validate_query');
      expect(text).toContain('execute_query');
    });

    it('write_query only returns SQL when execute_query is disabled', async () => {
      process.env.MCP_TOOLS_DISABLED = 'execute_query';
      await client.close();
      await connect();
      mockQuery.mockResolvedValueOnce(ORDER_COLUMNS);

      const result = await client.getPrompt({
        name: 'write_query',
        arguments: { question: 'Count orders', schema: 'MYLIB', table: 'ORDERS' },
      });
      const text = promptText(result);
      expect(text).toContain('Return the SQL. Do not run it.');
      expect(text).not.toContain('execute_query');
    });

    it('write_query reports a missing table', async () => {
      mockQuery.mockResolvedValueOnce([]);
      await expect(
        client.getPrompt({ name: 'write_query', arguments: { question: 'x', schema: 'MYLIB', table: 'NOPE' } }),
      ).rejects.toThrow('MYLIB.NOPE was not found');
    });
  });
});
