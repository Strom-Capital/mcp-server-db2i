/**
 * SQL procedures and functions for list_routines and describe_routine, read
 * from QSYS2.SYSROUTINES and QSYS2.SYSPARMS.
 *
 * SYSPARMS holds more than parameters. ROW_TYPE 'P' is a parameter. For a
 * scalar function, 'C' is the return value ('R' is the value before a CAST
 * FROM). For a table function, 'C' and 'R' are result columns: Db2 stores a
 * single result column as 'C' and several as 'R'.
 */

import { executeQuery } from './connection.js';
import { filterToLikePattern } from './queries.js';
import type { DbTarget } from '../systems.js';

export type RoutineType = 'PROCEDURE' | 'SCALAR FUNCTION' | 'TABLE FUNCTION';

/** Overloads describe_routine returns for one name. */
export const MAX_OVERLOADS = 50;

/** SQL_DATA_ACCESS codes, spelled as in CREATE PROCEDURE and CREATE FUNCTION. */
const SQL_DATA_ACCESS: Readonly<Record<string, string>> = {
  NONE: 'NO SQL',
  CONTAINS: 'CONTAINS SQL',
  READS: 'READS SQL DATA',
  MODIFIES: 'MODIFIES SQL DATA',
};

export interface RoutineRow {
  schema: string;
  name: string;
  specific_name: string;
  type: RoutineType;
  /** SQL for an SQL routine, otherwise the external language such as RPGLE or C. */
  language: string | null;
  /** Program or service program an external routine calls. */
  external_name: string | null;
  sql_data_access: string | null;
  /** Result sets a procedure can return. Null for functions. */
  result_sets: number | null;
  parameter_count: number;
  text: string | null;
  last_altered: string | null;
}

export interface RoutineColumn {
  position: number;
  name: string | null;
  data_type: string;
  length: number | null;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  text: string | null;
}

export interface RoutineParameter extends RoutineColumn {
  mode: string;
  /** Default as SQL text, such as NULL or '*ALL'. Null when the parameter has none. */
  default: string | null;
}

export interface RoutineDetail extends RoutineRow {
  parameters: RoutineParameter[];
  /** Return value of a scalar function. */
  returns?: RoutineColumn | null;
  /** Result columns of a table function. */
  result_columns?: RoutineColumn[];
}

export interface ListRoutinesQuery {
  schema: string;
  filter?: string;
  type?: 'PROCEDURE' | 'FUNCTION';
  limit: number;
  target?: DbTarget;
}

export interface DescribeRoutineQuery {
  schema: string;
  name?: string;
  specificName?: string;
  target?: DbTarget;
}

const ROUTINE_COLUMNS = `
  SPECIFIC_SCHEMA, SPECIFIC_NAME, ROUTINE_SCHEMA, ROUTINE_NAME, ROUTINE_TYPE,
  FUNCTION_TYPE, ROUTINE_BODY, EXTERNAL_LANGUAGE, EXTERNAL_NAME, SQL_DATA_ACCESS,
  MAX_DYNAMIC_RESULT_SETS, IN_PARMS, OUT_PARMS, INOUT_PARMS,
  ROUTINE_TEXT, LONG_COMMENT, LAST_ALTERED, ROUTINE_CREATED
`;

