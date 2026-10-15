/**
 * Chart.js configuration for a chart plan, in the brand theme: hairline grid,
 * ink baseline, mono labels, square bars and legend keys, flat fills.
 */

import type { ChartConfiguration, Plugin } from 'chart.js';

import { labelOf, numberOf, timeOf, type Column, type ResultTable, type Row } from './data.js';
import type { ChartPlan } from './select.js';
import { MAX_SERIES, seriesColor, withAlpha, type Fonts, type Theme } from './theme.js';

export interface KpiItem {
  label: string;
  value: string;
}

export type BuiltChart =
  | { kind: 'chart'; config: ChartConfiguration }
  | { kind: 'kpi'; items: KpiItem[]; title?: string }
  | { kind: 'empty'; reason: string };

export interface BuildContext {
  theme: Theme;
  fonts: Fonts;
  locale?: string;
}

/** Most bars a sorted bar chart shows before the rest fold into "Other". */
const MAX_RANKED_BARS = 20;
/** Most slices before the rest fold into "Other". */
const MAX_SLICES = 6;
const OTHER = 'Other';

const columnOf = (table: ResultTable, name: string | undefined): Column | undefined =>
  table.columns.find((c) => c.name === name);

function formatter(locale: string | undefined) {
  const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
  const full = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  return {
    tick: (value: number | string) => (typeof value === 'number' ? compact.format(value) : value),
    full: (value: number) => full.format(value),
  };
}

/** Category labels in axis order: time ascending, otherwise as the rows came. */
function axisLabels(table: ResultTable, x: Column): string[] {
  if (x.role === 'time') {
    const keyed = new Map<string, number>();
    for (const row of table.rows) {
      const time = timeOf(row[x.name], x);
      if (time && !keyed.has(time.label)) {
        keyed.set(time.label, time.key);
      }
    }
    return [...keyed.entries()]
      .sort((a, b) => (Number.isNaN(a[1]) || Number.isNaN(b[1]) ? 0 : a[1] - b[1]))
      .map(([label]) => label);
  }
  return [...new Set(table.rows.map((row) => labelOf(row[x.name], x)))];
}

/** Sum of a measure per label, and per series value when a series column is set. */
function aggregate(rows: Row[], x: Column, y: string, series?: Column): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const value = numberOf(row[y]);
    if (value === null) {
      continue;
    }
    const label = labelOf(row[x.name], x);
    const key = series ? labelOf(row[series.name], series) : y;
    const bucket = result.get(label) ?? new Map<string, number>();
    bucket.set(key, (bucket.get(key) ?? 0) + value);
    result.set(label, bucket);
  }
  return result;
}

/** Keep the `keep` largest entries and sum the rest into "Other". */
function foldSmallest(entries: [string, number][], keep: number): [string, number][] {
  if (entries.length <= keep + 1) {
    return entries;
  }
  const sorted = [...entries].sort((a, b) => b[1] - a[1]);
  const rest = sorted.slice(keep).reduce((sum, [, value]) => sum + value, 0);
  return [...sorted.slice(0, keep), [OTHER, rest]];
}

