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
  createAuthRateLimitMiddleware,
  clearAuthRateLimit,
  type AuthenticatedRequest,
} from './authMiddleware.js';
