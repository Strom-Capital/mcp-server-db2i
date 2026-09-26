/**
 * Column kinds and value normalization for row cursors.
 *
 * The three drivers report types and values differently: JT400 hands every
 * value over as text, ODBC returns BIGINT as a bigint, and dates arrive in
 * Db2's or ISO format depending on the driver. A cursor maps each column to a
 * ColumnKind and each value to one shape, so file writers see the same rows
 * whichever driver read them.
 */

import type { ColumnKind, DbColumn } from './driver.js';

/** Digits a JavaScript number holds exactly. Wider decimals stay text. */
const MAX_EXACT_DIGITS = 15;

const INTEGER_TEXT = /^[+-]?\d+$/;
const DECIMAL_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)(E[+-]?\d+)?$/i;
const TIMESTAMP_TEXT = /^(\d{4}-\d{2}-\d{2})[-T ](\d{2})[.:](\d{2})[.:](\d{2})(?:[.,](\d{1,12}))?$/;
const TIME_TEXT = /^(\d{2})[.:](\d{2})[.:](\d{2})$/;

/**
 * The kind of a column from its Db2 or JDBC type name, such as DECIMAL,
 * CHAR () FOR BIT DATA, or TIMESTAMP(6).
 */
export function kindFromTypeName(typeName: string): ColumnKind {
  const name = typeName.trim().toUpperCase();
  if (name.includes('FOR BIT DATA')) {
    return 'binary';
  }
  const base = name.replace(/\s*\(.*$/, '');
  switch (base) {
    case 'BIGINT':
      return 'bigint';
    case 'INTEGER':
    case 'INT':
    case 'SMALLINT':
    case 'TINYINT':
      return 'int';
    case 'DECIMAL':
    case 'NUMERIC':
    case 'DECFLOAT':
      return 'decimal';
    case 'REAL':
    case 'DOUBLE':
    case 'FLOAT':
      return 'float';
    case 'DATE':
      return 'date';
    case 'TIME':
      return 'time';
    case 'TIMESTAMP':
      return 'timestamp';
    case 'BINARY':
    case 'VARBINARY':
    case 'BLOB':
    case 'ROWID':
      return 'binary';
    case 'CHAR':
    case 'CHARACTER':
    case 'VARCHAR':
    case 'LONG VARCHAR':
    case 'CLOB':
    case 'GRAPHIC':
    case 'VARGRAPHIC':
    case 'LONG VARGRAPHIC':
    case 'DBCLOB':
    case 'NCHAR':
    case 'NVARCHAR':
    case 'NCLOB':
    case 'XML':
    case 'DATALINK':
      return 'string';
    default:
      return 'other';
  }
}

/** ODBC SQL type codes, including IBM i Access extensions. */
const ODBC_KINDS = new Map<number, ColumnKind>([
  [-5, 'bigint'],
  [4, 'int'],
  [5, 'int'],
  [-6, 'int'],
  [2, 'decimal'],
  [3, 'decimal'],
  [-360, 'decimal'],
  [6, 'float'],
  [7, 'float'],
  [8, 'float'],
  [91, 'date'],
  [92, 'time'],
  [93, 'timestamp'],
  [-2, 'binary'],
  [-3, 'binary'],
  [-4, 'binary'],
  [-98, 'binary'],
  [1, 'string'],
  [12, 'string'],
  [-1, 'string'],
  [-8, 'string'],
  [-9, 'string'],
  [-10, 'string'],
  [-95, 'string'],
  [-96, 'string'],
  [-99, 'string'],
  [-350, 'string'],
  [-370, 'string'],
]);

/**
 * The kind of an ODBC column: from its type name when that is known, else from
 * the SQL type code.
 */
export function kindFromOdbcType(dataType: number, dataTypeName?: string): ColumnKind {
  const byName = dataTypeName ? kindFromTypeName(dataTypeName) : 'other';
  if (byName !== 'other') {
    return byName;
  }
  return ODBC_KINDS.get(dataType) ?? 'other';
}

/** CHAR and GRAPHIC pad to their length; the padding is not data. */
function isFixedLength(column: DbColumn): boolean {
  const name = column.dbType.trim().toUpperCase();
  return /^(CHAR|CHARACTER|GRAPHIC|NCHAR)\b/.test(name) && !name.includes('FOR BIT DATA');
}

function hex(value: Uint8Array): string {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex').toUpperCase();
}

function integerValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (INTEGER_TEXT.test(text)) {
      const number = Number(text);
      return Number.isSafeInteger(number) ? number : text.replace(/^\+/, '');
    }
    return text;
  }
  return value;
}

