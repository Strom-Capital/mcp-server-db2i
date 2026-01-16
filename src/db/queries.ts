/**
 * Query helpers for IBM DB2i metadata and data access
 */

import { executeQuery } from './connection.js';

/**
 * Convert a filter pattern to SQL LIKE pattern
 * Supports:
 * - "term" -> "%term%" (contains)
 * - "term*" -> "term%" (starts with)
 * - "*term" -> "%term" (ends with)
 * - "term*suffix" -> "term%suffix" (pattern)
 */
export function filterToLikePattern(filter: string | undefined): string {
  if (!filter) {
    return '%';
  }

  // If filter already contains %, use as-is
  if (filter.includes('%')) {
    return filter.toUpperCase();
  }

  // Convert * to % for user-friendly wildcards
  if (filter.includes('*')) {
    return filter.replace(/\*/g, '%').toUpperCase();
  }

  // Default: contains search
  return `%${filter.toUpperCase()}%`;
}

/**
 * Validate that a query is read-only (SELECT only)
 */
export function isReadOnlyQuery(sql: string): boolean {
  const trimmed = sql.trim().toUpperCase();
  
  // Must start with SELECT or WITH (for CTEs)
  if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('WITH')) {
    return false;
  }

  // Check for dangerous keywords that indicate modification
  const dangerousKeywords = [
    'INSERT',
    'UPDATE',
    'DELETE',
    'DROP',
    'CREATE',
    'ALTER',
    'TRUNCATE',
    'GRANT',
    'REVOKE',
    'CALL',
    'EXECUTE',
  ];

  for (const keyword of dangerousKeywords) {
    // Check if keyword appears as a statement (not inside a string or comment)
    const regex = new RegExp(`\\b${keyword}\\b`, 'i');
    if (regex.test(trimmed)) {
      return false;
    }
  }

  return true;
}

/**
 * List all schemas/libraries
 */
export async function listSchemas(filter?: string): Promise<Array<{ schema_name: string; schema_text: string | null }>> {
  const pattern = filterToLikePattern(filter);
  
  const sql = `
    SELECT 
      SCHEMA_NAME,
      SCHEMA_TEXT
    FROM QSYS2.SYSSCHEMAS
    WHERE SCHEMA_NAME LIKE ?
    ORDER BY SCHEMA_NAME
  `;

  const result = await executeQuery(sql, [pattern]);
  
  return result.rows.map(row => ({
    schema_name: String(row.SCHEMA_NAME || '').trim(),
    schema_text: row.SCHEMA_TEXT ? String(row.SCHEMA_TEXT).trim() : null,
  }));
}

/**
 * List tables in a schema
 */
export async function listTables(
  schema: string,
  filter?: string
): Promise<Array<{ table_name: string; table_type: string; table_text: string | null }>> {
  const pattern = filterToLikePattern(filter);
  
  const sql = `
    SELECT 
      TABLE_NAME,
      TABLE_TYPE,
      TABLE_TEXT
    FROM QSYS2.SYSTABLES
    WHERE TABLE_SCHEMA = ?
      AND TABLE_NAME LIKE ?
    ORDER BY TABLE_NAME
  `;

  const result = await executeQuery(sql, [schema.toUpperCase(), pattern]);
  
  return result.rows.map(row => ({
    table_name: String(row.TABLE_NAME || '').trim(),
    table_type: String(row.TABLE_TYPE || '').trim(),
    table_text: row.TABLE_TEXT ? String(row.TABLE_TEXT).trim() : null,
  }));
}

/**
 * Describe a table's columns
 */
export async function describeTable(
  schema: string,
  table: string
): Promise<Array<{
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
  const sql = `
    SELECT 
      COLUMN_NAME,
      ORDINAL_POSITION,
      DATA_TYPE,
      LENGTH,
      NUMERIC_SCALE,
      IS_NULLABLE,
      COLUMN_DEFAULT,
      COLUMN_TEXT,
      SYSTEM_COLUMN_NAME,
      CCSID
    FROM QSYS2.SYSCOLUMNS
    WHERE TABLE_SCHEMA = ?
      AND TABLE_NAME = ?
    ORDER BY ORDINAL_POSITION
  `;

  const result = await executeQuery(sql, [schema.toUpperCase(), table.toUpperCase()]);
  
  return result.rows.map(row => ({
    column_name: String(row.COLUMN_NAME || '').trim(),
    ordinal_position: Number(row.ORDINAL_POSITION),
    data_type: String(row.DATA_TYPE || '').trim(),
    length: row.LENGTH != null ? Number(row.LENGTH) : null,
    numeric_scale: row.NUMERIC_SCALE != null ? Number(row.NUMERIC_SCALE) : null,
    is_nullable: String(row.IS_NULLABLE || '').trim(),
    column_default: row.COLUMN_DEFAULT ? String(row.COLUMN_DEFAULT).trim() : null,
    column_text: row.COLUMN_TEXT ? String(row.COLUMN_TEXT).trim() : null,
    system_column_name: String(row.SYSTEM_COLUMN_NAME || '').trim(),
    ccsid: row.CCSID != null ? Number(row.CCSID) : null,
  }));
}

