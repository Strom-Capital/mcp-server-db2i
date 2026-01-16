/**
 * Tests for configuration module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadConfig, buildConnectionConfig, type DB2iConfig } from '../src/config.js';

describe('Config Module', () => {
  // Store original env vars
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset env vars before each test
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore original env vars
    process.env = originalEnv;
  });

  describe('loadConfig', () => {
    describe('required environment variables', () => {
      it('should throw error when DB2I_HOSTNAME is missing', () => {
        delete process.env.DB2I_HOSTNAME;
        process.env.DB2I_USERNAME = 'user';
        process.env.DB2I_PASSWORD = 'pass';

        expect(() => loadConfig()).toThrow('DB2I_HOSTNAME environment variable is required');
      });

      it('should throw error when DB2I_USERNAME is missing', () => {
        process.env.DB2I_HOSTNAME = 'host.example.com';
        delete process.env.DB2I_USERNAME;
        process.env.DB2I_PASSWORD = 'pass';

        expect(() => loadConfig()).toThrow('DB2I_USERNAME environment variable is required');
      });

      it('should throw error when DB2I_PASSWORD is missing', () => {
        process.env.DB2I_HOSTNAME = 'host.example.com';
        process.env.DB2I_USERNAME = 'user';
        delete process.env.DB2I_PASSWORD;

        expect(() => loadConfig()).toThrow('DB2I_PASSWORD environment variable is required');
      });
    });

    describe('successful config loading', () => {
      beforeEach(() => {
        process.env.DB2I_HOSTNAME = 'myibmi.example.com';
        process.env.DB2I_USERNAME = 'MYUSER';
        process.env.DB2I_PASSWORD = 'secret123';
      });

      it('should load required config values', () => {
        const config = loadConfig();

        expect(config.hostname).toBe('myibmi.example.com');
        expect(config.username).toBe('MYUSER');
        expect(config.password).toBe('secret123');
      });

      it('should use default port 446', () => {
        const config = loadConfig();
        expect(config.port).toBe(446);
      });

      it('should use custom port when provided', () => {
        process.env.DB2I_PORT = '8471';
        const config = loadConfig();
        expect(config.port).toBe(8471);
      });

      it('should use default database *LOCAL', () => {
        const config = loadConfig();
        expect(config.database).toBe('*LOCAL');
      });

      it('should use custom database when provided', () => {
        process.env.DB2I_DATABASE = 'MYDB';
        const config = loadConfig();
        expect(config.database).toBe('MYDB');
      });

      it('should have empty schema by default', () => {
        const config = loadConfig();
        expect(config.schema).toBe('');
      });

      it('should use custom schema when provided', () => {
        process.env.DB2I_SCHEMA = 'MYLIB';
        const config = loadConfig();
        expect(config.schema).toBe('MYLIB');
      });
    });

    describe('JDBC options parsing', () => {
      beforeEach(() => {
        process.env.DB2I_HOSTNAME = 'host.example.com';
        process.env.DB2I_USERNAME = 'user';
        process.env.DB2I_PASSWORD = 'pass';
      });

      it('should have empty jdbcOptions by default', () => {
        const config = loadConfig();
        expect(config.jdbcOptions).toEqual({});
      });

      it('should parse single JDBC option', () => {
        process.env.DB2I_JDBC_OPTIONS = 'naming=system';
        const config = loadConfig();
        expect(config.jdbcOptions).toEqual({ naming: 'system' });
      });

      it('should parse multiple JDBC options', () => {
        process.env.DB2I_JDBC_OPTIONS = 'naming=system;date format=iso';
        const config = loadConfig();
        expect(config.jdbcOptions).toEqual({
          naming: 'system',
          'date format': 'iso',
        });
      });

      it('should handle options with spaces', () => {
        process.env.DB2I_JDBC_OPTIONS = 'date format=iso;time format=hms';
        const config = loadConfig();
        expect(config.jdbcOptions['date format']).toBe('iso');
        expect(config.jdbcOptions['time format']).toBe('hms');
      });

      it('should handle trailing semicolon', () => {
        process.env.DB2I_JDBC_OPTIONS = 'naming=system;';
        const config = loadConfig();
        expect(config.jdbcOptions).toEqual({ naming: 'system' });
      });

      it('should handle empty options gracefully', () => {
        process.env.DB2I_JDBC_OPTIONS = '';
        const config = loadConfig();
        expect(config.jdbcOptions).toEqual({});
      });

      it('should trim whitespace from options', () => {
        process.env.DB2I_JDBC_OPTIONS = ' naming = system ; errors = full ';
        const config = loadConfig();
        expect(config.jdbcOptions['naming']).toBe('system');
        expect(config.jdbcOptions['errors']).toBe('full');
      });
    });
  });

  describe('buildConnectionConfig', () => {
    const baseConfig: DB2iConfig = {
      hostname: 'myhost.example.com',
      port: 446,
      username: 'TESTUSER',
      password: 'testpass',
      database: '*LOCAL',
      schema: '',
      jdbcOptions: {},
    };

    it('should include host, user, and password', () => {
      const connConfig = buildConnectionConfig(baseConfig);

      expect(connConfig.host).toBe('myhost.example.com');
      expect(connConfig.user).toBe('TESTUSER');
      expect(connConfig.password).toBe('testpass');
    });

    it('should add default naming convention', () => {
      const connConfig = buildConnectionConfig(baseConfig);
      expect(connConfig['naming']).toBe('system');
    });

    it('should add default date format', () => {
      const connConfig = buildConnectionConfig(baseConfig);
      expect(connConfig['date format']).toBe('iso');
    });

    it('should not override user-specified naming', () => {
      const config: DB2iConfig = {
        ...baseConfig,
        jdbcOptions: { naming: 'sql' },
      };
      const connConfig = buildConnectionConfig(config);
      expect(connConfig['naming']).toBe('sql');
    });

    it('should not override user-specified date format', () => {
      const config: DB2iConfig = {
        ...baseConfig,
        jdbcOptions: { 'date format': 'usa' },
      };
      const connConfig = buildConnectionConfig(config);
      expect(connConfig['date format']).toBe('usa');
    });

    it('should merge all JDBC options', () => {
      const config: DB2iConfig = {
        ...baseConfig,
        jdbcOptions: {
          errors: 'full',
          libraries: 'MYLIB,QGPL',
          secure: 'true',
        },
      };
      const connConfig = buildConnectionConfig(config);

      expect(connConfig['errors']).toBe('full');
      expect(connConfig['libraries']).toBe('MYLIB,QGPL');
      expect(connConfig['secure']).toBe('true');
      // Defaults should still be present
      expect(connConfig['naming']).toBe('system');
      expect(connConfig['date format']).toBe('iso');
    });
  });
});
