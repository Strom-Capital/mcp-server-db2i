/**
 * Metadata inspection tools for IBM DB2i MCP Server
 * 
 * All tools support optional sessionId for HTTP transport.
 * When sessionId is provided, uses session-specific connection pool.
 * When omitted, uses global connection pool (stdio mode).
 */

import {
  listSchemas,
  listTables,
  describeTable,
  listViews,
  listIndexes,
  getTableConstraints,
  searchColumns,
  searchTables,
  type CatalogSearchScope,
  type SearchColumnRow,
  type SearchTableRow,
} from '../db/queries.js';
import { applyQueryLimit, getAllowedSchemas, getDefaultSchema, loadConfig } from '../config.js';
import { annotationFor } from '../customTools/context.js';
import type { StoredRelation } from '../customTools/loader.js';
import { isSchemaAllowed } from '../utils/security/schemaAllowlist.js';

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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error occurred';
}

// ============================================================================
// List Schemas Tool
// ============================================================================

export function listSchemasTool(input: { filter?: string; sessionId?: string }): Promise<ToolResult<{
  schema_name: string;
  schema_text: string | null;
}>> {
  return withErrorHandling(() => listSchemas(input.filter, input.sessionId));
}

// ============================================================================
// List Tables Tool
// ============================================================================

export async function listTablesTool(input: { schema?: string; filter?: string; sessionId?: string }): Promise<ToolResult<{
  table_name: string;
  table_type: string;
  table_text: string | null;
  business_description?: string;
}>> {
  try {
    const schema = resolveSchema(input.schema);
    const result = await withErrorHandling(() => listTables(schema, input.filter, input.sessionId));
    if (!result.success) {
      return result;
    }
    return {
      ...result,
      data: result.data.map((row) => {
        const description = annotationFor(schema, row.table_name)?.description;
        return description ? { ...row, business_description: description } : row;
      }),
    };
  } catch (error) {
    return { success: false, error: messageOf(error) };
  }
}

// ============================================================================
// Describe Table Tool
// ============================================================================

export async function describeTableTool(input: { schema?: string; table: string; sessionId?: string }): Promise<
  | {
      success: true;
      data: Array<{
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
        business_description?: string;
      }>;
      count: number;
      business_description?: string;
      relations?: StoredRelation[];
    }
  | { success: false; error: string }
> {
  try {
    const schema = resolveSchema(input.schema);
    const result = await withErrorHandling(() => describeTable(schema, input.table, input.sessionId));
    if (!result.success) {
      return result;
    }

    const annotation = annotationFor(schema, input.table);
    const data = result.data.map((column) => {
      const description = annotation?.columns[column.column_name.toUpperCase()];
      return description ? { ...column, business_description: description } : column;
    });

    return {
      success: true,
      data,
      count: data.length,
      ...(annotation?.description ? { business_description: annotation.description } : {}),
      ...(annotation && annotation.relations.length > 0 ? { relations: annotation.relations } : {}),
    };
  } catch (error) {
    return { success: false, error: messageOf(error) };
  }
}

// ============================================================================
// List Views Tool
// ============================================================================

export function listViewsTool(input: { schema?: string; filter?: string; sessionId?: string }): Promise<ToolResult<{
  view_name: string;
  view_text: string | null;
}>> {
  return withErrorHandling(() => {
    const schema = resolveSchema(input.schema);
    return listViews(schema, input.filter, input.sessionId);
  });
}

// ============================================================================
// List Indexes Tool
// ============================================================================

export function listIndexesTool(input: { schema?: string; table: string; sessionId?: string }): Promise<ToolResult<{
  index_name: string;
  index_schema: string;
  is_unique: string;
  column_names: string;
}>> {
  return withErrorHandling(() => {
    const schema = resolveSchema(input.schema);
    return listIndexes(schema, input.table, input.sessionId);
  });
}

// ============================================================================
// Get Table Constraints Tool
// ============================================================================

export function getTableConstraintsTool(input: { schema?: string; table: string; sessionId?: string }): Promise<ToolResult<{
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
    return getTableConstraints(schema, input.table, input.sessionId);
  });
}

// ============================================================================
// Catalog search
// ============================================================================

export interface CatalogSearchInput {
  filter: string;
  schema?: string;
  includeSystem?: boolean;
  limit?: number;
  sessionId?: string;
}

type SearchResult<T> =
  | { success: true; data: T[]; count: number; truncated: boolean }
  | { success: false; error: string };

function schemaDenied(schema: string, allowed: string[]): string {
  return `Schema ${schema.trim().toUpperCase()} is not in QUERY_ALLOWED_SCHEMAS (${allowed.join(', ')}).`;
}

/**
 * A filter of only * and % would match the whole catalog.
 */
function isWildcardOnly(filter: string): boolean {
  return filter.replace(/[*%\s]/g, '').length === 0;
}

function resolveSearchScope(input: CatalogSearchInput): CatalogSearchScope | { error: string } {
  if (isWildcardOnly(input.filter)) {
    return { error: 'Filter must contain a name or text to match. A pattern of only * or % is not allowed.' };
  }

  const allowed = getAllowedSchemas();
  const requested = input.schema?.trim().toUpperCase();

  if (allowed) {
    if (requested && !isSchemaAllowed(requested, allowed)) {
      return { error: schemaDenied(requested, allowed) };
    }
    return {
      schemas: requested ? [requested] : allowed.map((name) => name.toUpperCase()),
      excludeSystem: false,
      limit: applyQueryLimit(input.limit),
    };
  }

  if (requested) {
    return {
      schemas: [requested],
      excludeSystem: false,
      limit: applyQueryLimit(input.limit),
    };
  }

  return {
    excludeSystem: input.includeSystem !== true,
    limit: applyQueryLimit(input.limit),
  };
}

function withColumnNotes(rows: SearchColumnRow[]): Array<SearchColumnRow & { business_description?: string }> {
  return rows.map((row) => {
    const description = annotationFor(row.schema_name, row.table_name)?.columns[row.column_name.toUpperCase()];
    return description ? { ...row, business_description: description } : row;
  });
}

function withTableNotes(rows: SearchTableRow[]): Array<SearchTableRow & { business_description?: string }> {
  return rows.map((row) => {
    const description = annotationFor(row.schema_name, row.table_name)?.description;
    return description ? { ...row, business_description: description } : row;
  });
}

export async function searchColumnsTool(input: CatalogSearchInput): Promise<SearchResult<SearchColumnRow & { business_description?: string }>> {
  const scope = resolveSearchScope(input);
  if ('error' in scope) {
    return { success: false, error: scope.error };
  }

  try {
    const result = await searchColumns(input.filter, scope, input.sessionId);
    const data = withColumnNotes(result.rows);
    return { success: true, data, count: data.length, truncated: result.truncated };
  } catch (error) {
    return { success: false, error: messageOf(error) };
  }
}

export async function searchTablesTool(input: CatalogSearchInput): Promise<SearchResult<SearchTableRow & { business_description?: string }>> {
  const scope = resolveSearchScope(input);
  if ('error' in scope) {
    return { success: false, error: scope.error };
  }

  try {
    const result = await searchTables(input.filter, scope, input.sessionId);
    const data = withTableNotes(result.rows);
    return { success: true, data, count: data.length, truncated: result.truncated };
  } catch (error) {
    return { success: false, error: messageOf(error) };
  }
}
