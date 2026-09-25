/**
 * HTTP Transport for MCP Server
 * 
 * Express-based HTTP server with:
 * - OAuth-style token authentication (/auth)
 * - Optional OAuth 2.1 authorization server for remote clients (/oauth/*)
 * - MCP protocol endpoints (/mcp)
 * - Health check endpoint (/health)
 * - Stateless MCP serving by default (stateful Mcp-Session-Id is deprecated)
 * - Optional TLS support
 */

import express, { type Express, type Request, type Response } from 'express';
import https from 'node:https';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createMcpHandler, isInitializeRequest, isLegacyRequest, type McpHttpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler, toWebRequest } from '@modelcontextprotocol/node';

import { FAVICON_ICO, FAVICON_SVG, ICON_PNG, ICON_TILE_SVG } from '../branding.js';
import { getHttpConfig, hostnameOf, isLoopbackHost } from '../config.js';
import { createChildLogger } from '../utils/logger.js';
import {
  getTokenManager,
  authMiddleware,
  createAuthRateLimitMiddleware,
  createOAuthRateLimitMiddleware,
  createOAuthRouter,
  extractBearerToken,
  resetOAuthState,
  type AuthenticatedRequest,
  type AuthResponse,
  type AuthValidationResult,
} from '../auth/index.js';
import { getSessionManager } from './sessionManager.js';
import { GLOBAL_SESSION_KEY, isSessionOwnedByCaller, resolveCallerSessionKey } from './sessionAuth.js';
import { createServer as createMcpServer, SERVER_NAME, SERVER_VERSION, type SessionContext } from '../server.js';
import { getOpenApiSpec } from '../openapi.js';
import { initializeSessionPool, closeSessionPool, closeAllSessionPools } from '../db/connection.js';
import { authAllowedDbHosts, verifyLogin } from '../auth/login.js';

const log = createChildLogger({ component: 'http-transport' });

/** Latest HTTP MCP handler, closed on shutdown so in-flight 2026 exchanges abort. */
let mcpHttpHandler: McpHttpHandler | undefined;

/**
 * Tell HTTP clients that subscribed to tool list changes to drop their cache.
 * No-op until the HTTP handler exists, and when nobody is listening.
 */
export function notifyCustomToolsChanged(): void {
  mcpHttpHandler?.notify.toolsChanged();
}

