/**
 * Authentication Middleware for HTTP Transport
 * 
 * Express middleware to validate Bearer tokens on protected routes.
 * Supports multiple authentication modes:
 * - 'required': Full /auth flow with per-user DB credentials (default).
 *   With MCP_OAUTH_ENABLED, 401 responses carry a WWW-Authenticate challenge.
 * - 'token': Pre-shared static token, uses env DB credentials
 * - 'none': No authentication required, uses env DB credentials
 */

import type { Request, Response, NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ipKeyGenerator, MemoryStore, rateLimit } from 'express-rate-limit';
import { getTokenManager } from './tokenManager.js';
import { createChildLogger } from '../utils/logger.js';
import { getHttpConfig } from '../config.js';
import type { TokenSession } from './types.js';

const log = createChildLogger({ component: 'auth-middleware' });

/**
 * Extended Express Request with auth context
 */
export interface AuthenticatedRequest extends Request {
  /** The validated token session */
  tokenSession?: TokenSession;
  /** The raw token string */
  authToken?: string;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Extract Bearer token from Authorization header
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return null;
  }

  return parts[1];
}

/**
 * Authentication middleware for protected routes
 * 
 * Behavior depends on MCP_AUTH_MODE:
 * - 'required': Validates Bearer token from /auth flow, attaches token session
 * - 'token': Validates Bearer token against static MCP_AUTH_TOKEN
 * - 'none': Skips authentication entirely
 * 
 * @example
 * app.post('/mcp', authMiddleware, (req, res) => {
 *   const session = (req as AuthenticatedRequest).tokenSession;
 *   // Use session.config for DB connection (only in 'required' mode)
 * });
 */
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const httpConfig = getHttpConfig();
  
  // No auth mode - skip authentication entirely
  if (httpConfig.authMode === 'none') {
    log.debug(
      { path: req.path, method: req.method, authMode: 'none' },
      'Auth disabled, allowing request'
    );
    return next();
  }
  
  // Token mode - validate against static token
  if (httpConfig.authMode === 'token') {
    const authHeader = req.headers.authorization;
    const token = extractBearerToken(authHeader);
    
    if (!token) {
      log.debug(
        { path: req.path, method: req.method },
        'Missing or invalid Authorization header (token mode)'
      );
      res.status(401).json({
        error: 'unauthorized',
        error_description: 'Missing or invalid Authorization header. Use: Authorization: Bearer <token>',
      });
      return;
    }
    
    // Compare digests in constant time, so neither the contents nor the length leak
    const tokensMatch = timingSafeEqual(sha256(token), sha256(httpConfig.staticToken ?? ''));
    
    if (tokensMatch) {
      log.debug(
        { path: req.path, method: req.method, authMode: 'token' },
        'Static token validated'
      );
      // Store token for session keying (will use global config for DB)
      (req as AuthenticatedRequest).authToken = token;
      return next();
    }
    
    log.debug(
      { path: req.path, method: req.method },
      'Invalid static token'
    );
    res.status(401).json({
      error: 'invalid_token',
      error_description: 'Invalid authentication token',
    });
    return;
  }
  
  // Required mode - full token validation with per-user credentials
  const authHeader = req.headers.authorization;
  const token = extractBearerToken(authHeader);

  // With the OAuth server on, a 401 points clients at the protected resource metadata (RFC 9728)
  const challenge = (error?: string): void => {
    if (httpConfig.oauth) {
      res.setHeader(
        'WWW-Authenticate',
        `Bearer resource_metadata="${httpConfig.oauth.publicUrl}/.well-known/oauth-protected-resource/mcp"` +
          (error ? `, error="${error}"` : '')
      );
    }
  };

  if (!token) {
    log.debug(
      { path: req.path, method: req.method },
      'Missing or invalid Authorization header'
    );
    challenge();
    res.status(401).json({
      error: 'unauthorized',
      error_description: 'Missing or invalid Authorization header. Use: Authorization: Bearer <token>',
    });
    return;
  }

  const tokenManager = getTokenManager();
  const result = tokenManager.validateToken(token);

  if (!result.valid || !result.session) {
    log.debug(
      { path: req.path, method: req.method, error: result.error },
      'Token validation failed'
    );
    challenge('invalid_token');
    res.status(401).json({
      error: 'invalid_token',
      error_description: result.error ?? 'Token validation failed',
    });
    return;
  }

  // Attach session to request
  (req as AuthenticatedRequest).tokenSession = result.session;
  (req as AuthenticatedRequest).authToken = token;

  log.debug(
    {
      path: req.path,
      method: req.method,
      user: result.session.config.username,
      host: result.session.config.hostname,
    },
    'Request authenticated'
  );

  next();
}

