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

  describe('trustProxy', () => {
    it('trusts no proxy by default, and parses hop counts and address lists', async () => {
      process.env.MCP_AUTH_MODE = 'none';
      const { getHttpConfig } = await import('../src/config.js');
      delete process.env.MCP_TRUST_PROXY;
      expect(getHttpConfig().trustProxy).toBe(false);
      process.env.MCP_TRUST_PROXY = '0';
      expect(getHttpConfig().trustProxy).toBe(false);
      process.env.MCP_TRUST_PROXY = 'true';
      expect(getHttpConfig().trustProxy).toBe(true);
      process.env.MCP_TRUST_PROXY = '1';
      expect(getHttpConfig().trustProxy).toBe(1);
      process.env.MCP_TRUST_PROXY = 'loopback, 10.0.0.0/8';
      expect(getHttpConfig().trustProxy).toBe('loopback, 10.0.0.0/8');
    });
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
    it('should default to stateless', async () => {
      delete process.env.MCP_SESSION_MODE;
      
      const { getSessionMode } = await import('../src/config.js');
      expect(getSessionMode()).toBe('stateless');
    });

    it('should return stateful when explicitly set', async () => {
      process.env.MCP_SESSION_MODE = 'stateful';

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
      delete process.env.MCP_ALLOWED_HOSTS;
      delete process.env.MCP_ALLOW_UNAUTHENTICATED_HTTP;

      const { getHttpConfig } = await import('../src/config.js');
      const config = getHttpConfig();

      expect(config.port).toBe(3000);
      expect(config.host).toBe('127.0.0.1');
      expect(config.sessionMode).toBe('stateless');
      expect(config.tokenExpiry).toBe(3600);
      expect(config.maxSessions).toBe(100);
      expect(config.tls.enabled).toBe(false);
      expect(config.allowedHosts).toEqual(expect.arrayContaining(['localhost', '127.0.0.1', '::1']));
      expect(config.allowUnauthenticatedHttp).toBe(false);
    });

    it('should add MCP_ALLOWED_HOSTS and keep loopback', async () => {
      process.env.MCP_ALLOWED_HOSTS = 'App.Example.com';
      process.env.MCP_HTTP_HOST = '0.0.0.0';

      const { getHttpConfig } = await import('../src/config.js');
      const config = getHttpConfig();

      expect(config.allowedHosts).toContain('app.example.com');
      expect(config.allowedHosts).toContain('127.0.0.1');
      expect(config.allowedHosts).not.toContain('0.0.0.0');
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

  describe('getAuthRateLimitConfig', () => {
    it('defaults to 5 attempts per 60 seconds', async () => {
      delete process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS;
      delete process.env.AUTH_RATE_LIMIT_WINDOW_MS;

      const { getAuthRateLimitConfig, getHttpConfig } = await import('../src/config.js');

      expect(getAuthRateLimitConfig()).toEqual({ maxAttempts: 5, windowMs: 60000 });
      expect(getHttpConfig().authRateLimit).toEqual({ maxAttempts: 5, windowMs: 60000 });
    });

    it('reads custom values', async () => {
      process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS = ' 20 ';
      process.env.AUTH_RATE_LIMIT_WINDOW_MS = '300000';

      const { getAuthRateLimitConfig } = await import('../src/config.js');

      expect(getAuthRateLimitConfig()).toEqual({ maxAttempts: 20, windowMs: 300000 });
    });

    it('is not turned off by RATE_LIMIT_ENABLED=false', async () => {
      process.env.RATE_LIMIT_ENABLED = 'false';
      delete process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS;
      delete process.env.AUTH_RATE_LIMIT_WINDOW_MS;

      const { getAuthRateLimitConfig } = await import('../src/config.js');

      expect(getAuthRateLimitConfig()).toEqual({ maxAttempts: 5, windowMs: 60000 });
    });

    it.each([
      ['AUTH_RATE_LIMIT_MAX_ATTEMPTS', '0', 'must be at least 1'],
      ['AUTH_RATE_LIMIT_MAX_ATTEMPTS', '-3', 'must be at least 1'],
      ['AUTH_RATE_LIMIT_MAX_ATTEMPTS', '2.5', 'must be a whole number'],
      ['AUTH_RATE_LIMIT_MAX_ATTEMPTS', 'ten', 'must be a whole number'],
      ['AUTH_RATE_LIMIT_WINDOW_MS', '0', 'must be at least 1'],
      ['AUTH_RATE_LIMIT_WINDOW_MS', '-60000', 'must be at least 1'],
      ['AUTH_RATE_LIMIT_WINDOW_MS', '1e3', 'must be a whole number'],
    ])('rejects %s=%s', async (name, value, message) => {
      delete process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS;
      delete process.env.AUTH_RATE_LIMIT_WINDOW_MS;
      process.env[name] = value;

      const { getAuthRateLimitConfig, getHttpConfig } = await import('../src/config.js');

      expect(() => getAuthRateLimitConfig()).toThrow(`${name} ${message}`);
      expect(() => getHttpConfig()).toThrow(name);
    });
  });

  describe('getOAuthRateLimitConfig', () => {
    beforeEach(() => {
      delete process.env.OAUTH_RATE_LIMIT_MAX_REQUESTS;
      delete process.env.OAUTH_RATE_LIMIT_WINDOW_MS;
    });

    it('defaults to 120 requests per 60 seconds', async () => {
      const { getOAuthRateLimitConfig, getHttpConfig } = await import('../src/config.js');

      expect(getOAuthRateLimitConfig()).toEqual({ maxRequests: 120, windowMs: 60000 });
      expect(getHttpConfig().oauthRateLimit).toEqual({ maxRequests: 120, windowMs: 60000 });
    });

    it('reads custom values', async () => {
      process.env.OAUTH_RATE_LIMIT_MAX_REQUESTS = ' 600 ';
      process.env.OAUTH_RATE_LIMIT_WINDOW_MS = '300000';

      const { getOAuthRateLimitConfig } = await import('../src/config.js');

      expect(getOAuthRateLimitConfig()).toEqual({ maxRequests: 600, windowMs: 300000 });
    });

    it('is not turned off by RATE_LIMIT_ENABLED=false', async () => {
      process.env.RATE_LIMIT_ENABLED = 'false';

      const { getOAuthRateLimitConfig } = await import('../src/config.js');

      expect(getOAuthRateLimitConfig()).toEqual({ maxRequests: 120, windowMs: 60000 });
    });

    it.each([
      ['OAUTH_RATE_LIMIT_MAX_REQUESTS', '0', 'must be at least 1'],
      ['OAUTH_RATE_LIMIT_MAX_REQUESTS', '-3', 'must be at least 1'],
      ['OAUTH_RATE_LIMIT_MAX_REQUESTS', '2.5', 'must be a whole number'],
      ['OAUTH_RATE_LIMIT_WINDOW_MS', '0', 'must be at least 1'],
      ['OAUTH_RATE_LIMIT_WINDOW_MS', '1e3', 'must be a whole number'],
    ])('rejects %s=%s', async (name, value, message) => {
      process.env[name] = value;

      const { getOAuthRateLimitConfig, getHttpConfig } = await import('../src/config.js');

      expect(() => getOAuthRateLimitConfig()).toThrow(`${name} ${message}`);
      expect(() => getHttpConfig()).toThrow(name);
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
