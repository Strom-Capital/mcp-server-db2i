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
import type { DbColumn, DbPool, DbRows, RowCursor } from './driver.js';
import { DbError, isConnectionLost, loadDriver, QueryTimeoutError, toJsonSafeRows, toParams } from './driver.js';
import { DatabaseQueryError, explainSqlError, LOOKUP_TIMEOUT_MS, type SqlErrorDetails } from './sqlErrorInfo.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger({ component: 'database' });

export interface QueryResult {
  rows: Record<string, unknown>[];
  /** Columns whose values the driver rounded (DECIMAL past 15 digits on ODBC). */
  roundedColumns?: string[];
  /** The result set's columns in order, when the driver reported them. */
  columns?: DbColumn[];
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
  /** Statements and open cursors running on the owner's pools. */
  active: number;
  /** When the owner last started or finished using a pool. */
  lastUsed: number;
}

const owners = new Map<string, Owner>();

// MCP_POOL_IDLE_TIMEOUT in milliseconds, 0 when off, and the timer that applies it
let idleTimeoutMs = 0;
let idleSweeper: NodeJS.Timeout | undefined;

// Pools whose close() has started and not finished, for the shutdown deadline log
const closingPools = new Set<string>();

// Statements and cursors running on each pool, so a pool dropped after the IBM i
// ended its connection closes only once they have finished
const poolUsers = new Map<Promise<DbPool>, number>();

// Dropped pools that close when the last statement or cursor using them ends
const retiring = new Map<Promise<DbPool>, () => void>();

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
    owners.set(poolKey, { label, systems: new Map(), active: 0, lastUsed: Date.now() });
  }
}

/**
 * Close the connections of HTTP session keys that ran nothing for `ms`
 * (MCP_POOL_IDLE_TIMEOUT). The keys stay registered, and their next query
 * opens a new pool. Without this, odbc and jt400 pools keep a connection until
 * the token that owns them ends. The stdio pools are left alone.
 *
 * @param ms - Idle time in milliseconds before a key's pools close, 0 to turn it off
 */
export function setSessionPoolIdleTimeout(ms: number): void {
  idleTimeoutMs = ms;
  clearInterval(idleSweeper);
  idleSweeper = undefined;
  if (ms > 0) {
    idleSweeper = setInterval(() => {
      void closeIdleSessionPools();
    }, Math.min(ms, 60_000));
    idleSweeper.unref();
  }
}

/**
 * Close the pools of every HTTP session key idle past the timeout. Run by the
 * timer setSessionPoolIdleTimeout starts; exported for tests.
 *
 * @param now - Current time
 */
export async function closeIdleSessionPools(now = Date.now()): Promise<void> {
  if (idleTimeoutMs <= 0) {
    return;
  }
  const closing: Promise<void>[] = [];
  for (const [key, owner] of owners) {
    if (key === STDIO_POOL_KEY || owner.active > 0 || now - owner.lastUsed < idleTimeoutMs) {
      continue;
    }
    // Detach every open pool before the first await, so a query that arrives
    // while they close opens a new pool rather than using a closing one
    const open = [...owner.systems.entries()].flatMap(([system, pair]) =>
      [pair.procedure, pair.query]
        .filter((slot): slot is PoolSlot => slot?.pool !== undefined)
        .map((slot) => {
          const detached = { ...slot };
          slot.pool = undefined;
          return { system, slot: detached };
        })
    );
    if (open.length === 0) {
      continue;
    }
    log.info(
      { sessionId: shortId(key), idleSeconds: Math.round((now - owner.lastUsed) / 1000) },
      'Closing idle session connection pools'
    );
    closing.push(...open.map(({ system, slot }) => closeSlot(slot, system, key)));
  }
  await Promise.all(closing);
}

/** Whether any of an owner's pools has been created and not closed. */
function hasOpenPool(owner: Owner): boolean {
  return [...owner.systems.values()].some((pair) => pair.query.pool !== undefined || pair.procedure?.pool !== undefined);
}

