/**
 * HTTP Transport for MCP Server
 * 
 * Express-based HTTP server with:
 * - OAuth-style token authentication (/auth)
 * - MCP protocol endpoints (/mcp)
 * - Health check endpoint (/health)
 * - Stateful and stateless session modes
 * - Optional TLS support
 */

import express, { type Express, type Request, type Response } from 'express';
import https from 'node:https';
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import {
  getHttpConfig,
  loadConfig,
  loadPartialConfig,
  type DB2iConfig,
} from '../config.js';
import { createChildLogger } from '../utils/logger.js';
import {
  getTokenManager,
  authMiddleware,
  authRateLimitMiddleware,
  recordFailedAuthAttempt,
  clearAuthRateLimit,
  type AuthenticatedRequest,
  type AuthRequest,
  type AuthResponse,
} from '../auth/index.js';
import { getSessionManager } from './sessionManager.js';
import { createServer as createMcpServer, SERVER_NAME, SERVER_VERSION } from '../server.js';
import { getOpenApiSpec } from '../openapi.js';
import { initializeSessionPool, testSessionConnection, closeSessionPool, closeAllSessionPools } from '../db/connection.js';

const log = createChildLogger({ component: 'http-transport' });

/**
 * Validate auth request body
 */
function validateAuthRequest(body: unknown): { valid: boolean; request?: AuthRequest; error?: string } {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body must be a JSON object' };
  }

  const req = body as Record<string, unknown>;

  // Validate required fields
  if (!req.username || typeof req.username !== 'string' || req.username.trim() === '') {
    return { valid: false, error: 'username is required and must be a non-empty string' };
  }

  if (!req.password || typeof req.password !== 'string') {
    return { valid: false, error: 'password is required and must be a string' };
  }

  // Validate optional fields
  if (req.host !== undefined && (typeof req.host !== 'string' || req.host.trim() === '')) {
    return { valid: false, error: 'host must be a non-empty string if provided' };
  }

  if (req.port !== undefined && (typeof req.port !== 'number' || req.port < 1 || req.port > 65535)) {
    return { valid: false, error: 'port must be a number between 1 and 65535' };
  }

  if (req.database !== undefined && typeof req.database !== 'string') {
    return { valid: false, error: 'database must be a string if provided' };
  }

  if (req.schema !== undefined && typeof req.schema !== 'string') {
    return { valid: false, error: 'schema must be a string if provided' };
  }

  if (req.duration !== undefined) {
    if (typeof req.duration !== 'number' || req.duration < 1 || req.duration > 86400) {
      return { valid: false, error: 'duration must be a number between 1 and 86400 seconds' };
    }
  }

  return {
    valid: true,
    request: {
      username: req.username.trim(),
      password: req.password,
      host: typeof req.host === 'string' ? req.host.trim() : undefined,
      port: typeof req.port === 'number' ? req.port : undefined,
      database: typeof req.database === 'string' ? req.database : undefined,
      schema: typeof req.schema === 'string' ? req.schema : undefined,
      duration: typeof req.duration === 'number' ? req.duration : undefined,
    },
  };
}

/**
 * Create the Express application
 */
