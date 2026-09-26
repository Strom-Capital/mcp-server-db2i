---
title: Mapepire is back, over SSH
description: I dropped the Mapepire driver earlier. Its new SSH mode changes the trade-off, so it's back, for systems where only port 22 is open.
date: 2026-09-24T18:00:00Z
audience: ibmi
tags: [release, drivers, mapepire]
---

In an earlier update I said this project would stay on JDBC and that I had dropped the Mapepire branch. The reasoning was simple. Mapepire needs a server component on the IBM i, and installing something new on a production system isn't always an option. IBM's own MCP server for IBM i already covers the Mapepire route well.

A few hours after the 2.7 release, that reasoning stopped holding. mapepire-js 1.0 has an SSH mode, and version 2.8 uses it.

## How it works

```bash
DB2I_DRIVER=mapepire
```

The driver logs in over SSH and starts the Mapepire server inside that session. There is no daemon to run and nothing for an administrator to install.

- **Only port 22 needs to be open to the network.** Inside the IBM i, Mapepire talks to the database host server over localhost. That server has to be running (it normally is), and your database exit programs still apply.
- **On first use**, mapepire-js uploads its bundled server JAR to `$HOME/.mapepire` and checks its checksum. If Code for i has already put a JAR there, it's reused. If you run the `mapepire-server` package, point `serverPath` at it instead.
- **On the IBM i**, it needs sshd and Java 8 or later. The client needs no Java and no ODBC driver.
- **Before the password is sent**, it checks the host key against `~/.ssh/known_hosts` or a pinned `hostKey=SHA256:...` fingerprint.

The connection keeps the read-only default, and the allowlist and masking apply exactly as with the other drivers.

Someone on r/IBMi pointed out a port clash on the old branch. They were right. This version doesn't need a Mapepire port at all. Only SSH has to be open.

## Which driver to use

It depends on what your network allows:

| Your network | Driver |
|---|---|
| Host server ports open | `odbc` (the default) or `jt400` |
| Only SSH open | `mapepire` |

With `DB2I_PROFILES`, you can mix them: one driver per system.

## The trade-off

Each Mapepire job is a JVM on the IBM i, so the first query in a session takes a few seconds. After that it's quick. The user profile also needs SSH login, which includes a shell. Give the server a dedicated, low-privilege profile, as you would for the other drivers.

## Upgrading

```bash
npx mcp-server-db2i@latest
```

Setup details are in the configuration guide, under the Mapepire driver.

## What next?

Remote clients. Right now claude.ai can't connect at all, because HTTP mode needs a token that a hosted client can't hold. That's next.