function baseOptions(ctx: BuildContext, plan: ChartPlan, legend: boolean) {
  const { theme, fonts } = ctx;
  const fmt = formatter(ctx.locale);
  const tick = { color: theme.muted, font: { family: fonts.mono, size: 11 } };
  const valueAxis = plan.horizontal ? 'x' : 'y';
  const categoryAxis = plan.horizontal ? 'y' : 'x';
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 250 },
    indexAxis: plan.horizontal ? 'y' : 'x',
    interaction: { mode: 'index', intersect: false },
    layout: { padding: { top: 4, right: 8 } },
    plugins: {
      title: {
        display: Boolean(plan.title), text: plan.title, align: 'start', color: theme.ink,
        font: { family: fonts.sans, size: 14, weight: 500 }, padding: { bottom: 12 },
      },
      legend: {
        display: legend, align: 'start', position: 'top',
        labels: { color: theme.muted, usePointStyle: true, pointStyle: 'rect', boxWidth: 8, boxHeight: 8, padding: 14, font: { family: fonts.mono, size: 11 } },
      },
      tooltip: {
        backgroundColor: theme.surface, titleColor: theme.ink, bodyColor: theme.ink, borderColor: theme.line, borderWidth: 1,
        cornerRadius: 2, padding: 10, boxWidth: 8, boxHeight: 8, usePointStyle: true,
        titleFont: { family: fonts.mono, size: 11, weight: 500 }, bodyFont: { family: fonts.mono, size: 11 },
        callbacks: {
          label: (item: { dataset: { label?: string }; parsed: Record<string, number> }) => {
            const value = item.parsed[valueAxis] ?? item.parsed.y;
            return ` ${item.dataset.label ?? ''}: ${typeof value === 'number' ? fmt.full(value) : value}`;
          },
        },
      },
    },
    scales: {
      [categoryAxis]: {
        stacked: plan.stacked,
        grid: { display: false },
        border: { color: theme.ink, width: 1 },
        ticks: { ...tick, autoSkip: true, maxRotation: 45 },
      },
      [valueAxis]: {
        stacked: plan.stacked,
        beginAtZero: true,
        grid: { color: theme.line, lineWidth: 1 },
        border: { display: false },
        ticks: { ...tick, maxTicksLimit: 6, callback: fmt.tick },
      },
    },
    elements: {
      bar: { borderRadius: 0, borderWidth: 0 },
      line: { borderWidth: 1.75, tension: 0 },
      point: { radius: 0, hoverRadius: 4, pointStyle: 'rect', hitRadius: 8 },
      arc: { borderWidth: 2, borderColor: theme.surface },
    },
  } as Record<string, unknown> & { plugins: Record<string, Record<string, unknown>>; scales: Record<string, Record<string, unknown>> };
}

function config(type: string, data: unknown, options: unknown, plugins: Plugin[] = []): BuiltChart {
  return { kind: 'chart', config: { type, data, options, plugins } as unknown as ChartConfiguration };
}

function categoryChart(table: ResultTable, plan: ChartPlan, ctx: BuildContext): BuiltChart {
  const { theme } = ctx;
  const x = columnOf(table, plan.x);
  if (!x) {
    return { kind: 'empty', reason: 'No column for the axis.' };
  }
  const series = columnOf(table, plan.series);
  const isLine = plan.type === 'line' || plan.type === 'area';
  let labels = axisLabels(table, x);
  const datasets: Record<string, unknown>[] = [];
  const options = baseOptions(ctx, plan, true);

  if (series) {
    const sums = aggregate(table.rows, x, plan.y[0], series);
    const totals = new Map<string, number>();
    for (const bucket of sums.values()) {
      for (const [key, value] of bucket) {
        totals.set(key, (totals.get(key) ?? 0) + value);
      }
    }
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
    const keys = ranked.length > MAX_SERIES + 1 ? [...ranked.slice(0, MAX_SERIES), OTHER] : ranked;
    keys.forEach((key, index) => {
      const color = key === OTHER ? theme.other : seriesColor(theme, index);
      const data = labels.map((label) => {
        const bucket = sums.get(label);
        if (!bucket) return null;
        if (key !== OTHER) return bucket.get(key) ?? null;
        let rest = 0;
        for (const [k, v] of bucket) if (!keys.includes(k)) rest += v;
        return rest;
      });
      datasets.push(seriesDataset(plan, key, data, color, index, theme));
    });
  } else {
    const sums = plan.y.map((y) => aggregate(table.rows, x, y));
    const single = plan.y.length === 1;
    if (single && !isLine && x.role !== 'time' && (plan.horizontal || labels.length > MAX_RANKED_BARS)) {
      const entries = foldSmallest(labels.map((label) => [label, sums[0].get(label)?.get(plan.y[0]) ?? 0]), MAX_RANKED_BARS);
      labels = entries.map(([label]) => label);
      datasets.push({
        label: plan.y[0], data: entries.map(([, value]) => value), barPercentage: 0.75,
        backgroundColor: entries.map(([label]) => (label === OTHER ? theme.other : theme.accent)),
      });
    } else {
      const magnitudes = sums.map((sum) => Math.max(0, ...[...sum.values()].map((bucket) => Math.abs([...bucket.values()][0] ?? 0))));
      const split = plan.y.length === 2 && !plan.stacked && Math.min(...magnitudes) > 0 &&
        Math.max(...magnitudes) / Math.min(...magnitudes) > 10;
      plan.y.forEach((y, index) => {
        const data = labels.map((label) => sums[index].get(label)?.get(y) ?? null);
        const color = single ? theme.accent : seriesColor(theme, index);
        const dataset = seriesDataset(plan, y, data, color, index, theme);
        if (split && index === 1) {
          dataset.yAxisID = 'y1';
        }
        datasets.push(dataset);
      });
      if (split) {
        const right = { ...(options.scales.y as Record<string, unknown>), position: 'right', grid: { display: false } };
        options.scales.y1 = right;
      }
    }
    if (plan.target) {
      const target = aggregate(table.rows, x, plan.target);
      const values = labels.map((label) => target.get(label)?.get(plan.target as string) ?? null);
      const actual = datasets[0];
      if (actual && !isLine && Array.isArray(actual.data)) {
        actual.backgroundColor = (actual.data as (number | null)[]).map((value, i) =>
          value !== null && values[i] !== null && value < (values[i] as number) ? withAlpha(theme.accent, 0.4) : theme.accent);
        actual.order = 2;
      }
      datasets.push({
        type: 'line', label: plan.target, data: values, borderColor: theme.ink, backgroundColor: theme.ink,
        borderDash: [4, 3], stepped: 'middle', pointRadius: 0, order: 1,
      });
    }
  }
  options.plugins.legend.display = datasets.length > 1;
  return config(isLine ? 'line' : 'bar', { labels, datasets }, options);
}

