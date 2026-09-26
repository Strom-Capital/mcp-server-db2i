---
title: Services, timeouts and routines (2.10 and 2.11)
description: A query timeout that cancels on the IBM i, IBM i services search, SQL errors with cause and recovery text, index advice, and procedures and functions.
date: 2026-09-25T15:00:00Z
audience: ibmi
icon: timer
tags: [release, tools, security]
---

Versions 2.10 and 2.11 fill gaps rather than add a headline feature. One of them matters more than the rest, so it goes first.

## A timeout that stops the work, not just the wait

The row limit caps what a query returns, not the work the IBM i does to produce it. A `SELECT` that scans a large table, or joins on columns without an index, can hold a CPU for a long time. The IBM i also keeps running a statement after its client disconnects. So "the client gave up" doesn't mean "the system stopped".

`QUERY_TIMEOUT` (seconds, default 120) cancels the statement **on the IBM i**. It applies to every statement a tool runs, and a profile can set its own value. How each driver cancels:

- **ODBC:** cancels the statement on its own connection. No extra authority needed.
- **JT400 and Mapepire:** call `QSYS2.CANCEL_SQL` for the statement's job. That needs `*JOBCTL` or the `QIBM_DB_SQLADM` function usage.

The tool returns an error that says the query was cancelled after N seconds and suggests narrowing the filter. The connection goes back to the pool.

## Errors the model can act on

When Db2 rejects a statement, the error now includes the SQLSTATE and SQLCODE, plus the **cause** and **recovery** text from the message's second-level help. That's the same text you'd see pressing F1 on a green screen. Models are much better at fixing a query when they're told why it failed in Db2 for i's own words, instead of reading only "SQL0204".

## index_advice

`index_advice` reads the IBM i index advisor for a library or a table. It merges the advisor's rows, sums the counts, and ranks by how often the optimizer built a temporary index instead. Those are the strongest candidates for a permanent one.

It only reads the advice. Review it before creating anything, because the advisor doesn't check whether an existing index or keyed logical file already covers the same keys.

## search_ibmi_services

IBM i services are the SQL views and functions in `QSYS2` and `SYSTOOLS` that expose system information: jobs, spool files, PTFs, system values and much more. There are hundreds, and a model doesn't know which ones your release has.

`search_ibmi_services` finds services by keyword or category, with the release that added each one and an example query. Queries on services still go through `execute_query`, with the same read-only checks and allowlist, so add `QSYS2` to the allowlist if you want them.

## Procedures and functions

- **`list_routines`** lists SQL procedures and functions in a library, with their language (SQL, RPGLE, CLLE and so on) and the program an external routine calls.
- **`describe_routine`** returns parameters, the return value or result columns, and a call template.

The server still doesn't call routines. These tools help the model understand what exists, for example when you ask it to write code around a service program.

## Smaller things

- Login and OAuth rate limits are configurable.
- Stdio servers exit when their client goes away, instead of lingering.
- The ODBC driver returns `BIGINT` values correctly.
- Schema-qualified function calls are now checked against the library allowlist too.

## Upgrading

```bash
npx mcp-server-db2i@latest
```

If you rely on JT400 or Mapepire and want timeouts to cancel on the IBM i, check the server's user profile has the authority listed above. Without it, the cancel fails and the statement keeps running.

## What next?

Job logs and spool files are the most requested next step, and IBM i services already cover a lot of that. Tell me which questions you'd want answered first.
