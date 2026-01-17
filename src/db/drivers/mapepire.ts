/**
 * Mapepire Driver Implementation
 * 
 * Uses @ibm/mapepire-js to connect to IBM DB2i via the Mapepire server.
 * This driver provides a native TypeScript/JavaScript client without Java dependency.
 * 
 * Requirements:
 * - Mapepire server component must be installed and running on IBM i
 * - Default port: 8471
 * 
 * Benefits:
 * - No Java Runtime required on client
 * - Modern async-first design
 * - Native TypeScript support
 * 
 * @see https://github.com/Mapepire-IBMi/mapepire-js
 */

import type { DB2iDriver, QueryResult, DriverConfig, MapepireDriverConfig } from './interface.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger({ component: 'mapepire-driver' });

// Dynamic import types for optional @ibm/mapepire-js dependency
type MapepirePool = {
  init(): Promise<void>;
  execute<T = unknown>(sql: string, options?: { parameters?: unknown[] }): Promise<{
    success: boolean;
    data?: T[];
    sql_rc?: number;
    execution_time?: number;
  }>;
  end(): Promise<void>;
};

type MapepirePoolConstructor = new (options: {
  creds: {
    host: string;
    user: string;
    password: string;
    port?: number;
    rejectUnauthorized?: boolean;
    ca?: string;
  };
  maxSize?: number;
  startingSize?: number;
}) => MapepirePool;

type GetRootCertificateFn = (server: {
  host: string;
  user: string;
  password: string;
  rejectUnauthorized?: boolean;
}) => Promise<string>;

/**
 * Mapepire driver implementation using @ibm/mapepire-js
 */
export class MapepireDriver implements DB2iDriver {
  readonly driverType = 'mapepire' as const;
  
  private pool: MapepirePool | null = null;
  private initialized = false;
  private queryTimeout = 30000; // Default 30 seconds
  private mapepireModule: {
    Pool: MapepirePoolConstructor;
    getRootCertificate: GetRootCertificateFn;
  } | null = null;

  /**
   * Dynamically import @ibm/mapepire-js module
   * This allows the module to be optional - users only need it if they use mapepire driver
   */
  private async loadMapepireModule(): Promise<{
    Pool: MapepirePoolConstructor;
    getRootCertificate: GetRootCertificateFn;
  }> {
    if (this.mapepireModule) {
      return this.mapepireModule;
    }

    try {
      // Dynamic import of the optional dependency
      // Using string concatenation to prevent TypeScript from resolving the module at compile time
      const moduleName = ['@ibm', 'mapepire-js'].join('/');
      const mapepire = await import(/* webpackIgnore: true */ moduleName);
      
      // Handle both default export and named exports
      const pkg = mapepire.default || mapepire;
      
      this.mapepireModule = {
        Pool: pkg.Pool,
        getRootCertificate: pkg.getRootCertificate,
      };
      
      return this.mapepireModule;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(
        `Failed to load @ibm/mapepire-js. Please install it with: npm install @ibm/mapepire-js\n` +
        `Original error: ${message}`
      );
    }
  }

