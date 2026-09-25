/**
 * Cause and recovery text for a failed statement.
 *
 * Drivers report the first-level message, such as `ORDERS in MYLIB type *FILE
 * not found.` The second-level text of the SQL message says why and what to
 * change, which is what an agent needs to fix its SQL. It comes from
 * SYSTOOLS.SQLCODE_INFO, once per system and SQLCODE, or from the message
 * itself when the JDBC `errors=full` option already put it there.
 */

import type { DbPool, SqlDiagnostics } from './driver.js';
import { DbError } from './driver.js';

/** What a tool returns next to `error` when a statement fails. */
export type SqlErrorDetails = SqlDiagnostics & {
  /** Why the statement failed. May contain `&1`-style placeholders. */
  cause?: string;
  /** What to change before trying again. May contain placeholders too. */
  recovery?: string;
};

/**
 * A statement that failed on the IBM i, as the connection manager throws it.
 * `details` holds the SQLSTATE, SQLCODE, cause and recovery that were found.
 */
export class DatabaseQueryError extends Error {
  constructor(
    message: string,
    readonly details: SqlErrorDetails,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'DatabaseQueryError';
  }
}

/** Longest cause or recovery returned, in characters. */
export const MAX_PART_LENGTH = 1000;

/** Time limit for the SQLCODE_INFO lookup. */
export const LOOKUP_TIMEOUT_MS = 5_000;

const LOOKUP_SQL = 'SELECT MESSAGE_SECOND_LEVEL_TEXT FROM TABLE(SYSTOOLS.SQLCODE_INFO(?)) X';

// Headings in second-level text, with their dot leaders: `Cause . . . . . :`
const HEADING = /\b(Cause|Recovery|Technical description)\s*(?:\.\s*)+:\s*/g;

type Explanation = Pick<SqlErrorDetails, 'cause' | 'recovery'>;

// Per system and SQLCODE. The text is the same for every call, so a lookup in
// flight is shared and a finished one is kept for the life of the process.
const cache = new Map<string, Promise<Explanation | undefined>>();

// Systems where SQLCODE_INFO does not exist, so it is not asked again
const unavailable = new Set<string>();

function clean(text: string, maxLength: number): string | undefined {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) {
    return undefined;
  }
  if (flat.length <= maxLength) {
    return flat;
  }
  const cut = flat.slice(0, maxLength - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > maxLength / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Split second-level message text on its `Cause` and `Recovery` headings,
 * remove the dot leaders and cut each part to `maxLength`. Text before the
 * first heading, such as the first-level message, is returned as `lead`.
 */
export function splitSecondLevelText(
  text: string,
  maxLength: number = MAX_PART_LENGTH
): Explanation & { lead: string } {
  const headings = [...text.matchAll(HEADING)];
  const result: Explanation & { lead: string } = {
    lead: text.slice(0, headings[0]?.index ?? text.length).trim(),
  };
  headings.forEach((heading, i) => {
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[i + 1]?.index ?? text.length;
    const part = clean(text.slice(start, end), maxLength);
    if (heading[1] === 'Cause') {
      result.cause ??= part;
    } else if (heading[1] === 'Recovery') {
      result.recovery ??= part;
    }
  });
  return result;
}

/** True when the lookup failed because SYSTOOLS.SQLCODE_INFO does not exist. */
function isFunctionMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLCODE_INFO/i.test(message) && /\bSQL0204\b|\bSQL0440\b|\b42704\b|\b42884\b|not found/i.test(message);
}

async function lookUp(pool: DbPool, system: string, sqlcode: number): Promise<Explanation | undefined> {
  try {
    const rows = await pool.query(LOOKUP_SQL, [sqlcode], { timeoutMs: LOOKUP_TIMEOUT_MS });
    const text = rows[0]?.MESSAGE_SECOND_LEVEL_TEXT;
    if (typeof text !== 'string') {
      return undefined;
    }
    const { cause, recovery } = splitSecondLevelText(text);
    return cause || recovery ? { cause, recovery } : undefined;
  } catch (error) {
    if (isFunctionMissing(error)) {
      unavailable.add(system);
    }
    throw error;
  }
}

/**
 * Cause and recovery for a SQLCODE on one system, from the cache or from
 * SYSTOOLS.SQLCODE_INFO. A lookup that fails is not cached, so the next error
 * tries again, unless the function does not exist on that system.
 */
function explanationFor(pool: DbPool, system: string, sqlcode: number): Promise<Explanation | undefined> {
  const key = `${system}\u0000${Math.abs(sqlcode)}`;
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  const pending = lookUp(pool, system, sqlcode);
  cache.set(key, pending);
  pending.catch(() => {
    if (cache.get(key) === pending) {
      cache.delete(key);
    }
  });
  return pending;
}

/**
 * Details for a failed statement: its SQLSTATE and SQLCODE, plus the cause and
 * recovery when they can be found. `message` is the driver message without any
 * second-level text it already carried.
 *
 * Never throws. A failed or slow lookup leaves out cause and recovery, and
 * the error is reported as the driver gave it.
 *
 * @param error - Error thrown by the driver
 * @param pool - Pool the statement ran on, used for the lookup
 * @param system - System name, the cache key with the SQLCODE
 */
export async function explainSqlError(
  error: unknown,
  pool: DbPool,
  system: string
): Promise<{ message: string; details: SqlErrorDetails }> {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof DbError)) {
    return { message, details: {} };
  }
  const details: SqlErrorDetails = {};
  if (error.sqlstate) details.sqlstate = error.sqlstate;
  if (error.sqlcode !== undefined) details.sqlcode = error.sqlcode;

  // errors=full: the message already has the text, with its values filled in
  const inline = splitSecondLevelText(message);
  if (inline.cause || inline.recovery) {
    return { message: inline.lead, details: { ...details, cause: inline.cause, recovery: inline.recovery } };
  }

  if (error.sqlcode === undefined || unavailable.has(system)) {
    return { message, details };
  }
  try {
    const found = await explanationFor(pool, system, error.sqlcode);
    return { message, details: { ...details, ...found } };
  } catch {
    return { message, details };
  }
}

/**
 * The fields a tool adds to its error result. Empty for errors that did not
 * come from Db2, such as a rejection by the SQL validator.
 */
export function sqlErrorFields(error: unknown): SqlErrorDetails {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth++) {
    if (current instanceof DatabaseQueryError) {
      const fields: SqlErrorDetails = {};
      for (const key of ['sqlstate', 'sqlcode', 'cause', 'recovery'] as const) {
        if (current.details[key] !== undefined) {
          Object.assign(fields, { [key]: current.details[key] });
        }
      }
      return fields;
    }
    current = current.cause;
  }
  return {};
}

/** Forget every cached lookup. For tests. */
export function clearSqlErrorCache(): void {
  cache.clear();
  unavailable.clear();
}
