/**
 * Result view entry point: connect to the host, read the tool result, and
 * show it as a chart or a grid.
 */

import {
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  DoughnutController,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PieController,
  PointElement,
  ScatterController,
  Title,
  Tooltip,
} from 'chart.js';
import type { McpUiHostContext } from '@modelcontextprotocol/ext-apps';

import { connect, type Bridge } from './bridge.js';
import { buildChart } from './build.js';
import { readResult, type ResultTable } from './data.js';
import { renderGrid } from './grid.js';
import { availableTypes, selectChart, type ChartPlan } from './select.js';
import { fallbackFonts, themeFor, type Fonts, type ThemeMode } from './theme.js';

Chart.register(
  BarController, LineController, PieController, DoughnutController, ScatterController,
  BarElement, LineElement, PointElement, ArcElement,
  CategoryScale, LinearScale,
  Tooltip, Legend, Title, Filler,
);

declare const __APP_VERSION__: string;

const TYPE_LABELS: Record<ChartPlan['type'], string> = {
  bar: 'Bar',
  line: 'Line',
  area: 'Area',
  pie: 'Pie',
  doughnut: 'Doughnut',
  scatter: 'Scatter',
  pareto: 'Pareto',
  waterfall: 'Waterfall',
  histogram: 'Histogram',
  kpi: 'Number',
};

interface ViewState {
  table?: ResultTable;
  plan: ChartPlan | null;
  view: 'chart' | 'table';
  mode: ThemeMode;
  locale?: string;
  chart?: Chart;
}

const state: ViewState = {
  plan: null,
  view: 'table',
  mode: window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
};

const root = document.getElementById('app') as HTMLElement;

function fontsFromPage(): Fonts {
  const probe = (variable: string, fallback: string): string => {
    const value = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
    return value || fallback;
  };
  return { sans: probe('--font-sans', fallbackFonts.sans), mono: probe('--font-mono', fallbackFonts.mono) };
}

function applyHostContext(context: McpUiHostContext): void {
  if (context.theme === 'light' || context.theme === 'dark') {
    state.mode = context.theme;
  }
  if (typeof context.locale === 'string') {
    state.locale = context.locale;
  }
  const variables = context.styles?.variables;
  if (variables) {
    for (const [name, value] of Object.entries(variables)) {
      if (typeof value === 'string' && name.startsWith('--')) {
        document.documentElement.style.setProperty(name, value);
      }
    }
  }
  const fontCss = context.styles?.css?.fonts;
  if (typeof fontCss === 'string' && !document.getElementById('host-fonts')) {
    const style = document.createElement('style');
    style.id = 'host-fonts';
    style.textContent = fontCss;
    document.head.append(style);
  }
  document.documentElement.dataset.theme = state.mode;
  render();
}

function message(text: string, error = false): void {
  state.chart?.destroy();
  state.chart = undefined;
  const p = document.createElement('p');
  p.className = error ? 'message error' : 'message';
  p.textContent = text;
  root.replaceChildren(p);
}

function toolbar(table: ResultTable): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'toolbar';
  const tabs = document.createElement('div');
  tabs.className = 'tabs';
  tabs.setAttribute('role', 'tablist');
  for (const view of ['chart', 'table'] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(state.view === view));
    button.textContent = view === 'chart' ? 'Chart' : 'Table';
    button.disabled = view === 'chart' && !state.plan;
    button.addEventListener('click', () => {
      state.view = view;
      render();
    });
    tabs.append(button);
  }
  bar.append(tabs);

  const types = availableTypes(table);
  if (state.view === 'chart' && state.plan && types.length > 1) {
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Chart type');
    const options = types.includes(state.plan.type) ? types : [state.plan.type, ...types];
    for (const type of options) {
      const option = document.createElement('option');
      option.value = type;
      option.textContent = TYPE_LABELS[type];
      option.selected = type === state.plan.type;
      select.append(option);
    }
    select.addEventListener('change', () => {
      state.plan = replanFor(table, select.value as ChartPlan['type']);
      render();
    });
    bar.append(select);
  }
  return bar;
}