function textOrNull(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function routineType(row: Record<string, unknown>): RoutineType {
  if (textOrNull(row.ROUTINE_TYPE)?.toUpperCase() === 'PROCEDURE') {
    return 'PROCEDURE';
  }
  return textOrNull(row.FUNCTION_TYPE)?.toUpperCase() === 'T' ? 'TABLE FUNCTION' : 'SCALAR FUNCTION';
}

function toRoutineRow(row: Record<string, unknown>): RoutineRow {
  const type = routineType(row);
  const access = textOrNull(row.SQL_DATA_ACCESS)?.toUpperCase();
  const body = textOrNull(row.ROUTINE_BODY)?.toUpperCase();
  return {
    schema: textOrNull(row.ROUTINE_SCHEMA) ?? '',
    name: textOrNull(row.ROUTINE_NAME) ?? '',
    specific_name: textOrNull(row.SPECIFIC_NAME) ?? '',
    type,
    language: textOrNull(row.EXTERNAL_LANGUAGE) ?? (body === 'SQL' ? 'SQL' : null),
    external_name: textOrNull(row.EXTERNAL_NAME),
    sql_data_access: access ? (SQL_DATA_ACCESS[access] ?? access) : null,
    result_sets: type === 'PROCEDURE' ? (numberOrNull(row.MAX_DYNAMIC_RESULT_SETS) ?? 0) : null,
    parameter_count:
      (numberOrNull(row.IN_PARMS) ?? 0) + (numberOrNull(row.OUT_PARMS) ?? 0) + (numberOrNull(row.INOUT_PARMS) ?? 0),
    text: textOrNull(row.ROUTINE_TEXT) ?? textOrNull(row.LONG_COMMENT),
    last_altered: textOrNull(row.LAST_ALTERED) ?? textOrNull(row.ROUTINE_CREATED),
  };
}

/** A distinct type is named by its schema and name; SYSPARMS says only DISTINCT. */
function dataTypeOf(row: Record<string, unknown>): string {
  const dataType = textOrNull(row.DATA_TYPE)?.toUpperCase() ?? '';
  const typeName = textOrNull(row.DATA_TYPE_NAME);
  if (dataType === 'DISTINCT' && typeName) {
    const typeSchema = textOrNull(row.DATA_TYPE_SCHEMA);
    return typeSchema ? `${typeSchema}.${typeName}` : typeName;
  }
  return dataType;
}

function toColumn(row: Record<string, unknown>, position: number): RoutineColumn {
  return {
    position,
    name: textOrNull(row.PARAMETER_NAME),
    data_type: dataTypeOf(row),
    length: numberOrNull(row.CHARACTER_MAXIMUM_LENGTH),
    precision: numberOrNull(row.NUMERIC_PRECISION),
    scale: numberOrNull(row.NUMERIC_SCALE),
    nullable: textOrNull(row.IS_NULLABLE)?.toUpperCase() !== 'NO',
    text: textOrNull(row.LONG_COMMENT),
  };
}

/**
 * Write a name as an SQL identifier. Ordinary names are left as they are;
 * anything else is quoted.
 */
export function sqlIdentifier(name: string): string {
  return /^[A-Z#@$][A-Z0-9_#@$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/**
 * A statement that calls the routine, with a parameter marker per parameter.
 * Arguments are named when every parameter has a name, unless positional is
 * set.
 */
export function callTemplate(
  routine: Pick<RoutineRow, 'schema' | 'name' | 'type'>,
  parameters: Array<Pick<RoutineParameter, 'name'>>,
  options: { positional?: boolean } = {}
): string {
  const named = !options.positional && parameters.every((parameter) => parameter.name);
  const args = parameters
    .map((parameter) => (named ? `${sqlIdentifier(parameter.name as string)} => ?` : '?'))
    .join(', ');
  const qualified = `${sqlIdentifier(routine.schema)}.${sqlIdentifier(routine.name)}`;
  switch (routine.type) {
    case 'PROCEDURE':
      return `CALL ${qualified}(${args})`;
    case 'TABLE FUNCTION':
      return `SELECT * FROM TABLE(${qualified}(${args})) X`;
    default:
      return `SELECT ${qualified}(${args}) FROM SYSIBM.SYSDUMMY1`;
  }
}

/**
 * Procedures and functions in one library, one row per specific routine,
 * sorted by name and then specific name.
 */
export async function listRoutines(query: ListRoutinesQuery): Promise<{ rows: RoutineRow[]; truncated: boolean }> {
  const fetch = query.limit + 1;
  if (!Number.isSafeInteger(fetch) || fetch < 2) {
    throw new Error('Limit must be a positive integer.');
  }

  const where = ['ROUTINE_SCHEMA = ?', 'ROUTINE_NAME LIKE ?'];
  const params: unknown[] = [query.schema.trim().toUpperCase(), filterToLikePattern(query.filter)];
  if (query.type) {
    where.push('ROUTINE_TYPE = ?');
    params.push(query.type);
  }

  const sql = `
    SELECT ${ROUTINE_COLUMNS}
    FROM QSYS2.SYSROUTINES
    WHERE ${where.join(' AND ')}
    ORDER BY ROUTINE_NAME, SPECIFIC_NAME
    FETCH FIRST ${fetch} ROWS ONLY
  `;

  const result = await executeQuery(sql, params, query.target);
  const rows = result.rows.map(toRoutineRow);
  if (rows.length > query.limit) {
    return { rows: rows.slice(0, query.limit), truncated: true };
  }
  return { rows, truncated: false };
}

/**
 * Parameters and result columns for a routine and each of its overloads. At most MAX_OVERLOADS are returned.
 */
export async function describeRoutine(query: DescribeRoutineQuery): Promise<{ rows: RoutineDetail[]; truncated: boolean }> {
  const schema = query.schema.trim().toUpperCase();
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.specificName?.trim()) {
    where.push('SPECIFIC_SCHEMA = ?', 'SPECIFIC_NAME = ?');
    params.push(schema, query.specificName.trim().toUpperCase());
  }
  if (query.name?.trim()) {
    where.push('ROUTINE_SCHEMA = ?', 'ROUTINE_NAME = ?');
    params.push(schema, query.name.trim().toUpperCase());
  }
  if (where.length === 0) {
    throw new Error('Provide name, specific_name, or both.');
  }

  const routines = await executeQuery(
    `
    SELECT ${ROUTINE_COLUMNS}
    FROM QSYS2.SYSROUTINES
    WHERE ${where.join(' AND ')}
    ORDER BY SPECIFIC_NAME
    FETCH FIRST ${MAX_OVERLOADS + 1} ROWS ONLY
    `,
    params,
    query.target
  );
  const truncated = routines.rows.length > MAX_OVERLOADS;
  const found = routines.rows.slice(0, MAX_OVERLOADS);
  if (found.length === 0) {
    return { rows: [], truncated: false };
  }

  // Specific names are unique within the specific schema, which can differ
  // from the routine schema.
  const keys = found.map((row) => [textOrNull(row.SPECIFIC_SCHEMA) ?? '', textOrNull(row.SPECIFIC_NAME) ?? '']);
  const parms = await executeQuery(
    `
    SELECT SPECIFIC_SCHEMA, SPECIFIC_NAME, ORDINAL_POSITION, ROW_TYPE, PARAMETER_MODE, PARAMETER_NAME,
           DATA_TYPE, DATA_TYPE_SCHEMA, DATA_TYPE_NAME, CHARACTER_MAXIMUM_LENGTH,
           NUMERIC_PRECISION, NUMERIC_SCALE, IS_NULLABLE, LONG_COMMENT,
           CAST("DEFAULT" AS VARCHAR(2000)) AS DEFAULT_VALUE
    FROM QSYS2.SYSPARMS
    WHERE ${keys.map(() => '(SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = ?)').join(' OR ')}
    ORDER BY SPECIFIC_SCHEMA, SPECIFIC_NAME, ORDINAL_POSITION
    `,
    keys.flat(),
    query.target
  );

  const byRoutine = new Map<string, Array<Record<string, unknown>>>();
  for (const row of parms.rows) {
    const key = `${textOrNull(row.SPECIFIC_SCHEMA)}.${textOrNull(row.SPECIFIC_NAME)}`;
    const list = byRoutine.get(key) ?? [];
    list.push(row);
    byRoutine.set(key, list);
  }

  const rows = found.map((row): RoutineDetail => {
    const routine = toRoutineRow(row);
    const rowsOf = byRoutine.get(`${textOrNull(row.SPECIFIC_SCHEMA)}.${routine.specific_name}`) ?? [];
    const rowType = (parm: Record<string, unknown>) => textOrNull(parm.ROW_TYPE)?.toUpperCase();

    const parameters = rowsOf
      .filter((parm) => rowType(parm) === 'P')
      .map((parm, index): RoutineParameter => ({
        ...toColumn(parm, index + 1),
        mode: textOrNull(parm.PARAMETER_MODE)?.toUpperCase() ?? 'IN',
        default: textOrNull(parm.DEFAULT_VALUE),
      }));
    const detail: RoutineDetail = { ...routine, parameters };

    if (routine.type === 'SCALAR FUNCTION') {
      const value = rowsOf.find((parm) => rowType(parm) === 'C') ?? rowsOf.find((parm) => rowType(parm) === 'R');
      detail.returns = value ? toColumn(value, 1) : null;
    } else if (routine.type === 'TABLE FUNCTION') {
      detail.result_columns = rowsOf
        .filter((parm) => rowType(parm) === 'C' || rowType(parm) === 'R')
        .map((parm, index) => toColumn(parm, index + 1));
    }
    return detail;
  });

  return { rows, truncated };
}
