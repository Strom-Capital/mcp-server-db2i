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
  kpi: 'Key figures',
};

/** What the placeholder looks like: the shape the result will most likely take. */
type Shape = 'chart' | 'kpi' | 'table';

interface ViewState {
  table?: ResultTable;
  plan: ChartPlan | null;
  view: 'chart' | 'table';
  mode: ThemeMode;
  locale?: string;
  chart?: Chart;
  /** Chart hint known before the result: from the tool input or the tool's metadata. */
  pending?: { shape: Shape; title?: string; tiles?: number };
  /** The result (or an error) has been shown, so the placeholder is gone. */
  done: boolean;
}

const state: ViewState = {
  plan: null,
  view: 'table',
  mode: window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  done: false,
};

const root = document.getElementById('app') as HTMLElement;
document.documentElement.dataset.theme = state.mode;

/** `_meta` key on business tools; a YAML tool with a `chart:` block names its chart type here. */
const TOOL_META_KEY = 'db2i-mcp/tool';

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
  const meta = context.toolInfo?.tool?._meta?.[TOOL_META_KEY];
  if (!state.pending && meta && typeof meta === 'object' && 'chart' in meta) {
    anticipate((meta as { chart?: unknown }).chart);
  }
  render();
}

/** The placeholder shape for a chart hint: the chart box, KPI tiles, or the grid. */
function shapeOf(hint: unknown): NonNullable<ViewState['pending']> {
  if (!hint || typeof hint !== 'object' || !('type' in hint) || typeof hint.type !== 'string') {
    return { shape: 'table' };
  }
  const title = 'title' in hint && typeof hint.title === 'string' ? hint.title : undefined;
  const tiles = 'y' in hint && Array.isArray(hint.y) && hint.y.length > 0 ? Math.min(hint.y.length, 3) : 1;
  const shape: Shape = hint.type === 'table' ? 'table' : hint.type === 'kpi' ? 'kpi' : 'chart';
  return { shape, ...(title ? { title } : {}), ...(shape === 'kpi' ? { tiles } : {}) };
}

/** Redraw the placeholder for what the result will most likely look like. */
function anticipate(hint: unknown): void {
  state.pending = shapeOf(hint);
  if (!state.done) {
    loading();
  }
}

/** A next step for database errors a user can act on. */
function errorHint(text: string): string | undefined {
  if (/SQL0204|42704|not found/i.test(text)) {
    return 'A library, table or other object in the query was not found. Check the names.';
  }
  if (/SQL0206|42703/.test(text)) {
    return 'A column in the query was not found. Check the column names.';
  }
  if (/SQL055[12]|42501|not authori[sz]ed/i.test(text)) {
    return 'The IBM i user profile has no authority to an object in the query.';
  }
  if (/allowlist/i.test(text)) {
    return 'This server only reads the libraries it is set up for.';
  }
  return undefined;
}

/**
 * A result without rows: a headline, the detail, and a next step when there is one.
 * Errors are announced; the rest is a status.
 */
function message(title: string, detail?: string, options: { error?: boolean; hint?: string } = {}): void {
  state.done = true;
  state.chart?.destroy();
  state.chart = undefined;
  const block = document.createElement('div');
  block.className = options.error ? 'state error' : 'state';
  block.setAttribute('role', options.error ? 'alert' : 'status');
  const heading = document.createElement('p');
  heading.className = 'state-title';
  heading.textContent = title;
  block.append(heading);
  for (const [text, className] of [[detail, 'state-detail'], [options.hint, 'state-hint']] as const) {
    if (text) {
      const p = document.createElement('p');
      p.className = className;
      p.textContent = text;
      block.append(p);
    }
  }
  root.replaceChildren(block);
}

function failed(text: string): void {
  message('The query failed', text, { error: true, hint: errorHint(text) });
}

/** A block of placeholder text: keeps the line height of the real text it stands for. */
function boneText(className: string, width: string, tag = 'div'): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  const bone = document.createElement('span');
  bone.className = 'bone bone-text';
  bone.style.width = width;
  bone.textContent = '\u00a0';
  element.append(bone);
  return element;
}

/** The chart box with a few pulsing bars on a ruled plot. */
function chartBones(title: string | undefined): HTMLElement {
  const box = document.createElement('div');
  box.className = 'chart bone-chart';
  if (title) {
    box.append(boneText('bone-title', `${Math.min(60, 8 + title.length * 1.2)}%`));
  }
  const plot = document.createElement('div');
  plot.className = 'bone-plot';
  [46, 72, 58, 88, 64, 78, 52].forEach((height, index) => {
    const bar = document.createElement('div');
    bar.className = 'bone bone-bar';
    bar.style.height = `${height}%`;
    bar.style.setProperty('--delay', `${index * 80}ms`);
    plot.append(bar);
  });
  box.append(plot);
  return box;
}

