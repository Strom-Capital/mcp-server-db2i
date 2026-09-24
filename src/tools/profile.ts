/**
 * profile_table: row counts, last change, and per-column distinct and null
 * counts with low and high values. Stored statistics by default, a table scan
 * when compute is set. Masked columns keep their counts and lose their values.
 */

import { getAllowedSchemas } from '../config.js';
import { getCustomTools } from '../customTools/registry.js';
import type { MaskRule } from '../customTools/masking.js';
import {
  computeColumnStats,
  MAX_COMPUTED_COLUMNS,
  readColumns,
  readStoredColumnStats,
  readTableStats,
  type CatalogColumn,
  type ColumnStats,
  type TableStats,
} from '../db/profile.js';
import { isSchemaAllowed } from '../utils/security/schemaAllowlist.js';
import { requireSchema, schemaDenied } from './sqlServices.js';

export type ColumnProfile = {
  column_name: string;
  data_type: string;
  source: 'stored' | 'computed' | 'none';
  distinct_values: number | null;
  null_count: number | null;
  low: string | null;
  high: string | null;
  statistics_updated?: string | null;
  masked?: MaskRule;
};

export type ProfileTableResult = {
  success: boolean;
  error?: string;
  schema?: string;
  table?: string;
  mode?: 'stored' | 'computed';
  table_stats?: TableStats | null;
  computed_rows?: number | null;
  data?: ColumnProfile[];
  count?: number;
  truncated?: boolean;
  /** The aggregate statement compute mode ran. */
  sql?: string;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error occurred';
}

function selectColumns(
  catalog: CatalogColumn[],
  requested: string[] | undefined
): { ok: true; columns: CatalogColumn[] } | { ok: false; error: string } {
  if (!requested || requested.length === 0) {
    return { ok: true, columns: catalog };
  }
  const byName = new Map(catalog.map((column) => [column.column_name.toUpperCase(), column]));
  const wanted = [...new Set(requested.map((name) => name.trim().toUpperCase()))];
  const unknown = wanted.filter((name) => !byName.has(name));
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown column(s): ${unknown.join(', ')}.` };
  }
  return { ok: true, columns: wanted.map((name) => byName.get(name) as CatalogColumn) };
}

function profileOf(
  column: CatalogColumn,
  stats: ColumnStats | undefined,
  source: 'stored' | 'computed',
  mask: MaskRule | undefined
): ColumnProfile {
  const hasStats = stats !== undefined && (source === 'computed' || stats.distinct_values !== null || stats.null_count !== null);
  const profile: ColumnProfile = {
    column_name: column.column_name,
    data_type: column.data_type,
    source: hasStats ? source : 'none',
    distinct_values: stats?.distinct_values ?? null,
    null_count: stats?.null_count ?? null,
    low: mask ? null : stats?.low ?? null,
    high: mask ? null : stats?.high ?? null,
  };
  if (source === 'stored') {
    profile.statistics_updated = stats?.statistics_updated ?? null;
  }
  if (mask) {
    profile.masked = mask;
  }
  return profile;
}

export async function profileTableTool(input: {
  schema?: string;
  table: string;
  compute?: boolean;
  columns?: string[];
  sessionId?: string;
  defaultSchema?: string;
}): Promise<ProfileTableResult> {
  try {
    const schema = requireSchema(input.schema, input.defaultSchema).trim().toUpperCase();
    const table = input.table.trim().toUpperCase();
    const allowed = getAllowedSchemas();
    if (allowed && !isSchemaAllowed(schema, allowed)) {
      return { success: false, error: schemaDenied(schema, allowed) };
    }

    const catalog = await readColumns(schema, table, input.sessionId);
    if (catalog.length === 0) {
      return { success: false, error: `Table ${schema}.${table} was not found.` };
    }

    const selected = selectColumns(catalog, input.columns);
    if (!selected.ok) {
      return { success: false, error: selected.error };
    }

    const masks = getCustomTools().masking.get(`${schema}.${table}`) ?? new Map<string, MaskRule>();
    const tableStats = await readTableStats(schema, table, input.sessionId);

    if (!input.compute) {
      const stored = await readStoredColumnStats(schema, table, input.sessionId);
      const data = selected.columns.map((column) => {
        const name = column.column_name.toUpperCase();
        return profileOf(column, stored.get(name), 'stored', masks.get(name));
      });
      return {
        success: true,
        schema,
        table,
        mode: 'stored',
        table_stats: tableStats,
        data,
        count: data.length,
        truncated: false,
      };
    }

    const scanned = selected.columns.slice(0, MAX_COMPUTED_COLUMNS);
    const computed = await computeColumnStats(schema, table, scanned, new Set(masks.keys()), input.sessionId);
    const data = scanned.map((column) => {
      const name = column.column_name.toUpperCase();
      return profileOf(column, computed.columns.get(name), 'computed', masks.get(name));
    });

    return {
      success: true,
      schema,
      table,
      mode: 'computed',
      table_stats: tableStats,
      computed_rows: computed.rowCount,
      data,
      count: data.length,
      truncated: selected.columns.length > scanned.length,
      sql: computed.sql,
    };
  } catch (error) {
    return { success: false, error: messageOf(error) };
  }
}