function seriesDataset(
  plan: ChartPlan,
  label: string,
  data: (number | null)[],
  color: string,
  index: number,
  theme: Theme,
): Record<string, unknown> {
  if (plan.type === 'area') {
    const fill = plan.stacked ? (index === 0 ? 'origin' : '-1') : 'origin';
    return { label, data, borderColor: color, backgroundColor: withAlpha(color, theme.mode === 'light' ? 0.3 : 0.4), fill, spanGaps: true };
  }
  if (plan.type === 'line') {
    return { label, data, borderColor: color, backgroundColor: color, spanGaps: true, pointRadius: data.length <= 24 ? 2.5 : 0 };
  }
  return { label, data, backgroundColor: color, barPercentage: 0.75 };
}

/** Total in the middle of a doughnut. */
function centerTotal(theme: Theme, fonts: Fonts, format: (value: number) => string): Plugin<'doughnut'> {
  return {
    id: 'centerTotal',
    afterDraw(chart) {
      const area = chart.chartArea;
      const values = chart.data.datasets[0]?.data ?? [];
      const total = (values as number[]).reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0);
      const x = (area.left + area.right) / 2;
      const y = (area.top + area.bottom) / 2;
      const c = chart.ctx;
      c.save();
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillStyle = theme.ink;
      c.font = `400 22px ${fonts.sans}`;
      c.fillText(format(total), x, y);
      c.restore();
    },
  };
}

function sliceChart(table: ResultTable, plan: ChartPlan, ctx: BuildContext): BuiltChart {
  const { theme, fonts } = ctx;
  const x = columnOf(table, plan.x);
  if (!x) {
    return { kind: 'empty', reason: 'No column for the slices.' };
  }
  const sums = aggregate(table.rows, x, plan.y[0]);
  const entries = foldSmallest(
    [...sums.entries()].map(([label, bucket]): [string, number] => [label, bucket.get(plan.y[0]) ?? 0]).filter(([, value]) => value > 0),
    MAX_SLICES,
  ).sort((a, b) => (a[0] === OTHER ? 1 : b[0] === OTHER ? -1 : b[1] - a[1]));
  const options = baseOptions(ctx, plan, true);
  delete (options as Record<string, unknown>).scales;
  options.interaction = { mode: 'nearest', intersect: true };
  options.plugins.legend = { ...options.plugins.legend, position: 'right', align: 'center' };
  if (plan.type === 'doughnut') {
    options.cutout = '66%';
  }
  const fmt = formatter(ctx.locale);
  options.plugins.tooltip = {
    ...options.plugins.tooltip,
    callbacks: { label: (item: { label: string; parsed: number }) => ` ${item.label}: ${fmt.full(item.parsed)}` },
  };
  const plugins = plan.type === 'doughnut' ? [centerTotal(theme, fonts, fmt.tick as (v: number) => string) as Plugin] : [];
  return config(plan.type, {
    labels: entries.map(([label]) => label),
    datasets: [{
      label: plan.y[0],
      data: entries.map(([, value]) => value),
      backgroundColor: entries.map(([label], index) => (label === OTHER ? theme.other : seriesColor(theme, index))),
    }],
  }, options, plugins);
}

