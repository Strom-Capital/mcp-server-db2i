---
title: Teaching the model your schema with YAML
description: Table notes and named business tools, written once in YAML, so the model uses your definitions instead of guessing.
date: 2026-09-23T15:00:00Z
audience: ibmi
icon: file-code
tags: [release, business-tools]
---

When someone on r/IBMi said the schema was their biggest hurdle, it matched my experience exactly. Six-character column names and status codes that were never written down don't give a model much to work with. It can read the catalog. It can't read the knowledge in your team's heads.

Version 2.2 lets you write that knowledge down once, in YAML, and hand it to the model on every call.

## Table notes

Point `MCP_CUSTOM_TOOLS` at a YAML file or a folder. For each table, you can say what it holds, what a column's codes mean, and how it relates to other tables, even when there is no foreign key:

```yaml
version: 1
annotations:
  MYLIB.ORDERHDR:
    entity: sales_order
    description: Sales order header. One row per order.
    columns:
      STATUS: "O = open, R = released, C = closed"
    relations:
      - table: MYLIB.ORDERS
        join: { ORDERNO: ORDERNO }
        cardinality: one-to-many
        description: Order lines
```

`describe_table` includes these notes, and a new `get_business_context` tool returns them all. The model sees "`STATUS = 'O'` means open" at the moment it writes the query.

## Named business tools

You can also define tools. For example, `search_sales_orders(customer, status)` becomes a tool the model calls with parameters, instead of writing SQL from scratch:

```yaml
tools:
  - name: search_sales_orders
    description: Open sales orders for a customer, newest first.
    parameters:
      customer: { type: string, required: true, maxLength: 10 }
      status: { type: string, enum: [O, C], default: O }
    sql: |
      SELECT H.ORDERNO, H.CUSTNO, H.ORDERDATE, H.STATUS
      FROM MYLIB.ORDERHDR H
      WHERE H.CUSTNO = :customer AND H.STATUS = :status
      ORDER BY H.ORDERDATE DESC
```

- Parameters are bound, never pasted into the SQL.
- Every statement goes through the read-only checks and the library allowlist when the server starts.
- A bad file stops the server from starting, instead of failing halfway through a conversation.

The repo includes a generic ERP example pack (sales, purchasing, service, manufacturing, bill of materials and general ledger) with placeholder names. It also has notes on the patterns that catch people out: dates stored as `YYYYMMDD` numbers, optional filters that have to accept `NULL`, and statuses derived from several columns.

## Checking and reloading (2.4)

Two follow-ups shipped the next day:

- `mcp-server-db2i validate-tools` checks your YAML without starting the server. It fits nicely in CI.
- With `MCP_CUSTOM_TOOLS_WATCH=true`, the server reloads tool files when they change. No restart while you're iterating.

## Where to start

The queries your team already relies on are the best source. An Excel sheet that pulls open orders over ODBC, or the logic behind a report, already encodes what "open order" means at your company. Turn that query into a named tool and the model uses the same definition.

## Upgrading

```bash
npx mcp-server-db2i@latest
```

## What next?

If you write a tool pack for a particular ERP and can share it without internal names, I'd like to see it. Open an issue.
