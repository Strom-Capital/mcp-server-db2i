---
title: "Security"
description: "Credentials, query validation, the schema allowlist, rate limits, column masking, and the audit log."
---

This guide covers security features and best practices for mcp-server-db2i.

## Security Features

- **Read-only access**: Only SELECT statements are permitted, and the driver connection is opened read only (JDBC `access=read only` for `jt400` and `mapepire`, ODBC `CONNTYPE=2`) unless `DB2I_JDBC_OPTIONS` sets `access` or `DB2I_ODBC_OPTIONS` sets `CONNTYPE`
- **SSH host key check**: The `mapepire` driver refuses an IBM i whose SSH host key does not match a pinned fingerprint or `known_hosts`, so a spoofed host never receives the password
- **No credentials in code**: All sensitive data via environment variables or file-based secrets
- **Query validation**: AST-based SQL parsing plus regex validation blocks dangerous operations
- **Result limiting**: Queries return 1000 rows unless the caller asks for more (`QUERY_DEFAULT_LIMIT`), and never more than 10000 (`QUERY_MAX_LIMIT`)
- **Query timeout**: A statement that runs longer than `QUERY_TIMEOUT` (default 120 seconds) is cancelled on the IBM i
- **Rate limiting**: Configurable request throttling to prevent abuse (100 req/15 min default)
- **Structured logging**: Automatic redaction of sensitive fields like passwords
- **HTTP auth**: `required` (per-user credentials via `/auth`), `token` (static bearer), or `none` (trusted networks)

## Credential Management

The server supports multiple methods for providing credentials, listed from most to least secure.

