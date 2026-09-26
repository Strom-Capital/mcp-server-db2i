---
title: New questions for the ERP data you already have
description: How an AI assistant can answer the one-off questions between reports, against live ERP data on IBM i, alongside the screens, Excel workbooks and BI tools you already use.
date: 2026-09-26T09:00:00Z
audience: business
tags: [business, erp]
---

If your company's ERP runs on IBM i, it holds years of orders, customers, items, invoices and work orders. People get answers from that data every day. This post is about a different kind of question, and a way to answer it that works alongside what you have.

## How answers arrive today

Most companies I work with get their numbers in one of three ways, often all three:

- **The ERP's own screens and reports.** The system people work in every day, with reports built for the jobs it does.
- **Excel workbooks that query the ERP over ODBC.** Usually built by someone who knows exactly which fields matter, and trusted for good reason.
- **A data warehouse or BI tool.** Dashboards on data that has been modeled for the questions the business asks most often.

Each of these does its job well. They answer the questions they were designed for, reliably, month after month.

## The question between reports

Then there is the question that comes up on a Tuesday afternoon:

- "Which customers ordered less this quarter than the same quarter last year?"
- "Which purchase orders from this supplier are late, and what's waiting on them?"
- "How many service orders for this item came back within 30 days?"

Nobody built a report for it, because nobody knew it would be asked. It might be asked once. Answering it usually means asking someone on the IBM i or BI team to write a query, and that person already has a queue.

## Asking in plain language

The open-source project I maintain lets an AI assistant, such as Claude or Cursor, read the data on your IBM i directly. You type the question as you would ask a colleague. The assistant looks up which tables hold the answer, writes a query, checks it with the IBM i, runs it and answers with the numbers.

It works against live data, so there's no copy to wait for. And nothing needs to be built first: no new database, no new data model.

## It builds on what you already have

The assistant is only as good as what it knows about your tables. The good news is that your company has already written most of it down, in the existing reports and queries.

Your IBM i team can take the logic of a trusted Excel query, or the definition behind a report, and give it to the assistant as a named definition: this is an "open order", this is how an order header joins its lines, this status code means "released". The assistant then uses your definitions instead of guessing. The next post goes into how that works.

## What your IBM i team needs to agree to

They'll have good questions, and they should. The short version:

- **It only reads.** A read-only database connection and a check that only allows queries. A time limit also stops long queries on the IBM i itself.
- **People sign in as themselves.** Each person uses their own IBM i user, often the same as for the ERP, and the IBM i decides what they can read.
- **You choose what's visible.** Only the libraries you allow, with sensitive columns hidden or masked.
- **Everything is logged.** Every request is written to an audit log.
- **The data stays on the IBM i.** Nothing is copied into a new database.

## What it isn't

It doesn't replace your financial reporting. Official figures still come from the reports your finance team relies on. It doesn't replace the BI team either. If a question turns out to be asked every week, it deserves a proper report, and now you know which one to build.

Your IT team sets it up once. After that, people add a link in their assistant and sign in.

## Next step

It is free and open source, with nothing to buy. The [page for business teams](/business#send-to-it) has a short email you can copy and send to your IT team. If you have questions first, ask the documentation assistant on this site.
