/**
 * JDBC Connection Manager for IBM DB2i using node-jt400
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

let connectionPool: ReturnType<typeof pool> | null = null;

/**
 * Initialize the connection pool
 */
export function initializePool(config: DB2iConfig): void {
  log.debug({ hostname: config.hostname, port: config.port }, 'Initializing connection pool');
  const connectionConfig = buildConnectionConfig(config);
  connectionPool = pool(connectionConfig);
  log.info({ hostname: config.hostname }, 'Connection pool created');
}

/**
 * Get the connection pool instance (internal use only)
 */
function getPool(): ReturnType<typeof pool> {
  if (!connectionPool) {
    throw new Error('Connection pool not initialized. Call initializePool first.');
  }
  return connectionPool;
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
 */
export async function executeQuery(
  sql: string,
  params: unknown[] = []
): Promise<QueryResult> {
  const db = getPool();

  try {
    log.debug({ sql: sql.substring(0, 200), paramCount: params.length }, 'Executing query');
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
 * Test the database connection
 */
export async function testConnection(): Promise<boolean> {
  try {
    log.debug('Testing database connection');
    await executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
    log.debug('Connection test successful');
    return true;
  } catch (error) {
    log.warn({ err: error }, 'Connection test failed');
    return false;
  }
}
