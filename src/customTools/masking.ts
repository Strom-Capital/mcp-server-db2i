/**
 * Column masking for execute_query and YAML tools.
 *
 * PARSE_STATEMENT names the tables. It does not say whether a column is a
 * plain selected column or buried in a predicate or expression, so that
 * part is a token scan. The scan is conservative: an unqualified column
 * name counts whenever a masked table is in the statement.
 */

import type { MaskRule } from './schema.js';

export type { MaskRule };

/** SCHEMA.TABLE (uppercased) to COLUMN (uppercased) to rule. */
export type MaskingMap = Map<string, Map<string, MaskRule>>;

export interface MaskCheck {
  violations: string[];
  /** Uppercased masked columns that the statement returns. */
  selected: string[];
}

type TokenKind = 'ident' | 'delim' | 'string' | 'comment' | 'number' | 'dot' | 'slash' | 'comma' | 'lparen' | 'rparen' | 'other';

interface Token {
  kind: TokenKind;
  text: string;
  upper: string;
  depth: number;
}

const REDACTED = '****';

/**
 * Scan a statement. Comments and string literals are their own tokens so a
 * masked name inside them is not treated as a column.
 */
export function tokenizeSql(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let depth = 0;

  while (i < sql.length) {
    const ch = sql[i];

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') {
      i += 1;
      continue;
    }

    if (ch === '-' && sql[i + 1] === '-') {
      const start = i;
      i += 2;
      while (i < sql.length && sql[i] !== '\n') {
        i += 1;
      }
      tokens.push({ kind: 'comment', text: sql.slice(start, i), upper: '', depth });
      continue;
    }

    if (ch === '/' && sql[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        i += 1;
      }
      i = Math.min(sql.length, i + 2);
      tokens.push({ kind: 'comment', text: sql.slice(start, i), upper: '', depth });
      continue;
    }

    if (ch === "'") {
      const start = i;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      tokens.push({ kind: 'string', text: sql.slice(start, i), upper: '', depth });
      continue;
    }

    if (ch === '"') {
      i += 1;
      let text = '';
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          text += '"';
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          i += 1;
          break;
        }
        text += sql[i];
        i += 1;
      }
      tokens.push({ kind: 'delim', text, upper: text.toUpperCase(), depth });
      continue;
    }

    if (isIdentStart(ch)) {
      const start = i;
      i += 1;
      while (i < sql.length && isIdentPart(sql[i])) {
        i += 1;
      }
      const text = sql.slice(start, i);
      tokens.push({ kind: 'ident', text, upper: text.toUpperCase(), depth });
      continue;
    }

    if (ch >= '0' && ch <= '9') {
      const start = i;
      i += 1;
      while (i < sql.length && ((sql[i] >= '0' && sql[i] <= '9') || sql[i] === '.')) {
        i += 1;
      }
      tokens.push({ kind: 'number', text: sql.slice(start, i), upper: '', depth });
      continue;
    }

    if (ch === '(') {
      tokens.push({ kind: 'lparen', text: ch, upper: '', depth });
      depth += 1;
      i += 1;
      continue;
    }

    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      tokens.push({ kind: 'rparen', text: ch, upper: '', depth });
      i += 1;
      continue;
    }

    const kind: TokenKind = ch === '.' ? 'dot' : ch === '/' ? 'slash' : ch === ',' ? 'comma' : 'other';
    tokens.push({ kind, text: ch, upper: '', depth });
    i += 1;
  }

  return tokens;
}

/**
 * Masked names may appear only as a plain item in the outer select list:
 * COL, Q.COL, or S.T.COL. A masked table also rejects UNION, EXCEPT,
 * INTERSECT, and an ORDER BY position.
 */
