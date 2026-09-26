/**
 * Connection pool manager for IBM Db2i.
 *
 * Pools are owned by a caller (`stdio`, or an HTTP session key) and kept per
 * IBM i system, so one caller can hold a pool on each configured system.
 *
 * The driver (JT400 over JDBC, or ODBC) comes from each system's config and is
 * loaded on first use, so pools are created lazily by the first query. Registering a
 * pool is synchronous; nothing connects until a statement runs.
 */

import type { DB2iConfig } from '../config.js';
import { queryTimeoutMs } from '../config.js';
import { DEFAULT_SYSTEM_NAME, STDIO_POOL_KEY, type DbTarget } from '../systems.js';
import type { DbPool, DbRows, RowCursor } from './driver.js';
import { loadDriver, QueryTimeoutError, toJsonSafeRows, toParams } from './driver.js';
import { DatabaseQueryError, explainSqlError } from './sqlErrorInfo.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger({ component: 'database' });

export interface QueryResult {
  rows: Record<string, unknown>[];
  /** Columns whose values the driver rounded (DECIMAL past 15 digits on ODBC). */
  roundedColumns?: string[];
}

/** One pool. `pool` is set by the first query and cleared on failure. */
interface PoolSlot {
  config: DB2iConfig;
  readOnly: boolean;
  label: string;
  pool?: Promise<DbPool>;
}

/**
 * Pools owned by one caller: `stdio`, or an HTTP session key. Keyed by system,
 * then by read-only query pool and procedure pool.
 */
interface Owner {
  label: string;
  systems: Map<string, { query: PoolSlot; procedure?: PoolSlot }>;
}

const owners = new Map<string, Owner>();

// Pools whose close() has started and not finished, for the shutdown deadline log
const closingPools = new Set<string>();

// Systems whose failed cancel was already logged, so a runaway query per call
// does not repeat the same warning
const cancelWarned = new Set<string>();

/** Time limit for the QSYS2.CANCEL_SQL call itself. */
const CANCEL_CALL_TIMEOUT_MS = 15_000;

// The target used when a caller passes none: the stdio owner's default system.
// Set by initializePool, for the CLI and code paths that predate systems.
let globalTarget: DbTarget | null = null;

function shortId(poolKey: string): string {
  return poolKey.substring(0, 8);
}

function logContext(target: DbTarget): Record<string, unknown> {
  return target.poolKey === STDIO_POOL_KEY
    ? { system: target.system }
    : { sessionId: shortId(target.poolKey), system: target.system };
}

/**
 * Initialize the stdio pools, and make `system` the target for calls that
 * pass none. Safe to call more than once; a new config applies to pools that
 * have not connected yet.
 */
export function initializePool(config: DB2iConfig, system: string = DEFAULT_SYSTEM_NAME): void {
  registerOwner(STDIO_POOL_KEY, 'Global');
  globalTarget = {
    poolKey: STDIO_POOL_KEY,
    system,
    config,
    allowedSchemas: undefined,
    defaultSchema: config.schema || undefined,
  };
  const slot = owners.get(STDIO_POOL_KEY)?.systems.get(system);
  if (slot) {
    slot.query.config = config;
    if (slot.procedure) {
      slot.procedure.config = config;
    }
  }
  log.info({ hostname: config.hostname, driver: config.driver, system }, 'Global connection pool registered');
}

/**
 * Allow pools for an HTTP session key. Pools for each system are created on
 * that system's first query. A key that was never registered, or was closed,
 * cannot open a connection.
 */
export function initializeSessionPool(sessionId: string): void {
  if (owners.has(sessionId)) {
    log.debug({ sessionId: shortId(sessionId) }, 'Session pool already exists');
    return;
  }
  registerOwner(sessionId, 'Session');
  log.info(
    { sessionId: shortId(sessionId), poolCount: getSessionPoolCount() },
    'Session connection pool registered'
  );
}

function registerOwner(poolKey: string, label: string): void {
  if (!owners.has(poolKey)) {
    owners.set(poolKey, { label, systems: new Map() });
  }
}

/**
 * Close every pool a session key owns, on every system.
 */
export async function closeSessionPool(sessionId: string): Promise<void> {
  const owner = owners.get(sessionId);
  if (!owner) {
    return;
  }
  // Remove first so a closed session never reopens a pool
  owners.delete(sessionId);
  await closeOwner(owner, sessionId);
}

