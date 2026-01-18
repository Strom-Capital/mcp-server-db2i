/**
 * Configuration module for IBM DB2i MCP Server
 * Handles environment variables and JDBC connection options
 *
 * Supports file-based secrets (e.g., Docker secrets) via *_FILE environment variables.
 * File-based secrets take priority over plain environment variables.
 * 
 * HTTP Transport Configuration:
 * - MCP_TRANSPORT: 'stdio' | 'http' | 'both' (default: 'stdio')
 * - MCP_HTTP_PORT: HTTP server port (default: 3000)
 * - MCP_HTTP_HOST: HTTP bind address (default: '127.0.0.1')
 * - MCP_SESSION_MODE: 'stateful' | 'stateless' (default: 'stateful')
 * - MCP_AUTH_MODE: 'required' | 'token' | 'none' (default: 'required')
 * - MCP_AUTH_TOKEN: Static token for 'token' auth mode
 * - MCP_TLS_ENABLED: Enable built-in TLS (default: false)
 * - MCP_TLS_CERT_PATH: Path to TLS certificate
 * - MCP_TLS_KEY_PATH: Path to TLS private key
 * - MCP_TOKEN_EXPIRY: Token lifetime in seconds (default: 3600)
 * - MCP_MAX_SESSIONS: Maximum concurrent sessions (default: 100)
 * - MCP_CORS_ORIGINS: CORS allowed origins (comma-separated, '*' for all)
 */

import { readFileSync, existsSync } from 'node:fs';

export interface DB2iConfig {
  hostname: string;
  port: number;
  username: string;
  password: string;
  database: string;
  schema: string;
  jdbcOptions: Record<string, string>;
}

/**
 * Valid log levels for the application
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * Get the configured log level from environment
 * Defaults to 'info' if not set or invalid
 */
export function getLogLevel(): LogLevel {
  const level = process.env.LOG_LEVEL?.toLowerCase();
  const validLevels: LogLevel[] = ['debug', 'info', 'warn', 'error', 'fatal'];

  if (level && validLevels.includes(level as LogLevel)) {
    return level as LogLevel;
  }

  return 'info';
}

/**
 * Read a secret value from a file.
 * Docker secrets are typically mounted at /run/secrets/<secret_name>
 *
 * @param filePath - Path to the file containing the secret
 * @returns The secret value with leading/trailing whitespace trimmed
 * @throws Error if file cannot be read
 */
export function readSecretFromFile(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`Secret file not found: ${filePath}`);
  }
  return readFileSync(filePath, 'utf8').trim();
}

/**
 * Get a secret value from either a file or environment variable.
 * File-based secrets take priority (more secure).
 *
 * @param envVar - Name of the environment variable containing the value
 * @param fileEnvVar - Name of the environment variable containing the file path
 * @returns The secret value, or undefined if neither is set
 */
export function getSecret(envVar: string, fileEnvVar: string): string | undefined {
  const filePath = process.env[fileEnvVar];
  if (filePath) {
    return readSecretFromFile(filePath);
  }
  return process.env[envVar];
}

/**
 * Validate hostname format.
 * Accepts valid hostnames (RFC 1123) and IPv4 addresses.
 *
 * @param hostname - The hostname or IP address to validate
 * @returns true if the hostname format is valid, false otherwise
 */
export function validateHostname(hostname: string): boolean {
  const trimmed = hostname.trim();
  if (!trimmed) return false;

  // IPv4 pattern: four octets separated by dots
  const ipv4Pattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const ipv4Match = trimmed.match(ipv4Pattern);
  if (ipv4Match) {
    // Validate each octet is 0-255
    return ipv4Match.slice(1).every((octet) => {
      const num = parseInt(octet, 10);
      return num >= 0 && num <= 255;
    });
  }

  // Hostname pattern (RFC 1123):
  // - Labels separated by dots
  // - Each label: 1-63 chars, alphanumeric or hyphen, cannot start/end with hyphen
  // - Total length up to 253 chars
  if (trimmed.length > 253) return false;

  const hostnamePattern =
    /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  return hostnamePattern.test(trimmed);
}

/**
 * Parse JDBC options from a semicolon-separated string
 * Format: "key1=value1;key2=value2"
 */
