/**
 * Apply a FETCH FIRST row cap to a SELECT statement.
 *
 * Only a trailing FETCH FIRST / FETCH NEXT / LIMIT clause is treated as an
 * existing limit. Column names such as CREDIT_LIMIT or string literals
 * containing "LIMIT" do not skip the cap. An existing trailing clause is
 * clamped to effectiveLimit rather than trusted as-is.
 */

const TRAILING_LIMIT_RE =
  /\b(?:FETCH\s+(?:FIRST|NEXT)\s+(?:(\d+)\s+)?ROWS?\s+ONLY|LIMIT\s+(\d+)(\s+OFFSET\s+\d+)?)\s*;?\s*$/i;

/**
 * Remove a trailing FETCH FIRST or LIMIT clause, if one is present.
 * Used to normalize SQL before parsing; it does not add a replacement clause.
 */
export function stripTrailingRowLimit(sql: string): string {
  const trimmed = sql.trim();
  const match = TRAILING_LIMIT_RE.exec(trimmed);
  if (match) {
    return trimmed.slice(0, match.index).trimEnd();
  }
  return withoutSemicolon(trimmed);
}

/**
 * Return SQL with a row limit that does not exceed effectiveLimit.
 */
export function applySqlRowLimit(sql: string, effectiveLimit: number): string {
  const trimmed = sql.trim();
  const match = TRAILING_LIMIT_RE.exec(trimmed);

  if (match) {
    const [, fetchCount, limitCount, offset] = match;
    const existing = limitCount ?? fetchCount;
    // FETCH FIRST ROW ONLY has no count and means one row
    const clamped = Math.min(existing === undefined ? 1 : Number.parseInt(existing, 10), effectiveLimit);
    const withoutClause = trimmed.slice(0, match.index).trimEnd();
    return offset
      ? `${withoutClause} LIMIT ${clamped}${offset}`
      : `${withoutClause} FETCH FIRST ${clamped} ROWS ONLY`;
  }

  const statement = withoutSemicolon(trimmed);
  // A clause appended after a trailing -- comment would be commented out
  const lastLine = statement.slice(statement.lastIndexOf('\n') + 1);
  const separator = lastLine.includes('--') ? '\n' : ' ';
  return `${statement}${separator}FETCH FIRST ${effectiveLimit} ROWS ONLY`;
}

function withoutSemicolon(sql: string): string {
  return sql.endsWith(';') ? sql.slice(0, -1).trimEnd() : sql;
}