export function createHttpApp(): Express {
  const app = express();
  const httpConfig = getHttpConfig();

  // Middleware
  app.use(express.json());

  // Security headers
  app.use((req: Request, res: Response, next: express.NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
  });

  // CORS - validate against allowed origins list
  // By default (MCP_CORS_ORIGINS not set), no CORS headers are sent = same-origin only
  // Set MCP_CORS_ORIGINS='*' to allow all origins, or comma-separated list for specific origins
  app.use((req: Request, res: Response, next: express.NextFunction) => {
    const origin = req.headers.origin;
    const allowedOrigins = httpConfig.corsOrigins;
    
    if (origin && allowedOrigins.length > 0) {
      // CORS is explicitly configured - check if origin is allowed
      const isAllowed = 
        allowedOrigins.includes('*') || // Wildcard = allow all
        allowedOrigins.includes(origin); // Specific origin match
      
      if (isAllowed) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        // Only set credentials when origin is explicitly allowed (not wildcard)
        if (!allowedOrigins.includes('*')) {
          res.setHeader('Access-Control-Allow-Credentials', 'true');
        }
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Accept');
      }
    }
    // When allowedOrigins is empty (default), no CORS headers are set.
    // Browser will enforce same-origin policy, blocking cross-origin requests.
    
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // OpenAPI specification endpoint
  app.get('/openapi.json', (req: Request, res: Response) => {
    const protocol = httpConfig.tls.enabled ? 'https' : 'http';
    const host = req.get('host') || `${httpConfig.host}:${httpConfig.port}`;
    const baseUrl = `${protocol}://${host}`;
    
    res.setHeader('Content-Type', 'application/json');
    res.json(getOpenApiSpec(baseUrl));
  });

  // Health check endpoint
  app.get('/health', (req: Request, res: Response) => {
    const tokenManager = getTokenManager();
    const sessionManager = getSessionManager();

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      server: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      config: {
        authMode: httpConfig.authMode,
        sessionMode: httpConfig.sessionMode,
        tlsEnabled: httpConfig.tls.enabled,
      },
      sessions: {
        tokens: httpConfig.authMode === 'required' ? tokenManager.getStats() : undefined,
        mcp: sessionManager.getStats(),
      },
    });
  });

  // Authentication endpoint (only active in 'required' auth mode)
  app.post('/auth', authRateLimitMiddleware, async (req: Request, res: Response) => {
    try {
      // Check if /auth endpoint is needed for current auth mode
      if (httpConfig.authMode !== 'required') {
        res.status(404).json({
          error: 'not_found',
          error_description: httpConfig.authMode === 'none' 
            ? 'Authentication is disabled. Access /mcp directly.'
            : 'Using token authentication mode. Use the pre-configured token.',
        });
        return;
      }

      // Validate request
      const validation = validateAuthRequest(req.body);
      if (!validation.valid || !validation.request) {
        recordFailedAuthAttempt(req);
        res.status(400).json({
          error: 'invalid_request',
          error_description: validation.error,
        });
        return;
      }

      const authReq = validation.request;

      // Build DB config with env fallbacks
      let dbConfig: DB2iConfig;
      try {
        dbConfig = loadPartialConfig({
          hostname: authReq.host,
          port: authReq.port,
          username: authReq.username,
          password: authReq.password,
          database: authReq.database,
          schema: authReq.schema,
        });
      } catch (err) {
        recordFailedAuthAttempt(req);
        const message = err instanceof Error ? err.message : 'Configuration error';
        res.status(400).json({
          error: 'invalid_request',
          error_description: message,
        });
        return;
      }

      // Test connection to validate credentials
      log.debug({ host: dbConfig.hostname, user: dbConfig.username }, 'Testing credentials');
      
      // Use crypto random bytes for unique test pool ID (avoids collision with concurrent requests)
      const testPoolId = `auth-test-${crypto.randomBytes(16).toString('hex')}`;
      try {
        initializeSessionPool(testPoolId, dbConfig);
        const connected = await testSessionConnection(testPoolId);
        await closeSessionPool(testPoolId);

        if (!connected) {
          recordFailedAuthAttempt(req);
          res.status(401).json({
            error: 'invalid_credentials',
            error_description: 'Authentication failed: unable to connect to database',
          });
          return;
        }
      } catch (err) {
        await closeSessionPool(testPoolId);
        recordFailedAuthAttempt(req);
        const message = err instanceof Error ? err.message : 'Connection failed';
        res.status(401).json({
          error: 'invalid_credentials',
          error_description: `Authentication failed: ${message}`,
        });
        return;
      }

      // Create token session
      const tokenManager = getTokenManager();
      
      // Advisory check - the hard limit is enforced in createSession()
      if (!tokenManager.canCreateSession()) {
        res.status(503).json({
          error: 'service_unavailable',
          error_description: 'Maximum concurrent sessions reached. Please try again later.',
        });
        return;
      }

      // Create session with proper error handling for race condition
      // (another request could fill the limit between canCreateSession and createSession)
      let token: string;
      let expiresAt: Date;
      let expiresIn: number;
      try {
        const result = tokenManager.createSession(dbConfig, authReq.duration);
        token = result.token;
        expiresAt = result.expiresAt;
        expiresIn = result.expiresIn;
      } catch (err) {
        // Check if this is a max sessions error (race condition)
        if (err instanceof Error && err.message.includes('Maximum concurrent sessions')) {
          res.status(503).json({
            error: 'service_unavailable',
            error_description: err.message,
          });
          return;
        }
        throw err; // Re-throw other errors
      }

      // Clear rate limit on successful auth
      clearAuthRateLimit(req);

      const response: AuthResponse = {
        access_token: token,
        token_type: 'Bearer',
        expires_in: expiresIn,
        expires_at: expiresAt.toISOString(),
      };

      log.info(
        { host: dbConfig.hostname, user: dbConfig.username, expiresIn },
        'Authentication successful'
      );

      res.status(201).json(response);
    } catch (err) {
      log.error({ err }, 'Unexpected error in auth handler');
      res.status(500).json({
        error: 'server_error',
        error_description: 'An unexpected error occurred',
      });
    }
  });

  // MCP endpoint - POST (main request handler)
  app.post('/mcp', authMiddleware, async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;

    try {
      // Determine DB config and session key based on auth mode
      let dbConfig: DB2iConfig;
      let sessionKey: string;

      if (httpConfig.authMode === 'none' || httpConfig.authMode === 'token') {
        // Use env-based config (like stdio mode)
        try {
          dbConfig = loadConfig();
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Configuration error';
          log.error({ err }, 'Failed to load DB config from environment');
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: `DB configuration error: ${message}` },
            id: null,
          });
          return;
        }
        // Use a single shared pool for none/token modes (similar to stdio mode).
        // This pool persists for the server's lifetime and is cleaned up on shutdown
        // via closeAllSessionPools(). This is intentional connection reuse, not a leak.
        sessionKey = 'global';
      } else {
        // Required mode - use per-user config from token
        if (!authReq.tokenSession || !authReq.authToken) {
          log.error('Token session or auth token missing in required mode');
          res.status(401).json({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Token session not found' },
            id: null,
          });
          return;
        }
        const session = authReq.tokenSession;
        const authToken = authReq.authToken;
        dbConfig = session.config;
        sessionKey = authToken;
      }

      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const sessionManager = getSessionManager();

      if (httpConfig.sessionMode === 'stateful') {
        // Stateful mode - reuse or create sessions
        if (sessionId) {
          // Existing session
          const mcpSession = sessionManager.getSession(sessionId);
          if (!mcpSession) {
            res.status(404).json({
              jsonrpc: '2.0',
              error: { code: -32001, message: 'Session not found or expired' },
              id: null,
            });
            return;
          }

          sessionManager.incrementActiveRequests(sessionId);
          try {
            await mcpSession.transport.handleRequest(req, res, req.body);
          } finally {
            sessionManager.decrementActiveRequests(sessionId);
          }
        } else if (isInitializeRequest(req.body)) {
          // New session initialization
          // Initialize DB pool for this session key
          initializeSessionPool(sessionKey, dbConfig);

          // Create MCP server and session with proper cleanup on failure
          let mcpServer: ReturnType<typeof createMcpServer> | undefined;
          let transport: Awaited<ReturnType<typeof sessionManager.createSession>>['transport'];
          let newSessionId: string;

          try {
            mcpServer = createMcpServer(dbConfig, sessionKey);
            const result = await sessionManager.createSession(mcpServer, sessionKey);
            transport = result.transport;
            newSessionId = result.sessionId;
          } catch (err) {
            // Clean up resources if server or session creation fails
            if (mcpServer) {
              await mcpServer.close().catch(() => {});
            }
            // Only close the pool if it's a per-user pool (required auth mode).
            // For 'none'/'token' modes, sessionKey='global' and the pool is shared
            // across all sessions - closing it would break other active sessions.
            // The global pool is only closed on server shutdown.
            if (sessionKey !== 'global') {
              await closeSessionPool(sessionKey);
            }
            throw err;
          }

          // Associate MCP session with token (only in required mode)
          if (httpConfig.authMode === 'required') {
            const tokenManager = getTokenManager();
            tokenManager.setMcpSessionId(sessionKey, newSessionId);
          }

          // Handle the initial request
          // Note: errors here are handled by the outer try-catch, and the session
          // will be cleaned up via normal session management (not here)
          await transport.handleRequest(req, res, req.body);
        } else {
          res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Session ID required for non-initialize requests' },
            id: null,
          });
        }
      } else {
        // Stateless mode - new server per request
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });

        // Initialize or reuse pool for this session key.
        // In 'required' auth mode, sessionKey = authToken, so the pool is shared
        // across all requests with the same token. This is intentional for efficiency.
        // Pool cleanup is handled by TokenManager when the token expires or is revoked
        // (see setCleanupCallback in startHttpServer).
        initializeSessionPool(sessionKey, dbConfig);

        const mcpServer = createMcpServer(dbConfig, sessionKey);
        
        // Clean up MCP server and transport on response close.
        // Note: The database connection pool is NOT closed here - it's reused across
        // requests with the same auth token and cleaned up on token expiration.
        res.on('close', () => {
          mcpServer.close().catch(() => {});
          transport.close().catch(() => {});
        });

        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
      }
    } catch (err) {
      log.error({ err }, 'Error handling MCP request');
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // MCP endpoint - GET (SSE for stateful mode)
  app.get('/mcp', authMiddleware, async (req: Request, res: Response) => {
    const httpConfig = getHttpConfig();

    if (httpConfig.sessionMode !== 'stateful') {
      res.status(405).json({
        error: 'method_not_allowed',
        error_description: 'GET requests only supported in stateful mode',
      });
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string;
    if (!sessionId) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'Mcp-Session-Id header required',
      });
      return;
    }

    const sessionManager = getSessionManager();
    const mcpSession = sessionManager.getSession(sessionId);

    if (!mcpSession) {
      res.status(404).json({
        error: 'not_found',
        error_description: 'Session not found or expired',
      });
      return;
    }

    await mcpSession.transport.handleRequest(req, res);
  });

  // MCP endpoint - DELETE (close session)
  app.delete('/mcp', authMiddleware, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string;

    if (!sessionId) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'Mcp-Session-Id header required',
      });
      return;
    }

    const sessionManager = getSessionManager();
    const closed = await sessionManager.closeSession(sessionId);

    if (closed) {
      res.json({ status: 'session_closed', sessionId });
    } else {
      res.status(404).json({
        error: 'not_found',
        error_description: 'Session not found',
      });
    }
  });

  return app;
}

