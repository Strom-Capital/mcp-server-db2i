/**
 * Database Connection Manager for IBM DB2i
 * 
 * Provides a unified interface for database operations that works with
 * multiple database drivers (node-jt400, mapepire).
 * 
 * The driver is selected via the DB2I_DRIVER environment variable:
 * - 'jt400' (default): Uses node-jt400 JDBC driver
 * - 'mapepire': Uses @ibm/mapepire-js native client
 */

import type { DB2iConfig } from '../config.js';
import { buildDriverConfig, getDriverType } from '../config.js';
import { driverManager, type QueryResult, type DriverType } from './drivers/index.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger({ component: 'database' });

// Re-export QueryResult type for backwards compatibility
export type { QueryResult };

/**
 * Initialize the database connection pool
 * 
 * @param config - Database configuration from loadConfig()
 */
export function initializePool(config: DB2iConfig): void {
  const driverType = getDriverType();
  log.debug({ hostname: config.hostname, port: config.port, driver: driverType }, 'Initializing connection pool');
  
  const driverConfig = buildDriverConfig(config);
  
  // Start initialization asynchronously but don't wait for it here
  // This maintains backwards compatibility with the synchronous signature
  driverManager.initialize(driverConfig).catch((error) => {
    log.error({ err: error }, 'Failed to initialize database driver');
  });
  
  log.info({ hostname: config.hostname, driver: driverType }, 'Connection pool initialization started');
}

/**
 * Initialize the database connection pool (async version)
 * 
 * Prefer this over initializePool for async contexts.
 * 
 * @param config - Database configuration from loadConfig()
 */
export async function initializePoolAsync(config: DB2iConfig): Promise<void> {
  const driverType = getDriverType();
  log.debug({ hostname: config.hostname, port: config.port, driver: driverType }, 'Initializing connection pool');
  
  const driverConfig = buildDriverConfig(config);
  await driverManager.initialize(driverConfig);
  
  log.info({ hostname: config.hostname, driver: driverType }, 'Connection pool initialized');
}

/**
 * Execute a query and return results
 * 
 * @param sql - SQL query string
 * @param params - Optional query parameters for prepared statements
 * @returns Query results
 */
export async function executeQuery(
  sql: string,
  params: unknown[] = []
): Promise<QueryResult> {
  // Ensure driver is initialized before executing
  if (!driverManager.isInitialized()) {
    throw new Error('Connection pool not initialized. Call initializePool first.');
  }

  log.debug({ sql: sql.substring(0, 200), paramCount: params.length }, 'Executing query');
  
  try {
    const result = await driverManager.executeQuery(sql, params);
    log.debug({ rowCount: result.rows.length }, 'Query completed');
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown database error';
    log.debug({ err: error, sql: sql.substring(0, 200) }, 'Database query failed');
    throw new Error(`Database query failed: ${message}`);
  }
}

/**
 * Test the database connection
 * 
 * @returns true if connection is healthy, false otherwise
 */
export async function testConnection(): Promise<boolean> {
  try {
    log.debug('Testing database connection');
    
    // Wait for initialization if still in progress
    // Give it up to 30 seconds for slow connections
    const maxWaitTime = 30000;
    const checkInterval = 100;
    let waitedTime = 0;
    
    while (!driverManager.isInitialized() && waitedTime < maxWaitTime) {
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      waitedTime += checkInterval;
    }
    
    if (!driverManager.isInitialized()) {
      log.warn('Driver not initialized after waiting');
      return false;
    }
    
    const result = await driverManager.testConnection();
    log.debug({ success: result }, 'Connection test completed');
    return result;
  } catch (error) {
    log.warn({ err: error }, 'Connection test failed');
    return false;
  }
}

/**
 * Close the database connection pool
 */
export async function closePool(): Promise<void> {
  log.info('Closing database connection pool');
  await driverManager.close();
  log.info('Database connection pool closed');
}

/**
 * Get the current driver type being used
 * 
 * @returns The driver type ('jt400' or 'mapepire') or null if not initialized
 */
export function getCurrentDriverType(): DriverType | null {
  return driverManager.getDriverType();
}

/**
 * Check if the connection pool is initialized
 * 
 * @returns true if the pool is ready to accept queries
 */
export function isPoolInitialized(): boolean {
  return driverManager.isInitialized();
}