function paretoChart(table: ResultTable, plan: ChartPlan, ctx: BuildContext): BuiltChart {
  const { theme, fonts } = ctx;
  const x = columnOf(table, plan.x);
  if (!x) {
    return { kind: 'empty', reason: 'No column for the categories.' };
  }
  const sums = aggregate(table.rows, x, plan.y[0]);
  const entries = foldSmallest(
    [...sums.entries()].map(([label, bucket]): [string, number] => [label, bucket.get(plan.y[0]) ?? 0]),
    MAX_RANKED_BARS + 10,
  ).sort((a, b) => (a[0] === OTHER ? 1 : b[0] === OTHER ? -1 : b[1] - a[1]));
  const total = entries.reduce((sum, [, value]) => sum + value, 0) || 1;
  let running = 0;
  const cumulative = entries.map(([, value]) => Math.round(((running += value) / total) * 1000) / 10);
  const options = baseOptions(ctx, { ...plan, horizontal: false, stacked: false }, true);
  options.scales.y1 = {
    position: 'right', min: 0, max: 100, grid: { display: false }, border: { display: false },
    ticks: { color: theme.muted, font: { family: fonts.mono, size: 11 }, stepSize: 20, callback: (v: number) => `${v}%` },
  };
  return config('bar', {
    labels: entries.map(([label]) => label),
    datasets: [
      {
        type: 'bar', label: plan.y[0], data: entries.map(([, value]) => value), yAxisID: 'y', order: 2, barPercentage: 0.8,
        backgroundColor: entries.map(([label], i) => (label !== OTHER && (i === 0 || cumulative[i - 1] < 80) ? theme.accent : theme.other)),
      },
      { type: 'line', label: 'Cumulative %', data: cumulative, yAxisID: 'y1', order: 1, borderColor: theme.ink, backgroundColor: theme.ink, pointRadius: 2 },
    ],
  }, options);
}

function waterfallChart(table: ResultTable, plan: ChartPlan, ctx: BuildContext): BuiltChart {
  const { theme } = ctx;
  const x = columnOf(table, plan.x);
  if (!x) {
    return { kind: 'empty', reason: 'No column for the steps.' };
  }
  const steps = table.rows
    .map((row) => ({ label: labelOf(row[x.name], x), value: numberOf(row[plan.y[0]]) }))
    .filter((step): step is { label: string; value: number } => step.value !== null);
  if (steps.length < 2) {
    return { kind: 'empty', reason: 'A waterfall needs a start value and at least one change.' };
  }
  let level = steps[0].value;
  const bars: { label: string; range: [number, number]; color: string; value: number }[] = [
    { label: steps[0].label, range: [0, level], color: theme.total, value: level },
  ];
  for (const step of steps.slice(1)) {
    const start = level;
    level += step.value;
    bars.push({ label: step.label, range: [start, level], color: step.value >= 0 ? theme.up : theme.down, value: step.value });
  }
  bars.push({ label: 'End', range: [0, level], color: theme.total, value: level });
  const fmt = formatter(ctx.locale);
  const options = baseOptions(ctx, { ...plan, horizontal: false, stacked: false }, false);
  options.scales.y = { ...options.scales.y, beginAtZero: false };
  options.plugins.tooltip = {
    ...options.plugins.tooltip,
    callbacks: {
      label: (item: { dataIndex: number }) => {
        const bar = bars[item.dataIndex];
        const total = item.dataIndex === 0 || item.dataIndex === bars.length - 1;
        return ` ${total ? '' : bar.value > 0 ? '+' : ''}${fmt.full(bar.value)}`;
      },
    },
  };
  return config('bar', {
    labels: bars.map((bar) => bar.label),
    datasets: [{ label: plan.y[0], data: bars.map((bar) => bar.range), backgroundColor: bars.map((bar) => bar.color), barPercentage: 0.7 }],
  }, options);
}

/** Bin edges on round numbers. */
export function histogramBins(values: number[]): { edges: number[]; counts: number[] } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) {
    return { edges: [min, min + 1], counts: [values.length] };
  }
  const target = Math.min(20, Math.max(5, Math.ceil(Math.log2(values.length) + 1)));
  const raw = (max - min) / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
  const start = Math.floor(min / step) * step;
  const edges: number[] = [];
  for (let edge = start; edge <= max + step / 2; edge += step) {
    edges.push(Math.round(edge * 1e9) / 1e9);
  }
  if (edges[edges.length - 1] <= max) {
    edges.push(Math.round((edges[edges.length - 1] + step) * 1e9) / 1e9);
  }
  const counts = new Array(edges.length - 1).fill(0);
  for (const value of values) {
    const index = Math.min(counts.length - 1, Math.floor((value - start) / step));
    counts[index] += 1;
  }
  return { edges, counts };
}