/**
 * Close all session connection pools (for shutdown)
 */
export async function closeAllSessionPools(): Promise<void> {
  const keys = [...owners.keys()].filter((key) => key !== STDIO_POOL_KEY);
  if (keys.length === 0) {
    return;
  }

  log.info({ poolCount: keys.length }, 'Closing all session connection pools');
  await Promise.all(keys.map((key) => closeSessionPool(key)));
  log.info('All session connection pools closed');
}

/**
 * Close the stdio pools on every system (for shutdown)
 */
export async function closeGlobalPool(): Promise<void> {
  globalTarget = null;
  const owner = owners.get(STDIO_POOL_KEY);
  if (!owner) {
    return;
  }
  owners.delete(STDIO_POOL_KEY);
  await closeOwner(owner);
}

async function closeOwner(owner: Owner, sessionId?: string): Promise<void> {
  const slots = [...owner.systems.entries()].flatMap(([system, pair]) =>
    [pair.procedure, pair.query]
      .filter((slot): slot is PoolSlot => slot !== undefined)
      .map((slot) => ({ system, slot }))
  );
  // Procedure pools first, as before systems existed
  for (const { system, slot } of slots) {
    await closeSlot(slot, system, sessionId);
  }
}

/**
 * Close the pool behind a slot, if one was ever created. A slot that never
 * ran a query has nothing to close.
 */
async function closeSlot(slot: PoolSlot, system: string, sessionId?: string): Promise<void> {
  const pending = slot.pool;
  slot.pool = undefined;
  if (!pending) {
    return;
  }
  const context = sessionId
    ? { sessionId: shortId(sessionId), system, poolCount: getSessionPoolCount() }
    : { system };
  const name = sessionId ? `${slot.label} (${shortId(sessionId)}, ${system})` : `${slot.label} (${system})`;
  closingPools.add(name);
  try {
    const pool = await pending;
    await pool.close();
    log.info(context, `${slot.label} closed`);
  } catch (err) {
    log.warn({ err, ...context }, `Error closing ${slot.label.toLowerCase()}`);
  } finally {
    closingPools.delete(name);
  }
}

/**
 * Pools that started closing and have not finished, for example because a
 * statement is still running on them.
 */
export function pendingPoolCloses(): string[] {
  return [...closingPools];
}

/**
 * Get the pool behind a slot, creating it on first use. A failed creation is
 * forgotten so the next query tries again.
 */
function acquire(slot: PoolSlot, target: DbTarget): Promise<DbPool> {
  if (slot.pool) {
    return slot.pool;
  }
  const context = logContext(target);
  const created = loadDriver(slot.config.driver).then((driver) =>
    driver.createPool(slot.config, { readOnly: slot.readOnly })
  );
  slot.pool = created;
  created.then(
    () => {
      log.info({ ...context, driver: slot.config.driver }, `${slot.label} created`);
    },
    (err: unknown) => {
      if (slot.pool === created) {
        slot.pool = undefined;
      }
      log.debug({ err, ...context }, `${slot.label} could not be created`);
    }
  );
  return created;
}

function resolve(target: DbTarget | undefined): DbTarget {
  if (target) {
    return target;
  }
  if (!globalTarget) {
    throw new Error('Global connection pool not initialized. Call initializePool first.');
  }
  return globalTarget;
}

/**
 * Get the slot for a target, registering it on the owner's first query to
 * that system. The owner must already be registered.
 */
function getSlot(target: DbTarget, procedure: boolean): PoolSlot {
  const owner = owners.get(target.poolKey);
  if (!owner) {
    if (target.poolKey === STDIO_POOL_KEY) {
      throw new Error('Global connection pool not initialized. Call initializePool first.');
    }
    throw new Error(`Session pool not found for session: ${shortId(target.poolKey)}...`);
  }

  let pair = owner.systems.get(target.system);
  if (!pair) {
    pair = {
      query: { config: target.config, readOnly: true, label: `${owner.label} connection pool` },
    };
    owner.systems.set(target.system, pair);
  }
  if (!procedure) {
    return pair.query;
  }
  // QSYS2.GENERATE_SQL is rejected on a read-only connection, so DDL generation
  // uses a second pool without the driver's read-only setting. It runs only the CALL.
  pair.procedure ??= {
    config: pair.query.config,
    readOnly: false,
    label: `${owner.label} procedure pool`,
  };
  return pair.procedure;
}

