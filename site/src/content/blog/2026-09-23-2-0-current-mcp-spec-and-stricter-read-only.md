---
title: "2.0: the current MCP spec and stricter read-only guarantees"
description: The server now speaks the 2026-07-28 MCP spec, the database connection itself is read-only, and a library allowlist limits what the model can reach.
date: 2026-09-23T09:00:00Z
audience: ibmi
icon: lock
tags: [release, security, breaking]
---

Version 2.0 is the first major release. Part of it is housekeeping: the MCP SDK moved to version 2, and the server now speaks the 2026-07-28 specification while still serving older 2025-era clients. The more important part is what 1.3.2, 2.0 and 2.1 did to the read-only guarantee.

## The connection is read-only now

Until now, the SQL validator was the only thing between the model and your data. A validator is a good first check, but it is still software reading SQL, and SQL is a large language.

The JDBC connection now opens read-only by default. Even a statement that slipped past the validator would be refused by the database. The validator stays, and gains a check for functions with side effects hidden inside a `SELECT`.

## A library allowlist

```bash
QUERY_ALLOWED_SCHEMAS=MYLIB,OTHERLIB
```

With the allowlist set, a query that touches any other library is rejected. So is SQL the parser can't read, so odd syntax can't be used to get around the check.

Unqualified table names resolve to `DB2I_SCHEMA`, so the model can write `SELECT * FROM ORDERS` without guessing which library `ORDERS` lives in.

## Tighter HTTP

If you run over HTTP:

- Sessions are bound to the caller that created them.
- Rate limits are tracked per session.
- Unknown `Origin` and `Host` headers are rejected.
- `/auth` refuses database hosts you didn't configure.
- Startup warns you if the database connection isn't using TLS.

## Choosing tools and formats

Two smaller settings in 2.1:

- `MCP_TOOLS_ENABLED` and `MCP_TOOLS_DISABLED` choose which tools are registered. A catalog-only setup without `execute_query` is one line.
- `MCP_RESPONSE_FORMAT` is `json` (compact, the default), `pretty`, or `markdown`, which renders results as tables in chat clients.

## Upgrading

```bash
npx mcp-server-db2i@latest
```

**Breaking change for HTTP users:** sessions now default to stateless. Stateful sessions still work, but they are deprecated. Read the changelog before you upgrade a shared server. Stdio setups are not affected.

## What next?

The next release is about helping the model get SQL right the first time. If you have seen it invent column names, you know why.
