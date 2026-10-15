/** A result row as the server returns it. */
export type Row = Record<string, unknown>;

/** Why a tool call failed, with the Db2 details when there are any. */
export interface ToolError {
  message: string;
  sqlstate?: string;
  sqlcode?: number;
  cause?: string;
  recovery?: string;
  violations?: string[];
}

/** A file written by export_query. */
export interface ExportFile {
  url: string;
  filename: string;
  format?: string;
  rowCount?: number;
  bytes?: number;
  expiresAt?: string;
  downloadsAllowed?: number;
  truncated?: false | 'rows' | 'bytes';
}

/** What the UI needs from one tool result. */
export interface ToolResultView {
  ok: boolean;
  error?: ToolError;
  rows?: Row[];
  rowCount?: number;
  truncated: boolean;
  limitApplied?: number;
  warnings: string[];
  exportFile?: ExportFile;
  /** Text content, when there is no structured result to show. */
  text?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRowArray(value: unknown): value is Row[] {
  return Array.isArray(value) && value.length > 0 && value.every(isRecord);
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function textContent(output: Record<string, unknown>): string | undefined {
  const content = output.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const texts = content
    .filter((item): item is { type: 'text'; text: string } => isRecord(item) && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text);
  return texts.length > 0 ? texts.join('\n') : undefined;
}

function structuredOf(output: Record<string, unknown>, text: string | undefined): Record<string, unknown> | undefined {
  if (isRecord(output.structuredContent)) {
    return output.structuredContent;
  }
  if (text?.trimStart().startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(text);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function rowsOf(structured: Record<string, unknown>): Row[] | undefined {
  if (isRowArray(structured.data)) {
    return structured.data;
  }
  if (Array.isArray(structured.data) && structured.data.length === 0) {
    return [];
  }
  for (const value of Object.values(structured)) {
    if (isRowArray(value)) {
      return value;
    }
  }
  return undefined;
}

function exportOf(structured: Record<string, unknown>): ExportFile | undefined {
  const url = stringOf(structured.url);
  const filename = stringOf(structured.filename);
  if (!url || !filename) {
    return undefined;
  }
  return {
    url,
    filename,
    format: stringOf(structured.format),
    rowCount: typeof structured.rowCount === 'number' ? structured.rowCount : undefined,
    bytes: typeof structured.bytes === 'number' ? structured.bytes : undefined,
    expiresAt: stringOf(structured.expiresAt),
    downloadsAllowed: typeof structured.downloadsAllowed === 'number' ? structured.downloadsAllowed : undefined,
    truncated: structured.truncated === 'rows' || structured.truncated === 'bytes' ? structured.truncated : false,
  };
}

/**
 * Read an MCP tool result (`CallToolResult`) into what the UI shows: rows for
 * a table, an export file, an error with Db2 details, or plain text.
 *
 * @param output - The tool output from a chat message part or a direct run
 * @returns The view; `ok` is false for tool errors and for `success: false`
 */
export function readToolResult(output: unknown): ToolResultView {
  if (!isRecord(output)) {
    return { ok: output !== undefined, truncated: false, warnings: [], text: output === undefined ? undefined : String(output) };
  }
  const text = textContent(output);
  const structured = structuredOf(output, text);
  const failed = output.isError === true || structured?.success === false;

  if (!structured) {
    return {
      ok: !failed,
      truncated: false,
      warnings: [],
      text,
      ...(failed ? { error: { message: text ?? 'The tool failed.' } } : {}),
    };
  }

  const warnings = Array.isArray(structured.warnings)
    ? structured.warnings.filter((warning): warning is string => typeof warning === 'string')
    : [];
  const view: ToolResultView = {
    ok: !failed,
    truncated: structured.truncated === true || structured.truncated === 'rows' || structured.truncated === 'bytes',
    warnings,
  };

  if (failed) {
    view.error = {
      message: stringOf(structured.error) ?? text ?? 'The tool failed.',
      sqlstate: stringOf(structured.sqlstate),
      sqlcode: typeof structured.sqlcode === 'number' ? structured.sqlcode : undefined,
      cause: stringOf(structured.cause),
      recovery: stringOf(structured.recovery),
      violations: Array.isArray(structured.violations)
        ? structured.violations.filter((item): item is string => typeof item === 'string')
        : undefined,
    };
    return view;
  }

  view.exportFile = exportOf(structured);
  const rows = view.exportFile && isRowArray(structured.sample) ? structured.sample : rowsOf(structured);
  if (rows) {
    view.rows = rows;
  } else {
    view.text = text;
  }
  if (typeof structured.rowCount === 'number') {
    view.rowCount = structured.rowCount;
  } else if (typeof structured.count === 'number') {
    view.rowCount = structured.count;
  } else if (rows) {
    view.rowCount = rows.length;
  }
  if (typeof structured.limitApplied === 'number') {
    view.limitApplied = structured.limitApplied;
  }
  return view;
}

/**
 * The SQL a tool call ran, for tools that take a `sql` argument.
 *
 * @param input - Tool input
 * @returns The SQL text, or undefined
 */
export function sqlOf(input: unknown): string | undefined {
  return isRecord(input) && typeof input.sql === 'string' ? input.sql : undefined;
}

/** SQL and parameters that export_query can run again to get every row. */
export interface ExportSource {
  sql: string;
  params?: unknown[];
}

/**
 * The query behind a result, when export_query can run it. Only execute_query
 * results qualify: a business SQL tool's call holds its arguments, not its SQL.
 *
 * @param tool - Name of the tool that returned the result
 * @param input - Its arguments
 * @returns The SQL and parameters, or undefined
 */
export function exportSourceOf(tool: string | undefined, input: unknown): ExportSource | undefined {
  const sql = tool === 'execute_query' ? sqlOf(input)?.trim() : undefined;
  if (!sql || !isRecord(input)) {
    return undefined;
  }
  return Array.isArray(input.params) && input.params.length > 0 ? { sql, params: input.params } : { sql };
}

/**
 * Tool arguments other than SQL and the audit-only `context`, for display.
 *
 * @param input - Tool input
 * @returns The remaining arguments
 */
export function argumentsOf(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) {
    return {};
  }
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key !== 'sql' && key !== 'context' && value !== undefined) {
      rest[key] = value;
    }
  }
  return rest;
}
