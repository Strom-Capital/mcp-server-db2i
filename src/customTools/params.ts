/**
 * Turn :name placeholders into positional ? markers.
 *
 * Names inside string literals, quoted identifiers, and comments stay as text.
 * A bare ? is rejected so bind order cannot be mixed with hand-written markers.
 */

const PLACEHOLDER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class PlaceholderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaceholderError';
  }
}

export interface RewrittenSql {
  /** SQL with :name placeholders replaced by ? markers. */
  sql: string;
  /** Placeholder names in bind order. Repeated names are kept. */
  names: string[];
}

/**
 * Replace :name placeholders with ? and return the names in bind order.
 *
 * @throws PlaceholderError when a colon is not a :name placeholder, a ? marker
 * is already present, or a quote or block comment is left open.
 */
export function rewriteNamedPlaceholders(sql: string): RewrittenSql {
  let out = '';
  const names: string[] = [];
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      if (end === -1) {
        out += sql.slice(i);
        break;
      }
      out += sql.slice(i, end);
      i = end;
      continue;
    }

    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) {
        throw new PlaceholderError('Unclosed block comment.');
      }
      out += sql.slice(i, end + 2);
      i = end + 2;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const end = endOfQuoted(sql, i, ch);
      out += sql.slice(i, end);
      i = end;
      continue;
    }

    if (ch === '?') {
      throw new PlaceholderError(
        'Use :name placeholders. Question marks are reserved for bound parameters.'
      );
    }

    if (ch === ':') {
      const name = readPlaceholderName(sql, i + 1);
      names.push(name);
      out += '?';
      i += 1 + name.length;
      continue;
    }

    out += ch;
    i += 1;
  }

  return { sql: out, names };
}

function readPlaceholderName(sql: string, start: number): string {
  let end = start;
  while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end])) {
    end += 1;
  }
  const name = sql.slice(start, end);
  if (!PLACEHOLDER_NAME.test(name)) {
    throw new PlaceholderError(
      'Invalid placeholder. Write :name using letters, digits, and underscores.'
    );
  }
  return name;
}

function endOfQuoted(sql: string, start: number, quote: "'" | '"'): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  const kind = quote === "'" ? 'string literal' : 'quoted identifier';
  throw new PlaceholderError(`Unclosed ${kind}.`);
}
