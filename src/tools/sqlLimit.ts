/**
 * Apply a FETCH FIRST row cap to a SELECT statement.
 *
 * Only a trailing FETCH FIRST / FETCH NEXT / LIMIT clause is treated as an
 * existing limit. Column names such as CREDIT_LIMIT or string literals
 * containing "LIMIT" do not skip the cap. An existing trailing clause is
 * clamped to effectiveLimit rather than trusted as-is.
 *
 * Db2 for i wants FETCH FIRST before the clauses that end a select statement:
 * FOR READ ONLY, FOR UPDATE, OPTIMIZE FOR, an isolation clause such as WITH UR,
 * SKIP LOCKED DATA and the like. The cap goes in front of those.
 *
 * The clauses are found on a copy of the statement with comments blanked out
 * and literal contents masked, so a clause inside a comment or a string is
 * never taken for the real one.
 */

const TRAILING_LIMIT_RE =
  /\b(?:FETCH\s+(?:FIRST|NEXT)\s+(?:(\d+)\s+)?ROWS?\s+ONLY|LIMIT\s+(\d+)(\s+OFFSET\s+\d+)?)\s*$/i;

/** One clause that must follow FETCH FIRST in a Db2 for i select statement. */
const TAIL_CLAUSE =
  '(?:FOR\\s+(?:READ|FETCH)\\s+ONLY' +
  '|FOR\\s+UPDATE(?:\\s+OF\\s+[\\w$#@."]+(?:\\s*,\\s*[\\w$#@."]+)*)?' +
  '|OPTIMIZE\\s+FOR\\s+\\d+\\s+ROWS?' +
  '|WITH\\s+(?:NC|UR|CS|RS|RR)(?:\\s+USE\\s+AND\\s+KEEP\\s+(?:EXCLUSIVE|UPDATE|SHARE)\\s+LOCKS)?' +
  '|SKIP\\s+LOCKED\\s+DATA' +
  '|WAIT\\s+FOR\\s+OUTCOME' +
  '|USE\\s+CURRENTLY\\s+COMMITTED' +
  '|NOWAIT)';

/** The run of tail clauses at the end of the statement, each after whitespace or a parenthesis. */
const TRAILING_CLAUSES_RE = new RegExp(`(?:(?<=[\\s)])${TAIL_CLAUSE}\\s*)+$`, 'i');

/** Control and Unicode separator characters, which Db2 for i reads as whitespace. */
const SEPARATOR = /[\p{Cc}\p{Z}\u0085]/u;

/** Characters that end a -- comment in Db2 for i, and the other line breaks (ending early is safe). */
const LINE_END = /[\n\r\v\f\u0085\u2028\u2029]/;

/**
 * The statement with comments replaced by spaces and the contents of string
 * literals and delimited identifiers replaced by X, so every position matches
 * the original. Block comments nest, as in Db2 for i. Separator characters
 * become plain spaces. An unterminated literal or comment masks the rest of the text.
 */
function maskNonCode(sql: string): string {
  const out = sql.split('');
  let i = 0;
  const blank = (from: number, to: number, fill: string): void => {
    for (let k = from; k < to; k++) out[k] = fill;
  };
  while (i < sql.length) {
    const current = sql[i];
    const next = sql[i + 1];
    if (current === '-' && next === '-') {
      const start = i;
      i += 2;
      while (i < sql.length && !LINE_END.test(sql[i])) i++;
      blank(start, i, ' ');
      continue;
    }
    if (current === '/' && next === '*') {
      const start = i;
      i += 2;
      let depth = 1;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      blank(start, i, ' ');
      continue;
    }
    if (current === "'" || current === '"') {
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === current && sql[i + 1] === current) {
          i += 2;
          continue;
        }
        if (sql[i] === current) {
          i++;
          break;
        }
        i++;
      }
      // Keep the quotes so the literal still reads as a value, not as the end of the statement
      blank(start + 1, Math.max(start + 1, i - 1), 'X');
      continue;
    }
    // NEL and other separators are whitespace to Db2 for i but not to trimEnd() or \s
    if (SEPARATOR.test(current)) {
      out[i] = ' ';
    }
    i++;
  }
  return out.join('');
}

