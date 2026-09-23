/**
 * MCP Server Factory
 *
 * Creates and configures the MCP server with all tools registered.
 * Extracted from index.ts for testability.
 * 
 * Supports two modes:
 * - Stdio mode: Uses global connection pool (no sessionConfig)
 * - HTTP mode: Uses session-specific connection pool (with sessionConfig)
 */

import { createRequire } from 'module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { DB2iConfig } from './config.js';
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
 * Session context for HTTP transport
 * Contains the session-specific configuration
 */
export interface SessionContext {
  /** Session/token ID for looking up the connection pool */
  sessionId: string;
  /** DB2i configuration for this session */
  config: DB2iConfig;
}

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
  structuredContent?: Record<string, unknown>;
  isError?: true;
};

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const queryOutputSchema = {
  success: z.boolean(),
  error: z.string().optional(),
  violations: z.array(z.string()).optional(),
  data: z.array(z.unknown()).optional(),
  rowCount: z.number().int().optional(),
  limitApplied: z.number().int().optional(),
};

const listSchemasOutputSchema = {
  success: z.boolean(),
  error: z.string().optional(),
  data: z.array(z.object({
    schema_name: z.string(),
    schema_text: z.string().nullable(),
  })).optional(),
  count: z.number().int().optional(),
};

const listTablesOutputSchema = {
  success: z.boolean(),
  error: z.string().optional(),
  data: z.array(z.object({
    table_name: z.string(),
    table_type: z.string(),
    table_text: z.string().nullable(),
  })).optional(),
  count: z.number().int().optional(),
};

const describeTableOutputSchema = {
  success: z.boolean(),
  error: z.string().optional(),
  data: z.array(z.object({
    column_name: z.string(),
    ordinal_position: z.number(),
    data_type: z.string(),
    length: z.number().nullable(),
    numeric_scale: z.number().nullable(),
    is_nullable: z.string(),
    column_default: z.string().nullable(),
    column_text: z.string().nullable(),
    system_column_name: z.string(),
    ccsid: z.number().nullable(),
  })).optional(),
  count: z.number().int().optional(),
};

const listViewsOutputSchema = {
  success: z.boolean(),
  error: z.string().optional(),
  data: z.array(z.object({
    view_name: z.string(),
    view_text: z.string().nullable(),
  })).optional(),
  count: z.number().int().optional(),
};

const listIndexesOutputSchema = {
  success: z.boolean(),
  error: z.string().optional(),
  data: z.array(z.object({
    index_name: z.string(),
    index_schema: z.string(),
    is_unique: z.string(),
    column_names: z.string(),
  })).optional(),
  count: z.number().int().optional(),
};

const tableConstraintsOutputSchema = {
  success: z.boolean(),
  error: z.string().optional(),
  data: z.array(z.object({
    constraint_name: z.string(),
    constraint_type: z.string(),
    column_name: z.string(),
    ordinal_position: z.number(),
    referenced_table_schema: z.string().nullable(),
    referenced_table_name: z.string().nullable(),
    referenced_column_name: z.string().nullable(),
  })).optional(),
  count: z.number().int().optional(),
};

/**
 * Creates a tool handler wrapper that applies rate limiting and standardizes responses.
 * Eliminates boilerplate code across all tool registrations.
 * 
 * @param handler - The tool handler function
 * @param errorMessage - Error message to use on failure
 * @param sessionContext - Optional session context for HTTP transport
 */
