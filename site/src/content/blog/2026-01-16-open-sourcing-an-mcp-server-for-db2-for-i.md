---
title: Open-sourcing an MCP server for Db2 for i
description: Why I built a way for Claude and Cursor to read IBM i databases directly, and what the first release does.
date: 2026-01-16T12:00:00Z
audience: ibmi
tags: [release, announcement]
originalUrl: https://www.reddit.com/r/IBMi/comments/1qedua2/open_sourced_an_mcp_server_for_db2_for_i_claude/
---

I kept doing the same thing. I'd open an AI assistant to help with a query against an IBM i database, then spend the first ten minutes pasting table definitions into the chat and explaining which library held what. The assistant was good at SQL. It just couldn't see the system.

So I built the piece that was missing and released it as `mcp-server-db2i`, under the MIT license.

## What MCP is, briefly

The Model Context Protocol (MCP) is how assistants like Claude and Cursor connect to outside systems. A server describes a set of tools, and the assistant decides when to call them. You don't write a plugin per assistant. Any client that speaks MCP can use any MCP server.

This server gives the assistant a small set of tools for Db2 for i.

## What the first release does

- Runs read-only SQL queries against your IBM i.
- Lists libraries (schemas), tables and views.
- Describes a table's columns, indexes and constraints.
- Works with Claude Desktop, Cursor, or any other MCP client.

In practice, that means you can ask "What columns are in the `ORDERS` table?" and the assistant checks, instead of guessing. Ask "Show me orders from the last 7 days" and it looks up the table, writes the query and runs it.

## Read-only by design

The server only accepts `SELECT` statements. There is no tool for updates, and statements that aren't queries are rejected before they reach the database. I wanted something I'd be comfortable pointing at a real system, and "the model promised not to" isn't a control.

Credentials come from environment variables, so they stay out of the client's config file.

## How it connects

The first release uses the JT400 JDBC driver. That means Node, a Java runtime, and three environment variables: host, user and password. JT400 talks to the database host server that already runs on your IBM i, so there is nothing to install on the system itself.

## Installing it

```bash
npm install -g mcp-server-db2i
```

It also runs as a Docker container. The README covers client setup for Claude Desktop and Cursor.

## What next?

This is a first release, and I'd rather build what people actually need than guess. If you try it, tell me what worked and what didn't. Issues and pull requests are welcome on GitHub.
