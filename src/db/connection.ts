/**
 * Connection pool manager for IBM DB2i.
 *
 * Supports both:
 * - Global pool: For stdio transport (single user, env-based config)
 * - Session pools: For HTTP transport (per-user, token-based config)
 *
 * The driver (JT400 over JDBC, or ODBC) is selected by DB2I_DRIVER and loaded
 * on first use, so pools are created lazily by the first query. Registering a
 * pool is synchronous; nothing connects until a statement runs.
 */

import type { DB2iConfig } from '../config.js';
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

/** A registered pool. `pool` is set by the first query and cleared on failure. */
interface PoolSlot {
  config: DB2iConfig;
  readOnly: boolean;
  label: string;
  pool?: Promise<DbPool>;
}

// Global pool for stdio transport (backwards compatible)
let globalSlot: PoolSlot | null = null;

// Session pools for HTTP transport (keyed by session/token ID)
const sessionSlots = new Map<string, PoolSlot>();

// QSYS2.GENERATE_SQL is rejected on a read-only connection, so DDL generation
// uses a second pool without the driver's read-only setting. It runs only the CALL.
let globalProcedureSlot: PoolSlot | null = null;
const sessionProcedureSlots = new Map<string, PoolSlot>();

function shortId(sessionId: string): string {
  return sessionId.substring(0, 8);
}

/**
 * Initialize the global connection pool (for stdio transport)
 *
 * Safe to call multiple times - will skip if pool already exists.
 */
export function initializePool(config: DB2iConfig): void {
  if (globalSlot) {
    globalSlot.config = config;
    log.debug({ hostname: config.hostname }, 'Global pool already exists, skipping initialization');
    return;
  }

  log.debug(
    { hostname: config.hostname, port: config.port, driver: config.driver },
    'Initializing global connection pool'
  );
  globalSlot = { config, readOnly: true, label: 'Global connection pool' };
  log.info({ hostname: config.hostname, driver: config.driver }, 'Global connection pool registered');
}

/**
 * Initialize a session-specific connection pool (for HTTP transport)
 *
 * @param sessionId - Unique session identifier (typically the auth token)
 * @param config - DB2i configuration for this session
 */
export function initializeSessionPool(sessionId: string, config: DB2iConfig): void {
  const existing = sessionSlots.get(sessionId);
  if (existing) {
    existing.config = config;
    log.debug({ sessionId: shortId(sessionId) }, 'Session pool already exists');
    return;
  }

  log.debug(
    { sessionId: shortId(sessionId), hostname: config.hostname, driver: config.driver },
    'Initializing session connection pool'
  );
  sessionSlots.set(sessionId, { config, readOnly: true, label: 'Session connection pool' });
  log.info(
    {
      sessionId: shortId(sessionId),
      hostname: config.hostname,
      driver: config.driver,
      poolCount: sessionSlots.size,
    },
    'Session connection pool registered'
  );
}

/**
 * Close a session-specific connection pool
 *
 * @param sessionId - The session identifier
 * @returns Promise that resolves when the pool is closed
 */
export async function closeSessionPool(sessionId: string): Promise<void> {
  const procedureSlot = sessionProcedureSlots.get(sessionId);
  if (procedureSlot) {
    sessionProcedureSlots.delete(sessionId);
    await closeSlot(procedureSlot, sessionId);
  }

  const slot = sessionSlots.get(sessionId);
  if (slot) {
    // Remove first so a broken pool is never retried
    sessionSlots.delete(sessionId);
    await closeSlot(slot, sessionId);
  }
}

/**
 * Close all session connection pools (for shutdown)
 *
 * @returns Promise that resolves when all pools are closed
 */
export async function closeAllSessionPools(): Promise<void> {
  const poolCount = sessionSlots.size;
  if (poolCount === 0) {
    return;
  }

  log.info({ poolCount }, 'Closing all session connection pools');

  const closePromises = Array.from(sessionSlots.keys()).map((sessionId) =>
    closeSessionPool(sessionId)
  );

  await Promise.all(closePromises);
  log.info('All session connection pools closed');
}

/**
 * Close the global connection pool (for shutdown)
 *
 * @returns Promise that resolves when the pool is closed
 */
