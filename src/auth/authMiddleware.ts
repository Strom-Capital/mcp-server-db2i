/**
 * Authentication Middleware for HTTP Transport
 * 
 * Express middleware to validate Bearer tokens on protected routes.
 * Supports multiple authentication modes:
 * - 'required': Full /auth flow with per-user DB credentials (default)
 * - 'token': Pre-shared static token, uses env DB credentials
 * - 'none': No authentication required, uses env DB credentials
 */

import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { getTokenManager } from './tokenManager.js';
import { createChildLogger } from '../utils/logger.js';
import { getHttpConfig, type AuthMode } from '../config.js';
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

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(authHeader: string | undefined): string | null {
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
    
    // Use constant-time comparison to prevent timing attacks
    const staticToken = httpConfig.staticToken ?? '';
    const tokenBuffer = Buffer.from(token);
    const staticTokenBuffer = Buffer.from(staticToken);
    const tokensMatch = tokenBuffer.length === staticTokenBuffer.length &&
      timingSafeEqual(tokenBuffer, staticTokenBuffer);
    
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
 * Get the current auth mode for use in route handlers
 */
export function getAuthModeFromConfig(): AuthMode {
  return getHttpConfig().authMode;
}

/**
 * Optional authentication middleware
 * 
 * Similar to authMiddleware but doesn't require authentication.
 * If a valid token is provided, attaches the session to the request.
 * If no token or invalid token, continues without error.
 * 
 * Useful for endpoints that work with or without authentication.
 */
export function optionalAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;
  const token = extractBearerToken(authHeader);

  if (token) {
    const tokenManager = getTokenManager();
    const result = tokenManager.validateToken(token);

    if (result.valid && result.session) {
      (req as AuthenticatedRequest).tokenSession = result.session;
      (req as AuthenticatedRequest).authToken = token;
    }
  }

  next();
}

/**
 * Rate limiting middleware for auth endpoints
 * 
 * Simple in-memory rate limiter to prevent brute force attacks.
 * Tracks failed attempts by IP address.
 */
const authAttempts = new Map<string, { count: number; resetAt: number }>();
const AUTH_RATE_LIMIT = {
  maxAttempts: 5,
  windowMs: 60000, // 1 minute
};

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
 * Should be applied to the /auth endpoint.
 */
export function authRateLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const ip = getClientIp(req);
  const now = Date.now();

  // Clean up expired entries
  const entry = authAttempts.get(ip);
  if (entry && entry.resetAt < now) {
    authAttempts.delete(ip);
  }

  const current = authAttempts.get(ip);

  if (current && current.count >= AUTH_RATE_LIMIT.maxAttempts) {
    const retryAfter = Math.ceil((current.resetAt - now) / 1000);
    log.warn({ ip, attempts: current.count }, 'Auth rate limit exceeded');
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
 * Record a failed auth attempt for rate limiting
 */
export function recordFailedAuthAttempt(req: Request): void {
  const ip = getClientIp(req);
  const now = Date.now();

  const current = authAttempts.get(ip);
  if (current && current.resetAt > now) {
    current.count++;
  } else {
    authAttempts.set(ip, {
      count: 1,
      resetAt: now + AUTH_RATE_LIMIT.windowMs,
    });
  }
}

/**
 * Clear rate limit for an IP (on successful auth)
 */
export function clearAuthRateLimit(req: Request): void {
  const ip = getClientIp(req);
  authAttempts.delete(ip);
}
