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
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { getEnabledTools, getResponseFormat, type DB2iConfig } from './config.js';
import { executeQueryTool } from './tools/query.js';
import {
  listSchemasTool,
  listTablesTool,
  searchTablesTool,
  searchColumnsTool,
  describeTableTool,
  listViewsTool,
  listIndexesTool,
  getTableConstraintsTool,
} from './tools/metadata.js';
import {
  getJournalInfoTool,
  getObjectDdlTool,
  getRelatedObjectsTool,
  validateQueryTool,
} from './tools/sqlServices.js';
import { profileTableTool } from './tools/profile.js';
import { getBusinessContextTool } from './customTools/context.js';
import { bindCustomToolArgs, executeCustomTool } from './customTools/execute.js';
import { getCustomTools, type StoredTool } from './customTools/registry.js';
import type { LoadedCustomTools } from './customTools/loader.js';
import { getSessionManager } from './transports/sessionManager.js';
import { inputSchemaFor } from './customTools/schema.js';
import { SQL_OBJECT_TYPES } from './db/sqlServices.js';
import { MAX_COMPUTED_COLUMNS } from './db/profile.js';
import { getRateLimiter } from './utils/rateLimiter.js';
import { writeAudit, type AuditCall } from './utils/auditLog.js';
import { formatToolText } from './utils/formatResult.js';

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

const queryOutputSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  violations: z.array(z.string()).optional(),
  data: z.array(z.unknown()).optional(),
  rowCount: z.number().int().optional(),
  limitApplied: z.number().int().optional(),
});

const listSchemasOutputSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  data: z.array(z.object({
    schema_name: z.string(),
    schema_text: z.string().nullable(),
  })).optional(),
  count: z.number().int().optional(),
});

const listTablesOutputSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  data: z.array(z.object({
    table_name: z.string(),
    table_type: z.string(),
    table_text: z.string().nullable(),
    business_description: z.string().optional(),
  })).optional(),
  count: z.number().int().optional(),
});

const searchTablesOutputSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  data: z.array(z.object({
    schema_name: z.string(),
    table_name: z.string(),
    table_type: z.string(),
    table_text: z.string().nullable(),
    business_description: z.string().optional(),
  })).optional(),
  count: z.number().int().optional(),
  truncated: z.boolean().optional(),
});

const searchColumnsOutputSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  data: z.array(z.object({
    schema_name: z.string(),
    table_name: z.string(),
    column_name: z.string(),
    system_column_name: z.string(),
    data_type: z.string(),
    length: z.number().nullable(),
    numeric_scale: z.number().nullable(),
    column_text: z.string().nullable(),
    business_description: z.string().optional(),
  })).optional(),
  count: z.number().int().optional(),
  truncated: z.boolean().optional(),
});

const describeTableOutputSchema = z.object({
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
    business_description: z.string().optional(),
  })).optional(),
  count: z.number().int().optional(),
  business_description: z.string().optional(),
  relations: z.array(z.object({
    table: z.string(),
    join: z.record(z.string(), z.string()),
    cardinality: z.string().optional(),
    description: z.string().optional(),
  })).optional(),
});

const listViewsOutputSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  data: z.array(z.object({
    view_name: z.string(),
    view_text: z.string().nullable(),
  })).optional(),
  count: z.number().int().optional(),
});

const listIndexesOutputSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  data: z.array(z.object({
    index_name: z.string(),
    index_schema: z.string(),
    is_unique: z.string(),
    column_names: z.string(),
  })).optional(),
  count: z.number().int().optional(),
});

const validateQueryOutputSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  valid: z.boolean().optional(),
  statementType: z.string().nullable().optional(),
  missingTables: z.array(z.string()).optional(),
  missingColumns: z.array(z.string()).optional(),
  missingRoutines: z.array(z.string()).optional(),
  violations: z.array(z.string()).optional(),
});

const objectDdlOutputSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  schema: z.string().optional(),
  object: z.string().optional(),
  type: z.string().optional(),
  ddl: z.string().optional(),
});

const relatedObjectsOutputSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  data: z.array(z.object({
    sql_object_type: z.string(),
    schema_name: z.string().nullable(),
    sql_name: z.string().nullable(),
    library_name: z.string().nullable(),
    system_name: z.string().nullable(),
    object_text: z.string().nullable(),
  })).optional(),
  count: z.number().int().optional(),
});

const journalInfoOutputSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  schema: z.string().optional(),
  data: z.array(z.object({
    table_name: z.string(),
    system_table_name: z.string(),
    journaled: z.boolean(),
    journal_library: z.string().nullable(),
    journal_name: z.string().nullable(),
    journal_images: z.string().nullable(),
    omit_entries: z.string().nullable(),
    journal_start: z.string().nullable(),
    has_primary_key: z.boolean(),
    needs_attention: z.boolean(),
  })).optional(),
  count: z.number().int().optional(),
  needsAttention: z.number().int().optional(),
  truncated: z.boolean().optional(),
});

const profileTableOutputSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  schema: z.string().optional(),
  table: z.string().optional(),
  mode: z.enum(['stored', 'computed']).optional(),
  table_stats: z.object({
    number_rows: z.number().nullable(),
    number_deleted_rows: z.number().nullable(),
    data_size: z.number().nullable(),
    last_change: z.string().nullable(),
    last_used: z.string().nullable(),
  }).nullable().optional(),
  computed_rows: z.number().nullable().optional(),
  data: z.array(z.object({
    column_name: z.string(),
    data_type: z.string(),
    source: z.enum(['stored', 'computed', 'none']),
    distinct_values: z.number().nullable(),
    null_count: z.number().nullable(),
    low: z.string().nullable(),
    high: z.string().nullable(),
    statistics_updated: z.string().nullable().optional(),
    masked: z.enum(['redact', 'last4']).optional(),
  })).optional(),
  count: z.number().int().optional(),
  truncated: z.boolean().optional(),
  sql: z.string().optional(),
});

const businessContextOutputSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  data: z.array(z.object({
    table: z.string(),
    entity: z.string().optional(),
    description: z.string().optional(),
    columns: z.record(z.string(), z.string()).optional(),
    relations: z.array(z.object({
      table: z.string(),
      join: z.record(z.string(), z.string()),
      cardinality: z.string().optional(),
      description: z.string().optional(),
    })).optional(),
  })).optional(),
  count: z.number().int().optional(),
});

const tableConstraintsOutputSchema = z.object({
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
});

interface ToolAudit<TArgs> {
  tool: string;
  /** SQL and arguments to record. Metadata tools pass sql: null and their arguments. */
  audit?: (args: TArgs) => Pick<AuditCall, 'sql' | 'params' | 'args'>;
  /** SQL the handler built at run time, read from a successful result. */
  resultSql?: (result: ToolResult) => string | undefined;
}

/**
 * Creates a tool handler wrapper that applies rate limiting and standardizes responses.
 * Eliminates boilerplate code across all tool registrations.
 * 
 * @param handler - The tool handler function
 * @param errorMessage - Error message to use on failure
 * @param sessionContext - Optional session context for HTTP transport
 * @param audit - Tool name and how to read SQL or arguments for the audit log
 */
