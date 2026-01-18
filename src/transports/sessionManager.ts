/**
 * MCP Session Manager for HTTP Transport
 * 
 * Manages stateful MCP sessions using the SDK's StreamableHTTPServerTransport.
 * Each session maintains its own transport and server instance.
 */

import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger({ component: 'session-manager' });

/**
 * MCP Session state
 */
export interface McpSession {
  /** Unique session ID */
  id: string;
  /** The MCP server instance for this session */
  server: McpServer;
  /** The transport for this session */
  transport: StreamableHTTPServerTransport;
  /** Associated auth token */
  authToken: string;
  /** When the session was created */
  createdAt: Date;
  /** When the session was last accessed */
  lastAccessedAt: Date;
  /** Number of active requests */
  activeRequests: number;
  /** Whether the session is closing */
  isClosing: boolean;
}

/**
 * Session Manager singleton for managing MCP sessions
 */
class SessionManager {
  private static instance: SessionManager;
  private sessions: Map<string, McpSession> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly staleTimeoutMs = 30 * 60 * 1000; // 30 minutes
  private readonly cleanupIntervalMs = 60 * 1000; // 1 minute

  private constructor() {
    this.startCleanupTimer();
    log.debug('Session manager initialized');
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  /**
   * Create a new MCP session
   * 
   * @param server - The MCP server instance
   * @param authToken - The associated auth token
   * @returns The session ID and transport
   */
  async createSession(
    server: McpServer,
    authToken: string
  ): Promise<{ sessionId: string; transport: StreamableHTTPServerTransport }> {
    const sessionId = randomUUID();
    
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      onsessioninitialized: (id) => {
        log.info({ sessionId: id }, 'MCP session initialized');
      },
    });

    // Handle transport close
    transport.onclose = () => {
      log.debug({ sessionId }, 'Transport closed, cleaning up session');
      this.closeSession(sessionId).catch((err) => {
        log.error({ err, sessionId }, 'Error during transport close cleanup');
      });
    };

    // Connect server to transport
    await server.connect(transport);

    const session: McpSession = {
      id: sessionId,
      server,
      transport,
      authToken,
      createdAt: new Date(),
      lastAccessedAt: new Date(),
      activeRequests: 0,
      isClosing: false,
    };

    this.sessions.set(sessionId, session);

    log.info(
      { sessionId, sessionCount: this.sessions.size },
      'MCP session created'
    );

    return { sessionId, transport };
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId: string): McpSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session && !session.isClosing) {
      session.lastAccessedAt = new Date();
      return session;
    }
    return undefined;
  }

  /**
   * Get a session by auth token
   */
  getSessionByToken(authToken: string): McpSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.authToken === authToken && !session.isClosing) {
        session.lastAccessedAt = new Date();
        return session;
      }
    }
    return undefined;
  }

  /**
   * Check if a session exists
   */
  hasSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session !== undefined && !session.isClosing;
  }

  /**
   * Increment active request count
   */
  incrementActiveRequests(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.activeRequests++;
      session.lastAccessedAt = new Date();
    }
  }

  /**
   * Decrement active request count
   */
  decrementActiveRequests(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.activeRequests > 0) {
      session.activeRequests--;
      session.lastAccessedAt = new Date();
    }
  }

  /**
   * Close a session
   */
  async closeSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    if (session.isClosing) {
      log.debug({ sessionId }, 'Session already closing');
      return false;
    }

    session.isClosing = true;

    try {
      await session.transport.close();
      await session.server.close();
    } catch (err) {
      log.error({ err, sessionId }, 'Error closing session resources');
    }

    this.sessions.delete(sessionId);

    log.info(
      { sessionId, sessionCount: this.sessions.size },
      'MCP session closed'
    );

    return true;
  }

  /**
   * Close all sessions for a given auth token
   */
  async closeSessionsByToken(authToken: string): Promise<number> {
    const sessionsToClose: string[] = [];

    for (const [id, session] of this.sessions.entries()) {
      if (session.authToken === authToken) {
        sessionsToClose.push(id);
      }
    }

    let closedCount = 0;
    for (const sessionId of sessionsToClose) {
      if (await this.closeSession(sessionId)) {
        closedCount++;
      }
    }

    return closedCount;
  }

  /**
   * Get session statistics
   */
  getStats(): {
    totalSessions: number;
    activeSessions: number;
    staleSessions: number;
  } {
    const now = Date.now();
    let activeSessions = 0;
    let staleSessions = 0;

    for (const session of this.sessions.values()) {
      if (session.isClosing) continue;
      
      const age = now - session.lastAccessedAt.getTime();
      if (age > this.staleTimeoutMs) {
        staleSessions++;
      } else {
        activeSessions++;
      }
    }

    return {
      totalSessions: this.sessions.size,
      activeSessions,
      staleSessions,
    };
  }

  /**
   * Clean up stale sessions
   */
  private async cleanupStaleSessions(): Promise<void> {
    const now = Date.now();
    const staleSessionIds: string[] = [];

    for (const [id, session] of this.sessions.entries()) {
      if (session.isClosing) continue;

      const age = now - session.lastAccessedAt.getTime();
      if (age > this.staleTimeoutMs && session.activeRequests === 0) {
        staleSessionIds.push(id);
      }
    }

    if (staleSessionIds.length > 0) {
      log.info(
        { staleCount: staleSessionIds.length },
        'Cleaning up stale sessions'
      );

      for (const sessionId of staleSessionIds) {
        await this.closeSession(sessionId);
      }
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
      this.cleanupStaleSessions().catch((err) => {
        log.error({ err }, 'Error during stale session cleanup');
      });
    }, this.cleanupIntervalMs);

    // Don't block process exit
    this.cleanupTimer.unref();

    log.debug(
      { intervalMs: this.cleanupIntervalMs, staleTimeoutMs: this.staleTimeoutMs },
      'Session cleanup timer started'
    );
  }

  /**
   * Shutdown the session manager
   */
  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    const sessionIds = Array.from(this.sessions.keys());
    log.info({ sessionCount: sessionIds.length }, 'Shutting down session manager');

    for (const sessionId of sessionIds) {
      await this.closeSession(sessionId);
    }

    log.info('Session manager shutdown complete');
  }
}

// Export singleton getter
export function getSessionManager(): SessionManager {
  return SessionManager.getInstance();
}

// Export the class type for testing
export { SessionManager };
