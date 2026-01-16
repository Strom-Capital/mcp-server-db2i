/**
 * Metadata inspection tools for IBM DB2i MCP Server
 */

import { z } from 'zod';
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

export const listSchemasInputSchema = {
  filter: z.string().optional().describe('Filter pattern for schema names. Use * as wildcard. Example: "QSYS*" matches schemas starting with QSYS'),
};

export async function listSchemasTool(input: { filter?: string }): Promise<{
  success: boolean;
  data?: Array<{ schema_name: string; schema_text: string | null }>;
  count?: number;
  error?: string;
}> {
  try {
    const schemas = await listSchemas(input.filter);
    return {
      success: true,
      data: schemas,
      count: schemas.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    return {
      success: false,
      error: message,
    };
  }
}

export const listSchemasToolDefinition = {
  name: 'list_schemas',
  description: 'List all schemas (libraries) in the IBM DB2i database. Optionally filter by name pattern using * as wildcard.',
  inputSchema: listSchemasInputSchema,
  handler: listSchemasTool,
};

// ============================================================================
// List Tables Tool
// ============================================================================

export const listTablesInputSchema = {
  schema: z.string().optional().describe('Schema (library) name to list tables from. Uses DB2I_SCHEMA env var if not provided.'),
  filter: z.string().optional().describe('Filter pattern for table names. Use * as wildcard. Example: "CUST*" matches tables starting with CUST'),
};

export async function listTablesTool(input: { schema?: string; filter?: string }): Promise<{
  success: boolean;
  data?: Array<{ table_name: string; table_type: string; table_text: string | null }>;
  count?: number;
  error?: string;
}> {
  try {
    const schema = resolveSchema(input.schema);
    const tables = await listTables(schema, input.filter);
    return {
      success: true,
      data: tables,
      count: tables.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    return {
      success: false,
      error: message,
    };
  }
}

export const listTablesToolDefinition = {
  name: 'list_tables',
  description: 'List all tables in a specific schema (library). Optionally filter by name pattern using * as wildcard.',
  inputSchema: listTablesInputSchema,
  handler: listTablesTool,
};

// ============================================================================
// Describe Table Tool
// ============================================================================

export const describeTableInputSchema = {
  schema: z.string().optional().describe('Schema (library) name containing the table. Uses DB2I_SCHEMA env var if not provided.'),
  table: z.string().describe('Table name to describe'),
};

export async function describeTableTool(input: { schema?: string; table: string }): Promise<{
  success: boolean;
  data?: Array<{
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
  }>;
  count?: number;
  error?: string;
}> {
  try {
    const schema = resolveSchema(input.schema);
    const columns = await describeTable(schema, input.table);
    return {
      success: true,
      data: columns,
      count: columns.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    return {
      success: false,
      error: message,
    };
  }
}

export const describeTableToolDefinition = {
  name: 'describe_table',
  description: 'Get detailed column information for a specific table including data types, lengths, nullability, defaults, and CCSID.',
  inputSchema: describeTableInputSchema,
  handler: describeTableTool,
};

// ============================================================================
// List Views Tool
// ============================================================================

export const listViewsInputSchema = {
  schema: z.string().optional().describe('Schema (library) name to list views from. Uses DB2I_SCHEMA env var if not provided.'),
  filter: z.string().optional().describe('Filter pattern for view names. Use * as wildcard.'),
};

export async function listViewsTool(input: { schema?: string; filter?: string }): Promise<{
  success: boolean;
  data?: Array<{ view_name: string; view_text: string | null }>;
  count?: number;
  error?: string;
}> {
  try {
    const schema = resolveSchema(input.schema);
    const views = await listViews(schema, input.filter);
    return {
      success: true,
      data: views,
      count: views.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    return {
      success: false,
      error: message,
    };
  }
}

export const listViewsToolDefinition = {
  name: 'list_views',
  description: 'List all views in a specific schema (library). Optionally filter by name pattern using * as wildcard.',
  inputSchema: listViewsInputSchema,
  handler: listViewsTool,
};

// ============================================================================
// List Indexes Tool
// ============================================================================

export const listIndexesInputSchema = {
  schema: z.string().optional().describe('Schema (library) name containing the table. Uses DB2I_SCHEMA env var if not provided.'),
  table: z.string().describe('Table name to list indexes for'),
};

export async function listIndexesTool(input: { schema?: string; table: string }): Promise<{
  success: boolean;
  data?: Array<{
    index_name: string;
    index_schema: string;
    is_unique: string;
    column_names: string;
  }>;
  count?: number;
  error?: string;
}> {
  try {
    const schema = resolveSchema(input.schema);
    const indexes = await listIndexes(schema, input.table);
    return {
      success: true,
      data: indexes,
      count: indexes.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    return {
      success: false,
      error: message,
    };
  }
}

export const listIndexesToolDefinition = {
  name: 'list_indexes',
  description: 'List all indexes for a specific table including uniqueness and column information.',
  inputSchema: listIndexesInputSchema,
  handler: listIndexesTool,
};

// ============================================================================
// Get Table Constraints Tool
// ============================================================================

export const getTableConstraintsInputSchema = {
  schema: z.string().optional().describe('Schema (library) name containing the table. Uses DB2I_SCHEMA env var if not provided.'),
  table: z.string().describe('Table name to get constraints for'),
};

export async function getTableConstraintsTool(input: { schema?: string; table: string }): Promise<{
  success: boolean;
  data?: Array<{
    constraint_name: string;
    constraint_type: string;
    column_name: string;
    ordinal_position: number;
    referenced_table_schema: string | null;
    referenced_table_name: string | null;
    referenced_column_name: string | null;
  }>;
  count?: number;
  error?: string;
}> {
  try {
    const schema = resolveSchema(input.schema);
    const constraints = await getTableConstraints(schema, input.table);
    return {
      success: true,
      data: constraints,
      count: constraints.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    return {
      success: false,
      error: message,
    };
  }
}

export const getTableConstraintsToolDefinition = {
  name: 'get_table_constraints',
  description: 'Get all constraints (primary keys, foreign keys, unique constraints) for a specific table.',
  inputSchema: getTableConstraintsInputSchema,
  handler: getTableConstraintsTool,
};

// ============================================================================
// Export all tool definitions
// ============================================================================

export const metadataToolDefinitions = [
  listSchemasToolDefinition,
  listTablesToolDefinition,
  describeTableToolDefinition,
  listViewsToolDefinition,
  listIndexesToolDefinition,
  getTableConstraintsToolDefinition,
];