export function withToolHandler<TArgs, TResult extends ToolResult>(
  handler: (args: TArgs, sessionId?: string) => Promise<TResult>,
  errorMessage: string,
  sessionContext?: SessionContext,
  audit?: ToolAudit<TArgs>,
): (args: TArgs) => Promise<McpToolResponse> {
  return async (args: TArgs): Promise<McpToolResponse> => {
    const facts = audit?.audit?.(args) ?? {};
    const identity = sessionContext?.config.username || 'stdio';

    // Check rate limit
    const rateLimiter = getRateLimiter();
    const rateResult = rateLimiter.checkLimit(sessionContext?.sessionId ?? 'stdio');

    if (!rateResult.allowed) {
      const error = rateLimiter.formatError(rateResult);
      recordAudit(audit?.tool, identity, facts, { outcome: 'rate_limited', error: error.error });
      const structured = { success: false, error: error.error };
      return {
        content: [{ type: 'text', text: formatToolText(error, getResponseFormat()) }],
        structuredContent: structured,
        isError: true,
      };
    }

    const started = Date.now();
    let result: TResult;
    try {
      result = await handler(args, sessionContext?.sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : errorMessage;
      recordAudit(audit?.tool, identity, facts, {
        outcome: 'error',
        error: message,
        durationMs: Date.now() - started,
      });
      throw error;
    }

    const durationMs = Date.now() - started;
    if (!result.success) {
      const message = result.error ?? errorMessage;
      recordAudit(audit?.tool, identity, facts, {
        outcome: 'error',
        error: message,
        durationMs,
        rowCount: rowCountOf(result),
      });
      const structured = {
        success: false,
        error: message,
        ...('violations' in result && result.violations
          ? { violations: result.violations }
          : {}),
      };
      return {
        content: [{ type: 'text', text: message }],
        structuredContent: structured,
        isError: true,
      };
    }

    const builtSql = audit?.resultSql?.(result);
    recordAudit(audit?.tool, identity, builtSql ? { ...facts, sql: builtSql } : facts, {
      outcome: 'success',
      durationMs,
      rowCount: rowCountOf(result),
    });
    return {
      content: [{ type: 'text', text: formatToolText(result, getResponseFormat()) }],
      structuredContent: result,
    };
  };
}

function recordAudit(
  tool: string | undefined,
  identity: string,
  facts: Pick<AuditCall, 'sql' | 'params' | 'args'>,
  outcome: Pick<AuditCall, 'outcome' | 'error' | 'durationMs' | 'rowCount'>,
): void {
  if (!tool) {
    return;
  }
  writeAudit({ tool, identity, ...facts, ...outcome });
}

function rowCountOf(result: ToolResult): number | undefined {
  if (typeof result.rowCount === 'number') {
    return result.rowCount;
  }
  if (typeof result.count === 'number') {
    return result.count;
  }
  if (Array.isArray(result.data)) {
    return result.data.length;
  }
  return undefined;
}

function sqlAudit<T extends { sql?: string; params?: unknown[] }>(tool: string): ToolAudit<T> {
  return {
    tool,
    audit: (args) => ({ sql: args.sql ?? null, params: args.params ?? [] }),
  };
}

function argsAudit<T extends Record<string, unknown>>(tool: string): ToolAudit<T> {
  return {
    tool,
    audit: (args) => ({
      sql: null,
      args: Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined)),
    }),
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

  const loadedTools = getCustomTools();
  const enabledTools = new Set(getEnabledTools(loadedTools.tools));

  if (enabledTools.has('execute_query')) {
    server.registerTool(
      'execute_query',
      {
        title: 'Execute SQL Query',
        description: 'Execute a read-only SQL SELECT query against the IBM DB2i database. Only SELECT statements are allowed for security. Results are limited by default to prevent large result sets.',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: z.object({
          sql: z.string().describe('SQL SELECT query to execute'),
          params: z.array(z.unknown()).optional().describe('Query parameters for prepared statement'),
          limit: z.number().int().positive().optional().default(1000).describe('Maximum number of rows to return (default: 1000, max: configured via QUERY_MAX_LIMIT)'),
        }),
        outputSchema: queryOutputSchema,
      },
      withToolHandler(
        (args, sessionId) => executeQueryTool({
          sql: args.sql,
          params: args.params,
          limit: args.limit,
          sessionId,
          defaultSchema: getDefaultSchema(),
        }),
        'Query failed',
        sessionContext,
        sqlAudit('execute_query'),
      )
    );
  }

  if (enabledTools.has('list_schemas')) {
    server.registerTool(
      'list_schemas',
      {
        title: 'List Schemas',
        description: 'List all schemas (libraries) in the IBM DB2i database. Optionally filter by name pattern using * as wildcard.',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: z.object({
          filter: z.string().optional().describe('Filter pattern for schema names. Use * as wildcard. Example: "QSYS*" matches schemas starting with QSYS'),
        }),
        outputSchema: listSchemasOutputSchema,
      },
      withToolHandler(
        (args, sessionId) => listSchemasTool({ filter: args.filter, sessionId }),
        'Failed to list schemas',
        sessionContext,
        argsAudit('list_schemas'),
      )
    );
  }

  if (enabledTools.has('list_tables')) {
    server.registerTool(
      'list_tables',
      {
        title: 'List Tables',
        description: `List all tables in a schema (library). ${sessionConfig ? 'Uses session default schema if not provided.' : 'Uses DB2I_SCHEMA env var if schema not provided.'} Optionally filter by name pattern using * as wildcard.`,
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: z.object({
          schema: z.string().optional().describe(`Schema (library) name to list tables from. ${sessionConfig ? 'Uses session default schema if not provided.' : 'Uses DB2I_SCHEMA env var if not provided.'}`),
          filter: z.string().optional().describe('Filter pattern for table names. Use * as wildcard. Example: "CUST*" matches tables starting with CUST'),
        }),
        outputSchema: listTablesOutputSchema,
      },
      withToolHandler(
        (args, sessionId) => listTablesTool({ 
          schema: args.schema ?? getDefaultSchema(), 
          filter: args.filter,
          sessionId,
        }),
        'Failed to list tables',
        sessionContext,
        argsAudit('list_tables'),
      )
    );
  }

  if (enabledTools.has('search_tables')) {
    server.registerTool(
      'search_tables',
      {
        title: 'Search Tables',
        description: 'Find tables by name or description text across libraries. Matches TABLE_NAME, SYSTEM_TABLE_NAME, and TABLE_TEXT. Use * as a wildcard. When QUERY_ALLOWED_SCHEMAS is set, only those libraries are searched. Otherwise system libraries (Q* and SYS*) are skipped unless include_system is true.',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: z.object({
          filter: z.string().describe('Name or text to match. Use * as a wildcard. Example: "ORDER*" matches tables starting with ORDER'),
          schema: z.string().optional().describe('Limit the search to one library. Must be in QUERY_ALLOWED_SCHEMAS when that list is set.'),
          include_system: z.boolean().optional().describe('Include Q* and SYS* libraries. Ignored when a schema or QUERY_ALLOWED_SCHEMAS is set.'),
          limit: z.number().int().positive().optional().describe('Maximum rows to return. Capped by QUERY_MAX_LIMIT.'),
        }),
        outputSchema: searchTablesOutputSchema,
      },
      withToolHandler(
        (args, sessionId) => searchTablesTool({
          filter: args.filter,
          schema: args.schema,
          includeSystem: args.include_system,
          limit: args.limit,
          sessionId,
        }),
        'Failed to search tables',
        sessionContext,
        argsAudit('search_tables'),
      )
    );
  }

  if (enabledTools.has('search_columns')) {
    server.registerTool(
      'search_columns',
      {
        title: 'Search Columns',
        description: 'Find columns by name or description text across libraries. Matches COLUMN_NAME, SYSTEM_COLUMN_NAME, and COLUMN_TEXT. Use * as a wildcard. When QUERY_ALLOWED_SCHEMAS is set, only those libraries are searched. Otherwise system libraries (Q* and SYS*) are skipped unless include_system is true.',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: z.object({
          filter: z.string().describe('Name or text to match. Use * as a wildcard. Example: "ITEM*" matches columns starting with ITEM'),
          schema: z.string().optional().describe('Limit the search to one library. Must be in QUERY_ALLOWED_SCHEMAS when that list is set.'),
          include_system: z.boolean().optional().describe('Include Q* and SYS* libraries. Ignored when a schema or QUERY_ALLOWED_SCHEMAS is set.'),
          limit: z.number().int().positive().optional().describe('Maximum rows to return. Capped by QUERY_MAX_LIMIT.'),
        }),
        outputSchema: searchColumnsOutputSchema,
      },
      withToolHandler(
        (args, sessionId) => searchColumnsTool({
          filter: args.filter,
          schema: args.schema,
          includeSystem: args.include_system,
          limit: args.limit,
          sessionId,
        }),
        'Failed to search columns',
        sessionContext,
        argsAudit('search_columns'),
      )
    );
  }

  if (enabledTools.has('describe_table')) {
    server.registerTool(
      'describe_table',
      {
        title: 'Describe Table',
        description: `Get detailed column information for a specific table including data types, lengths, nullability, defaults, and CCSID. ${sessionConfig ? 'Uses session default schema if not provided.' : 'Uses DB2I_SCHEMA env var if schema not provided.'}`,
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: z.object({
          schema: z.string().optional().describe(`Schema (library) name containing the table. ${sessionConfig ? 'Uses session default schema if not provided.' : 'Uses DB2I_SCHEMA env var if not provided.'}`),
          table: z.string().describe('Table name to describe'),
        }),
        outputSchema: describeTableOutputSchema,
      },
      withToolHandler(
        (args, sessionId) => describeTableTool({ 
          schema: args.schema ?? getDefaultSchema(), 
          table: args.table,
          sessionId,
        }),
        'Failed to describe table',
        sessionContext,
        argsAudit('describe_table'),
      )
    );
  }

  if (enabledTools.has('list_views')) {
    server.registerTool(
      'list_views',
      {
        title: 'List Views',
        description: `List all views in a schema (library). ${sessionConfig ? 'Uses session default schema if not provided.' : 'Uses DB2I_SCHEMA env var if schema not provided.'} Optionally filter by name pattern using * as wildcard.`,
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: z.object({
          schema: z.string().optional().describe(`Schema (library) name to list views from. ${sessionConfig ? 'Uses session default schema if not provided.' : 'Uses DB2I_SCHEMA env var if not provided.'}`),
          filter: z.string().optional().describe('Filter pattern for view names. Use * as wildcard.'),
        }),
        outputSchema: listViewsOutputSchema,
      },
      withToolHandler(
        (args, sessionId) => listViewsTool({ 
          schema: args.schema ?? getDefaultSchema(), 
          filter: args.filter,
          sessionId,
        }),
        'Failed to list views',
        sessionContext,
        argsAudit('list_views'),
      )
    );
  }

  if (enabledTools.has('list_indexes')) {
    server.registerTool(
      'list_indexes',
      {
        title: 'List Indexes',
        description: `List all indexes for a specific table including uniqueness and column information. ${sessionConfig ? 'Uses session default schema if not provided.' : 'Uses DB2I_SCHEMA env var if schema not provided.'}`,
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: z.object({
          schema: z.string().optional().describe(`Schema (library) name containing the table. ${sessionConfig ? 'Uses session default schema if not provided.' : 'Uses DB2I_SCHEMA env var if not provided.'}`),
          table: z.string().describe('Table name to list indexes for'),
        }),
        outputSchema: listIndexesOutputSchema,
      },
      withToolHandler(
        (args, sessionId) => listIndexesTool({ 
          schema: args.schema ?? getDefaultSchema(), 
          table: args.table,
          sessionId,
        }),
        'Failed to list indexes',
        sessionContext,
        argsAudit('list_indexes'),
      )
    );
  }

  if (enabledTools.has('get_table_constraints')) {
    server.registerTool(
      'get_table_constraints',
      {
        title: 'Get Table Constraints',
        description: `Get all constraints (primary keys, foreign keys, unique constraints) for a specific table. ${sessionConfig ? 'Uses session default schema if not provided.' : 'Uses DB2I_SCHEMA env var if schema not provided.'}`,
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: z.object({
          schema: z.string().optional().describe(`Schema (library) name containing the table. ${sessionConfig ? 'Uses session default schema if not provided.' : 'Uses DB2I_SCHEMA env var if not provided.'}`),
          table: z.string().describe('Table name to get constraints for'),
        }),
        outputSchema: tableConstraintsOutputSchema,
      },
      withToolHandler(
        (args, sessionId) => getTableConstraintsTool({ 
          schema: args.schema ?? getDefaultSchema(), 
          table: args.table,
          sessionId,
        }),
        'Failed to get constraints',
        sessionContext,
        argsAudit('get_table_constraints'),
      )
    );
  }

  if (enabledTools.has('validate_query')) {
    server.registerTool(
      'validate_query',
      {
        title: 'Validate SQL Query',
        description: 'Check a SQL statement without running it. Parses it with QSYS2.PARSE_STATEMENT and checks that referenced tables, columns, and qualified routines exist in the catalog. Also reports read-only and schema-allowlist findings.',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: z.object({
          sql: z.string().describe('SQL statement to validate. It is not executed.'),
        }),
        outputSchema: validateQueryOutputSchema,
      },
      withToolHandler(
        (args, sessionId) => validateQueryTool({
          sql: args.sql,
          sessionId,
          defaultSchema: getDefaultSchema(),
        }),
        'Validation failed',
        sessionContext,
        sqlAudit('validate_query'),
      )
    );
  }

  if (enabledTools.has('get_object_ddl')) {
    server.registerTool(
      'get_object_ddl',
      {
        title: 'Get Object DDL',
        description: 'Return the SQL DDL that recreates a database object, using QSYS2.GENERATE_SQL. Does not run the generated statements. Requires IBM i 7.3 or later.',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: z.object({
          schema: z.string().optional().describe(`Schema (library) that contains the object. ${sessionConfig ? 'Uses session default schema if not provided.' : 'Uses DB2I_SCHEMA env var if not provided.'}`),
          object: z.string().describe('Object name'),
          type: z.enum(SQL_OBJECT_TYPES).describe('Object type: TABLE, VIEW, INDEX, ALIAS, TRIGGER, FUNCTION, PROCEDURE, or SEQUENCE'),
        }),
        outputSchema: objectDdlOutputSchema,
      },
      withToolHandler(
        (args, sessionId) => getObjectDdlTool({
          schema: args.schema,
          object: args.object,
          type: args.type,
          sessionId,
          defaultSchema: getDefaultSchema(),
        }),
        'Failed to generate DDL',
        sessionContext,
        argsAudit('get_object_ddl'),
      )
    );
  }

  if (enabledTools.has('get_related_objects')) {
    server.registerTool(
      'get_related_objects',
      {
        title: 'Get Related Objects',
        description: 'List views, indexes, triggers, and other objects that depend on a table, using SYSTOOLS.RELATED_OBJECTS. Requires IBM i 7.3 Technology Refresh 9, IBM i 7.4 Technology Refresh 3, or a later release.',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: z.object({
          schema: z.string().optional().describe(`Schema (library) that contains the table. ${sessionConfig ? 'Uses session default schema if not provided.' : 'Uses DB2I_SCHEMA env var if not provided.'}`),
          table: z.string().describe('Table name'),
        }),
        outputSchema: relatedObjectsOutputSchema,
      },
      withToolHandler(
        (args, sessionId) => getRelatedObjectsTool({
          schema: args.schema,
          table: args.table,
          sessionId,
          defaultSchema: getDefaultSchema(),
        }),
        'Failed to list related objects',
        sessionContext,
        argsAudit('get_related_objects'),
      )
    );
  }

  if (enabledTools.has('get_journal_info')) {
    server.registerTool(
      'get_journal_info',
      {
        title: 'Get Journal Info',
        description: 'List the physical data files in a library with their journal, journal library, journal images, omitted entries, and whether they have a primary key, using QSYS2.OBJECT_STATISTICS. needs_attention is true when a table is not journaled, or has no primary key and does not journal both images, which journal-based replication tools need. Requires IBM i 7.3 Technology Refresh 2 or later.',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: z.object({
          schema: z.string().optional().describe(`Schema (library) to inspect. ${sessionConfig ? 'Uses session default schema if not provided.' : 'Uses DB2I_SCHEMA env var if not provided.'}`),
          filter: z.string().optional().describe('Filter pattern for table names. Use * as wildcard. Example: "ORDER*" matches tables starting with ORDER'),
          limit: z.number().int().positive().optional().describe('Maximum rows to return. Capped by QUERY_MAX_LIMIT.'),
        }),
        outputSchema: journalInfoOutputSchema,
      },
      withToolHandler(
        (args, sessionId) => getJournalInfoTool({
          schema: args.schema,
          filter: args.filter,
          limit: args.limit,
          sessionId,
          defaultSchema: getDefaultSchema(),
        }),
        'Failed to read journal info',
        sessionContext,
        argsAudit('get_journal_info'),
      )
    );
  }

  if (enabledTools.has('profile_table')) {
    server.registerTool(
      'profile_table',
      {
        title: 'Profile Table',
        description: `Profile a table for ETL work: row count, deleted rows, size, and last change from QSYS2.SYSTABLESTAT, plus per-column distinct count, null count, and low and high values. By default column numbers come from stored statistics in QSYS2.SYSCOLUMNSTAT (low and high are the second-lowest and second-highest values), and columns without collected statistics report source "none". Set compute to true to scan the table for exact numbers on up to ${MAX_COMPUTED_COLUMNS} columns. Masked columns keep their counts and return no values.`,
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: z.object({
          schema: z.string().optional().describe(`Schema (library) that contains the table. ${sessionConfig ? 'Uses session default schema if not provided.' : 'Uses DB2I_SCHEMA env var if not provided.'}`),
          table: z.string().describe('Table name'),
          compute: z.boolean().optional().describe('Scan the table for exact counts, MIN, and MAX. Slower on large tables. Default false.'),
          columns: z.array(z.string()).optional().describe(`Columns to profile. Defaults to every column (the first ${MAX_COMPUTED_COLUMNS} when compute is true).`),
        }),
        outputSchema: profileTableOutputSchema,
      },
      withToolHandler(
        (args, sessionId) => profileTableTool({
          schema: args.schema,
          table: args.table,
          compute: args.compute,
          columns: args.columns,
          sessionId,
          defaultSchema: getDefaultSchema(),
        }),
        'Failed to profile table',
        sessionContext,
        {
          ...argsAudit('profile_table'),
          resultSql: (result) => (typeof result.sql === 'string' ? result.sql : undefined),
        },
      )
    );
  }

  if (enabledTools.has('get_business_context')) {
    server.registerTool(
      'get_business_context',
      {
        title: 'Get Business Context',
        description: 'List business entities, table and column descriptions, and relations that the catalog does not declare as foreign keys. Filter by entity or table. Omit both to return every annotation loaded from MCP_CUSTOM_TOOLS.',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: z.object({
          entity: z.string().optional().describe('Entity name, for example sales_order'),
          table: z.string().optional().describe('Table name, or SCHEMA.TABLE'),
        }),
        outputSchema: businessContextOutputSchema,
      },
      withToolHandler(
        (args) => Promise.resolve(getBusinessContextTool({
          entity: args.entity,
          table: args.table,
        })),
        'Failed to read business context',
        sessionContext,
        argsAudit('get_business_context'),
      )
    );
  }

  const customRegistrations = new Map<string, LiveCustomTool>();
  for (const tool of loadedTools.tools) {
    if (!enabledTools.has(tool.name)) {
      continue;
    }
    customRegistrations.set(tool.name, registerCustomTool(server, tool, sessionContext, getDefaultSchema));
  }
  rememberLiveCustomTools({
    server,
    tools: customRegistrations,
    sessionContext,
    getDefaultSchema,
  });

  return server;
}

