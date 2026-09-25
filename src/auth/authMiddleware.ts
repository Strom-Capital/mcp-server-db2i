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

  // With the OAuth server on, point clients at the protected resource metadata (RFC 9728)
  if (httpConfig.oauth) {
    res.setHeader(
      'WWW-Authenticate',
      `Bearer resource_metadata="${httpConfig.oauth.publicUrl}/.well-known/oauth-protected-resource/mcp"` +
        (token ? ', error="invalid_token"' : '')
    );
  }

  if (!token) {
    log.debug(
      { path: req.path, method: req.method },
      'Missing or invalid Authorization header'
    );
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

/**
 * Rate limiting middleware for auth endpoints
 * 
 * Simple in-memory rate limiter to prevent brute force attacks.
 * Tracks attempts by IP address. Each attempt is counted when it arrives,
 * because failures are only known after a slow database connection test and
 * parallel requests would otherwise all pass the check.
 */
const authAttempts = new Map<string, { count: number; resetAt: number }>();
const AUTH_RATE_LIMIT = {
  maxAttempts: 5,
  windowMs: 60000, // 1 minute
};

/** Past this many tracked addresses, expired entries are dropped before adding more. */
const AUTH_ATTEMPTS_SWEEP_SIZE = 1000;

function sweepAuthAttempts(now: number): void {
  for (const [ip, entry] of authAttempts) {
    if (entry.resetAt <= now) {
      authAttempts.delete(ip);
    }
  }
}

/**
 * Get client IP from request
 * 
 * Uses Express's req.ip which respects the 'trust proxy' setting.
 * If proxy is trusted, req.ip will contain the client IP from X-Forwarded-For.
 * If proxy is not trusted, req.ip will be the direct connection IP.
 * 
 * To trust proxy headers, set app.set('trust proxy', true) or configure
 * specific trusted proxies. Without this, X-Forwarded-For headers are ignored.
 */
function getClientIp(req: Request): string {
  // Use Express's req.ip which respects 'trust proxy' setting
  // This prevents IP spoofing when proxy is not trusted
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/**
 * Auth rate limiting middleware
 * 
 * Limits authentication attempts per IP to prevent brute force.
 * Should be applied to the /auth endpoint. Call clearAuthRateLimit
 * after a successful authentication.
 */
export function authRateLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const retryAfter = consumeAuthAttempt(req);
  if (retryAfter !== null) {
    res.status(429).json({
      error: 'too_many_requests',
      error_description: `Too many authentication attempts. Try again in ${retryAfter} seconds.`,
      retry_after: retryAfter,
    });
    return;
  }
  next();
}

/**
 * Count one login attempt against the caller's IP, sharing the /auth budget.
 * For handlers that answer a rate-limited request themselves, such as the OAuth login page.
 *
 * @returns null when the attempt is allowed, else seconds until the next one is
 */
export function consumeAuthAttempt(req: Request): number | null {
  const ip = getClientIp(req);
  const now = Date.now();
  if (authAttempts.size >= AUTH_ATTEMPTS_SWEEP_SIZE) {
    sweepAuthAttempts(now);
  }

  let current = authAttempts.get(ip);
  if (!current || current.resetAt <= now) {
    current = { count: 0, resetAt: now + AUTH_RATE_LIMIT.windowMs };
    authAttempts.set(ip, current);
  }

  if (current.count >= AUTH_RATE_LIMIT.maxAttempts) {
    log.warn({ ip, attempts: current.count }, 'Auth rate limit exceeded');
    return Math.ceil((current.resetAt - now) / 1000);
  }

  current.count++;
  return null;
}

/**
 * Clear rate limit for an IP (on successful auth)
 */
export function clearAuthRateLimit(req: Request): void {
  const ip = getClientIp(req);
  authAttempts.delete(ip);
}

/**
 * Forget all login attempts. Used by tests.
 */
export function resetAuthRateLimits(): void {
  authAttempts.clear();
}