export function withToolHandler<TArgs, TResult extends ToolResult>(
  handler: (args: TArgs, sessionId?: string) => Promise<TResult>,
  errorMessage: string,
  sessionContext?: SessionContext
): (args: TArgs) => Promise<McpToolResponse> {
  return async (args: TArgs): Promise<McpToolResponse> => {
    // Check rate limit
    const rateLimiter = getRateLimiter();
    const rateResult = rateLimiter.checkLimit(sessionContext?.sessionId ?? 'stdio');

    if (!rateResult.allowed) {
      const error = rateLimiter.formatError(rateResult);
      const structured = { success: false, error: error.error };
      return {
        content: [{ type: 'text', text: JSON.stringify(error, null, 2) }],
        structuredContent: structured,
        isError: true,
      };
    }

    // Execute the tool with optional sessionId
    const result = await handler(args, sessionContext?.sessionId);

    if (!result.success) {
      const structured = {
        success: false,
        error: result.error ?? errorMessage,
        ...('violations' in result && result.violations
          ? { violations: result.violations }
          : {}),
      };
      return {
        content: [{ type: 'text', text: result.error ?? errorMessage }],
        structuredContent: structured,
        isError: true,
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  };
}

/**
 * Create and configure the MCP server with all tools registered.
 *
 * @param sessionConfig - Optional session config for HTTP transport.
 *                        When provided, tools use session-specific connection pool.
 *                        When omitted, tools use global connection pool (stdio mode).
 * @param sessionId - Optional session ID (auth token) for HTTP transport.
 *                    Used to look up the session-specific connection pool.
 * @returns Configured McpServer instance ready to connect to a transport
 */
export function createServer(sessionConfig?: DB2iConfig, sessionId?: string): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // Create session context if sessionConfig provided
  const sessionContext: SessionContext | undefined = sessionConfig && sessionId ? {
    sessionId,
    config: sessionConfig,
  } : undefined;

  // Helper to get effective default schema
  const getDefaultSchema = (): string | undefined => {
    if (sessionConfig?.schema) {
      return sessionConfig.schema;
    }
    return process.env.DB2I_SCHEMA || undefined;
  };

  // Register execute_query tool
  server.registerTool(
    'execute_query',
    {
      title: 'Execute SQL Query',
      description: 'Execute a read-only SQL SELECT query against the IBM DB2i database. Only SELECT statements are allowed for security. Results are limited by default to prevent large result sets.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        sql: z.string().describe('SQL SELECT query to execute'),
        params: z.array(z.unknown()).optional().describe('Query parameters for prepared statement'),
        limit: z.number().int().positive().optional().default(1000).describe('Maximum number of rows to return (default: 1000, max: configured via QUERY_MAX_LIMIT)'),
      },
      outputSchema: queryOutputSchema,
    },
    withToolHandler(
      (args, sessionId) => executeQueryTool({
        sql: args.sql,
        params: args.params,
        limit: args.limit,
        sessionId,
      }),
      'Query failed',
      sessionContext
    )
  );

  // Register list_schemas tool
  server.registerTool(
    'list_schemas',
    {
      title: 'List Schemas',
      description: 'List all schemas (libraries) in the IBM DB2i database. Optionally filter by name pattern using * as wildcard.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        filter: z.string().optional().describe('Filter pattern for schema names. Use * as wildcard. Example: "QSYS*" matches schemas starting with QSYS'),
      },
      outputSchema: listSchemasOutputSchema,
    },
    withToolHandler(
      (args, sessionId) => listSchemasTool({ filter: args.filter, sessionId }),
      'Failed to list schemas',
      sessionContext
    )
  );

  // Register list_tables tool
  server.registerTool(
    'list_tables',
    {
      title: 'List Tables',
      description: `List all tables in a schema (library). ${sessionConfig ? 'Uses session default schema if not provided.' : 'Uses DB2I_SCHEMA env var if schema not provided.'} Optionally filter by name pattern using * as wildcard.`,
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        schema: z.string().optional().describe(`Schema (library) name to list tables from. ${sessionConfig ? 'Uses session default schema if not provided.' : 'Uses DB2I_SCHEMA env var if not provided.'}`),
        filter: z.string().optional().describe('Filter pattern for table names. Use * as wildcard. Example: "CUST*" matches tables starting with CUST'),
      },
      outputSchema: listTablesOutputSchema,
    },
    withToolHandler(
      (args, sessionId) => listTablesTool({ 
        schema: args.schema ?? getDefaultSchema(), 
        filter: args.filter,
        sessionId,
      }),
      'Failed to list tables',
      sessionContext
    )
  );

  // Register describe_table tool
  server.registerTool(
    'describe_table',
    {
      title: 'Describe Table',
      description: `Get detailed column information for a specific table including data types, lengths, nullability, defaults, and CCSID. ${sessionConfig ? 'Uses session default schema if not provided.' : 'Uses DB2I_SCHEMA env var if schema not provided.'}`,
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        schema: z.string().optional().describe(`Schema (library) name containing the table. ${sessionConfig ? 'Uses session default schema if not provided.' : 'Uses DB2I_SCHEMA env var if not provided.'}`),
        table: z.string().describe('Table name to describe'),
      },
      outputSchema: describeTableOutputSchema,
    },
    withToolHandler(
      (args, sessionId) => describeTableTool({ 
        schema: args.schema ?? getDefaultSchema(), 
        table: args.table,
        sessionId,
      }),
      'Failed to describe table',
      sessionContext
    )
  );

  // Register list_views tool
  server.registerTool(
    'list_views',
    {
      title: 'List Views',
      description: `List all views in a schema (library). ${sessionConfig ? 'Uses session default schema if not provided.' : 'Uses DB2I_SCHEMA env var if schema not provided.'} Optionally filter by name pattern using * as wildcard.`,
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        schema: z.string().optional().describe(`Schema (library) name to list views from. ${sessionConfig ? 'Uses session default schema if not provided.' : 'Uses DB2I_SCHEMA env var if not provided.'}`),
        filter: z.string().optional().describe('Filter pattern for view names. Use * as wildcard.'),
      },
      outputSchema: listViewsOutputSchema,
    },
    withToolHandler(
      (args, sessionId) => listViewsTool({ 
        schema: args.schema ?? getDefaultSchema(), 
        filter: args.filter,
        sessionId,
      }),
      'Failed to list views',
      sessionContext
    )
  );

  // Register list_indexes tool
  server.registerTool(
    'list_indexes',
    {
      title: 'List Indexes',
      description: `List all indexes for a specific table including uniqueness and column information. ${sessionConfig ? 'Uses session default schema if not provided.' : 'Uses DB2I_SCHEMA env var if schema not provided.'}`,
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        schema: z.string().optional().describe(`Schema (library) name containing the table. ${sessionConfig ? 'Uses session default schema if not provided.' : 'Uses DB2I_SCHEMA env var if not provided.'}`),
        table: z.string().describe('Table name to list indexes for'),
      },
      outputSchema: listIndexesOutputSchema,
    },
    withToolHandler(
      (args, sessionId) => listIndexesTool({ 
        schema: args.schema ?? getDefaultSchema(), 
        table: args.table,
        sessionId,
      }),
      'Failed to list indexes',
      sessionContext
    )
  );

  // Register get_table_constraints tool
  server.registerTool(
    'get_table_constraints',
    {
      title: 'Get Table Constraints',
      description: `Get all constraints (primary keys, foreign keys, unique constraints) for a specific table. ${sessionConfig ? 'Uses session default schema if not provided.' : 'Uses DB2I_SCHEMA env var if schema not provided.'}`,
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        schema: z.string().optional().describe(`Schema (library) name containing the table. ${sessionConfig ? 'Uses session default schema if not provided.' : 'Uses DB2I_SCHEMA env var if not provided.'}`),
        table: z.string().describe('Table name to get constraints for'),
      },
      outputSchema: tableConstraintsOutputSchema,
    },
    withToolHandler(
      (args, sessionId) => getTableConstraintsTool({ 
        schema: args.schema ?? getDefaultSchema(), 
        table: args.table,
        sessionId,
      }),
      'Failed to get constraints',
      sessionContext
    )
  );

  return server;
}