/** KPI tiles built from the real classes, so the placeholder is exactly as tall. */
function kpiBones(title: string | undefined, tiles: number): HTMLElement[] {
  const frame = document.createElement('div');
  frame.className = 'kpis';
  const row = document.createElement('div');
  row.className = 'kpi-row';
  for (let index = 0; index < tiles; index++) {
    const tile = document.createElement('div');
    tile.className = 'kpi bone-pulse';
    // A titled single tile shows no label (see renderChart)
    if (!(title && tiles === 1)) {
      tile.append(boneText('kpi-label', '72px'));
    }
    tile.append(boneText('kpi-value', tiles === 1 ? '180px' : '70%'));
    row.append(tile);
  }
  frame.append(row);
  return title ? [boneText('', '40%', 'h2'), frame] : [frame];
}

/** The grid as rows of bars, the header row darker. */
function tableBones(): HTMLElement {
  const rows = document.createElement('div');
  rows.className = 'bone-rows';
  for (let row = 0; row < 6; row++) {
    const line = document.createElement('div');
    line.className = 'bone-row';
    line.style.setProperty('--delay', `${row * 80}ms`);
    for (let cell = 0; cell < 4; cell++) {
      const bone = document.createElement('div');
      bone.className = 'bone';
      line.append(bone);
    }
    rows.append(line);
  }
  return rows;
}

/**
 * Placeholder shown until the tool result arrives, in the shape the result
 * will most likely take, so the frame keeps its height when it lands: the
 * chart box for a chart hint, tiles for KPIs, otherwise the grid.
 */
function loading(): void {
  const { shape, title, tiles } = state.pending ?? { shape: 'table' as Shape };
  const frame = document.createElement('div');
  frame.className = `loading loading-${shape}`;
  frame.setAttribute('role', 'status');
  const label = document.createElement('span');
  label.className = 'sr-only';
  label.textContent = 'Waiting for the result\u2026';
  const tabs = document.createElement('div');
  tabs.className = 'bone bone-tabs';
  const body = shape === 'chart' ? [chartBones(title)] : shape === 'kpi' ? kpiBones(title, tiles ?? 1) : [tableBones()];
  frame.append(label, tabs, ...body);
  root.replaceChildren(frame);
}

const VIEWS = ['chart', 'table'] as const;

/** Switch between chart and grid, and keep focus on the tab that is now selected. */
function selectView(view: ViewState['view']): void {
  state.view = view;
  render(`tab-${view}`);
}

