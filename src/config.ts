/**
 * Configuration module for IBM DB2i MCP Server
 * Handles environment variables and the JDBC / ODBC connection options
 *
 * Database driver:
 * - DB2I_DRIVER: 'jt400' | 'odbc' (default: 'jt400')
 * - DB2I_JDBC_OPTIONS: extra JT400 properties, `key=value;key=value`
 * - DB2I_ODBC_OPTIONS: extra IBM i Access ODBC keywords, `KEY=value;KEY=value`
 *
 * Supports file-based secrets (e.g., Docker secrets) via *_FILE environment variables.
 * File-based secrets take priority over plain environment variables.
 * 
 * HTTP Transport Configuration:
 * - MCP_TRANSPORT: 'stdio' | 'http' | 'both' (default: 'stdio')
 * - MCP_HTTP_PORT: HTTP server port (default: 3000)
 * - MCP_HTTP_HOST: HTTP bind address (default: '127.0.0.1')
 * - MCP_SESSION_MODE: 'stateful' | 'stateless' (default: 'stateless'; stateful is deprecated)
 * - MCP_AUTH_MODE: 'required' | 'token' | 'none' (default: 'required')
 * - MCP_AUTH_TOKEN: Static token for 'token' auth mode
 * - MCP_TLS_ENABLED: Enable built-in TLS (default: false)
 * - MCP_TLS_CERT_PATH: Path to TLS certificate
 * - MCP_TLS_KEY_PATH: Path to TLS private key
 * - MCP_TOKEN_EXPIRY: Token lifetime in seconds (default: 3600)
 * - MCP_MAX_SESSIONS: Maximum concurrent sessions (default: 100)
 * - MCP_CORS_ORIGINS: CORS allowed origins (comma-separated, '*' for all)
 * - MCP_ALLOWED_HOSTS: Extra Host header names, added to loopback (comma-separated)
 * - MCP_ALLOW_UNAUTHENTICATED_HTTP: Allow MCP_AUTH_MODE=none on a non-loopback bind
 * - MCP_AUTH_ALLOWED_DB_HOSTS: Hosts /auth may open a database connection to
 */

import { readFileSync, existsSync } from 'node:fs';

/**
 * Database drivers. `jt400` is the JDBC bridge (needs a JRE). `odbc` uses the
 * npm `odbc` package with the IBM i Access ODBC driver and needs no Java.
 */
export const DB_DRIVERS = ['jt400', 'odbc'] as const;

/** Name of the one system the DB2I_* variables describe when DB2I_PROFILES is unset. */
export const DEFAULT_SYSTEM_NAME = 'default';
export type DbDriverName = (typeof DB_DRIVERS)[number];

export interface DB2iConfig {
  hostname: string;
  port: number;
  username: string;
  password: string;
  database: string;
  schema: string;
  /** Selected by DB2I_DRIVER. Defaults to jt400. */
  driver: DbDriverName;
  /** Extra JT400 properties from DB2I_JDBC_OPTIONS. Used when driver is jt400. */
  jdbcOptions: Record<string, string>;
  /** Extra ODBC connection keywords from DB2I_ODBC_OPTIONS. Used when driver is odbc. */
  odbcOptions: Record<string, string>;
}

/**
 * Get the database driver from DB2I_DRIVER.
 * Defaults to jt400 so existing installs keep working.
 */