/**
 * Start the HTTP server
 */
export async function startHttpServer(): Promise<http.Server | https.Server> {
  const httpConfig = getHttpConfig();
  const app = createHttpApp();

  // Register cleanup callback to close session pools when tokens expire or are revoked.
  // This handles cleanup for both stateful and stateless modes in 'required' auth:
  // - sessionKey = authToken, so pools are keyed by token
  // - Pools are intentionally reused across requests for the same token (efficiency)
  // - When token expires/revokes, this callback closes the associated pool
  if (httpConfig.authMode === 'required') {
    const tokenManager = getTokenManager();
    tokenManager.setCleanupCallback(async (token: string) => {
      await closeSessionPool(token);
    });
  }

  let server: http.Server | https.Server;

  if (httpConfig.tls.enabled && httpConfig.tls.certPath && httpConfig.tls.keyPath) {
    const cert = readFileSync(httpConfig.tls.certPath);
    const key = readFileSync(httpConfig.tls.keyPath);
    server = https.createServer({ cert, key }, app);
    log.info('TLS enabled');
  } else {
    server = http.createServer(app);
    if (httpConfig.host !== '127.0.0.1' && httpConfig.host !== 'localhost') {
      log.warn(
        'TLS is disabled. For production use, enable TLS or run behind a reverse proxy with TLS.'
      );
    }
  }

  return new Promise((resolve, reject) => {
    server.on('error', (err) => {
      log.error({ err }, 'HTTP server error');
      reject(err);
    });

    server.listen(httpConfig.port, httpConfig.host, () => {
      const protocol = httpConfig.tls.enabled ? 'https' : 'http';
      const address = `${protocol}://${httpConfig.host}:${httpConfig.port}`;
      
      log.info(
        {
          address,
          sessionMode: httpConfig.sessionMode,
          authMode: httpConfig.authMode,
          tlsEnabled: httpConfig.tls.enabled,
        },
        `HTTP server listening at ${address}`
      );

      // Log security warnings based on auth mode
      if (httpConfig.authMode === 'none') {
        log.warn(
          'AUTH MODE IS DISABLED (MCP_AUTH_MODE=none). ' +
          'The /mcp endpoint is accessible without authentication. ' +
          'Only use this on trusted networks or localhost.'
        );
      } else if (httpConfig.authMode === 'token' && !httpConfig.tls.enabled) {
        log.warn(
          'Using static token auth without TLS. ' +
          'Enable TLS (MCP_TLS_ENABLED=true) or run behind a TLS-terminating proxy.'
        );
      }

      resolve(server);
    });
  });
}

/**
 * Gracefully shutdown the HTTP server
 */
export async function shutdownHttpServer(server: http.Server | https.Server): Promise<void> {
  log.info('Shutting down HTTP server...');

  // Close session manager (closes MCP sessions)
  const sessionManager = getSessionManager();
  await sessionManager.shutdown();

  // Close token manager (clears auth tokens and triggers pool cleanup via callback)
  const tokenManager = getTokenManager();
  await tokenManager.shutdown();

  // Close all database connection pools
  await closeAllSessionPools();

  // Close HTTP server
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        log.error({ err }, 'Error closing HTTP server');
        reject(err);
      } else {
        log.info('HTTP server closed');
        resolve();
      }
    });
  });
}
