/**
 * The tool result as the view uses it: rows, and each column's role.
 *
 * A column's kind comes from the driver. Its role decides how it is charted:
 * a measure is a number to plot, time orders an axis, and a category labels
 * one. IBM i data needs two corrections to the kind:
 * - Dates kept as numbers (DECIMAL(8,0) as YYYYMMDD, or CYYMMDD) are time.
 * - Numeric codes (order, item or customer numbers) are categories, never summed.
 */

export type ColumnKind =
  | 'int' | 'bigint' | 'decimal' | 'float' | 'string' | 'date' | 'time' | 'timestamp' | 'binary' | 'other';

export type Role = 'measure' | 'time' | 'category' | 'none';

export type ChartType =
  | 'bar' | 'line' | 'area' | 'pie' | 'doughnut' | 'scatter' | 'pareto' | 'waterfall' | 'histogram' | 'kpi' | 'table';

/** A chart hint from the model or a YAML tool, already checked against the columns by the server. */
export interface ChartHint {
  type: ChartType;
  x?: string;
  y?: string[];
  series?: string;
  stacked?: boolean;
  horizontal?: boolean;
  target?: string;
  title?: string;
}

export interface Column {
  name: string;
  kind: ColumnKind;
  role: Role;
  /** Distinct non-null values. */
  distinct: number;
}

export type Row = Record<string, unknown>;

export interface ResultTable {
  columns: Column[];
  rows: Row[];
  chart?: ChartHint;
  /** More rows matched than the result holds. */
  truncated: boolean;
  warnings: string[];
}

const NUMERIC_KINDS = new Set<ColumnKind>(['int', 'bigint', 'decimal', 'float']);
const KINDS = new Set<ColumnKind>([
  'int', 'bigint', 'decimal', 'float', 'string', 'date', 'time', 'timestamp', 'binary', 'other',
]);

const DATE_NAME = /(DATE|DAT|DTE|DT)$|^(DATE|DT)|DATE/i;
const CODE_NAME = /(NO|NBR|NUM|NR|ID|CODE|CDE|KEY)$/i;
const PERIOD_NAME = /^(YEAR|YR|YYYY|MONTH|MON|MM|PERIOD|PER|WEEK|WK|QUARTER|QTR|FISCAL_?YEAR|FY)$/i;

