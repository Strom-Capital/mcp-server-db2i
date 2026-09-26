/**
 * CSV export writer: UTF-8 with a byte order mark, so Excel reads accented
 * characters correctly, RFC 4180 quoting, and CRLF line ends.
 */

import type { ExportColumn, ExportWriter } from './writer.js';
import { FileSink } from './writer.js';

const BOM = '﻿';

/**
 * Text that a spreadsheet would read as a formula when the CSV is opened:
 * `=`, `+`, `-`, `@`, tab, carriage return, line feed, or a full-width `＝`.
 */
const FORMULA_START = /^[=+\-@\t\r\n＝]/;

const NEEDS_QUOTES = /[",\r\n]/;

/**
 * Prefix `'` to text that would start a formula. Applies to text columns only:
 * a negative number or an exact decimal written as text is left alone.
 */
export function guardFormula(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

function quote(text: string): string {
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One field as CSV text. Null is an empty field. */
export function csvField(value: unknown, column: ExportColumn): string {
  if (value === null || value === undefined) {
    return '';
  }
  const text = typeof value === 'string' ? value : String(value);
  const isText = column.masked || column.kind === 'string' || column.kind === 'other';
  return quote(isText ? guardFormula(text) : text);
}

export class CsvWriter implements ExportWriter {
  private readonly sink: FileSink;
  private columns: readonly ExportColumn[] = [];

  constructor(path: string) {
    this.sink = new FileSink(path);
  }

  get bytes(): number {
    return this.sink.bytes;
  }

  get rawBytes(): number {
    return this.sink.bytes;
  }

  async writeHeader(columns: readonly ExportColumn[]): Promise<void> {
    this.columns = columns;
    const header = columns.map((column) => quote(guardFormula(column.name))).join(',');
    await this.sink.write(`${BOM}${header}\r\n`);
  }

  async writeRows(rows: readonly unknown[][]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    const lines = rows.map((row) => this.columns.map((column, index) => csvField(row[index], column)).join(','));
    await this.sink.write(`${lines.join('\r\n')}\r\n`);
  }

  async finish(): Promise<void> {
    await this.sink.end();
  }

  async abort(): Promise<void> {
    await this.sink.destroy();
  }
}
