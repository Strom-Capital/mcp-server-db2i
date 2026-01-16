/**
 * MCP Server Integration Tests
 *
 * Tests the full request/response cycle using MCP SDK's InMemoryTransport.
 * Database operations are mocked via vi.mock('node-jt400').
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

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
    it('should list all 7 registered tools', async () => {
      const { tools } = await client.listTools();

      expect(tools).toHaveLength(7);

      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('execute_query');
      expect(toolNames).toContain('list_schemas');
      expect(toolNames).toContain('list_tables');
      expect(toolNames).toContain('describe_table');
      expect(toolNames).toContain('list_views');
      expect(toolNames).toContain('list_indexes');
      expect(toolNames).toContain('get_table_constraints');
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
      }
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
