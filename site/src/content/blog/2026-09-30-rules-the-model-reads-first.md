---
title: Rules the model reads before the first query
description: Version 3.2 sends your most important data rules to the model at the start of every session, next to the table notes and business tools you already write in YAML.
date: 2026-09-30T10:00:00Z
audience: ibmi
tags: [release, business-tools]
---

Table notes only help when the model reads them. In [an earlier post](/blog/teaching-the-model-your-schema-with-yaml) I showed how to describe tables and status codes in YAML. The model sees those notes when it calls `describe_table` or `get_business_context`. But a model that searches the catalog and writes SQL straight away never asks. I watched it happen on a real system: the notes said which flag marks a deleted order, the model skipped them, and the answer counted hundreds of deleted orders as still open. The note was right. Nothing told the model to read it.

Version 3.2 closes that gap. The rules no query may miss now reach the model before it writes anything.

## Three places for business knowledge

The Model Context Protocol (MCP) server reads the YAML files in `MCP_CUSTOM_TOOLS`. After 3.2 there are three kinds of entries, and each has its own job:

| Entry | When the model sees it | Use it for |
|---|---|---|
| `instructions` | At the start of every session | The few rules every query must follow |
| `annotations` | When it looks at a table | What a table holds, what each code means, how tables join |
| `tools` | In the tool list, every session | Questions people ask again and again, answered with your own SQL |

## Instructions

`instructions` is a new top-level text in a YAML file. The server sends it to the client as MCP server instructions when the session starts, so the model has it before the first question:

```yaml
# rules.yaml
version: 1
instructions: |
  MYLIB.ORDERHDR and MYLIB.ORDERS: always filter TRIM(STATFLG) <> 'D'. D rows are deleted.
  STATUS 60 is invoiced. 10, 20 and 40 are still open.
  ORDERDAT and other dates are numbers in YYYYMMDD form.
  For open orders, use list_sales_orders instead of writing the SQL.
```

Keep it short. All files together may hold 4000 characters, because the text rides along in every session. Detail about a single table belongs in its annotation.

The server also adds a short built-in part in front of your text. When annotations are loaded, it tells the model to read a table's business context before writing SQL against it. When business tools are registered, it tells the model to prefer a tool that already answers the question. A server without `MCP_CUSTOM_TOOLS` sends nothing, so nothing changes for anyone who doesn't use custom files.

## Where each rule goes

A file that also defines tools sends its instructions only to sessions that have at least one of those tools. So the split works like this:

- A rule every query must follow, such as the deleted flag, goes in a file without tools. The example pack keeps these in `rules.yaml`.
- Guidance about a group of tools ("use `search_sales_orders` for order questions") goes in the same file as those tools. If `MCP_TOOLS_ENABLED` turns the tools off, the guidance goes with them.
- What a column or code means goes in the table's annotation:

```yaml
annotations:
  MYLIB.ORDERHDR:
    entity: sales_order
    description: Sales order header. Rows with STATFLG D are deleted.
    columns:
      STATUS: "10 entered, 20 confirmed, 40 picked, 60 invoiced. 10 and 20 are still open."
      STATFLG: "Blank is normal, E is an error, D is deleted"
      ORDERDAT: Order date as a number YYYYMMDD
```

## A tool that answers the whole question

The best rule is one the model doesn't have to apply itself. When a question comes up every week, write the SQL once as a named tool, with the rules built in:

```yaml
tools:
  - name: list_picked_not_invoiced
    title: Picked orders not yet invoiced
    description: >
      Orders picked but not invoiced, ordered at least min_days ago.
      Deleted orders are left out. Oldest first.
    parameters:
      min_days: { type: integer, default: 30 }
    sql: |
      SELECT H.ORDERNO, H.CUSTNO, H.ORDERDAT
      FROM MYLIB.ORDERHDR H
      WHERE TRIM(H.STATFLG) <> 'D'
        AND H.STATUS = 40
        AND H.ORDERDAT <= INTEGER(VARCHAR_FORMAT(CURRENT DATE - CAST(:min_days AS INTEGER) DAYS, 'YYYYMMDD'))
      ORDER BY H.ORDERDAT
```

Now "which orders have been waiting for an invoice for over a month?" is one tool call. The parameter is bound, the statement goes through the read-only checks and the library (schema) allowlist when the server starts, and `mcp-server-db2i validate-tools` checks the file in CI.

## When the client ignores instructions

MCP leaves it to the client what to do with server instructions. Claude Code adds them to the model's context. Other clients may not. So 3.2 also puts one sentence at the end of the `execute_query` and `export_query` descriptions when annotations are loaded: read a table's business context before querying it. Tool descriptions reach the model in every client.

Two more limits:

- Instructions are read when a session starts. With `MCP_CUSTOM_TOOLS_WATCH=true`, a change reaches new HTTP sessions. A running session keeps the text it started with.
- This guides the model. It doesn't enforce anything. The read-only connection, the SQL validator and the library allowlist still do that.

The full reference is in [Business SQL tools](https://docs.db2i-mcp.com/custom-tools), with sections on [instructions](https://docs.db2i-mcp.com/custom-tools#instructions), [annotations](https://docs.db2i-mcp.com/custom-tools#annotations) and [tools](https://docs.db2i-mcp.com/custom-tools#tools), and [common patterns](https://docs.db2i-mcp.com/custom-tools#common-patterns) such as numeric dates and derived statuses.

## What this means for business users

Your IT team writes down once what "open", "invoiced" and "deleted" mean in your ERP. After that, the assistant follows the same definitions in every conversation, so two people asking the same question get the same answer.

## Upgrading

```bash
npx mcp-server-db2i@latest
```

Nothing breaks. Without an `instructions` text, the server sends only the built-in part, and only when you already load custom files.

## What next?

I'd like the example pack to cover more ERP rules that catch people out. If you have one you can share without internal names, open a pull request against `examples/erp-tools`.
