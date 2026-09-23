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
| `DB2I_SCHEMA` | No | - | Default schema/library. Also the JDBC library list for `execute_query` when `libraries` is not set |
| `DB2I_JDBC_OPTIONS` | No | - | Additional JDBC options (semicolon-separated) |

*Either the environment variable or the corresponding `*_FILE` variable must be set. File-based secrets take priority when both are provided.

### Transport Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_TRANSPORT` | `stdio` | Transport mode: `stdio`, `http`, or `both` |
| `MCP_HTTP_PORT` | `3000` | HTTP server port |
| `MCP_HTTP_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` for a published Docker port or a reverse proxy on another container. Terminate TLS here or at that proxy |
| `MCP_ALLOWED_HOSTS` | loopback | Extra `Host` header names, comma-separated. `localhost`, `127.0.0.1`, and `::1` are always allowed. The bind address is included unless it is `0.0.0.0` |
| `MCP_SESSION_MODE` | `stateless` | `stateless` (default). `stateful` is deprecated and only keeps `Mcp-Session-Id` for 2025-era clients |
| `MCP_TOKEN_EXPIRY` | `3600` | Token lifetime in seconds (for `required` auth mode) |
| `MCP_MAX_SESSIONS` | `100` | Maximum concurrent sessions |

### HTTP Authentication Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_AUTH_MODE` | `required` | Authentication mode (see below) |
| `MCP_AUTH_TOKEN` | - | Static token for `token` auth mode |
| `MCP_ALLOW_UNAUTHENTICATED_HTTP` | `false` | Allow `MCP_AUTH_MODE=none` when `MCP_HTTP_HOST` is not a loopback address |
| `MCP_AUTH_ALLOWED_DB_HOSTS` | `DB2I_HOSTNAME` | Comma-separated hosts `POST /auth` may connect to. When unset, only `DB2I_HOSTNAME` is accepted. When both are unset, any host is accepted and a warning is logged |

**Authentication Modes:**

- **`required`** (default): Full `/auth` flow with per-user DB credentials. Most secure.
- **`token`**: Pre-shared static token. Uses environment DB credentials. Requires `MCP_AUTH_TOKEN`.
- **`none`**: No authentication. Uses environment DB credentials. Only for trusted networks. The server refuses to start if `MCP_HTTP_HOST` is not loopback, unless `MCP_ALLOW_UNAUTHENTICATED_HTTP=true`.

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
| `QUERY_PARSE_CHECK` | on | `execute_query` and business SQL tools parse the statement with `QSYS2.PARSE_STATEMENT` before running it. One extra round trip, often a few hundred milliseconds. Business tools cache that result. Set to `false` or `0` to turn the check off |

### Tool Selection

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_TOOLS_ENABLED` | - | Comma-separated allowlist. If set, only these tools are registered |
| `MCP_TOOLS_DISABLED` | - | Comma-separated denylist, applied after the allowlist |

Valid built-in names: `execute_query`, `list_schemas`, `list_tables`, `describe_table`, `list_views`, `list_indexes`, `get_table_constraints`, `validate_query`, `get_object_ddl`, `get_related_objects`, `get_business_context`. Names are case-insensitive. An unknown name stops the server at startup, so a typo can't silently leave a tool exposed.

When [business SQL tools](custom-tools.md) are loaded, the same variables also accept a custom tool name or `toolset:<name>`. A toolset selector matches only custom tools in that group. `toolset:sales` does not register `execute_query`.

```env
# Metadata browsing only, no free-form SQL
MCP_TOOLS_DISABLED=execute_query

# Only schema and table discovery
MCP_TOOLS_ENABLED=list_schemas,list_tables,describe_table

# Sales tools from MCP_CUSTOM_TOOLS, plus the annotation browser
# MCP_TOOLS_ENABLED=toolset:sales,get_business_context
```

Disabled tools are not listed by `tools/list` and cannot be called. The setting applies to both stdio and HTTP transports.

### Business SQL tools

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_CUSTOM_TOOLS` | - | Comma-separated YAML files or directories. Each file defines read-only SQL tools, table annotations, or both. |

The server reads these files before it accepts connections. A statement that is not a query, or that names a library outside `QUERY_ALLOWED_SCHEMAS`, stops startup. See [Business SQL tools](custom-tools.md) for the file format, parameter binding, and the example ERP pack.