export function getDbDriver(): DbDriverName {
  const raw = process.env.DB2I_DRIVER?.trim();
  if (!raw) {
    return 'jt400';
  }
  const value = raw.toLowerCase();
  if ((DB_DRIVERS as readonly string[]).includes(value)) {
    return value as DbDriverName;
  }
  throw new Error(
    `Invalid DB2I_DRIVER value: "${raw}". Must be one of: ${DB_DRIVERS.join(', ')}`
  );
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
 * Parse driver options from a semicolon-separated string
 * Format: "key1=value1;key2=value2". Used for both DB2I_JDBC_OPTIONS and
 * DB2I_ODBC_OPTIONS.
 */
export function parseJdbcOptions(optionsString: string | undefined): Record<string, string> {
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
 * Look up a JDBC option by name, ignoring key case.
 */
function jdbcOption(options: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(options).find((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : options[key];
}

/**
 * IBM i Access ODBC keywords have a short form and a long alias
 * (NAM / Naming, CONNTYPE / ConnectionType, ...). Both are case-insensitive.
 */
const ODBC_KEYWORD_ALIASES: Record<string, readonly string[]> = {
  driver: ['driver'],
  dsn: ['dsn'],
  nam: ['nam', 'naming'],
  dft: ['dft', 'dateformat'],
  conntype: ['conntype', 'connectiontype'],
  dbq: ['dbq', 'defaultlibraries'],
  trimchar: ['trimchar', 'trimcharfields'],
  ssl: ['ssl'],
};

/**
 * Look up an ODBC keyword by its canonical short name, accepting the long
 * alias and ignoring case.
 */
function odbcOption(options: Record<string, string>, name: string): string | undefined {
  const names = ODBC_KEYWORD_ALIASES[name] ?? [name];
  const key = Object.keys(options).find((candidate) => names.includes(candidate.toLowerCase()));
  return key === undefined ? undefined : options[key];
}

/**
 * Security-relevant JDBC settings derived from DB2I_JDBC_OPTIONS.
 * `access` is unset when the driver default of read only should apply.
 */
export function jdbcConnectionSecurity(
  options: Record<string, string> = parseJdbcOptions(process.env.DB2I_JDBC_OPTIONS)
): { accessOverride?: string; secure: boolean } {
  const accessOverride = jdbcOption(options, 'access');
  const secureValue = jdbcOption(options, 'secure');
  return {
    accessOverride,
    secure: secureValue?.toLowerCase() === 'true',
  };
}

/**
 * Security-relevant ODBC settings derived from DB2I_ODBC_OPTIONS.
 * `CONNTYPE` is unset when the default of read only (CONNTYPE=2) applies.
 * `SSL=1` encrypts the whole connection; the driver default encrypts only the password.
 */
export function odbcConnectionSecurity(
  options: Record<string, string> = parseJdbcOptions(process.env.DB2I_ODBC_OPTIONS)
): { accessOverride?: string; secure: boolean } {
  return {
    accessOverride: odbcOption(options, 'conntype'),
    secure: odbcOption(options, 'ssl')?.trim() === '1',
  };
}

export interface ConnectionSecurity {
  driver: DbDriverName;
  /** The variable that carries driver options, for log messages. */
  optionsVariable: string;
  /** The operator's explicit access setting, when it overrides the read-only default. */
  accessOverride?: string;
  /** Whether the database connection is encrypted. */
  secure: boolean;
  /** What to set to turn encryption on, for log messages. */
  secureHint: string;
}

/**
 * Security-relevant settings of the selected driver, for the startup warnings.
 */
export function connectionSecurity(
  driver: DbDriverName = getDbDriver(),
  options?: Record<string, string>
): ConnectionSecurity {
  if (driver === 'odbc') {
    return {
      driver,
      optionsVariable: 'DB2I_ODBC_OPTIONS',
      ...odbcConnectionSecurity(options),
      secureHint: 'SSL=1',
    };
  }
  return {
    driver,
    optionsVariable: 'DB2I_JDBC_OPTIONS',
    ...jdbcConnectionSecurity(options),
    secureHint: 'secure=true',
  };
}

/**
 * JT400 `extended metadata=true` replaces column names with LABEL ON text.
 * Masking matches result keys, so that option would let a value through.
 * The ODBC driver reports column names, so the check only applies to jt400.
 */
export function assertExtendedMetadataAllowsMasking(
  maskingLoaded: boolean,
  driver: DbDriverName = getDbDriver(),
  options: Record<string, string> = parseJdbcOptions(process.env.DB2I_JDBC_OPTIONS),
  optionsLabel = 'DB2I_JDBC_OPTIONS'
): void {
  if (!maskingLoaded || driver !== 'jt400') {
    return;
  }
  const value = jdbcOption(options, 'extended metadata');
  if (value?.toLowerCase() === 'true') {
    throw new Error(
      `${optionsLabel} sets extended metadata=true, which renames result columns, so masking rules cannot be applied. Remove that option or the masking rules.`
    );
  }
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
    port: readIntEnv('DB2I_PORT', 446),
    username,
    password,
    database: process.env.DB2I_DATABASE || '*LOCAL',
    schema: process.env.DB2I_SCHEMA || '',
    driver: getDbDriver(),
    jdbcOptions: parseJdbcOptions(process.env.DB2I_JDBC_OPTIONS),
    odbcOptions: parseJdbcOptions(process.env.DB2I_ODBC_OPTIONS),
  };
}

/**
 * Build JDBC connection configuration for node-jt400
 */
export interface BuildConnectionOptions {
  /**
   * When false, omit JDBC `access` so QSYS2.GENERATE_SQL can return its
   * result set. A read-only connection rejects that procedure. The default
   * connection stays read only.
   */
  readOnly?: boolean;
}

export function buildConnectionConfig(config: DB2iConfig, options?: BuildConnectionOptions): {
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

  const readOnly = options?.readOnly !== false;

  // Read-only at the driver, unless the operator set access explicitly.
  // An explicit value is merged below and overrides this default.
  // The GENERATE_SQL connection passes readOnly: false and drops `access`.
  if (readOnly && jdbcOption(config.jdbcOptions, 'access') === undefined) {
    connectionConfig['access'] = 'read only';
  }

  // Unqualified names resolve to the configured schema unless the operator
  // already set a library list. An explicit `libraries` option wins because
  // JDBC options are merged afterwards.
  const hasLibraries = Object.keys(config.jdbcOptions).some(
    (key) => key.toLowerCase() === 'libraries'
  );
  if (config.schema && !hasLibraries) {
    connectionConfig['libraries'] = config.schema;
  }

  // Merge additional JDBC options
  for (const [key, value] of Object.entries(config.jdbcOptions)) {
    if (!readOnly && key.toLowerCase() === 'access') {
      continue;
    }
    connectionConfig[key] = value;
  }

  return connectionConfig;
}

/**
 * Build the IBM i Access ODBC connection keywords for the `odbc` package.
 * Mirrors buildConnectionConfig: the same defaults, the same override rules.
 *
 * DB2I_PORT and DB2I_DATABASE are not applied, matching the JDBC builder. The
 * ODBC driver talks to the host servers, not the DRDA port.
 */
export function buildOdbcConnectionConfig(
  config: DB2iConfig,
  options?: BuildConnectionOptions
): Record<string, string> {
  const keywords: Record<string, string> = {};
  const extra = config.odbcOptions;

  // The operator may point at a DSN or another driver name instead.
  if (odbcOption(extra, 'driver') === undefined && odbcOption(extra, 'dsn') === undefined) {
    keywords['DRIVER'] = 'IBM i Access ODBC Driver';
  }
  keywords['SYSTEM'] = config.hostname;
  keywords['UID'] = config.username;
  keywords['PWD'] = config.password;

  // System naming: `/` stays the library separator, like naming=system on JDBC.
  if (odbcOption(extra, 'nam') === undefined) {
    keywords['NAM'] = '1';
  }
  // ISO dates, like `date format=iso` on JDBC.
  if (odbcOption(extra, 'dft') === undefined) {
    keywords['DFT'] = '5';
  }
  // JT400 trims CHAR padding by default; the ODBC driver does not.
  if (odbcOption(extra, 'trimchar') === undefined) {
    keywords['TRIMCHAR'] = '1';
  }

  const readOnly = options?.readOnly !== false;

  // Read-only at the driver (CONNTYPE=2, SELECT only) unless the operator set
  // CONNTYPE explicitly. The GENERATE_SQL connection passes readOnly: false
  // and drops CONNTYPE, so the driver default (read/write) applies there.
  if (readOnly && odbcOption(extra, 'conntype') === undefined) {
    keywords['CONNTYPE'] = '2';
  }

  // Unqualified names resolve to the configured schema unless the operator
  // already set a library list.
  if (config.schema && odbcOption(extra, 'dbq') === undefined) {
    keywords['DBQ'] = config.schema;
  }

  // Merge DB2I_ODBC_OPTIONS last so the operator's keywords win.
  for (const [key, value] of Object.entries(extra)) {
    if (!readOnly && ODBC_KEYWORD_ALIASES['conntype'].includes(key.toLowerCase())) {
      continue;
    }
    keywords[key] = value;
  }

  return keywords;
}

/**
 * Serialize ODBC keywords into a connection string.
 * A value containing `;`, `=`, `{` or surrounding spaces is wrapped in braces.
 * unixODBC cannot escape `}` inside a braced value, so such values are rejected.
 */
export function serializeOdbcConnectionString(keywords: Record<string, string>): string {
  return Object.entries(keywords)
    .map(([key, value]) => {
      if (value.includes('}')) {
        throw new Error(
          `ODBC connection keyword ${key} contains "}", which cannot be escaped in a connection string`
        );
      }
      const needsBraces = /[;={]/.test(value) || value !== value.trim();
      return `${key}=${needsBraces ? `{${value}}` : value}`;
    })
    .join(';');
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
 * Read an integer environment variable. Unset or blank gives the fallback;
 * anything that is not a whole number is a configuration error.
 */
export function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${name} must be a whole number, got "${raw}"`);
  }
  return Number.parseInt(raw, 10);
}

/**
 * Get query limit configuration from environment variables
 *
 * - QUERY_DEFAULT_LIMIT: Default rows to return (default: 1000)
 * - QUERY_MAX_LIMIT: Maximum rows allowed, caps user-provided limits (default: 10000)
 */
export function getQueryLimitConfig(): QueryLimitConfig {
  const defaultLimit = readIntEnv('QUERY_DEFAULT_LIMIT', 1000);
  const maxLimit = readIntEnv('QUERY_MAX_LIMIT', 10000);

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
// Tool Selection and Response Format
// ============================================================================

/**
 * Names of all tools the server can register
 */
export const TOOL_NAMES = [
  'execute_query',
  'list_schemas',
  'list_tables',
  'search_tables',
  'search_columns',
  'describe_table',
  'list_views',
  'list_indexes',
  'get_table_constraints',
  'validate_query',
  'get_object_ddl',
  'get_related_objects',
  'get_journal_info',
  'profile_table',
  'get_business_context',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * A YAML-defined tool that tool selection can name directly or by toolset.
 */
export interface CustomToolSelector {
  name: string;
  toolset?: string;
}

/**
 * Parse a comma-separated list of tool names and toolset:<name> selectors.
 * Throws if any entry is not a known tool or toolset, so typos fail loudly at startup.
 */
function parseToolList(
  value: string | undefined,
  envVar: string,
  names: ReadonlySet<string>,
  toolsets: ReadonlySet<string>,
): string[] | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  const entries = value
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);

  const unknown = entries.filter((entry) => {
    if (entry.startsWith('toolset:')) {
      return !toolsets.has(entry.slice('toolset:'.length));
    }
    return !names.has(entry);
  });
  if (unknown.length > 0) {
    const valid = [...names].join(', ');
    const toolsetHint = toolsets.size > 0
      ? `. Toolsets: ${[...toolsets].sort().map((toolset) => `toolset:${toolset}`).join(', ')}`
      : '';
    throw new Error(
      `Unknown tool name(s) in ${envVar}: ${unknown.join(', ')}. Valid tools: ${valid}${toolsetHint}`
    );
  }

  return entries;
}

function selectorMatches(selector: string, name: string, toolset: string | undefined): boolean {
  if (selector.startsWith('toolset:')) {
    return toolset?.toLowerCase() === selector.slice('toolset:'.length);
  }
  return selector === name.toLowerCase();
}

/**
 * Get the list of tools to register.
 *
 * Environment variables:
 * - MCP_TOOLS_ENABLED: Comma-separated allowlist. If set, only these tools are registered.
 * - MCP_TOOLS_DISABLED: Comma-separated denylist, applied after the allowlist.
 *
 * Entries may be a built-in name, a custom tool name, or toolset:<name>.
 * A toolset selector matches custom tools only.
 *
 * @param customTools - YAML tools loaded for this process. Omit when none are loaded.
 * @returns Enabled tool names. Built-ins stay in registration order, then custom tools in load order.
 * @throws Error if either variable contains an unknown tool name or toolset
 */
export function getEnabledTools(customTools: readonly CustomToolSelector[] = []): string[] {
  const names = new Set<string>(TOOL_NAMES);
  const toolsets = new Set<string>();
  for (const tool of customTools) {
    names.add(tool.name.toLowerCase());
    if (tool.toolset) {
      toolsets.add(tool.toolset.toLowerCase());
    }
  }

  const allowlist = parseToolList(process.env.MCP_TOOLS_ENABLED, 'MCP_TOOLS_ENABLED', names, toolsets);
  const denylist = parseToolList(process.env.MCP_TOOLS_DISABLED, 'MCP_TOOLS_DISABLED', names, toolsets) ?? [];

  const enabled = (name: string, toolset: string | undefined): boolean => {
    const allowed = !allowlist || allowlist.some((entry) => selectorMatches(entry, name, toolset));
    const denied = denylist.some((entry) => selectorMatches(entry, name, toolset));
    return allowed && !denied;
  };

  const builtins = TOOL_NAMES.filter((name) => enabled(name, undefined));
  const custom = customTools
    .filter((tool) => enabled(tool.name, tool.toolset))
    .map((tool) => tool.name);

  return [...builtins, ...custom];
}

/**
 * Text content format for tool responses
 * - 'json': Compact JSON (default)
 * - 'pretty': Indented JSON
 * - 'markdown': Row results as a markdown table, other results as compact JSON
 */
export type ResponseFormat = 'json' | 'pretty' | 'markdown';

/**
 * Get the configured response format from MCP_RESPONSE_FORMAT.
 * Defaults to 'json' if not set or invalid.
 */
export function getResponseFormat(): ResponseFormat {
  const format = process.env.MCP_RESPONSE_FORMAT?.trim().toLowerCase();
  if (format === 'pretty' || format === 'markdown') {
    return format;
  }
  return 'json';
}

/**
 * Libraries execute_query may reference.
 *
 * Environment variable:
 * - QUERY_ALLOWED_SCHEMAS: Comma-separated allowlist. Empty or unset disables the check.
 *
 * Read from the environment only, so an HTTP client cannot widen it by
 * choosing a different schema at /auth. Names are uppercased; IBM i folds
 * unquoted identifiers to uppercase.
 *
 * @returns Allowed schema names, or undefined when the check is off
 */
export function getAllowedSchemas(): string[] | undefined {
  const value = process.env.QUERY_ALLOWED_SCHEMAS;
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  return normalizeSchemaList(value.split(','));
}

/**
 * Trim, uppercase, and deduplicate library names. Undefined when none remain.
 */
export function normalizeSchemaList(values: readonly string[]): string[] | undefined {
  const names = [
    ...new Set(values.map((name) => name.trim().toUpperCase()).filter((name) => name.length > 0)),
  ];
  return names.length > 0 ? names : undefined;
}

/**
 * Whether execute_query asks IBM i to parse the statement before running it.
 *
 * Environment variable:
 * - QUERY_PARSE_CHECK: `false` or `0` turns the check off. Anything else, including unset, leaves it on.
 */
export function isQueryParseCheckEnabled(): boolean {
  const value = process.env.QUERY_PARSE_CHECK?.trim().toLowerCase();
  return value !== 'false' && value !== '0';
}

/**
 * Whether YAML tool files are re-read when they change.
 *
 * Environment variable:
 * - MCP_CUSTOM_TOOLS_WATCH: `true` or `1` turns watching on. Anything else, including unset, leaves it off.
 */
export function isCustomToolsWatchEnabled(): boolean {
  const value = process.env.MCP_CUSTOM_TOOLS_WATCH?.trim().toLowerCase();
  return value === 'true' || value === '1';
}

/**
 * Watching with no files is a startup error. A blank MCP_CUSTOM_TOOLS would
 * otherwise look like a successful watch of nothing.
 */
export function assertCustomToolsWatch(): void {
  if (!isCustomToolsWatchEnabled()) {
    return;
  }
  const raw = process.env.MCP_CUSTOM_TOOLS;
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      'MCP_CUSTOM_TOOLS_WATCH is set but MCP_CUSTOM_TOOLS is empty. There is nothing to watch.'
    );
  }
}

export type AuditSqlMode = 'hash' | 'full';

export interface AuditConfig {
  /** `stderr` writes the line directly. A path is opened for append at startup. */
  target: 'stderr' | { path: string };
  sql: AuditSqlMode;
  /** When true, bound parameter values are written. Otherwise only the count is. */
  params: boolean;
}

/**
 * Query audit log. Unset MCP_AUDIT_LOG means no audit log.
 *
 * - MCP_AUDIT_LOG: `stderr`, or a file path to append.
 * - MCP_AUDIT_SQL: `hash` (default) or `full`. Anything else stops startup.
 * - MCP_AUDIT_PARAMS: `true` includes bound values. Anything else records only the count.
 */
export function getAuditConfig(): AuditConfig | undefined {
  const sql = auditSqlMode();

  const target = process.env.MCP_AUDIT_LOG?.trim();
  if (!target) {
    return undefined;
  }

  return {
    target: target === 'stderr' ? 'stderr' : { path: target },
    sql,
    params: process.env.MCP_AUDIT_PARAMS?.trim().toLowerCase() === 'true',
  };
}

function auditSqlMode(): AuditSqlMode {
  const sqlRaw = process.env.MCP_AUDIT_SQL?.trim().toLowerCase() || 'hash';
  if (sqlRaw === 'hash' || sqlRaw === 'full') {
    return sqlRaw;
  }
  throw new Error(`MCP_AUDIT_SQL must be "hash" or "full", got "${process.env.MCP_AUDIT_SQL}".`);
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
  /** Session mode: stateful (deprecated) or stateless (default) */
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
  /** Host header names that may reach this server. Always includes loopback. */
  allowedHosts: string[];
  /** Permit MCP_AUTH_MODE=none when the bind address is not loopback. */
  allowUnauthenticatedHttp: boolean;
  /**
   * Hosts /auth may connect to. Null means neither MCP_AUTH_ALLOWED_DB_HOSTS
   * nor DB2I_HOSTNAME is set, so any host is accepted.
   */
  authAllowedDbHosts: string[] | null;
}

/**
 * Default HTTP configuration values
 */
export const DEFAULT_HTTP_CONFIG: HttpConfig = {
  transport: 'stdio',
  port: 3000,
  host: '127.0.0.1',
  sessionMode: 'stateless',
  authMode: 'required',
  tls: {
    enabled: false,
  },
  tokenExpiry: 3600,
  maxSessions: 100,
  corsOrigins: [],
  allowedHosts: ['localhost', '127.0.0.1', '::1'],
  allowUnauthenticatedHttp: false,
  authAllowedDbHosts: null,
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

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];

/**
 * Hostname from a Host header or an allowlist entry.
 * Strips a port, IPv6 brackets, and a trailing root dot, and lowercases the result.
 * Rejects userinfo, paths, and queries.
 */
export function hostnameOf(hostHeader: string): string | undefined {
  const raw = hostHeader.trim();
  if (
    !raw ||
    raw.includes('@') ||
    raw.includes('/') ||
    raw.includes('?') ||
    raw.includes('\\') ||
    raw.includes('#') ||
    /\s/.test(raw)
  ) {
    return undefined;
  }

  let host = raw;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end <= 1) return undefined;
    const rest = host.slice(end + 1);
    if (rest !== '' && !/^:\d+$/.test(rest)) return undefined;
    host = host.slice(1, end);
  } else {
    const colonCount = host.split(':').length - 1;
    if (colonCount === 1) {
      if (!/:\d+$/.test(host)) return undefined;
      host = host.replace(/:\d+$/, '');
    } else if (colonCount > 1) {
      return undefined;
    }
  }

  host = host.replace(/\.$/, '').toLowerCase();
  return host.length > 0 ? host : undefined;
}

/**
 * True for localhost, 127.0.0.1, and ::1. 0.0.0.0 is not loopback.
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = hostnameOf(host);
  return normalized !== undefined && LOOPBACK_HOSTS.includes(normalized);
}

/**
 * Host names accepted on incoming requests.
 * Loopback is always included. The bind address is included unless it is
 * 0.0.0.0 or ::. MCP_ALLOWED_HOSTS adds more names.
 */
function getAllowedHosts(bindHost: string): string[] {
  const configured = (process.env.MCP_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((entry) => hostnameOf(entry))
    .filter((entry): entry is string => Boolean(entry));

  const allowed = new Set<string>(LOOPBACK_HOSTS);
  const bind = hostnameOf(bindHost);
  if (bind && bind !== '0.0.0.0' && bind !== '::') {
    allowed.add(bind);
  }
  for (const host of configured) {
    allowed.add(host);
  }
  return [...allowed];
}

/**
 * Hosts the /auth endpoint may open a database connection to.
 * An explicit MCP_AUTH_ALLOWED_DB_HOSTS list wins. Otherwise DB2I_HOSTNAME
 * is the only allowed host. Null when neither is set.
 */
export function getAuthAllowedDbHosts(): string[] | null {
  const explicit = process.env.MCP_AUTH_ALLOWED_DB_HOSTS;
  if (explicit !== undefined && explicit.trim() !== '') {
    const hosts = [
      ...new Set(
        explicit
          .split(',')
          .map(normalizeDbHost)
          .filter((host) => host.length > 0)
      ),
    ];
    return hosts.length > 0 ? hosts : null;
  }

  const dbHost = normalizeDbHost(process.env.DB2I_HOSTNAME ?? '');
  return dbHost ? [dbHost] : null;
}

/** Lowercase a host name and drop a trailing dot, for comparing hosts. */
export function normalizeDbHost(host: string): string {
  return host.trim().replace(/\.$/, '').toLowerCase();
}

function allowUnauthenticatedHttp(): boolean {
  const value = process.env.MCP_ALLOW_UNAUTHENTICATED_HTTP?.toLowerCase();
  return value === 'true' || value === '1';
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
 * Get the configured session mode.
 * Defaults to 'stateless'. `stateful` is deprecated: protocol sessions were
 * removed in MCP 2026-07-28, and database pools are already keyed by auth token.
 */
export function getSessionMode(): SessionMode {
  const mode = process.env.MCP_SESSION_MODE?.toLowerCase();
  if (mode === 'stateful') {
    return 'stateful';
  }
  return 'stateless';
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

  const host = process.env.MCP_HTTP_HOST || '127.0.0.1';

  return {
    transport: getTransportMode(),
    port: readIntEnv('MCP_HTTP_PORT', 3000),
    host,
    sessionMode: getSessionMode(),
    authMode,
    staticToken,
    tls: getTlsConfig(),
    tokenExpiry: readIntEnv('MCP_TOKEN_EXPIRY', 3600),
    maxSessions: readIntEnv('MCP_MAX_SESSIONS', 100),
    corsOrigins: getCorsOrigins(),
    allowedHosts: getAllowedHosts(host),
    allowUnauthenticatedHttp: allowUnauthenticatedHttp(),
    authAllowedDbHosts: getAuthAllowedDbHosts(),
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
  const port = overrides.port ?? readIntEnv('DB2I_PORT', 446);
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
    driver: getDbDriver(),
    jdbcOptions: parseJdbcOptions(process.env.DB2I_JDBC_OPTIONS),
    odbcOptions: parseJdbcOptions(process.env.DB2I_ODBC_OPTIONS),
  };
}