A [`DB2I_PROFILES`](configuration.md#multiple-systems) file never holds a password. Each profile's `password` must be a `"${ENV_VAR}"` reference, or `passwordFile` must point at a file such as a Docker secret. The server refuses to start if a profile has a literal password.

### Option 1: Docker Secrets (Recommended for Production)

Docker secrets provide the most secure credential management. Secrets are mounted as files and never exposed in environment variables or process listings.

1. Create secret files:

```bash
mkdir -p ./secrets
echo "your-username" > ./secrets/db2i_username.txt
echo "your-password" > ./secrets/db2i_password.txt
chmod 600 ./secrets/*.txt
```

2. Configure docker-compose.yml to use secrets:

```yaml
services:
  mcp-server-db2i:
    # ... other config ...
    environment:
      - DB2I_HOSTNAME=${DB2I_HOSTNAME}
      - DB2I_USERNAME_FILE=/run/secrets/db2i_username
      - DB2I_PASSWORD_FILE=/run/secrets/db2i_password
    secrets:
      - db2i_username
      - db2i_password

secrets:
  db2i_username:
    file: ./secrets/db2i_username.txt
  db2i_password:
    file: ./secrets/db2i_password.txt
```

For Docker Swarm or Kubernetes, use their native secret management instead of file-based secrets.

### Option 2: External Secret Management

For enterprise deployments, integrate with secret management systems:

- **HashiCorp Vault**: Inject secrets at runtime
- **AWS Secrets Manager**: Use IAM roles for access
- **Azure Key Vault**: Integrate with managed identities
- **Google Secret Manager**: Use service account authentication

These systems can populate the `*_FILE` environment variables or inject secrets directly.

### Option 3: Environment Variables (Development Only)

Plain environment variables are convenient for development but expose credentials through:
- `docker inspect` output
- Process listings (`ps aux`)
- Shell history
- Log files

```bash
# .env file (ensure it's in .gitignore)
DB2I_USERNAME=your-username
DB2I_PASSWORD=your-password
```

**Warning**: Never commit `.env` files or credentials to version control.

### File-Based Secret Variables

| Variable | Description |
|----------|-------------|
| `DB2I_USERNAME_FILE` | Path to file containing username (takes priority over `DB2I_USERNAME`) |
| `DB2I_PASSWORD_FILE` | Path to file containing password (takes priority over `DB2I_PASSWORD`) |

## Rate Limiting

The server includes built-in rate limiting to protect the IBM i database from excessive queries.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_WINDOW_MS` | `900000` | Time window in milliseconds (15 min) |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Maximum requests per window |
| `RATE_LIMIT_ENABLED` | `true` | Set to `false` to disable |

### Behavior

- **Default**: 100 requests per 15-minute window
- **Scope**: Per server instance (for stdio transport, this means per-client since each MCP client spawns its own server process)
- **HTTP transport**: Rate limiting applies per authenticated token

When the rate limit is exceeded, queries return an error with `waitTimeSeconds` indicating when to retry:

```json
{
  "success": false,
  "error": "Rate limit exceeded",
  "waitTimeSeconds": 120,
  "limit": 100,
  "windowMs": 900000
}
```

## Query Validation

The server validates all SQL queries before execution using multiple layers:

```mermaid
flowchart LR
    query["SQL Query"] --> ast["AST Parser"]
    ast -->|"SELECT only"| regex["Regex Patterns"]
    ast -->|"DDL/DML/DCL"| reject1[["REJECTED"]]
    regex -->|"Safe"| limit["Result Limiter"]
    regex -->|"Dangerous patterns"| reject2[["REJECTED"]]
    limit --> db[("Db2 for i")]
```

### AST-based Validation

Queries are parsed into an Abstract Syntax Tree (AST) to verify:
- Only SELECT statements are allowed
- No DDL (CREATE, ALTER, DROP)
- No DML (INSERT, UPDATE, DELETE)
- No DCL (GRANT, REVOKE)

### Regex Validation

Additional regex patterns block:

- Command execution attempts
- System procedure calls
- Dangerous functions, including schema-qualified calls. The check uses the unqualified name
- IBM i services that send data off the system or write outside the database: HTTP services, IFS write services, spreadsheet generation, and email

Before the keyword scan, string literals, comments, and the quotes around delimited identifiers are removed. A literal or a quoted name earlier in the statement cannot hide a later call. Words that appear only inside a literal or a comment are ignored.

The driver connection is a second layer. JT400 and the Mapepire server (which uses JT400 on the IBM i) use `access=read only` unless `DB2I_JDBC_OPTIONS` sets `access`; the ODBC driver uses `CONNTYPE=2` unless `DB2I_ODBC_OPTIONS` sets `CONNTYPE`. An explicit override is logged at startup.

### Statement parse check

`execute_query` asks IBM i to parse the statement with `QSYS2.PARSE_STATEMENT` before it runs. The query is rejected when the statement does not parse, or when it is not a query. This catches Db2 for i syntax that the local parser accepts.

The check is on unless `QUERY_PARSE_CHECK` is `false` or `0`. It adds one round trip, often a few hundred milliseconds, on every `execute_query` call. Business SQL tools run the same check the first time each tool is called, then cache the result. If `QSYS2.PARSE_STATEMENT` is not installed, the query is rejected and the error tells you to turn the check off. A missing function does not skip the check on its own.

`validate_query` runs the same parse, then checks tables, columns, and qualified routines against the catalog. It reports findings and does not execute the statement.

`get_object_ddl` calls `QSYS2.GENERATE_SQL` on a separate connection that is not marked read-only, because that procedure is rejected on a read-only connection. That connection runs only the procedure call. It does not execute the DDL it returns. The connection used by `execute_query` stays read-only.

### Result Limiting

Query results are automatically limited to prevent memory exhaustion:

| Variable | Default | Description |
|----------|---------|-------------|
| `QUERY_DEFAULT_LIMIT` | `1000` | Applied when no limit specified |
| `QUERY_MAX_LIMIT` | `10000` | Maximum allowed (caps user limits) |

### Query Timeout

The row limit caps what a query returns, not the work the IBM i does to produce it. A `SELECT` that scans a large table, or joins on columns without an index, can hold a CPU for a long time. The IBM i also keeps running a statement after its client disconnects or is killed. `QUERY_TIMEOUT` (seconds, default `120`) cancels such a statement on the IBM i, not only on the client side.

It applies to every statement a tool runs: `execute_query`, business SQL tools, the catalog tools and `get_object_ddl`. A profile can set its own `queryTimeout`, and `0` turns the limit off. The tool returns an error that says the query was cancelled after N seconds and suggests narrowing the filter. The connection goes back to the pool.

How each driver cancels:

| Driver | How | Authority it needs | Extra cost |
|--------|-----|--------------------|------------|
| `odbc` | `SQLCancel` on the statement's own connection. The IBM i Access ODBC driver ignores `SQL_ATTR_QUERY_TIMEOUT` for elapsed time, so the server does not use it | None beyond the connection's own | None measurable |
| `jt400` | Runs each statement in a transaction to learn its job (`QSYS2.JOB_NAME`), then calls `QSYS2.CANCEL_SQL` for that job | *JOBCTL special authority or the `QIBM_DB_SQLADM` function usage | About 40 ms per statement |
| `mapepire` | Calls `QSYS2.CANCEL_SQL` for the job the Mapepire server reported when it connected | *JOBCTL special authority or the `QIBM_DB_SQLADM` function usage | None measurable |

All three cancel by elapsed time, not by the optimizer's estimate. A read-only connection rejects `CALL QSYS2.CANCEL_SQL`, so jt400 and mapepire make that call on the separate connection `get_object_ddl` uses, which is not marked read-only and runs only fixed statements. Once a statement has used half its limit, that connection is opened in the background, so the cancel does not wait for a new Mapepire job to start.

If the cancel fails, for example because the user profile lacks that authority, the tool still returns after the limit, with an error saying the statement could not be cancelled and may still be running on the IBM i. The server logs a warning the first time this happens on each system. The mapepire driver then closes the job, which frees the client but does not stop the statement on the IBM i; it runs until it finishes. With a low-privilege profile, the `odbc` driver is the one that cancels on the IBM i.

### Metadata-Only Mode

If clients only need to browse schemas, tables, and columns, turn off free-form SQL entirely:

```bash
MCP_TOOLS_DISABLED=execute_query
```

The tool is then never registered, so validation bypasses cannot reach it. Business SQL tools loaded from `MCP_CUSTOM_TOOLS` stay available, and they go through the same read-only check, schema allowlist, and parse check. See [Business SQL tools](custom-tools.md). See [Tool Selection](configuration.md#tool-selection) for the full allowlist and denylist syntax.

### Schema Allowlist

`QUERY_ALLOWED_SCHEMAS` rejects an `execute_query` call whose tables are outside that list. The check runs after the read-only validation and before the parse check and the query. The same list applies to `validate_query`, `get_object_ddl`, `get_related_objects`, `get_journal_info`, `index_advice`, `profile_table`, `list_routines`, `describe_routine`, the catalog browsing tools (`list_tables`, `describe_table`, `list_views`, `list_indexes`, `get_table_constraints`), the resources and prompts, and business SQL tools. `list_schemas` returns only libraries in the list. `get_related_objects` omits dependents whose schema is outside the list. A business tool that fails the check is rejected at startup, and again when it is called. `search_ibmi_services` reads only the fixed service catalog `QSYS2.SERVICES_INFO`, which lists service names and examples and no business data, so the list does not apply to it.

- Unqualified names resolve to the session schema, or to `DB2I_SCHEMA` when the session has none. If that schema is missing or not in the list, the query is rejected.
- The list comes from the server environment. A schema chosen at `/auth` changes where unqualified names resolve. It does not add libraries to the list.
- With [`DB2I_PROFILES`](configuration.md#multiple-systems), each profile can set its own `allowedSchemas`. A profile without one uses `QUERY_ALLOWED_SCHEMAS`. Every call is checked against the list of the system it runs on.
- Queries that cannot be parsed are rejected while the list is set. System naming (`LIB/FILE`) and `TABLE(...)` table functions fall into that group.
- `QSYS2` and `SYSIBM` are allowed only when you add them.

This does not replace IBM i object authority. A view or alias in an allowed library can still point at another library. Use a user profile that has access only to the libraries in the list.

## HTTP Transport Security

When using HTTP transport, additional security measures apply:

### Authentication

- **`required`** (default): clients exchange IBM i credentials at `POST /auth`. Those credentials are not taken from the environment. Tokens expire after 1 hour by default (`MCP_TOKEN_EXPIRY`).
- **`token`** and **`none`**: the server uses `DB2I_*` environment credentials. `token` still requires `MCP_AUTH_TOKEN`. Use `none` only on a trusted network. A non-loopback bind with `MCP_AUTH_MODE=none` refuses to start unless `MCP_ALLOW_UNAUTHENTICATED_HTTP=true`.

`POST /auth` opens a database connection to test the credentials. By default that host must be `DB2I_HOSTNAME`. Set `MCP_AUTH_ALLOWED_DB_HOSTS` to a comma-separated list to allow more than one. When neither value is set, any host is accepted and a warning is logged. A rejected host returns 400 and does not open a connection. It still counts toward the `/auth` rate limit.

Every request is checked against an allowlist of `Host` values before it is routed. Loopback names are always allowed. Add public names with `MCP_ALLOWED_HOSTS` when the server is reached by a hostname other than the bind address. A rejected `Host` returns 403. The rejected value is logged and is not echoed in the response. This blocks a page that rebinds its name onto the loopback address and sends that name in both `Host` and `Origin`.

Browser requests with an `Origin` header must be same-origin or listed in `MCP_CORS_ORIGINS`. Others get 403. A listed origin is echoed in `Access-Control-Allow-Origin` with `Vary: Origin`, and `MCP_CORS_ORIGINS='*'` answers with a literal `*`. The server never sends `Access-Control-Allow-Credentials`, because tokens travel in the `Authorization` header rather than in cookies.

See [HTTP Transport](http-transport.md) for the request shapes. Protocol sessions (`Mcp-Session-Id`) are deprecated; pools stay isolated by auth token in the default stateless mode.

### OAuth Authorization Server

`MCP_OAUTH_ENABLED=true` adds a sign-in page and an OAuth 2.1 authorization server, so remote clients such as claude.ai can connect. See [Remote Clients (OAuth)](http-transport.md#remote-clients-oauth). The design choices that matter for security:

- **Users sign in as themselves.** The page asks for an IBM i user profile and password and tests them on the chosen system. The token carries those credentials, like a `/auth` token, so object authority on the IBM i still applies. There is no shared service profile.
- **The page is served by this server only.** It sends `Content-Security-Policy` with `default-src 'none'` (plus `img-src data:` for the inline favicon), `frame-ancestors 'none'` and a `form-action` limited to this origin and the client's redirect origin, plus `Cache-Control: no-store` and `Referrer-Policy: same-origin` (not `no-referrer`, which makes browsers post the form with `Origin: null`, and the Origin check refuses that). The password is never echoed back, and a failed sign-in shows a generic message, not the driver error.
- **Redirect URIs are allowlisted.** Dynamic registration accepts only URIs from `MCP_OAUTH_REDIRECT_URIS` (default: the Claude connector callbacks and Cursor's `cursor://` callback) and loopback. Like loopback, an app-scheme callback returns the code to an app on the user's own machine, and the sign-in page's `form-action` allows that scheme rather than an origin. This stops a third party from registering a client that sends codes to their own site. The page names the client and the host it returns to, and asks the user to continue only if they started the connection. Prefix entries must end in `/*`, and URIs are compared after normalization.
- **PKCE is mandatory.** Only `S256` is accepted. Codes are single use and expire after 60 seconds. A code presented a second time revokes every token it issued. The `resource` parameter, when sent, must name this server (RFC 8707).
- **Signed state instead of stored state.** Client IDs and the pending sign-in request are HMAC-SHA256 signed with `MCP_OAUTH_SECRET`, each for its own purpose, and every registration gets a random nonce. A confidential client's secret is derived from its ID with the same key. Rotating `MCP_OAUTH_SECRET` invalidates every registration and every open sign-in page.
- **Refresh tokens rotate and re-check.** Each refresh token works once. Each refresh opens a test connection with the stored credentials, so a disabled profile or a new password ends the grant and its access tokens. When the IBM i cannot be reached at all, the refresh answers 503 `temporarily_unavailable` and the grant stays, so an outage does not sign everyone out. An error the server cannot classify counts as a rejection, so a stored password the IBM i refused is never retried. One user profile holds at most 10 refresh grants per system; past that its own oldest grant ends, never another user's.
- **Revocation ends the whole sign-in.** Revoking either the access token or the refresh token ends both, and every access token refreshed from the same sign-in. `MCP_OAUTH_REFRESH_EXPIRY=0` turns refresh tokens off, and users then sign in again when the access token expires (`MCP_TOKEN_EXPIRY`).
- **Everything stays in memory.** Credentials, codes and refresh tokens are never written to disk. A restart signs everyone out.
- **TLS is required** for `MCP_PUBLIC_URL`, except on loopback. Terminate TLS at a reverse proxy or tunnel and bind the server to loopback behind it.

Before exposing the server on the internet, set `QUERY_ALLOWED_SCHEMAS` or a profile `allowedSchemas`, keep `MCP_TOOLS_ENABLED` to what users need, and limit what the IBM i user profiles can read.

### Auth Endpoint Rate Limiting

The `/auth` endpoint and the OAuth sign-in form share additional rate limiting to prevent brute-force attacks:

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_RATE_LIMIT_MAX_ATTEMPTS` | `5` | Maximum login attempts before lockout |
| `AUTH_RATE_LIMIT_WINDOW_MS` | `60000` | Time window for tracking login attempts, in milliseconds |
| `OAUTH_RATE_LIMIT_MAX_REQUESTS` | `120` | Maximum requests across all `/oauth/*` endpoints |
| `OAUTH_RATE_LIMIT_WINDOW_MS` | `60000` | Time window for the OAuth endpoint limit, in milliseconds |

**Behavior:**
- Authentication attempts are tracked per IP address and counted when they arrive, so parallel requests cannot get past the limit while earlier attempts are still testing their credentials
- After the maximum number of attempts within the window (5 in 60 seconds by default), further requests from that IP get 429 until the window ends
- A successful login does not count, but it does not clear earlier failures either, so one valid profile cannot be used to reset the count while guessing another profile's password
- Lockout automatically expires after the window period
- With OAuth on, the sign-in form uses the same budget, and all `/oauth/*` endpoints together are limited to 120 requests per minute per IP by default
- Behind a reverse proxy or tunnel, set `MCP_TRUST_PROXY` so the limits see each client's address instead of the proxy's. Without it, every client shares the proxy's budget

Both limits use [express-rate-limit](https://github.com/express-rate-limit/express-rate-limit) with an in-memory store.

> **Note:** These limits cannot be turned off, and `RATE_LIMIT_ENABLED=false` does not disable them. Each value must be a positive whole number, and a window can be at most `2147483647` ms (about 24.8 days). See [Rate Limiting](configuration.md#rate-limiting) in the configuration reference.

### TLS/HTTPS

For production HTTP deployments:

```bash
# Enable built-in TLS
MCP_TLS_ENABLED=true
MCP_TLS_CERT_PATH=/path/to/cert.pem
MCP_TLS_KEY_PATH=/path/to/key.pem
```

Or run behind a reverse proxy (nginx, Caddy, cloud load balancer) that handles TLS termination.

### Session Limits

Control concurrent sessions to prevent resource exhaustion:

```bash
MCP_MAX_SESSIONS=100  # Maximum concurrent sessions
```

## Column masking

Db2 row and column access control (RCAC) is the control that actually holds. A mask in this server only changes what an agent receives from `execute_query`, from YAML tools, and from `profile_table`. It does not change what the database user can read with another client.

Rules live in the YAML `masking` section described in [Business SQL tools](custom-tools.md#masking). `redact` replaces a value. `last4` keeps the last four characters.

The server rejects a statement that uses a masked column as anything other than a plain selected column, so an alias or `UPPER(EMAIL)` cannot carry the value out under another name. That check needs `QSYS2.PARSE_STATEMENT` for `execute_query`. When masking is loaded and `QUERY_PARSE_CHECK` is off, `execute_query` refuses to run. A mask the server cannot enforce would be worse than no mask. YAML tools are checked from the statement text at load time and do not depend on that setting.

`profile_table` writes its own statements, so the select-list check does not apply to it. It never selects `MIN` or `MAX` of a masked column when it scans, and it drops the stored low and high values of a masked column. Distinct and null counts are still returned, marked with `masked` and the rule. With `compute: true` the generated aggregate goes to the audit log like any other SQL.

`extended metadata=true` in `DB2I_JDBC_OPTIONS` makes JT400 label result keys with `LABEL ON` text instead of the column name. Masking would miss those keys, so the server refuses to start when that option is set and a masking rule is loaded. The same check applies to the `mapepire` driver, which reads the same JDBC options.

A view, an alias, or a table function that reads a masked table is not covered unless the view itself is listed in `masking`.

## Mapepire driver (SSH)

With `DB2I_DRIVER=mapepire` the server logs in to the IBM i with SSH and runs the Mapepire server inside that session. Some things to know:

- **Host key.** The host key must match `hostKey` or an entry in `known_hosts` before the password is sent. `insecureHostKey=true` skips the check and logs a warning at startup. Do not use it across a network you don't trust.
- **Files on the IBM i.** On first use, mapepire-js uploads its bundled server JAR to `$HOME/.mapepire` in the user's home directory and checks its SHA-256. Later connections reuse it, or a JAR that Code for i left in `$HOME/.vscode`. Set `serverPath` to run an installed JAR instead. Delete `$HOME/.mapepire` to remove it.
- **SSH access.** The user profile needs SSH login, which also allows a shell. Give the MCP server a dedicated, low-privilege profile, as you would for the other drivers. If sshd allows it, limit what that profile can do over SSH.
- **Encryption.** SSH encrypts the whole session, so the JDBC `secure` option is not needed.
- **Keys.** `privateKeyFile` logs in with a key instead of the password. The key file must not have a passphrase, so protect it like a password file. Over HTTP with `MCP_AUTH_MODE=required`, `/auth` sessions ignore the key and log in over SSH with the caller's password, so the key cannot stand in for a caller's credentials.

## Audit log

`MCP_AUDIT_LOG` writes one JSON line for every tool call: who ran it, which tool, a hash of the SQL (or the text when `MCP_AUDIT_SQL=full`), how many parameters were bound, the row count, how long it took, and whether it succeeded, failed, or was rate limited. HTTP calls record the IBM i username. Stdio calls record `stdio`. Each line also records the `system` the call ran on (`default` when `DB2I_PROFILES` is unset), and its `args` leave out the `system` argument.

Resource reads and the `write_query` prompt query the catalog too, so they are recorded the same way. Their `tool` is `resource:table`, `resource:table_ddl`, or `prompt:write_query`, and `args` holds the schema and table. Reading `db2i://business-context` and completing names are not recorded.

Hashing is the default because the statement often contains customer values, and an audit file should not become a second copy of the data. Set `MCP_AUDIT_PARAMS=true` only when you need the bound values and the file is protected like a credential.

The audit log also records why the server stopped, as a line such as `{"time":"...","event":"shutdown","reason":"stdin closed"}`. The reason is `SIGINT`, `SIGTERM`, `SIGHUP`, or `stdin closed` (the stdio client went away). A second line with reason `deadline` means shutdown ran past 5 seconds and the process exited while a pool was still closing. Lines with an `event` field have no `tool`.

The pino log is not this record. At `info` it does not keep the SQL, and at `debug` it is a diagnostic trace, not an answer to who ran what. A failed audit write is reported once and does not fail the tool call.

## Logging Security

The structured logger automatically redacts sensitive fields:

- Passwords are never logged
- Connection strings are sanitized
- Query parameters with sensitive names are masked

### Log Levels

| Level | When to Use |
|-------|-------------|
| `error` | Production (errors only) |
| `warn` | Production (errors + warnings) |
| `info` | Default (normal operations) |
| `debug` | Development/troubleshooting |

In production, use JSON logging for better parsing:

```bash
NODE_ENV=production
LOG_LEVEL=info
```

## Security Checklist

### Production Deployment

- [ ] Use Docker secrets or external secret management
- [ ] Enable TLS for HTTP transport
- [ ] Set `secure=true` in `DB2I_JDBC_OPTIONS` (or `SSL=1` in `DB2I_ODBC_OPTIONS`) after the IBM i host servers are configured for SSL
- [ ] With the `mapepire` driver, pin `hostKey` or keep the host in `known_hosts`, and leave `insecureHostKey` unset
- [ ] Set `MCP_ALLOWED_HOSTS` to the public hostname when the HTTP server is not loopback-only
- [ ] With `MCP_OAUTH_ENABLED`, set `MCP_OAUTH_SECRET`, serve `MCP_PUBLIC_URL` over HTTPS, and keep `MCP_OAUTH_REDIRECT_URIS` to the clients you use
- [ ] Leave `access` (JDBC) and `CONNTYPE` (ODBC) unset so the connection stays read only, or treat an explicit value as a deliberate override
- [ ] Set appropriate rate limits
- [ ] Configure query limits, and keep `QUERY_TIMEOUT` on. With `jt400` or `mapepire`, check that the user profile can run `QSYS2.CANCEL_SQL`, or use `odbc`
- [ ] Disable tools clients don't need (e.g. `MCP_TOOLS_DISABLED=execute_query`)
- [ ] Set `QUERY_ALLOWED_SCHEMAS` when `execute_query` or business SQL tools are enabled, and limit the IBM i user profile to those libraries
- [ ] Use `info` or higher log level
- [ ] Run as non-root user (Docker image does this by default)
- [ ] Restrict network access to IBM i system
- [ ] Monitor logs for suspicious activity

### Development

- [ ] Use `.env` file (add to `.gitignore`)
- [ ] Enable debug logging if needed
- [ ] Test with production-like rate limits
- [ ] Verify query validation works as expected

## Reporting Security Issues

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public GitHub issue
2. Use GitHub's [private vulnerability reporting](https://github.com/Strom-Capital/mcp-server-db2i/security/advisories/new) to submit your report
3. Include steps to reproduce the issue
4. Allow time for a fix before public disclosure
