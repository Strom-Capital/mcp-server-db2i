---
title: Let IBM i check the model's work
description: Three tools that push validation to the system itself, so the model finds out about a wrong column name before anything runs.
date: 2026-09-23T12:00:00Z
audience: ibmi
icon: search-check
tags: [release, tools]
---

Models invent column names. They'll write `CUSTOMER_ID` where the table has `CUSTNO`, or reach for a function that exists in another database but not in Db2 for i. A generic SQL parser can't catch this, because it doesn't know your catalog, and it doesn't know every corner of Db2 for i syntax either.

The IBM i does know both. Version 2.2 adds three tools that ask it.

## validate_query

`validate_query` sends a statement to the IBM i to be parsed, and checks every table and column name against the catalog. It doesn't run the statement.

The model can now write a query, check it, fix what's wrong and only then run it. In practice, the loop goes from "run, fail, guess, run again" to "check, fix, run once". That's fewer round trips and less load on the system.

## get_object_ddl

`get_object_ddl` returns the SQL that recreates a table, view or index. It gives the model the whole definition in one call: column types, keys, defaults and the text of a view. Before, it had to reconstruct that from several catalog queries.

It's also useful on its own. Ask for the DDL of `MYLIB.ORDERS` when you are drafting a staging table somewhere else.

## get_related_objects

`get_related_objects` lists the views, indexes and triggers that depend on a table. Before you ask the model to reason about changing a table, or which index a query might use, it can see what's built on top of it.

## All read-only

None of the three change anything. They go through the same read-only connection and the same library allowlist as `execute_query`. `get_object_ddl` only returns text; it doesn't run it.

## Upgrading

```bash
npx mcp-server-db2i@latest
```

The tools are on by default. If you run with `MCP_TOOLS_ENABLED`, add them to the list.

## What next?

Checking the SQL helps with the model's syntax. It doesn't help with meaning: which status code means "open", or which two tables belong together. The other half of 2.2 is about that.
