/**
 * Token Manager for HTTP Authentication
 * 
 * Handles secure token generation, validation, session storage, and cleanup.
 * Tokens are stored in memory with automatic cleanup of expired sessions.
 */

import crypto from 'node:crypto';
import type { DB2iConfig } from '../config.js';
import { DEFAULT_SYSTEM_NAME, getHttpConfig } from '../config.js';
import { createChildLogger } from '../utils/logger.js';
import type {
  TokenSession,
  TokenValidationResult,
} from './types.js';

const log = createChildLogger({ component: 'token-manager' });

/**
 * Callback type for session cleanup notification
 * Used to close associated resources (e.g., connection pools) when tokens expire
 * or are revoked. The session is already gone from the manager when it runs.
 */
export type SessionCleanupCallback = (token: string, session: TokenSession) => Promise<void> | void;

/**
 * The pool key a token's queries run on. Every token from one OAuth sign-in
 * shares its grant's key, so a refreshed token keeps the pool that is already
 * open. A POST /auth token is its own key. Tokens are base64url and never
 * contain `:`, so the two kinds cannot collide.
 *
 * @param token - The access token
 * @param session - The token's session, for its grant ID
 */
export function sessionPoolKey(token: string, session: Pick<TokenSession, 'grantId'> | undefined): string {
  return session?.grantId ? `grant:${session.grantId}` : token;
}

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
   * @param config - Db2i configuration for this session
   * @param durationSeconds - Optional custom token duration
   * @param system - System the credentials were checked on
   * @param clientId - OAuth client the token is issued to, if any
   * @param grantId - OAuth sign-in the token descends from, if any
   * @returns The generated token and session info
   */
  createSession(
    config: DB2iConfig,
    durationSeconds?: number,
    system: string = DEFAULT_SYSTEM_NAME,
    clientId?: string,
    grantId?: string
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
    // A client may ask for a shorter token, never a longer one than MCP_TOKEN_EXPIRY
    const expiresIn = Math.min(durationSeconds ?? httpConfig.tokenExpiry, httpConfig.tokenExpiry);
    const expiresAt = new Date(now.getTime() + expiresIn * 1000);

    const session: TokenSession = {
      token,
      config,
      system,
      clientId,
      grantId,
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
        system,
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
      // The sweep only sees tokens still in the map, so release the pool here
      void this.notifyCleanup(token, session);
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
    await this.notifyCleanup(token, session);
    
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
   * Revoke every token issued from one OAuth sign-in
   *
   * @param grantId - The grant the tokens descend from
   * @returns How many tokens were revoked
   */
  async revokeGrant(grantId: string): Promise<number> {
    const tokens = [...this.sessions.entries()]
      .filter(([, session]) => session.grantId === grantId)
      .map(([token]) => token);
    for (const token of tokens) {
      await this.revokeToken(token);
    }
    return tokens.length;
  }

  /**
   * Whether any token issued from one OAuth sign-in is still held, expired or not
   *
   * @param grantId - The grant the tokens descend from
   */
  hasGrant(grantId: string): boolean {
    for (const session of this.sessions.values()) {
      if (session.grantId === grantId) {
        return true;
      }
    }
    return false;
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
    const expiredTokens: Array<[string, TokenSession]> = [];

    for (const [token, session] of this.sessions.entries()) {
      if (now > session.expiresAt) {
        expiredTokens.push([token, session]);
      }
    }

    if (expiredTokens.length > 0) {
      for (const [token, session] of expiredTokens) {
        this.sessions.delete(token);
        // Notify cleanup callback to close associated resources
        await this.notifyCleanup(token, session);
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
    const sessionCount = this.sessions.size;
    const sessions = Array.from(this.sessions.entries());
    this.sessions.clear();
    for (const [token, session] of sessions) {
      await this.notifyCleanup(token, session);
    }

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
  private async notifyCleanup(token: string, session: TokenSession): Promise<void> {
    if (this.cleanupCallback) {
      try {
        await this.cleanupCallback(token, session);
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
