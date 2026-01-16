/**
 * Metadata inspection tools for IBM DB2i MCP Server
 */

import {
  listSchemas,
  listTables,
  describeTable,
  listViews,
  listIndexes,
  getTableConstraints,
} from '../db/queries.js';
import { loadConfig, getDefaultSchema } from '../config.js';

/**
 * Standard success/error result type for metadata tools
 */
type ToolResult<T> =
  | { success: true; data: T[]; count: number }
  | { success: false; error: string };

/**
 * Wraps an async function with standard error handling
 */
async function withErrorHandling<T>(
  fn: () => Promise<T[]>
): Promise<ToolResult<T>> {
  try {
    const data = await fn();
    return { success: true, data, count: data.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    return { success: false, error: message };
  }
}

/**
 * Get schema to use - either from input or from default config
 */
function resolveSchema(inputSchema?: string): string {
  if (inputSchema) {
    return inputSchema;
  }
  const config = loadConfig();
  const defaultSchema = getDefaultSchema(config);
  if (!defaultSchema) {
    throw new Error('Schema is required. Either provide it as a parameter or set DB2I_SCHEMA environment variable.');
  }
  return defaultSchema;
}

// ============================================================================
// List Schemas Tool
// ============================================================================

export function listSchemasTool(input: { filter?: string }): Promise<ToolResult<{
  schema_name: string;
  schema_text: string | null;
}>> {
  return withErrorHandling(() => listSchemas(input.filter));
}

// ============================================================================
// List Tables Tool
// ============================================================================

export function listTablesTool(input: { schema?: string; filter?: string }): Promise<ToolResult<{
  table_name: string;
  table_type: string;
  table_text: string | null;
}>> {
  return withErrorHandling(() => {
    const schema = resolveSchema(input.schema);
    return listTables(schema, input.filter);
  });
}

// ============================================================================
// Describe Table Tool
// ============================================================================

export function describeTableTool(input: { schema?: string; table: string }): Promise<ToolResult<{
  column_name: string;
  ordinal_position: number;
  data_type: string;
  length: number | null;
  numeric_scale: number | null;
  is_nullable: string;
  column_default: string | null;
  column_text: string | null;
  system_column_name: string;
  ccsid: number | null;
}>> {
  return withErrorHandling(() => {
    const schema = resolveSchema(input.schema);
    return describeTable(schema, input.table);
  });
}

// ============================================================================
// List Views Tool
// ============================================================================

export function listViewsTool(input: { schema?: string; filter?: string }): Promise<ToolResult<{
  view_name: string;
  view_text: string | null;
}>> {
  return withErrorHandling(() => {
    const schema = resolveSchema(input.schema);
    return listViews(schema, input.filter);
  });
}

// ============================================================================
// List Indexes Tool
// ============================================================================

export function listIndexesTool(input: { schema?: string; table: string }): Promise<ToolResult<{
  index_name: string;
  index_schema: string;
  is_unique: string;
  column_names: string;
}>> {
  return withErrorHandling(() => {
    const schema = resolveSchema(input.schema);
    return listIndexes(schema, input.table);
  });
}

// ============================================================================
// Get Table Constraints Tool
// ============================================================================

export function getTableConstraintsTool(input: { schema?: string; table: string }): Promise<ToolResult<{
  constraint_name: string;
  constraint_type: string;
  column_name: string;
  ordinal_position: number;
  referenced_table_schema: string | null;
  referenced_table_name: string | null;
  referenced_column_name: string | null;
}>> {
  return withErrorHandling(() => {
    const schema = resolveSchema(input.schema);
    return getTableConstraints(schema, input.table);
  });
}