/** IBM i system name: 1-10 characters, not starting with a digit or `_`. */
const IBMI_LIBRARY_NAME = /^[A-Za-z$#@][A-Za-z0-9_$#@]{0,9}$/;

/**
 * Validate auth request body
 */
function validateAuthRequest(body: unknown): AuthValidationResult {
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

  // The schema becomes a driver option, and the Mapepire driver sends options
  // as one unescaped `key=value;...` string. Accept only a library name.
  if (
    req.schema !== undefined &&
    (typeof req.schema !== 'string' || !IBMI_LIBRARY_NAME.test(req.schema.trim()))
  ) {
    return { valid: false, error: 'schema must be an IBM i library name if provided' };
  }

  if (req.duration !== undefined) {
    if (typeof req.duration !== 'number' || req.duration < 1 || req.duration > 86400) {
      return { valid: false, error: 'duration must be a number between 1 and 86400 seconds' };
    }
  }

  if (req.system !== undefined && (typeof req.system !== 'string' || req.system.trim() === '')) {
    return { valid: false, error: 'system must be a non-empty string if provided' };
  }

  return {
    valid: true,
    request: {
      username: req.username.trim(),
      password: req.password,
      host: typeof req.host === 'string' ? req.host.trim() : undefined,
      port: typeof req.port === 'number' ? req.port : undefined,
      database: typeof req.database === 'string' ? req.database : undefined,
      schema: typeof req.schema === 'string' ? req.schema.trim() : undefined,
      duration: typeof req.duration === 'number' ? req.duration : undefined,
      system: typeof req.system === 'string' ? req.system.trim() : undefined,
    },
  };
}

/**
 * Whether Origin matches the request Host (same-origin browser traffic).
 */
function isSameOriginRequest(origin: string, req: Request): boolean {
  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}

/**
 * JSON-RPC 404 used when a session is missing or not owned by the caller.
 */
function sessionNotFoundBody(): { jsonrpc: '2.0'; error: { code: number; message: string }; id: null } {
  return {
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Session not found or expired' },
    id: null,
  };
}

/**
 * Build a per-request MCP server bound to the caller's database pool.
 * Pools stay keyed by auth token (or the shared "global" key), not by MCP session id.
 */
function createHttpMcpServer(request?: globalThis.Request): ReturnType<typeof createMcpServer> {
  const httpConfig = getHttpConfig();
  let context: SessionContext;

  if (httpConfig.authMode === 'none' || httpConfig.authMode === 'token') {
    context = { sessionId: resolveCallerSessionKey(httpConfig.authMode) };
  } else {
    const token = extractBearerToken(request?.headers.get('authorization') ?? undefined);
    const validation = token ? getTokenManager().validateToken(token) : undefined;
    if (!token || !validation?.valid || !validation.session) {
      throw new Error('Token session not found');
    }
    context = {
      sessionId: resolveCallerSessionKey(httpConfig.authMode, token),
      binding: { system: validation.session.system, config: validation.session.config },
    };
  }

  initializeSessionPool(context.sessionId);
  return createMcpServer(context);
}

/**
 * Deprecated MCP_SESSION_MODE=stateful path for 2025-era clients that still
 * send Mcp-Session-Id. 2026-07-28 traffic is not routed here.
 */
async function handleStatefulLegacyRequest(req: Request, res: Response): Promise<void> {
  const httpConfig = getHttpConfig();
  const authReq = req as AuthenticatedRequest;

  if (req.method === 'GET') {
    const sessionId = req.headers['mcp-session-id'] as string;
    if (!sessionId) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'Mcp-Session-Id header required',
      });
      return;
    }

    const sessionKey = resolveCallerSessionKey(httpConfig.authMode, authReq.authToken);
    const sessionManager = getSessionManager();
    const mcpSession = sessionManager.getSession(sessionId);

    if (!mcpSession || !isSessionOwnedByCaller(mcpSession.authToken, sessionKey)) {
      res.status(404).json({
        error: 'not_found',
        error_description: 'Session not found or expired',
      });
      return;
    }

    await mcpSession.transport.handleRequest(req, res);
    return;
  }

  if (req.method === 'DELETE') {
    const sessionId = req.headers['mcp-session-id'] as string;
    if (!sessionId) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'Mcp-Session-Id header required',
      });
      return;
    }

    const sessionKey = resolveCallerSessionKey(httpConfig.authMode, authReq.authToken);
    const sessionManager = getSessionManager();
    const mcpSession = sessionManager.getSession(sessionId);

    if (!mcpSession || !isSessionOwnedByCaller(mcpSession.authToken, sessionKey)) {
      res.status(404).json({
        error: 'not_found',
        error_description: 'Session not found',
      });
      return;
    }

    const closed = await sessionManager.closeSession(sessionId);
    if (closed) {
      res.json({ status: 'session_closed', sessionId });
    } else {
      res.status(404).json({
        error: 'not_found',
        error_description: 'Session not found',
      });
    }
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({
      error: 'method_not_allowed',
      error_description: 'Method not allowed',
    });
    return;
  }

  try {
    let sessionKey: string;
    let binding: SessionContext['binding'];

    if (httpConfig.authMode === 'none' || httpConfig.authMode === 'token') {
      sessionKey = resolveCallerSessionKey(httpConfig.authMode, authReq.authToken);
    } else {
      if (!authReq.tokenSession || !authReq.authToken) {
        log.error('Token session or auth token missing in required mode');
        res.status(401).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Token session not found' },
          id: null,
        });
        return;
      }
      binding = { system: authReq.tokenSession.system, config: authReq.tokenSession.config };
      sessionKey = resolveCallerSessionKey(httpConfig.authMode, authReq.authToken);
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const sessionManager = getSessionManager();

    if (sessionId) {
      const mcpSession = sessionManager.getSession(sessionId);
      if (!mcpSession || !isSessionOwnedByCaller(mcpSession.authToken, sessionKey)) {
        res.status(404).json(sessionNotFoundBody());
        return;
      }

      sessionManager.incrementActiveRequests(sessionId);
      try {
        await mcpSession.transport.handleRequest(req, res, req.body);
      } finally {
        sessionManager.decrementActiveRequests(sessionId);
      }
      return;
    }

    if (!isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Session ID required for non-initialize requests' },
        id: null,
      });
      return;
    }

    initializeSessionPool(sessionKey);

    let mcpServer: ReturnType<typeof createMcpServer> | undefined;
    let transport: Awaited<ReturnType<typeof sessionManager.createSession>>['transport'];

    try {
      mcpServer = createMcpServer({ sessionId: sessionKey, binding });
      const result = await sessionManager.createSession(mcpServer, sessionKey);
      transport = result.transport;
    } catch (err) {
      if (mcpServer) {
        await mcpServer.close().catch(() => {});
      }
      if (sessionKey !== GLOBAL_SESSION_KEY) {
        await closeSessionPool(sessionKey);
      }
      throw err;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    log.error({ err }, 'Error handling legacy MCP session request');
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
}