export function checkMaskedColumns(sql: string, maskedColumns: ReadonlySet<string>): MaskCheck {
  if (maskedColumns.size === 0) {
    return { violations: [], selected: [] };
  }

  const tokens = tokenizeSql(sql).filter((token) => token.kind !== 'comment');
  const violations: string[] = [];

  for (const word of ['UNION', 'EXCEPT', 'INTERSECT'] as const) {
    if (tokens.some((token) => token.kind === 'ident' && token.depth === 0 && token.upper === word)) {
      violations.push(`${word} is not allowed when a masked table is referenced.`);
    }
  }

  if (orderByPosition(tokens)) {
    violations.push('ORDER BY position is not allowed when a masked column is selected.');
  }

  const list = selectList(tokens);
  const items = list ? splitItems(tokens.slice(list.start, list.end)) : [];
  const star = items.some((item) => item.length === 1 && item[0].kind === 'other' && item[0].text === '*');
  const selected = new Set<string>();
  const reported = new Set<string>();

  for (const token of tokens) {
    if ((token.kind !== 'ident' && token.kind !== 'delim') || !maskedColumns.has(token.upper)) {
      continue;
    }

    const item = items.find((candidate) => candidate.includes(token));
    if (token.depth !== 0 || !item || !plainColumnItem(item, token.upper)) {
      if (!reported.has(token.upper)) {
        reported.add(token.upper);
        violations.push(`Masked column ${token.upper} must be a plain selected column.`);
      }
      continue;
    }

    selected.add(token.upper);
  }

  if (star) {
    for (const column of maskedColumns) {
      selected.add(column);
    }
  }

  return { violations, selected: [...selected] };
}

/**
 * Tables from PARSE_STATEMENT that have masking rules.
 * TABLE and VIEW rows only. An unresolved schema matches every rule for that table name.
 */
export function maskedTablesFromParsed(
  rows: ReadonlyArray<{ nameType: string; schema: string | null; name: string | null }>,
  masking: MaskingMap,
  defaultSchema?: string,
): string[] {
  const fallback = defaultSchema?.trim().toUpperCase() || undefined;
  const found = new Set<string>();

  for (const row of rows) {
    if ((row.nameType !== 'TABLE' && row.nameType !== 'VIEW') || !row.name) {
      continue;
    }
    const schema = row.schema?.trim().toUpperCase() || fallback;
    const table = row.name.trim().toUpperCase();
    if (schema) {
      const key = `${schema}.${table}`;
      if (masking.has(key)) {
        found.add(key);
      }
      continue;
    }
    for (const key of masking.keys()) {
      if (key.endsWith(`.${table}`)) {
        found.add(key);
      }
    }
  }

  return [...found];
}

/**
 * SCHEMA.TABLE and SCHEMA/TABLE keys, plus a bare table name that matches
 * one masking key. A qualified name does not pull in other schemas.
 */
export function maskedTablesInSql(sql: string, masking: MaskingMap): string[] {
  if (masking.size === 0) {
    return [];
  }

  const tokens = tokenizeSql(sql).filter((token) => token.kind !== 'comment');
  const found = new Set<string>();
  const tableNames = new Map<string, string[]>();
  for (const key of masking.keys()) {
    const table = key.slice(key.lastIndexOf('.') + 1);
    const list = tableNames.get(table) ?? [];
    list.push(key);
    tableNames.set(table, list);
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind !== 'ident' && token.kind !== 'delim') {
      continue;
    }

    const separator = tokens[i + 1];
    const next = tokens[i + 2];
    if (
      separator &&
      next &&
      (separator.kind === 'dot' || separator.kind === 'slash') &&
      (next.kind === 'ident' || next.kind === 'delim')
    ) {
      const key = `${token.upper}.${next.upper}`;
      if (masking.has(key)) {
        found.add(key);
      }
    }

    const previous = tokens[i - 1];
    const followed = separator?.kind === 'dot' || separator?.kind === 'slash';
    const preceded = previous?.kind === 'dot' || previous?.kind === 'slash';
    if (!followed && !preceded) {
      for (const key of tableNames.get(token.upper) ?? []) {
        found.add(key);
      }
    }
  }

  return [...found];
}

/**
 * Column rules for the referenced tables. `redact` wins when two tables
 * mask the same column differently.
 */
export function columnsForTables(masking: MaskingMap, tables: readonly string[]): Map<string, MaskRule> {
  const columns = new Map<string, MaskRule>();
  for (const table of tables) {
    const rules = masking.get(table);
    if (!rules) {
      continue;
    }
    for (const [column, rule] of rules) {
      const current = columns.get(column);
      if (!current || rule === 'redact') {
        columns.set(column, rule);
      }
    }
  }
  return columns;
}

/**
 * Check that every masked column is among the result's column names.
 * Returns the error to report, or undefined when all of them are present.
 */
