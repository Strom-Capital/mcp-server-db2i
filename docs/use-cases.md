# Use cases

These patterns come from projects where the source system was the Iptor DC1 ERP on IBM i. Nothing in them depends on that ERP. They apply to any IBM i system where the business data lives in DB2 for i files with terse names, numeric dates, and single-letter status codes.

Every library, table, and column name below is a placeholder.

## Building REST APIs on ERP data

A new web shop, portal, or integration needs order data from the ERP. The hard part is rarely the HTTP handler. It is finding the right files, their keys, and what the codes in them mean.

With the server connected to Cursor or Claude Code, the agent does the discovery itself:

1. `search_tables` and `search_columns` find the order header and line files by name or description.
2. `describe_table` and `get_table_constraints` return the columns, types, and keys, so the agent knows that `MYLIB.ORDERS` joins to `MYLIB.ORDERHDR` on `ORDERNO`.
3. The agent drafts the SQL and checks it with `validate_query`, which catches a wrong column or library name before anything runs.
4. `execute_query` runs the statement against a few sample rows, so the response types match the real data.
5. The agent writes the endpoint: the route, bound parameters, the SQL, and the response model.

A prompt that covers the whole flow:

> Find the sales order header and line tables in MYLIB. Then write a `GET /orders/:orderNo` endpoint that returns the header with its lines. Check the SQL with `validate_query` and test it on order 1001 before you write the handler.

Tip: decode numeric dates and status codes once, in YAML annotations (see [Business SQL tools](custom-tools.md#annotations)). The agent reads them through `get_business_context`, so every endpoint it generates turns `20260924` into a date and `O` into "open" the same way.

## ETL and ELT pipelines for BI

A BI solution needs the ERP data in a warehouse or lakehouse, refreshed every night or every hour. Before any pipeline code, someone has to learn what the source files hold and how they change.

The agent can do most of that groundwork:

- **Profile the source.** Row counts, distinct values, date ranges, and null rates through `execute_query`. This shows which columns are real data and which are unused.
- **Build the staging tables.** `get_object_ddl` returns the DDL for a source table, which the agent translates to the target platform's types.
- **Map the dependencies.** `get_related_objects` lists the views, indexes, and logical files that depend on a source table. That often points to a view someone already built for reporting.
- **Draft the incremental extract.** The agent finds a change date or a sequence column and writes a watermark query, for example every `MYLIB.ORDERHDR` row changed since the last run.
- **Map legacy codes to dimensions.** Status codes, order types, and warehouse codes become readable dimension attributes, using the annotations as the source of truth.

A prompt to start with:

> Profile MYLIB.ORDERHDR: row count, date range of ORDERDATE, and the distinct values of STATUS with counts. Then draft an incremental extract of rows changed since yesterday.

Tip: explore with a narrow scope. Set `QUERY_ALLOWED_SCHEMAS` to the libraries the pipeline reads, or use `MCP_TOOLS_ENABLED` for a metadata-only setup without `execute_query`. Run the pipeline itself under a read-only user profile. See [Configuration](configuration.md).

## Near-real-time replication to BI

Nightly extracts leave dashboards a day behind. Journal-based change data capture closes the gap: IBM i records every insert, update, and delete in a journal, and a replication tool such as Fivetran reads those entries and applies them to the warehouse within minutes.

The replication tool does the streaming. The work before it starts is knowing which tables are journaled, and how. The agent can answer that from the catalog:

- **Check journaling.** `QSYS2.OBJECT_STATISTICS` shows whether each file is journaled, to which journal and library, and whether the journal records before images, after images, or both.
- **Find tables without keys.** `get_table_constraints` lists the primary keys. A table without one usually needs both before and after images (`IMAGES(*BOTH)`) so the tool can match an update to the row it changed.
- **Inspect the journal.** `QSYS2.DISPLAY_JOURNAL` shows recent entries, so you can confirm that changes to a table actually reach the journal the tool reads.
- **Pick the table list.** The agent groups the tables by journal and flags the ones that need a change before the connector goes live.

A prompt to start with:

> List the physical files in MYLIB with their journal, journal library, and journal images. Flag every table that has no primary key and does not journal both images.

The server only reads. Starting journaling (`STRJRNPF`) or changing images (`CHGJRNOBJ`) is a change on the system, and an administrator runs those commands. When `QUERY_ALLOWED_SCHEMAS` is set, add `QSYS2` so the catalog queries can run.

Once the raw tables land in the warehouse, the ETL tips above still apply. The same annotations that decode dates and status codes for the agent describe the transformation layer on top of the replicated tables.

## Ad-hoc analysis from AI agents

A sales manager asks which customers have open orders older than 30 days. Normally that is a ticket for the one person who knows the ERP files. With the server connected to Claude or Cursor, the question can go straight to the agent:

> Which customers have open orders older than 30 days? Group them by customer and show the total order value.

The agent finds the tables, writes the query, runs it, and summarizes the result. For questions people ask often, give the agent a vetted query instead of letting it write a new one each time:

- **Business SQL tools** turn a reviewed SELECT into a named tool with typed parameters, such as `search_sales_orders`. See [Business SQL tools](custom-tools.md) and the example pack in [examples/erp-tools](../examples/erp-tools).
- **Column masking** hides fields such as email addresses or bank details from the agent. See [Masking](custom-tools.md#masking).
- **The HTTP transport** serves shared or hosted agents with token authentication. See [HTTP Transport](http-transport.md).

## Guardrails

The same settings keep every use case safe:

- Only SELECT and WITH statements run. Everything else is rejected before it reaches the database.
- `QUERY_DEFAULT_LIMIT` and `QUERY_MAX_LIMIT` cap the rows a query returns.
- `QUERY_ALLOWED_SCHEMAS` keeps queries inside the libraries you list.
- `MCP_AUDIT_LOG` records every tool call.
- Connect with a user profile that has read access only to the data the agent needs.

See [Security](security.md) for the full picture.
