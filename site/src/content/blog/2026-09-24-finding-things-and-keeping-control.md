---
title: Finding things and keeping control
description: Search across libraries, profile a table, check journaling, read tables as MCP resources, and mask sensitive columns with every call written to an audit log.
date: 2026-09-24T09:00:00Z
audience: ibmi
icon: telescope
tags: [release, tools, security]
---

Versions 2.4 and 2.5 did two kinds of work. One half helps the model find its way around a system it has never seen. The other half gives your IBM i team more control over what it sees and a record of what it did.

## Finding things

- **`search_tables` and `search_columns`** search across libraries. The model doesn't have to guess that customer data lives in `MYLIB` and not `OTHERLIB`. It asks.
- **`profile_table`** returns the row count, the last change, and per-column distinct and null counts. It uses stored statistics where it can, so it's cheap. It's the fastest way for the model to learn what a status column actually contains.
- **`get_journal_info`** shows whether a table is journaled, with which images, and its primary key. That's useful before you point a replication tool at it.

## Resources and prompts

MCP has two features besides tools, and the server now uses both:

- **Resources:** clients can read a table's columns and its DDL as resources and attach them to a conversation.
- **Prompts:** built-in starting points to explore a library, explain a table, or write a query.

## Column masking

Some columns shouldn't reach a model in full. A `masking` section in your YAML files redacts a column in results, or keeps only its last four characters:

```yaml
version: 1
masking:
  MYLIB.CUSTOMERS:
    EMAIL: redact
    PHONE: last4
```

Masking applies to `execute_query`, your YAML business tools and `profile_table`. A masked column can only be selected as a plain column, so an alias or `UPPER(EMAIL)` can't carry the value out under another name.

To be precise about what this is: a mask changes what the agent receives. It doesn't change what the database user can read with another client. Db2 row and column access control (RCAC) is the control that holds at the database. Masking in the server is a backstop on top of it.

## An audit log

With `MCP_AUDIT_LOG` set, every tool call is written as one JSON line: who ran it, which tool, which system, how long it took and how many rows came back. The SQL is hashed by default, so the log shows that a statement ran without storing its text. Send it wherever your other logs go.

## The allowlist covers browsing too

`QUERY_ALLOWED_SCHEMAS` used to apply only to `execute_query`. From 2.5 it also applies to the catalog tools, so the model can't list the tables of a library it isn't allowed to query.

## Upgrading

```bash
npx mcp-server-db2i@latest
```

Version 2.3 raised the minimum to Node 22. Check your Node version before upgrading. The masking and audit log settings are documented in the security guide.

## What next?

The most common setup complaint so far is Java. The next release is about that.
