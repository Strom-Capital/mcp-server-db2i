/**
 * MCP Server Factory
 *
 * Creates and configures the MCP server with all tools registered.
 * Extracted from index.ts for testability.
 * 
 * Supports two modes:
 * - Stdio mode: pools owned by `stdio` (no session context)
 * - HTTP mode: pools owned by the caller's session key
 *
 * Each call runs on one IBM i system. When the caller can reach more than one,
 * the tools take an optional `system` argument.
 */

import { createRequire } from 'module';
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { serverIcons } from './branding.js';
import { getEnabledTools, getExportConfig, getResponseFormat } from './config.js';
import { resolveTarget, STDIO_POOL_KEY, systemNames, type DbTarget, type SystemBinding } from './systems.js';
import { executeQueryTool } from './tools/query.js';
import { exportQueryTool } from './tools/exportQuery.js';
import { EXPORT_CONTENT_TYPES } from './export/store.js';
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
  searchIbmiServicesTool,
  validateQueryTool,
} from './tools/sqlServices.js';
import { indexAdviceTool } from './tools/indexAdvice.js';
import { describeRoutineTool, listRoutinesTool } from './tools/routines.js';
import { profileTableTool } from './tools/profile.js';
import { getBusinessContextTool } from './customTools/context.js';
import { bindCustomToolArgs, executeCustomTool } from './customTools/execute.js';
import { getCustomTools, type StoredTool } from './customTools/registry.js';
import type { LoadedCustomTools } from './customTools/loader.js';
import { getSessionManager } from './transports/sessionManager.js';
import { inputSchemaFor } from './customTools/schema.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { SQL_OBJECT_TYPES } from './db/sqlServices.js';
import { MAX_COMPUTED_COLUMNS } from './db/profile.js';
import type { SqlErrorDetails } from './db/sqlErrorInfo.js';
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
  /** Session/token ID that owns the connection pools */
  sessionId: string;
  /**
   * Set for a session that logged in at /auth. Its credentials were checked on
   * one system, so every call runs there.
   */
  binding?: SystemBinding;
}

/** Systems a caller may name in a tool's `system` argument. */
function reachableSystems(sessionContext?: SessionContext): string[] {
  return sessionContext?.binding ? [sessionContext.binding.system] : systemNames();
}

/**
 * The optional `system` argument, when the caller can reach more than one
 * system. Typed as empty so the tool argument types stay as they were; the
 * handler reads the value through withToolHandler.
 */
function systemShape(sessionContext?: SessionContext): Record<never, never> {
  const names = reachableSystems(sessionContext);
  if (names.length < 2) {
    return {};
  }
  return {
    system: z.enum(names as [string, ...string[]]).optional().describe(
      `IBM i system to run on. Defaults to ${names[0]}.`
    ),
  };
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
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'resource_link'; uri: string; name: string; mimeType?: string; description?: string }
  >;
  structuredContent?: Record<string, unknown>;
  isError?: true;
};

/** Appended to tool and `schema` argument descriptions. */
const SCHEMA_DEFAULT_HINT = "Uses the system's default schema if not provided.";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

// Returned with `error` when Db2 rejected the statement (see src/db/sqlErrorInfo.ts)
const sqlErrorOutputFields = {
  sqlstate: z.string().optional().describe('SQLSTATE of the failed statement'),
  sqlcode: z.number().int().optional().describe('SQLCODE of the failed statement, such as -204'),
  cause: z.string().optional().describe('Why the statement failed. &1-style placeholders stand for values in error.'),
  recovery: z.string().optional().describe('What to change before trying again'),
};

const queryOutputSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  ...sqlErrorOutputFields,
  violations: z.array(z.string()).optional(),
  data: z.array(z.unknown()).optional(),
  rowCount: z.number().int().optional(),
  limitApplied: z.number().int().optional(),
});

const exportOutputSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  ...sqlErrorOutputFields,
  violations: z.array(z.string()).optional(),
  format: z.enum(['csv', 'xlsx']).optional(),
  filename: z.string().optional().describe('Name the download is saved as'),
  rowCount: z.number().int().optional(),
  bytes: z.number().int().optional(),
  truncated: z.union([z.literal(false), z.enum(['rows', 'bytes'])]).optional()
    .describe('rows or bytes when the file stops at max_rows / EXPORT_MAX_ROWS or EXPORT_MAX_BYTES'),
  columns: z.array(z.object({ name: z.string(), kind: z.string() })).optional(),
  sample: z.array(z.record(z.string(), z.unknown())).optional().describe('First rows of the file, masked'),
  warnings: z.array(z.string()).optional().describe('Tell the user these, such as columns the driver rounded'),
  path: z.string().optional().describe('The file on the server host (stdio)'),
  url: z.string().optional().describe('Download link for the user (HTTP)'),
  expiresAt: z.string().optional(),
  downloadsAllowed: z.number().int().optional().describe('Downloads the link allows before it stops working'),
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
  ...sqlErrorOutputFields,
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

const servicesOutputSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  categories: z.array(z.object({
    category: z.string(),
    count: z.number().int(),
  })).optional(),
  data: z.array(z.object({
    service_name: z.string(),
    category: z.string(),
    schema: z.string(),
    sql_object_type: z.string().nullable(),
    system_object_name: z.string().nullable(),
    earliest_release: z.string().nullable(),
    initial_db2_group_level: z.number().int().nullable(),
    latest_db2_group_level: z.number().int().nullable(),
    example: z.string().nullable().optional(),
  })).optional(),
  count: z.number().int().optional(),
  truncated: z.boolean().optional(),
});

const indexAdviceOutputSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  ...sqlErrorOutputFields,
  schema: z.string().optional(),
  table: z.string().optional(),
  since: z.string().optional(),
  data: z.array(z.object({
    schema: z.string(),
    table: z.string(),
    key_columns: z.array(z.string()),
    index_type: z.string(),
    times_advised: z.number(),
    mti_used: z.number(),
    mti_created: z.number(),
    last_advised: z.string().nullable(),
    last_mti_used: z.string().nullable(),
    reasons: z.array(z.object({
      code: z.string(),
      description: z.string().nullable(),
    })),
    rows_merged: z.number().int(),
  })).optional(),
  count: z.number().int().optional(),
  truncated: z.boolean().optional(),
});

const routineShape = {
  schema: z.string(),
  name: z.string(),
  specific_name: z.string(),
  type: z.enum(['PROCEDURE', 'SCALAR FUNCTION', 'TABLE FUNCTION']),
  language: z.string().nullable(),
  external_name: z.string().nullable(),
  sql_data_access: z.string().nullable(),
  result_sets: z.number().int().nullable(),
  parameter_count: z.number().int(),
  text: z.string().nullable(),
  last_altered: z.string().nullable(),
};

const routineColumnShape = {
  position: z.number().int(),
  name: z.string().nullable(),
  data_type: z.string(),
  length: z.number().nullable(),
  precision: z.number().nullable(),
  scale: z.number().nullable(),
  nullable: z.boolean(),
  text: z.string().nullable(),
};

const listRoutinesOutputSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  ...sqlErrorOutputFields,
  schema: z.string().optional(),
  data: z.array(z.object(routineShape)).optional(),
  count: z.number().int().optional(),
  truncated: z.boolean().optional(),
});

const describeRoutineOutputSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  ...sqlErrorOutputFields,
  schema: z.string().optional(),
  data: z.array(z.object({
    ...routineShape,
    parameters: z.array(z.object({
      ...routineColumnShape,
      mode: z.string(),
      default: z.string().nullable(),
    })),
    returns: z.object(routineColumnShape).nullable().optional(),
    result_columns: z.array(z.object(routineColumnShape)).optional(),
    call_template: z.string(),
    callable_with_execute_query: z.boolean(),
    note: z.string().optional(),
  })).optional(),
  count: z.number().int().optional(),
  truncated: z.boolean().optional(),
});

const profileTableOutputSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  ...sqlErrorOutputFields,
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
 * @param systemOf - Reads the requested system from the arguments. Defaults to the `system` argument.
 */
