/**
 * Which chart to draw. A hint wins when it fits the result; the parts it
 * leaves out are filled in. Without one, rules on the column roles pick a
 * chart, or none when the result does not chart well.
 */

import type { ChartHint, ChartType, Column, ResultTable } from './data.js';
import { MAX_SERIES } from './theme.js';

/** A chart with every column it needs chosen. */
export interface ChartPlan {
  type: Exclude<ChartType, 'table'>;
  x?: string;
  y: string[];
  series?: string;
  stacked: boolean;
  horizontal: boolean;
  target?: string;
  title?: string;
}

export interface Selection {
  plan: ChartPlan | null;
  /** Open on the chart rather than the grid. */
  showChart: boolean;
}

/** Bar charts with more categories than this turn horizontal. */
const MAX_VERTICAL_BARS = 12;

/** Above this many columns the result is detail rows, so it opens on the grid. */
const MAX_COLUMNS_FOR_CHART_FIRST = 4;

const byRole = (table: ResultTable, role: Column['role']): Column[] =>
  table.columns.filter((column) => column.role === role);

const column = (table: ResultTable, name: string | undefined): Column | undefined =>
  name === undefined ? undefined : table.columns.find((c) => c.name === name);

function averageLabelLength(table: ResultTable, name: string): number {
  if (table.rows.length === 0) {
    return 0;
  }
  const total = table.rows.reduce((sum, row) => sum + String(row[name] ?? '').trim().length, 0);
  return total / table.rows.length;
}

/** The chart the rules pick from the column roles alone. */
export function ruleChart(table: ResultTable): ChartPlan | null {
  const rows = table.rows.length;
  if (rows === 0) {
    return null;
  }
  const measures = byRole(table, 'measure');
  const times = byRole(table, 'time');
  const categories = byRole(table, 'category');
  const base = { stacked: false, horizontal: false };
  // A series column repeats: each value covers two rows or more on average
  const isSeries = (c: Column): boolean => c.distinct >= 2 && c.distinct <= MAX_SERIES && c.distinct * 2 <= rows;

  if (measures.length === 0) {
    return null;
  }
  if (rows === 1 && measures.length <= 3 && categories.length + times.length <= 1) {
    return { ...base, type: 'kpi', y: measures.map((m) => m.name) };
  }
  if (times.length > 0 && rows >= 2) {
    const x = times[0].name;
    const series = categories.find(isSeries);
    if (series) {
      return { ...base, type: 'line', x, y: [measures[0].name], series: series.name };
    }
    return { ...base, type: 'line', x, y: measures.slice(0, 4).map((m) => m.name) };
  }
  if (categories.length >= 2) {
    const [first, second] = [...categories].sort((a, b) => a.distinct - b.distinct);
    if (isSeries(first)) {
      return { ...base, type: 'bar', x: second.name, y: [measures[0].name], series: first.name, stacked: true };
    }
  }
  if (categories.length >= 1) {
    const x = categories[0].name;
    if (measures.length >= 2) {
      return { ...base, type: 'bar', x, y: measures.slice(0, MAX_SERIES).map((m) => m.name) };
    }
    const horizontal = rows > MAX_VERTICAL_BARS || averageLabelLength(table, x) > 14;
    return { ...base, type: 'bar', x, y: [measures[0].name], horizontal };
  }
  if (times.length === 0 && measures.length >= 2 && rows >= 5) {
    return { ...base, type: 'scatter', x: measures[0].name, y: [measures[1].name] };
  }
  if (measures.length === 1 && rows >= 10) {
    return { ...base, type: 'histogram', y: [measures[0].name] };
  }
  return null;
}

/**
 * Complete a hint with columns from the result, or return null when it
 * cannot be drawn from these rows.
 */
export function planFromHint(table: ResultTable, hint: ChartHint): ChartPlan | null {
  if (hint.type === 'table') {
    return null;
  }
  const measures = byRole(table, 'measure').map((c) => c.name);
  const axes = [...byRole(table, 'time'), ...byRole(table, 'category')].map((c) => c.name);
  const used = new Set([hint.x, hint.series, hint.target].filter((n): n is string => Boolean(n)));
  const hinted = (hint.y ?? []).filter((name) => column(table, name));
  const y = hinted.length > 0 ? hinted : measures.filter((name) => !used.has(name));
  const plan: ChartPlan = {
    type: hint.type,
    y,
    stacked: hint.stacked ?? false,
    horizontal: hint.horizontal ?? false,
    ...(hint.series && column(table, hint.series) ? { series: hint.series } : {}),
    ...(hint.target && column(table, hint.target) ? { target: hint.target } : {}),
    ...(hint.title ? { title: hint.title } : {}),
  };

  switch (hint.type) {
    case 'scatter': {
      const x = hint.x ?? measures[0];
      const yScatter = hinted.length > 0 ? hinted : measures.filter((name) => name !== x).slice(0, 1);
      return x && yScatter.length > 0 ? { ...plan, x, y: yScatter } : null;
    }
    case 'histogram':
      return y.length > 0 ? { ...plan, y: [y[0]] } : null;
    case 'kpi':
      return y.length > 0 ? { ...plan, y: y.slice(0, 3) } : null;
    default: {
      const x = hint.x ?? axes.find((name) => name !== hint.series);
      if (!x || y.length === 0) {
        return null;
      }
      const single = hint.type === 'pie' || hint.type === 'doughnut' || hint.type === 'pareto' || hint.type === 'waterfall';
      return { ...plan, x, y: single ? [y[0]] : y.slice(0, MAX_SERIES) };
    }
  }
}

/**
 * The chart for a result, and whether the view opens on it.
 */
export function selectChart(table: ResultTable): Selection {
  if (table.chart) {
    const plan = planFromHint(table, table.chart);
    if (plan || table.chart.type === 'table') {
      return { plan: plan ?? ruleChart(table), showChart: plan !== null };
    }
  }
  const plan = ruleChart(table);
  const chartable = table.columns.filter((c) => c.role !== 'none').length;
  return { plan, showChart: plan !== null && chartable <= MAX_COLUMNS_FOR_CHART_FIRST };
}

/** Chart types the type menu offers for a result. */
export function availableTypes(table: ResultTable): ChartPlan['type'][] {
  const measures = byRole(table, 'measure').length;
  const axes = byRole(table, 'time').length + byRole(table, 'category').length;
  if (measures === 0 || table.rows.length === 0) {
    return [];
  }
  const types: ChartPlan['type'][] = [];
  if (axes > 0) {
    types.push('bar', 'line', 'area', 'pareto', 'waterfall');
    if (table.rows.length <= 50) {
      types.push('pie', 'doughnut');
    }
  }
  if (measures >= 2) {
    types.push('scatter');
  }
  types.push('histogram');
  if (table.rows.length <= 3) {
    types.push('kpi');
  }
  return types;
}