/**
 * Count a statement or cursor as use of its owner's pools until the returned
 * function is called, so the idle timeout never closes a pool under it.
 */
function markActive(target: DbTarget): () => void {
  const owner = owners.get(target.poolKey);
  if (!owner) {
    return () => undefined;
  }
  owner.active++;
  owner.lastUsed = Date.now();
  let done = false;
  return () => {
    if (!done) {
      done = true;
      owner.active--;
      owner.lastUsed = Date.now();
    }
  };
}

/**
 * Give the pools one session key owns to another key, keeping their open
 * connections. Used to hand a credential check's pool to the token or OAuth
 * grant it proved. Nothing moves when `to` already has an open pool or a
 * statement running: the caller then closes `from`, so pools of two keys are
 * never merged. A `to` whose pools the idle timeout closed is replaced.
 *
 * @returns true when the pools moved
 */
export function moveSessionPool(from: string, to: string): boolean {
  const owner = owners.get(from);
  if (!owner || from === STDIO_POOL_KEY || to === STDIO_POOL_KEY) {
    return false;
  }
  const existing = owners.get(to);
  if (existing && (existing.active > 0 || hasOpenPool(existing))) {
    return false;
  }
  owners.delete(from);
  owners.set(to, owner);
  log.info({ from: shortId(from), sessionId: shortId(to) }, 'Session connection pool handed over');
  return true;
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

/** One statement's or cursor's use of a pool. */
interface Lease {
  db: DbPool;
  /** The slot's pool when the lease was taken, for retire(). */
  pending: Promise<DbPool>;
  /** Stop using the pool. Safe to call twice. */
  done(): void;
}

/**
 * Get the slot's pool, creating it on first use, and count the caller as a
 * user of it until `done()`. A pool that retire() dropped closes when its last
 * user is done.
 */
async function lease(slot: PoolSlot, target: DbTarget): Promise<Lease> {
  const pending = acquire(slot, target);
  poolUsers.set(pending, (poolUsers.get(pending) ?? 0) + 1);
  let finished = false;
  const done = (): void => {
    if (finished) {
      return;
    }
    finished = true;
    const users = (poolUsers.get(pending) ?? 1) - 1;
    if (users > 0) {
      poolUsers.set(pending, users);
      return;
    }
    poolUsers.delete(pending);
    const close = retiring.get(pending);
    if (close) {
      retiring.delete(pending);
      close();
    }
  };
  try {
    return { db: await pending, pending, done };
  } catch (error) {
    done();
    throw error;
  }
}

/**
 * Drop a pool whose connection the IBM i ended, so the next statement opens a
 * new one. node-odbc puts a dead connection back in its pool and hands it out
 * again, so without this every later statement fails the same way until the
 * process restarts. The old pool closes once the statements and cursors still
 * using it have ended. Nothing happens when the slot already has another pool.
 */
function retire(slot: PoolSlot, target: DbTarget, pending: Promise<DbPool>): void {
  if (slot.pool !== pending) {
    return;
  }
  slot.pool = undefined;
  log.warn(
    { ...logContext(target), driver: slot.config.driver },
    `${slot.label}: the IBM i ended the connection, so the next statement opens a new one`
  );
  const detached: PoolSlot = { ...slot, pool: pending };
  const sessionId = target.poolKey === STDIO_POOL_KEY ? undefined : target.poolKey;
  const close = (): void => {
    void closeSlot(detached, target.system, sessionId);
  };
  if (poolUsers.has(pending)) {
    retiring.set(pending, close);
  } else {
    close();
  }
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
  const release = markActive(resolved);

  try {
    log.debug(
      { sql: sql.substring(0, 200), paramCount: params.length, ...logContext(resolved) },
      procedure ? 'Executing procedure' : 'Executing query'
    );
    // A statement whose connection the IBM i ended runs once more on a new
    // pool. Safe: the query pool is read only, and the procedure pool runs only
    // QSYS2.GENERATE_SQL.
    for (let attempt = 1; ; attempt++) {
      let used: Lease | undefined;
      try {
        used = await lease(slot, resolved);
        const timeoutMs = queryTimeoutMs(slot.config);
        const warmUp = scheduleCancelWarmUp(slot, resolved, procedure, timeoutMs);
        let rawRows: DbRows;
        try {
          rawRows = await used.db.query(sql, toParams(params), {
            timeoutMs,
            cancelJob: (jobName) => cancelSql(jobName, resolved),
          });
        } finally {
          clearTimeout(warmUp);
        }
        // BIGINT and binary values from ODBC are not JSON; convert them once, for every output path
        const rows = toJsonSafeRows(Array.from(rawRows));
        log.debug({ rowCount: rows.length }, `${kind} completed`);
        const { roundedColumns, columns } = rawRows;
        return {
          rows,
          ...(roundedColumns ? { roundedColumns } : {}),
          ...(columns ? { columns } : {}),
        };
      } catch (error) {
        if (used && isConnectionLost(error)) {
          retire(slot, resolved, used.pending);
          if (attempt === 1) {
            log.info({ ...logContext(resolved) }, `${kind} lost its connection; running it again on a new one`);
            continue;
          }
        }
        if (error instanceof QueryTimeoutError) {
          logTimeout(error, resolved, slot.config.driver, sql);
        }
        log.debug({ err: error, sql: sql.substring(0, 200) }, procedure ? 'Procedure call failed' : 'Database query failed');
        if (!used) {
          const message = error instanceof Error ? error.message : 'Unknown database error';
          throw new Error(`Database query failed: ${message}`, { cause: error });
        }
        const { message, details } = await explainSqlError(error, used.db, resolved.system);
        throw new DatabaseQueryError(`Database query failed: ${message}`, details, { cause: error });
      } finally {
        used?.done();
      }
    }
  } finally {
    release();
  }
}

/** Time limit for preparing a statement to learn why Db2 rejects it, as for the SQLCODE lookup. */
export const PREPARE_TIMEOUT_MS = LOOKUP_TIMEOUT_MS;

/**
 * Why Db2 rejects a statement, found by preparing it on the read-only pool
 * without running it. For a statement QSYS2.PARSE_STATEMENT could not parse,
 * which gives no reason of its own.
 *
 * Never throws. Returns `{ accepted: true }` when Db2 prepares the statement
 * without an error, and undefined when the driver cannot prepare without
 * running (JT400), or when the prepare fails for a reason that is not a Db2
 * error or takes longer than PREPARE_TIMEOUT_MS.
 *
 * @param sql - A statement that already passed the SQL validator
 * @param target - Caller and system. Omit for the stdio default system.
 * @returns The driver message and the SQLSTATE, SQLCODE, cause and recovery
 */
export async function explainUnparsedStatement(
  sql: string,
  target?: DbTarget
): Promise<{ message: string; details: SqlErrorDetails } | { accepted: true } | undefined> {
  let resolved: DbTarget;
  try {
    resolved = resolve(target);
  } catch {
    return undefined;
  }
  const slot = getSlot(resolved, false);
  const release = markActive(resolved);
  let used: Lease | undefined;
  try {
    used = await lease(slot, resolved);
    const { db } = used;
    if (!db.prepare) {
      return undefined;
    }
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((done) => {
      timer = setTimeout(() => done('timeout'), PREPARE_TIMEOUT_MS);
      timer.unref();
    });
    const prepared = db.prepare(sql).then(
      () => 'prepared' as const,
      (error: unknown) => error
    );
    const outcome = await Promise.race([prepared, timedOut]).finally(() => clearTimeout(timer));
    if (outcome === 'prepared') {
      return { accepted: true };
    }
    if (isConnectionLost(outcome)) {
      // Not a reason Db2 rejects the statement; the next statement gets a new pool
      retire(slot, resolved, used.pending);
      return undefined;
    }
    if (!(outcome instanceof DbError)) {
      if (outcome === 'timeout') {
        log.debug({ ...logContext(resolved) }, 'Prepare to explain a parse failure timed out');
      }
      return undefined;
    }
    return await explainSqlError(outcome, db, resolved.system);
  } catch (error) {
    log.debug({ err: error, ...logContext(resolved) }, 'Prepare to explain a parse failure failed');
    return undefined;
  } finally {
    used?.done();
    release();
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
  // The cursor holds a connection until it is closed, so it counts as use until then
  const release = markActive(resolved);

  const explain = async (error: unknown, pool: DbPool | undefined): Promise<Error> => {
    log.debug({ err: error, sql: sql.substring(0, 200) }, 'Cursor query failed');
    if (!pool) {
      const message = error instanceof Error ? error.message : 'Unknown database error';
      return new Error(`Database query failed: ${message}`, { cause: error });
    }
    const { message, details } = await explainSqlError(error, pool, resolved.system);
    return new DatabaseQueryError(`Database query failed: ${message}`, details, { cause: error });
  };

  log.debug(
    { sql: sql.substring(0, 200), paramCount: params.length, ...logContext(resolved) },
    'Opening cursor'
  );
  // A cursor whose connection the IBM i ended opens once more on a new pool.
  // Once rows are handed out it is never started again.
  for (let attempt = 1; ; attempt++) {
    let used: Lease | undefined;
    let warmUp: NodeJS.Timeout | undefined;
    try {
      used = await lease(slot, resolved);
      const { db, pending, done } = used;
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
      const timer = warmUp;
      return {
        columns: cursor.columns,
        async next() {
          try {
            return await cursor.next();
          } catch (error) {
            if (isConnectionLost(error)) {
              retire(slot, resolved, pending);
            }
            throw await explain(error, db);
          }
        },
        async close() {
          clearTimeout(timer);
          try {
            await cursor.close();
          } finally {
            done();
            release();
          }
        },
      };
    } catch (error) {
      clearTimeout(warmUp);
      if (used && isConnectionLost(error)) {
        retire(slot, resolved, used.pending);
        if (attempt === 1) {
          used.done();
          log.info({ ...logContext(resolved) }, 'Cursor lost its connection while opening; opening it again on a new one');
          continue;
        }
      }
      used?.done();
      release();
      throw await explain(error, used?.db);
    }
  }
}

/**
 * Cancel the statement running in another job with QSYS2.CANCEL_SQL. A
 * read-only connection rejects the CALL, so it runs on the procedure pool.
 * It needs *JOBCTL special authority or the QIBM_DB_SQLADM function usage.
 */
async function cancelSql(jobName: string, target: DbTarget): Promise<void> {
  const slot = getSlot(target, true);
  const release = markActive(target);
  try {
    // A cancel whose connection the IBM i ended runs once more on a new pool
    for (let attempt = 1; ; attempt++) {
      const used = await lease(slot, target);
      try {
        await used.db.query('CALL QSYS2.CANCEL_SQL(?)', [jobName], {
          timeoutMs: CANCEL_CALL_TIMEOUT_MS,
          noResultSet: true,
        });
        break;
      } catch (error) {
        if (!isConnectionLost(error)) {
          throw error;
        }
        retire(slot, target, used.pending);
        if (attempt > 1) {
          throw error;
        }
      } finally {
        used.done();
      }
    }
  } finally {
    release();
  }
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
    void (async () => {
      const procedureSlot = getSlot(target, true);
      const used = await lease(procedureSlot, target);
      try {
        await used.db.query('VALUES 1', [], { timeoutMs: CANCEL_CALL_TIMEOUT_MS });
      } catch (error) {
        // The cancel then opens a new pool instead of finding a dead connection
        if (isConnectionLost(error)) {
          retire(procedureSlot, target, used.pending);
        }
        throw error;
      } finally {
        used.done();
      }
    })().catch((err: unknown) => {
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
