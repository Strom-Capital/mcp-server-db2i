---
title: Tools, resources, and prompts
sidebarTitle: Tools
description: The built-in MCP tools, resources, and prompts that mcp-server-db2i registers.
---

Every tool is read-only. Each one can be turned off with `MCP_TOOLS_DISABLED`, or the list narrowed with `MCP_TOOLS_ENABLED` (see [Tool selection](configuration.md#tool-selection)). With several systems configured, every tool takes an optional `system` argument (see [Multiple systems](configuration.md#multiple-systems)). [Business SQL tools](custom-tools.md) loaded from YAML appear next to these.

## Tools

| Tool | Description |
|------|-------------|
| `execute_query` | Execute read-only SELECT queries |
| `list_schemas` | List schemas/libraries (with optional filter) |
| `list_tables` | List tables in a schema (with optional filter) |
| `search_tables` | Find tables by name or description across libraries |
| `search_columns` | Find columns by name or description across libraries |
| `describe_table` | Get detailed column information |
| `list_views` | List views in a schema (with optional filter) |
| `list_indexes` | List SQL indexes for a table |
| `get_table_constraints` | Get primary keys, foreign keys, unique constraints |
| `validate_query` | Check a statement without running it, including catalog names |
| `get_object_ddl` | Return the SQL DDL that recreates an object |
| `get_related_objects` | List objects that depend on a table |
| `get_journal_info` | List journal, images, and primary key per table, and flag tables a replication tool cannot read |
| `profile_table` | Row count, last change, and per-column distinct and null counts from stored statistics or a scan |
| `get_business_context` | List business descriptions and relations loaded from YAML |
| `search_ibmi_services` | Find IBM i services by keyword or category, with the release that added each one and an example query |

> **Note:** `list_indexes` and `get_table_constraints` query the `QSYS2` SQL catalog views and only return SQL-defined objects. Legacy DDS Logical Files and Physical File constraints are not included.

## Filter syntax

The list tools support pattern matching:

| Pattern | Matches |
|---------|---------|
| `CUST` | Contains "CUST" |
| `CUST*` | Starts with "CUST" |
| `*LOG` | Ends with "LOG" |
| `ORD*FILE` | Starts with "ORD", ends with "FILE" |

## Resources

Clients that support MCP resources can read a table's context without a tool call, and complete library and table names as you type.

| Resource | Contents | Registered when |
|----------|----------|-----------------|
| `db2i://{schema}/{table}` | Columns from the catalog, plus the YAML business description, column notes, and relations | `describe_table` is enabled |
| `db2i://{schema}/{table}/ddl` | SQL from `QSYS2.GENERATE_SQL` that recreates the table, view, or alias | `get_object_ddl` is enabled |
| `db2i://business-context` | Every annotation loaded from `MCP_CUSTOM_TOOLS` | `get_business_context` is enabled |

`resources/list` offers the annotated tables, for example `db2i://MYLIB/ORDERS`. Percent-encode `#` and other reserved characters in names (`ORD%23X` for `ORD#X`). A library outside `QUERY_ALLOWED_SCHEMAS` is rejected with the same message `execute_query` gives, and completion offers only allowed libraries. Reads and completions that query IBM i count against the rate limit, and reads are written to the audit log. Completion fetches a library's name list once and reuses it for 60 seconds, so typing a name costs one query rather than one per keystroke.

## Prompts

| Prompt | Arguments | What it asks for |
|--------|-----------|------------------|
| `explore_library` | `schema` | List the tables, describe the central ones, and summarize how they join |
| `explain_table` | `schema`, `table` | Explain rows, columns, keys, and relations in plain language |
| `write_query` | `question`, `schema`, `table` | Write one SELECT from the table's real columns and YAML relations, then validate and run it when those tools are enabled |

A prompt is listed only when the tools it tells the model to call are enabled: `explore_library` needs `list_tables` and `describe_table`, and the other two need `describe_table`. None of them asks for a write.
