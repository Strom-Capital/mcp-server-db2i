/**
 * Row filters from annotations, such as leaving out deleted rows.
 *
 * PARSE_STATEMENT names the tables a statement reads and the columns it
 * references anywhere (select list, WHERE, JOIN ON, a CTE), with the table a
 * qualified column belongs to. A filter counts as used when one of its columns
 * appears qualified with the annotated table, or unqualified. The check only
 * warns: reading deleted rows is sometimes the point.
 */

import type { StoredAnnotation, StoredFilter } from './loader.js';

/** The parts of a PARSE_STATEMENT row the check reads. */
export interface ParsedReference {
  nameType: string;
  schema: string | null;
  name: string | null;
  columnName: string | null;
}

export interface FilterCheck {
  /** SCHEMA.TABLE of each annotated table with a filter the statement does not use. */
  tables: string[];
  /** One message per unused filter, for the tool result's warnings. */
  warnings: string[];
}

const TABLE_TYPES = new Set(['TABLE', 'VIEW', 'ALIAS']);

/**
 * Find annotated tables in a parsed statement whose row filters it leaves out.
 *
 * @param parsed - Rows from QSYS2.PARSE_STATEMENT for the statement
 * @param annotations - Loaded annotations; only those with filters matter
 * @param defaultSchema - Schema unqualified table names resolve to
 */
export function checkRowFilters(
  parsed: ReadonlyArray<ParsedReference>,
  annotations: ReadonlyArray<StoredAnnotation>,
  defaultSchema?: string,
): FilterCheck {
  const filtered = new Map<string, StoredFilter[]>();
  for (const annotation of annotations) {
    if (annotation.filters && annotation.filters.length > 0) {
      filtered.set(annotation.table, annotation.filters);
    }
  }
  if (filtered.size === 0) {
    return { tables: [], warnings: [] };
  }

  const fallback = defaultSchema?.trim().toUpperCase() || undefined;
  const referenced = new Set<string>();
  for (const row of parsed) {
    if (TABLE_TYPES.has(row.nameType) && row.name) {
      for (const key of annotatedKeysFor(row, filtered, fallback)) {
        referenced.add(key);
      }
    }
  }

  const columns = parsed.filter((row) => row.nameType === 'COLUMN' && row.columnName);
  const tables: string[] = [];
  const warnings: string[] = [];
  for (const key of referenced) {
    let skipped = false;
    for (const filter of filtered.get(key) ?? []) {
      const used = columns.some(
        (row) =>
          filter.columns.includes(row.columnName!.trim().toUpperCase()) &&
          (!row.name || annotatedKeysFor(row, filtered, fallback).includes(key)),
      );
      if (!used) {
        skipped = true;
        warnings.push(filterWarning(key, filter));
      }
    }
    if (skipped) {
      tables.push(key);
    }
  }
  return { tables, warnings };
}

/** Annotated tables a table or qualified column reference can mean. */
function annotatedKeysFor(
  row: ParsedReference,
  filtered: Map<string, StoredFilter[]>,
  fallback: string | undefined,
): string[] {
  const table = row.name!.trim().toUpperCase();
  const schema = row.schema?.trim().toUpperCase() || fallback;
  if (schema) {
    const key = `${schema}.${table}`;
    return filtered.has(key) ? [key] : [];
  }
  return [...filtered.keys()].filter((key) => key.endsWith(`.${table}`));
}

function filterWarning(table: string, filter: StoredFilter): string {
  const reason = filter.reason ? ` (${filter.reason})` : '';
  return (
    `${table} has a filter ${filter.sql}${reason}. This query does not use ${filter.columns.join(' or ')}. ` +
    'Add the filter unless the question needs those rows.'
  );
}
