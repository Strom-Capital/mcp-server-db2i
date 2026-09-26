---
title: "What \"open order\" means at your company"
description: How your own business definitions, written down once, keep an AI assistant from guessing about your ERP data. Explained without the technical detail.
date: 2026-09-26T12:00:00Z
audience: business
icon: book-open-text
tags: [business, business-tools]
---

Ask ten companies what an "open order" is and you'll get ten answers. Is an order open when it's been entered, or only once it's confirmed? Does a partly delivered order count? What about one on credit hold?

Your company has an answer, and it's built into your reports. An AI assistant doesn't know it. This post explains how to tell it, in terms that don't need a developer to follow.

## Why the assistant would guess

An ERP database is organized for the ERP, not for reading. Table and column names are often short codes, such as `ORDERHDR` for the order header and `STATUS` holding a single letter. Two tables that belong together may have nothing in the database that says so.

An assistant can read the names. It can't know that `STATUS = 'R'` means "released to the warehouse" at your company, or that an order's lines live in a different table. Without that, it makes a reasonable guess. Reasonable guesses produce plausible numbers, which is the worst kind of wrong.

## Writing it down once

The project lets your IBM i team keep short notes about your tables in a plain text file. Each note says, in business words:

- **What the table is.** "Sales order header, one row per order."
- **What codes mean.** "Status: O is open, R is released, C is closed."
- **What belongs together.** "Each order has its lines in the order lines table, matched on order number."

The assistant reads these notes every time it looks at the table. When someone asks about open orders, it sees your meaning of "open" before it writes a single query.

## Your trusted queries become tools

Notes help the assistant write better queries. For the questions that matter most, you can go further and not let it write the query at all.

Your IBM i team can take a query the business already trusts, for example the one behind an Excel sheet of open orders by customer, and turn it into a named tool: "search open sales orders, by customer". The assistant then fills in the customer and runs your query, exactly as written. The answer matches the workbook, because it's the same query.

This is also the best place to start. The Excel workbooks and reports your team already relies on hold years of careful decisions about what the numbers mean. Reusing them is quicker than starting over, and it keeps everyone's numbers the same.

## What stays the same

Nothing about the safety of the setup changes. Named tools are read-only, they can only use the libraries your IBM i team has allowed, and they're checked when the server starts. A mistake in the file stops the server instead of producing a wrong answer later.

## A small start works

You don't need to describe the whole ERP. A handful of notes on the tables people ask about most, and one or two trusted queries as tools, make a noticeable difference. Add more as questions come up.

## Next step

Ask the documentation assistant on this site how business definitions work, or share this post with your IBM i team. The technical guide is in the docs, under business SQL tools.
