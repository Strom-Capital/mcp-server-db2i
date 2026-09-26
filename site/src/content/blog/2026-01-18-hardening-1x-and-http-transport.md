---
title: Hardening 1.x, and an HTTP transport
description: A stricter SQL validator, rate limits and result limits, Docker secrets, and a way for web apps and agents to connect over HTTP.
date: 2026-01-18T12:00:00Z
audience: ibmi
icon: shield-check
tags: [release, security, http]
---

The first release worked, but it was built for one person on one laptop. The three releases that followed in the same week were about two things: making the read-only promise harder to get around, and letting something other than a desktop app connect.

## A validator that reads the SQL

Version 1.0 checked statements with regular expressions. That catches the obvious cases and misses the creative ones. Version 1.1 parses each statement into a syntax tree and walks it, so a write hidden inside a comment, a string or odd spacing is still found. The regex check stays as a fallback when the parser can't read a statement.

The same release added:

- **Rate limiting**, per client, 100 requests per 15 minutes by default.
- **Structured logging** with Pino, with passwords redacted.
- **A test suite** of 128 tests, so later changes don't quietly break the guarantees.

## Limits and secrets

Version 1.2 added a configurable cap on how many rows a query returns, so a careless `SELECT *` on a large table doesn't flood the assistant. It also added support for Docker secrets, so the password can come from a mounted file instead of an environment variable, and it validates the host name format before connecting.

## HTTP transport

Until 1.3, the server only spoke stdio: the client starts it as a child process and talks over standard input and output. That's right for Claude Desktop or Cursor on your own machine. It doesn't work for a web app, a shared service or an agent running somewhere else.

Version 1.3 adds an HTTP transport with three authentication modes:

- **`required`**: each caller sends their own IBM i credentials to `POST /auth` and gets a token. Queries run as that user.
- **`token`**: one pre-shared token, for a trusted service.
- **`none`**: for a trusted network only.

It keeps a connection pool per user and cleans it up when the token expires. It can serve HTTPS itself, and it publishes an OpenAPI 3.1 description at `/openapi.json`. Set `MCP_TRANSPORT=http`, or `both` to keep stdio running too.

## Upgrading

```bash
npx mcp-server-db2i@latest
```

Nothing in 1.1 to 1.3 changes existing stdio setups.

## What next?

Several people asked about Mapepire as an alternative to JDBC. I'm looking into it. If there is something else you'd want first, open an issue.