/**
 * List views in a schema
 */
export async function listViews(
  schema: string,
  filter?: string
): Promise<Array<{ view_name: string; view_text: string | null }>> {
  const pattern = filterToLikePattern(filter);
  
  const sql = `
    SELECT 
      TABLE_NAME AS VIEW_NAME,
      TABLE_TEXT AS VIEW_TEXT
    FROM QSYS2.SYSTABLES
    WHERE TABLE_SCHEMA = ?
      AND TABLE_TYPE = 'V'
      AND TABLE_NAME LIKE ?
    ORDER BY TABLE_NAME
  `;

  const result = await executeQuery(sql, [schema.toUpperCase(), pattern]);
  
  return result.rows.map(row => ({
    view_name: String(row.VIEW_NAME || '').trim(),
    view_text: row.VIEW_TEXT ? String(row.VIEW_TEXT).trim() : null,
  }));
}

/**
 * List indexes for a table
 */
export async function listIndexes(
  schema: string,
  table: string
): Promise<Array<{
  index_name: string;
  index_schema: string;
  is_unique: string;
  column_names: string;
}>> {
  const sql = `
    SELECT 
      INDEX_NAME,
      INDEX_SCHEMA,
      IS_UNIQUE,
      COLUMN_NAMES
    FROM QSYS2.SYSINDEXES
    WHERE TABLE_SCHEMA = ?
      AND TABLE_NAME = ?
    ORDER BY INDEX_NAME
  `;

  const result = await executeQuery(sql, [schema.toUpperCase(), table.toUpperCase()]);
  
  return result.rows.map(row => ({
    index_name: String(row.INDEX_NAME || '').trim(),
    index_schema: String(row.INDEX_SCHEMA || '').trim(),
    is_unique: String(row.IS_UNIQUE || '').trim(),
    column_names: String(row.COLUMN_NAMES || '').trim(),
  }));
}

/**
 * Get table constraints (primary keys, foreign keys, unique constraints)
 */
export async function getTableConstraints(
  schema: string,
  table: string
): Promise<Array<{
  constraint_name: string;
  constraint_type: string;
  column_name: string;
  ordinal_position: number;
  referenced_table_schema: string | null;
  referenced_table_name: string | null;
  referenced_column_name: string | null;
}>> {
  const sql = `
    SELECT 
      CST.CONSTRAINT_NAME,
      CST.CONSTRAINT_TYPE,
      KC.COLUMN_NAME,
      KC.ORDINAL_POSITION,
      RC.UNIQUE_CONSTRAINT_SCHEMA AS REFERENCED_TABLE_SCHEMA,
      FK.TABLE_NAME AS REFERENCED_TABLE_NAME,
      FK.COLUMN_NAME AS REFERENCED_COLUMN_NAME
    FROM QSYS2.SYSCST CST
    LEFT JOIN QSYS2.SYSKEYCST KC 
      ON CST.CONSTRAINT_SCHEMA = KC.CONSTRAINT_SCHEMA 
      AND CST.CONSTRAINT_NAME = KC.CONSTRAINT_NAME
    LEFT JOIN QSYS2.SYSREFCST RC 
      ON CST.CONSTRAINT_SCHEMA = RC.CONSTRAINT_SCHEMA 
      AND CST.CONSTRAINT_NAME = RC.CONSTRAINT_NAME
    LEFT JOIN QSYS2.SYSKEYCST FK 
      ON RC.UNIQUE_CONSTRAINT_SCHEMA = FK.CONSTRAINT_SCHEMA 
      AND RC.UNIQUE_CONSTRAINT_NAME = FK.CONSTRAINT_NAME
      AND KC.ORDINAL_POSITION = FK.ORDINAL_POSITION
    WHERE CST.TABLE_SCHEMA = ?
      AND CST.TABLE_NAME = ?
    ORDER BY CST.CONSTRAINT_NAME, KC.ORDINAL_POSITION
  `;

  const result = await executeQuery(sql, [schema.toUpperCase(), table.toUpperCase()]);
  
  return result.rows.map(row => ({
    constraint_name: String(row.CONSTRAINT_NAME || '').trim(),
    constraint_type: String(row.CONSTRAINT_TYPE || '').trim(),
    column_name: String(row.COLUMN_NAME || '').trim(),
    ordinal_position: Number(row.ORDINAL_POSITION || 0),
    referenced_table_schema: row.REFERENCED_TABLE_SCHEMA ? String(row.REFERENCED_TABLE_SCHEMA).trim() : null,
    referenced_table_name: row.REFERENCED_TABLE_NAME ? String(row.REFERENCED_TABLE_NAME).trim() : null,
    referenced_column_name: row.REFERENCED_COLUMN_NAME ? String(row.REFERENCED_COLUMN_NAME).trim() : null,
  }));
}
