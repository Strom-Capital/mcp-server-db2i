# Configuration

This guide covers all configuration options for mcp-server-db2i.

## Quick Start

Create a `.env` file or set environment variables:

```env
# Required
DB2I_HOSTNAME=your-ibm-i-host.com
DB2I_USERNAME=your-username
DB2I_PASSWORD=your-password
```

## Environment Variables

### Database Connection

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DB2I_HOSTNAME` | Yes | - | IBM i hostname or IP address |
| `DB2I_USERNAME` | Yes* | - | IBM i user profile |
| `DB2I_PASSWORD` | Yes* | - | User password |
| `DB2I_USERNAME_FILE` | No | - | Path to file containing username (overrides `DB2I_USERNAME`) |
| `DB2I_PASSWORD_FILE` | No | - | Path to file containing password (overrides `DB2I_PASSWORD`) |
| `DB2I_PORT` | No | `446` | JDBC port (446 is standard for IBM i) |
| `DB2I_DATABASE` | No | `*LOCAL` | Database name |
| `DB2I_SCHEMA` | No | - | Default schema/library for tools |
| `DB2I_JDBC_OPTIONS` | No | - | Additional JDBC options (semicolon-separated) |

*Either the environment variable or the corresponding `*_FILE` variable must be set. File-based secrets take priority when both are provided.

### Transport Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_TRANSPORT` | `stdio` | Transport mode: `stdio`, `http`, or `both` |
| `MCP_HTTP_PORT` | `3000` | HTTP server port |
| `MCP_HTTP_HOST` | `0.0.0.0` | HTTP server bind address |
| `MCP_SESSION_MODE` | `stateful` | Session mode: `stateful` or `stateless` |
| `MCP_TOKEN_EXPIRY` | `3600` | Token lifetime in seconds (for `required` auth mode) |
| `MCP_MAX_SESSIONS` | `100` | Maximum concurrent sessions |

### HTTP Authentication Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_AUTH_MODE` | `required` | Authentication mode (see below) |
| `MCP_AUTH_TOKEN` | - | Static token for `token` auth mode |

**Authentication Modes:**

- **`required`** (default): Full `/auth` flow with per-user DB credentials. Most secure.
- **`token`**: Pre-shared static token. Uses environment DB credentials. Requires `MCP_AUTH_TOKEN`.
- **`none`**: No authentication. Uses environment DB credentials. Only for trusted networks.

### TLS Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_TLS_ENABLED` | `false` | Enable built-in TLS |
| `MCP_TLS_CERT_PATH` | - | Path to TLS certificate (required if TLS enabled) |
| `MCP_TLS_KEY_PATH` | - | Path to TLS private key (required if TLS enabled) |

### Query Limits

| Variable | Default | Description |
|----------|---------|-------------|
| `QUERY_DEFAULT_LIMIT` | `1000` | Default number of rows returned by queries |
| `QUERY_MAX_LIMIT` | `10000` | Maximum rows allowed (caps user-provided limits) |

### Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_WINDOW_MS` | `900000` | Rate limit time window in milliseconds (15 min) |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Maximum requests allowed per window |
| `RATE_LIMIT_ENABLED` | `true` | Set to `false` or `0` to disable rate limiting |

### Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error`, `fatal` |
| `NODE_ENV` | - | Set to `production` for JSON logs, otherwise pretty-printed |
| `LOG_PRETTY` | auto | Override log format: `true` = pretty, `false` = JSON |
| `LOG_COLORS` | auto | Override colors: `true`/`false` (auto-detects TTY by default) |

## Example Configuration

### Minimal (stdio mode)

```env
DB2I_HOSTNAME=ibmi.example.com
DB2I_USERNAME=MYUSER
DB2I_PASSWORD=mypassword
```

### Full Configuration

```env
# Database connection
DB2I_HOSTNAME=ibmi.example.com
DB2I_PORT=446
DB2I_DATABASE=*LOCAL
DB2I_USERNAME=MYUSER
DB2I_PASSWORD=mypassword
DB2I_SCHEMA=MYLIB
DB2I_JDBC_OPTIONS=naming=sql;date format=iso;errors=full

# Transport
MCP_TRANSPORT=http
MCP_HTTP_PORT=3000
MCP_HTTP_HOST=0.0.0.0
MCP_SESSION_MODE=stateful
MCP_TOKEN_EXPIRY=3600
MCP_MAX_SESSIONS=100

# HTTP Authentication (choose one mode)
MCP_AUTH_MODE=required
# MCP_AUTH_TOKEN=your-static-token  # Only for 'token' mode

# TLS
MCP_TLS_ENABLED=true
MCP_TLS_CERT_PATH=/certs/server.crt
MCP_TLS_KEY_PATH=/certs/server.key

# Query limits
QUERY_DEFAULT_LIMIT=1000
QUERY_MAX_LIMIT=10000

# Rate limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
RATE_LIMIT_ENABLED=true

# Logging
LOG_LEVEL=info
NODE_ENV=production
```

## JDBC Options

The `DB2I_JDBC_OPTIONS` variable accepts semicolon-separated JDBC options for the JT400/JTOpen driver.

### Common Options

| Option | Values | Description |
|--------|--------|-------------|
| `naming` | `system`, `sql` | `system` uses `/` for library separator, `sql` uses `.` for schema separator |
| `libraries` | `LIB1,LIB2,...` | Library list for resolving unqualified names |
| `date format` | `iso`, `usa`, `eur`, `jis`, `mdy`, `dmy`, `ymd` | Date format for date fields |
| `time format` | `iso`, `usa`, `eur`, `jis`, `hms` | Time format for time fields |
| `errors` | `full`, `basic` | Level of detail in error messages (`full` helps debugging) |
| `translate binary` | `true`, `false` | Whether to translate binary/CCSID data |
| `secure` | `true`, `false` | Enable SSL/TLS encryption for JDBC connection |

### Examples

```env
# SQL naming convention with ISO date format
DB2I_JDBC_OPTIONS=naming=sql;date format=iso

# System naming with verbose errors
DB2I_JDBC_OPTIONS=naming=system;errors=full

# Full configuration
DB2I_JDBC_OPTIONS=naming=sql;date format=iso;time format=iso;errors=full;libraries=MYLIB,QGPL
```

### Naming Conventions

The `naming` option affects how you reference tables:

- **`sql`** (recommended): Use schema.table syntax (e.g., `MYLIB.CUSTOMERS`)
- **`system`**: Use library/file syntax (e.g., `MYLIB/CUSTOMERS`)

## Default Schema

The `DB2I_SCHEMA` variable sets a default schema for all tools. When set:

- You don't need to specify `schema` in each tool call
- Tools will use this schema if no schema is provided
- You can still override it per-call by providing a `schema` parameter

```env
# Set default schema
DB2I_SCHEMA=MYLIB
```

Without a default schema, you must specify the schema in each tool call or the tool will return an error.

## File-Based Secrets

For secure credential management, use file-based secrets instead of environment variables:

| Variable | Description |
|----------|-------------|
| `DB2I_USERNAME_FILE` | Path to file containing username |
| `DB2I_PASSWORD_FILE` | Path to file containing password |

File-based secrets take priority over plain environment variables. See the [Security Guide](security.md) for more details on credential management.

## Loading Configuration

The server loads configuration from:

1. Environment variables (highest priority)
2. `.env` file in the working directory

For npm scripts, the `.env` file is automatically loaded:

```bash
npm run dev   # Loads .env automatically
npm start     # Loads .env automatically
```

For Docker, use `--env-file` or the `env_file` directive in docker-compose.yml.
