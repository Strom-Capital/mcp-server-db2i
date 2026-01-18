# Changelog

## [1.3.0](https://github.com/Strom-Capital/mcp-server-db2i/compare/v1.2.1...v1.3.0) (2026-01-18)


### Features

* **http:** add HTTP transport with token authentication ([#19](https://github.com/Strom-Capital/mcp-server-db2i/issues/19)) ([19fb0c8](https://github.com/Strom-Capital/mcp-server-db2i/commit/19fb0c8de7e3482fe7d5ae3b3b8f5b1be9cb55d4))
  * REST API endpoints for MCP protocol (`POST /mcp`, `GET /mcp`, `DELETE /mcp`)
  * OAuth-style token authentication via `POST /auth` endpoint
  * Three auth modes: `required` (per-user DB credentials), `token` (pre-shared), `none` (trusted networks)
  * Stateful and stateless session modes with configurable limits
  * Per-user database connection pools with automatic cleanup on token expiration
  * Built-in TLS/HTTPS support with certificate configuration
  * OpenAPI 3.1 specification at `/openapi.json`
  * CORS configuration with same-origin-only default
  * DNS rebinding protection middleware
* **config:** new environment variables for HTTP transport
  * `MCP_TRANSPORT` (stdio/http/both), `MCP_HTTP_PORT`, `MCP_HTTP_HOST`
  * `MCP_AUTH_MODE`, `MCP_AUTH_TOKEN`, `MCP_SESSION_MODE`
  * `MCP_TOKEN_EXPIRY`, `MCP_MAX_SESSIONS`, `MCP_CORS_ORIGINS`
  * `MCP_TLS_ENABLED`, `MCP_TLS_CERT_PATH`, `MCP_TLS_KEY_PATH`
* **docs:** comprehensive documentation in `/docs` folder
  * HTTP Transport guide, Configuration reference, Security guide
  * Docker deployment guide, Cursor integration examples, Development guide


### Bug Fixes

* **security:** use constant-time comparison for static token auth (timing attack prevention)
* **cors:** only enable CORS headers when `MCP_CORS_ORIGINS` is explicitly configured (default is same-origin only)
* **http:** close mcpServer when session creation fails to prevent resource leaks
* **http:** prevent closing shared 'global' pool on individual session failure in none/token auth modes
* **http:** handle race condition in `/auth` endpoint session limit with proper 503 response
* **http:** use crypto.randomBytes for unique test pool IDs to prevent collisions
* **config:** defer HTTP config validation until HTTP transport is enabled (allows stdio-only with HTTP env vars set)
* **docker:** suppress false-positive BuildKit warnings for ENV placeholders

## [1.2.1](https://github.com/Strom-Capital/mcp-server-db2i/compare/v1.2.0...v1.2.1) (2026-01-17)


### Bug Fixes

* add Docker secrets configuration to docker-compose.yml ([886d2bc](https://github.com/Strom-Capital/mcp-server-db2i/commit/886d2bcd481d58ad0e61f9809f8f102110150cca))

## [1.2.0](https://github.com/Strom-Capital/mcp-server-db2i/compare/v1.1.0...v1.2.0) (2026-01-17)


### Features

* add configurable query result size limits ([#15](https://github.com/Strom-Capital/mcp-server-db2i/issues/15)) ([0905b75](https://github.com/Strom-Capital/mcp-server-db2i/commit/0905b75afbc284fd0d0d806bb79478fccc9a16c9)), closes [#14](https://github.com/Strom-Capital/mcp-server-db2i/issues/14)
* add Docker secrets support for secure credential management ([#10](https://github.com/Strom-Capital/mcp-server-db2i/issues/10)) ([8d40b2a](https://github.com/Strom-Capital/mcp-server-db2i/commit/8d40b2ad51efe956e260033fb29690112fd5a2a1)), closes [#9](https://github.com/Strom-Capital/mcp-server-db2i/issues/9)
* add hostname format validation ([#13](https://github.com/Strom-Capital/mcp-server-db2i/issues/13)) ([f6ac711](https://github.com/Strom-Capital/mcp-server-db2i/commit/f6ac711b6e457d3a3f5230aea40231a7aa898bed)), closes [#12](https://github.com/Strom-Capital/mcp-server-db2i/issues/12)

## [1.1.0](https://github.com/Strom-Capital/mcp-server-db2i/compare/v1.0.0...v1.1.0) (2026-01-16)


### Features

* **security:** AST-based SQL security validator using node-sql-parser with regex fallback ([#2](https://github.com/Strom-Capital/mcp-server-db2i/issues/2))
* **logging:** Pino structured logging with JSON/pretty modes, TTY-aware colors, password redaction ([#3](https://github.com/Strom-Capital/mcp-server-db2i/issues/3))
* **rate-limiting:** Configurable request throttling with per-client tracking (default: 100 req/15 min) ([#5](https://github.com/Strom-Capital/mcp-server-db2i/issues/5))
* **testing:** Vitest test suite with 128 tests across 6 test files
* **linting:** ESLint configuration for code quality


### Bug Fixes

* **metadata:** Fix list_indexes query to use LISTAGG for column names (was throwing SQL0206)


### Code Refactoring

* Extract server setup into `src/server.ts`
* Create `src/utils/` modules for logger, rate limiter, and security validator
* Update CI workflows to run tests and lint checks


## 1.0.0 (2026-01-16)


### ⚠ BREAKING CHANGES

* Initial public release of MCP server for IBM DB2 for i

### Features

* initial release ([aa8ef0a](https://github.com/Strom-Capital/mcp-server-db2i/commit/aa8ef0a669343dcc92c688f29658104506b81953))