function toolbar(table: ResultTable): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'toolbar';
  const tabs = document.createElement('div');
  tabs.className = 'tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Result view');
  const enabled = VIEWS.filter((view) => view === 'table' || state.plan);
  for (const view of VIEWS) {
    const button = document.createElement('button');
    const selected = state.view === view;
    button.type = 'button';
    button.id = `tab-${view}`;
    button.dataset.focus = `tab-${view}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(selected));
    button.setAttribute('aria-controls', 'panel');
    button.tabIndex = selected ? 0 : -1;
    button.textContent = view === 'chart' ? 'Chart' : 'Table';
    if (!enabled.includes(view)) {
      // aria-disabled rather than disabled: a disabled button shows no tooltip, and this one says why
      button.setAttribute('aria-disabled', 'true');
      button.title = 'No chart: these rows have no numbers to plot';
    }
    button.addEventListener('click', () => {
      if (enabled.includes(view)) {
        selectView(view);
      }
    });
    tabs.append(button);
  }
  // Arrow keys move between the tabs, as in any tab list
  tabs.addEventListener('keydown', (event) => {
    const at = enabled.indexOf(state.view);
    const next = event.key === 'ArrowRight' ? enabled[(at + 1) % enabled.length]
      : event.key === 'ArrowLeft' ? enabled[(at - 1 + enabled.length) % enabled.length]
        : event.key === 'Home' ? enabled[0]
          : event.key === 'End' ? enabled[enabled.length - 1] : undefined;
    if (next) {
      event.preventDefault();
      selectView(next);
    }
  });
  bar.append(tabs);

  const types = state.plan ? availableTypes(table, state.plan) : [];
  if (state.view === 'chart' && state.plan && types.length > 1) {
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Chart type');
    select.dataset.focus = 'chart-type';
    for (const type of types) {
      const option = document.createElement('option');
      option.value = type;
      option.textContent = TYPE_LABELS[type];
      option.selected = type === state.plan.type;
      select.append(option);
    }
    select.addEventListener('change', () => {
      state.plan = replanFor(table, select.value as ChartPlan['type']);
      render('chart-type');
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
    const frame = document.createElement('div');
    frame.className = 'kpis';
    const tiles = document.createElement('div');
    tiles.className = 'kpi-row';
    frame.append(tiles);
    if (built.title) {
      const title = document.createElement('h2');
      title.textContent = built.title;
      container.append(title);
    }
    // One tile under a title: the title already says what the number is
    const labelled = !(built.title && built.items.length === 1);
    for (const item of built.items) {
      const tile = document.createElement('div');
      tile.className = 'kpi';
      if (labelled) {
        const label = document.createElement('div');
        label.className = 'kpi-label';
        label.textContent = item.label;
        tile.append(label);
      } else {
        tile.title = item.label;
      }
      const value = document.createElement('div');
      value.className = 'kpi-value';
      value.textContent = item.value;
      tile.append(value);
      tiles.append(tile);
    }
    container.append(frame);
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

/**
 * Draw the result. The toolbar is rebuilt, so the control that had focus
 * gets it back.
 *
 * @param focus - Control to focus afterwards; defaults to the one focused now
 */
function render(focus?: string): void {
  const table = state.table;
  if (!table) {
    return;
  }
  const active = document.activeElement;
  const restore = focus ?? (active instanceof HTMLElement && root.contains(active) ? active.dataset.focus : undefined);
  state.chart?.destroy();
  state.chart = undefined;
  const bar = toolbar(table);
  const content = document.createElement('div');
  content.className = 'content';
  content.id = 'panel';
  content.setAttribute('role', 'tabpanel');
  content.setAttribute('aria-labelledby', `tab-${state.view}`);
  if (state.view === 'chart' && state.plan) {
    renderChart(content, table, state.plan);
  } else {
    renderGrid(content, table, bar, { locale: state.locale });
  }
  const notes = document.createElement('div');
  notes.className = 'notes';
  for (const warning of table.warnings) {
    const p = document.createElement('p');
    p.textContent = warning;
    notes.append(p);
  }
  root.replaceChildren(bar, content, ...(table.warnings.length > 0 ? [notes] : []));
  if (restore) {
    root.querySelector<HTMLElement>(`[data-focus="${restore}"]`)?.focus();
  }
}

function showResult(structured: unknown, text: string | undefined, isError = false): void {
  state.done = true;
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
    if (isError) {
      failed(text ?? 'The tool reported an error.');
    } else {
      message('Nothing to show here', text ?? 'This result has no rows.');
    }
    return;
  }
  if ('error' in read) {
    failed(read.error);
    return;
  }
  if (read.rows.length === 0) {
    message('No rows matched', 'The query ran and returned no rows.', { hint: 'Ask again with a wider filter or date range.' });
    return;
  }
  const selection = selectChart(read);
  state.table = read;
  state.plan = selection.plan;
  state.view = selection.showChart ? 'chart' : 'table';
  render();
}

/** Hold size reports until the placeholder has its shape, so the host resizes once. */
let holdSize = true;
let reportSize: () => void = () => undefined;

function releaseSize(): void {
  if (holdSize) {
    holdSize = false;
    reportSize();
  }
}

/** The longest the first size report waits for the tool input. */
const SHAPE_WAIT_MS = 300;

function watchSize(bridge: Bridge): void {
  let last = 0;
  // The page's scrollHeight never drops below the frame, so measure the content to let the frame shrink
  reportSize = (): void => {
    if (holdSize) {
      return;
    }
    const height = Math.ceil(root.getBoundingClientRect().height);
    if (Math.abs(height - last) > 1) {
      last = height;
      bridge.sizeChanged(height);
    }
  };
  new ResizeObserver(() => reportSize()).observe(root);
  // The host sends the tool input right after the handshake; report then, or soon without it
  if (state.pending || state.done) {
    releaseSize();
  } else {
    setTimeout(releaseSize, SHAPE_WAIT_MS);
  }
}

loading();

connect(window.parent, { name: 'db2i-result-view', version: __APP_VERSION__ }, {
  onToolInput: (params) => {
    if (!state.pending) {
      anticipate(params.arguments?.chart);
    }
    releaseSize();
  },
  onToolResult: (result) => {
    const first = result.content?.find((item) => item.type === 'text');
    showResult(result.structuredContent, first && 'text' in first ? first.text : undefined, result.isError === true);
    releaseSize();
  },
  onHostContext: applyHostContext,
}).then(watchSize, (error: unknown) => {
  message('The result view could not start', error instanceof Error ? error.message : 'It could not connect to the host.', { error: true });
});
