/**
 * Database driver interface.
 *
 * connection.ts manages pools; a driver knows how to create one. Each driver
 * module is loaded with a dynamic import on first use, so an ODBC install never
 * resolves node-jt400 or starts a JVM, a JT400 install never loads libodbc, and
 * neither loads the Mapepire client or ssh2.
 */

import type { DB2iConfig, DbDriverName } from '../config.js';

export type QueryParam = string | number | Date | null;

export interface DbQueryOptions {
  /** Milliseconds before the statement is cancelled on the IBM i. 0 means no limit. */
  timeoutMs: number;
  /**
   * Cancel the statement running in another job with QSYS2.CANCEL_SQL. For
   * drivers that know the job name but cannot cancel on their own connection.
   */
  cancelJob?: (jobName: string) => Promise<void>;
  /**
   * The statement returns no result set, such as a CALL of a procedure
   * without one. JT400 fails such a statement when it is read as a query.
   */
  noResultSet?: boolean;
}

export interface DbPool {
  /** Run a statement with positional `?` parameters and return its rows. */
  query(
    sql: string,
    params: readonly QueryParam[],
    options?: DbQueryOptions
  ): Promise<Record<string, unknown>[]>;
  /** Close every connection in the pool. */
  close(): Promise<void>;
}

export interface CreatePoolOptions {
  /**
   * When false, omit the driver's read-only setting so QSYS2.GENERATE_SQL can
   * return its result set. The default connection stays read only.
   */
  readOnly: boolean;
}

export interface DbDriver {
  readonly name: DbDriverName;
  createPool(config: DB2iConfig, options: CreatePoolOptions): Promise<DbPool>;
}

async function importDriver(name: DbDriverName): Promise<DbDriver> {
  switch (name) {
    case 'jt400': {
      const mod = await import('./drivers/jt400.js');
      return mod.jt400Driver;
    }
    case 'odbc': {
      const mod = await import('./drivers/odbc.js');
      return mod.odbcDriver;
    }
    case 'mapepire': {
      const mod = await import('./drivers/mapepire.js');
      return mod.mapepireDriver;
    }
    default: {
      const unknown: never = name;
      throw new Error(`Unknown database driver: ${String(unknown)}`);
    }
  }
}

// One import per driver, shared by every pool that asks for it concurrently
// (several HTTP sessions can open their first connection at the same time).
// A failed import is forgotten so the next pool tries again.
const loading = new Map<DbDriverName, Promise<DbDriver>>();

/**
 * Load the driver module for the configured name.
 */
export function loadDriver(name: DbDriverName): Promise<DbDriver> {
  const existing = loading.get(name);
  if (existing) {
    return existing;
  }
  const pending = importDriver(name);
  loading.set(name, pending);
  pending.catch(() => {
    if (loading.get(name) === pending) {
      loading.delete(name);
    }
  });
  return pending;
}

/** How long a cancelled statement gets to end before the caller stops waiting. */
export const CANCEL_GRACE_MS = 10_000;

/**
 * A statement ran past its time limit. `cancelled` is false when the cancel
 * failed, in which case the statement may still be running on the IBM i.
 */
export class QueryTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly cancelled: boolean,
    options?: ErrorOptions
  ) {
    const seconds = Math.round(timeoutMs / 100) / 10;
    const hint = 'Narrow the filter, or add a condition on an indexed column.';
    super(
      cancelled
        ? `Query cancelled on the IBM i after ${seconds} seconds (QUERY_TIMEOUT). ${hint}`
        : `Query stopped after ${seconds} seconds (QUERY_TIMEOUT), but it could not be cancelled and may still be running on the IBM i. ${hint}`,
      options
    );
    this.name = 'QueryTimeoutError';
  }
}

/**
 * Settle with `execution`, unless it runs past `timeoutMs`. Then call `cancel`
 * and reject with a QueryTimeoutError, even when the cancelled statement
 * returns rows: a cancelled statement's result is not the answer.
 *
 * After a successful cancel the rejection waits up to CANCEL_GRACE_MS for the
 * statement to end, so its connection is idle again before the caller moves on.
 * A failed cancel rejects at once. `execution` is always observed, so a late
 * failure never becomes an unhandled rejection.
 */
export function withQueryTimeout<T>(
  execution: Promise<T>,
  timeoutMs: number,
  cancel: () => Promise<void>
): Promise<T> {
  if (timeoutMs <= 0) {
    return execution;
  }
  return new Promise<T>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      cancel().then(
        () => {
          const fail = (): void => reject(new QueryTimeoutError(timeoutMs, true));
          const grace = setTimeout(fail, CANCEL_GRACE_MS);
          const ended = (): void => {
            clearTimeout(grace);
            fail();
          };
          execution.then(ended, ended);
        },
        (error: unknown) => reject(new QueryTimeoutError(timeoutMs, false, { cause: error }))
      );
    }, timeoutMs);
    execution.then(
      (value) => {
        if (!timedOut) {
          clearTimeout(timer);
          resolve(value);
        }
      },
      (error: unknown) => {
        if (!timedOut) {
          clearTimeout(timer);
          reject(error);
        }
      }
    );
  });
}

/**
 * Narrow caller parameters to what the drivers bind. `undefined` entries are
 * dropped; anything that is not a string, number, Date or null becomes a string.
 */
export function toParams(params: readonly unknown[]): QueryParam[] {
  return params
    .filter((p) => p !== undefined)
    .map((p) => {
      if (p === null) return null;
      if (typeof p === 'string') return p;
      if (typeof p === 'number') return p;
      if (p instanceof Date) return p;
      return String(p);
    });
}

/**
 * Db2 for i accepts `YYYY-MM-DD HH:MM:SS.ffffff` for a timestamp parameter.
 * The value is rendered in UTC, the same instant a Date represents.
 */
export function toDb2Timestamp(date: Date): string {
  return `${date.toISOString().slice(0, 23).replace('T', ' ')}000`;
}

const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Make row values safe for JSON. node-odbc returns BIGINT as a `bigint`, which
 * `JSON.stringify` rejects. A value within the safe integer range becomes a
 * number, and a larger one an exact string, the same as Mapepire returns.
 * Rows are changed in place; drivers hand over fresh row objects.
 */
export function toJsonSafeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      const value = row[key];
      if (typeof value === 'bigint') {
        row[key] = value >= MIN_SAFE && value <= MAX_SAFE ? Number(value) : value.toString();
      }
    }
  }
  return rows;
}
