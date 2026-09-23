/**
 * Tool Result Formatting
 *
 * Renders tool results as the text content of an MCP tool response.
 * structuredContent is always the raw result; only the text representation varies.
 */

import type { ResponseFormat } from '../config.js';

type Row = Record<string, unknown>;

function isRowArray(value: unknown): value is Row[] {
  return (
    Array.isArray(value) &&
    value.every((row) => typeof row === 'object' && row !== null && !Array.isArray(row))
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

/**
 * Render rows as a markdown table. Columns are the union of all row keys,
 * in first-seen order, so sparse rows still line up.
 */
export function toMarkdownTable(rows: Row[]): string {
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) {
        columns.push(key);
      }
    }
  }

  if (columns.length === 0) {
    return '_No rows returned._';
  }

  const header = `| ${columns.map(formatCell).join(' | ')} |`;
  const separator = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((col) => formatCell(row[col])).join(' | ')} |`);

  return [header, separator, ...body].join('\n');
}

function toMarkdown(result: Record<string, unknown>): string {
  const { data, success: _success, ...meta } = result;

  if (!isRowArray(data)) {
    return JSON.stringify(result);
  }

  const summary = Object.entries(meta)
    .map(([key, value]) => `${key}: ${formatCell(value)}`)
    .join(', ');

  const table = toMarkdownTable(data);
  return summary ? `${summary}\n\n${table}` : table;
}

/**
 * Format a tool result as response text.
 *
 * @param result - The tool result object
 * @param format - 'json' (compact), 'pretty' (indented), or 'markdown'
 */
export function formatToolText(result: object, format: ResponseFormat): string {
  switch (format) {
    case 'pretty':
      return JSON.stringify(result, null, 2);
    case 'markdown':
      return toMarkdown(result as Record<string, unknown>);
    default:
      return JSON.stringify(result);
  }
}
