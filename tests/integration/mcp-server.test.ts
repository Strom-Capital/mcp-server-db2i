/**
 * MCP Server Integration Tests
 *
 * Tests the full request/response cycle using MCP SDK's InMemoryTransport.
 * Database operations are mocked via vi.mock('node-jt400').
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client, InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/client';

// Mock node-jt400 before importing modules that use it
const mockQuery = vi.fn();
vi.mock('node-jt400', () => ({
  pool: vi.fn(() => ({
    query: mockQuery,
  })),
}));

// Mock the rate limiter to control its behavior in tests
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

// Now import the server after mocks are set up
import { TOOL_NAMES } from '../../src/config.js';
import { createServer } from '../../src/server.js';
import { initializePool } from '../../src/db/connection.js';
import { getRateLimiter } from '../../src/utils/rateLimiter.js';

describe('MCP Server Integration', () => {
  let client: Client;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;
  const originalEnv = process.env;

  beforeEach(async () => {
    // Reset mocks
    vi.clearAllMocks();
    mockQuery.mockReset();

    // Set up required environment variables
    process.env = {
      ...originalEnv,
      DB2I_HOSTNAME: 'test-host',
      DB2I_USERNAME: 'test-user',
      DB2I_PASSWORD: 'test-pass',
      DB2I_SCHEMA: 'TESTLIB',
      QUERY_PARSE_CHECK: 'false',
    };

    // Initialize the connection pool (uses mocked node-jt400)
    initializePool({
      hostname: 'test-host',
      port: 446,
      username: 'test-user',
      password: 'test-pass',
      database: '*LOCAL',
      schema: 'TESTLIB',
      jdbcOptions: {},
    });

    // Create linked transports for in-memory communication
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    // Create and connect server
    const server = createServer();
    await server.connect(serverTransport);

    // Create and connect client
    client = new Client({
      name: 'test-client',
      version: '1.0.0',
    });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    process.env = originalEnv;
    await client.close();
    await clientTransport.close();
    await serverTransport.close();
  });

  describe('Tool Discovery', () => {
    it('should list every built-in tool', async () => {
      const { tools } = await client.listTools();

      expect(tools).toHaveLength(TOOL_NAMES.length);

      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('execute_query');
      expect(toolNames).toContain('get_business_context');
      expect(toolNames).toContain('list_schemas');
      expect(toolNames).toContain('list_tables');
      expect(toolNames).toContain('search_tables');
      expect(toolNames).toContain('search_columns');
      expect(toolNames).toContain('describe_table');
      expect(toolNames).toContain('list_views');
      expect(toolNames).toContain('list_indexes');
      expect(toolNames).toContain('get_table_constraints');
      expect(toolNames).toContain('validate_query');
      expect(toolNames).toContain('get_object_ddl');
      expect(toolNames).toContain('get_related_objects');
      expect(toolNames).toContain('get_journal_info');
      expect(toolNames).toContain('profile_table');
    });

    it('should have correct metadata for execute_query tool', async () => {
      const { tools } = await client.listTools();
      const queryTool = tools.find((t) => t.name === 'execute_query');

      expect(queryTool).toBeDefined();
      expect(queryTool?.description).toContain('read-only SQL SELECT query');
      expect(queryTool?.inputSchema).toBeDefined();
    });

    it('should have readOnlyHint annotation on all tools', async () => {
      const { tools } = await client.listTools();

      for (const tool of tools) {
        // The annotations should indicate read-only operations
        expect(tool.annotations?.readOnlyHint).toBe(true);
        expect(tool.annotations?.destructiveHint).toBe(false);
        expect(tool.annotations?.idempotentHint).toBe(true);
        expect(tool.annotations?.openWorldHint).toBe(false);
      }
    });

    it('should declare outputSchema on all tools', async () => {
      const { tools } = await client.listTools();

      for (const tool of tools) {
        expect(tool.outputSchema).toBeDefined();
      }
    });

    it('should omit tools disabled via MCP_TOOLS_DISABLED', async () => {
      process.env.MCP_TOOLS_DISABLED = 'execute_query';

      const [filteredClientTransport, filteredServerTransport] = InMemoryTransport.createLinkedPair();
      const filteredServer = createServer();
      await filteredServer.connect(filteredServerTransport);
      const filteredClient = new Client({ name: 'filtered-test', version: '1.0.0' });
      await filteredClient.connect(filteredClientTransport);

      const { tools } = await filteredClient.listTools();
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toHaveLength(TOOL_NAMES.length - 1);
      expect(toolNames).not.toContain('execute_query');
      expect(toolNames).toContain('list_schemas');

      await filteredClient.close();
      await filteredClientTransport.close();
      await filteredServerTransport.close();
    });
  });

  describe('Schema Allowlist', () => {
    it('should reject a query that names a library outside QUERY_ALLOWED_SCHEMAS', async () => {
      process.env.QUERY_ALLOWED_SCHEMAS = 'TESTLIB';
      mockQuery.mockResolvedValueOnce([{ ID: 1 }]);

      const result = await client.callTool({
        name: 'execute_query',
        arguments: { sql: 'SELECT * FROM OTHERLIB.USERS' },
      }) as CallToolResult;

      expect(result.isError).toBe(true);
      const errorText = (result.content[0] as { type: 'text'; text: string }).text;
      expect(errorText).toContain('OTHERLIB.USERS');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it.each([
      ['list_tables', {}],
      ['describe_table', { table: 'ORDERHDR' }],
      ['list_views', {}],
      ['list_indexes', { table: 'ORDERHDR' }],
      ['get_table_constraints', { table: 'ORDERHDR' }],
    ])('should reject %s for a library outside QUERY_ALLOWED_SCHEMAS', async (name, args) => {
      process.env.QUERY_ALLOWED_SCHEMAS = 'TESTLIB';

      const result = await client.callTool({
        name,
        arguments: { schema: 'OTHERLIB', ...args },
      }) as CallToolResult;

      expect(result.isError).toBe(true);
      const errorText = (result.content[0] as { type: 'text'; text: string }).text;
      expect(errorText).toBe('Schema OTHERLIB is not in QUERY_ALLOWED_SCHEMAS (TESTLIB).');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('should still use an allowed default schema when none is given', async () => {
      process.env.QUERY_ALLOWED_SCHEMAS = 'TESTLIB';
      mockQuery.mockResolvedValueOnce([{ TABLE_NAME: 'ORDERS', TABLE_TYPE: 'T', TABLE_TEXT: null }]);

      const result = await client.callTool({ name: 'list_tables', arguments: {} }) as CallToolResult;

      expect(result.isError).toBeUndefined();
      expect(mockQuery).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['TESTLIB']));
    });

    it('should list only libraries in QUERY_ALLOWED_SCHEMAS', async () => {
      process.env.QUERY_ALLOWED_SCHEMAS = 'TESTLIB,QSYS2';
      mockQuery.mockResolvedValueOnce([
        { SCHEMA_NAME: 'OTHERLIB', SCHEMA_TEXT: null },
        { SCHEMA_NAME: 'QSYS2', SCHEMA_TEXT: 'Catalog' },
        { SCHEMA_NAME: 'TESTLIB', SCHEMA_TEXT: null },
      ]);

      const result = await client.callTool({ name: 'list_schemas', arguments: {} }) as CallToolResult;

      const content = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(content.data.map((row: { schema_name: string }) => row.schema_name)).toEqual(['QSYS2', 'TESTLIB']);
      expect(content.count).toBe(2);
    });
  });

  describe('PARSE_STATEMENT check', () => {
    it('should reject a statement that does not parse', async () => {
      process.env.QUERY_PARSE_CHECK = 'true';
      mockQuery.mockResolvedValueOnce([]);

      const result = await client.callTool({
        name: 'execute_query',
        arguments: { sql: 'SELECT * FROM MYLIB.ORDERS' },
      }) as CallToolResult;

      expect(result.isError).toBe(true);
      const errorText = (result.content[0] as { type: 'text'; text: string }).text;
      expect(errorText).toContain('could not be parsed');
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('PARSE_STATEMENT'),
        expect.any(Array)
      );
    });

    it('should reject a statement whose type is not a query', async () => {
      process.env.QUERY_PARSE_CHECK = 'true';
      mockQuery.mockResolvedValueOnce([
        { NAME_TYPE: 'TABLE', SCHEMA: 'MYLIB', NAME: 'ORDERS', COLUMN_NAME: null, SQL_STATEMENT_TYPE: 'INSERT' },
      ]);

      const result = await client.callTool({
        name: 'execute_query',
        arguments: { sql: 'SELECT * FROM MYLIB.ORDERS' },
      }) as CallToolResult;

      expect(result.isError).toBe(true);
      const errorText = (result.content[0] as { type: 'text'; text: string }).text;
      expect(errorText).toContain('INSERT');
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('should reject the query when PARSE_STATEMENT is missing', async () => {
      process.env.QUERY_PARSE_CHECK = 'true';
      mockQuery.mockRejectedValueOnce(new Error('PARSE_STATEMENT in QSYS2 type *N not found. SQL0204'));

      const result = await client.callTool({
        name: 'execute_query',
        arguments: { sql: 'SELECT * FROM MYLIB.ORDERS' },
      }) as CallToolResult;

      expect(result.isError).toBe(true);
      const errorText = (result.content[0] as { type: 'text'; text: string }).text;
      expect(errorText).toContain('QUERY_PARSE_CHECK=false');
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });

  describe('Response Format', () => {
    it('should render row results as a markdown table when MCP_RESPONSE_FORMAT=markdown', async () => {
      process.env.MCP_RESPONSE_FORMAT = 'markdown';
      const mockRows = [{ ID: 1, NAME: 'Alice' }];
      mockQuery.mockResolvedValueOnce(mockRows);

      const result = await client.callTool({
        name: 'execute_query',
        arguments: { sql: 'SELECT * FROM MYLIB.USERS' },
      }) as CallToolResult;

      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('| ID | NAME |');
      expect(text).toContain('| 1 | Alice |');
      expect(result.structuredContent).toMatchObject({ success: true, data: mockRows });
    });
  });

  describe('execute_query Tool', () => {
    it('should execute a valid SELECT query and return results', async () => {
      const mockRows = [
        { ID: 1, NAME: 'Alice' },
        { ID: 2, NAME: 'Bob' },
      ];
      mockQuery.mockResolvedValueOnce(mockRows);

      const result = await client.callTool({
        name: 'execute_query',
        arguments: {
          sql: 'SELECT * FROM MYLIB.USERS',
          limit: 100,
        },
      }) as CallToolResult;

      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);

      const content = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(content.success).toBe(true);
      expect(content.data).toEqual(mockRows);
      expect(content.rowCount).toBe(2);
      expect(result.structuredContent).toMatchObject({
        success: true,
        data: mockRows,
        rowCount: 2,
      });
    });

    it('should reject dangerous queries (SQL injection attempt)', async () => {
      const result = await client.callTool({
        name: 'execute_query',
        arguments: {
          sql: 'DROP TABLE users; SELECT * FROM MYLIB.USERS',
        },
      }) as CallToolResult;

      expect(result.isError).toBe(true);
      const errorText = (result.content[0] as { type: 'text'; text: string }).text;
      expect(errorText).toContain('Security validation failed');
    });

    it('should reject INSERT statements', async () => {
      const result = await client.callTool({
        name: 'execute_query',
        arguments: {
          sql: "INSERT INTO users (name) VALUES ('test')",
        },
      }) as CallToolResult;

      expect(result.isError).toBe(true);
    });

    it('should handle database errors gracefully', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Connection timeout'));

      const result = await client.callTool({
        name: 'execute_query',
        arguments: {
          sql: 'SELECT * FROM MYLIB.USERS',
        },
      }) as CallToolResult;

      expect(result.isError).toBe(true);
      const errorText = (result.content[0] as { type: 'text'; text: string }).text;
      expect(errorText).toContain('Connection timeout');
    });

    it('should apply FETCH FIRST limit to queries', async () => {
      mockQuery.mockResolvedValueOnce([{ ID: 1 }]);

      await client.callTool({
        name: 'execute_query',
        arguments: {
          sql: 'SELECT * FROM MYLIB.USERS',
          limit: 50,
        },
      });

      // Check that the query was modified to include FETCH FIRST
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('FETCH FIRST 50 ROWS ONLY'),
        expect.any(Array)
      );
    });

    it('should apply FETCH FIRST when a column name contains LIMIT', async () => {
      mockQuery.mockResolvedValueOnce([{ CREDIT_LIMIT: 5000 }]);

      await client.callTool({
        name: 'execute_query',
        arguments: {
          sql: 'SELECT CREDIT_LIMIT FROM MYLIB.ACCOUNTS',
          limit: 25,
        },
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('FETCH FIRST 25 ROWS ONLY'),
        expect.any(Array)
      );
    });

    it('should clamp an oversized FETCH FIRST in the SQL text', async () => {
      mockQuery.mockResolvedValueOnce([{ ID: 1 }]);

      await client.callTool({
        name: 'execute_query',
        arguments: {
          sql: 'SELECT * FROM MYLIB.USERS FETCH FIRST 10000000 ROWS ONLY',
          limit: 100,
        },
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('FETCH FIRST 100 ROWS ONLY'),
        expect.any(Array)
      );
      expect(mockQuery).not.toHaveBeenCalledWith(
        expect.stringContaining('10000000'),
        expect.any(Array)
      );
    });
  });

  describe('list_schemas Tool', () => {
    it('should return list of schemas', async () => {
      // Mock DB returns UPPERCASE column names
      const mockDbRows = [
        { SCHEMA_NAME: 'QSYS', SCHEMA_TEXT: 'System library' },
        { SCHEMA_NAME: 'MYLIB', SCHEMA_TEXT: 'My application library' },
      ];
      mockQuery.mockResolvedValueOnce(mockDbRows);

      const result = await client.callTool({
        name: 'list_schemas',
        arguments: {},
      }) as CallToolResult;

      expect(result.isError).toBeUndefined();
      const content = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(content.success).toBe(true);
      // Tool returns lowercase property names
      expect(content.data).toEqual([
        { schema_name: 'QSYS', schema_text: 'System library' },
        { schema_name: 'MYLIB', schema_text: 'My application library' },
      ]);
      expect(content.count).toBe(2);
    });

    it('should apply filter pattern', async () => {
      mockQuery.mockResolvedValueOnce([{ SCHEMA_NAME: 'QSYS', SCHEMA_TEXT: null }]);

      await client.callTool({
        name: 'list_schemas',
        arguments: {
          filter: 'QSYS*',
        },
      });

      // Verify the query includes the LIKE pattern
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('LIKE'),
        expect.arrayContaining(['QSYS%'])
      );
    });
  });

  describe('list_tables Tool', () => {
    it('should return tables for a schema', async () => {
      // Mock DB returns UPPERCASE column names
      const mockDbRows = [
        { TABLE_NAME: 'USERS', TABLE_TYPE: 'TABLE', TABLE_TEXT: 'User data' },
        { TABLE_NAME: 'ORDERS', TABLE_TYPE: 'TABLE', TABLE_TEXT: 'Order data' },
      ];
      mockQuery.mockResolvedValueOnce(mockDbRows);

      const result = await client.callTool({
        name: 'list_tables',
        arguments: {
          schema: 'MYLIB',
        },
      }) as CallToolResult;

      expect(result.isError).toBeUndefined();
      const content = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(content.success).toBe(true);
      // Tool returns lowercase property names
      expect(content.data).toEqual([
        { table_name: 'USERS', table_type: 'TABLE', table_text: 'User data' },
        { table_name: 'ORDERS', table_type: 'TABLE', table_text: 'Order data' },
      ]);
      expect(content.count).toBe(2);
    });

    it('should use default schema from environment when not provided', async () => {
      const mockDbRows = [{ TABLE_NAME: 'TEST', TABLE_TYPE: 'TABLE', TABLE_TEXT: null }];
      mockQuery.mockResolvedValueOnce(mockDbRows);

      const result = await client.callTool({
        name: 'list_tables',
        arguments: {},
      }) as CallToolResult;

      expect(result.isError).toBeUndefined();
      // Should have queried using TESTLIB from env (passed as parameter)
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['TESTLIB'])
      );
    });
  });

  describe('search_tables Tool', () => {
    it('should return tables matching the filter', async () => {
      mockQuery.mockResolvedValueOnce([
        { TABLE_SCHEMA: 'MYLIB', TABLE_NAME: 'ORDERS', TABLE_TYPE: 'T', TABLE_TEXT: 'Order lines' },
      ]);

      const result = await client.callTool({
        name: 'search_tables',
        arguments: { filter: 'ORDER*', schema: 'MYLIB' },
      }) as CallToolResult;

      expect(result.isError).toBeUndefined();
      const content = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(content.success).toBe(true);
      expect(content.data).toEqual([
        { schema_name: 'MYLIB', table_name: 'ORDERS', table_type: 'T', table_text: 'Order lines' },
      ]);
      expect(content.truncated).toBe(false);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('QSYS2.SYSTABLES'),
        expect.arrayContaining(['ORDER%', 'MYLIB'])
      );
    });
  });

  describe('search_columns Tool', () => {
    it('should return columns matching the filter', async () => {
      mockQuery.mockResolvedValueOnce([
        {
          TABLE_SCHEMA: 'MYLIB',
          TABLE_NAME: 'ORDERS',
          COLUMN_NAME: 'ITEMNO',
          SYSTEM_COLUMN_NAME: 'ITEMNO',
          DATA_TYPE: 'CHAR',
          LENGTH: 15,
          NUMERIC_SCALE: 0,
          COLUMN_TEXT: 'Item',
        },
      ]);

      const result = await client.callTool({
        name: 'search_columns',
        arguments: { filter: 'ITEMNO', schema: 'MYLIB' },
      }) as CallToolResult;

      expect(result.isError).toBeUndefined();
      const content = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(content.success).toBe(true);
      expect(content.data[0]).toMatchObject({
        schema_name: 'MYLIB',
        table_name: 'ORDERS',
        column_name: 'ITEMNO',
        column_text: 'Item',
      });
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('QSYS2.SYSCOLUMNS'),
        expect.arrayContaining(['%ITEMNO%', 'MYLIB'])
      );
    });
  });

  describe('describe_table Tool', () => {
    it('should return column information for a table', async () => {
      // Mock DB returns UPPERCASE column names
      const mockDbRows = [
        {
          COLUMN_NAME: 'ID',
          ORDINAL_POSITION: 1,
          DATA_TYPE: 'INTEGER',
          LENGTH: 4,
          NUMERIC_SCALE: 0,
          IS_NULLABLE: 'N',
          COLUMN_DEFAULT: null,
          COLUMN_TEXT: 'Primary key',
          SYSTEM_COLUMN_NAME: 'ID',
          CCSID: null,
        },
        {
          COLUMN_NAME: 'NAME',
          ORDINAL_POSITION: 2,
          DATA_TYPE: 'VARCHAR',
          LENGTH: 100,
          NUMERIC_SCALE: null,
          IS_NULLABLE: 'Y',
          COLUMN_DEFAULT: null,
          COLUMN_TEXT: 'User name',
          SYSTEM_COLUMN_NAME: 'NAME',
          CCSID: 37,
        },
      ];
      mockQuery.mockResolvedValueOnce(mockDbRows);

      const result = await client.callTool({
        name: 'describe_table',
        arguments: {
          schema: 'MYLIB',
          table: 'USERS',
        },
      }) as CallToolResult;

      expect(result.isError).toBeUndefined();
      const content = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(content.success).toBe(true);
      // Tool returns lowercase property names
      expect(content.data).toEqual([
        {
          column_name: 'ID',
          ordinal_position: 1,
          data_type: 'INTEGER',
          length: 4,
          numeric_scale: 0,
          is_nullable: 'N',
          column_default: null,
          column_text: 'Primary key',
          system_column_name: 'ID',
          ccsid: null,
        },
        {
          column_name: 'NAME',
          ordinal_position: 2,
          data_type: 'VARCHAR',
          length: 100,
          numeric_scale: null,
          is_nullable: 'Y',
          column_default: null,
          column_text: 'User name',
          system_column_name: 'NAME',
          ccsid: 37,
        },
      ]);
      expect(content.count).toBe(2);
    });
  });

  describe('list_views Tool', () => {
    it('should return views for a schema', async () => {
      // Mock DB returns UPPERCASE column names with VIEW aliases
      const mockDbRows = [
        { VIEW_NAME: 'ACTIVE_USERS', VIEW_TEXT: 'Active users view' },
      ];
      mockQuery.mockResolvedValueOnce(mockDbRows);

      const result = await client.callTool({
        name: 'list_views',
        arguments: {
          schema: 'MYLIB',
        },
      }) as CallToolResult;

      expect(result.isError).toBeUndefined();
      const content = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(content.success).toBe(true);
      // Tool returns lowercase property names
      expect(content.data).toEqual([
        { view_name: 'ACTIVE_USERS', view_text: 'Active users view' },
      ]);
      expect(content.count).toBe(1);
    });
  });

  describe('list_indexes Tool', () => {
    it('should return indexes for a table', async () => {
      // Mock DB returns UPPERCASE column names
      const mockDbRows = [
        {
          INDEX_NAME: 'USERS_PK',
          INDEX_SCHEMA: 'MYLIB',
          IS_UNIQUE: 'Y',
          COLUMN_NAMES: 'ID',
        },
      ];
      mockQuery.mockResolvedValueOnce(mockDbRows);

      const result = await client.callTool({
        name: 'list_indexes',
        arguments: {
          schema: 'MYLIB',
          table: 'USERS',
        },
      }) as CallToolResult;

      expect(result.isError).toBeUndefined();
      const content = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(content.success).toBe(true);
      // Tool returns lowercase property names
      expect(content.data).toEqual([
        {
          index_name: 'USERS_PK',
          index_schema: 'MYLIB',
          is_unique: 'Y',
          column_names: 'ID',
        },
      ]);
      expect(content.count).toBe(1);
    });
  });

  describe('get_table_constraints Tool', () => {
    it('should return constraints for a table', async () => {
      // Mock DB returns UPPERCASE column names
      const mockDbRows = [
        {
          CONSTRAINT_NAME: 'USERS_PK',
          CONSTRAINT_TYPE: 'PRIMARY KEY',
          COLUMN_NAME: 'ID',
          ORDINAL_POSITION: 1,
          REFERENCED_TABLE_SCHEMA: null,
          REFERENCED_TABLE_NAME: null,
          REFERENCED_COLUMN_NAME: null,
        },
      ];
      mockQuery.mockResolvedValueOnce(mockDbRows);

      const result = await client.callTool({
        name: 'get_table_constraints',
        arguments: {
          schema: 'MYLIB',
          table: 'USERS',
        },
      }) as CallToolResult;

      expect(result.isError).toBeUndefined();
      const content = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      expect(content.success).toBe(true);
      // Tool returns lowercase property names
      expect(content.data).toEqual([
        {
          constraint_name: 'USERS_PK',
          constraint_type: 'PRIMARY KEY',
          column_name: 'ID',
          ordinal_position: 1,
          referenced_table_schema: null,
          referenced_table_name: null,
          referenced_column_name: null,
        },
      ]);
      expect(content.count).toBe(1);
    });
  });

  describe('Rate Limiting', () => {
    it('should block requests when rate limit is exceeded', async () => {
      // Override the mock to simulate rate limit exceeded
      const mockRateLimiter = getRateLimiter as ReturnType<typeof vi.fn>;
      mockRateLimiter.mockReturnValueOnce({
        checkLimit: vi.fn(() => ({ allowed: false, remaining: 0, retryAfterSeconds: 60 })),
        formatError: vi.fn(() => ({
          error: 'Rate limit exceeded. Please try again in 60 seconds.',
          waitTimeSeconds: 60,
          limit: 100,
          windowMs: 900000,
        })),
      });

      // Need to recreate server with the new mock
      const [newClientTransport, newServerTransport] = InMemoryTransport.createLinkedPair();
      const newServer = createServer();
      await newServer.connect(newServerTransport);

      const newClient = new Client({ name: 'rate-test', version: '1.0.0' });
      await newClient.connect(newClientTransport);

      mockQuery.mockResolvedValueOnce([{ ID: 1 }]);

      const result = await newClient.callTool({
        name: 'execute_query',
        arguments: { sql: 'SELECT 1 FROM SYSIBM.SYSDUMMY1' },
      }) as CallToolResult;

      expect(result.isError).toBe(true);
      const errorText = (result.content[0] as { type: 'text'; text: string }).text;
      expect(errorText).toContain('Rate limit exceeded');

      await newClient.close();
      await newClientTransport.close();
      await newServerTransport.close();
    });

    it('should key the rate limiter by session or stdio', async () => {
      const checkLimit = vi.fn(() => ({ allowed: true, remaining: 99 }));
      const mockRateLimiter = getRateLimiter as ReturnType<typeof vi.fn>;
      mockRateLimiter.mockReturnValue({
        checkLimit,
        formatError: vi.fn(),
      });

      mockQuery.mockResolvedValue([{ ID: 1 }]);

      const stdioResult = await client.callTool({
        name: 'execute_query',
        arguments: { sql: 'SELECT 1 FROM SYSIBM.SYSDUMMY1' },
      }) as CallToolResult;
      expect(stdioResult.isError).toBeUndefined();
      expect(checkLimit).toHaveBeenCalledWith('stdio');

      const [sessionClientTransport, sessionServerTransport] = InMemoryTransport.createLinkedPair();
      const sessionServer = createServer({
        hostname: 'test-host',
        port: 446,
        username: 'test-user',
        password: 'test-pass',
        database: '*LOCAL',
        schema: 'TESTLIB',
        jdbcOptions: {},
      }, 'session-token-abc');
      await sessionServer.connect(sessionServerTransport);
      const sessionClient = new Client({ name: 'session-test', version: '1.0.0' });
      await sessionClient.connect(sessionClientTransport);

      await sessionClient.callTool({
        name: 'execute_query',
        arguments: { sql: 'SELECT 1 FROM SYSIBM.SYSDUMMY1' },
      });
      expect(checkLimit).toHaveBeenCalledWith('session-token-abc');

      await sessionClient.close();
      await sessionClientTransport.close();
      await sessionServerTransport.close();

      mockRateLimiter.mockReset();
      mockRateLimiter.mockImplementation(() => ({
        checkLimit: vi.fn(() => ({ allowed: true, remaining: 99 })),
        formatError: vi.fn(() => ({
          error: 'Rate limit exceeded',
          waitTimeSeconds: 60,
          limit: 100,
          windowMs: 900000,
        })),
      }));
    });
  });

  describe('Error Handling', () => {
    it('should return isError: true for tool failures', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Database unavailable'));

      const result = await client.callTool({
        name: 'list_schemas',
        arguments: {},
      }) as CallToolResult;

      expect(result.isError).toBe(true);
    });

    it('should return descriptive error messages', async () => {
      mockQuery.mockRejectedValueOnce(new Error('SQL0204 - Object not found'));

      const result = await client.callTool({
        name: 'describe_table',
        arguments: {
          schema: 'MYLIB',
          table: 'NONEXISTENT',
        },
      }) as CallToolResult;

      expect(result.isError).toBe(true);
      const errorText = (result.content[0] as { type: 'text'; text: string }).text;
      expect(errorText).toContain('SQL0204');
    });
  });
});
