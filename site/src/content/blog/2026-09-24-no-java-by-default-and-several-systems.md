---
title: No Java by default, and several systems from one server
description: The IBM i Access ODBC driver is now the default, JT400 is optional, and one server can reach production, test and development side by side.
date: 2026-09-24T12:00:00Z
audience: ibmi
tags: [release, drivers, breaking]
---

The most common complaint about setup was fair. Node, plus a Java runtime for the JT400 driver, plus three environment variables is more than most MCP servers ask for. Someone on r/IBMi compared it with servers you just install and use, and they had a point.

Versions 2.6 and 2.7 remove the Java part for most people, and let one server reach several IBM i systems.

## ODBC is the default driver

The server now uses the IBM i Access ODBC driver by default. On the machine that runs the server, you need unixODBC and IBM's ODBC driver. No Java.

Like JT400, ODBC talks to the database host server that already runs on your IBM i. There is still nothing new to install on the system itself.

JT400 still works. Set `DB2I_DRIVER=jt400` and have a JDK installed when you run `npm install`, because the Java bridge compiles then. The Dockerfile builds either image: the default build gives you ODBC, and `--target jt400` gives you JT400.

Behind this is a driver interface. Each tool talks to the interface, not to a driver, so every guarantee (read-only, the allowlist, masking, the audit log) behaves the same whichever driver is underneath. That interface is also what made the next release possible.

## Several systems from one server

Point `DB2I_PROFILES` at a YAML file with one profile per system:

```yaml
profiles:
  - name: prod
    host: ibmi.example.com
    driver: odbc
    username: "${DB2I_PROD_USERNAME}"
    password: "${DB2I_PROD_PASSWORD}"
    schema: MYLIB
    allowedSchemas: [MYLIB, QSYS2]
  - name: test
    host: ibmi-test.example.com
    driver: jt400
    username: MCPREAD
    passwordFile: /run/secrets/db2i_test_password
```

Each system gets its own driver, credentials and library allowlist. Passwords come from environment variables or files, never from the YAML itself: a literal password is refused.

Every tool takes an optional `system` argument. You can ask for a column's definition in test and then run the same query against production, in one conversation, without restarting anything.

## Upgrading

```bash
npx mcp-server-db2i@latest
```

**If you use JT400 today, set `DB2I_DRIVER=jt400` before you upgrade.** Otherwise the server looks for the ODBC driver and fails to connect. Docker users on arm64 should note that the ODBC image is amd64 only, while the JT400 image builds natively.

## What next?

Some systems only have SSH open to the network, and neither ODBC nor JT400 can reach them. I had dropped Mapepire earlier for good reasons. That turned out not to be the end of it.
