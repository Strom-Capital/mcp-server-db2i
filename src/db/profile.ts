/**
 * Catalog statistics and computed aggregates for profile_table.
 *
 * Table numbers come from QSYS2.SYSTABLESTAT. Stored column numbers come from
 * single-column rows in QSYS2.SYSCOLUMNSTAT, which exist only when the
 * statistics manager has collected them. Computed numbers scan the table.
 */

import { executeQuery } from './connection.js';
import type { DbTarget } from '../systems.js';

/** Most columns one computed profile scans. */
export const MAX_COMPUTED_COLUMNS = 20;

/** Types that DISTINCT, MIN, and MAX reject. They get a null count only. */
const COUNT_ONLY_TYPES = new Set(['BLOB', 'CLOB', 'DBCLOB', 'XML', 'DATALINK', 'ROWID']);

export interface TableStats {
  number_rows: number | null;
  number_deleted_rows: number | null;
  data_size: number | null;
  last_change: string | null;
  last_used: string | null;
}

export interface CatalogColumn {
  column_name: string;
  data_type: string;
}

export interface ColumnStats {
  distinct_values: number | null;
  null_count: number | null;
  low: string | null;
  high: string | null;
  statistics_updated?: string | null;
}

export interface ComputedProfile {
  sql: string;
  rowCount: number | null;
  columns: Map<string, ColumnStats>;
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function textOrNull(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function isCountOnlyType(dataType: string): boolean {
  return COUNT_ONLY_TYPES.has(dataType.trim().toUpperCase());
}

export async function readColumns(schema: string, table: string, target?: DbTarget): Promise<CatalogColumn[]> {
  const result = await executeQuery(
    `SELECT COLUMN_NAME, DATA_TYPE FROM QSYS2.SYSCOLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [schema, table],
    target
  );
  return result.rows.map((row) => ({
    column_name: String(row.COLUMN_NAME ?? '').trim(),
    data_type: String(row.DATA_TYPE ?? '').trim(),
  }));
}

export async function readTableStats(schema: string, table: string, target?: DbTarget): Promise<TableStats | null> {
  const result = await executeQuery(
    `SELECT NUMBER_ROWS, NUMBER_DELETED_ROWS, DATA_SIZE, LAST_CHANGE_TIMESTAMP, LAST_USED_TIMESTAMP
     FROM QSYS2.SYSTABLESTAT
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [schema, table],
    target
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    number_rows: numberOrNull(row.NUMBER_ROWS),
    number_deleted_rows: numberOrNull(row.NUMBER_DELETED_ROWS),
    data_size: numberOrNull(row.DATA_SIZE),
    last_change: textOrNull(row.LAST_CHANGE_TIMESTAMP),
    last_used: textOrNull(row.LAST_USED_TIMESTAMP),
  };
}

/**
 * Single-column statistics keyed by column name. A column with more than one
 * statistic keeps the most recently updated one.
 */
export async function readStoredColumnStats(
  schema: string,
  table: string,
  target?: DbTarget
): Promise<Map<string, ColumnStats>> {
  const result = await executeQuery(
    `SELECT COLUMN_NAME, NUMBER_DISTINCT_VALUES, NUMBER_NULLS, LOW2KEY, HIGH2KEY, STATISTIC_LAST_UPDATED
     FROM QSYS2.SYSCOLUMNSTAT
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND NUMBER_COLUMN_NAMES = 1
     ORDER BY STATISTIC_LAST_UPDATED DESC`,
    [schema, table],
    target
  );

  const stats = new Map<string, ColumnStats>();
  for (const row of result.rows) {
    const column = String(row.COLUMN_NAME ?? '').trim().toUpperCase();
    if (!column || stats.has(column)) {
      continue;
    }
    stats.set(column, {
      distinct_values: numberOrNull(row.NUMBER_DISTINCT_VALUES),
      null_count: numberOrNull(row.NUMBER_NULLS),
      low: textOrNull(row.LOW2KEY),
      high: textOrNull(row.HIGH2KEY),
      statistics_updated: textOrNull(row.STATISTIC_LAST_UPDATED),
    });
  }
  return stats;
}

/**
 * One aggregate SELECT over the table. Every name is a quoted catalog name.
 * Columns in `hideValues` get no MIN or MAX, so masked values never leave the database.
 */
export function buildProfileSql(
  schema: string,
  table: string,
  columns: readonly CatalogColumn[],
  hideValues: ReadonlySet<string>
): string {
  const items = ['COUNT(*) AS PROFILE_ROWS'];
  columns.forEach((column, index) => {
    const name = quoteIdentifier(column.column_name);
    items.push(`COUNT(*) - COUNT(${name}) AS C${index}_NULLS`);
    if (isCountOnlyType(column.data_type)) {
      return;
    }
    items.push(`COUNT(DISTINCT ${name}) AS C${index}_DISTINCT`);
    if (!hideValues.has(column.column_name.toUpperCase())) {
      items.push(`MIN(${name}) AS C${index}_MIN`, `MAX(${name}) AS C${index}_MAX`);
    }
  });
  return `SELECT ${items.join(', ')} FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

export async function computeColumnStats(
  schema: string,
  table: string,
  columns: readonly CatalogColumn[],
  hideValues: ReadonlySet<string>,
  target?: DbTarget
): Promise<ComputedProfile> {
  const sql = buildProfileSql(schema, table, columns, hideValues);
  const result = await executeQuery(sql, [], target);
  const row = result.rows[0] ?? {};

  const stats = new Map<string, ColumnStats>();
  columns.forEach((column, index) => {
    stats.set(column.column_name.toUpperCase(), {
      distinct_values: numberOrNull(row[`C${index}_DISTINCT`]),
      null_count: numberOrNull(row[`C${index}_NULLS`]),
      low: textOrNull(row[`C${index}_MIN`]),
      high: textOrNull(row[`C${index}_MAX`]),
    });
  });

  return { sql, rowCount: numberOrNull(row.PROFILE_ROWS), columns: stats };
}