export function withToolHandler<TArgs, TResult extends ToolResult>(
  handler: (args: TArgs, target: DbTarget) => Promise<TResult>,
  errorMessage: string,
  sessionContext?: SessionContext,
  audit?: ToolAudit<TArgs>,
  systemOf: (args: TArgs) => string | undefined = systemArgOf,
): (args: TArgs) => Promise<McpToolResponse> {
  return async (args: TArgs): Promise<McpToolResponse> => {
    const facts = audit?.audit?.(args) ?? {};
    const requested = systemOf(args);

    let target: DbTarget | undefined;
    let targetError: string | undefined;
    try {
      target = resolveTarget(sessionContext?.sessionId ?? STDIO_POOL_KEY, requested, sessionContext?.binding);
    } catch (error) {
      // An unknown system, or connection settings that cannot be read
      targetError = error instanceof Error ? error.message : errorMessage;
    }
    const system = target?.system ?? requested;
    const identity = !sessionContext
      ? 'stdio'
      : target?.config.username ?? sessionContext.binding?.config.username ?? 'unknown';

    // Check rate limit
    const rateLimiter = getRateLimiter();
    const rateResult = rateLimiter.checkLimit(sessionContext?.sessionId ?? 'stdio');

    if (!rateResult.allowed) {
      const error = rateLimiter.formatError(rateResult);
      recordAudit(audit?.tool, identity, system, facts, { outcome: 'rate_limited', error: error.error });
      const structured = { success: false, error: error.error };
      return {
        content: [{ type: 'text', text: formatToolText(error, getResponseFormat()) }],
        structuredContent: structured,
        isError: true,
      };
    }

    if (!target) {
      const message = targetError ?? errorMessage;
      recordAudit(audit?.tool, identity, system, facts, { outcome: 'error', error: message });
      return {
        content: [{ type: 'text', text: message }],
        structuredContent: { success: false, error: message },
        isError: true,
      };
    }

    const started = Date.now();
    let result: TResult;
    try {
      result = await handler(args, target);
    } catch (error) {
      const message = error instanceof Error ? error.message : errorMessage;
      recordAudit(audit?.tool, identity, system, facts, {
        outcome: 'error',
        error: message,
        durationMs: Date.now() - started,
      });
      throw error;
    }

    const durationMs = Date.now() - started;
    if (!result.success) {
      const message = result.error ?? errorMessage;
      recordAudit(audit?.tool, identity, system, facts, {
        outcome: 'error',
        error: message,
        durationMs,
        rowCount: rowCountOf(result),
      });
      const sqlError = sqlErrorFieldsOf(result);
      const structured = {
        success: false,
        error: message,
        ...('violations' in result && result.violations
          ? { violations: result.violations }
          : {}),
        ...sqlError,
      };
      return {
        content: [{ type: 'text', text: withCauseAndRecovery(message, sqlError) }],
        structuredContent: structured,
        isError: true,
      };
    }

    const builtSql = audit?.resultSql?.(result);
    recordAudit(audit?.tool, identity, system, builtSql ? { ...facts, sql: builtSql } : facts, {
      outcome: 'success',
      durationMs,
      rowCount: rowCountOf(result),
      ...(typeof result.bytes === 'number' ? { bytes: result.bytes } : {}),
    });
    return {
      content: [{ type: 'text', text: formatToolText(result, getResponseFormat()) }],
      structuredContent: result,
    };
  };
}

/** The SQLSTATE, SQLCODE, cause and recovery a failed tool result carries. */
function sqlErrorFieldsOf(result: object): SqlErrorDetails {
  const fields: SqlErrorDetails = {};
  const source = result as Record<string, unknown>;
  if (typeof source.sqlstate === 'string') fields.sqlstate = source.sqlstate;
  if (typeof source.sqlcode === 'number') fields.sqlcode = source.sqlcode;
  if (typeof source.cause === 'string') fields.cause = source.cause;
  if (typeof source.recovery === 'string') fields.recovery = source.recovery;
  return fields;
}

/** The error text, followed by the cause and recovery when Db2 gave them. */
function withCauseAndRecovery(message: string, fields: SqlErrorDetails): string {
  const lines = [message];
  if (fields.cause) lines.push(`Cause: ${fields.cause}`);
  if (fields.recovery) lines.push(`Recovery: ${fields.recovery}`);
  return lines.join('\n\n');
}

function systemArgOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) {
    return undefined;
  }
  const value = (args as { system?: unknown }).system;
  return typeof value === 'string' ? value : undefined;
}

function recordAudit(
  tool: string | undefined,
  identity: string,
  system: string | undefined,
  facts: Pick<AuditCall, 'sql' | 'params' | 'args'>,
  outcome: Pick<AuditCall, 'outcome' | 'error' | 'durationMs' | 'rowCount' | 'bytes'>,
): void {
  if (!tool) {
    return;
  }
  writeAudit({ tool, identity, ...(system ? { system } : {}), ...facts, ...outcome });
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
      args: Object.fromEntries(
        Object.entries(args).filter(([key, value]) => value !== undefined && key !== 'system')
      ),
    }),
  };
}

/**
 * Create and configure the MCP server with all tools registered.
 *
 * @param sessionContext - HTTP session that owns the pools. Omit for stdio.
 * @returns Configured McpServer instance ready to connect to a transport
 */