function parseJdbcOptions(optionsString: string | undefined): Record<string, string> {
  if (!optionsString) {
    return {};
  }

  const options: Record<string, string> = {};
  const pairs = optionsString.split(';');

  for (const pair of pairs) {
    const trimmed = pair.trim();
    if (!trimmed) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex > 0) {
      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1).trim();
      options[key] = value;
    }
  }

  return options;
}

/**
 * Load configuration from environment variables.
 *
 * Supports file-based secrets for sensitive values (recommended for production):
 * - DB2I_PASSWORD_FILE: Path to file containing password (e.g., Docker secret)
 * - DB2I_USERNAME_FILE: Path to file containing username (optional)
 *
 * File-based secrets take priority over plain environment variables.
 */
export function loadConfig(): DB2iConfig {
  const hostname = process.env.DB2I_HOSTNAME;
  const username = getSecret('DB2I_USERNAME', 'DB2I_USERNAME_FILE');
  const password = getSecret('DB2I_PASSWORD', 'DB2I_PASSWORD_FILE');

  if (!hostname) {
    throw new Error('DB2I_HOSTNAME environment variable is required');
  }
  if (!validateHostname(hostname)) {
    throw new Error(
      `Invalid DB2I_HOSTNAME format: "${hostname}". Must be a valid hostname or IPv4 address.`
    );
  }
  if (!username) {
    throw new Error(
      'DB2I_USERNAME environment variable is required (or DB2I_USERNAME_FILE for file-based secret)'
    );
  }
  if (!password) {
    throw new Error(
      'DB2I_PASSWORD environment variable is required (or DB2I_PASSWORD_FILE for file-based secret)'
    );
  }

  return {
    hostname,
    port: parseInt(process.env.DB2I_PORT || '446', 10),
    username,
    password,
    database: process.env.DB2I_DATABASE || '*LOCAL',
    schema: process.env.DB2I_SCHEMA || '',
    jdbcOptions: parseJdbcOptions(process.env.DB2I_JDBC_OPTIONS),
  };
}

/**
 * Build JDBC connection configuration for node-jt400
 */
export function buildConnectionConfig(config: DB2iConfig): {
  host: string;
  user: string;
  password: string;
  [key: string]: string;
} {
  const connectionConfig: {
    host: string;
    user: string;
    password: string;
    [key: string]: string;
  } = {
    host: config.hostname,
    user: config.username,
    password: config.password,
  };

  // Add default naming convention (system naming uses / for library separator)
  if (!config.jdbcOptions['naming']) {
    connectionConfig['naming'] = 'system';
  }

  // Add date format if not specified
  if (!config.jdbcOptions['date format']) {
    connectionConfig['date format'] = 'iso';
  }

  // Merge additional JDBC options
  for (const [key, value] of Object.entries(config.jdbcOptions)) {
    connectionConfig[key] = value;
  }

  return connectionConfig;
}

/**
 * Get the default schema from config
 */
export function getDefaultSchema(config: DB2iConfig): string | undefined {
  return config.schema || undefined;
}

/**
 * Rate limit configuration interface
 */
export interface RateLimitConfig {
  /** Time window in milliseconds (default: 900000 = 15 minutes) */
  windowMs: number;
  /** Maximum requests allowed per window (default: 100) */
  maxRequests: number;
  /** Whether rate limiting is enabled (default: true) */
  enabled: boolean;
}

/**
 * Default rate limit configuration values
 *
 * Environment variables:
 * - RATE_LIMIT_WINDOW_MS: Time window in milliseconds (default: 900000)
 * - RATE_LIMIT_MAX_REQUESTS: Max requests per window (default: 100)
 * - RATE_LIMIT_ENABLED: Set to 'false' or '0' to disable (default: true)
 */
export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 100,
  enabled: true,
};

/**
 * Query limit configuration interface
 */
export interface QueryLimitConfig {
  /** Default number of rows to return (default: 1000) */
  defaultLimit: number;
  /** Maximum number of rows allowed (default: 10000) */
  maxLimit: number;
}

/**
 * Default query limit configuration values
 *
 * Environment variables:
 * - QUERY_DEFAULT_LIMIT: Default rows to return (default: 1000)
 * - QUERY_MAX_LIMIT: Maximum rows allowed, caps user-provided limits (default: 10000)
 */
export const DEFAULT_QUERY_LIMIT: QueryLimitConfig = {
  defaultLimit: 1000,
  maxLimit: 10000,
};

/**
 * Get query limit configuration from environment variables
 */
