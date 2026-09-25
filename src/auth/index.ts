/**
 * Authentication module for HTTP transport
 * 
 * Exports all auth-related types, middleware, and utilities.
 */

// Types
export type {
  AuthRequest,
  AuthResponse,
  TokenSession,
  TokenValidationResult,
  AuthValidationResult,
} from './types.js';

// Token Manager
export { getTokenManager, TokenManager, type SessionCleanupCallback } from './tokenManager.js';

// Middleware
export {
  authMiddleware,
  extractBearerToken,
  authRateLimitMiddleware,
  oauthRateLimitMiddleware,
  type LoginRateLimitedHandler,
  type AuthenticatedRequest,
} from './authMiddleware.js';

// IBM i login shared by /auth and OAuth
export { authAllowedDbHosts, authConnection, testCredentials, verifyLogin, type LoginResult } from './login.js';

// OAuth authorization server
export { createOAuthRouter, resetOAuthState } from './oauth.js';
