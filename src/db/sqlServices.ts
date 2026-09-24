/**
 * IBM i SQL services used by validate_query, get_object_ddl, get_related_objects,
 * and get_journal_info.
 *
 * PARSE_STATEMENT, RELATED_OBJECTS, and OBJECT_STATISTICS run on the read-only query pool.
 * GENERATE_SQL runs on the procedure pool because a read-only connection rejects it.
 */

import { executeProcedure, executeQuery } from './connection.js';
import { filterToLikePattern } from './queries.js';
import { isSchemaAllowed } from '../utils/security/schemaAllowlist.js';

export const SQL_OBJECT_TYPES = [
  'TABLE',
  'VIEW',
  'INDEX',
  'ALIAS',
  'TRIGGER',
  'FUNCTION',
  'PROCEDURE',
  'SEQUENCE',
] as const;

export type SqlObjectType = (typeof SQL_OBJECT_TYPES)[number];

const TABLE_NAME_TYPES = new Set(['TABLE', 'VIEW', 'ALIAS']);
const ROUTINE_NAME_TYPES = new Set(['FUNCTION', 'PROCEDURE']);
const UNQUOTED_NAME = /^[A-Z0-9_@#$]{1,128}$/;
const LOOKUP_CHUNK = 40;

/** Release requirement shared by validate_query and the validate-tools --connect check. */
export const PARSE_STATEMENT_REQUIREMENT =
  'It requires IBM i 7.3 with Db2 PTF group SF99703 level 3, or IBM i 7.4 or later.';

export const PARSE_STATEMENT_UNAVAILABLE =
  `QSYS2.PARSE_STATEMENT is not available on this system. ${PARSE_STATEMENT_REQUIREMENT}`;

const PARSE_SQL = `
  SELECT NAME_TYPE, SCHEMA, NAME, COLUMN_NAME, SQL_STATEMENT_TYPE
  FROM TABLE(QSYS2.PARSE_STATEMENT(CAST(? AS CLOB(2M)))) X
`;

export interface ParsedName {
  nameType: string;
  schema: string | null;
  name: string | null;
  columnName: string | null;
  statementType: string | null;
}

export interface RelatedObject {
  sql_object_type: string;
  schema_name: string | null;
  sql_name: string | null;
  library_name: string | null;
  system_name: string | null;
  object_text: string | null;
}

export interface StatementInspection {
  /** False when PARSE_STATEMENT returned no rows. */
  parsed: boolean;
  statementType: string | null;
  missingTables: string[];
  missingColumns: string[];
  missingRoutines: string[];
  violations: string[];
}

export interface InspectOptions {
  sessionId?: string;
  /** Schema unqualified names resolve to. */
  defaultSchema?: string;
  /** Uppercased allowlist. Unset means no restriction. */
  allowedSchemas?: string[];
}

interface TableRef {
  schema: string;
  table: string;
}

interface ColumnRef {
  schema: string;
  table: string;
  column: string;
}

const routineCache = new Map<string, boolean>();

export function clearRoutineCache(): void {
  routineCache.clear();
}

function cell(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  const text = String(value).trim();
  return text.length > 0 ? text.toUpperCase() : null;
}

function textCell(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

/**
 * True when the failure is QSYS2.PARSE_STATEMENT missing (SQL0204), rather than
 * a statement that parsed to no rows.
 */
export function isParseStatementMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /PARSE_STATEMENT/i.test(message) && (/\bSQL0204\b/.test(message) || /not found/i.test(message));
}

/**
 * Reject names that are not safe to embed in the GENERATE_SQL call.
 * The procedure's named arguments are literals, not parameter markers.
 */
export function requireSqlName(value: string, label: string): string {
  const name = value.trim().toUpperCase();
  if (!UNQUOTED_NAME.test(name)) {
    throw new Error(`${label} must be an unquoted IBM i name (letters, digits, and _ @ # $).`);
  }
  return name;
}

export async function parseStatement(sql: string, sessionId?: string): Promise<ParsedName[]> {
  const result = await executeQuery(PARSE_SQL, [sql], sessionId);
  return result.rows.map((row) => ({
    nameType: cell(row.NAME_TYPE) ?? '',
    schema: cell(row.SCHEMA),
    name: cell(row.NAME),
    columnName: cell(row.COLUMN_NAME),
    statementType: cell(row.SQL_STATEMENT_TYPE),
  }));
}

export async function hasRoutine(schema: string, name: string, sessionId?: string): Promise<boolean> {
  const routineSchema = schema.trim().toUpperCase();
  const routineName = name.trim().toUpperCase();
  const key = `${sessionId ?? 'global'}|${routineSchema}|${routineName}`;
  const cached = routineCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const result = await executeQuery(
    `SELECT ROUTINE_NAME FROM QSYS2.SYSROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ? FETCH FIRST 1 ROW ONLY`,
    [routineSchema, routineName],
    sessionId
  );
  const found = result.rows.length > 0;
  routineCache.set(key, found);
  return found;
}

function allowlistViolation(kind: 'Table' | 'Routine', schema: string, name: string, allowed: string[]): string {
  return `${kind} ${schema}.${name} is not in QUERY_ALLOWED_SCHEMAS (${allowed.join(', ')}).`;
}

function unresolvedTable(table: string): string {
  return `Unqualified table ${table} has no default schema. Set DB2I_SCHEMA or qualify the table with a library.`;
}

async function lookupPairs(
  sqlPrefix: string,
  tuples: string[][],
  keyOf: (row: Record<string, unknown>) => string,
  sessionId?: string
): Promise<Set<string>> {
  const found = new Set<string>();
  const width = tuples[0]?.length ?? 0;
  if (width === 0) {
    return found;
  }

  for (let offset = 0; offset < tuples.length; offset += LOOKUP_CHUNK) {
    const chunk = tuples.slice(offset, offset + LOOKUP_CHUNK);
    const values = chunk.map(() => `(${Array(width).fill('?').join(', ')})`).join(', ');
    const result = await executeQuery(`${sqlPrefix} (VALUES ${values})`, chunk.flat(), sessionId);
    for (const row of result.rows) {
      found.add(keyOf(row));
    }
  }

  return found;
}

/**
 * Parse a statement and check the names it uses against the catalog.
 * Does not run the statement. Throws when PARSE_STATEMENT itself is missing.
 */
export async function inspectStatement(sql: string, options: InspectOptions = {}): Promise<StatementInspection> {
  const parsed = await parseStatement(sql, options.sessionId);
  if (parsed.length === 0) {
    return {
      parsed: false,
      statementType: null,
      missingTables: [],
      missingColumns: [],
      missingRoutines: [],
      violations: ['The statement could not be parsed.'],
    };
  }

  const statementType = parsed.find((row) => row.statementType)?.statementType ?? null;
  const violations: string[] = [];
  const defaultSchema = options.defaultSchema?.trim().toUpperCase() || undefined;
  const allowed = options.allowedSchemas;

  const tables: TableRef[] = [];
  const seenTables = new Set<string>();

  for (const row of parsed) {
    if (!TABLE_NAME_TYPES.has(row.nameType) || !row.name) {
      continue;
    }
    const schema = row.schema ?? defaultSchema;
    if (!schema) {
      violations.push(unresolvedTable(row.name));
      continue;
    }
    if (allowed && !isSchemaAllowed(schema, allowed)) {
      violations.push(allowlistViolation('Table', schema, row.name, allowed));
      continue;
    }
    const key = `${schema}.${row.name}`;
    if (seenTables.has(key)) {
      continue;
    }
    seenTables.add(key);
    tables.push({ schema, table: row.name });
  }

  const specificColumns: ColumnRef[] = [];
  const seenColumns = new Set<string>();
  const looseColumns = new Set<string>();

  for (const row of parsed) {
    if (row.nameType !== 'COLUMN' || !row.columnName) {
      continue;
    }
    if (!row.name) {
      looseColumns.add(row.columnName);
      continue;
    }
    const schema = row.schema ?? tables.find((table) => table.table === row.name)?.schema ?? defaultSchema;
    if (!schema) {
      violations.push(`Column ${row.columnName} on ${row.name} could not be checked because the table has no schema.`);
      continue;
    }
    if (allowed && !isSchemaAllowed(schema, allowed)) {
      violations.push(allowlistViolation('Table', schema, row.name, allowed));
      continue;
    }
    const key = `${schema}.${row.name}.${row.columnName}`;
    if (seenColumns.has(key)) {
      continue;
    }
    seenColumns.add(key);
    specificColumns.push({ schema, table: row.name, column: row.columnName });
  }

  if (looseColumns.size > 0 && tables.length === 0) {
    for (const column of looseColumns) {
      violations.push(`Column ${column} could not be checked because the statement names no table.`);
    }
    looseColumns.clear();
  }

  const routines: Array<{ schema: string; name: string }> = [];
  const seenRoutines = new Set<string>();
  for (const row of parsed) {
    if (!ROUTINE_NAME_TYPES.has(row.nameType) || !row.name) {
      continue;
    }
    // Unqualified functions are built-ins (UPPER, COALESCE). Skip them.
    if (!row.schema) {
      continue;
    }
    if (allowed && !isSchemaAllowed(row.schema, allowed)) {
      violations.push(allowlistViolation('Routine', row.schema, row.name, allowed));
      continue;
    }
    const key = `${row.schema}.${row.name}`;
    if (seenRoutines.has(key)) {
      continue;
    }
    seenRoutines.add(key);
    routines.push({ schema: row.schema, name: row.name });
  }

  const missingTables: string[] = [];
  const missingColumns: string[] = [];
  const missingRoutines: string[] = [];

  if (tables.length > 0) {
    const existing = await lookupPairs(
      'SELECT TABLE_SCHEMA, TABLE_NAME FROM QSYS2.SYSTABLES WHERE (TABLE_SCHEMA, TABLE_NAME) IN',
      tables.map((table) => [table.schema, table.table]),
      (row) => `${cell(row.TABLE_SCHEMA)}.${cell(row.TABLE_NAME)}`,
      options.sessionId
    );
    for (const table of tables) {
      const key = `${table.schema}.${table.table}`;
      if (!existing.has(key)) {
        missingTables.push(key);
      }
    }
  }

  if (specificColumns.length > 0) {
    const existing = await lookupPairs(
      'SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME FROM QSYS2.SYSCOLUMNS WHERE (TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME) IN',
      specificColumns.map((column) => [column.schema, column.table, column.column]),
      (row) => `${cell(row.TABLE_SCHEMA)}.${cell(row.TABLE_NAME)}.${cell(row.COLUMN_NAME)}`,
      options.sessionId
    );
    for (const column of specificColumns) {
      const key = `${column.schema}.${column.table}.${column.column}`;
      if (!existing.has(key)) {
        missingColumns.push(key);
      }
    }
  }

  if (looseColumns.size > 0 && tables.length > 0) {
    const found = await lookupLooseColumns(tables, [...looseColumns], options.sessionId);
    for (const column of looseColumns) {
      if (!found.has(column)) {
        missingColumns.push(column);
      }
    }
  }

  if (routines.length > 0) {
    const existing = await lookupPairs(
      'SELECT ROUTINE_SCHEMA, ROUTINE_NAME FROM QSYS2.SYSROUTINES WHERE (ROUTINE_SCHEMA, ROUTINE_NAME) IN',
      routines.map((routine) => [routine.schema, routine.name]),
      (row) => `${cell(row.ROUTINE_SCHEMA)}.${cell(row.ROUTINE_NAME)}`,
      options.sessionId
    );
    for (const routine of routines) {
      const key = `${routine.schema}.${routine.name}`;
      if (!existing.has(key)) {
        missingRoutines.push(key);
      }
    }
  }

  if (!statementType) {
    violations.push('The statement type could not be determined.');
  } else if (statementType !== 'QUERY') {
    violations.push(`Statement type is ${statementType}.`);
  }

  return {
    parsed: true,
    statementType,
    missingTables,
    missingColumns,
    missingRoutines,
    violations,
  };
}

async function lookupLooseColumns(
  tables: TableRef[],
  columns: string[],
  sessionId?: string
): Promise<Set<string>> {
  const found = new Set<string>();
  const tableValues = tables.map(() => '(?, ?)').join(', ');
  const columnValues = columns.map(() => '?').join(', ');
  const sql = `
    SELECT COLUMN_NAME
    FROM QSYS2.SYSCOLUMNS
    WHERE (TABLE_SCHEMA, TABLE_NAME) IN (VALUES ${tableValues})
      AND COLUMN_NAME IN (${columnValues})
  `;
  const params = [...tables.flatMap((table) => [table.schema, table.table]), ...columns];
  const result = await executeQuery(sql, params, sessionId);
  for (const row of result.rows) {
    const name = cell(row.COLUMN_NAME);
    if (name) {
      found.add(name);
    }
  }
  return found;
}

export async function generateObjectDdl(input: {
  schema: string;
  objectName: string;
  objectType: string;
  sessionId?: string;
}): Promise<string> {
  const schema = requireSqlName(input.schema, 'Schema');
  const objectName = requireSqlName(input.objectName, 'Object name');
  const objectType = input.objectType.trim().toUpperCase();
  if (!(SQL_OBJECT_TYPES as readonly string[]).includes(objectType)) {
    throw new Error(`Object type must be one of: ${SQL_OBJECT_TYPES.join(', ')}.`);
  }

  const sql = `CALL QSYS2.GENERATE_SQL(DATABASE_OBJECT_NAME => '${objectName}', DATABASE_OBJECT_LIBRARY_NAME => '${schema}', DATABASE_OBJECT_TYPE => '${objectType}')`;
  const result = await executeProcedure(sql, [], input.sessionId);
  const lines = result.rows
    .map((row) => ({
      sequence: Number(row.SRCSEQ ?? 0),
      text: String(row.SRCDTA ?? '').replace(/\s+$/, ''),
    }))
    .sort((left, right) => left.sequence - right.sequence)
    .map((line) => line.text);

  if (lines.length === 0) {
    throw new Error(`QSYS2.GENERATE_SQL returned no source for ${schema}.${objectName}.`);
  }

  return lines.join('\n');
}

export async function listRelatedObjects(
  schema: string,
  table: string,
  sessionId?: string
): Promise<RelatedObject[]> {
  const result = await executeQuery(
    `SELECT SQL_OBJECT_TYPE, SCHEMA_NAME, SQL_NAME, LIBRARY_NAME, SYSTEM_NAME, OBJECT_TEXT
     FROM TABLE(SYSTOOLS.RELATED_OBJECTS(?, ?)) X`,
    [schema, table],
    sessionId
  );

  return result.rows.map((row) => ({
    sql_object_type: textCell(row.SQL_OBJECT_TYPE) ?? '',
    schema_name: textCell(row.SCHEMA_NAME),
    sql_name: textCell(row.SQL_NAME),
    library_name: textCell(row.LIBRARY_NAME),
    system_name: textCell(row.SYSTEM_NAME),
    object_text: textCell(row.OBJECT_TEXT),
  }));
}

export const JOURNAL_INFO_UNAVAILABLE =
  'QSYS2.OBJECT_STATISTICS on this system does not return journal columns. They require IBM i 7.3 Technology Refresh 2 or a later release.';

export interface JournalInfoRow {
  table_name: string;
  system_table_name: string;
  journaled: boolean;
  journal_library: string | null;
  journal_name: string | null;
  journal_images: string | null;
  omit_entries: string | null;
  journal_start: string | null;
  has_primary_key: boolean;
  needs_attention: boolean;
}

/**
 * True when OBJECT_STATISTICS lacks the journal columns (SQL0206 on an older release).
 */
export function isJournalColumnMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bSQL0206\b/.test(message) && /JOURNAL/i.test(message);
}

