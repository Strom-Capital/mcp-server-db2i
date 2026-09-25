/**
 * Index advice for index_advice, read from QSYS2.SYSIXADV.
 *
 * The advisor keeps one row per reason code and variant, so the same key
 * columns can appear several times. Rows are grouped by table, key columns,
 * and index type, and ranked by how often the optimizer used a maintained
 * temporary index (MTI) for them.
 */

import { executeQuery } from './connection.js';
import type { DbTarget } from '../systems.js';

/**
 * Reason codes from the IBM database monitor view 3020 (Index advised, SQE),
 * which SYSIXADV stores in REASON_ADVISED.
 */
export const INDEX_ADVICE_REASONS: Readonly<Record<string, string>> = {
  I1: 'Row selection',
  I2: 'Ordering or grouping',
  I3: 'Row selection and ordering or grouping',
  I5: 'Row selection using bitmap processing',
  I6: 'Source of statistics',
  I8: 'Encoded vector index only column projection',
};

export interface IndexAdviceReason {
  code: string;
  /** Null for a code IBM does not document. */
  description: string | null;
}

export interface IndexAdviceRow {
  schema: string;
  table: string;
  key_columns: string[];
  index_type: string;
  times_advised: number;
  mti_used: number;
  mti_created: number;
  last_advised: string | null;
  last_mti_used: string | null;
  reasons: IndexAdviceReason[];
  rows_merged: number;
}

export interface IndexAdviceQuery {
  schema: string;
  table?: string;
  /** Db2 timestamp text, as returned by parseSince. */
  since?: string;
  limit: number;
  target?: DbTarget;
}

const SINCE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?$/;

/**
 * Check a since value and turn it into Db2 timestamp text.
 * SYSIXADV stores the system's local time with no time zone, so a value with
 * a zone or offset is rejected instead of being shifted.
 */
export function parseSince(value: string): string {
  const match = SINCE_PATTERN.exec(value.trim());
  if (!match) {
    throw new Error(
      `since must be a date or timestamp such as 2026-01-31 or 2026-01-31 08:00:00, in the IBM i system's local time with no time zone. Got "${value}".`
    );
  }
  const [, year, month, day, hour = '00', minute = '00', second = '00', fraction = ''] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  const valid =
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day) &&
    date.getUTCHours() === Number(hour) &&
    date.getUTCMinutes() === Number(minute) &&
    date.getUTCSeconds() === Number(second);
  if (!valid) {
    throw new Error(`since is not a valid date or time: "${value}".`);
  }
  return `${year}-${month}-${day} ${hour}:${minute}:${second}.${fraction.padEnd(6, '0')}`;
}

/**
 * Split KEY_COLUMNS_ADVISED into keys. The advisor joins keys with ", " and
 * may add DESC or ASC after a name. Quoted names can hold commas and spaces.
 */
export function splitKeyColumns(value: string): string[] {
  const keys: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '"') {
      if (quoted && value[i + 1] === '"') {
        current += '""';
        i++;
        continue;
      }
      quoted = !quoted;
      current += char;
    } else if (char === ',' && !quoted) {
      keys.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  keys.push(current.trim());
  return keys.filter((key) => key.length > 0);
}

/** Merged rows can repeat a code, so the list is deduplicated here. */
function reasonsOf(value: unknown): IndexAdviceReason[] {
  if (value == null) {
    return [];
  }
  return [...new Set(String(value).split(',').map((code) => code.trim().toUpperCase()).filter((code) => code.length > 0))]
    .sort()
    .map((code) => ({ code, description: INDEX_ADVICE_REASONS[code] ?? null }));
}

function count(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function textOrNull(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

/**
 * Grouped index advice for one library, and optionally one table, ranked by
 * MTI use and then times advised. Only rows of that library are read.
 */
export async function listIndexAdvice(query: IndexAdviceQuery): Promise<{ rows: IndexAdviceRow[]; truncated: boolean }> {
  const fetch = query.limit + 1;
  if (!Number.isSafeInteger(fetch) || fetch < 2) {
    throw new Error('Limit must be a positive integer.');
  }

  const schema = query.schema.trim().toUpperCase();
  const where = ['(TABLE_SCHEMA = ? OR SYSTEM_TABLE_SCHEMA = ?)'];
  const params: unknown[] = [schema, schema];
  if (query.table?.trim()) {
    const table = query.table.trim().toUpperCase();
    where.push('(TABLE_NAME = ? OR SYSTEM_TABLE_NAME = ?)');
    params.push(table, table);
  }
  if (query.since) {
    where.push('LAST_ADVISED >= CAST(? AS TIMESTAMP)');
    params.push(query.since);
  }

  const sql = `
    SELECT TABLE_SCHEMA, TABLE_NAME, KEY_COLUMNS_ADVISED, INDEX_TYPE,
           SUM(TIMES_ADVISED) AS TIMES_ADVISED,
           SUM(MTI_USED) AS MTI_USED,
           SUM(MTI_CREATED) AS MTI_CREATED,
           MAX(LAST_ADVISED) AS LAST_ADVISED,
           MAX(LAST_MTI_USED) AS LAST_MTI_USED,
           LISTAGG(REASON_ADVISED, ',') WITHIN GROUP (ORDER BY REASON_ADVISED) AS REASONS,
           COUNT(*) AS ROWS_MERGED
    FROM QSYS2.SYSIXADV
    WHERE ${where.join(' AND ')}
    GROUP BY TABLE_SCHEMA, TABLE_NAME, KEY_COLUMNS_ADVISED, INDEX_TYPE
    ORDER BY MTI_USED DESC, TIMES_ADVISED DESC, TABLE_NAME, KEY_COLUMNS_ADVISED
    FETCH FIRST ${fetch} ROWS ONLY
  `;

  const result = await executeQuery(sql, params, query.target);
  const rows = result.rows.map((row): IndexAdviceRow => ({
    schema: textOrNull(row.TABLE_SCHEMA) ?? '',
    table: textOrNull(row.TABLE_NAME) ?? '',
    key_columns: splitKeyColumns(String(row.KEY_COLUMNS_ADVISED ?? '')),
    index_type: textOrNull(row.INDEX_TYPE)?.toUpperCase() ?? '',
    times_advised: count(row.TIMES_ADVISED),
    mti_used: count(row.MTI_USED),
    mti_created: count(row.MTI_CREATED),
    last_advised: textOrNull(row.LAST_ADVISED),
    last_mti_used: textOrNull(row.LAST_MTI_USED),
    reasons: reasonsOf(row.REASONS),
    rows_merged: count(row.ROWS_MERGED),
  }));

  if (rows.length > query.limit) {
    return { rows: rows.slice(0, query.limit), truncated: true };
  }
  return { rows, truncated: false };
}
