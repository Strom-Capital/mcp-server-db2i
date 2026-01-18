/**
 * JDBC Connection Manager for IBM DB2i using node-jt400
 * 
 * Supports both:
 * - Global pool: For stdio transport (single user, env-based config)
 * - Session pools: For HTTP transport (per-user, token-based config)
 */

import { pool } from 'node-jt400';
import type { Param } from 'node-jt400';
import type { DB2iConfig } from '../config.js';
import { buildConnectionConfig } from '../config.js';
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

// Global pool for stdio transport (backwards compatible)
let globalPool: ReturnType<typeof pool> | null = null;

// Session pools for HTTP transport (keyed by session/token ID)
const sessionPools = new Map<string, ReturnType<typeof pool>>();

/**
 * Initialize the global connection pool (for stdio transport)
 * 
 * Safe to call multiple times - will skip if pool already exists.
 */
export function initializePool(config: DB2iConfig): void {
  if (globalPool) {
    log.debug({ hostname: config.hostname }, 'Global pool already exists, skipping initialization');
    return;
  }
  
  log.debug({ hostname: config.hostname, port: config.port }, 'Initializing global connection pool');
  const connectionConfig = buildConnectionConfig(config);
  globalPool = pool(connectionConfig);
  log.info({ hostname: config.hostname }, 'Global connection pool created');
}

/**
 * Initialize a session-specific connection pool (for HTTP transport)
 * 
 * @param sessionId - Unique session identifier (typically the auth token)
 * @param config - DB2i configuration for this session
 */
export function initializeSessionPool(sessionId: string, config: DB2iConfig): void {
  // Don't recreate if already exists
  if (sessionPools.has(sessionId)) {
    log.debug({ sessionId: sessionId.substring(0, 8) }, 'Session pool already exists');
    return;
  }

  log.debug(
    { sessionId: sessionId.substring(0, 8), hostname: config.hostname },
    'Initializing session connection pool'
  );
  const connectionConfig = buildConnectionConfig(config);
  const sessionPool = pool(connectionConfig);
  sessionPools.set(sessionId, sessionPool);
  log.info(
    { sessionId: sessionId.substring(0, 8), hostname: config.hostname, poolCount: sessionPools.size },
    'Session connection pool created'
  );
}

/**
 * Close a session-specific connection pool
 * 
 * @param sessionId - The session identifier
 * @returns Promise that resolves when the pool is closed
 */
export async function closeSessionPool(sessionId: string): Promise<void> {
  const sessionPool = sessionPools.get(sessionId);
  if (sessionPool) {
    try {
      await sessionPool.close();
      sessionPools.delete(sessionId);
      log.info(
        { sessionId: sessionId.substring(0, 8), poolCount: sessionPools.size },
        'Session connection pool closed'
      );
    } catch (err) {
      // Still remove from map on error to avoid retry loops with broken pools
      sessionPools.delete(sessionId);
      log.warn(
        { err, sessionId: sessionId.substring(0, 8) },
        'Error closing session connection pool'
      );
    }
  }
}

/**
 * Close all session connection pools (for shutdown)
 * 
 * @returns Promise that resolves when all pools are closed
 */
export async function closeAllSessionPools(): Promise<void> {
  const poolCount = sessionPools.size;
  if (poolCount === 0) {
    return;
  }

  log.info({ poolCount }, 'Closing all session connection pools');
  
  const closePromises = Array.from(sessionPools.keys()).map(sessionId => 
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
  if (globalPool) {
    try {
      await globalPool.close();
      globalPool = null;
      log.info('Global connection pool closed');
    } catch (err) {
      log.warn({ err }, 'Error closing global connection pool');
    }
  }
}

/**
 * Get the global connection pool instance (internal use only)
 */
function getGlobalPool(): ReturnType<typeof pool> {
  if (!globalPool) {
    throw new Error('Global connection pool not initialized. Call initializePool first.');
  }
  return globalPool;
}

/**
 * Get a session-specific connection pool
 * 
 * @param sessionId - The session identifier
 * @returns The pool for the session, or throws if not found
 */
function getSessionPool(sessionId: string): ReturnType<typeof pool> {
  const sessionPool = sessionPools.get(sessionId);
  if (!sessionPool) {
    throw new Error(`Session pool not found for session: ${sessionId.substring(0, 8)}...`);
  }
  return sessionPool;
}

/**
 * Get the appropriate pool - session pool if sessionId provided, otherwise global
 */
function getPool(sessionId?: string): ReturnType<typeof pool> {
  if (sessionId) {
    return getSessionPool(sessionId);
  }
  return getGlobalPool();
}

/**
 * Convert unknown params to Param type, filtering out undefined
 */
function toParams(params: unknown[]): Param[] {
  return params
    .filter((p): p is string | number | Date | null => p !== undefined)
    .map((p) => {
      if (p === null) return null;
      if (typeof p === 'string') return p;
      if (typeof p === 'number') return p;
      if (p instanceof Date) return p;
      // Convert other types to string
      return String(p);
    });
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
  const db = getPool(sessionId);

  try {
    log.debug({ sql: sql.substring(0, 200), paramCount: params.length, sessionId: sessionId?.substring(0, 8) }, 'Executing query');
    const typedParams = toParams(params);
    const results = await db.query(sql, typedParams);
    const rows = results as Record<string, unknown>[];
    log.debug({ rowCount: rows.length }, 'Query completed');
    
    return { rows };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown database error';
    log.debug({ err: error, sql: sql.substring(0, 200) }, 'Database query failed');
    throw new Error(`Database query failed: ${message}`);
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
    log.debug({ sessionId: sessionId.substring(0, 8) }, 'Testing session database connection');
    await executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1', [], sessionId);
    log.debug({ sessionId: sessionId.substring(0, 8) }, 'Session connection test successful');
    return true;
  } catch (error) {
    log.warn({ err: error, sessionId: sessionId.substring(0, 8) }, 'Session connection test failed');
    return false;
  }
}

/**
 * Check if a session pool exists
 */
export function hasSessionPool(sessionId: string): boolean {
  return sessionPools.has(sessionId);
}

/**
 * Get count of active session pools
 */
export function getSessionPoolCount(): number {
  return sessionPools.size;
}
