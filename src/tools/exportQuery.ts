/**
 * export_query: write a read-only query's rows to a CSV or XLSX file for the
 * user, instead of returning them to the model.
 *
 * The statement passes the same checks as execute_query. Rows are read a batch
 * at a time with a cursor, masked, and written to a file in EXPORT_DIR. Over
 * stdio the result gives the file path; over HTTP it gives a short-lived
 * download link. The model gets a summary and a few sample rows.
 */

import { getExportConfig } from '../config.js';
import { openQueryCursor } from '../db/connection.js';
import { CANCEL_GRACE_MS, type ColumnKind, type RowCursor } from '../db/driver.js';
import { sqlErrorFields, type SqlErrorDetails } from '../db/sqlErrorInfo.js';
import { maskValue, requireMaskedColumns, type MaskRule } from '../customTools/masking.js';
import { CsvWriter } from '../export/csv.js';
import { beginExport, ExportLimitError, isExportStoreReady, type ExportFormat } from '../export/store.js';
import type { ExportColumn, ExportWriter } from '../export/writer.js';
import { XLSX_MAX_ROWS, XlsxWriter } from '../export/xlsx.js';
import type { DbTarget } from '../systems.js';
import { createChildLogger } from '../utils/logger.js';
import { prepareReadQuery } from './query.js';
import { applySqlRowLimit } from './sqlLimit.js';

const log = createChildLogger({ component: 'export-tool' });

/** Rows per fetch. */
const FETCH_SIZE = 1000;

/** Rows shown to the model so it can check the export looks right. */
const SAMPLE_ROWS = 5;

/** An XLSX file is compressed; this caps the XML inside it. */
const XLSX_RAW_FACTOR = 4;

/** How the caller gets the file. */
export type ExportDelivery = 'path' | 'link';

export interface ExportQueryInput {
  sql: string;
  params?: unknown[];
  format?: ExportFormat;
  /** Download name without extension. Sanitized. */
  filename?: string;
  maxRows?: number;
  /** stdio callers get a path on this host; HTTP callers get a link. */
  delivery: ExportDelivery;
  /** Who ran the export, for the audit log. */
  owner: string;
  target?: DbTarget;
  defaultSchema?: string;
}

export type ExportQueryResult = SqlErrorDetails & {
  success: boolean;
  error?: string;
  violations?: string[];
  format?: ExportFormat;
  filename?: string;
  rowCount?: number;
  bytes?: number;
  /** Why the file ends early: the row cap or the size cap. */
  truncated?: false | 'rows' | 'bytes';
  columns?: Array<{ name: string; kind: ColumnKind }>;
  sample?: Record<string, unknown>[];
  /** stdio: the file on this host. */
  path?: string;
  /** HTTP: the download link. */
  url?: string;
  /** ISO time the file or link expires. */
  expiresAt?: string;
  singleUse?: boolean;
};

/** The export ran past EXPORT_TIMEOUT. */
class ExportTimeoutError extends Error {
  constructor(seconds: number) {
    super(
      `Export stopped after ${seconds} seconds (EXPORT_TIMEOUT). Narrow the filter, lower max_rows, or add a condition on an indexed column.`
    );
    this.name = 'ExportTimeoutError';
  }
}

/**
 * A download name: letters, digits, dot, underscore and hyphen, at most 80
 * characters, with the format's extension.
 */
export function exportFilename(requested: string | undefined, format: ExportFormat, now = new Date()): string {
  const fallback = `export-${now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}`;
  const base = (requested ?? '')
    .replace(new RegExp(`\\.${format}$`, 'i'), '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, 80);
  return `${base || fallback}.${format}`;
}

/**
 * Reject when the deadline passes. The abort that fires with the deadline
 * cancels the statement; if the driver still has not answered after the cancel
 * grace, stop waiting for it.
 */
function beforeDeadline<T>(promise: Promise<T>, signal: AbortSignal, seconds: number): Promise<T> {
  if (seconds <= 0) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    let grace: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      grace = setTimeout(() => reject(new ExportTimeoutError(seconds)), CANCEL_GRACE_MS);
      grace.unref();
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    promise.then(
      (value) => {
        clearTimeout(grace);
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) {
          reject(new ExportTimeoutError(seconds));
        } else {
          resolve(value);
        }
      },
      (error: unknown) => {
        clearTimeout(grace);
        signal.removeEventListener('abort', onAbort);
        reject(signal.aborted ? new ExportTimeoutError(seconds) : error);
      }
    );
  });
}

function duplicateName(names: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      return name;
    }
    seen.add(name);
  }
  return undefined;
}

/**
 * Run a read-only query and write its rows to an export file.
 *
 * @param input - SQL, format, delivery and the caller's target
 * @returns A summary with the path or link, or why the export failed
 */