function histogramChart(table: ResultTable, plan: ChartPlan, ctx: BuildContext): BuiltChart {
  const values = table.rows.map((row) => numberOf(row[plan.y[0]])).filter((v): v is number => v !== null);
  if (values.length === 0) {
    return { kind: 'empty', reason: 'No numbers to bin.' };
  }
  const { edges, counts } = histogramBins(values);
  const fmt = formatter(ctx.locale);
  const labels = counts.map((_, i) => `${fmt.tick(edges[i])}-${fmt.tick(edges[i + 1])}`);
  const options = baseOptions(ctx, { ...plan, horizontal: false, stacked: false }, false);
  return config('bar', {
    labels,
    datasets: [{
      label: `Rows by ${plan.y[0]}`, data: counts, backgroundColor: ctx.theme.accent, borderColor: ctx.theme.surface,
      borderWidth: 1, barPercentage: 1, categoryPercentage: 1,
    }],
  }, options);
}

function scatterChart(table: ResultTable, plan: ChartPlan, ctx: BuildContext): BuiltChart {
  const { theme, fonts } = ctx;
  const series = columnOf(table, plan.series);
  const groups = new Map<string, { x: number; y: number }[]>();
  for (const row of table.rows) {
    const x = numberOf(row[plan.x as string]);
    const y = numberOf(row[plan.y[0]]);
    if (x === null || y === null) continue;
    const key = series ? labelOf(row[series.name], series) : plan.y[0];
    const points = groups.get(key) ?? [];
    points.push({ x, y });
    groups.set(key, points);
  }
  const keys = [...groups.keys()].slice(0, MAX_SERIES);
  const options = baseOptions(ctx, { ...plan, horizontal: false, stacked: false }, keys.length > 1);
  options.interaction = { mode: 'nearest', intersect: true };
  const fmt = formatter(ctx.locale);
  options.scales.x = {
    type: 'linear', grid: { color: theme.line }, border: { color: theme.ink },
    title: { display: true, text: plan.x, color: theme.muted, font: { family: fonts.mono, size: 11 } },
    ticks: { color: theme.muted, font: { family: fonts.mono, size: 11 }, maxTicksLimit: 8, callback: fmt.tick },
  };
  options.scales.y = {
    ...options.scales.y, beginAtZero: false,
    title: { display: true, text: plan.y[0], color: theme.muted, font: { family: fonts.mono, size: 11 } },
  };
  options.plugins.tooltip = {
    ...options.plugins.tooltip,
    callbacks: { label: (item: { parsed: { x: number; y: number } }) => ` ${fmt.full(item.parsed.x)}, ${fmt.full(item.parsed.y)}` },
  };
  return config('scatter', {
    datasets: keys.map((key, index) => ({
      label: key, data: groups.get(key), backgroundColor: withAlpha(seriesColor(theme, index), 0.8), pointRadius: 3, pointHoverRadius: 5,
    })),
  }, options);
}

function kpi(table: ResultTable, plan: ChartPlan, ctx: BuildContext): BuiltChart {
  const row = table.rows[0];
  if (!row) {
    return { kind: 'empty', reason: 'No rows.' };
  }
  const fmt = formatter(ctx.locale);
  const items = plan.y.map((name) => {
    const value = numberOf(row[name]);
    return { label: name, value: value === null ? String(row[name] ?? '') : fmt.full(value) };
  });
  return { kind: 'kpi', items, ...(plan.title ? { title: plan.title } : {}) };
}

/**
 * Build the chart for a plan.
 *
 * @param table - The result
 * @param plan - What to draw
 * @param ctx - Theme, fonts and locale
 */
export function buildChart(table: ResultTable, plan: ChartPlan, ctx: BuildContext): BuiltChart {
  switch (plan.type) {
    case 'kpi':
      return kpi(table, plan, ctx);
    case 'pie':
    case 'doughnut':
      return sliceChart(table, plan, ctx);
    case 'pareto':
      return paretoChart(table, plan, ctx);
    case 'waterfall':
      return waterfallChart(table, plan, ctx);
    case 'histogram':
      return histogramChart(table, plan, ctx);
    case 'scatter':
      return scatterChart(table, plan, ctx);
    default:
      return categoryChart(table, plan, ctx);
  }
}
