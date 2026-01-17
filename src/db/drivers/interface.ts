/**
 * Database Driver Interface for IBM DB2i
 * 
 * This module defines the common interface that all database drivers must implement.
 * It allows the application to switch between different database drivers (node-jt400, mapepire)
 * without changing the application code.
 */

/**
 * Query result structure returned by all drivers
 */
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

/**
 * Base configuration shared by all drivers
 */
export interface BaseDriverConfig {
  hostname: string;
  port: number;
  username: string;
  password: string;
  database: string;
  schema: string;
}

/**
 * JT400-specific configuration
 */
export interface JT400DriverConfig extends BaseDriverConfig {
  driver: 'jt400';
  jdbcOptions: Record<string, string>;
}

/**
 * Mapepire-specific configuration
 */
export interface MapepireDriverConfig extends BaseDriverConfig {
  driver: 'mapepire';
  /** Whether to ignore SSL certificate validation (default: true) */
  ignoreUnauthorized: boolean;
  /** Connection pool maximum size (default: 10) */
  poolMaxSize: number;
  /** Connection pool starting size (default: 2) */
  poolStartingSize: number;
  /** Query timeout in milliseconds (default: 30000 = 30 seconds, 0 = no timeout) */
  queryTimeout: number;
}

/**
 * Union type for all driver configurations
 */
export type DriverConfig = JT400DriverConfig | MapepireDriverConfig;

/**
 * Supported driver types
 */
export type DriverType = 'jt400' | 'mapepire';

/**
 * Database driver interface that all implementations must satisfy
 */
export interface DB2iDriver {
  /**
   * The type of driver
   */
  readonly driverType: DriverType;

  /**
   * Initialize the driver and establish connection pool
   * @param config - Driver-specific configuration
   */
  initialize(config: DriverConfig): Promise<void>;

  /**
   * Execute a SQL query and return results
   * @param sql - SQL query string
   * @param params - Optional query parameters for prepared statements
   * @returns Query results with rows and optional metadata
   */
  executeQuery(sql: string, params?: unknown[]): Promise<QueryResult>;

  /**
   * Test the database connection
   * @returns true if connection is healthy, false otherwise
   */
  testConnection(): Promise<boolean>;

  /**
   * Close the connection pool and release resources
   */
  close(): Promise<void>;

  /**
   * Check if the driver is initialized and ready
   */
  isInitialized(): boolean;
}