/**
 * Execute a SQL query on the read-only pool.
 *
 * @param sql - SQL query to execute
 * @param params - Query parameters
 * @param target - Caller and system. Omit for the stdio default system.
 */
export async function executeQuery(
  sql: string,
  params: unknown[] = [],
  target?: DbTarget
): Promise<QueryResult> {
  return run(sql, params, target, false);
}

/**
 * Run a statement on the procedure pool and return its result set.
 * Used for QSYS2.GENERATE_SQL, which a read-only connection rejects.
 *
 * @param sql - Statement to execute. Callers must not pass user SQL text.
 * @param params - Statement parameters
 * @param target - Caller and system. Omit for the stdio default system.
 */
export async function executeProcedure(
  sql: string,
  params: unknown[] = [],
  target?: DbTarget
): Promise<QueryResult> {
  return run(sql, params, target, true);
}

async function run(
  sql: string,
  params: unknown[],
  target: DbTarget | undefined,
  procedure: boolean
): Promise<QueryResult> {
  const resolved = resolve(target);
  const slot = getSlot(resolved, procedure);
  const kind = procedure ? 'Procedure' : 'Query';
  let db: DbPool | undefined;

  try {
    log.debug(
      { sql: sql.substring(0, 200), paramCount: params.length, ...logContext(resolved) },
      procedure ? 'Executing procedure' : 'Executing query'
    );
    db = await acquire(slot, resolved);
    const timeoutMs = queryTimeoutMs(slot.config);
    const warmUp = scheduleCancelWarmUp(slot, resolved, procedure, timeoutMs);
    let rawRows: DbRows;
    try {
      rawRows = await db.query(sql, toParams(params), {
        timeoutMs,
        cancelJob: (jobName) => cancelSql(jobName, resolved),
      });
    } finally {
      clearTimeout(warmUp);
    }
    // BIGINT and binary values from ODBC are not JSON; convert them once, for every output path
    const rows = toJsonSafeRows(Array.from(rawRows));
    log.debug({ rowCount: rows.length }, `${kind} completed`);
    const { roundedColumns } = rawRows;
    return roundedColumns ? { rows, roundedColumns } : { rows };
  } catch (error) {
    if (error instanceof QueryTimeoutError) {
      logTimeout(error, resolved, slot.config.driver, sql);
    }
    log.debug({ err: error, sql: sql.substring(0, 200) }, procedure ? 'Procedure call failed' : 'Database query failed');
    if (!db) {
      const message = error instanceof Error ? error.message : 'Unknown database error';
      throw new Error(`Database query failed: ${message}`, { cause: error });
    }
    const { message, details } = await explainSqlError(error, db, resolved.system);
    throw new DatabaseQueryError(`Database query failed: ${message}`, details, { cause: error });
  }
}

/**
 * Open a cursor on the read-only pool, for reading a large result a batch at
 * a time. The cursor holds one connection or job until it is closed, so the
 * caller must close it in a `finally`. Aborting `signal` cancels the statement
 * on the IBM i, the same way QUERY_TIMEOUT does for executeQuery.
 *
 * @param sql - A statement that already passed prepareReadQuery
 * @param params - Query parameters
 * @param target - Caller and system. Omit for the stdio default system.
 * @param options - Rows per fetch, the caller's time limit, and the abort signal
 */
export async function openQueryCursor(
  sql: string,
  params: unknown[],
  target: DbTarget | undefined,
  options: { fetchSize: number; timeoutMs: number; signal?: AbortSignal }
): Promise<RowCursor> {
  const resolved = resolve(target);
  const slot = getSlot(resolved, false);
  let db: DbPool | undefined;
  let warmUp: NodeJS.Timeout | undefined;

  const explain = async (error: unknown, pool: DbPool | undefined): Promise<Error> => {
    log.debug({ err: error, sql: sql.substring(0, 200) }, 'Cursor query failed');
    if (!pool) {
      const message = error instanceof Error ? error.message : 'Unknown database error';
      return new Error(`Database query failed: ${message}`, { cause: error });
    }
    const { message, details } = await explainSqlError(error, pool, resolved.system);
    return new DatabaseQueryError(`Database query failed: ${message}`, details, { cause: error });
  };

  try {
    log.debug(
      { sql: sql.substring(0, 200), paramCount: params.length, ...logContext(resolved) },
      'Opening cursor'
    );
    db = await acquire(slot, resolved);
    if (!db.openCursor) {
      throw new Error(`The ${slot.config.driver} driver cannot read results in batches`);
    }
    warmUp = scheduleCancelWarmUp(slot, resolved, false, options.timeoutMs);
    const cursor = await db.openCursor(sql, toParams(params), {
      fetchSize: options.fetchSize,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      cancelJob: (jobName) => cancelSql(jobName, resolved),
    });
    const pool = db;
    return {
      columns: cursor.columns,
      async next() {
        try {
          return await cursor.next();
        } catch (error) {
          throw await explain(error, pool);
        }
      },
      async close() {
        clearTimeout(warmUp);
        await cursor.close();
      },
    };
  } catch (error) {
    clearTimeout(warmUp);
    throw await explain(error, db);
  }
}