export function requireMaskedColumns(
  columnNames: readonly string[],
  rules: ReadonlyMap<string, MaskRule>,
): string | undefined {
  const names = new Set(columnNames.map((name) => name.toUpperCase()));
  for (const column of rules.keys()) {
    if (!names.has(column)) {
      return `Masked column ${column} was not in the result, so the rows were not returned.`;
    }
  }
  return undefined;
}

/**
 * Mask one value. Null and undefined stay as they are.
 */
export function maskValue(value: unknown, rule: MaskRule): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  return rule === 'redact' ? REDACTED : last4(value);
}

/**
 * Apply rules to result keys. An empty result has no keys to check.
 * A row set that is missing a selected masked column is returned as an error.
 */
export function maskRows(
  rows: Record<string, unknown>[],
  rules: ReadonlyMap<string, MaskRule>,
): { ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string } {
  if (rules.size === 0) {
    return { ok: true, rows };
  }

  if (rows.length > 0) {
    const error = requireMaskedColumns(Object.keys(rows[0]), rules);
    if (error) {
      return { ok: false, error };
    }
  }

  const masked = rows.map((row) => {
    const copy: Record<string, unknown> = { ...row };
    for (const [key, value] of Object.entries(copy)) {
      const rule = rules.get(key.toUpperCase());
      if (rule) {
        copy[key] = maskValue(value, rule);
      }
    }
    return copy;
  });

  return { ok: true, rows: masked };
}

function last4(value: unknown): string {
  const text = String(value);
  if (text.length <= 4) {
    return REDACTED;
  }
  return `${'*'.repeat(text.length - 4)}${text.slice(-4)}`;
}

function selectList(tokens: Token[]): { start: number; end: number } | undefined {
  const selectAt = tokens.findIndex((token) => token.kind === 'ident' && token.depth === 0 && token.upper === 'SELECT');
  if (selectAt < 0) {
    return undefined;
  }

  let start = selectAt + 1;
  const qualifier = tokens[start];
  if (qualifier && qualifier.kind === 'ident' && qualifier.depth === 0 && (qualifier.upper === 'DISTINCT' || qualifier.upper === 'ALL')) {
    start += 1;
  }

  let end = tokens.length;
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind === 'ident' && token.depth === 0 && token.upper === 'FROM') {
      end = i;
      break;
    }
  }

  return { start, end };
}

function splitItems(tokens: Token[]): Token[][] {
  const items: Token[][] = [];
  let current: Token[] = [];
  for (const token of tokens) {
    if (token.kind === 'comma' && token.depth === 0) {
      if (current.length > 0) {
        items.push(current);
      }
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) {
    items.push(current);
  }
  return items;
}

function plainColumnItem(item: Token[], column: string): boolean {
  const names = item.filter((token) => token.kind === 'ident' || token.kind === 'delim' || token.kind === 'dot');
  if (names.length !== item.length) {
    return false;
  }

  const idents = names.filter((token) => token.kind !== 'dot');
  const dots = names.filter((token) => token.kind === 'dot');
  if (idents.length === 1 && dots.length === 0) {
    return idents[0].upper === column;
  }
  if (idents.length === 2 && dots.length === 1 && names[1]?.kind === 'dot') {
    return idents[1].upper === column;
  }
  if (idents.length === 3 && dots.length === 2 && names[1]?.kind === 'dot' && names[3]?.kind === 'dot') {
    return idents[2].upper === column;
  }
  return false;
}

function orderByPosition(tokens: Token[]): boolean {
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const order = tokens[i];
    const by = tokens[i + 1];
    if (
      order.kind !== 'ident' ||
      order.depth !== 0 ||
      order.upper !== 'ORDER' ||
      by.kind !== 'ident' ||
      by.depth !== 0 ||
      by.upper !== 'BY'
    ) {
      continue;
    }

    let end = tokens.length;
    for (let j = i + 2; j < tokens.length; j += 1) {
      const token = tokens[j];
      if (token.kind === 'ident' && token.depth === 0 && (token.upper === 'FETCH' || token.upper === 'LIMIT' || token.upper === 'OFFSET')) {
        end = j;
        break;
      }
    }

    for (const item of splitItems(tokens.slice(i + 2, end))) {
      const first = item.find((token) => token.kind !== 'comment');
      if (first?.kind === 'number') {
        return true;
      }
    }
  }

  return false;
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_@#$]/.test(ch);
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_@#$]/.test(ch);
}
