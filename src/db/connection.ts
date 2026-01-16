/**
 * JDBC Connection Manager for IBM DB2i using node-jt400
 */

import { pool } from 'node-jt400';
import type { Param } from 'node-jt400';
import type { DB2iConfig } from '../config.js';
import { buildConnectionConfig } from '../config.js';

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
  const connectionConfig = buildConnectionConfig(config);
  connectionPool = pool(connectionConfig);
}

/**
 * Get the connection pool instance
 */
export function getPool(): ReturnType<typeof pool> {
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
    const typedParams = toParams(params);
    const results = await db.query(sql, typedParams);
    
    return {
      rows: results as Record<string, unknown>[],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown database error';
    throw new Error(`Database query failed: ${message}`);
  }
}

/**
 * Execute a query with metadata about columns
 */
export async function executeQueryWithMetadata(
  sql: string,
  params: unknown[] = []
): Promise<QueryResult> {
  const db = getPool();

  try {
    const typedParams = toParams(params);
    const results = await db.query(sql, typedParams);
    
    return {
      rows: results as Record<string, unknown>[],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown database error';
    throw new Error(`Database query failed: ${message}`);
  }
}

/**
 * Test the database connection
 */
export async function testConnection(): Promise<boolean> {
  try {
    await executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Close the connection pool
 */
export async function closePool(): Promise<void> {
  if (connectionPool) {
    // node-jt400 pool doesn't have explicit close, but we can clear the reference
    connectionPool = null;
  }
}
