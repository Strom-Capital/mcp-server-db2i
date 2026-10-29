---
title: Mapepire works again when the job CCSID is 65535
description: A new Mapepire server made every query fail on systems where the job CCSID is 65535. Version 3.8.4 connects through the database host server again, so the job CCSID no longer matters.
date: 2026-10-29T08:00:00Z
audience: ibmi
tags: [release, drivers, mapepire]
---

If you use the Mapepire driver, every query may have started failing this week with `CCSID value is not valid`. Nothing changed on your side. The install command pulls the newest `@ibm/mapepire-js`, and version 1.1.0, released on 27 October, bundles a newer Mapepire server that cannot start a database connection when the job CCSID is 65535. A user reported it the next day. Version 3.8.4 of the Model Context Protocol (MCP) server fixes it.

## What broke

The full error looks like this:

```
java.sql.SQLException: INTERNAL ERROR:  Creation of DB2Driver object for registering with DriverManager failed. -> com.ibm.db2.jdbc.app.DB2JDBCDataException: CCSID value is not valid.
```

The Mapepire driver logs in over SSH and starts the Mapepire server inside that session. The server then opens its own database connection on the IBM i.

Up to Mapepire server 2.3, that connection went through the Toolbox (JT400) driver to the database host server on the same system. That's what [the SSH post](/blog/mapepire-is-back-over-ssh) described. From 2.4, the default path uses the native JDBC driver in the SSH job instead. The native driver refuses to load when the job CCSID is 65535. That happens whenever the system value `QCCSID` is 65535 and the user profile has `CCSID(*SYSVAL)`, which is a common setup.

mapepire-js 1.1.0 bundles server 2.5.1. The bundled JAR gets uploaded to `$HOME/.mapepire` on first use, so the new server arrived with the new package. I could reproduce it on a test system right away. The problem is reported upstream in [mapepire-server issue 188](https://github.com/Mapepire-IBMi/mapepire-server/issues/188).

## What 3.8.4 changes

mapepire-js 1.1.0 also added a way to choose the connection path. The MCP server now passes that choice through as a new `technique` option in `DB2I_MAPEPIRE_OPTIONS`:

- `technique=tcp`, the default. The Mapepire server connects through the Toolbox driver to the database host server on the same IBM i, as the SSH user. This is the path Mapepire server 2.3 used, so queries run in a `QZDASOINIT` job as they did before, and your database exit programs still apply.
- `technique=cli`. The native JDBC driver in the SSH job. It works only when the job CCSID is not 65535.

On the test system, `tcp` sees the same user, current schema and library list as the `odbc` driver. Text outside ASCII, such as `ÄÖ€`, comes back intact. `get_object_ddl`, which uses a second connection, returns the same DDL as `odbc`.

Nothing else changes. The connection keeps the read-only default, and the SQL validator, the library allowlist and masking apply as before.

With mapepire-js 1.0, the option is ignored. That version bundles server 2.3.6, which takes the host server path anyway.

## What `tcp` needs

Only port 22 has to be open to the network, as before. Inside the IBM i, the database host server has to be running (`STRHOSTSVR SERVER(*DATABASE)`). It normally is, since ODBC, JT400 and ACS Run SQL Scripts use it too.

Some shops end the database host server and allow SSH only. If yours does, set `technique=cli` and give the user profile a CCSID:

```env
DB2I_MAPEPIRE_OPTIONS=hostKey=SHA256:abc...xyz;technique=cli
```

```
CHGUSRPRF USRPRF(MCPREAD) CCSID(37)
```

Pick the CCSID that matches your system's language. With `technique=cli` and a job CCSID of 65535, the error now explains the cause and names both ways out, instead of stopping at `CCSID value is not valid`.

## If you can't upgrade yet

Either of these gets an older MCP server working again:

- Pin the previous mapepire-js, which bundles server 2.3.6: `npx -y -p mcp-server-db2i@latest -p @ibm/mapepire-js@1.0.2 -p ssh2 mcp-server-db2i`
- Give the user profile a CCSID, as shown above.

## Upgrading

```bash
npx -y -p mcp-server-db2i@latest -p @ibm/mapepire-js -p ssh2 mcp-server-db2i
```

With a global install, run `npm install -g mcp-server-db2i @ibm/mapepire-js ssh2`. No configuration change is needed. The `odbc` and `jt400` drivers are not affected. Every Mapepire option is in [Using the Mapepire driver](https://docs.db2i-mcp.com/configuration#using-the-mapepire-driver-ssh).

## What next?

If a later Mapepire server makes the native path work on CCSID 65535, I'll look at the default again. Until then, `tcp` is the path that works on the most systems.