interface LiveCustomTool {
  registered: RegisteredTool;
  signature: string;
}

interface LiveCustomTools {
  server: McpServer;
  tools: Map<string, LiveCustomTool>;
  sessionContext?: SessionContext;
  getDefaultSchema: () => string | undefined;
}

const liveCustomTools = new WeakMap<McpServer, LiveCustomTools>();
const stdioServers = new Set<McpServer>();

function rememberLiveCustomTools(live: LiveCustomTools): void {
  liveCustomTools.set(live.server, live);
}

/**
 * Stdio pins one server for the connection. Drop it when that connection closes.
 */
export function pinStdioServer(server: McpServer): () => void {
  stdioServers.add(server);
  return () => {
    stdioServers.delete(server);
  };
}

/** Registered custom tool on a live server, for tests. */
export function liveCustomTool(server: McpServer, name: string): RegisteredTool | undefined {
  return liveCustomTools.get(server)?.tools.get(name)?.registered;
}

/**
 * Apply a validated tool set to servers that outlive a single request.
 */
export function syncLiveCustomTools(loaded: LoadedCustomTools, enabled: ReadonlySet<string>): void {
  const servers = new Set<McpServer>(stdioServers);
  for (const server of getSessionManager().listServers()) {
    servers.add(server);
  }
  for (const server of servers) {
    const live = liveCustomTools.get(server);
    if (!live) {
      continue;
    }
    syncOneServer(live, loaded, enabled);
    server.sendToolListChanged();
  }
}

