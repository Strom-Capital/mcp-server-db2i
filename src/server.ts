/**
 * MCP Server Factory
 *
 * Creates and configures the MCP server with all tools registered.
 * Extracted from index.ts for testability.
 */

import { createRequire } from 'module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { executeQueryTool } from './tools/query.js';
import {
  listSchemasTool,
  listTablesTool,
  describeTableTool,
  listViewsTool,
  listIndexesTool,
  getTableConstraintsTool,
} from './tools/metadata.js';
import { getRateLimiter } from './utils/rateLimiter.js';

// Read version from package.json to keep it in sync with npm releases
const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { name: string; version: string };

export const SERVER_NAME = packageJson.name;
export const SERVER_VERSION = packageJson.version;

/**
 * Standard tool result type
 */
export interface ToolResult {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

/**
 * MCP tool response type
 */
export type McpToolResponse = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
};

/**
 * Creates a tool handler wrapper that applies rate limiting and standardizes responses.
 * Eliminates boilerplate code across all tool registrations.
 */
export function withToolHandler<TArgs, TResult extends ToolResult>(
  handler: (args: TArgs) => Promise<TResult>,
  errorMessage: string
): (args: TArgs) => Promise<McpToolResponse> {
  return async (args: TArgs): Promise<McpToolResponse> => {
    // Check rate limit
    const rateLimiter = getRateLimiter();
    const rateResult = rateLimiter.checkLimit();

    if (!rateResult.allowed) {
      const error = rateLimiter.formatError(rateResult);
      return {
        content: [{ type: 'text', text: JSON.stringify(error, null, 2) }],
        isError: true,
      };
    }

    // Execute the tool
    const result = await handler(args);

    if (!result.success) {
      return {
        content: [{ type: 'text', text: result.error ?? errorMessage }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  };
}

/**
 * Create and configure the MCP server with all tools registered.
 *
 * @returns Configured McpServer instance ready to connect to a transport
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // Register execute_query tool
  server.registerTool(
    'execute_query',
    {
      title: 'Execute SQL Query',
      description: 'Execute a read-only SQL SELECT query against the IBM DB2i database. Only SELECT statements are allowed for security. Results are limited by default to prevent large result sets.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        sql: z.string().describe('SQL SELECT query to execute'),
        params: z.array(z.unknown()).optional().describe('Query parameters for prepared statement'),
        limit: z.number().optional().default(1000).describe('Maximum number of rows to return (default: 1000)'),
      },
    },
    withToolHandler(
      (args) => executeQueryTool({
        sql: args.sql,
        params: args.params,
        limit: args.limit ?? 1000,
      }),
      'Query failed'
    )
  );

  // Register list_schemas tool
  server.registerTool(
    'list_schemas',
    {
      title: 'List Schemas',
      description: 'List all schemas (libraries) in the IBM DB2i database. Optionally filter by name pattern using * as wildcard.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        filter: z.string().optional().describe('Filter pattern for schema names. Use * as wildcard. Example: "QSYS*" matches schemas starting with QSYS'),
      },
    },
    withToolHandler(
      (args) => listSchemasTool({ filter: args.filter }),
      'Failed to list schemas'
    )
  );

  // Register list_tables tool
  server.registerTool(
    'list_tables',
    {
      title: 'List Tables',
      description: 'List all tables in a schema (library). Uses DB2I_SCHEMA env var if schema not provided. Optionally filter by name pattern using * as wildcard.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        schema: z.string().optional().describe('Schema (library) name to list tables from. Uses DB2I_SCHEMA env var if not provided.'),
        filter: z.string().optional().describe('Filter pattern for table names. Use * as wildcard. Example: "CUST*" matches tables starting with CUST'),
      },
    },
    withToolHandler(
      (args) => listTablesTool({ schema: args.schema, filter: args.filter }),
      'Failed to list tables'
    )
  );

  // Register describe_table tool
  server.registerTool(
    'describe_table',
    {
      title: 'Describe Table',
      description: 'Get detailed column information for a specific table including data types, lengths, nullability, defaults, and CCSID. Uses DB2I_SCHEMA env var if schema not provided.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        schema: z.string().optional().describe('Schema (library) name containing the table. Uses DB2I_SCHEMA env var if not provided.'),
        table: z.string().describe('Table name to describe'),
      },
    },
    withToolHandler(
      (args) => describeTableTool({ schema: args.schema, table: args.table }),
      'Failed to describe table'
    )
  );

  // Register list_views tool
  server.registerTool(
    'list_views',
    {
      title: 'List Views',
      description: 'List all views in a schema (library). Uses DB2I_SCHEMA env var if schema not provided. Optionally filter by name pattern using * as wildcard.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        schema: z.string().optional().describe('Schema (library) name to list views from. Uses DB2I_SCHEMA env var if not provided.'),
        filter: z.string().optional().describe('Filter pattern for view names. Use * as wildcard.'),
      },
    },
    withToolHandler(
      (args) => listViewsTool({ schema: args.schema, filter: args.filter }),
      'Failed to list views'
    )
  );

  // Register list_indexes tool
  server.registerTool(
    'list_indexes',
    {
      title: 'List Indexes',
      description: 'List all indexes for a specific table including uniqueness and column information. Uses DB2I_SCHEMA env var if schema not provided.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        schema: z.string().optional().describe('Schema (library) name containing the table. Uses DB2I_SCHEMA env var if not provided.'),
        table: z.string().describe('Table name to list indexes for'),
      },
    },
    withToolHandler(
      (args) => listIndexesTool({ schema: args.schema, table: args.table }),
      'Failed to list indexes'
    )
  );

  // Register get_table_constraints tool
  server.registerTool(
    'get_table_constraints',
    {
      title: 'Get Table Constraints',
      description: 'Get all constraints (primary keys, foreign keys, unique constraints) for a specific table. Uses DB2I_SCHEMA env var if schema not provided.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        schema: z.string().optional().describe('Schema (library) name containing the table. Uses DB2I_SCHEMA env var if not provided.'),
        table: z.string().describe('Table name to get constraints for'),
      },
    },
    withToolHandler(
      (args) => getTableConstraintsTool({ schema: args.schema, table: args.table }),
      'Failed to get constraints'
    )
  );

  return server;
}