export function getQueryLimitConfig(): QueryLimitConfig {
  const defaultLimit = parseInt(process.env.QUERY_DEFAULT_LIMIT || '1000', 10);
  const maxLimit = parseInt(process.env.QUERY_MAX_LIMIT || '10000', 10);

  return {
    defaultLimit: Math.max(1, defaultLimit),
    maxLimit: Math.max(1, maxLimit),
  };
}

/**
 * Apply query limit constraints.
 * Returns the effective limit, capped to maxLimit.
 *
 * @param requestedLimit - The limit requested by the user (or undefined for default)
 * @param config - Query limit configuration
 * @returns The effective limit to use
 */
export function applyQueryLimit(
  requestedLimit: number | undefined,
  config: QueryLimitConfig = getQueryLimitConfig()
): number {
  const limit = requestedLimit ?? config.defaultLimit;
  return Math.min(Math.max(1, limit), config.maxLimit);
}

// ============================================================================
// HTTP Transport Configuration
// ============================================================================

/**
 * Transport mode options
 */
export type TransportMode = 'stdio' | 'http' | 'both';

/**
 * Session mode options for HTTP transport
 */
export type SessionMode = 'stateful' | 'stateless';

/**
 * Authentication mode options for HTTP transport
 * - 'required': Full /auth flow with per-user DB credentials (most secure, default)
 * - 'token': Pre-shared static token via MCP_AUTH_TOKEN, uses env DB credentials
 * - 'none': No authentication required, uses env DB credentials (trusted networks only)
 */
export type AuthMode = 'required' | 'token' | 'none';

/**
 * TLS configuration for HTTP transport
 */
export interface TlsConfig {
  /** Whether TLS is enabled */
  enabled: boolean;
  /** Path to TLS certificate file */
  certPath?: string;
  /** Path to TLS private key file */
  keyPath?: string;
}

/**
 * HTTP transport configuration
 */
export interface HttpConfig {
  /** Transport mode: stdio, http, or both (default: stdio) */
  transport: TransportMode;
  /** HTTP server port (default: 3000) */
  port: number;
  /** HTTP server bind address (default: 127.0.0.1) */
  host: string;
  /** Session mode: stateful or stateless (default: stateful) */
  sessionMode: SessionMode;
  /** Authentication mode: required, token, or none (default: required) */
  authMode: AuthMode;
  /** Static token for 'token' auth mode */
  staticToken?: string;
  /** TLS configuration */
  tls: TlsConfig;
  /** Token expiry time in seconds (default: 3600) */
  tokenExpiry: number;
  /** Maximum concurrent sessions (default: 100) */
  maxSessions: number;
  /** CORS allowed origins (comma-separated, '*' for all, empty for none) */
  corsOrigins: string[];
}

/**
 * Default HTTP configuration values
 */
export const DEFAULT_HTTP_CONFIG: HttpConfig = {
  transport: 'stdio',
  port: 3000,
  host: '127.0.0.1',
  sessionMode: 'stateful',
  authMode: 'required',
  tls: {
    enabled: false,
  },
  tokenExpiry: 3600,
  maxSessions: 100,
  corsOrigins: [],
};

/**
 * Parse CORS origins from environment variable
 * Returns array of allowed origins, or ['*'] for all
 */
export function getCorsOrigins(): string[] {
  const origins = process.env.MCP_CORS_ORIGINS;
  if (!origins || origins.trim() === '') {
    return [];
  }
  return origins.split(',').map(o => o.trim()).filter(o => o.length > 0);
}

/**
 * Get the configured transport mode
 * Defaults to 'stdio' for backwards compatibility
 */
export function getTransportMode(): TransportMode {
  const mode = process.env.MCP_TRANSPORT?.toLowerCase();
  if (mode === 'http' || mode === 'both') {
    return mode;
  }
  return 'stdio';
}

/**
 * Get the configured session mode
 * Defaults to 'stateful'
 */
export function getSessionMode(): SessionMode {
  const mode = process.env.MCP_SESSION_MODE?.toLowerCase();
  if (mode === 'stateless') {
    return 'stateless';
  }
  return 'stateful';
}

/**
 * Get the configured authentication mode for HTTP transport
 * Defaults to 'required' for security
 * 
 * Environment variables:
 * - MCP_AUTH_MODE: 'required' | 'token' | 'none' (default: 'required')
 * - MCP_AUTH_TOKEN: Static token for 'token' mode (required if mode='token')
 */
