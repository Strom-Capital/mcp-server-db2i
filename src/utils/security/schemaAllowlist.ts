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

const UNPARSEABLE_MESSAGE =
  'Query could not be parsed, so its libraries could not be checked. ' +
  'While a schema allowlist is set, system naming (LIB/FILE) and TABLE(...) functions are not accepted.';

interface ParsedQuery {
  tables: string[];
  ast: unknown;
}

/**
 * Replace `?` parameter markers with NULL, leaving markers inside quotes alone.
 * The Db2 dialect rejects `?`, and real queries use it for prepared statements.
 */
function replaceParameterMarkers(sql: string): string {
  let out = '';
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];

    if (quote) {
      out += ch;
      if (ch === quote) {
        if (sql[i + 1] === quote) {
          out += sql[++i];
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }

    if (ch === '?') {
      out += 'NULL';
      continue;
    }

    out += ch;
  }

  return out;
}

function normalizeForParsing(sql: string): string {
  return replaceParameterMarkers(stripTrailingRowLimit(sql));
}

function parseQuery(sql: string): ParsedQuery | undefined {
  const parser = new Parser();

  for (const database of PARSE_DIALECTS) {
    try {
      const ast = parser.astify(sql, { database });
      const tables = parser.tableList(sql, { database });
      return { ast, tables };
    } catch {
      // The other dialect may accept what this one rejects.
    }
  }

  return undefined;
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
  if (!parsed) {
    return { ok: false, violations: [UNPARSEABLE_MESSAGE] };
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
