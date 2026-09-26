/**
 * Schema allowlist for execute_query and the SQL service tools.
 *
 * When QUERY_ALLOWED_SCHEMAS is set, every table reference must resolve to
 * one of those libraries, and every schema-qualified function call must name
 * one of them. Queries that cannot be parsed are rejected, so a dialect the
 * parser does not understand cannot skip the check.
 *
 * Unqualified function calls are not checked. They resolve through the SQL
 * path (the library list under system naming), which is not known here, and
 * that is how built-ins such as UPPER and COALESCE are found. Clients cannot
 * change the path because SET statements are rejected by the SQL validator.
 */

import nodeSqlParser from 'node-sql-parser';

import { stripTrailingRowLimit } from '../../tools/sqlLimit.js';

const { Parser } = nodeSqlParser;

export interface SchemaCheckOptions {
  /** Uppercased library names the query may use */
  allowed: string[];
  /** Schema unqualified names resolve to. Empty means none is configured. */
  defaultSchema?: string;
}

export interface SchemaCheckResult {
  ok: boolean;
  violations: string[];
}

const PARSE_DIALECTS = ['db2', 'mysql'] as const;

const UNPARSEABLE_CAUSES =
  'Common causes while a schema allowlist is set: system naming (LIB/FILE), TABLE(...) functions, ' +
  'or Db2 syntax the checker does not support yet. Try SQL naming (LIB.FILE) or a simpler expression.';

/** Characters of the parsed text shown after the position the parser stopped at */
const ERROR_SNIPPET_LENGTH = 25;

interface ParsedQuery {
  tables: string[];
  ast: unknown;
}

interface ParseFailure {
  line?: number;
  near?: string;
}

/**
 * Apply rewrite to the SQL outside string literals, quoted identifiers and
 * comments. Those runs are copied unchanged.
 */
function rewriteCode(sql: string, rewrite: (code: string) => string): string {
  let out = '';
  let code = '';
  let i = 0;

  const flushCode = (): void => {
    out += rewrite(code);
    code = '';
  };

  while (i < sql.length) {
    const ch = sql[i];
    let end: number;

    if (ch === "'" || ch === '"') {
      end = i + 1;
      while (end < sql.length) {
        if (sql[end] === ch) {
          if (sql[end + 1] === ch) {
            end += 2;
            continue;
          }
          end++;
          break;
        }
        end++;
      }
    } else if (ch === '-' && sql[i + 1] === '-') {
      const newline = sql.indexOf('\n', i);
      end = newline === -1 ? sql.length : newline;
    } else if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      end = close === -1 ? sql.length : close + 2;
    } else {
      code += ch;
      i++;
      continue;
    }

    flushCode();
    out += sql.slice(i, end);
    i = end;
  }

  flushCode();
  return out;
}

/** Db2 for i type names the parser rejects, mapped to ones it reads */
const TYPE_REPLACEMENTS: Record<string, string> = {
  NVARCHAR: 'VARCHAR',
  VARGRAPHIC: 'VARCHAR',
  NCHAR: 'CHAR',
  GRAPHIC: 'CHAR',
  NCLOB: 'VARCHAR',
  DBCLOB: 'VARCHAR',
  CLOB: 'VARCHAR',
  DECFLOAT: 'DECIMAL',
};

const CAST_TYPE_RE = new RegExp(
  `\\bAS(\\s+)(${Object.keys(TYPE_REPLACEMENTS).join('|')})\\b(?!\\s*\\.)(\\s*\\([^()]*\\))?`,
  'gi'
);

/**
 * Rewrite Db2 for i data type syntax the parser does not read into forms it
 * does. Only keywords, integers and type names change, never identifiers, so
 * the table and function references stay the same.
 */
function normalizeDb2Types(code: string): string {
  return code
    .replace(/\bCCSID\s+\d+\b/gi, '')
    .replace(/\bFOR\s+(?:BIT|SBCS|MIXED)\s+DATA\b/gi, '')
    .replace(CAST_TYPE_RE, (_match, space: string, type: string, args: string | undefined) => {
      // LOB lengths such as CLOB(1M) take a K, M or G suffix
      const length = args?.replace(/(\d+)\s*[KMG]\b/gi, '$1') ?? '';
      return `AS${space}${TYPE_REPLACEMENTS[type.toUpperCase()]}${length}`;
    });
}

/**
 * Db2 for i special registers, after CURRENT and a space or an underscore.
 * Multi-word names come before their first word, so TIME ZONE wins over TIME.
 */