/**
 * Create the Express application
 */
export function createHttpApp(): Express {
  const app = express();
  const httpConfig = getHttpConfig();

  if (httpConfig.sessionMode === 'stateful') {
    log.warn(
      'MCP_SESSION_MODE=stateful is deprecated. Protocol sessions were removed in MCP 2026-07-28. ' +
      'The default stateless mode still isolates database pools by auth token. ' +
      'Stateful mode only keeps Mcp-Session-Id for 2025-era clients.'
    );
  }

  mcpHttpHandler = createMcpHandler(
    (ctx) => createHttpMcpServer(ctx.requestInfo),
    {
      legacy: httpConfig.sessionMode === 'stateful' ? 'reject' : 'stateless',
      onerror: (error) => log.error({ err: error }, 'MCP handler error'),
    }
  );
  const mcpNodeHandler = toNodeHandler(mcpHttpHandler);

  // Behind a proxy, MCP_TRUST_PROXY lets req.ip, and so the rate limits, see the client address
  app.set('trust proxy', httpConfig.trustProxy);

  // Middleware
  app.use(express.json());

  // Security headers
  app.use((req: Request, res: Response, next: express.NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  // Host allowlist. Runs before Origin checks so a rebinding request, which
  // sends the attacker's name in both Host and Origin, is rejected first.
  app.use((req: Request, res: Response, next: express.NextFunction) => {
    const hostHeader = req.headers.host;
    const hostname = typeof hostHeader === 'string' ? hostnameOf(hostHeader) : undefined;
    if (!hostname || !httpConfig.allowedHosts.includes(hostname)) {
      log.warn(
        {
          host: typeof hostHeader === 'string' ? hostHeader : undefined,
          reason: 'host_not_allowed',
          clientIp: req.socket.remoteAddress,
        },
        'Rejected request'
      );
      res.status(403).json({
        error: 'forbidden',
        error_description: 'Forbidden: Host not allowed',
      });
      return;
    }
    next();
  });

  // CORS and Origin validation (Streamable HTTP requires Origin checks)
  // By default (MCP_CORS_ORIGINS not set), only same-origin or missing Origin is allowed
  // Set MCP_CORS_ORIGINS='*' to allow all origins, or comma-separated list for specific origins
  app.use((req: Request, res: Response, next: express.NextFunction) => {
    const origin = req.headers.origin;
    const allowedOrigins = httpConfig.corsOrigins;
    const allowsAnyOrigin = allowedOrigins.includes('*');

    if (!allowsAnyOrigin) {
      res.vary('Origin');
    }

    if (origin) {
      const isConfiguredOrigin = allowsAnyOrigin || allowedOrigins.includes(origin);
      const isSameOrigin = isSameOriginRequest(origin, req);
      const isAllowed = isConfiguredOrigin || isSameOrigin;

      if (!isAllowed) {
        res.status(403).json({
          error: 'forbidden',
          error_description: 'Origin not allowed',
        });
        return;
      }

      if (isConfiguredOrigin) {
        // Bearer tokens travel in the Authorization header, not cookies, so
        // Access-Control-Allow-Credentials is never needed.
        res.setHeader('Access-Control-Allow-Origin', allowsAnyOrigin ? '*' : origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader(
          'Access-Control-Allow-Headers',
          'Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version, Mcp-Method, Mcp-Name'
        );
      }
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Project icon for browser tabs, connector lists and the MCP server info. No auth:
  // it is the same public logo for everyone.
  const sendIcon = (type: string, body: Buffer | string) => (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.type(type).send(body);
  };
  app.get('/favicon.ico', sendIcon('image/x-icon', FAVICON_ICO));
  app.get('/favicon.svg', sendIcon('image/svg+xml', FAVICON_SVG));
  app.get('/icon.png', sendIcon('image/png', ICON_PNG));
  app.get('/icon.svg', sendIcon('image/svg+xml', ICON_TILE_SVG));

  // One login limiter for POST /auth and the OAuth sign-in form, so they share a budget
  const authRateLimitMiddleware = createAuthRateLimitMiddleware(httpConfig.authRateLimit);

  // OAuth authorization server for remote clients (MCP_OAUTH_ENABLED)
  if (httpConfig.oauth) {
    app.use(createOAuthRouter(httpConfig.oauth, SERVER_NAME, {
      requests: createOAuthRateLimitMiddleware(httpConfig.oauthRateLimit),
      login: authRateLimitMiddleware,
    }));
  }

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
        oauthEnabled: httpConfig.oauth !== null,
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
        res.status(400).json({
          error: 'invalid_request',
          error_description: validation.error,
        });
        return;
      }

      const authReq = validation.request;

      // A profile plus the caller's credentials, or the request's host with env fallbacks,
      // proven with a test connection
      const login = await verifyLogin(authReq);
      if (!login.ok) {
        res.status(login.status).json({
          error: login.error,
          error_description: login.description,
        });
        return;
      }
      const { system, config: dbConfig } = login;

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
        const result = tokenManager.createSession(dbConfig, authReq.duration, system);
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

      const response: AuthResponse = {
        access_token: token,
        token_type: 'Bearer',
        expires_in: expiresIn,
        expires_at: expiresAt.toISOString(),
      };

      log.info(
        { host: dbConfig.hostname, system, user: dbConfig.username, expiresIn },
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

  // MCP endpoint. Default serves 2026-07-28 per request and stateless 2025 clients.
  // MCP_SESSION_MODE=stateful (deprecated) still routes claim-less 2025 traffic
  // through the session manager.
  app.all('/mcp', authMiddleware, async (req: Request, res: Response) => {
    try {
      if (httpConfig.sessionMode === 'stateful') {
        const probe = await toWebRequest(req, req.body);
        if (await isLegacyRequest(probe)) {
          await handleStatefulLegacyRequest(req, res);
          return;
        }
      }
      await mcpNodeHandler(req, res, req.body);
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

  return app;
}

/**
 * Start the HTTP server
 */
export async function startHttpServer(): Promise<http.Server | https.Server> {
  const httpConfig = getHttpConfig();

  if (
    !isLoopbackHost(httpConfig.host) &&
    httpConfig.authMode === 'none' &&
    !httpConfig.allowUnauthenticatedHttp
  ) {
    throw new Error(
      `Refusing to listen on ${httpConfig.host} with MCP_AUTH_MODE=none. ` +
      'Enable authentication, bind a loopback address, or set MCP_ALLOW_UNAUTHENTICATED_HTTP=true.'
    );
  }

  if (httpConfig.authMode === 'required' && authAllowedDbHosts() === null) {
    log.warn(
      'MCP_AUTH_ALLOWED_DB_HOSTS and DB2I_HOSTNAME are unset. ' +
      '/auth will open a database connection to any host the client names.'
    );
  }

  if (httpConfig.oauth?.ephemeralSecret) {
    log.warn(
      'MCP_OAUTH_SECRET is unset, so OAuth clients registered before a restart must register again. ' +
      'Set it to a random value: openssl rand -hex 32'
    );
  }

  const app = createHttpApp();

  // Register cleanup callback to close session pools when tokens expire or are revoked.
  // This handles cleanup for both stateful and stateless modes in 'required' auth:
  // - sessionKey = authToken, so pools are keyed by token
  // - Pools are intentionally reused across requests for the same token (efficiency)
  // - When token expires/revokes, this callback closes the associated pool
  if (httpConfig.authMode === 'required') {
    const tokenManager = getTokenManager();
    tokenManager.setCleanupCallback(async (token: string) => {
      await getSessionManager().closeSessionsByToken(token);
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
    if (!isLoopbackHost(httpConfig.host)) {
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

  if (mcpHttpHandler) {
    await mcpHttpHandler.close().catch((err) => {
      log.error({ err }, 'Error closing MCP HTTP handler');
    });
    mcpHttpHandler = undefined;
  }

  // Close session manager (closes MCP sessions)
  const sessionManager = getSessionManager();
  await sessionManager.shutdown();

  // Close token manager (clears auth tokens and triggers pool cleanup via callback)
  const tokenManager = getTokenManager();
  await tokenManager.shutdown();
  resetOAuthState();

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