export function getAuthMode(): AuthMode {
  const mode = process.env.MCP_AUTH_MODE?.toLowerCase();
  if (mode === 'none' || mode === 'token') {
    return mode;
  }
  return 'required';
}

/**
 * Get the static auth token for 'token' mode
 */
export function getStaticToken(): string | undefined {
  return process.env.MCP_AUTH_TOKEN;
}

/**
 * Get TLS configuration from environment variables
 */
export function getTlsConfig(): TlsConfig {
  const enabled = process.env.MCP_TLS_ENABLED?.toLowerCase();
  const isEnabled = enabled === 'true' || enabled === '1';

  if (!isEnabled) {
    return { enabled: false };
  }

  const certPath = process.env.MCP_TLS_CERT_PATH;
  const keyPath = process.env.MCP_TLS_KEY_PATH;

  if (!certPath || !keyPath) {
    throw new Error(
      'MCP_TLS_CERT_PATH and MCP_TLS_KEY_PATH are required when MCP_TLS_ENABLED=true'
    );
  }

  if (!existsSync(certPath)) {
    throw new Error(`TLS certificate file not found: ${certPath}`);
  }

  if (!existsSync(keyPath)) {
    throw new Error(`TLS key file not found: ${keyPath}`);
  }

  return {
    enabled: true,
    certPath,
    keyPath,
  };
}

/**
 * Load HTTP transport configuration from environment variables
 */
export function getHttpConfig(): HttpConfig {
  const authMode = getAuthMode();
  const staticToken = getStaticToken();

  // Validate token mode has a token configured
  if (authMode === 'token' && !staticToken) {
    throw new Error(
      'MCP_AUTH_TOKEN is required when MCP_AUTH_MODE=token. Generate with: openssl rand -hex 32'
    );
  }

  return {
    transport: getTransportMode(),
    port: parseInt(process.env.MCP_HTTP_PORT || '3000', 10),
    host: process.env.MCP_HTTP_HOST || '127.0.0.1',
    sessionMode: getSessionMode(),
    authMode,
    staticToken,
    tls: getTlsConfig(),
    tokenExpiry: parseInt(process.env.MCP_TOKEN_EXPIRY || '3600', 10),
    maxSessions: parseInt(process.env.MCP_MAX_SESSIONS || '100', 10),
    corsOrigins: getCorsOrigins(),
  };
}

/**
 * Check if HTTP transport is enabled
 */
export function isHttpEnabled(): boolean {
  const mode = getTransportMode();
  return mode === 'http' || mode === 'both';
}

/**
 * Check if stdio transport is enabled
 */
export function isStdioEnabled(): boolean {
  const mode = getTransportMode();
  return mode === 'stdio' || mode === 'both';
}

/**
 * Load partial DB2i config from optional parameters with env fallbacks.
 * Used by HTTP auth to build session-specific configs.
 * 
 * @param overrides - Optional overrides for config values
 * @returns Partial config with env fallbacks applied
 */
export function loadPartialConfig(overrides: {
  hostname?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  schema?: string;
}): DB2iConfig {
  const hostname = overrides.hostname ?? process.env.DB2I_HOSTNAME;
  const port = overrides.port ?? parseInt(process.env.DB2I_PORT || '446', 10);
  const username = overrides.username ?? getSecret('DB2I_USERNAME', 'DB2I_USERNAME_FILE');
  const password = overrides.password ?? getSecret('DB2I_PASSWORD', 'DB2I_PASSWORD_FILE');
  const database = overrides.database ?? process.env.DB2I_DATABASE ?? '*LOCAL';
  const schema = overrides.schema ?? process.env.DB2I_SCHEMA ?? '';

  if (!hostname) {
    throw new Error(
      'Host is required: provide in request or set DB2I_HOSTNAME environment variable'
    );
  }

  if (!validateHostname(hostname)) {
    throw new Error(
      `Invalid hostname format: "${hostname}". Must be a valid hostname or IPv4 address.`
    );
  }

  if (!username) {
    throw new Error('Username is required');
  }

  if (!password) {
    throw new Error('Password is required');
  }

  return {
    hostname,
    port,
    username,
    password,
    database,
    schema,
    jdbcOptions: parseJdbcOptions(process.env.DB2I_JDBC_OPTIONS),
  };
}

// Make parseJdbcOptions accessible internally for loadPartialConfig
// (it's already defined above, we just need to export it or use it here)
