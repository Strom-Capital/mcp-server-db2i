/**
 * Token Manager for HTTP Authentication
 * 
 * Handles secure token generation, validation, session storage, and cleanup.
 * Tokens are stored in memory with automatic cleanup of expired sessions.
 */

import crypto from 'node:crypto';
import type { DB2iConfig } from '../config.js';
import { getHttpConfig } from '../config.js';
import { createChildLogger } from '../utils/logger.js';
import type {
  TokenSession,
  TokenValidationResult,
} from './types.js';

const log = createChildLogger({ component: 'token-manager' });

/**
 * Callback type for session cleanup notification
 * Used to close associated resources (e.g., connection pools) when tokens expire
 */
export type SessionCleanupCallback = (token: string) => Promise<void> | void;

/**
 * Token Manager singleton for managing authentication tokens
 */
class TokenManager {
  private static instance: TokenManager;
  private sessions: Map<string, TokenSession> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly cleanupIntervalMs = 60000; // 1 minute
  private cleanupCallback: SessionCleanupCallback | null = null;

  private constructor() {
    this.startCleanupTimer();
    log.debug('Token manager initialized');
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): TokenManager {
    if (!TokenManager.instance) {
      TokenManager.instance = new TokenManager();
    }
    return TokenManager.instance;
  }

  /**
   * Generate a cryptographically secure token
   * Uses 32 bytes (256 bits) of randomness encoded as base64url
   */
  private generateTokenString(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  /**
   * Create a new token session
   * 
   * @param config - DB2i configuration for this session
   * @param durationSeconds - Optional custom token duration
   * @returns The generated token and session info
   */
  createSession(
    config: DB2iConfig,
    durationSeconds?: number
  ): { token: string; expiresAt: Date; expiresIn: number } {
    const httpConfig = getHttpConfig();
    
    // Check max sessions limit
    if (this.sessions.size >= httpConfig.maxSessions) {
      throw new Error(
        `Maximum concurrent sessions (${httpConfig.maxSessions}) reached. Please try again later.`
      );
    }

    const token = this.generateTokenString();
    const now = new Date();
    const expiresIn = durationSeconds ?? httpConfig.tokenExpiry;
    const expiresAt = new Date(now.getTime() + expiresIn * 1000);

    const session: TokenSession = {
      token,
      config,
      createdAt: now,
      expiresAt,
      lastUsedAt: now,
    };

    this.sessions.set(token, session);

    log.info(
      {
        sessionCount: this.sessions.size,
        expiresIn,
        host: config.hostname,
        // Note: username intentionally omitted for PII compliance
      },
      'Token session created'
    );

    return { token, expiresAt, expiresIn };
  }

  /**
   * Validate a token and return the session
   * 
   * @param token - The token to validate
   * @returns Validation result with session if valid
   */
  validateToken(token: string): TokenValidationResult {
    if (!token || typeof token !== 'string') {
      return { valid: false, error: 'Invalid token format' };
    }

    const session = this.sessions.get(token);

    if (!session) {
      log.debug({ tokenPrefix: token.substring(0, 8) }, 'Token not found');
      return { valid: false, error: 'Token not found or expired' };
    }

    // Check expiration
    if (new Date() > session.expiresAt) {
      log.debug(
        { tokenPrefix: token.substring(0, 8), expiredAt: session.expiresAt },
        'Token expired'
      );
      this.sessions.delete(token);
      return { valid: false, error: 'Token expired' };
    }

    // Update last used timestamp
    session.lastUsedAt = new Date();

    return { valid: true, session };
  }

  /**
   * Get a session by token without validation
   * Used internally when token is already validated
   */
  getSession(token: string): TokenSession | undefined {
    return this.sessions.get(token);
  }

  /**
   * Update the MCP session ID for a token
   * Used when a stateful MCP session is established
   */
  setMcpSessionId(token: string, mcpSessionId: string): void {
    const session = this.sessions.get(token);
    if (session) {
      session.mcpSessionId = mcpSessionId;
      log.debug(
        { tokenPrefix: token.substring(0, 8), mcpSessionId },
        'MCP session ID associated with token'
      );
    }
  }

  /**
   * Revoke a token
   * 
   * @param token - The token to revoke
   * @returns true if token was found and revoked
   */
  async revokeToken(token: string): Promise<boolean> {
    const session = this.sessions.get(token);
    if (!session) {
      return false;
    }

    this.sessions.delete(token);
    
    // Notify cleanup callback to close associated resources
    await this.notifyCleanup(token);
    
    log.info(
      {
        tokenPrefix: token.substring(0, 8),
        sessionCount: this.sessions.size,
      },
      'Token revoked'
    );
    return true;
  }

  /**
   * Get session statistics
   */
  getStats(): {
    totalSessions: number;
    activeSessions: number;
    expiredSessions: number;
  } {
    const now = new Date();
    let activeSessions = 0;
    let expiredSessions = 0;

    for (const session of this.sessions.values()) {
      if (now <= session.expiresAt) {
        activeSessions++;
      } else {
        expiredSessions++;
      }
    }

    return {
      totalSessions: this.sessions.size,
      activeSessions,
      expiredSessions,
    };
  }

  /**
   * Clean up expired sessions
   */
  private async cleanupExpiredSessions(): Promise<void> {
    const now = new Date();
    const expiredTokens: string[] = [];

    for (const [token, session] of this.sessions.entries()) {
      if (now > session.expiresAt) {
        expiredTokens.push(token);
      }
    }

    if (expiredTokens.length > 0) {
      for (const token of expiredTokens) {
        this.sessions.delete(token);
        // Notify cleanup callback to close associated resources
        await this.notifyCleanup(token);
      }
      log.info(
        {
          expiredCount: expiredTokens.length,
          remainingCount: this.sessions.size,
        },
        'Cleaned up expired sessions'
      );
    }
  }

  /**
   * Start the cleanup timer
   */
  private startCleanupTimer(): void {
    if (this.cleanupTimer) {
      return;
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredSessions();
    }, this.cleanupIntervalMs);

    // Don't block process exit
    this.cleanupTimer.unref();

    log.debug(
      { intervalMs: this.cleanupIntervalMs },
      'Session cleanup timer started'
    );
  }