/** A number from a JSON value. Drivers send DECIMAL as a string on some paths. */
export function numberOf(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * A date kept as a number: YYYYMMDD between 1950 and 2100, or, when
 * `century` is set, CYYMMDD (C is 0 for 19xx and 1 for 20xx).
 *
 * @returns The date as YYYY-MM-DD, or null when the value is not one
 */
export function numericDate(value: unknown, century: boolean): string | null {
  const number = numberOf(value);
  if (number === null || !Number.isInteger(number) || number < 0) {
    return null;
  }
  if (number >= 19500101 && number <= 21001231) {
    return isoDate(Math.floor(number / 10000), Math.floor(number / 100) % 100, number % 100);
  }
  if (century && number <= 1991231) {
    const c = Math.floor(number / 1000000);
    const yy = Math.floor(number / 10000) % 100;
    return isoDate(1900 + c * 100 + yy, Math.floor(number / 100) % 100, number % 100);
  }
  return null;
}

/** True when every non-null value is a date kept as a number. */
function allNumericDates(values: unknown[], century: boolean): boolean {
  let seen = 0;
  for (const value of values) {
    if (value === null || value === undefined || value === 0 || value === '0') {
      continue;
    }
    if (numericDate(value, century) === null) {
      return false;
    }
    seen += 1;
  }
  return seen > 0;
}

/** A kind for a column the driver did not describe, from its values. */
function inferKind(values: unknown[]): ColumnKind {
  const present = values.filter((value) => value !== null && value !== undefined);
  if (present.length === 0) {
    return 'other';
  }
  if (present.every((value) => numberOf(value) !== null)) {
    return present.every((value) => Number.isInteger(numberOf(value))) ? 'int' : 'decimal';
  }
  if (present.every((value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))) {
    return 'date';
  }
  if (present.every((value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[ T-]\d{2}[:.]\d{2}/.test(value))) {
    return 'timestamp';
  }
  return 'string';
}

function roleOf(name: string, kind: ColumnKind, values: unknown[], position: number, others: number): Role {
  if (kind === 'binary' || kind === 'other') {
    return 'none';
  }
  if (kind === 'date' || kind === 'timestamp') {
    return 'time';
  }
  if (kind === 'time') {
    return 'category';
  }
  const dateName = DATE_NAME.test(name);
  if (kind === 'string') {
    return dateName && allNumericDates(values, false) ? 'time' : 'category';
  }
  if (!NUMERIC_KINDS.has(kind)) {
    return 'category';
  }
  if (allNumericDates(values, dateName)) {
    return 'time';
  }
  if (PERIOD_NAME.test(name)) {
    return 'time';
  }
  if (CODE_NAME.test(name) && !/PAID$/i.test(name)) {
    return 'category';
  }
  // A leading integer column that is unique on every row labels the rest, such as a customer number
  if (position === 0 && others > 0 && (kind === 'int' || kind === 'bigint') && values.length >= 3) {
    const distinct = new Set(values.map((value) => numberOf(value))).size;
    if (distinct === values.length) {
      return 'category';
    }
  }
  return 'measure';
}

/**
 * The time value of a cell, as a sort key and a label.
 */
export function timeOf(value: unknown, column: Column): { key: number; label: string } | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (column.kind === 'date' || column.kind === 'timestamp' || typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const text = String(value);
    const key = Date.parse(text.length > 10 ? text.slice(0, 19).replace(' ', 'T').replace(/\./g, ':') : text);
    const label = column.kind === 'timestamp' ? text.slice(0, 16).replace('T', ' ') : text.slice(0, 10);
    return Number.isNaN(key) ? { key: Number.NaN, label: text } : { key, label };
  }
  const iso = numericDate(value, DATE_NAME.test(column.name));
  if (iso) {
    return { key: Date.parse(iso), label: iso };
  }
  const number = numberOf(value);
  return number === null ? { key: Number.NaN, label: String(value) } : { key: number, label: String(value) };
}

/** The label of a cell on a category or time axis. */
export function labelOf(value: unknown, column: Column): string {
  if (value === null || value === undefined) {
    return '(null)';
  }
  if (column.role === 'time') {
    return timeOf(value, column)?.label ?? String(value);
  }
  return typeof value === 'string' ? value.trim() || '(blank)' : String(value);
}

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a tool's structured result.
 *
 * @returns The table, or the error the tool reported, or null when the result has no rows to show
 */
export function readResult(structured: unknown): ResultTable | { error: string } | null {
  if (!isRow(structured)) {
    return null;
  }
  if (structured.success === false) {
    return { error: typeof structured.error === 'string' ? structured.error : 'The tool failed.' };
  }
  const data = structured.data;
  if (!Array.isArray(data)) {
    return null;
  }
  const rows = data.filter(isRow);
  const described = Array.isArray(structured.columns)
    ? structured.columns.filter((c): c is { name: string; kind: string } => isRow(c) && typeof c.name === 'string')
    : [];
  const names = described.length > 0
    ? described.map((c) => c.name)
    : [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const kinds = new Map(described.map((c) => [c.name, KINDS.has(c.kind as ColumnKind) ? (c.kind as ColumnKind) : 'other']));

  const columns: Column[] = names.map((name, position) => {
    const values = rows.map((row) => row[name]);
    const kind = kinds.get(name) ?? inferKind(values);
    return {
      name,
      kind,
      role: roleOf(name, kind, values, position, names.length - 1),
      distinct: new Set(values.filter((v) => v !== null && v !== undefined).map((v) => String(v))).size,
    };
  });

  const chart = isRow(structured.chart) && typeof structured.chart.type === 'string'
    ? (structured.chart as unknown as ChartHint)
    : undefined;
  const warnings = Array.isArray(structured.warnings)
    ? structured.warnings.filter((w): w is string => typeof w === 'string')
    : [];
  return {
    columns,
    rows,
    ...(chart ? { chart } : {}),
    truncated: structured.truncated === true,
    warnings,
  };
}
