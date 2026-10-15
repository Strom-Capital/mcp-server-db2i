/**
 * Result columns and chart hints for the result view (ui://db2i/result).
 *
 * Tools that return rows also return `columns`, each column's name and kind, so
 * the view can tell a measure from a label without guessing from JSON values.
 * A chart hint comes from the model (execute_query's `chart` argument) or from
 * a YAML tool's `chart:` block. It names result columns, which are only known
 * once the query has run, so it is checked against the result here.
 */

import { z } from 'zod';

import type { ColumnKind, DbColumn } from '../db/driver.js';

/** One result column as tools return it. */
export type ResultColumn = {
  name: string;
  kind: ColumnKind;
};

export const resultColumnsSchema = z.array(z.object({ name: z.string(), kind: z.string() }));

/**
 * The columns of a result, in order, as name and kind. A duplicate name is
 * listed once, at its first position, with the kind of its last column, whose
 * value the row object holds. A masked column is text, whatever its type,
 * because its values are replaced.
 *
 * @param columns - Columns the driver reported, if any
 * @param maskedColumns - Upper-case names of the masked columns
 */
export function resultColumns(
  columns: readonly DbColumn[] | undefined,
  maskedColumns: ReadonlySet<string> = new Set(),
): ResultColumn[] | undefined {
  if (!columns || columns.length === 0) {
    return undefined;
  }
  const byName = new Map<string, ResultColumn>();
  for (const column of columns) {
    const kind = maskedColumns.has(column.name.toUpperCase()) ? 'string' : column.kind;
    byName.set(column.name, { name: column.name, kind });
  }
  return [...byName.values()];
}

export const CHART_TYPES = [
  'bar',
  'line',
  'area',
  'pie',
  'doughnut',
  'scatter',
  'pareto',
  'waterfall',
  'histogram',
  'kpi',
  'table',
] as const;

export type ChartType = (typeof CHART_TYPES)[number];

const columnName = z.string().trim().min(1).max(128);

/** A chart hint. Every field but `type` is optional; the view fills in what is left out. */
export const chartSpecSchema = z.strictObject({
  type: z.enum(CHART_TYPES).describe(
    'bar, line or area for categories or time; pie or doughnut for a share of six or fewer parts; ' +
      'scatter for two measures; pareto for a ranking with cumulative share; waterfall for a running total ' +
      '(first row is the start value, the rest are changes); histogram to bin one measure; ' +
      'kpi for a one-row result; table for no chart'
  ),
  x: columnName.optional().describe('Column for categories or time (the x axis)'),
  y: z.array(columnName).min(1).max(8).optional().describe('Measure columns'),
  series: columnName.optional().describe('Column whose values become separate series, such as STATUS'),
  stacked: z.boolean().optional().describe('Stack bar or area series'),
  horizontal: z.boolean().optional().describe('Horizontal bars, for long labels or rankings'),
  target: columnName.optional().describe('Column with a target or budget, drawn as a line over the bars'),
  title: z.string().trim().min(1).max(120).optional(),
});

export type ChartSpec = z.infer<typeof chartSpecSchema>;

/**
 * Check a chart hint against the result's columns. Column names match without
 * regard to case and come back as the result spells them.
 *
 * @returns The hint with result column names, or why it does not fit the result
 */
export function resolveChartSpec(
  spec: ChartSpec,
  columns: readonly ResultColumn[] | undefined,
): { ok: true; chart: ChartSpec } | { ok: false; error: string } {
  if (spec.type === 'table') {
    return { ok: true, chart: spec };
  }
  if (!columns) {
    return { ok: false, error: 'The result has no column information.' };
  }
  const byUpper = new Map(columns.map((column) => [column.name.toUpperCase(), column.name]));
  const unknown: string[] = [];
  const resolve = (name: string): string => {
    const found = byUpper.get(name.toUpperCase());
    if (!found) {
      unknown.push(name);
    }
    return found ?? name;
  };
  const chart: ChartSpec = { ...spec };
  if (spec.x) chart.x = resolve(spec.x);
  if (spec.y) chart.y = spec.y.map(resolve);
  if (spec.series) chart.series = resolve(spec.series);
  if (spec.target) chart.target = resolve(spec.target);
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `Chart columns not in the result: ${unknown.join(', ')}. Result columns: ${columns.map((c) => c.name).join(', ')}.`,
    };
  }
  return { ok: true, chart };
}

/** What a row-returning tool adds to its result for the result view. */
export type ResultViewFields = {
  columns?: ResultColumn[];
  chart?: ChartSpec;
  /** Why the chart hint was dropped. The view then picks a chart itself. */
  chartError?: string;
};

/**
 * The result's columns, and the chart hint checked against them.
 *
 * @param columns - Columns the driver reported, if any
 * @param maskedColumns - Upper-case names of the masked columns
 * @param chart - The chart hint, if any
 */
export function resultViewFields(
  columns: readonly DbColumn[] | undefined,
  maskedColumns: ReadonlySet<string>,
  chart: ChartSpec | undefined,
): ResultViewFields {
  const resolvedColumns = resultColumns(columns, maskedColumns);
  const fields: ResultViewFields = resolvedColumns ? { columns: resolvedColumns } : {};
  if (!chart) {
    return fields;
  }
  const resolved = resolveChartSpec(chart, resolvedColumns);
  return resolved.ok ? { ...fields, chart: resolved.chart } : { ...fields, chartError: resolved.error };
}