/** The plan for a type the user picked, keeping the columns that still fit. */
function replanFor(table: ResultTable, type: ChartPlan['type']): ChartPlan | null {
  const current = state.plan;
  const picked = selectChart({ ...table, chart: { type, ...(current?.x && type !== 'scatter' ? { x: current.x } : {}), ...(current?.series && (type === 'bar' || type === 'line' || type === 'area') ? { series: current.series, stacked: current.stacked } : {}) } });
  return picked.plan;
}

function renderChart(container: HTMLElement, table: ResultTable, plan: ChartPlan): void {
  const built = buildChart(table, plan, { theme: themeFor(state.mode), fonts: fontsFromPage(), locale: state.locale });
  if (built.kind === 'empty') {
    const p = document.createElement('p');
    p.className = 'message';
    p.textContent = built.reason;
    container.append(p);
    return;
  }
  if (built.kind === 'kpi') {
    const tiles = document.createElement('div');
    tiles.className = 'kpis';
    if (built.title) {
      const title = document.createElement('h2');
      title.textContent = built.title;
      container.append(title);
    }
    for (const item of built.items) {
      const tile = document.createElement('div');
      tile.className = 'kpi';
      const label = document.createElement('div');
      label.className = 'kpi-label';
      label.textContent = item.label;
      const value = document.createElement('div');
      value.className = 'kpi-value';
      value.textContent = item.value;
      tile.append(label, value);
      tiles.append(tile);
    }
    container.append(tiles);
    return;
  }
  const box = document.createElement('div');
  box.className = 'chart';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', plan.title ?? `${TYPE_LABELS[plan.type]} chart of ${plan.y.join(', ')}`);
  box.append(canvas);
  container.append(box);
  state.chart = new Chart(canvas, built.config);
}

function render(): void {
  const table = state.table;
  if (!table) {
    return;
  }
  state.chart?.destroy();
  state.chart = undefined;
  const content = document.createElement('div');
  content.className = 'content';
  if (state.view === 'chart' && state.plan) {
    renderChart(content, table, state.plan);
  } else {
    renderGrid(content, table);
  }
  const notes = document.createElement('div');
  notes.className = 'notes';
  for (const warning of table.warnings) {
    const p = document.createElement('p');
    p.textContent = warning;
    notes.append(p);
  }
  root.replaceChildren(toolbar(table), content, ...(table.warnings.length > 0 ? [notes] : []));
}

function showResult(structured: unknown, text: string | undefined): void {
  let source = structured;
  if (source === undefined && text) {
    try {
      source = JSON.parse(text);
    } catch {
      source = undefined;
    }
  }
  const read = readResult(source);
  if (!read) {
    message(text ?? 'This result has no rows to show.');
    return;
  }
  if ('error' in read) {
    message(read.error, true);
    return;
  }
  if (read.rows.length === 0) {
    message('No rows matched.');
    return;
  }
  const selection = selectChart(read);
  state.table = read;
  state.plan = selection.plan;
  state.view = selection.showChart ? 'chart' : 'table';
  render();
}

function watchSize(bridge: Bridge): void {
  let last = 0;
  const report = (): void => {
    const height = document.documentElement.scrollHeight;
    if (Math.abs(height - last) > 1) {
      last = height;
      bridge.sizeChanged(height);
    }
  };
  new ResizeObserver(report).observe(document.body);
  report();
}

message('Waiting for the result\u2026');

connect(window.parent, { name: 'db2i-result-view', version: __APP_VERSION__ }, {
  onToolResult: (result) => {
    const first = result.content?.find((item) => item.type === 'text');
    showResult(result.structuredContent, first && 'text' in first ? first.text : undefined);
  },
  onHostContext: applyHostContext,
}).then(watchSize, (error: unknown) => {
  message(error instanceof Error ? error.message : 'Could not connect to the host.', true);
});