function decimalValue(value: unknown, column: DbColumn): unknown {
  const exact = column.dbType.toUpperCase().startsWith('DECFLOAT')
    ? false
    : (column.precision ?? 0) <= MAX_EXACT_DIGITS;
  if (typeof value === 'bigint') {
    return integerValue(value);
  }
  if (typeof value === 'number') {
    // A driver that hands over a wide decimal as a number has already rounded
    // it; text would only make the rounded value look exact
    return value;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (exact && DECIMAL_TEXT.test(text)) {
      return Number(text);
    }
    return text;
  }
  return value;
}

function floatValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const text = value.trim();
    const number = Number(text);
    return text !== '' && Number.isFinite(number) ? number : text;
  }
  return value;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * Date and time text in one form: `YYYY-MM-DD`, `HH:MM:SS`, and
 * `YYYY-MM-DD HH:MM:SS.ffffff` with the fraction as the driver gave it.
 * Text in any other format (a job date format such as *MDY) is kept as is.
 */
function temporalValue(value: unknown, kind: 'date' | 'time' | 'timestamp'): unknown {
  if (value instanceof Date) {
    const date = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1, 2)}-${pad(value.getUTCDate(), 2)}`;
    const time = `${pad(value.getUTCHours(), 2)}:${pad(value.getUTCMinutes(), 2)}:${pad(value.getUTCSeconds(), 2)}`;
    if (kind === 'date') return date;
    if (kind === 'time') return time;
    return `${date} ${time}.${pad(value.getUTCMilliseconds(), 3)}`;
  }
  if (typeof value !== 'string') {
    return value;
  }
  const text = value.trim();
  if (kind === 'timestamp') {
    const match = TIMESTAMP_TEXT.exec(text);
    if (match) {
      const fraction = match[5] ? `.${match[5]}` : '';
      return `${match[1]} ${match[2]}:${match[3]}:${match[4]}${fraction}`;
    }
    return text;
  }
  if (kind === 'time') {
    const match = TIME_TEXT.exec(text);
    return match ? `${match[1]}:${match[2]}:${match[3]}` : text;
  }
  // A date is already YYYY-MM-DD with naming=sql and the default *ISO format
  return text;
}

/**
 * One value in the shape file writers expect for its column:
 * - null for null
 * - numbers for integers and for decimals a JavaScript number holds exactly;
 *   wider integers and decimals as exact text when the driver sent text, and
 *   as the driver's number otherwise (see DbColumn.lossy)
 * - canonical text for dates, times and timestamps
 * - upper-case hex for binary data
 * - text with CHAR padding removed for character columns
 */
export function normalizeValue(value: unknown, column: DbColumn): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Uint8Array) {
    return hex(value);
  }
  if (value instanceof ArrayBuffer) {
    // node-odbc returns binary columns as an ArrayBuffer
    return hex(new Uint8Array(value));
  }
  switch (column.kind) {
    case 'int':
    case 'bigint':
      return integerValue(value);
    case 'decimal':
      return decimalValue(value, column);
    case 'float':
      return floatValue(value);
    case 'date':
    case 'time':
    case 'timestamp':
      return temporalValue(value, column.kind);
    case 'string': {
      const text = typeof value === 'string' ? value : String(value);
      return isFixedLength(column) ? text.replace(/ +$/, '') : text;
    }
    case 'binary':
      return typeof value === 'string' ? value : String(value);
    default:
      if (typeof value === 'bigint') {
        return integerValue(value);
      }
      return typeof value === 'object' ? JSON.stringify(value) : value;
  }
}

/**
 * Turn a driver's row object into an array in column order, normalizing each
 * value. Columns are looked up by name, so two columns with the same name
 * read the same value; callers reject such results before reading rows.
 */
export function rowFromObject(row: Record<string, unknown>, columns: readonly DbColumn[]): unknown[] {
  return columns.map((column) => normalizeValue(row[column.name], column));
}