export function createServer(sessionContext?: SessionContext): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    icons: serverIcons(),
  });

  const system = systemShape(sessionContext);

  const loadedTools = getCustomTools();
  const enabledTools = new Set(getEnabledTools(loadedTools.tools));

  if (enabledTools.has('execute_query')) {
    server.registerTool(
      'execute_query',
      {
        title: 'Execute SQL Query',
        description: 'Execute a read-only SQL SELECT query against the IBM Db2i database. Only SELECT statements are allowed for security. Results are limited by default to prevent large result sets.',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: z.object({
          ...system,
          sql: z.string().describe('SQL SELECT query to execute'),
          params: z.array(z.unknown()).optional().describe('Query parameters for prepared statement'),
          limit: z.number().int().positive().optional().describe('Maximum number of rows to return (default: QUERY_DEFAULT_LIMIT, max: QUERY_MAX_LIMIT)'),
        }),
        outputSchema: queryOutputSchema,
      },
      withToolHandler(
        (args, target) => executeQueryTool({
          sql: args.sql,
          params: args.params,
          limit: args.limit,
          target,
          defaultSchema: target.defaultSchema,
        }),
        'Query failed',
        sessionContext,
        sqlAudit('execute_query'),
      )
    );
  }

  if (enabledTools.has('export_query') && getExportConfig()) {
    const delivery = sessionContext ? 'link' : 'path';
    const handler = withToolHandler(
      (args: { sql: string; params?: unknown[]; format?: 'csv' | 'xlsx'; filename?: string; max_rows?: number }, target) =>
        exportQueryTool({
          sql: args.sql,
          params: args.params,
          format: args.format,
          filename: args.filename,
          maxRows: args.max_rows,
          delivery,
          owner: sessionContext ? target.config.username : 'stdio',
          target,
          defaultSchema: target.defaultSchema,
        }),
      'Export failed',
      sessionContext,
      sqlAudit('export_query'),
    );
    server.registerTool(
      'export_query',
      {
        title: 'Export Query to File',
        description:
          'Run a read-only SQL SELECT and write every row to a CSV or Excel (XLSX) file for the user, instead of returning the rows. ' +
          'Use it when the user asks for a file, a spreadsheet, or more rows than execute_query returns. ' +
          (delivery === 'link'
            ? 'The result has a download link: give it to the user as is, and do not open it yourself, because each download counts against a small limit. It expires after a few minutes. '
            : 'The result has the file path on this machine: tell the user where the file is. ') +
          'The result also has the row count, the columns, and a few sample rows so you can check the export. ' +
          'Same checks as execute_query; masked columns are masked in the file.',
        annotations: { ...READ_ONLY_ANNOTATIONS, idempotentHint: false },
        inputSchema: z.object({
          ...system,
          sql: z.string().describe('SQL SELECT query to export'),
          params: z.array(z.unknown()).optional().describe('Query parameters for prepared statement'),
          format: z.enum(['csv', 'xlsx']).optional().describe('File format. Default: xlsx'),
          filename: z.string().max(120).optional().describe('Name for the file, without extension, e.g. open-orders-1001'),
          max_rows: z.number().int().positive().optional().describe('Most rows to write (capped by EXPORT_MAX_ROWS)'),
        }),
        outputSchema: exportOutputSchema,
      },
      async (args) => {
        const response = await handler(args);
        const url = response.structuredContent?.url;
        const filename = response.structuredContent?.filename;
        if (typeof url === 'string' && typeof filename === 'string') {
          response.content.push({
            type: 'resource_link',
            uri: url,
            name: filename,
            mimeType: EXPORT_CONTENT_TYPES[filename.endsWith('.csv') ? 'csv' : 'xlsx'],
            description: 'Query export for the user to download',
          });
        }
        return response;
      }
    );
  }

  if (enabledTools.has('list_schemas')) {
    server.registerTool(
      'list_schemas',
      {
        title: 'List Schemas',
        description: 'List all schemas (libraries) in the IBM Db2i database. Optionally filter by name pattern using * as wildcard.',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: z.object({
          ...system,
          filter: z.string().optional().describe('Filter pattern for schema names. Use * as wildcard. Example: "QSYS*" matches schemas starting with QSYS'),
        }),
        outputSchema: listSchemasOutputSchema,
      },
      withToolHandler(
        (args, target) => listSchemasTool({ filter: args.filter, target }),
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
        description: `List all tables in a schema (library). ${SCHEMA_DEFAULT_HINT} Optionally filter by name pattern using * as wildcard.`,
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: z.object({
          ...system,
          schema: z.string().optional().describe(`Schema (library) name to list tables from. ${SCHEMA_DEFAULT_HINT}`),
          filter: z.string().optional().describe('Filter pattern for table names. Use * as wildcard. Example: "CUST*" matches tables starting with CUST'),
        }),
        outputSchema: listTablesOutputSchema,
      },
      withToolHandler(
        (args, target) => listTablesTool({ 
          schema: args.schema ?? target.defaultSchema, 
          filter: args.filter,
          target,
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
        description: 'Find tables by name or description text across libraries. Matches TABLE_NAME, SYSTEM_TABLE_NAME, and TABLE_TEXT. Use * as a wildcard. When a schema allowlist is configured, only those libraries are searched. Otherwise system libraries (Q* and SYS*) are skipped unless include_system is true.',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: z.object({
          ...system,
          filter: z.string().describe('Name or text to match. Use * as a wildcard. Example: "ORDER*" matches tables starting with ORDER'),
          schema: z.string().optional().describe('Limit the search to one library. Must be in the schema allowlist when one is configured.'),
          include_system: z.boolean().optional().describe('Include Q* and SYS* libraries. Ignored when a schema or a schema allowlist is set.'),
          limit: z.number().int().positive().optional().describe('Maximum rows to return. Capped by QUERY_MAX_LIMIT.'),
        }),
        outputSchema: searchTablesOutputSchema,
      },
      withToolHandler(
        (args, target) => searchTablesTool({
          filter: args.filter,
          schema: args.schema,
          includeSystem: args.include_system,
          limit: args.limit,
          target,
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
        description: 'Find columns by name or description text across libraries. Matches COLUMN_NAME, SYSTEM_COLUMN_NAME, and COLUMN_TEXT. Use * as a wildcard. When a schema allowlist is configured, only those libraries are searched. Otherwise system libraries (Q* and SYS*) are skipped unless include_system is true.',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: z.object({
          ...system,
          filter: z.string().describe('Name or text to match. Use * as a wildcard. Example: "ITEM*" matches columns starting with ITEM'),
          schema: z.string().optional().describe('Limit the search to one library. Must be in the schema allowlist when one is configured.'),
          include_system: z.boolean().optional().describe('Include Q* and SYS* libraries. Ignored when a schema or a schema allowlist is set.'),
          limit: z.number().int().positive().optional().describe('Maximum rows to return. Capped by QUERY_MAX_LIMIT.'),
        }),
        outputSchema: searchColumnsOutputSchema,
      },
      withToolHandler(
        (args, target) => searchColumnsTool({
          filter: args.filter,
          schema: args.schema,
          includeSystem: args.include_system,
          limit: args.limit,
          target,
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
        description: `Get detailed column information for a specific table including data types, lengths, nullability, defaults, and CCSID. ${SCHEMA_DEFAULT_HINT}`,
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: z.object({
          ...system,
          schema: z.string().optional().describe(`Schema (library) name containing the table. ${SCHEMA_DEFAULT_HINT}`),
          table: z.string().describe('Table name to describe'),
        }),
        outputSchema: describeTableOutputSchema,
      },
      withToolHandler(
        (args, target) => describeTableTool({ 
          schema: args.schema ?? target.defaultSchema, 
          table: args.table,
          target,
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
        description: `List all views in a schema (library). ${SCHEMA_DEFAULT_HINT} Optionally filter by name pattern using * as wildcard.`,
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: z.object({
          ...system,
          schema: z.string().optional().describe(`Schema (library) name to list views from. ${SCHEMA_DEFAULT_HINT}`),
          filter: z.string().optional().describe('Filter pattern for view names. Use * as wildcard.'),
        }),
        outputSchema: listViewsOutputSchema,
      },
      withToolHandler(
        (args, target) => listViewsTool({ 
          schema: args.schema ?? target.defaultSchema, 
          filter: args.filter,
          target,
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
        description: `List all indexes for a specific table including uniqueness and column information. ${SCHEMA_DEFAULT_HINT}`,
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: z.object({
          ...system,
          schema: z.string().optional().describe(`Schema (library) name containing the table. ${SCHEMA_DEFAULT_HINT}`),
          table: z.string().describe('Table name to list indexes for'),
        }),
        outputSchema: listIndexesOutputSchema,
      },
      withToolHandler(
        (args, target) => listIndexesTool({ 
          schema: args.schema ?? target.defaultSchema, 
          table: args.table,
          target,
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
        description: `Get all constraints (primary keys, foreign keys, unique constraints) for a specific table. ${SCHEMA_DEFAULT_HINT}`,
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: z.object({
          ...system,
          schema: z.string().optional().describe(`Schema (library) name containing the table. ${SCHEMA_DEFAULT_HINT}`),
          table: z.string().describe('Table name to get constraints for'),
        }),
        outputSchema: tableConstraintsOutputSchema,
      },
      withToolHandler(
        (args, target) => getTableConstraintsTool({ 
          schema: args.schema ?? target.defaultSchema, 
          table: args.table,
          target,
        }),
        'Failed to get constraints',
        sessionContext,
        argsAudit('get_table_constraints'),
      )
    );
  }

  if (enabledTools.has('list_routines')) {
    server.registerTool(
      'list_routines',
      {
        title: 'List Routines',
        description: `List SQL procedures and functions in a library from QSYS2.SYSROUTINES, one row per specific routine, so overloads appear once each. Shows the type (procedure, scalar function, or table function), language, external program, SQL data access, result sets, and text. Use describe_routine for parameters and a call template. ${SCHEMA_DEFAULT_HINT}`,
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: z.object({
          ...system,
          schema: z.string().optional().describe(`Schema (library) to list routines in. ${SCHEMA_DEFAULT_HINT}`),
          filter: z.string().optional().describe('Filter routine names. Use * as wildcard, e.g. "GET*". Without a wildcard, matches names containing the text.'),
          type: z.enum(['PROCEDURE', 'FUNCTION']).optional().describe('Only procedures or only functions. Omit for both.'),
          limit: z.number().int().positive().optional().describe('Maximum routines to return. Capped by QUERY_MAX_LIMIT.'),
        }),
        outputSchema: listRoutinesOutputSchema,
      },
      withToolHandler(
        (args, target) => listRoutinesTool({
          schema: args.schema,
          filter: args.filter,
          type: args.type,
          limit: args.limit,
          target,
          defaultSchema: target.defaultSchema,
        }),
        'Failed to list routines',
        sessionContext,
        argsAudit('list_routines'),
      )
    );
  }

  if (enabledTools.has('describe_routine')) {
    server.registerTool(
      'describe_routine',
      {
        title: 'Describe Routine',
        description: `Describe an SQL procedure or function from QSYS2.SYSPARMS: parameters in order with mode, data type, and default; the return value of a scalar function; and the result columns of a table function. An overloaded name returns every overload unless specific_name picks one. call_template is a statement with a ? marker per parameter. callable_with_execute_query says whether execute_query can run it: procedures (CALL) and functions that modify SQL data cannot, and note says why. ${SCHEMA_DEFAULT_HINT}`,
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: z.object({
          ...system,
          schema: z.string().optional().describe(`Schema (library) containing the routine. ${SCHEMA_DEFAULT_HINT}`),
          name: z.string().optional().describe('Routine name. Required unless specific_name is given.'),
          specific_name: z.string().optional().describe('Specific name of one overload, from list_routines.'),
        }),
        outputSchema: describeRoutineOutputSchema,
      },
      withToolHandler(
        (args, target) => describeRoutineTool({
          schema: args.schema,
          name: args.name,
          specificName: args.specific_name,
          target,
          defaultSchema: target.defaultSchema,
        }),
        'Failed to describe routine',
        sessionContext,
        argsAudit('describe_routine'),
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
          ...system,
          sql: z.string().describe('SQL statement to validate. It is not executed.'),
        }),
        outputSchema: validateQueryOutputSchema,
      },
      withToolHandler(
        (args, target) => validateQueryTool({
          sql: args.sql,
          target,
          defaultSchema: target.defaultSchema,
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
          ...system,
          schema: z.string().optional().describe(`Schema (library) that contains the object. ${SCHEMA_DEFAULT_HINT}`),
          object: z.string().describe('Object name'),
          type: z.enum(SQL_OBJECT_TYPES).describe('Object type: TABLE, VIEW, INDEX, ALIAS, TRIGGER, FUNCTION, PROCEDURE, or SEQUENCE'),
        }),
        outputSchema: objectDdlOutputSchema,
      },
      withToolHandler(
        (args, target) => getObjectDdlTool({
          schema: args.schema,
          object: args.object,
          type: args.type,
          target,
          defaultSchema: target.defaultSchema,
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
          ...system,
          schema: z.string().optional().describe(`Schema (library) that contains the table. ${SCHEMA_DEFAULT_HINT}`),
          table: z.string().describe('Table name'),
        }),
        outputSchema: relatedObjectsOutputSchema,
      },
      withToolHandler(
        (args, target) => getRelatedObjectsTool({
          schema: args.schema,
          table: args.table,
          target,
          defaultSchema: target.defaultSchema,
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
          ...system,
          schema: z.string().optional().describe(`Schema (library) to inspect. ${SCHEMA_DEFAULT_HINT}`),
          filter: z.string().optional().describe('Filter pattern for table names. Use * as wildcard. Example: "ORDER*" matches tables starting with ORDER'),
          limit: z.number().int().positive().optional().describe('Maximum rows to return. Capped by QUERY_MAX_LIMIT.'),
        }),
        outputSchema: journalInfoOutputSchema,
      },
      withToolHandler(
        (args, target) => getJournalInfoTool({
          schema: args.schema,
          filter: args.filter,
          limit: args.limit,
          target,
          defaultSchema: target.defaultSchema,
        }),
        'Failed to read journal info',
        sessionContext,
        argsAudit('get_journal_info'),
      )
    );
  }

  if (enabledTools.has('search_ibmi_services')) {
    server.registerTool(
      'search_ibmi_services',
      {
        title: 'Search IBM i Services',
        description: 'Find IBM i SQL services (views, table functions, procedures, and more in QSYS2 and SYSTOOLS) in the catalog QSYS2.SERVICES_INFO, with the release that added each one and an example query. Call it before writing SQL that uses an IBM i service, instead of guessing names and parameters. With no query and no category, it lists the categories with a count each. This tool only reads the catalog. Running an example with execute_query still needs the IBM i authority the service documents and, when QUERY_ALLOWED_SCHEMAS is set, the service\'s schema in that list; while the list is set, examples that call TABLE(...) table functions are rejected.',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: z.object({
          ...system,
          query: z.string().optional().describe('Keywords, all of which must appear in the service name or category (case-insensitive). Example: "journal entries"'),
          category: z.string().optional().describe('Exact category, such as JOURNAL, SECURITY, or WORK MANAGEMENT. Call with no arguments to list them.'),
          include_example: z.boolean().optional().describe('Include the example query for each service. Default true.'),
          search_examples: z.boolean().optional().describe('Also match keywords against the example queries. Default false.'),
          limit: z.number().int().positive().optional().describe('Maximum services to return. Capped by QUERY_MAX_LIMIT.'),
        }),
        outputSchema: servicesOutputSchema,
      },
      withToolHandler(
        (args, target) => searchIbmiServicesTool({
          query: args.query,
          category: args.category,
          includeExample: args.include_example,
          searchExamples: args.search_examples,
          limit: args.limit,
          target,
        }),
        'Failed to search IBM i services',
        sessionContext,
        argsAudit('search_ibmi_services'),
      )
    );
  }

  if (enabledTools.has('index_advice')) {
    server.registerTool(
      'index_advice',
      {
        title: 'Index Advice',
        description: 'List the indexes the query optimizer asked for on the tables of a library, from the IBM i index advisor (QSYS2.SYSIXADV). Rows with the same table, key columns, and index type are merged into one, with counts summed and reason codes described. Sorted by mti_used, then times_advised: advice where the optimizer kept building and reusing a maintained temporary index (MTI) is the strongest signal. key_columns are in CREATE INDEX order and can end in DESC. last_advised and since are in the system\'s local time. This tool only reads the advice; it does not create indexes.',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: z.object({
          ...system,
          schema: z.string().optional().describe(`Schema (library) whose tables to read advice for. ${SCHEMA_DEFAULT_HINT}`),
          table: z.string().optional().describe('Table name. Omit for every table in the library.'),
          since: z.string().optional().describe('Only advice last given on or after this date or timestamp, in the IBM i system\'s local time with no time zone. Example: "2026-01-31" or "2026-01-31 08:00:00"'),
          limit: z.number().int().positive().optional().describe('Maximum rows to return. Capped by QUERY_MAX_LIMIT.'),
        }),
        outputSchema: indexAdviceOutputSchema,
      },
      withToolHandler(
        (args, target) => indexAdviceTool({
          schema: args.schema,
          table: args.table,
          since: args.since,
          limit: args.limit,
          target,
          defaultSchema: target.defaultSchema,
        }),
        'Failed to read index advice',
        sessionContext,
        argsAudit('index_advice'),
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
          ...system,
          schema: z.string().optional().describe(`Schema (library) that contains the table. ${SCHEMA_DEFAULT_HINT}`),
          table: z.string().describe('Table name'),
          compute: z.boolean().optional().describe('Scan the table for exact counts, MIN, and MAX. Slower on large tables. Default false.'),
          columns: z.array(z.string()).optional().describe(`Columns to profile. Defaults to every column (the first ${MAX_COMPUTED_COLUMNS} when compute is true).`),
        }),
        outputSchema: profileTableOutputSchema,
      },
      withToolHandler(
        (args, target) => profileTableTool({
          schema: args.schema,
          table: args.table,
          compute: args.compute,
          columns: args.columns,
          target,
          defaultSchema: target.defaultSchema,
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
    if (!enabledTools.has(tool.name) || !customToolReachable(tool, sessionContext)) {
      continue;
    }
    customRegistrations.set(tool.name, registerCustomTool(server, tool, sessionContext));
  }
  rememberLiveCustomTools({
    server,
    tools: customRegistrations,
    sessionContext,
    listsAnnotatedTables: enabledTools.has('describe_table'),
  });

  registerResources(server, enabledTools, sessionContext);
  registerPrompts(server, enabledTools, sessionContext);

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
  /** resources/list offers the annotated tables, so a reload changes it. */
  listsAnnotatedTables: boolean;
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
    if (live.listsAnnotatedTables) {
      server.sendResourceListChanged();
    }
  }
}

function syncOneServer(
  live: LiveCustomTools,
  loaded: LoadedCustomTools,
  enabled: ReadonlySet<string>,
): void {
  const next = new Map(
    loaded.tools
      .filter((tool) => enabled.has(tool.name) && customToolReachable(tool, live.sessionContext))
      .map((tool) => [tool.name, tool])
  );

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
      live.tools.set(name, registerCustomTool(live.server, tool, live.sessionContext));
      continue;
    }
    if (current.signature === signature) {
      continue;
    }
    current.registered.update({
      title: tool.title,
      description: tool.description,
      paramsSchema: customToolInputSchema(tool, live.sessionContext),
      callback: customToolCallback(tool, live.sessionContext),
    });
    current.signature = signature;
  }
}

/**
 * A tool fixed to a system is left out of a session bound to another one.
 */
function customToolReachable(tool: StoredTool, sessionContext: SessionContext | undefined): boolean {
  return !tool.system || reachableSystems(sessionContext).includes(tool.system);
}

/**
 * The tool's parameters, plus `system` when it is not fixed to one, the caller
 * can reach several, and no parameter already uses that name.
 */
function customToolInputSchema(tool: StoredTool, sessionContext: SessionContext | undefined) {
  const params = inputSchemaFor(tool.parameters);
  if (tool.system || 'system' in tool.parameters) {
    return params;
  }
  return params.extend(systemShape(sessionContext));
}

function registerCustomTool(
  server: McpServer,
  tool: StoredTool,
  sessionContext: SessionContext | undefined,
): LiveCustomTool {
  const registered = server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: customToolInputSchema(tool, sessionContext),
      outputSchema: queryOutputSchema,
    },
    customToolCallback(tool, sessionContext),
  );
  return { registered, signature: toolSignature(tool) };
}

function customToolCallback(
  tool: StoredTool,
  sessionContext: SessionContext | undefined,
) {
  return withToolHandler(
    (args: unknown, target) => executeCustomTool(tool, withoutSystemArg(tool, args), {
      target,
      defaultSchema: target.defaultSchema,
    }),
    'Query failed',
    sessionContext,
    {
      tool: tool.name,
      audit: (args) => {
        const bound = bindCustomToolArgs(tool, withoutSystemArg(tool, args));
        return { sql: tool.sql, params: bound.ok ? bound.params : [] };
      },
    },
    (args) => customToolSystem(tool, args),
  );
}

/**
 * The system a custom tool runs on: its pinned system, or the caller's
 * `system` argument unless that name is one of the tool's SQL parameters.
 */
function customToolSystem(tool: StoredTool, args: unknown): string | undefined {
  if (tool.system) {
    return tool.system;
  }
  return 'system' in tool.parameters ? undefined : systemArgOf(args);
}

/** Tool arguments without the `system` argument, which is not a SQL parameter. */
function withoutSystemArg(tool: StoredTool, args: unknown): Record<string, unknown> {
  const record = args as Record<string, unknown>;
  if ('system' in tool.parameters || !('system' in record)) {
    return record;
  }
  const { system: _system, ...rest } = record;
  return rest;
}

function toolSignature(tool: StoredTool): string {
  return JSON.stringify({
    title: tool.title,
    description: tool.description,
    parameters: tool.parameters,
    sql: tool.sql,
    maxRows: tool.maxRows ?? null,
    system: tool.system ?? null,
  });
}