const SPECIAL_REGISTERS = [
  'DATE',
  'TIME\\s+ZONE',
  'TIMEZONE',
  'TIMESTAMP',
  'TIME',
  'USER',
  'SERVER',
  'SCHEMA',
  'SQLID',
  'FUNCTION\\s+PATH',
  'PATH',
  'DEGREE',
  'DEBUG\\s+MODE',
  'DECFLOAT\\s+ROUNDING\\s+MODE',
  'IMPLICIT\\s+XMLPARSE\\s+OPTION',
  'LOCK\\s+TIMEOUT',
  'TEMPORAL\\s+SYSTEM_TIME',
  'CLIENT_ACCTNG',
  'CLIENT_APPLNAME',
  'CLIENT_PROGRAMID',
  'CLIENT_USERID',
  'CLIENT_WRKSTNNAME',
];

/** Characters that continue a Db2 for i name, besides letters, digits and _ */
const NAME_CHAR = '\\w$#@';

/**
 * A special register that is not part of a qualified name: nothing joins it
 * to a name before it, and no dot follows it. TIMESTAMP may carry a precision.
 */
const SPECIAL_REGISTER_RE = new RegExp(
  `(?<![${NAME_CHAR}.])CURRENT(?:\\s+|_)(?:TIMESTAMP\\s*\\(\\s*\\d*\\s*\\)|${SPECIAL_REGISTERS.join('|')})(?![${NAME_CHAR}]|\\s*\\.)`,
  'gi'
);

/**
 * The unit of a labeled duration after a number or a closing parenthesis,
 * as in CURRENT DATE - 30 DAYS. The unit after a column name is left alone:
 * there it cannot be told apart from an alias.
 */
const DURATION_RE = new RegExp(
  `((?<![${NAME_CHAR}.])\\d+(?:\\.\\d*)?|\\))\\s+(?:YEARS?|MONTHS?|DAYS?|HOURS?|MINUTES?|SECONDS?|MICROSECONDS?)(?![${NAME_CHAR}]|\\s*\\.)`,
  'gi'
);

/**
 * Rewrite Db2 for i special registers and labeled durations, which the parser
 * does not read. A register becomes NULL and a duration loses its unit. Only
 * keywords change: a qualified name such as MYLIB.CURRENT is never touched,
 * and a table named CURRENT turns unparseable and is refused, as before.
 */
function normalizeDb2Registers(code: string): string {
  return code.replace(SPECIAL_REGISTER_RE, 'NULL').replace(DURATION_RE, '$1');
}

/**
 * Build the copy of the SQL that is parsed for the check. It is never run.
 * `?` markers become NULL because the Db2 dialect rejects them.
 * Exported for tests.
 */
export function normalizeForParsing(sql: string): string {
  return rewriteCode(stripTrailingRowLimit(sql), (code) =>
    normalizeDb2Registers(normalizeDb2Types(code.replace(/\?/g, 'NULL')))
  );
}

function describeParseError(sql: string, error: unknown): ParseFailure {
  const start = (error as { location?: { start?: { line?: unknown; offset?: unknown } } } | null)
    ?.location?.start;
  if (typeof start?.line !== 'number' || typeof start.offset !== 'number') {
    return {};
  }
  const near = sql
    .slice(start.offset, start.offset + ERROR_SNIPPET_LENGTH)
    .replace(/\s+/g, ' ')
    .trim();
  return { line: start.line, near: near || undefined };
}

function unparseableMessage(failure: ParseFailure): string {
  let position = '';
  if (failure.line !== undefined) {
    position = failure.near
      ? ` (near line ${failure.line}: "${failure.near}")`
      : ` (at the end of line ${failure.line})`;
  }
  return `The query could not be parsed, so its libraries could not be checked${position}. ${UNPARSEABLE_CAUSES}`;
}

function parseQuery(sql: string): ParsedQuery | ParseFailure {
  const parser = new Parser();
  let failure: ParseFailure | undefined;

  for (const database of PARSE_DIALECTS) {
    try {
      const ast = parser.astify(sql, { database });
      const tables = parser.tableList(sql, { database });
      return { ast, tables };
    } catch (error) {
      // The other dialect may accept what this one rejects. Report the first.
      failure ??= describeParseError(sql, error);
    }
  }

  return failure ?? {};
}