### Response Format

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_RESPONSE_FORMAT` | `json` | Text format of tool results: `json`, `pretty`, or `markdown` |

- **`json`** (default): Compact JSON, no indentation.
- **`pretty`**: Indented JSON. Easier to read, but uses more tokens.
- **`markdown`**: Row results (`data`) become a markdown table with a summary line such as `rowCount: 2, limitApplied: 1000`. Results without rows fall back to compact JSON.

`structuredContent` always holds the raw result object, whatever this setting is. Only the text content changes.

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
| `LOG_PRETTY` | `auto` | Override log format: `true` = pretty, `false` = JSON |
| `LOG_COLORS` | `auto` | Override colors: `true`/`false` (auto-detects TTY by default) |

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
MCP_HTTP_HOST=127.0.0.1
MCP_SESSION_MODE=stateless
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

# Libraries execute_query and the SQL service tools may reference (unset = no restriction)
# QUERY_ALLOWED_SCHEMAS=MYLIB,QSYS2
# QUERY_PARSE_CHECK=true

# Tool selection and response format
# MCP_TOOLS_ENABLED=list_schemas,list_tables,describe_table
# Business tools: MCP_CUSTOM_TOOLS=./examples/erp-tools
# MCP_TOOLS_ENABLED=toolset:sales,get_business_context
MCP_TOOLS_DISABLED=execute_query
MCP_RESPONSE_FORMAT=json

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
| `secure` | `true`, `false` | Enable SSL/TLS encryption for the JDBC connection. Off unless set. Startup logs a warning when it is not `true` |
| `access` | `all`, `read only`, `read call` | Statement access mode. Defaults to `read only` when omitted. An explicit value overrides that default and is logged at startup |

The server sets `access=read only` on every connection unless `DB2I_JDBC_OPTIONS` already contains `access`. That stops a statement the SQL validator misses from running as a write. Built-in tools only issue `SELECT`, so the default does not change them.

Set `secure=true` only after the IBM i host servers are configured for SSL (Digital Certificate Manager). Until then the user, password, and results cross the network in cleartext, and the server says so at startup.

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

The `DB2I_SCHEMA` variable sets a default schema for the metadata tools and for `execute_query`. When set:

- You don't need to specify `schema` in each metadata tool call
- Tools will use this schema if no schema is provided
- You can still override it per-call by providing a `schema` parameter
- `execute_query` uses it as the JDBC `libraries` list, unless `DB2I_JDBC_OPTIONS` already sets `libraries`. With `naming=sql`, the first library is the default schema, so `FROM CUSTOMERS` resolves to `MYLIB.CUSTOMERS`. An explicit `libraries` option always wins.

In HTTP `required` mode, the schema sent to `/auth` is used for that session and falls back to `DB2I_SCHEMA` when the client omits it.

```env
# Set default schema
DB2I_SCHEMA=MYLIB
```

Without a default schema, metadata tools require a `schema` argument, and an unqualified table name in `execute_query` resolves to the schema named after the user profile.

## Schema Allowlist

`QUERY_ALLOWED_SCHEMAS` limits which libraries `execute_query`, `validate_query`, `get_object_ddl`, `get_related_objects`, and business SQL tools may reference. It is off when unset or empty. It is read from the server environment only, so a client cannot widen it by choosing a different schema at `/auth`. `get_related_objects` omits dependents whose schema is outside the list. A business SQL tool that names a library outside the list stops the server at startup.

`QUERY_PARSE_CHECK` controls the `QSYS2.PARSE_STATEMENT` check inside `execute_query` and inside business SQL tools. It is on unless set to `false` or `0`. A statement that does not parse, or that is not a query, is rejected. If the function is not installed, the query is rejected until the check is turned off. Business tools cache the parse result after the first call.

The check is one extra round trip before the query. The added time is roughly fixed, often a few hundred milliseconds, and does not grow with the query. On a short query that can be most of the wait. Turn it off when that latency matters more than the extra syntax check. `validate_query` is separate: it also looks up names in the catalog, so it is slower than this check.

| Variable | Default | Description |
|----------|---------|-------------|
| `QUERY_ALLOWED_SCHEMAS` | - | Comma-separated libraries `execute_query`, the SQL service tools, and business SQL tools may use. Case-insensitive |
| `QUERY_PARSE_CHECK` | on | `false` or `0` skips the `PARSE_STATEMENT` check in `execute_query` and business SQL tools |

```env
QUERY_ALLOWED_SCHEMAS=MYLIB,QSYS2
```

When the list is set:

- Every table reference must be in the list. An unqualified name counts as the effective default schema (the session schema, or `DB2I_SCHEMA`).
- Catalog libraries such as `QSYS2` and `SYSIBM` are not included automatically. Add them if clients should query the catalog.
- A query the server cannot parse is rejected. That includes system naming (`LIB/FILE`) and `TABLE(...)` table functions.
- Names defined in a `WITH` clause are not treated as tables.
- The schema and table browsing tools (`list_schemas`, `list_tables`, `describe_table`, `list_views`, `list_indexes`, `get_table_constraints`) are not affected. They run fixed catalog queries.

A view or alias inside an allowed library can still read other libraries. Give the IBM i user profile access only to the libraries in the list. See [Security](security.md#schema-allowlist).

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