/**
 * Cancel the statement running in another job with QSYS2.CANCEL_SQL. A
 * read-only connection rejects the CALL, so it runs on the procedure pool.
 * It needs *JOBCTL special authority or the QIBM_DB_SQLADM function usage.
 */
async function cancelSql(jobName: string, target: DbTarget): Promise<void> {
  const slot = getSlot(target, true);
  const db = await acquire(slot, target);
  await db.query('CALL QSYS2.CANCEL_SQL(?)', [jobName], {
    timeoutMs: CANCEL_CALL_TIMEOUT_MS,
    noResultSet: true,
  });
  log.debug({ job: jobName, ...logContext(target) }, 'Statement cancelled with QSYS2.CANCEL_SQL');
}

/**
 * jt400 and mapepire cancel on the procedure pool, and a Mapepire job there
 * takes seconds to start. Once a statement has used half its time limit, open
 * that pool in the background so the cancel does not wait for it. ODBC cancels
 * on the statement's own connection and needs nothing.
 */
function scheduleCancelWarmUp(
  slot: PoolSlot,
  target: DbTarget,
  procedure: boolean,
  timeoutMs: number
): NodeJS.Timeout | undefined {
  if (timeoutMs <= 0 || procedure || slot.config.driver === 'odbc') {
    return undefined;
  }
  const timer = setTimeout(() => {
    // getSlot throws once the session has closed, so it runs inside the chain
    void Promise.resolve()
      .then(() => acquire(getSlot(target, true), target))
      .then((db) => db.query('VALUES 1', [], { timeoutMs: CANCEL_CALL_TIMEOUT_MS }))
      .catch((err: unknown) => {
        log.debug({ err, ...logContext(target) }, 'Could not open the pool QSYS2.CANCEL_SQL runs on');
      });
  }, timeoutMs / 2);
  timer.unref();
  return timer;
}

function logTimeout(error: QueryTimeoutError, target: DbTarget, driver: string, sql: string): void {
  const context = { ...logContext(target), driver, timeoutMs: error.timeoutMs, sql: sql.substring(0, 200) };
  if (error.cancelled) {
    log.info(context, 'Statement cancelled after QUERY_TIMEOUT');
    return;
  }
  if (cancelWarned.has(target.system)) {
    log.info({ ...context, err: error.cause }, 'Statement passed QUERY_TIMEOUT and could not be cancelled');
    return;
  }
  cancelWarned.add(target.system);
  log.warn(
    { ...context, err: error.cause },
    'Statement passed QUERY_TIMEOUT and could not be cancelled, so it may still be running on the IBM i. ' +
      'The jt400 and mapepire drivers cancel with QSYS2.CANCEL_SQL, which needs *JOBCTL special authority ' +
      'or the QIBM_DB_SQLADM function usage. The odbc driver cancels without either.'
  );
}

/**
 * Test a connection. Omit the target for the stdio default system.
 */
export async function testConnection(target?: DbTarget): Promise<boolean> {
  try {
    log.debug(target ? logContext(target) : {}, 'Testing database connection');
    await executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1', [], target);
    log.debug('Connection test successful');
    return true;
  } catch (error) {
    log.warn({ err: error, ...(target ? logContext(target) : {}) }, 'Connection test failed');
    return false;
  }
}

/**
 * Check if a session key is registered
 */
export function hasSessionPool(sessionId: string): boolean {
  return sessionId !== STDIO_POOL_KEY && owners.has(sessionId);
}

/**
 * Get count of registered session keys
 */
export function getSessionPoolCount(): number {
  return [...owners.keys()].filter((key) => key !== STDIO_POOL_KEY).length;
}
