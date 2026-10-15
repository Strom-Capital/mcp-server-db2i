import type { Row } from './results';

export type ColumnKind = 'number' | 'date' | 'boolean' | 'text' | 'empty';

export interface ColumnInfo {
  name: string;
  kind: ColumnKind;
  /** Whether numbers get thousands separators. Off for keys, codes and numeric dates. */
  group: boolean;
}

/** A decimal written as text. Drivers return DECIMAL and BIGINT this way when a double would round them. */
const NUMERIC_TEXT = /^-?\d+(\.\d+)?$/;
/** Names of numeric columns that hold keys, codes or dates such as 20261015, which read wrong as 20,261,015. */
const UNGROUPED_NAME = /(NO|NR|NUM|NUMBER|ID|CODE|CD|KEY|YEAR|YR|DATE|DAT|DT|TIME|TIM)\d*$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}[.:]\d{2}([.:]\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Whether a value is a number, or a decimal written as text.
 *
 * @param value - A cell value
 * @returns True for numbers and numeric strings
 */
export function isNumeric(value: unknown): boolean {
  return (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && NUMERIC_TEXT.test(value.trim()));
}

function kindOf(value: unknown): ColumnKind {
  if (value === null || value === undefined || value === '') {
    return 'empty';
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (isNumeric(value)) {
    return 'number';
  }
  if (typeof value === 'string' && ISO_DATE.test(value.trim())) {
    return 'date';
  }
  return 'text';
}

/**
 * Column names in row order, with the kind every non-empty value shares.
 * A column with mixed kinds is text.
 *
 * @param rows - Result rows
 * @returns One entry per column
 */
export function inferColumns(rows: Row[]): ColumnInfo[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const name of Object.keys(row)) {
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
  }
  return names.map((name) => {
    let kind: ColumnKind = 'empty';
    for (const row of rows) {
      const next = kindOf(row[name]);
      if (next === 'empty') {
        continue;
      }
      if (kind === 'empty') {
        kind = next;
      } else if (kind !== next) {
        kind = 'text';
        break;
      }
    }
    return { name, kind, group: kind === 'number' && !UNGROUPED_NAME.test(name) };
  });
}

/**
 * Group the integer digits of a decimal string without converting it to a
 * double, so DECIMAL(31) values keep every digit.
 *
 * @param text - A numeric string such as `-1234567.50`
 * @param separator - Thousands separator
 * @returns The grouped text, such as `-1,234,567.50`
 */
export function groupDigits(text: string, separator = ','): string {
  const trimmed = text.trim();
  const negative = trimmed.startsWith('-');
  const [whole = '', fraction] = (negative ? trimmed.slice(1) : trimmed).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
  return `${negative ? '-' : ''}${grouped}${fraction !== undefined ? `.${fraction}` : ''}`;
}

/**
 * Text for a cell. Numbers get thousands separators and keep their digits,
 * dates stay as Db2 returned them, and objects are shown as JSON.
 *
 * @param value - A cell value
 * @param kind - The column's kind
 * @param group - Whether to add thousands separators to numbers
 * @returns Display text; empty for null
 */
export function formatCell(value: unknown, kind: ColumnKind, group = true): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (kind === 'number' && group && isNumeric(value)) {
    return groupDigits(typeof value === 'number' ? String(value) : value as string);
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * A grouped count with a singular or plural noun.
 *
 * @param count - How many
 * @param noun - Singular noun, such as `row`
 * @returns Text such as `1 row` or `12,500 rows`
 */
export function countOf(count: number, noun: string): string {
  return `${groupDigits(String(count))} ${count === 1 ? noun : `${noun}s`}`;
}

/**
 * Time until an expiry, in words, for a clock that ticks every 15 seconds.
 *
 * @param expiresAt - ISO timestamp
 * @param now - Epoch milliseconds
 * @returns Text such as `in 8 min`, or `expired`
 */
export function timeLeft(expiresAt: string, now: number): string {
  const ms = Date.parse(expiresAt) - now;
  if (Number.isNaN(ms) || ms <= 0) {
    return 'expired';
  }
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return 'in less than a minute';
  }
  if (minutes < 120) {
    return `in ${minutes} min`;
  }
  return `in ${Math.floor(minutes / 60)} h`;
}

/**
 * Order two cell values. Nulls sort last; numbers compare as numbers, even
 * when written as text.
 *
 * @param a - First value
 * @param b - Second value
 * @param kind - The column's kind
 * @returns Negative, zero or positive
 */
export function compareCells(a: unknown, b: unknown, kind: ColumnKind): number {
  const aEmpty = a === null || a === undefined;
  const bEmpty = b === null || b === undefined;
  if (aEmpty || bEmpty) {
    return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
  }
  if (kind === 'number') {
    return Number(a) - Number(b);
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function rawText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/**
 * Rows as tab-separated text with a header line, for pasting into Excel.
 * Tabs and line breaks inside values become spaces.
 *
 * @param columns - Column names
 * @param rows - Rows
 * @returns TSV text
 */
export function toTsv(columns: string[], rows: Row[]): string {
  const clean = (value: unknown) => rawText(value).replace(/[\t\r\n]+/g, ' ');
  return [columns.map(clean).join('\t'), ...rows.map((row) => columns.map((column) => clean(row[column])).join('\t'))].join('\n');
}

/**
 * One CSV field. Text that a spreadsheet would run as a formula gets a
 * leading apostrophe; numbers, negative ones included, are left alone.
 *
 * @param value - A cell value
 * @returns The quoted field
 */
export function csvField(value: unknown): string {
  let text = rawText(value);
  if (/^[=+\-@\t\r]/.test(text) && !isNumeric(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Rows as CSV (RFC 4180) with a header line.
 *
 * @param columns - Column names
 * @param rows - Rows
 * @returns CSV text with CRLF line ends
 */
export function toCsv(columns: string[], rows: Row[]): string {
  return [columns.map(csvField).join(','), ...rows.map((row) => columns.map((column) => csvField(row[column])).join(','))].join('\r\n');
}