  /**
   * Stop the cleanup timer and clear all sessions
   * Used for graceful shutdown
   */
  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // Notify cleanup callback for all remaining sessions
    const tokens = Array.from(this.sessions.keys());
    for (const token of tokens) {
      await this.notifyCleanup(token);
    }

    const sessionCount = this.sessions.size;
    this.sessions.clear();

    log.info({ clearedSessions: sessionCount }, 'Token manager shutdown');
  }

  /**
   * Check if a new session can be created (advisory)
   * 
   * Note: This is an advisory check. In Node.js single-threaded environment,
   * there's no race condition between synchronous operations. However, if async
   * operations occur between calling this method and createSession(), the count
   * could change. The hard limit is enforced in createSession() which throws
   * an error if the limit is exceeded.
   */
  canCreateSession(): boolean {
    const httpConfig = getHttpConfig();
    return this.sessions.size < httpConfig.maxSessions;
  }

  /**
   * Set a callback to be called when sessions are cleaned up
   * Used to close associated resources (e.g., connection pools)
   * 
   * @param callback - Function called with the token when a session is removed
   */
  setCleanupCallback(callback: SessionCleanupCallback): void {
    this.cleanupCallback = callback;
    log.debug('Session cleanup callback registered');
  }

  /**
   * Internal method to notify about session cleanup
   */
  private async notifyCleanup(token: string): Promise<void> {
    if (this.cleanupCallback) {
      try {
        await this.cleanupCallback(token);
      } catch (err) {
        log.error({ err, tokenPrefix: token.substring(0, 8) }, 'Error in cleanup callback');
      }
    }
  }
}

// Export singleton getter
export function getTokenManager(): TokenManager {
  return TokenManager.getInstance();
}

// Export the class type for testing
export { TokenManager };