export async function exportQueryTool(input: ExportQueryInput): Promise<ExportQueryResult> {
  const config = getExportConfig();
  if (!config || !isExportStoreReady()) {
    return { success: false, error: 'Query exports are not enabled. Set EXPORT_ENABLED=true and EXPORT_DIR.' };
  }
  if (input.delivery === 'link' && !config.publicUrl) {
    return {
      success: false,
      error: 'Export download links need MCP_PUBLIC_URL, the address users reach this server at.',
    };
  }

  const format = input.format ?? 'xlsx';
  const filename = exportFilename(input.filename, format);
  const formatCap = format === 'xlsx' ? XLSX_MAX_ROWS - 1 : Number.MAX_SAFE_INTEGER;
  const rowCap = Math.min(input.maxRows ?? config.maxRows, config.maxRows, formatCap);

  const prepared = await prepareReadQuery({ sql: input.sql, target: input.target, defaultSchema: input.defaultSchema });
  if (!prepared.ok) {
    const { ok: _ok, ...rejection } = prepared;
    return { success: false, ...rejection };
  }

  let slot;
  try {
    slot = beginExport(format);
  } catch (error) {
    if (error instanceof ExportLimitError) {
      return { success: false, error: error.message };
    }
    throw error;
  }

  const controller = new AbortController();
  const deadline =
    config.timeoutSeconds > 0 ? setTimeout(() => controller.abort(), config.timeoutSeconds * 1000) : undefined;
  deadline?.unref();
  const withinDeadline = <T>(promise: Promise<T>): Promise<T> =>
    beforeDeadline(promise, controller.signal, config.timeoutSeconds);

  let cursor: RowCursor | undefined;
  let writer: ExportWriter | undefined;
  let finished = false;
  try {
    // One row past the cap tells a full result from a cut one
    const limitedSql = applySqlRowLimit(input.sql, rowCap + 1);
    cursor = await withinDeadline(
      openQueryCursor(limitedSql, input.params ?? [], input.target, {
        fetchSize: FETCH_SIZE,
        timeoutMs: config.timeoutSeconds * 1000,
        signal: controller.signal,
      })
    );

    const names = cursor.columns.map((column) => column.name);
    const duplicate = duplicateName(names);
    if (duplicate) {
      return {
        success: false,
        error: `Column ${duplicate} appears more than once in the result. Give each column a unique name with AS.`,
      };
    }
    const maskError = requireMaskedColumns(names, prepared.maskRules);
    if (maskError) {
      return { success: false, error: maskError };
    }
    const masks: Array<MaskRule | undefined> = names.map((name) => prepared.maskRules.get(name.toUpperCase()));
    const columns: ExportColumn[] = cursor.columns.map((column, index) => ({
      name: column.name,
      kind: column.kind,
      masked: masks[index] !== undefined,
    }));

    writer = format === 'csv' ? new CsvWriter(slot.partPath) : new XlsxWriter(slot.partPath);
    await writer.writeHeader(columns);

    const sample: Record<string, unknown>[] = [];
    let rowCount = 0;
    let truncated: false | 'rows' | 'bytes' = false;
    const rawCap = format === 'xlsx' ? config.maxBytes * XLSX_RAW_FACTOR : config.maxBytes;

    for (let batch = await withinDeadline(cursor.next()); batch; batch = await withinDeadline(cursor.next())) {
      const room = rowCap - rowCount;
      if (batch.length > room) {
        batch = batch.slice(0, room);
        truncated = 'rows';
      }
      const rows = batch.map((row) =>
        row.map((value, index) => {
          const rule = masks[index];
          return rule ? maskValue(value, rule) : value;
        })
      );
      for (const row of rows) {
        if (sample.length >= SAMPLE_ROWS) break;
        sample.push(Object.fromEntries(names.map((name, index) => [name, row[index]])));
      }
      await writer.writeRows(rows);
      rowCount += rows.length;
      if (truncated) {
        break;
      }
      if (writer.bytes >= config.maxBytes || writer.rawBytes >= rawCap) {
        truncated = 'bytes';
        break;
      }
    }

    await cursor.close();
    cursor = undefined;
    await writer.finish();
    finished = true;

    const entry = await slot.complete({ filename, format, owner: input.owner, bytes: writer.bytes, rows: rowCount });
    log.info({ rows: rowCount, bytes: entry.bytes, format, truncated, delivery: input.delivery }, 'Export written');

    const result: ExportQueryResult = {
      success: true,
      format,
      filename,
      rowCount,
      bytes: entry.bytes,
      truncated,
      columns: columns.map((column) => ({ name: column.name, kind: column.kind })),
      sample,
      expiresAt: new Date(entry.expiresAt).toISOString(),
    };
    if (input.delivery === 'link') {
      result.url = `${config.publicUrl}/exports/${entry.id}`;
      result.singleUse = config.singleUse;
    } else {
      result.path = entry.path;
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    log.debug({ err: error }, 'Export failed');
    return { success: false, error: message, ...sqlErrorFields(error) };
  } finally {
    clearTimeout(deadline);
    await cursor?.close();
    if (writer && !finished) {
      await writer.abort();
    }
    await slot.release();
  }
}