/** A statement split at its row limit and its trailing clauses, on code positions only. */
interface StatementParts {
  /** The statement before any trailing FETCH FIRST or LIMIT. */
  head: string;
  /** FETCH FIRST / NEXT count, LIMIT count and LIMIT's OFFSET, when there is a trailing limit. */
  limit?: { fetchCount?: string; limitCount?: string; offset?: string };
  /** Trailing clauses that must come after FETCH FIRST, with a leading space, or ''. */
  tail: string;
}

/**
 * Split a statement into the part before its row limit, the limit, and the
 * clauses after it. A trailing semicolon and trailing comments are dropped.
 */
function splitStatement(sql: string): StatementParts {
  const masked = maskNonCode(sql);
  let codeEnd = masked.trimEnd().length;
  if (masked[codeEnd - 1] === ';') {
    codeEnd = masked.slice(0, codeEnd - 1).trimEnd().length;
  }
  const code = masked.slice(0, codeEnd);

  const tailMatch = TRAILING_CLAUSES_RE.exec(code);
  const tailStart = tailMatch ? tailMatch.index : codeEnd;
  const tail = tailMatch ? ` ${sql.slice(tailStart, codeEnd).trim()}` : '';

  const before = code.slice(0, tailStart).trimEnd();
  const limitMatch = TRAILING_LIMIT_RE.exec(before);
  if (limitMatch) {
    // The clause holds no literals, so the masked groups read the same as the original
    const [, fetchCount, limitCount, offset] = limitMatch;
    return { head: sql.slice(0, limitMatch.index).trimEnd(), limit: { fetchCount, limitCount, offset }, tail };
  }
  return { head: sql.slice(0, before.length).trimEnd(), tail };
}

/**
 * Remove a trailing FETCH FIRST or LIMIT clause, if one is present.
 * Used to normalize SQL before parsing; it does not add a replacement clause.
 * Clauses that follow the limit, such as FOR READ ONLY, are kept.
 */
export function stripTrailingRowLimit(sql: string): string {
  const trimmed = sql.trim();
  const { head, limit, tail } = splitStatement(trimmed);
  if (!limit) {
    return trimmed.endsWith(';') ? trimmed.slice(0, -1).trimEnd() : trimmed;
  }
  return `${head}${tail}`;
}

/**
 * Return SQL with a row limit that does not exceed effectiveLimit.
 */
export function applySqlRowLimit(sql: string, effectiveLimit: number): string {
  const { head, limit, tail } = splitStatement(sql.trim());

  if (limit) {
    const existing = limit.limitCount ?? limit.fetchCount;
    // FETCH FIRST ROW ONLY has no count and means one row
    const clamped = Math.min(existing === undefined ? 1 : Number.parseInt(existing, 10), effectiveLimit);
    return limit.offset
      ? `${head} LIMIT ${clamped}${limit.offset}${tail}`
      : `${head} FETCH FIRST ${clamped} ROWS ONLY${tail}`;
  }

  return `${head} FETCH FIRST ${effectiveLimit} ROWS ONLY${tail}`;
}

/**
 * Cut rows fetched with applySqlRowLimit(sql, limit + 1) down to the limit.
 * The extra row only comes back when the limit left rows out, so its presence
 * sets `truncated`. A query's own smaller FETCH FIRST never reports truncation.
 */
export function takeRowsWithinLimit<T>(rows: T[], limit: number): { rows: T[]; truncated: boolean } {
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

/** Warning added to a result that stopped at the row limit. */
export function rowLimitWarning(limit: number): string {
  return `Result stopped at ${limit} rows and more rows match. Narrow the filter or aggregate, or tell the user the list is incomplete.`;
}