  /**
   * Initialize the Mapepire connection pool
   */
  async initialize(config: DriverConfig): Promise<void> {
    if (config.driver !== 'mapepire') {
      throw new Error('MapepireDriver requires mapepire configuration');
    }

    const mapepireConfig = config as MapepireDriverConfig;
    
    log.debug(
      { 
        hostname: mapepireConfig.hostname, 
        port: mapepireConfig.port,
        ignoreUnauthorized: mapepireConfig.ignoreUnauthorized,
        queryTimeout: mapepireConfig.queryTimeout,
      }, 
      'Initializing Mapepire connection pool'
    );

    // Security warning for insecure TLS mode
    if (mapepireConfig.ignoreUnauthorized) {
      log.warn(
        { hostname: mapepireConfig.hostname },
        'SECURITY WARNING: TLS certificate validation is disabled (MAPEPIRE_IGNORE_UNAUTHORIZED=true). ' +
        'This allows connections to servers with invalid or self-signed certificates. ' +
        'For production environments, set MAPEPIRE_IGNORE_UNAUTHORIZED=false and ensure proper SSL certificates.'
      );
    }

    // Store query timeout for later use
    this.queryTimeout = mapepireConfig.queryTimeout;

    // Load the mapepire module dynamically
    const { Pool, getRootCertificate } = await this.loadMapepireModule();

    // Prepare server credentials
    const creds: {
      host: string;
      user: string;
      password: string;
      port: number;
      rejectUnauthorized: boolean;
      ca?: string;
    } = {
      host: mapepireConfig.hostname,
      user: mapepireConfig.username,
      password: mapepireConfig.password,
      port: mapepireConfig.port,
      rejectUnauthorized: !mapepireConfig.ignoreUnauthorized,
    };

    // Get SSL certificate if needed (when not ignoring unauthorized)
    // Note: This uses a Trust-On-First-Use (TOFU) pattern - the initial connection
    // to fetch the certificate is made without validation. See README for security implications.
    if (!mapepireConfig.ignoreUnauthorized) {
      log.debug('Fetching SSL certificate for secure connection (TOFU pattern)');
      try {
        creds.ca = await getRootCertificate({
          host: mapepireConfig.hostname,
          user: mapepireConfig.username,
          password: mapepireConfig.password,
          rejectUnauthorized: false, // Initially connect without validation to get cert
        });
        log.debug('SSL certificate fetched successfully');
      } catch (error) {
        log.warn(
          { err: error }, 
          'Failed to fetch SSL certificate. Connection will proceed without certificate pinning. ' +
          'For maximum security, pre-configure the CA certificate.'
        );
      }
    }

    // Create and initialize connection pool
    this.pool = new Pool({
      creds,
      maxSize: mapepireConfig.poolMaxSize,
      startingSize: mapepireConfig.poolStartingSize,
    });

    await this.pool.init();
    this.initialized = true;
    
    log.info(
      { hostname: mapepireConfig.hostname, port: mapepireConfig.port }, 
      'Mapepire connection pool initialized'
    );
  }

  /**
   * Get the connection pool instance
   */
  private getPool(): MapepirePool {
    if (!this.pool) {
      throw new Error('Mapepire connection pool not initialized. Call initialize() first.');
    }
    return this.pool;
  }

  /**
   * Execute a query and return results
   */
  async executeQuery(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const pool = this.getPool();

    try {
      log.debug({ sql: sql.substring(0, 200), paramCount: params.length, timeout: this.queryTimeout }, 'Executing query via Mapepire');
      
      // Convert params to format expected by mapepire
      const parameters = params.length > 0 ? this.convertParams(params) : undefined;
      
      // Execute query with optional timeout
      const queryPromise = pool.execute<Record<string, unknown>>(sql, { parameters });
      const result = await this.withTimeout(queryPromise, this.queryTimeout);
      
      if (!result.success) {
        throw new Error(`Query execution failed with SQL return code: ${result.sql_rc}`);
      }
      
      const rows = result.data || [];
      log.debug({ rowCount: rows.length, executionTime: result.execution_time }, 'Mapepire query completed');
      
      return { rows };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown database error';
      log.debug({ err: error, sql: sql.substring(0, 200) }, 'Mapepire query failed');
      throw new Error(`Database query failed: ${message}`);
    }
  }

  /**
   * Wrap a promise with a timeout
   * @param promise - The promise to wrap
   * @param timeoutMs - Timeout in milliseconds (0 = no timeout)
   */
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    if (timeoutMs <= 0) {
      return promise;
    }

    let timeoutHandle: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Query timed out after ${timeoutMs}ms. Consider increasing MAPEPIRE_QUERY_TIMEOUT or optimizing the query.`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutHandle!);
    }
  }

  /**
   * Convert params to format compatible with mapepire
   */
  private convertParams(params: unknown[]): (string | number | null)[] {
    return params.map((p) => {
      if (p === null || p === undefined) return null;
      if (typeof p === 'string') return p;
      if (typeof p === 'number') return p;
      if (p instanceof Date) return p.toISOString();
      // Convert other types to string
      return String(p);
    });
  }

  /**
   * Test the database connection
   */
  async testConnection(): Promise<boolean> {
    try {
      log.debug('Testing Mapepire database connection');
      await this.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
      log.debug('Mapepire connection test successful');
      return true;
    } catch (error) {
      log.warn({ err: error }, 'Mapepire connection test failed');
      return false;
    }
  }

  /**
   * Close the connection pool
   */
  async close(): Promise<void> {
    if (this.pool) {
      log.info('Closing Mapepire connection pool');
      try {
        await this.pool.end();
      } catch (error) {
        log.warn({ err: error }, 'Error closing Mapepire pool');
      }
      this.pool = null;
    }
    this.initialized = false;
  }

  /**
   * Check if the driver is initialized
   */
  isInitialized(): boolean {
    return this.initialized && this.pool !== null;
  }
}
