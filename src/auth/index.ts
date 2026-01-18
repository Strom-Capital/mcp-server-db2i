/**
 * Authentication module for HTTP transport
 * 
 * Exports all auth-related types, middleware, and utilities.
 */

// Types
export type {
  AuthRequest,
  AuthResponse,
  AuthErrorResponse,
  TokenSession,
  TokenValidationResult,
  AuthValidationResult,
} from './types.js';

// Token Manager
export { getTokenManager, TokenManager, type SessionCleanupCallback } from './tokenManager.js';

// Middleware
export {
  authMiddleware,
  optionalAuthMiddleware,
  authRateLimitMiddleware,
  recordFailedAuthAttempt,
  clearAuthRateLimit,
  type AuthenticatedRequest,
} from './authMiddleware.js';
