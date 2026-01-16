#!/usr/bin/env node
/**
 * IBM DB2i MCP Server
 * 
 * A Model Context Protocol server for querying and inspecting
 * IBM DB2 for i (DB2i) databases using the JT400 JDBC driver.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { loadConfig } from './config.js';
import { initializePool, testConnection } from './db/connection.js';
import { executeQueryTool } from './tools/query.js';
import {
  listSchemasTool,
  listTablesTool,
  describeTableTool,
  listViewsTool,
  listIndexesTool,
  getTableConstraintsTool,
} from './tools/metadata.js';

const SERVER_NAME = 'mcp-server-db2i';
const SERVER_VERSION = '1.0.0';

/**
 * Create and configure the MCP server
 */
function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // Register execute_query tool
  server.tool(
    'execute_query',
    'Execute a read-only SQL SELECT query against the IBM DB2i database. Only SELECT statements are allowed for security. Results are limited by default to prevent large result sets.',
    {
      sql: z.string().describe('SQL SELECT query to execute'),
      params: z.array(z.unknown()).optional().describe('Query parameters for prepared statement'),
      limit: z.number().optional().default(1000).describe('Maximum number of rows to return (default: 1000)'),
    },
    async (args) => {
      const result = await executeQueryTool({
        sql: args.sql,
        params: args.params,
        limit: args.limit ?? 1000,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // Register list_schemas tool
  server.tool(
    'list_schemas',
    'List all schemas (libraries) in the IBM DB2i database. Optionally filter by name pattern using * as wildcard.',
    {
      filter: z.string().optional().describe('Filter pattern for schema names. Use * as wildcard. Example: "QSYS*" matches schemas starting with QSYS'),
    },
    async (args) => {
      const result = await listSchemasTool({ filter: args.filter });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // Register list_tables tool
  server.tool(
    'list_tables',
    'List all tables in a schema (library). Uses DB2I_SCHEMA env var if schema not provided. Optionally filter by name pattern using * as wildcard.',
    {
      schema: z.string().optional().describe('Schema (library) name to list tables from. Uses DB2I_SCHEMA env var if not provided.'),
      filter: z.string().optional().describe('Filter pattern for table names. Use * as wildcard. Example: "CUST*" matches tables starting with CUST'),
    },
    async (args) => {
      const result = await listTablesTool({ schema: args.schema, filter: args.filter });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // Register describe_table tool
  server.tool(
    'describe_table',
    'Get detailed column information for a specific table including data types, lengths, nullability, defaults, and CCSID. Uses DB2I_SCHEMA env var if schema not provided.',
    {
      schema: z.string().optional().describe('Schema (library) name containing the table. Uses DB2I_SCHEMA env var if not provided.'),
      table: z.string().describe('Table name to describe'),
    },
    async (args) => {
      const result = await describeTableTool({ schema: args.schema, table: args.table });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // Register list_views tool
  server.tool(
    'list_views',
    'List all views in a schema (library). Uses DB2I_SCHEMA env var if schema not provided. Optionally filter by name pattern using * as wildcard.',
    {
      schema: z.string().optional().describe('Schema (library) name to list views from. Uses DB2I_SCHEMA env var if not provided.'),
      filter: z.string().optional().describe('Filter pattern for view names. Use * as wildcard.'),
    },
    async (args) => {
      const result = await listViewsTool({ schema: args.schema, filter: args.filter });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // Register list_indexes tool
  server.tool(
    'list_indexes',
    'List all indexes for a specific table including uniqueness and column information. Uses DB2I_SCHEMA env var if schema not provided.',
    {
      schema: z.string().optional().describe('Schema (library) name containing the table. Uses DB2I_SCHEMA env var if not provided.'),
      table: z.string().describe('Table name to list indexes for'),
    },
    async (args) => {
      const result = await listIndexesTool({ schema: args.schema, table: args.table });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // Register get_table_constraints tool
  server.tool(
    'get_table_constraints',
    'Get all constraints (primary keys, foreign keys, unique constraints) for a specific table. Uses DB2I_SCHEMA env var if schema not provided.',
    {
      schema: z.string().optional().describe('Schema (library) name containing the table. Uses DB2I_SCHEMA env var if not provided.'),
      table: z.string().describe('Table name to get constraints for'),
    },
    async (args) => {
      const result = await getTableConstraintsTool({ schema: args.schema, table: args.table });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  return server;
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  try {
    // Load configuration from environment variables
    const config = loadConfig();

    // Initialize database connection pool
    initializePool(config);

    // Test the connection
    const connected = await testConnection();
    if (!connected) {
      console.error('Warning: Could not verify database connection. The server will start but queries may fail.');
    }

    // Create MCP server
    const server = createServer();

    // Connect via stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);

    // Handle shutdown gracefully
    process.on('SIGINT', () => {
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      process.exit(0);
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Failed to start MCP server: ${message}`);
    process.exit(1);
  }
}

// Run the server
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
