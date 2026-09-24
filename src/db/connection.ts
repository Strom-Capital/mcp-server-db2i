/**
 * Connection pool manager for IBM DB2i.
 *
 * Pools are owned by a caller (`stdio`, or an HTTP session key) and kept per
 * IBM i system, so one caller can hold a pool on each configured system.
 *
 * The driver (JT400 over JDBC, or ODBC) is selected by DB2I_DRIVER and loaded
 * on first use, so pools are created lazily by the first query. Registering a
 * pool is synchronous; nothing connects until a statement runs.
 */

import type { DB2iConfig } from '../config.js';
import { DEFAULT_SYSTEM_NAME, STDIO_POOL_KEY, type DbTarget } from '../systems.js';

export { STDIO_POOL_KEY };
import type { DbPool } from './driver.js';
import { loadDriver, toParams } from './driver.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger({ component: 'database' });

export interface QueryResult {
  rows: Record<string, unknown>[];
  metadata?: {
    columnCount: number;
    columns: Array<{
      name: string;
      type: string;
      precision: number;
      scale: number;
    }>;
  };
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
 * pass none. Safe to call more than once; the latest config wins.
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
  try {
    const pool = await pending;
    await pool.close();
    log.info(context, `${slot.label} closed`);
  } catch (err) {
    log.warn({ err, ...context }, `Error closing ${slot.label.toLowerCase()}`);
  }
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
 * Execute a query and return results
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
  const resolved = resolve(target);
  const slot = getSlot(resolved, false);

  try {
    log.debug(
      { sql: sql.substring(0, 200), paramCount: params.length, ...logContext(resolved) },
      'Executing query'
    );
    const db = await acquire(slot, resolved);
    const rows = await db.query(sql, toParams(params));
    log.debug({ rowCount: rows.length }, 'Query completed');

    return { rows };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown database error';
    log.debug({ err: error, sql: sql.substring(0, 200) }, 'Database query failed');
    throw new Error(`Database query failed: ${message}`, { cause: error });
  }
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
  const resolved = resolve(target);
  const slot = getSlot(resolved, true);

  try {
    log.debug(
      { sql: sql.substring(0, 200), paramCount: params.length, ...logContext(resolved) },
      'Executing procedure'
    );
    const db = await acquire(slot, resolved);
    const rows = await db.query(sql, toParams(params));
    log.debug({ rowCount: rows.length }, 'Procedure completed');
    return { rows };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown database error';
    log.debug({ err: error, sql: sql.substring(0, 200) }, 'Procedure call failed');
    throw new Error(`Database query failed: ${message}`, { cause: error });
  }
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
