/**
 * Configuration module for IBM DB2i MCP Server
 * Handles environment variables and JDBC connection options
 *
 * Supports file-based secrets (e.g., Docker secrets) via *_FILE environment variables.
 * File-based secrets take priority over plain environment variables.
 * 
 * Supports multiple database drivers:
 * - jt400 (default): Uses node-jt400 JDBC driver, requires Java on client
 * - mapepire: Uses @ibm/mapepire-js, requires Mapepire server on IBM i
 */

import { readFileSync, existsSync } from 'node:fs';
import type { DriverType, DriverConfig, JT400DriverConfig, MapepireDriverConfig } from './db/drivers/interface.js';

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
 * Mapepire-specific configuration (internal)
 */
interface MapepireConfig {
  /** Mapepire server port (default: 8471) */
  port: number;
  /** Whether to ignore SSL certificate validation (default: true) */
  ignoreUnauthorized: boolean;
  /** Connection pool maximum size (default: 10) */
  poolMaxSize: number;
  /** Connection pool starting size (default: 2) */
  poolStartingSize: number;
  /** Query timeout in milliseconds (default: 30000 = 30 seconds, 0 = no timeout) */
  queryTimeout: number;
}

/**
 * Get the configured database driver type
 * Defaults to 'jt400' if not set or invalid
 */
export function getDriverType(): DriverType {
  const driver = process.env.DB2I_DRIVER?.toLowerCase();
  if (driver === 'mapepire') {
    return 'mapepire';
  }
  return 'jt400';
}

/**
 * Load Mapepire-specific configuration from environment variables
 * @internal Used by buildDriverConfig
 */
function loadMapepireConfig(): MapepireConfig {
  const ignoreUnauthorizedEnv = process.env.MAPEPIRE_IGNORE_UNAUTHORIZED?.toLowerCase();
  
  return {
    port: parseInt(process.env.MAPEPIRE_PORT || '8471', 10),
    ignoreUnauthorized: ignoreUnauthorizedEnv !== 'false' && ignoreUnauthorizedEnv !== '0',
    poolMaxSize: parseInt(process.env.MAPEPIRE_POOL_MAX_SIZE || '10', 10),
    poolStartingSize: parseInt(process.env.MAPEPIRE_POOL_STARTING_SIZE || '2', 10),
    queryTimeout: parseInt(process.env.MAPEPIRE_QUERY_TIMEOUT || '30000', 10),
  };
}

/**
 * Build driver configuration based on the selected driver type
 */
export function buildDriverConfig(config: DB2iConfig): DriverConfig {
  const driverType = getDriverType();
  
  if (driverType === 'mapepire') {
    const mapepireConfig = loadMapepireConfig();
    return {
      driver: 'mapepire',
      hostname: config.hostname,
      port: mapepireConfig.port,
      username: config.username,
      password: config.password,
      database: config.database,
      schema: config.schema,
      ignoreUnauthorized: mapepireConfig.ignoreUnauthorized,
      poolMaxSize: mapepireConfig.poolMaxSize,
      poolStartingSize: mapepireConfig.poolStartingSize,
      queryTimeout: mapepireConfig.queryTimeout,
    } satisfies MapepireDriverConfig;
  }
  
  return {
    driver: 'jt400',
    hostname: config.hostname,
    port: config.port,
    username: config.username,
    password: config.password,
    database: config.database,
    schema: config.schema,
    jdbcOptions: config.jdbcOptions,
  } satisfies JT400DriverConfig;
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
 * Get query limit configuration from environment variables
 * 
 * Environment variables:
 * - QUERY_DEFAULT_LIMIT: Default rows to return (default: 1000)
 * - QUERY_MAX_LIMIT: Maximum rows allowed, caps user-provided limits (default: 10000)
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
