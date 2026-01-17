/**
 * JT400 Driver Implementation
 * 
 * Uses node-jt400 (JT400/JTOpen JDBC driver) to connect to IBM DB2i.
 * This is the default driver that works out of the box with any IBM i system.
 * 
 * Requirements:
 * - Java Runtime Environment on the client machine
 * - No special IBM i configuration needed
 */

import { pool } from 'node-jt400';
import type { Param } from 'node-jt400';
import type { DB2iDriver, QueryResult, DriverConfig, JT400DriverConfig } from './interface.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger({ component: 'jt400-driver' });

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
 * JT400 driver implementation using node-jt400
 */
export class JT400Driver implements DB2iDriver {
  readonly driverType = 'jt400' as const;
  
  private connectionPool: ReturnType<typeof pool> | null = null;
  private initialized = false;

  /**
   * Initialize the JT400 connection pool
   */
  async initialize(config: DriverConfig): Promise<void> {
    if (config.driver !== 'jt400') {
      throw new Error('JT400Driver requires jt400 configuration');
    }

    const jt400Config = config as JT400DriverConfig;
    
    log.debug({ hostname: jt400Config.hostname, port: jt400Config.port }, 'Initializing JT400 connection pool');
    
    const connectionConfig = this.buildConnectionConfig(jt400Config);
    this.connectionPool = pool(connectionConfig);
    this.initialized = true;
    
    log.info({ hostname: jt400Config.hostname }, 'JT400 connection pool created');
  }

  /**
   * Build JDBC connection configuration for node-jt400
   */
  private buildConnectionConfig(config: JT400DriverConfig): {
    host: string;
    user: string;
    password: string;
    [key: string]: string;
  } {
    const connectionConfig: {
      host: string;
      user: string;
      password: string;
      [key: string]: string;
    } = {
      host: config.hostname,
      user: config.username,
      password: config.password,
    };

    // Add default naming convention (system naming uses / for library separator)
    if (!config.jdbcOptions['naming']) {
      connectionConfig['naming'] = 'system';
    }

    // Add date format if not specified
    if (!config.jdbcOptions['date format']) {
      connectionConfig['date format'] = 'iso';
    }

    // Merge additional JDBC options
    for (const [key, value] of Object.entries(config.jdbcOptions)) {
      connectionConfig[key] = value;
    }

    return connectionConfig;
  }

  /**
   * Get the connection pool instance
   */
  private getPool(): ReturnType<typeof pool> {
    if (!this.connectionPool) {
      throw new Error('JT400 connection pool not initialized. Call initialize() first.');
    }
    return this.connectionPool;
  }

  /**
   * Execute a query and return results
   */
  async executeQuery(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const db = this.getPool();

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
  async testConnection(): Promise<boolean> {
    try {
      log.debug('Testing JT400 database connection');
      await this.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
      log.debug('JT400 connection test successful');
      return true;
    } catch (error) {
      log.warn({ err: error }, 'JT400 connection test failed');
      return false;
    }
  }

  /**
   * Close the connection pool
   * Note: node-jt400 pool doesn't have an explicit close method,
   * but we reset our state to allow re-initialization
   */
  async close(): Promise<void> {
    log.info('Closing JT400 connection pool');
    this.connectionPool = null;
    this.initialized = false;
  }

  /**
   * Check if the driver is initialized
   */
  isInitialized(): boolean {
    return this.initialized && this.connectionPool !== null;
  }
}
