/**
 * Configuration module for IBM DB2i MCP Server
 * Handles environment variables and JDBC connection options
 */

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
 * Load configuration from environment variables
 */
export function loadConfig(): DB2iConfig {
  const hostname = process.env.DB2I_HOSTNAME;
  const username = process.env.DB2I_USERNAME;
  const password = process.env.DB2I_PASSWORD;

  if (!hostname) {
    throw new Error('DB2I_HOSTNAME environment variable is required');
  }
  if (!username) {
    throw new Error('DB2I_USERNAME environment variable is required');
  }
  if (!password) {
    throw new Error('DB2I_PASSWORD environment variable is required');
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
