---
title: Query exports and staying signed in (2.12)
description: export_query writes every row of a read-only query to a CSV or XLSX file, OAuth sign-ins survive restarts, and fixes for non-ASCII text, binary columns and the schema allowlist.
date: 2026-09-26T22:30:00Z
audience: ibmi
icon: file-code
tags: [release, tools, oauth]
---

Version 2.12 has two features and a set of fixes. The first feature answers a request I kept hearing: "I don't want a summary, I want the whole list as a spreadsheet."

## export_query: the whole result as a file

`execute_query` returns rows to the model, which is right for answering a question. It is the wrong tool for "all open orders for customer 1001, as a spreadsheet". The model only sees a limited number of rows, and pasting thousands of rows into a chat helps nobody.

`export_query` runs the same kind of SELECT and writes every row to a CSV or XLSX file on the server host instead. The model gets the row count and a few sample rows, not the data.

- **Over stdio**, the result is the file path, so the user opens it from the same machine.
- **Over HTTP**, it is a download link, `<MCP_PUBLIC_URL>/exports/<id>`. The link expires after 15 minutes and allows 3 downloads by default. The server never hands out host paths.

It is off by default. Turn it on with two variables:

```bash
EXPORT_ENABLED=true
EXPORT_DIR=/var/lib/db2i-mcp/exports
```

The statement goes through the same checks as `execute_query`: the SQL validator, `QUERY_ALLOWED_SCHEMAS`, the parse check and column masking. Masked columns are masked in the file too.

Exports read many more rows than a normal query, so there are limits for the load on the IBM i:

- `EXPORT_MAX_ROWS` (100,000) and `EXPORT_MAX_BYTES` (100 MB) per file
- `EXPORT_TIMEOUT`, which cancels the statement on the IBM i like `QUERY_TIMEOUT`
- `EXPORT_MAX_CONCURRENT` (2) exports at a time

Keep them low on a production system.

A few things to know before you turn it on:

- **A download link works like a password.** Anyone who has it can download the file until it expires, because a browser following a link from a chat cannot send a bearer token. Treat a chat that holds a link as holding the data. `EXPORT_MAX_DOWNLOADS=1` makes links single use, at the cost of links that an email scanner's preview may already have spent.
- **Values, not formulas.** XLSX files hold values only. In CSV, a text value starting with `=`, `+`, `-` or `@` gets a leading `'`, so a spreadsheet does not run it.
- **Audit.** The export is logged like any tool call, with the row count and size. Each download adds an `export_download` line with the first 8 characters of the id. The full link is never logged.

The details are in [Query exports](https://docs.db2i-mcp.com/configuration#query-exports) and the security notes in [Security](https://docs.db2i-mcp.com/security#query-exports).

## Staying signed in across restarts

With the built-in OAuth server, a restart used to sign everyone out, which made every new Docker image an interruption. Set `MCP_OAUTH_STATE_FILE` and the server writes refresh grants to that file and reads them back when it starts:

```bash
MCP_OAUTH_STATE_FILE=/data/oauth/grants.json
```

- Access tokens still end with the process. Clients use their refresh token and carry on without showing the sign-in page.
- Each grant holds the user's IBM i password, because a refresh opens a new connection. Entries are encrypted with AES-256-GCM under a key derived from `MCP_OAUTH_SECRET`, and the file holds only a hash of each refresh token.
- Changing `MCP_OAUTH_SECRET` makes the file unreadable, and everyone signs in again.

In Docker, keep the file on a volume. The image creates `/data/oauth` for it. Anyone who can read both the file and the secret can read the stored passwords, so keep them apart and out of shared backups.

## Fixes

- **Non-ASCII text on ODBC.** ODBC connections now use UTF-8 (`CCSID=1208`) unless `DB2I_ODBC_OPTIONS` sets `CCSID`. Before, characters like Ä, Ö, Å and € arrived as `�`.
- **Binary columns.** `BINARY`, `VARBINARY`, `BLOB` and `FOR BIT DATA` columns now come back as upper-case hex on every driver. On ODBC they were empty objects, and on JT400 a `BLOB` was base64.
- **Rounded decimals on ODBC.** The ODBC driver reads wide `DECIMAL` and `NUMERIC` values as floating point, so they can be rounded. It now says so in the result instead of rounding silently.
- **Schema allowlist.** With `QUERY_ALLOWED_SCHEMAS` set, the check refused valid Db2 for i syntax. Casts such as `CCSID 37`, `FOR BIT DATA` and `AS NVARCHAR(50)`, special registers such as `CURRENT DATE` and `CURRENT USER AS U`, and durations such as `CURRENT DATE - 30 DAYS` now pass.

## Upgrading

```bash
npx mcp-server-db2i@latest
```

If you use ODBC and set a `CCSID` in `DB2I_ODBC_OPTIONS` on purpose, yours still wins. Otherwise text now arrives as UTF-8, which is what you want.

## What next?

Exports open the door to "every Monday, send me this list". Would scheduled exports be useful to you, or is on demand enough? Tell me in the [issues](https://github.com/Strom-Capital/mcp-server-db2i/issues).
