/**
 * Authentication types for HTTP transport
 * 
 * Defines interfaces for OAuth-style token authentication:
 * - AuthRequest: Credentials and optional config for token exchange
 * - AuthResponse: Token response following OAuth conventions
 * - TokenSession: Internal session storage
 */

import type { DB2iConfig } from '../config.js';

/**
 * Authentication request body for POST /auth
 * 
 * Required fields:
 * - username: IBM i user profile
 * - password: IBM i password
 * 
 * Optional fields (fall back to environment variables):
 * - host: IBM i hostname (falls back to DB2I_HOSTNAME)
 * - port: Connection port (falls back to DB2I_PORT, default: 446)
 * - database: Database name (falls back to DB2I_DATABASE, default: *LOCAL)
 * - schema: Default schema (falls back to DB2I_SCHEMA)
 * - duration: Token lifetime in seconds (falls back to MCP_TOKEN_EXPIRY, default: 3600)
 */
export interface AuthRequest {
  /** IBM i username (required) */
  username: string;
  /** IBM i password (required) */
  password: string;
  /** IBM i hostname (optional, falls back to DB2I_HOSTNAME) */
  host?: string;
  /** Connection port (optional, falls back to DB2I_PORT) */
  port?: number;
  /** Database name (optional, falls back to DB2I_DATABASE) */
  database?: string;
  /** Default schema (optional, falls back to DB2I_SCHEMA) */
  schema?: string;
  /** Token lifetime in seconds (optional, default: 3600) */
  duration?: number;
}

/**
 * Authentication response for successful token exchange
 * Follows OAuth 2.0 token response conventions
 */
export interface AuthResponse {
  /** The access token to use for subsequent requests */
  access_token: string;
  /** Token type (always "Bearer") */
  token_type: 'Bearer';
  /** Token lifetime in seconds */
  expires_in: number;
  /** ISO 8601 timestamp of when the token expires */
  expires_at: string;
}

/**
 * Authentication error response
 */
export interface AuthErrorResponse {
  /** Error code */
  error: string;
  /** Human-readable error description */
  error_description?: string;
}

/**
 * Internal token session storage
 * Stores the token, associated DB config, and lifecycle metadata
 */
export interface TokenSession {
  /** The access token */
  token: string;
  /** DB2i configuration for this session */
  config: DB2iConfig;
  /** When the token was created */
  createdAt: Date;
  /** When the token expires */
  expiresAt: Date;
  /** When the token was last used */
  lastUsedAt: Date;
  /** MCP session ID (for stateful mode) */
  mcpSessionId?: string;
}

/**
 * Token validation result
 */
export interface TokenValidationResult {
  /** Whether the token is valid */
  valid: boolean;
  /** The session if valid */
  session?: TokenSession;
  /** Error message if invalid */
  error?: string;
}

/**
 * Auth request validation result
 */
export interface AuthValidationResult {
  /** Whether the request is valid */
  valid: boolean;
  /** Validated and normalized request if valid */
  request?: AuthRequest;
  /** Error message if invalid */
  error?: string;
}
