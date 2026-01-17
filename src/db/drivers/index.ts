/**
 * Database Driver Factory
 * 
 * Provides a unified interface to create and manage database drivers.
 * Supports dynamic driver selection based on configuration.
 */

import type { DB2iDriver, DriverConfig, DriverType, QueryResult } from './interface.js';
import { JT400Driver } from './jt400.js';
import { MapepireDriver } from './mapepire.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger({ component: 'driver-factory' });

// Re-export types for convenience
export type { DB2iDriver, QueryResult, DriverConfig, DriverType };
export type { JT400DriverConfig, MapepireDriverConfig, BaseDriverConfig } from './interface.js';

/**
 * Create a database driver instance based on the driver type
 * 
 * @param driverType - The type of driver to create ('jt400' or 'mapepire')
 * @returns A new uninitialized driver instance
 */
export function createDriver(driverType: DriverType): DB2iDriver {
  log.debug({ driverType }, 'Creating database driver');
  
  switch (driverType) {
    case 'jt400':
      return new JT400Driver();
    case 'mapepire':
      return new MapepireDriver();
    default: {
      const exhaustiveCheck: never = driverType;
      throw new Error(`Unknown driver type: ${exhaustiveCheck}`);
    }
  }
}

/**
 * Create and initialize a database driver
 * 
 * @param config - Driver configuration (includes driver type)
 * @returns Initialized driver instance
 */
export async function createAndInitializeDriver(config: DriverConfig): Promise<DB2iDriver> {
  const driver = createDriver(config.driver);
  
  log.info({ driverType: config.driver, hostname: config.hostname }, 'Initializing database driver');
  
  await driver.initialize(config);
  
  log.info({ driverType: config.driver }, 'Database driver initialized successfully');
  
  return driver;
}

/**
 * Singleton driver instance management
 * 
 * Provides a global driver instance that can be shared across the application.
 * The driver is lazily initialized on first use.
 */
class DriverManager {
  private driver: DB2iDriver | null = null;
  private initializationPromise: Promise<void> | null = null;
  private config: DriverConfig | null = null;

  /**
   * Initialize the global driver instance
   * 
   * @param config - Driver configuration
   */
  async initialize(config: DriverConfig): Promise<void> {
    // If already initializing, wait for it
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    // If already initialized with same config, skip
    if (this.driver?.isInitialized() && this.config?.driver === config.driver) {
      log.debug('Driver already initialized');
      return;
    }

    // Close existing driver if switching types
    if (this.driver && this.config?.driver !== config.driver) {
      log.info({ oldDriver: this.config?.driver, newDriver: config.driver }, 'Switching driver types');
      await this.close();
    }

    this.initializationPromise = this.performInitialization(config);
    
    try {
      await this.initializationPromise;
    } finally {
      this.initializationPromise = null;
    }
  }

  private async performInitialization(config: DriverConfig): Promise<void> {
    this.driver = await createAndInitializeDriver(config);
    this.config = config;
  }

  /**
   * Get the current driver instance
   * @throws Error if driver is not initialized
   */
  getDriver(): DB2iDriver {
    if (!this.driver) {
      throw new Error('Database driver not initialized. Call initialize() first.');
    }
    return this.driver;
  }

  /**
   * Check if driver is initialized
   */
  isInitialized(): boolean {
    return this.driver?.isInitialized() ?? false;
  }

  /**
   * Get the current driver type
   */
  getDriverType(): DriverType | null {
    return this.config?.driver ?? null;
  }

  /**
   * Close the driver and release resources
   */
  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
      this.config = null;
    }
  }

  /**
   * Execute a query using the current driver
   * @throws Error if driver is not initialized
   */
  async executeQuery(sql: string, params?: unknown[]): Promise<QueryResult> {
    return this.getDriver().executeQuery(sql, params);
  }

  /**
   * Test the connection using the current driver
   * @throws Error if driver is not initialized
   */
  async testConnection(): Promise<boolean> {
    return this.getDriver().testConnection();
  }
}

/**
 * Global driver manager instance
 */
export const driverManager = new DriverManager();