/** Login attempts per IP: POST /auth and the OAuth sign-in form share this budget. */
const AUTH_RATE_LIMIT = {
  maxAttempts: 5,
  windowMs: 60000, // 1 minute
};

/** Requests per IP across the OAuth endpoints. Generous, because hosted clients such as claude.ai share egress addresses. */
const OAUTH_RATE_LIMIT = {
  maxRequests: 120,
  windowMs: 60000,
};

const loginAttemptStore = new MemoryStore();
const oauthRequestStore = new MemoryStore();

/**
 * Get client IP from request
 * 
 * Uses Express's req.ip which respects the 'trust proxy' setting.
 * If proxy is trusted, req.ip will contain the client IP from X-Forwarded-For.
 * If proxy is not trusted, req.ip will be the direct connection IP.
 * 
 * MCP_TRUST_PROXY sets Express's 'trust proxy'. Without it, X-Forwarded-For
 * headers are ignored and every request behind a proxy shares the proxy's address.
 */
function getClientIp(req: Request): string {
  // Use Express's req.ip which respects 'trust proxy' setting
  // This prevents IP spoofing when proxy is not trusted
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/** Rate limit key: the client IP, with IPv6 addresses grouped by /56 so one host cannot rotate through its range. */
function rateLimitKey(req: Request): string {
  return ipKeyGenerator(getClientIp(req));
}

/** Seconds until the caller's window resets. */
function retryAfterSeconds(req: Request): number {
  const resetTime = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
  return resetTime ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000)) : 60;
}

/**
 * Handler a route can set on `res.locals.onLoginRateLimited` to answer a
 * rate-limited login itself, such as the OAuth sign-in page rendering HTML.
 */
export type LoginRateLimitedHandler = (retryAfter: number) => void;

/**
 * Auth rate limiting middleware
 *
 * Limits login attempts per IP to prevent brute force. Applied to POST /auth
 * and the OAuth sign-in form, which share one budget. Each attempt is counted
 * when it arrives, because failures are only known after a slow database
 * connection test and parallel requests would otherwise all pass the check.
 * A successful login gives back only its own attempt. It never clears earlier
 * failures, so a caller with one valid profile cannot use it to reset the count
 * while guessing the password of another.
 */
export const authRateLimitMiddleware = rateLimit({
  windowMs: AUTH_RATE_LIMIT.windowMs,
  limit: AUTH_RATE_LIMIT.maxAttempts,
  store: loginAttemptStore,
  keyGenerator: rateLimitKey,
  // Success is a 2xx from /auth or the 303 redirect from the sign-in form
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  // X-Forwarded-For is ignored unless MCP_TRUST_PROXY is set; that is deliberate
  validate: { xForwardedForHeader: false },
  handler: (req: Request, res: Response) => {
    const retryAfter = retryAfterSeconds(req);
    log.warn({ ip: getClientIp(req) }, 'Auth rate limit exceeded');
    const custom = res.locals.onLoginRateLimited as LoginRateLimitedHandler | undefined;
    if (custom) {
      custom(retryAfter);
      return;
    }
    res.status(429).json({
      error: 'too_many_requests',
      error_description: `Too many authentication attempts. Try again in ${retryAfter} seconds.`,
      retry_after: retryAfter,
    });
  },
});

/**
 * Per-IP request limit for the OAuth endpoints (registration, sign-in, token, revoke).
 * Sign-in attempts are limited further by authRateLimitMiddleware.
 */
export const oauthRateLimitMiddleware = rateLimit({
  windowMs: OAUTH_RATE_LIMIT.windowMs,
  limit: OAUTH_RATE_LIMIT.maxRequests,
  store: oauthRequestStore,
  keyGenerator: rateLimitKey,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  handler: (req: Request, res: Response) => {
    const retryAfter = retryAfterSeconds(req);
    log.warn({ ip: getClientIp(req) }, 'OAuth rate limit exceeded');
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({
      error: 'too_many_requests',
      error_description: `Too many requests. Try again in ${retryAfter} seconds.`,
    });
  },
});

/**
 * Forget all login attempts and OAuth request counts. Used by tests.
 */
export async function resetAuthRateLimits(): Promise<void> {
  await loginAttemptStore.resetAll();
  await oauthRequestStore.resetAll();
}
