/**
 * Apply a FETCH FIRST row cap to a SELECT statement.
 *
 * Only a trailing FETCH FIRST / LIMIT clause is treated as an existing
 * limit. Column names such as CREDIT_LIMIT or string literals containing
 * "LIMIT" do not skip the cap. An existing trailing clause is clamped
 * to effectiveLimit rather than trusted as-is.
 */

const TRAILING_LIMIT_RE =
  /\b(?:FETCH\s+FIRST\s+(\d+)\s+ROWS?\s+ONLY|LIMIT\s+(\d+))\s*;?\s*$/i;

/**
 * Return SQL with a FETCH FIRST clause that does not exceed effectiveLimit.
 */
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
  return trimmed.endsWith(';') ? trimmed.slice(0, -1).trimEnd() : trimmed;
}

export function applySqlRowLimit(sql: string, effectiveLimit: number): string {
  const trimmed = sql.trim();
  const match = TRAILING_LIMIT_RE.exec(trimmed);

  if (match) {
    const existing = Number.parseInt(match[1] ?? match[2] ?? '', 10);
    const clamped = Number.isFinite(existing)
      ? Math.min(existing, effectiveLimit)
      : effectiveLimit;
    const withoutClause = trimmed.slice(0, match.index).trimEnd();
    return `${withoutClause} FETCH FIRST ${clamped} ROWS ONLY`;
  }

  const withoutSemicolon = trimmed.endsWith(';')
    ? trimmed.slice(0, -1).trimEnd()
    : trimmed;

  return `${withoutSemicolon} FETCH FIRST ${effectiveLimit} ROWS ONLY`;
}
