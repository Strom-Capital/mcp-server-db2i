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
| `DB2I_PORT` | No | `446` | JDBC port (446 is standard for IBM i). Not used by the `odbc` driver, which talks to the host servers |
| `DB2I_DATABASE` | No | `*LOCAL` | Database name |
| `DB2I_SCHEMA` | No | - | Default schema/library. Also the library list for `execute_query` (JDBC `libraries`, ODBC `DBQ`) when the option is not set |
| `DB2I_DRIVER` | No | `jt400` | Database driver: `jt400` (JDBC via node-jt400, needs a JRE) or `odbc` (IBM i Access ODBC driver, no Java). See [Database Drivers](#database-drivers) |
| `DB2I_JDBC_OPTIONS` | No | - | Additional JDBC options (semicolon-separated). `jt400` driver only |
| `DB2I_ODBC_OPTIONS` | No | - | Additional ODBC connection keywords (semicolon-separated). `odbc` driver only |
| `DB2I_PROFILES` | No | - | Path to a YAML file of IBM i systems. When set, it replaces every other variable in this table. See [Multiple Systems](#multiple-systems) |

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

Valid built-in names: `execute_query`, `list_schemas`, `list_tables`, `search_tables`, `search_columns`, `describe_table`, `list_views`, `list_indexes`, `get_table_constraints`, `validate_query`, `get_object_ddl`, `get_related_objects`, `get_journal_info`, `profile_table`, `get_business_context`. Names are case-insensitive. An unknown name stops the server at startup, so a typo can't silently leave a tool exposed.

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

Resources and prompts follow the tools they draw on. Disabling `describe_table` removes `db2i://{schema}/{table}` and all three prompts. Disabling `get_object_ddl` removes `db2i://{schema}/{table}/ddl`, and disabling `get_business_context` removes `db2i://business-context`. See [Resources and prompts](../README.md#resources-and-prompts).

### Business SQL tools

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_CUSTOM_TOOLS` | - | Comma-separated YAML files or directories. Each file defines read-only SQL tools, table annotations, or both. |
| `MCP_CUSTOM_TOOLS_WATCH` | off | `true` or `1` re-reads those files when they change. A valid set replaces the running tools and the server sends `notifications/tools/list_changed`. An invalid set is logged and the last good set keeps serving. Watching with an empty `MCP_CUSTOM_TOOLS` stops startup. |

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
| `MCP_AUDIT_LOG` | off | `stderr` writes one JSON line per tool call to standard error, separate from the pino log. Any other value is a file path to append. The server refuses to start when that path is not writable |
| `MCP_AUDIT_SQL` | `hash` | `hash` records `sha256:` of the statement. `full` records the SQL text. Anything else stops startup |
| `MCP_AUDIT_PARAMS` | off | `true` includes bound parameter values. Otherwise the line records only how many values were bound |

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

## Database Drivers

`DB2I_DRIVER` picks how the server talks to Db2 for i. Both drivers run the same tools and apply the same defaults: system naming, ISO dates, a read-only query connection, `DB2I_SCHEMA` as the library list, and a second connection without the read-only setting for `QSYS2.GENERATE_SQL` (`get_object_ddl`). Each driver is loaded on first use, so an `odbc` install never starts Java.

| Driver | Package | Needs | Options variable |
|--------|---------|-------|------------------|
| `jt400` (default) | [node-jt400](https://www.npmjs.com/package/node-jt400) | Java Runtime Environment 11 or later | `DB2I_JDBC_OPTIONS` |
| `odbc` | [odbc](https://www.npmjs.com/package/odbc) (IBM/node-odbc, optional dependency) | unixODBC and the IBM i Access ODBC Driver | `DB2I_ODBC_OPTIONS` |

The `odbc` package is an optional dependency. If its prebuilt binary is missing for your platform, `npm install` builds it from source and needs the unixODBC headers (`unixodbc-dev` on Debian and Ubuntu, `unixODBC-devel` on RHEL and SUSE).

### Installing the IBM i Access ODBC Driver

The driver is part of IBM i Access Client Solutions (ACS), but not of the ACS base download (the Java package with the 5250 emulator and Run SQL Scripts). It ships in the optional *Linux, Mac, and PASE Application Package* and *Windows Application Package*, and IBM also publishes the Linux and macOS packages from its own repositories ([instructions](https://ibmi-oss-docs.readthedocs.io/en/latest/odbc/installation.html)). On every platform the driver registers as `IBM i Access ODBC Driver`, which is the name the server uses unless `DB2I_ODBC_OPTIONS` sets `DRIVER` or `DSN`.

| Platform | Architectures | Driver manager | Install |
|----------|---------------|----------------|---------|
| Debian, Ubuntu | amd64, ppc64el (the apt repository also carries older i386 builds) | unixODBC (installed as a dependency) | IBM apt repository, or the `.deb` in the Linux Application Package |
| RHEL, Fedora, CentOS Stream | x86_64, ppc64le | unixODBC | IBM rpm repository (`dnf install --refresh ibm-iaccess`), or the `.rpm` in the Linux Application Package |
| SUSE, openSUSE | x86_64, ppc64le | unixODBC | Same rpm repository under `/etc/zypp/repos.d`, `zypper install ibm-iaccess` |
| macOS 14 and later | Universal (Intel and Apple Silicon) | unixODBC from Homebrew, installed first. The driver does not work with iODBC | Homebrew tap `ibm/iaccess`, or `ibm-iaccess-<version>.pkg` in the macOS Application Package |
| Windows 10 and later | x64 driver plus a 32-bit driver for 32-bit processes | Windows ODBC Data Source Administrator | `setup.exe` in the Windows Application Package. Use the 64-bit driver with 64-bit Node.js |
| IBM i PASE | ppc64 | unixODBC (installed as a dependency) | `yum install ibm-iaccess`, or the `.rpm` in the PASE Application Package |

Linux on arm64 (for example Raspberry Pi or Graviton) is not covered: IBM publishes no arm64 Linux build. Run the `jt400` driver there, or run the `odbc` image under amd64 emulation (see [docker.md](docker.md#multi-stage-build)).

```bash
# Debian / Ubuntu
curl https://public.dhe.ibm.com/software/ibmi/products/odbc/debs/dists/1.1.0/ibmi-acs-1.1.0.list | sudo tee /etc/apt/sources.list.d/ibmi-acs-1.1.0.list
sudo apt update && sudo apt install ibm-iaccess

# RHEL / Fedora
curl https://public.dhe.ibm.com/software/ibmi/products/odbc/rpms/ibmi-acs.repo | sudo tee /etc/yum.repos.d/ibmi-acs.repo
sudo dnf install --refresh ibm-iaccess

# SUSE
curl https://public.dhe.ibm.com/software/ibmi/products/odbc/rpms/ibmi-acs.repo | sudo tee /etc/zypp/repos.d/ibmi-acs.repo
sudo zypper refresh && sudo zypper install ibm-iaccess

# macOS (unixODBC, not iODBC)
brew install unixodbc
brew tap ibm/iaccess https://public.dhe.ibm.com/software/ibmi/products/odbc/macos/tap/
brew install ibm-iaccess

# IBM i PASE
yum install ibm-iaccess
```

Check the registration with `odbcinst -q -d` on Linux, macOS and PASE, or in the ODBC Data Source Administrator on Windows. The `odbc` npm package ships prebuilt binaries for Linux x64, macOS and Windows x64; on other targets `npm install` builds it and needs the unixODBC headers.

Windows notes:

- IBM ships the Windows driver for x64 and x86 only. On Windows on ARM install the **x64** build of Node.js; it runs under emulation and can load the x64 driver. A native ARM64 Node.js cannot load it.
- `npm install` builds the JT400 bridge and needs a JDK. For an ODBC-only install without Java, run `npm ci --ignore-scripts` and then `npm rebuild odbc`, which only fetches the prebuilt ODBC binary.

```env
DB2I_DRIVER=odbc
DB2I_ODBC_OPTIONS=SSL=1
```

## Multiple Systems

One server can reach several IBM i systems, for example production and test, or two partitions. Set `DB2I_PROFILES` to a YAML file with one profile per system ([example](../examples/profiles.yaml)):

```yaml
profiles:
  - name: prod
    host: ibmi.example.com
    driver: jt400
    username: "${DB2I_PROD_USERNAME}"
    password: "${DB2I_PROD_PASSWORD}"
    schema: SALES
    allowedSchemas: [SALES, QSYS2]
    jdbcOptions: "secure=true"
  - name: test
    host: ibmi-test.example.com
    driver: odbc
    username: MCPREAD
    passwordFile: /run/secrets/db2i_test_password
    odbcOptions: "SSL=1"
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | - | Name tools use in their `system` argument. Letters, digits, `_` and `-` |
| `host` | Yes | - | IBM i hostname or IPv4 address |
| `driver` | No | `jt400` | `jt400` or `odbc`. Each profile can use a different driver |
| `port` | No | `446` | JDBC port. Not used by `odbc` |
| `database` | No | `*LOCAL` | Database name |
| `schema` | No | - | Default library, like `DB2I_SCHEMA` |
| `allowedSchemas` | No | `QUERY_ALLOWED_SCHEMAS` | Libraries queries on this system may use |
| `username` | Yes* | - | User profile, as text or a `"${ENV_VAR}"` reference |
| `usernameFile` | Yes* | - | Path to a file holding the user profile |
| `password` | Yes* | - | Must be a `"${ENV_VAR}"` reference. A literal password is refused |
| `passwordFile` | Yes* | - | Path to a file holding the password, for example a Docker secret |
| `jdbcOptions` | No | - | Like `DB2I_JDBC_OPTIONS`, for this system |
| `odbcOptions` | No | - | Like `DB2I_ODBC_OPTIONS`, for this system |

*Set `username` or `usernameFile`, and `password` or `passwordFile`. A path may itself be a `"${ENV_VAR}"` reference. Quote every reference: inside a `{ }` map YAML reads a bare `${...}` as another map.

How calls pick a system:

- **The first profile is the default.** A tool call that names no system runs there, and so do resources and prompts.
- **Built-in tools take an optional `system` argument** when more than one system is configured. Its values are the profile names. With one system the argument is not offered, so tool schemas are unchanged.
- **YAML tools can set `system:`** to always run on one system. See [Business SQL tools](custom-tools.md#running-on-one-system).
- **Each system has its own allowlist and default library.** A query on `test` is checked against the `test` profile's `allowedSchemas`, or `QUERY_ALLOWED_SCHEMAS` when the profile sets none.
- **Pools are per system.** A system's pool opens on its first query and closes at shutdown. Startup checks only the default system's connection.
- **HTTP `/auth` logs in to one system.** Pass `system` in the request. The token is bound to that system, and its calls cannot switch to another. See [HTTP transport](http-transport.md#multiple-systems).

The file is read once at startup and a mistake stops the server. Restart it after editing the file. When `DB2I_PROFILES` is set, `DB2I_HOSTNAME` and the other connection variables are ignored, and startup logs a warning if they are also set.

## JDBC Options

The `DB2I_JDBC_OPTIONS` variable accepts semicolon-separated JDBC options for the JT400/JTOpen driver. It applies when `DB2I_DRIVER` is `jt400`.

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

## ODBC Options

The `DB2I_ODBC_OPTIONS` variable accepts semicolon-separated connection keywords for the IBM i Access ODBC Driver. It applies when `DB2I_DRIVER` is `odbc`. Keywords are case-insensitive and most have a long alias (`NAM` or `Naming`). IBM documents the full list under [Connection string keywords](https://www.ibm.com/docs/en/i/7.5?topic=details-connection-string-keywords).

### Common Keywords

| Keyword | Values | Description |
|---------|--------|-------------|
| `NAM` (`Naming`) | `1`, `0` | `1` is system naming (`/` library separator), `0` is SQL naming (`.`). The server sets `1` unless you set it |
| `DBQ` (`DefaultLibraries`) | `LIB1,LIB2,...` | Default library and library list. Start with a comma (`,LIB1,LIB2`) to set a list without a default library. Defaults to `DB2I_SCHEMA` |
| `DFT` (`DateFormat`) | `5` ISO, `4` USA, `6` EUR, `7` JIS, `1` MDY, `2` DMY, `3` YMD | Date format. The server sets `5` unless you set it |
| `TRIMCHAR` (`TrimCharFields`) | `1`, `0` | Trim trailing blanks from CHAR columns. The server sets `1` to match JT400 |
| `SSL` | `1`, `0` | `1` encrypts the whole connection. The driver default only encrypts the password. Startup logs a warning when it is not `1` |
| `CONNTYPE` (`ConnectionType`) | `2` read only, `1` read/call, `0` read/write | Statement access. Defaults to `2` when omitted. An explicit value overrides that default and is logged at startup |
| `DRIVER` / `DSN` | driver name or DSN | Defaults to `DRIVER=IBM i Access ODBC Driver`. Set `DSN=...` to use a data source from `odbc.ini` instead |
| `DATABASE` | RDB name | Independent auxiliary storage pool to connect to. Not set by default; `DB2I_DATABASE` is not passed to the driver |

The server sets `CONNTYPE=2` on every query connection unless `DB2I_ODBC_OPTIONS` already contains `CONNTYPE`. The `get_object_ddl` connection omits `CONNTYPE`, so `QSYS2.GENERATE_SQL` can return its result set; that connection runs only the CALL.

Set `SSL=1` only after the IBM i host servers are configured for TLS (Digital Certificate Manager). `DB2I_PORT` is not used: the ODBC driver connects to the host servers (8471, or 9471 with TLS), not the DRDA port.

A `SYSTEM`, `UID` or `PWD` value containing `;`, `=` or `{` is wrapped in braces automatically. A value containing `}` cannot be expressed in an ODBC connection string and is rejected at startup.

### Examples

```env
# TLS, SQL naming, and a library list with no default library
DB2I_ODBC_OPTIONS=SSL=1;NAM=0;DBQ=,MYLIB,QGPL

# Use a DSN from ~/.odbc.ini
DB2I_ODBC_OPTIONS=DSN=PRODIBMI
```

## Default Schema

The `DB2I_SCHEMA` variable sets a default schema for the metadata tools and for `execute_query`. When set:

- You don't need to specify `schema` in each metadata tool call
- Tools will use this schema if no schema is provided
- You can still override it per-call by providing a `schema` parameter
- `execute_query` uses it as the library list: JDBC `libraries` unless `DB2I_JDBC_OPTIONS` already sets `libraries`, or ODBC `DBQ` unless `DB2I_ODBC_OPTIONS` already sets `DBQ`. With SQL naming, the first library is the default schema, so `FROM CUSTOMERS` resolves to `MYLIB.CUSTOMERS`. An explicit option always wins.

In HTTP `required` mode, the schema sent to `/auth` is used for that session and falls back to `DB2I_SCHEMA` when the client omits it.

```env
# Set default schema
DB2I_SCHEMA=MYLIB
```

Without a default schema, metadata tools require a `schema` argument, and an unqualified table name in `execute_query` resolves to the schema named after the user profile.

## Schema Allowlist

`QUERY_ALLOWED_SCHEMAS` limits which libraries the built-in tools, business SQL tools, resources, and prompts may query or describe on IBM i. `get_business_context` and `db2i://business-context` only return YAML annotations, which the list does not filter. It is off when unset or empty. It is read from the server environment only, so a client cannot widen it by choosing a different schema at `/auth`. `get_related_objects` omits dependents whose schema is outside the list. A business SQL tool that names a library outside the list stops the server at startup. `search_tables` and `search_columns` only read libraries in the list, and reject a `schema` argument outside it.

`QUERY_PARSE_CHECK` controls the `QSYS2.PARSE_STATEMENT` check inside `execute_query` and inside business SQL tools. It is on unless set to `false` or `0`. A statement that does not parse, or that is not a query, is rejected. If the function is not installed, the query is rejected until the check is turned off. Business tools cache the parse result after the first call.

The check is one extra round trip before the query. The added time is roughly fixed, often a few hundred milliseconds, and does not grow with the query. On a short query that can be most of the wait. Turn it off when that latency matters more than the extra syntax check. `validate_query` is separate: it also looks up names in the catalog, so it is slower than this check.

| Variable | Default | Description |
|----------|---------|-------------|
| `QUERY_ALLOWED_SCHEMAS` | - | Comma-separated libraries that the tools, business SQL tools, resources, and prompts may use. Case-insensitive |
| `QUERY_PARSE_CHECK` | on | `false` or `0` skips the `PARSE_STATEMENT` check in `execute_query` and business SQL tools |

```env
QUERY_ALLOWED_SCHEMAS=MYLIB,QSYS2
```

When the list is set:

- Every table reference must be in the list. An unqualified name counts as the effective default schema (the session schema, or `DB2I_SCHEMA`).
- Catalog libraries such as `QSYS2` and `SYSIBM` are not included automatically. Add them if clients should query the catalog.
- A query the server cannot parse is rejected. That includes system naming (`LIB/FILE`) and `TABLE(...)` table functions.
- Names defined in a `WITH` clause are not treated as tables.
- `search_tables` and `search_columns` search only the libraries in the list. Without a list, they skip system libraries (`Q*` and `SYS*`) unless `include_system` is true.
- `get_journal_info` and `profile_table` reject a library outside the list. They read `QSYS2` catalog views themselves, so `QSYS2` does not have to be in the list for them.
- `list_tables`, `describe_table`, `list_views`, `list_indexes`, and `get_table_constraints` reject a library outside the list before querying. `list_schemas` returns only the libraries in the list. Keys and indexes of an allowed table are still reported when they reference another library.

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
