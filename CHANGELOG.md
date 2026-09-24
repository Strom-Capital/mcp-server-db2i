# Changelog

## [2.8.0](https://github.com/Strom-Capital/mcp-server-db2i/compare/v2.7.0...v2.8.0) (2026-09-24)


### Features

* add a Mapepire-over-SSH driver (DB2I_DRIVER=mapepire) ([#109](https://github.com/Strom-Capital/mcp-server-db2i/issues/109)) ([808c996](https://github.com/Strom-Capital/mcp-server-db2i/commit/808c9965ccdea144b5089e27093c9e2f948b649e))


### Bug Fixes

* shorten server.json description to the registry limit ([#107](https://github.com/Strom-Capital/mcp-server-db2i/issues/107)) ([f3d8676](https://github.com/Strom-Capital/mcp-server-db2i/commit/f3d8676649d5b73f028b11f3f58e62eb8c875163))

## [2.7.0](https://github.com/Strom-Capital/mcp-server-db2i/compare/v2.6.0...v2.7.0) (2026-09-24)


### Features

* make ODBC the default driver and JT400 optional ([#102](https://github.com/Strom-Capital/mcp-server-db2i/issues/102)) ([2447c4a](https://github.com/Strom-Capital/mcp-server-db2i/commit/2447c4a90e544da964a94bdc14bc5cc800f59603))

## [2.6.0](https://github.com/Strom-Capital/mcp-server-db2i/compare/v2.5.1...v2.6.0) (2026-09-24)


### Features

* add a driver interface and an IBM i Access ODBC backend ([#96](https://github.com/Strom-Capital/mcp-server-db2i/issues/96)) ([9c3e88a](https://github.com/Strom-Capital/mcp-server-db2i/commit/9c3e88a0e2c3c14944773614b416a0b68a0b714d)), closes [#57](https://github.com/Strom-Capital/mcp-server-db2i/issues/57)
* connect to multiple IBM i systems through profiles ([#98](https://github.com/Strom-Capital/mcp-server-db2i/issues/98)) ([cd910a4](https://github.com/Strom-Capital/mcp-server-db2i/commit/cd910a4de06a7553402b3ecd1496c9af4ef7a3f0))


### Bug Fixes

* housekeeping pass after connection profiles and the ODBC driver ([#99](https://github.com/Strom-Capital/mcp-server-db2i/issues/99)) ([4182a50](https://github.com/Strom-Capital/mcp-server-db2i/commit/4182a506f3dfdd04ee5ff68315f7f7ecb1a7ea05))


### CI/CD

* run CI in the release workflow only before a publish ([#100](https://github.com/Strom-Capital/mcp-server-db2i/issues/100)) ([57850bb](https://github.com/Strom-Capital/mcp-server-db2i/commit/57850bbdfa23f21e3cde903ed416b029b2cce381))

## [2.5.1](https://github.com/Strom-Capital/mcp-server-db2i/compare/v2.5.0...v2.5.1) (2026-09-24)


### Bug Fixes

* count /auth attempts on arrival and drop CORS credentials ([#94](https://github.com/Strom-Capital/mcp-server-db2i/issues/94)) ([046f1e5](https://github.com/Strom-Capital/mcp-server-db2i/commit/046f1e512d7d8c8bd36c9fd3d27c2059f2c80467)), closes [#93](https://github.com/Strom-Capital/mcp-server-db2i/issues/93)

## [2.5.0](https://github.com/Strom-Capital/mcp-server-db2i/compare/v2.4.0...v2.5.0) (2026-09-24)


### Features

* add get_journal_info and profile_table ([#76](https://github.com/Strom-Capital/mcp-server-db2i/issues/76)) ([0a5d694](https://github.com/Strom-Capital/mcp-server-db2i/commit/0a5d6945aa321d8a16ddc06aad966c91250b22cb)), closes [#74](https://github.com/Strom-Capital/mcp-server-db2i/issues/74) [#75](https://github.com/Strom-Capital/mcp-server-db2i/issues/75)
* apply QUERY_ALLOWED_SCHEMAS to the catalog browsing tools ([98383d5](https://github.com/Strom-Capital/mcp-server-db2i/commit/98383d54f4b6a92c6e8c000e56bf0428b7cdf994))
* expose MCP resources and prompts ([#80](https://github.com/Strom-Capital/mcp-server-db2i/issues/80)) ([98383d5](https://github.com/Strom-Capital/mcp-server-db2i/commit/98383d54f4b6a92c6e8c000e56bf0428b7cdf994))


### Bug Fixes

* report a missing library from get_journal_info ([#78](https://github.com/Strom-Capital/mcp-server-db2i/issues/78)) ([27af26f](https://github.com/Strom-Capital/mcp-server-db2i/commit/27af26f4fc338eb46536f6e09dea096baf4f5c91))


### CI/CD

* wait up to 10 minutes for npm before registry publish ([#72](https://github.com/Strom-Capital/mcp-server-db2i/issues/72)) ([17164e7](https://github.com/Strom-Capital/mcp-server-db2i/commit/17164e7e395608b2ce5a7b05ca528d01e9edb369))

## [2.4.0](https://github.com/Strom-Capital/mcp-server-db2i/compare/v2.3.0...v2.4.0) (2026-09-24)


### Features

* add a validate-tools command for YAML tool files ([#67](https://github.com/Strom-Capital/mcp-server-db2i/issues/67)) ([8963230](https://github.com/Strom-Capital/mcp-server-db2i/commit/89632307e2c039fadcbcde9c1f99bf4a420e67d3))
* add search_columns and search_tables ([4a819ca](https://github.com/Strom-Capital/mcp-server-db2i/commit/4a819cab459e621cf4f5a15a0992cc71675c127b))
* mask sensitive columns in query results ([#70](https://github.com/Strom-Capital/mcp-server-db2i/issues/70)) ([db0f800](https://github.com/Strom-Capital/mcp-server-db2i/commit/db0f800a089e7c2f0ebf4036fd1e29145873ff3d))
* record each tool call in an audit log ([#69](https://github.com/Strom-Capital/mcp-server-db2i/issues/69)) ([8b18502](https://github.com/Strom-Capital/mcp-server-db2i/commit/8b1850284ceaf850587e1cfab75e1b9bf818ba68))
* reload YAML tools when their files change ([#68](https://github.com/Strom-Capital/mcp-server-db2i/issues/68)) ([affa527](https://github.com/Strom-Capital/mcp-server-db2i/commit/affa5274ba9c9029d1bfd6978b7de3a068a28031))

## [2.3.0](https://github.com/Strom-Capital/mcp-server-db2i/compare/v2.2.1...v2.3.0) (2026-09-24)


### Features

* require Node 22 and node-jt400 7 ([#53](https://github.com/Strom-Capital/mcp-server-db2i/issues/53)) ([2afc062](https://github.com/Strom-Capital/mcp-server-db2i/commit/2afc0629c3a0062c13ba257f8d377e9d39666150))


### CI/CD

* retry MCP Registry publish until npm shows the version ([#55](https://github.com/Strom-Capital/mcp-server-db2i/issues/55)) ([598b708](https://github.com/Strom-Capital/mcp-server-db2i/commit/598b7080cc1cdbd5533912c370d8f72652bb1f70))

## [2.2.1](https://github.com/Strom-Capital/mcp-server-db2i/compare/v2.2.0...v2.2.1) (2026-09-23)


### Features

* publish to the official MCP Registry ([#49](https://github.com/Strom-Capital/mcp-server-db2i/issues/49)) ([856db9d](https://github.com/Strom-Capital/mcp-server-db2i/commit/856db9ddec904fb0c89c86a7665691c928a5d316)), closes [#48](https://github.com/Strom-Capital/mcp-server-db2i/issues/48)


### Miscellaneous

* ship the registry listing as 2.2.1 ([#51](https://github.com/Strom-Capital/mcp-server-db2i/issues/51)) ([7386edb](https://github.com/Strom-Capital/mcp-server-db2i/commit/7386edbfd930afacf9488884dc73a195b0a9833a))

## [2.2.0](https://github.com/Strom-Capital/mcp-server-db2i/compare/v2.1.0...v2.2.0) (2026-09-23)


### Features

* load read-only business SQL tools from YAML ([#47](https://github.com/Strom-Capital/mcp-server-db2i/issues/47)) ([690b985](https://github.com/Strom-Capital/mcp-server-db2i/commit/690b9858ff59d26e6d7dd1af1585e9f7aa064fe8))
* validate SQL and return object DDL and dependents ([#44](https://github.com/Strom-Capital/mcp-server-db2i/issues/44)) ([932a6a8](https://github.com/Strom-Capital/mcp-server-db2i/commit/932a6a839031635068ffa57c9e3a889672e71258))

## [2.1.0](https://github.com/Strom-Capital/mcp-server-db2i/compare/v2.0.0...v2.1.0) (2026-09-23)


### Features

* configurable tool selection and compact response format ([#37](https://github.com/Strom-Capital/mcp-server-db2i/issues/37)) ([0597685](https://github.com/Strom-Capital/mcp-server-db2i/commit/05976859f731071fbb21e1c128a5272a7c062f33)), closes [#35](https://github.com/Strom-Capital/mcp-server-db2i/issues/35)
* use DB2I_SCHEMA as the default library and add a schema allowlist ([#39](https://github.com/Strom-Capital/mcp-server-db2i/issues/39)) ([c4e9787](https://github.com/Strom-Capital/mcp-server-db2i/commit/c4e9787fbcf3d40abafcc3e63cbb2329f8627b13)), closes [#36](https://github.com/Strom-Capital/mcp-server-db2i/issues/36)


### Bug Fixes

* close read-only SQL and HTTP exposure gaps ([1c75a21](https://github.com/Strom-Capital/mcp-server-db2i/commit/1c75a218fa4841ace3b5cb60596a7fe5eda3f083)), closes [#40](https://github.com/Strom-Capital/mcp-server-db2i/issues/40)

## [2.0.0](https://github.com/Strom-Capital/mcp-server-db2i/compare/v1.3.2...v2.0.0) (2026-09-23)


### ⚠ BREAKING CHANGES

* migrate to MCP SDK v2 and default HTTP sessions to stateless ([#34](https://github.com/Strom-Capital/mcp-server-db2i/issues/34))

### Features

* migrate to MCP SDK v2 and default HTTP sessions to stateless ([#34](https://github.com/Strom-Capital/mcp-server-db2i/issues/34)) ([bf37f26](https://github.com/Strom-Capital/mcp-server-db2i/commit/bf37f268b8c33c965922eefac388b62e906223af)), closes [#27](https://github.com/Strom-Capital/mcp-server-db2i/issues/27)


### CI/CD

* publish npm via OIDC and allow republishing v1.3.2 ([e706589](https://github.com/Strom-Capital/mcp-server-db2i/commit/e706589e3b7932c9367906d7a1bb1a5b601e3e2d))
* publish npm via OIDC trusted publishing and allow tag retries ([1eb2362](https://github.com/Strom-Capital/mcp-server-db2i/commit/1eb2362adddba54119f82c2c96595af969a33f1c))
* run publish tests on Node 20, publish with Node 24 ([4c34d99](https://github.com/Strom-Capital/mcp-server-db2i/commit/4c34d99583f181e7e5b72d28116af3e34fe42cfd))
* run publish-job tests on Node 20 and publish with Node 24 ([b576466](https://github.com/Strom-Capital/mcp-server-db2i/commit/b57646667f125902fe31039abc294705e1f9aaa8))
* stop duplicate changelog rows and dedupe the release pipeline ([#32](https://github.com/Strom-Capital/mcp-server-db2i/issues/32)) ([5361afa](https://github.com/Strom-Capital/mcp-server-db2i/commit/5361afab8a589dd90ff39acf7a9f8b215dfb097c))

## [1.3.2](https://github.com/Strom-Capital/mcp-server-db2i/compare/v1.3.1...v1.3.2) (2026-09-23)


### Bug Fixes

* harden HTTP transport, clamp query limits, and bump MCP SDK to 1.30 ([#28](https://github.com/Strom-Capital/mcp-server-db2i/pull/28)) ([13ca726](https://github.com/Strom-Capital/mcp-server-db2i/commit/13ca726019d66e1d5969ee61565447d3313c9abc)), closes [#26](https://github.com/Strom-Capital/mcp-server-db2i/issues/26)

## [1.3.1](https://github.com/Strom-Capital/mcp-server-db2i/compare/v1.3.0...v1.3.1) (2026-03-05)


### Bug Fixes

* add node_modules/.bin to PATH in Docker builder stage ([994eff5](https://github.com/Strom-Capital/mcp-server-db2i/commit/994eff51ba0258803b66c644357e5c032c2388d7))

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
