/**
 * Recovery hint for a query that names a column the table does not have.
 *
 * Db2 reports it as SQLCODE -206 (SQL0206, "Column or global variable not
 * found"), with SQLSTATE 42703, or 42S22 through ODBC. An assistant that
 * guessed a column name recovers with one describe_table call, so the hint
 * says which tables to describe. The tables come from parsing the statement
 * locally; no extra database call is made.
 */

import type { SqlErrorDetails } from '../db/sqlErrorInfo.js';
import { referencedTables } from '../utils/security/schemaAllowlist.js';

const UNKNOWN_COLUMN_SQLCODE = -206;
const UNKNOWN_COLUMN_SQLSTATES = new Set(['42703', '42S22']);

/** Most tables the hint names, so a large join keeps it short. */
const MAX_HINT_TABLES = 5;

/**
 * True when a failed statement named an unknown column or global variable.
 *
 * @param fields - SQLSTATE and SQLCODE of the failure
 * @param message - Error text, checked for the SQL0206 message ID when the codes are missing
 */
export function isUnknownColumnError(fields: SqlErrorDetails, message: string): boolean {
  if (fields.sqlcode === UNKNOWN_COLUMN_SQLCODE) {
    return true;
  }
  if (fields.sqlstate && UNKNOWN_COLUMN_SQLSTATES.has(fields.sqlstate.toUpperCase())) {
    return true;
  }
  return /\bSQL0206\b/.test(message);
}

/**
 * The hint for an unknown column in `sql`, naming the tables it reads when they can be parsed.
 *
 * @param sql - Statement as the caller sent it
 * @param describeTable - False when describe_table is not available to the caller, so the hint does not name it
 */
export function unknownColumnHint(sql: string, describeTable = true): string {
  const tables = referencedTables(sql).slice(0, MAX_HINT_TABLES);
  const tool = describeTable ? ' with describe_table' : '';
  const where = tables.length > 0 ? tables.join(', ') : 'the tables in the query';
  return `Check the column names${tool} for ${where} before trying again, and put text values in single quotes, not double quotes.`;
}

/**
 * Error fields with the unknown-column hint put first in `recovery`. Other errors are returned unchanged.
 *
 * @param fields - Fields from sqlErrorFields for the failure
 * @param message - Error text of the failure
 * @param sql - Statement as the caller sent it
 * @param describeTable - False when describe_table is not available to the caller
 */
export function withUnknownColumnHint(
  fields: SqlErrorDetails,
  message: string,
  sql: string,
  describeTable = true
): SqlErrorDetails {
  if (!isUnknownColumnError(fields, message)) {
    return fields;
  }
  const hint = unknownColumnHint(sql, describeTable);
  return { ...fields, recovery: fields.recovery ? `${hint} ${fields.recovery}` : hint };
}
