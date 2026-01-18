/**
 * HTTP Configuration Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('HTTP Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getTransportMode', () => {
    it('should default to stdio', async () => {
      delete process.env.MCP_TRANSPORT;
      
      const { getTransportMode } = await import('../src/config.js');
      expect(getTransportMode()).toBe('stdio');
    });

    it('should return http when set', async () => {
      process.env.MCP_TRANSPORT = 'http';
      
      const { getTransportMode } = await import('../src/config.js');
      expect(getTransportMode()).toBe('http');
    });

    it('should return both when set', async () => {
      process.env.MCP_TRANSPORT = 'both';
      
      const { getTransportMode } = await import('../src/config.js');
      expect(getTransportMode()).toBe('both');
    });

    it('should be case insensitive', async () => {
      process.env.MCP_TRANSPORT = 'HTTP';
      
      const { getTransportMode } = await import('../src/config.js');
      expect(getTransportMode()).toBe('http');
    });

    it('should default to stdio for invalid values', async () => {
      process.env.MCP_TRANSPORT = 'invalid';
      
      const { getTransportMode } = await import('../src/config.js');
      expect(getTransportMode()).toBe('stdio');
    });
  });

  describe('getSessionMode', () => {
    it('should default to stateful', async () => {
      delete process.env.MCP_SESSION_MODE;
      
      const { getSessionMode } = await import('../src/config.js');
      expect(getSessionMode()).toBe('stateful');
    });

    it('should return stateless when set', async () => {
      process.env.MCP_SESSION_MODE = 'stateless';
      
      const { getSessionMode } = await import('../src/config.js');
      expect(getSessionMode()).toBe('stateless');
    });
  });

  describe('isHttpEnabled', () => {
    it('should return false by default', async () => {
      delete process.env.MCP_TRANSPORT;
      
      const { isHttpEnabled } = await import('../src/config.js');
      expect(isHttpEnabled()).toBe(false);
    });

    it('should return true when transport is http', async () => {
      process.env.MCP_TRANSPORT = 'http';
      
      const { isHttpEnabled } = await import('../src/config.js');
      expect(isHttpEnabled()).toBe(true);
    });

    it('should return true when transport is both', async () => {
      process.env.MCP_TRANSPORT = 'both';
      
      const { isHttpEnabled } = await import('../src/config.js');
      expect(isHttpEnabled()).toBe(true);
    });
  });

  describe('isStdioEnabled', () => {
    it('should return true by default', async () => {
      delete process.env.MCP_TRANSPORT;
      
      const { isStdioEnabled } = await import('../src/config.js');
      expect(isStdioEnabled()).toBe(true);
    });

    it('should return false when transport is http only', async () => {
      process.env.MCP_TRANSPORT = 'http';
      
      const { isStdioEnabled } = await import('../src/config.js');
      expect(isStdioEnabled()).toBe(false);
    });

    it('should return true when transport is both', async () => {
      process.env.MCP_TRANSPORT = 'both';
      
      const { isStdioEnabled } = await import('../src/config.js');
      expect(isStdioEnabled()).toBe(true);
    });
  });

  describe('getHttpConfig', () => {
    it('should return default values', async () => {
      delete process.env.MCP_HTTP_PORT;
      delete process.env.MCP_HTTP_HOST;
      delete process.env.MCP_SESSION_MODE;
      delete process.env.MCP_TOKEN_EXPIRY;
      delete process.env.MCP_MAX_SESSIONS;
      delete process.env.MCP_TLS_ENABLED;

      const { getHttpConfig } = await import('../src/config.js');
      const config = getHttpConfig();

      expect(config.port).toBe(3000);
      expect(config.host).toBe('127.0.0.1');
      expect(config.sessionMode).toBe('stateful');
      expect(config.tokenExpiry).toBe(3600);
      expect(config.maxSessions).toBe(100);
      expect(config.tls.enabled).toBe(false);
    });

    it('should respect custom port', async () => {
      process.env.MCP_HTTP_PORT = '8080';

      const { getHttpConfig } = await import('../src/config.js');
      const config = getHttpConfig();

      expect(config.port).toBe(8080);
    });

    it('should respect custom host', async () => {
      process.env.MCP_HTTP_HOST = '127.0.0.1';

      const { getHttpConfig } = await import('../src/config.js');
      const config = getHttpConfig();

      expect(config.host).toBe('127.0.0.1');
    });
  });

  describe('loadPartialConfig', () => {
    beforeEach(() => {
      // Set up minimal required env vars
      process.env.DB2I_HOSTNAME = 'default.ibmi.com';
      process.env.DB2I_USERNAME = 'DEFAULTUSER';
      process.env.DB2I_PASSWORD = 'defaultpass';
    });

    it('should use provided values over env vars', async () => {
      const { loadPartialConfig } = await import('../src/config.js');
      
      const config = loadPartialConfig({
        hostname: 'custom.ibmi.com',
        username: 'CUSTOMUSER',
        password: 'custompass',
      });

      expect(config.hostname).toBe('custom.ibmi.com');
      expect(config.username).toBe('CUSTOMUSER');
      expect(config.password).toBe('custompass');
    });

    it('should fall back to env vars when values not provided', async () => {
      const { loadPartialConfig } = await import('../src/config.js');
      
      const config = loadPartialConfig({
        username: 'CUSTOMUSER',
        password: 'custompass',
      });

      expect(config.hostname).toBe('default.ibmi.com');
      expect(config.username).toBe('CUSTOMUSER');
    });

    it('should throw if host not available anywhere', async () => {
      delete process.env.DB2I_HOSTNAME;
      
      const { loadPartialConfig } = await import('../src/config.js');
      
      expect(() => loadPartialConfig({
        username: 'USER',
        password: 'pass',
      })).toThrow('Host is required');
    });

    it('should validate hostname format', async () => {
      const { loadPartialConfig } = await import('../src/config.js');
      
      expect(() => loadPartialConfig({
        hostname: 'invalid hostname with spaces',
        username: 'USER',
        password: 'pass',
      })).toThrow('Invalid hostname format');
    });
  });
});