function syncOneServer(
  live: LiveCustomTools,
  loaded: LoadedCustomTools,
  enabled: ReadonlySet<string>,
): void {
  const next = new Map(loaded.tools.filter((tool) => enabled.has(tool.name)).map((tool) => [tool.name, tool]));

  for (const [name, current] of live.tools) {
    if (!next.has(name)) {
      current.registered.remove();
      live.tools.delete(name);
    }
  }

  for (const [name, tool] of next) {
    const signature = toolSignature(tool);
    const current = live.tools.get(name);
    if (!current) {
      live.tools.set(name, registerCustomTool(live.server, tool, live.sessionContext, live.getDefaultSchema));
      continue;
    }
    if (current.signature === signature) {
      continue;
    }
    current.registered.update({
      title: tool.title,
      description: tool.description,
      paramsSchema: inputSchemaFor(tool.parameters),
      callback: customToolCallback(tool, live.sessionContext, live.getDefaultSchema),
    });
    current.signature = signature;
  }
}

function registerCustomTool(
  server: McpServer,
  tool: StoredTool,
  sessionContext: SessionContext | undefined,
  getDefaultSchema: () => string | undefined,
): LiveCustomTool {
  const registered = server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: inputSchemaFor(tool.parameters),
      outputSchema: queryOutputSchema,
    },
    customToolCallback(tool, sessionContext, getDefaultSchema),
  );
  return { registered, signature: toolSignature(tool) };
}

function customToolCallback(
  tool: StoredTool,
  sessionContext: SessionContext | undefined,
  getDefaultSchema: () => string | undefined,
) {
  return withToolHandler(
    (args: unknown, sessionId) => executeCustomTool(tool, args as Record<string, unknown>, {
      sessionId,
      defaultSchema: getDefaultSchema(),
    }),
    'Query failed',
    sessionContext,
    {
      tool: tool.name,
      audit: (args) => {
        const bound = bindCustomToolArgs(tool, args as Record<string, unknown>);
        return { sql: tool.sql, params: bound.ok ? bound.params : [] };
      },
    },
  );
}

function toolSignature(tool: StoredTool): string {
  return JSON.stringify({
    title: tool.title,
    description: tool.description,
    parameters: tool.parameters,
    sql: tool.sql,
    maxRows: tool.maxRows ?? null,
  });
}