function collectCteNames(node: unknown, names: Set<string>): void {
  if (!node || typeof node !== 'object') {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectCteNames(item, names);
    }
    return;
  }

  const record = node as Record<string, unknown>;
  const withClause = record.with;
  if (Array.isArray(withClause)) {
    for (const cte of withClause) {
      const name = (cte as { name?: { value?: unknown } })?.name?.value;
      if (typeof name === 'string' && name.length > 0) {
        names.add(name.toUpperCase());
      }
      collectCteNames(cte, names);
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (key === 'with') {
      continue;
    }
    collectCteNames(value, names);
  }
}

function identifierValue(node: unknown): string | undefined {
  if (typeof node === 'string') {
    return node;
  }
  const value = (node as { value?: unknown } | null)?.value;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Collect schema-qualified function calls as SCHEMA.NAME.
 * The parser puts the qualifier in `name.schema`. Extra leading name parts are
 * treated as the qualifier too, so a shape change cannot hide one.
 */
function collectQualifiedFunctions(node: unknown, found: Map<string, string>): void {
  if (!node || typeof node !== 'object') {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectQualifiedFunctions(item, found);
    }
    return;
  }

  const record = node as Record<string, unknown>;
  if (record.type === 'function' && record.name && typeof record.name === 'object') {
    const name = record.name as { name?: unknown; schema?: unknown };
    const parts = Array.isArray(name.name) ? name.name.map(identifierValue) : [];
    const functionName = parts.at(-1) ?? '?';
    const qualifiers = [identifierValue(name.schema), ...parts.slice(0, -1)].filter(
      (part): part is string => typeof part === 'string' && part.length > 0
    );
    for (const qualifier of qualifiers) {
      const schema = qualifier.replace(/^"|"$/g, '').toUpperCase();
      found.set(`${schema}.${functionName.toUpperCase()}`, schema);
    }
  }

  for (const value of Object.values(record)) {
    collectQualifiedFunctions(value, found);
  }
}

function schemaOf(entry: string): { schema: string | undefined; table: string } | undefined {
  const parts = entry.split('::');
  if (parts.length < 3) {
    return undefined;
  }

  const schema = parts[1];
  const table = parts.slice(2).join('::').replace(/^"|"$/g, '');
  if (!table || table === '*') {
    return undefined;
  }

  if (!schema || schema.toLowerCase() === 'null') {
    return { schema: undefined, table };
  }

  return { schema: schema.replace(/^"|"$/g, '').toUpperCase(), table };
}

/**
 * Check that every table reference and qualified function call stays inside
 * the allowlist.
 * Callers should skip this when the allowlist is unset.
 */
export function checkQuerySchemas(sql: string, options: SchemaCheckOptions): SchemaCheckResult {
  const parsed = parseQuery(normalizeForParsing(sql));
  if (!('ast' in parsed)) {
    return { ok: false, violations: [unparseableMessage(parsed)] };
  }

  const cteNames = new Set<string>();
  collectCteNames(parsed.ast, cteNames);

  const allowed = new Set(options.allowed.map((name) => name.toUpperCase()));
  const defaultSchema = options.defaultSchema?.trim().toUpperCase() || undefined;
  const violations: string[] = [];

  for (const entry of parsed.tables) {
    const ref = schemaOf(entry);
    if (!ref) {
      continue;
    }

    if (!ref.schema) {
      if (cteNames.has(ref.table.toUpperCase())) {
        continue;
      }

      if (!defaultSchema) {
        violations.push(
          `Unqualified table ${ref.table} has no default schema. Set DB2I_SCHEMA (or schema in the profile), or qualify the table with a library.`
        );
        continue;
      }

      if (!allowed.has(defaultSchema)) {
        violations.push(
          `Unqualified table ${ref.table} resolves to ${defaultSchema}, which is not in the allowed schemas.`
        );
      }
      continue;
    }

    if (!allowed.has(ref.schema)) {
      violations.push(
        `Table ${ref.schema}.${ref.table} is not in the allowed schemas (${[...allowed].join(', ')}).`
      );
    }
  }

  const functions = new Map<string, string>();
  collectQualifiedFunctions(parsed.ast, functions);
  for (const [name, schema] of functions) {
    if (!allowed.has(schema)) {
      violations.push(
        `Function ${name} is not in the allowed schemas (${[...allowed].join(', ')}).`
      );
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * True when schema is in the allowlist. Comparison is case-insensitive.
 */
export function isSchemaAllowed(schema: string, allowed: readonly string[]): boolean {
  const name = schema.trim().toUpperCase();
  if (!name) {
    return false;
  }
  return allowed.some((entry) => entry.toUpperCase() === name);
}