export async function closeGlobalPool(): Promise<void> {
  if (globalProcedureSlot) {
    const slot = globalProcedureSlot;
    globalProcedureSlot = null;
    await closeSlot(slot);
  }

  if (globalSlot) {
    const slot = globalSlot;
    globalSlot = null;
    await closeSlot(slot);
  }
}

/**
 * Close the pool behind a slot, if one was ever created. A slot that never
 * ran a query has nothing to close.
 */
async function closeSlot(slot: PoolSlot, sessionId?: string): Promise<void> {
  const pending = slot.pool;
  slot.pool = undefined;
  if (!pending) {
    return;
  }
  const context = sessionId
    ? { sessionId: shortId(sessionId), poolCount: sessionSlots.size }
    : {};
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
function acquire(slot: PoolSlot, sessionId?: string): Promise<DbPool> {
  if (slot.pool) {
    return slot.pool;
  }
  const context = sessionId ? { sessionId: shortId(sessionId) } : {};
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

/**
 * Get the appropriate slot - session slot if sessionId provided, otherwise global
 */
function getSlot(sessionId?: string): PoolSlot {
  if (sessionId) {
    const slot = sessionSlots.get(sessionId);
    if (!slot) {
      throw new Error(`Session pool not found for session: ${shortId(sessionId)}...`);
    }
    return slot;
  }
  if (!globalSlot) {
    throw new Error('Global connection pool not initialized. Call initializePool first.');
  }
  return globalSlot;
}

/**
 * Slot for QSYS2.GENERATE_SQL. Created on first use from the same credentials
 * as the query pool, without the driver's read-only setting.
 */
function getProcedureSlot(sessionId?: string): PoolSlot {
  if (sessionId) {
    const existing = sessionProcedureSlots.get(sessionId);
    if (existing) {
      return existing;
    }
    const { config } = getSlot(sessionId);
    const created: PoolSlot = { config, readOnly: false, label: 'Session procedure pool' };
    sessionProcedureSlots.set(sessionId, created);
    return created;
  }

  if (globalProcedureSlot) {
    return globalProcedureSlot;
  }
  const { config } = getSlot();
  globalProcedureSlot = { config, readOnly: false, label: 'Procedure connection pool' };
  return globalProcedureSlot;
}

/**
 * Execute a query and return results
 *
 * @param sql - SQL query to execute
 * @param params - Query parameters
 * @param sessionId - Optional session ID for HTTP transport
 */
export async function executeQuery(
  sql: string,
  params: unknown[] = [],
  sessionId?: string
): Promise<QueryResult> {
  const slot = getSlot(sessionId);

  try {
    log.debug(
      { sql: sql.substring(0, 200), paramCount: params.length, sessionId: sessionId && shortId(sessionId) },
      'Executing query'
    );
    const db = await acquire(slot, sessionId);
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
 * @param sessionId - Optional session ID for HTTP transport
 */
export async function executeProcedure(
  sql: string,
  params: unknown[] = [],
  sessionId?: string
): Promise<QueryResult> {
  const slot = getProcedureSlot(sessionId);

  try {
    log.debug(
      { sql: sql.substring(0, 200), paramCount: params.length, sessionId: sessionId && shortId(sessionId) },
      'Executing procedure'
    );
    const db = await acquire(slot, sessionId);
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
 * Test the global database connection (for stdio transport)
 */
export async function testConnection(): Promise<boolean> {
  try {
    log.debug('Testing global database connection');
    await executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
    log.debug('Connection test successful');
    return true;
  } catch (error) {
    log.warn({ err: error }, 'Connection test failed');
    return false;
  }
}

/**
 * Test a session-specific database connection (for HTTP transport)
 *
 * @param sessionId - The session identifier
 */
export async function testSessionConnection(sessionId: string): Promise<boolean> {
  try {
    log.debug({ sessionId: shortId(sessionId) }, 'Testing session database connection');
    await executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1', [], sessionId);
    log.debug({ sessionId: shortId(sessionId) }, 'Session connection test successful');
    return true;
  } catch (error) {
    log.warn({ err: error, sessionId: shortId(sessionId) }, 'Session connection test failed');
    return false;
  }
}

/**
 * Check if a session pool exists
 */
export function hasSessionPool(sessionId: string): boolean {
  return sessionSlots.has(sessionId);
}

/**
 * Get count of active session pools
 */
export function getSessionPoolCount(): number {
  return sessionSlots.size;
}
