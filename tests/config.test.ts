/**
 * Tests for configuration module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadConfig,
  buildConnectionConfig,
  readSecretFromFile,
  getSecret,
  validateHostname,
  getQueryLimitConfig,
  applyQueryLimit,
  type DB2iConfig,
  type QueryLimitConfig,
} from '../src/config.js';

// Create a unique temp directory for test secrets
const testSecretsDir = join(tmpdir(), `db2i-test-secrets-${process.pid}`);

describe('Config Module', () => {
  // Store original env vars
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset env vars before each test
    vi.resetModules();
    process.env = { ...originalEnv };
    // Create temp secrets directory
    mkdirSync(testSecretsDir, { recursive: true });
  });

  afterEach(() => {
    // Restore original env vars
    process.env = originalEnv;
    // Clean up temp secrets directory
    try {
      rmSync(testSecretsDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
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
        delete process.env.DB2I_USERNAME_FILE;
        process.env.DB2I_PASSWORD = 'pass';

        expect(() => loadConfig()).toThrow(
          'DB2I_USERNAME environment variable is required (or DB2I_USERNAME_FILE for file-based secret)'
        );
      });

      it('should throw error when DB2I_PASSWORD is missing', () => {
        process.env.DB2I_HOSTNAME = 'host.example.com';
        process.env.DB2I_USERNAME = 'user';
        delete process.env.DB2I_PASSWORD;
        delete process.env.DB2I_PASSWORD_FILE;

        expect(() => loadConfig()).toThrow(
          'DB2I_PASSWORD environment variable is required (or DB2I_PASSWORD_FILE for file-based secret)'
        );
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

    describe('file-based secrets', () => {
      beforeEach(() => {
        process.env.DB2I_HOSTNAME = 'host.example.com';
        // Clear both env vars and file vars
        delete process.env.DB2I_USERNAME;
        delete process.env.DB2I_PASSWORD;
        delete process.env.DB2I_USERNAME_FILE;
        delete process.env.DB2I_PASSWORD_FILE;
      });

      it('should read password from file when DB2I_PASSWORD_FILE is set', () => {
        const passwordFile = join(testSecretsDir, 'password.txt');
        writeFileSync(passwordFile, 'secret-from-file');

        process.env.DB2I_USERNAME = 'user';
        process.env.DB2I_PASSWORD_FILE = passwordFile;

        const config = loadConfig();
        expect(config.password).toBe('secret-from-file');
      });

      it('should read username from file when DB2I_USERNAME_FILE is set', () => {
        const usernameFile = join(testSecretsDir, 'username.txt');
        writeFileSync(usernameFile, 'user-from-file');

        process.env.DB2I_USERNAME_FILE = usernameFile;
        process.env.DB2I_PASSWORD = 'pass';

        const config = loadConfig();
        expect(config.username).toBe('user-from-file');
      });

      it('should trim whitespace from file-based secrets', () => {
        const passwordFile = join(testSecretsDir, 'password.txt');
        writeFileSync(passwordFile, '  secret-with-whitespace  \n');

        process.env.DB2I_USERNAME = 'user';
        process.env.DB2I_PASSWORD_FILE = passwordFile;

        const config = loadConfig();
        expect(config.password).toBe('secret-with-whitespace');
      });

      it('should prioritize file-based secret over environment variable', () => {
        const passwordFile = join(testSecretsDir, 'password.txt');
        writeFileSync(passwordFile, 'file-password');

        process.env.DB2I_USERNAME = 'user';
        process.env.DB2I_PASSWORD = 'env-password';
        process.env.DB2I_PASSWORD_FILE = passwordFile;

        const config = loadConfig();
        expect(config.password).toBe('file-password');
      });

      it('should fall back to environment variable when file is not specified', () => {
        process.env.DB2I_USERNAME = 'user';
        process.env.DB2I_PASSWORD = 'env-password';

        const config = loadConfig();
        expect(config.password).toBe('env-password');
      });

      it('should throw error when secret file does not exist', () => {
        process.env.DB2I_USERNAME = 'user';
        process.env.DB2I_PASSWORD_FILE = '/nonexistent/path/to/secret';

        expect(() => loadConfig()).toThrow('Secret file not found: /nonexistent/path/to/secret');
      });

      it('should read both username and password from files', () => {
        const usernameFile = join(testSecretsDir, 'username.txt');
        const passwordFile = join(testSecretsDir, 'password.txt');
        writeFileSync(usernameFile, 'file-user');
        writeFileSync(passwordFile, 'file-pass');

        process.env.DB2I_USERNAME_FILE = usernameFile;
        process.env.DB2I_PASSWORD_FILE = passwordFile;

        const config = loadConfig();
        expect(config.username).toBe('file-user');
        expect(config.password).toBe('file-pass');
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

  describe('readSecretFromFile', () => {
    it('should read content from file', () => {
      const secretFile = join(testSecretsDir, 'test-secret.txt');
      writeFileSync(secretFile, 'my-secret-value');

      const result = readSecretFromFile(secretFile);
      expect(result).toBe('my-secret-value');
    });

    it('should trim whitespace from content', () => {
      const secretFile = join(testSecretsDir, 'test-secret.txt');
      writeFileSync(secretFile, '  trimmed  \n\n');

      const result = readSecretFromFile(secretFile);
      expect(result).toBe('trimmed');
    });

    it('should throw error for non-existent file', () => {
      expect(() => readSecretFromFile('/does/not/exist')).toThrow(
        'Secret file not found: /does/not/exist'
      );
    });
  });

  describe('getSecret', () => {
    it('should return value from file when file env var is set', () => {
      const secretFile = join(testSecretsDir, 'secret.txt');
      writeFileSync(secretFile, 'file-value');

      process.env.TEST_SECRET = 'env-value';
      process.env.TEST_SECRET_FILE = secretFile;

      const result = getSecret('TEST_SECRET', 'TEST_SECRET_FILE');
      expect(result).toBe('file-value');

      delete process.env.TEST_SECRET;
      delete process.env.TEST_SECRET_FILE;
    });

    it('should return value from env var when file env var is not set', () => {
      process.env.TEST_SECRET = 'env-value';
      delete process.env.TEST_SECRET_FILE;

      const result = getSecret('TEST_SECRET', 'TEST_SECRET_FILE');
      expect(result).toBe('env-value');

      delete process.env.TEST_SECRET;
    });

    it('should return undefined when neither is set', () => {
      delete process.env.TEST_SECRET;
      delete process.env.TEST_SECRET_FILE;

      const result = getSecret('TEST_SECRET', 'TEST_SECRET_FILE');
      expect(result).toBeUndefined();
    });
  });

  describe('validateHostname', () => {
    describe('valid hostnames', () => {
      it('should accept simple hostname', () => {
        expect(validateHostname('myhost')).toBe(true);
      });

      it('should accept hostname with domain', () => {
        expect(validateHostname('myhost.example.com')).toBe(true);
      });

      it('should accept hostname with subdomain', () => {
        expect(validateHostname('ibmi.prod.example.com')).toBe(true);
      });

      it('should accept hostname with hyphen', () => {
        expect(validateHostname('ibmi-prod')).toBe(true);
      });

      it('should accept hostname with numbers', () => {
        expect(validateHostname('ibmi01')).toBe(true);
      });

      it('should accept hostname starting with number', () => {
        expect(validateHostname('123host')).toBe(true);
      });
    });

    describe('valid IPv4 addresses', () => {
      it('should accept standard IPv4', () => {
        expect(validateHostname('192.168.1.100')).toBe(true);
      });

      it('should accept localhost IP', () => {
        expect(validateHostname('127.0.0.1')).toBe(true);
      });

      it('should accept all zeros', () => {
        expect(validateHostname('0.0.0.0')).toBe(true);
      });

      it('should accept max values', () => {
        expect(validateHostname('255.255.255.255')).toBe(true);
      });
    });

    describe('invalid hostnames', () => {
      it('should reject empty string', () => {
        expect(validateHostname('')).toBe(false);
      });

      it('should reject whitespace only', () => {
        expect(validateHostname('   ')).toBe(false);
      });

      it('should reject hostname starting with hyphen', () => {
        expect(validateHostname('-invalid')).toBe(false);
      });

      it('should reject hostname ending with hyphen', () => {
        expect(validateHostname('invalid-')).toBe(false);
      });

      it('should reject hostname with underscore', () => {
        expect(validateHostname('invalid_host')).toBe(false);
      });

      it('should reject hostname with special characters', () => {
        expect(validateHostname('host@domain')).toBe(false);
      });

      it('should reject hostname with spaces', () => {
        expect(validateHostname('my host')).toBe(false);
      });

      it('should reject hostname exceeding 253 characters', () => {
        const longHostname = 'a'.repeat(254);
        expect(validateHostname(longHostname)).toBe(false);
      });
    });

    describe('invalid IPv4 addresses', () => {
      it('should reject IPv4 with octet > 255', () => {
        expect(validateHostname('192.168.1.256')).toBe(false);
      });

      it('should reject IPv4 with negative octet', () => {
        expect(validateHostname('192.168.-1.1')).toBe(false);
      });

      it('should reject IPv4 with octet 999', () => {
        expect(validateHostname('192.168.999.1')).toBe(false);
      });
    });
  });

  describe('loadConfig hostname validation', () => {
    beforeEach(() => {
      process.env.DB2I_USERNAME = 'user';
      process.env.DB2I_PASSWORD = 'pass';
    });

    it('should accept valid hostname', () => {
      process.env.DB2I_HOSTNAME = 'myibmi.example.com';
      const config = loadConfig();
      expect(config.hostname).toBe('myibmi.example.com');
    });

    it('should accept valid IPv4 address', () => {
      process.env.DB2I_HOSTNAME = '192.168.1.100';
      const config = loadConfig();
      expect(config.hostname).toBe('192.168.1.100');
    });

    it('should throw error for invalid hostname format', () => {
      process.env.DB2I_HOSTNAME = 'invalid_host!';
      expect(() => loadConfig()).toThrow('Invalid DB2I_HOSTNAME format');
    });

    it('should throw error for hostname starting with hyphen', () => {
      process.env.DB2I_HOSTNAME = '-invalid';
      expect(() => loadConfig()).toThrow('Invalid DB2I_HOSTNAME format');
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

  describe('getQueryLimitConfig', () => {
    it('should return default values when env vars not set', () => {
      delete process.env.QUERY_DEFAULT_LIMIT;
      delete process.env.QUERY_MAX_LIMIT;

      const config = getQueryLimitConfig();
      expect(config.defaultLimit).toBe(1000);
      expect(config.maxLimit).toBe(10000);
    });

    it('should use custom default limit from env var', () => {
      process.env.QUERY_DEFAULT_LIMIT = '500';
      delete process.env.QUERY_MAX_LIMIT;

      const config = getQueryLimitConfig();
      expect(config.defaultLimit).toBe(500);

      delete process.env.QUERY_DEFAULT_LIMIT;
    });

    it('should use custom max limit from env var', () => {
      delete process.env.QUERY_DEFAULT_LIMIT;
      process.env.QUERY_MAX_LIMIT = '5000';

      const config = getQueryLimitConfig();
      expect(config.maxLimit).toBe(5000);

      delete process.env.QUERY_MAX_LIMIT;
    });

    it('should enforce minimum of 1 for limits', () => {
      process.env.QUERY_DEFAULT_LIMIT = '0';
      process.env.QUERY_MAX_LIMIT = '-10';

      const config = getQueryLimitConfig();
      expect(config.defaultLimit).toBe(1);
      expect(config.maxLimit).toBe(1);

      delete process.env.QUERY_DEFAULT_LIMIT;
      delete process.env.QUERY_MAX_LIMIT;
    });
  });

  describe('applyQueryLimit', () => {
    const testConfig: QueryLimitConfig = {
      defaultLimit: 1000,
      maxLimit: 10000,
    };

    it('should use default limit when no limit requested', () => {
      expect(applyQueryLimit(undefined, testConfig)).toBe(1000);
    });

    it('should use requested limit when within bounds', () => {
      expect(applyQueryLimit(500, testConfig)).toBe(500);
      expect(applyQueryLimit(5000, testConfig)).toBe(5000);
    });

    it('should cap limit to maxLimit when exceeded', () => {
      expect(applyQueryLimit(20000, testConfig)).toBe(10000);
      expect(applyQueryLimit(999999, testConfig)).toBe(10000);
    });

    it('should enforce minimum of 1', () => {
      expect(applyQueryLimit(0, testConfig)).toBe(1);
      expect(applyQueryLimit(-100, testConfig)).toBe(1);
    });

    it('should handle edge case where requested equals max', () => {
      expect(applyQueryLimit(10000, testConfig)).toBe(10000);
    });
  });
});
