/**
 * Chart colors and type, from the brand tokens in site/src/styles/tokens.css.
 * One accent: a single series is always the accent, and comparisons set the
 * accent against neutral. Six categorical colors, then a neutral "Other".
 * Each color is at least 3:1 against the surface it is drawn on.
 */

export type ThemeMode = 'light' | 'dark';

export interface Theme {
  mode: ThemeMode;
  surface: string;
  ink: string;
  muted: string;
  line: string;
  accent: string;
  /** Rises in a waterfall; the change arrow on a KPI. */
  up: string;
  /** Falls in a waterfall; the change arrow on a KPI. */
  down: string;
  /** Start and end bars in a waterfall. */
  total: string;
  series: readonly string[];
  other: string;
  /** Ordered buckets, most prominent first. */
  ramp: readonly string[];
}

const light: Theme = {
  mode: 'light',
  surface: '#faf9f6',
  ink: '#161716',
  muted: '#666962',
  line: '#d8d6cf',
  accent: '#3159e8',
  up: '#2a8576',
  down: '#c4583f',
  total: '#3a3d37',
  series: ['#3159e8', '#a8761c', '#2a8576', '#c4583f', '#3a3d37', '#8a5fb8'],
  other: '#bdb8ab',
  ramp: ['#1d3797', '#3159e8', '#6f8cf0', '#a9bbf6', '#d6defb'],
};

const dark: Theme = {
  mode: 'dark',
  surface: '#181918',
  ink: '#ecebe4',
  muted: '#9c9e97',
  line: '#2e302d',
  accent: '#7d97ff',
  up: '#3f9e8f',
  down: '#ec8468',
  total: '#d9d8d0',
  series: ['#7d97ff', '#e0b05a', '#3f9e8f', '#ec8468', '#d9d8d0', '#bb9ae6'],
  other: '#4c4e49',
  ramp: ['#c3cfff', '#7d97ff', '#5674e6', '#3a54b8', '#27397a'],
};

export function themeFor(mode: ThemeMode): Theme {
  return mode === 'dark' ? dark : light;
}

/** Most series a chart colors on its own. More fold into "Other". */
export const MAX_SERIES = 4;

/** Font families for canvas text, read from the page because canvas cannot resolve CSS variables. */
export interface Fonts {
  sans: string;
  mono: string;
}

export const fallbackFonts: Fonts = {
  sans: "'Geist Variable', Geist, system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
};

/** Series color by position: the palette, then "Other". */
export function seriesColor(theme: Theme, index: number): string {
  return theme.series[index] ?? theme.other;
}

/** A hex color with an alpha channel, for flat area fills. */
export function withAlpha(hex: string, alpha: number): string {
  return hex + Math.round(alpha * 255).toString(16).padStart(2, '0');
}