/**
 * A replication tool needs the table journaled, and a table without a primary
 * key needs before images too, so an update can be matched to its row.
 */
export function journalNeedsAttention(row: Pick<JournalInfoRow, 'journaled' | 'has_primary_key' | 'journal_images'>): boolean {
  if (!row.journaled) {
    return true;
  }
  return !row.has_primary_key && row.journal_images !== '*BOTH';
}

export async function schemaExists(schema: string, sessionId?: string): Promise<boolean> {
  const name = schema.trim().toUpperCase();
  const result = await executeQuery(
    `SELECT 1 AS FOUND FROM QSYS2.SYSSCHEMAS WHERE SCHEMA_NAME = ? OR SYSTEM_SCHEMA_NAME = ? FETCH FIRST 1 ROW ONLY`,
    [name, name],
    sessionId
  );
  return result.rows.length > 0;
}

/**
 * Journal state for the physical data files in a library.
 * Logical files and source files are left out.
 */
export async function listJournalInfo(
  schema: string,
  filter: string | undefined,
  limit: number,
  sessionId?: string
): Promise<{ rows: JournalInfoRow[]; truncated: boolean }> {
  const count = limit + 1;
  if (!Number.isSafeInteger(count) || count < 2) {
    throw new Error('Limit must be a positive integer.');
  }
  const pattern = filterToLikePattern(filter);

  const sql = `
    SELECT T.TABLE_NAME, T.SYSTEM_TABLE_NAME, O.JOURNALED, O.JOURNAL_LIBRARY, O.JOURNAL_NAME,
           O.JOURNAL_IMAGES, O.OMIT_JOURNAL_ENTRY, O.JOURNAL_START_TIMESTAMP,
           (SELECT COUNT(*) FROM QSYS2.SYSCST C
             WHERE C.TABLE_SCHEMA = T.TABLE_SCHEMA AND C.TABLE_NAME = T.TABLE_NAME
               AND C.CONSTRAINT_TYPE = 'PRIMARY KEY') AS PRIMARY_KEYS
    FROM TABLE(QSYS2.OBJECT_STATISTICS(?, '*FILE')) O
    JOIN QSYS2.SYSTABLES T
      ON T.SYSTEM_TABLE_SCHEMA = O.OBJLIB AND T.SYSTEM_TABLE_NAME = O.OBJNAME
    WHERE O.OBJATTRIBUTE = 'PF'
      AND T.FILE_TYPE = 'D'
      AND (T.TABLE_NAME LIKE ? OR T.SYSTEM_TABLE_NAME LIKE ?)
    ORDER BY T.TABLE_NAME
    FETCH FIRST ${count} ROWS ONLY
  `;

  const result = await executeQuery(sql, [schema.trim().toUpperCase(), pattern, pattern], sessionId);
  const rows = result.rows.map((row) => {
    const base = {
      table_name: textCell(row.TABLE_NAME) ?? '',
      system_table_name: textCell(row.SYSTEM_TABLE_NAME) ?? '',
      journaled: cell(row.JOURNALED) === 'YES',
      journal_library: textCell(row.JOURNAL_LIBRARY),
      journal_name: textCell(row.JOURNAL_NAME),
      journal_images: cell(row.JOURNAL_IMAGES),
      omit_entries: cell(row.OMIT_JOURNAL_ENTRY),
      journal_start: textCell(row.JOURNAL_START_TIMESTAMP),
      has_primary_key: Number(row.PRIMARY_KEYS ?? 0) > 0,
    };
    return { ...base, needs_attention: journalNeedsAttention(base) };
  });

  if (rows.length > limit) {
    return { rows: rows.slice(0, limit), truncated: true };
  }
  return { rows, truncated: false };
}
