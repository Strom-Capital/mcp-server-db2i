/**
 * Token Manager Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the config module before importing tokenManager
vi.mock('../../src/config.js', () => ({
  getHttpConfig: vi.fn(() => ({
    transport: 'http',
    port: 3000,
    host: '127.0.0.1',
    sessionMode: 'stateful',
    tls: { enabled: false },
    tokenExpiry: 3600,
    maxSessions: 100,
  })),
}));

// Mock the logger
vi.mock('../../src/utils/logger.js', () => ({
  createChildLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

import { getTokenManager, TokenManager } from '../../src/auth/tokenManager.js';
import type { DB2iConfig } from '../../src/config.js';

describe('TokenManager', () => {
  let tokenManager: TokenManager;

  const mockConfig: DB2iConfig = {
    hostname: 'test.ibmi.com',
    port: 446,
    username: 'TESTUSER',
    password: 'testpass',
    database: '*LOCAL',
    schema: 'TESTLIB',
    jdbcOptions: {},
  };

  beforeEach(() => {
    // Get fresh instance
    tokenManager = getTokenManager();
  });

  afterEach(async () => {
    // Cleanup
    await tokenManager.shutdown();
  });

  describe('createSession', () => {
    it('should create a new token session', () => {
      const result = tokenManager.createSession(mockConfig);

      expect(result.token).toBeDefined();
      expect(result.token.length).toBeGreaterThan(20);
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(result.expiresIn).toBe(3600);
    });

    it('should create tokens with unique values', () => {
      const result1 = tokenManager.createSession(mockConfig);
      const result2 = tokenManager.createSession(mockConfig);

      expect(result1.token).not.toBe(result2.token);
    });

    it('should respect custom duration', () => {
      const result = tokenManager.createSession(mockConfig, 1800);

      expect(result.expiresIn).toBe(1800);
    });
  });

  describe('validateToken', () => {
    it('should validate a valid token', () => {
      const { token } = tokenManager.createSession(mockConfig);
      const result = tokenManager.validateToken(token);

      expect(result.valid).toBe(true);
      expect(result.session).toBeDefined();
      expect(result.session?.config.hostname).toBe('test.ibmi.com');
    });

    it('should reject an invalid token', () => {
      const result = tokenManager.validateToken('invalid-token');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Token not found or expired');
    });

    it('should reject empty token', () => {
      const result = tokenManager.validateToken('');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid token format');
    });

    it('should update lastUsedAt on validation', async () => {
      const { token } = tokenManager.createSession(mockConfig);
      
      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 10));
      
      const result = tokenManager.validateToken(token);
      
      expect(result.session?.lastUsedAt.getTime()).toBeGreaterThan(
        result.session?.createdAt.getTime() || 0
      );
    });
  });

  describe('revokeToken', () => {
    it('should revoke a valid token', async () => {
      const { token } = tokenManager.createSession(mockConfig);
      
      const revoked = await tokenManager.revokeToken(token);
      expect(revoked).toBe(true);

      const result = tokenManager.validateToken(token);
      expect(result.valid).toBe(false);
    });

    it('should return false for non-existent token', async () => {
      const revoked = await tokenManager.revokeToken('non-existent');
      expect(revoked).toBe(false);
    });
  });

  describe('getStats', () => {
    it('should return correct session counts', () => {
      tokenManager.createSession(mockConfig);
      tokenManager.createSession(mockConfig);

      const stats = tokenManager.getStats();

      expect(stats.totalSessions).toBe(2);
      expect(stats.activeSessions).toBe(2);
      expect(stats.expiredSessions).toBe(0);
    });
  });

  describe('canCreateSession', () => {
    it('should return true when under limit', () => {
      expect(tokenManager.canCreateSession()).toBe(true);
    });
  });

  describe('setMcpSessionId', () => {
    it('should associate MCP session ID with token', () => {
      const { token } = tokenManager.createSession(mockConfig);
      
      tokenManager.setMcpSessionId(token, 'mcp-session-123');
      
      const session = tokenManager.getSession(token);
      expect(session?.mcpSessionId).toBe('mcp-session-123');
    });
  });
});
