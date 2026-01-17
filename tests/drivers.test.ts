/**
 * Tests for database driver abstraction layer
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the node-jt400 module
vi.mock('node-jt400', () => ({
  pool: vi.fn(() => ({
    query: vi.fn().mockResolvedValue([{ ID: 1, NAME: 'Test' }]),
  })),
}));

// Import after mocking
import { JT400Driver } from '../src/db/drivers/jt400.js';
import { MapepireDriver } from '../src/db/drivers/mapepire.js';
import { createDriver, driverManager } from '../src/db/drivers/index.js';
import type { JT400DriverConfig, MapepireDriverConfig } from '../src/db/drivers/index.js';

describe('Driver Interface', () => {
  describe('createDriver', () => {
    it('should create JT400Driver for jt400 type', () => {
      const driver = createDriver('jt400');
      expect(driver).toBeInstanceOf(JT400Driver);
      expect(driver.driverType).toBe('jt400');
    });

    it('should create MapepireDriver for mapepire type', () => {
      const driver = createDriver('mapepire');
      expect(driver).toBeInstanceOf(MapepireDriver);
      expect(driver.driverType).toBe('mapepire');
    });
  });
});

describe('JT400Driver', () => {
  let driver: JT400Driver;

  const testConfig: JT400DriverConfig = {
    driver: 'jt400',
    hostname: 'test.example.com',
    port: 446,
    username: 'testuser',
    password: 'testpass',
    database: '*LOCAL',
    schema: 'TESTLIB',
    jdbcOptions: {},
  };

  beforeEach(() => {
    driver = new JT400Driver();
  });

  afterEach(async () => {
    await driver.close();
  });

  it('should have correct driver type', () => {
    expect(driver.driverType).toBe('jt400');
  });

  it('should not be initialized before initialize() is called', () => {
    expect(driver.isInitialized()).toBe(false);
  });

  it('should initialize successfully with valid config', async () => {
    await driver.initialize(testConfig);
    expect(driver.isInitialized()).toBe(true);
  });

  it('should throw error if initialized with wrong driver type', async () => {
    const wrongConfig: MapepireDriverConfig = {
      driver: 'mapepire',
      hostname: 'test.example.com',
      port: 8471,
      username: 'testuser',
      password: 'testpass',
      database: '*LOCAL',
      schema: 'TESTLIB',
      ignoreUnauthorized: true,
      poolMaxSize: 10,
      poolStartingSize: 2,
      queryTimeout: 30000,
    };

    await expect(driver.initialize(wrongConfig)).rejects.toThrow(
      'JT400Driver requires jt400 configuration'
    );
  });

  it('should execute queries after initialization', async () => {
    await driver.initialize(testConfig);
    
    const result = await driver.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
    expect(result).toBeDefined();
    expect(result.rows).toBeDefined();
    expect(Array.isArray(result.rows)).toBe(true);
  });

  it('should throw error when executing query before initialization', async () => {
    await expect(driver.executeQuery('SELECT 1')).rejects.toThrow(
      'JT400 connection pool not initialized'
    );
  });

  it('should handle close correctly', async () => {
    await driver.initialize(testConfig);
    expect(driver.isInitialized()).toBe(true);
    
    await driver.close();
    expect(driver.isInitialized()).toBe(false);
  });

  it('should build connection config with default naming convention', async () => {
    await driver.initialize({
      ...testConfig,
      jdbcOptions: {},
    });
    expect(driver.isInitialized()).toBe(true);
  });

  it('should preserve custom JDBC options', async () => {
    await driver.initialize({
      ...testConfig,
      jdbcOptions: {
        'naming': 'sql',
        'date format': 'usa',
      },
    });
    expect(driver.isInitialized()).toBe(true);
  });
});

describe('MapepireDriver', () => {
  let driver: MapepireDriver;

  const testConfig: MapepireDriverConfig = {
    driver: 'mapepire',
    hostname: 'test.example.com',
    port: 8471,
    username: 'testuser',
    password: 'testpass',
    database: '*LOCAL',
    schema: 'TESTLIB',
    ignoreUnauthorized: true,
    poolMaxSize: 10,
    poolStartingSize: 2,
    queryTimeout: 30000,
  };

  beforeEach(() => {
    driver = new MapepireDriver();
  });

  afterEach(async () => {
    await driver.close();
  });

  it('should have correct driver type', () => {
    expect(driver.driverType).toBe('mapepire');
  });

  it('should not be initialized before initialize() is called', () => {
    expect(driver.isInitialized()).toBe(false);
  });

  it('should throw error if initialized with wrong driver type', async () => {
    const wrongConfig: JT400DriverConfig = {
      driver: 'jt400',
      hostname: 'test.example.com',
      port: 446,
      username: 'testuser',
      password: 'testpass',
      database: '*LOCAL',
      schema: 'TESTLIB',
      jdbcOptions: {},
    };

    await expect(driver.initialize(wrongConfig)).rejects.toThrow(
      'MapepireDriver requires mapepire configuration'
    );
  });

  // Note: Full initialization tests for MapepireDriver require the optional
  // @ibm/mapepire-js package to be installed, so we test error handling here
  it('should provide helpful error message when mapepire-js is not installed', async () => {
    await expect(driver.initialize(testConfig)).rejects.toThrow(
      /Failed to load @ibm\/mapepire-js/
    );
  });

  it('should handle close correctly when not initialized', async () => {
    // Should not throw
    await driver.close();
    expect(driver.isInitialized()).toBe(false);
  });
});

describe('DriverManager', () => {
  beforeEach(async () => {
    // Ensure clean state
    await driverManager.close();
  });

  afterEach(async () => {
    await driverManager.close();
  });

  it('should not be initialized initially', () => {
    expect(driverManager.isInitialized()).toBe(false);
    expect(driverManager.getDriverType()).toBeNull();
  });

  it('should throw error when getting driver before initialization', () => {
    expect(() => driverManager.getDriver()).toThrow(
      'Database driver not initialized'
    );
  });

  it('should throw error when executing query before initialization', async () => {
    await expect(driverManager.executeQuery('SELECT 1')).rejects.toThrow(
      'Database driver not initialized'
    );
  });

  it('should initialize with JT400 driver', async () => {
    const config: JT400DriverConfig = {
      driver: 'jt400',
      hostname: 'test.example.com',
      port: 446,
      username: 'testuser',
      password: 'testpass',
      database: '*LOCAL',
      schema: '',
      jdbcOptions: {},
    };

    await driverManager.initialize(config);
    
    expect(driverManager.isInitialized()).toBe(true);
    expect(driverManager.getDriverType()).toBe('jt400');
  });

  it('should return same driver type after initialization', async () => {
    const config: JT400DriverConfig = {
      driver: 'jt400',
      hostname: 'test.example.com',
      port: 446,
      username: 'testuser',
      password: 'testpass',
      database: '*LOCAL',
      schema: '',
      jdbcOptions: {},
    };

    await driverManager.initialize(config);
    const driver = driverManager.getDriver();
    
    expect(driver.driverType).toBe('jt400');
  });

  it('should handle close correctly', async () => {
    const config: JT400DriverConfig = {
      driver: 'jt400',
      hostname: 'test.example.com',
      port: 446,
      username: 'testuser',
      password: 'testpass',
      database: '*LOCAL',
      schema: '',
      jdbcOptions: {},
    };

    await driverManager.initialize(config);
    expect(driverManager.isInitialized()).toBe(true);
    
    await driverManager.close();
    expect(driverManager.isInitialized()).toBe(false);
    expect(driverManager.getDriverType()).toBeNull();
  });
});
