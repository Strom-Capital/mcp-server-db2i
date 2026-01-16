# Changelog

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
