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
| `export_query` | Write every row of a read-only query to a CSV or XLSX file: a path over stdio, a short-lived download link over HTTP. Off unless `EXPORT_ENABLED` is set |
| `list_schemas` | List schemas/libraries (with optional filter) |
| `list_tables` | List tables in a schema (with optional filter) |
| `search_tables` | Find tables by name or description across libraries |
| `search_columns` | Find columns by name or description across libraries |
| `describe_table` | Get detailed column information |
| `list_views` | List views in a schema (with optional filter) |
| `list_indexes` | List SQL indexes for a table |
| `get_table_constraints` | Get primary keys, foreign keys, unique constraints |
| `list_routines` | List SQL procedures and functions in a library, with language, external program, and SQL data access |
| `describe_routine` | Parameters, return value or result columns, and a call template for a procedure or function |
| `validate_query` | Check a statement without running it, including catalog names |
| `get_object_ddl` | Return the SQL DDL that recreates an object |
| `get_related_objects` | List objects that depend on a table |
| `get_journal_info` | List journal, images, and primary key per table, and flag tables a replication tool cannot read |
| `index_advice` | List the indexes the query optimizer asked for in a library, merged and ranked by temporary index use |
| `profile_table` | Row count, last change, and per-column distinct and null counts from stored statistics or a scan |
| `get_business_context` | List business descriptions and relations loaded from YAML |
| `search_ibmi_services` | Find IBM i services by keyword or category, with the release that added each one and an example query |

> **Note:** `list_indexes` and `get_table_constraints` query the `QSYS2` SQL catalog views and only return SQL-defined objects. Legacy DDS Logical Files and Physical File constraints are not included.

### Procedures and functions

`list_routines` reads `QSYS2.SYSROUTINES` for one library and returns one row per specific routine, so each overload of a name is its own row. `filter` uses the same wildcards as `list_tables`, and `type` narrows the list to `PROCEDURE` or `FUNCTION`.

| Field | Meaning |
|-------|---------|
| `type` | `PROCEDURE`, `SCALAR FUNCTION`, or `TABLE FUNCTION` |
| `language` | `SQL` for an SQL routine, otherwise the external language such as `RPGLE`, `CLLE`, or `C` |
| `external_name` | The program or service program an external routine calls |
| `sql_data_access` | `NO SQL`, `CONTAINS SQL`, `READS SQL DATA`, or `MODIFIES SQL DATA` |
| `result_sets` | Result sets a procedure can return. Null for functions |
| `parameter_count`, `text`, `last_altered` | Number of parameters, the routine's text, and when it last changed |

`describe_routine` reads `QSYS2.SYSPARMS` for a routine. An overloaded name returns every overload unless `specific_name` picks one. Each result has the fields above plus:

| Field | Meaning |
|-------|---------|
| `parameters` | In order, with `mode` (`IN`, `OUT`, or `INOUT`), `data_type`, `length`, `precision`, `scale`, `nullable`, and `default` as SQL text |
| `returns` | The return value of a scalar function |
| `result_columns` | The result columns of a table function |
| `call_template` | A statement with a `?` marker per parameter, with named arguments when every parameter has a name |
| `callable_with_execute_query` | Whether `execute_query` can run the template. `note` says why not |

Templates look like `CALL MYLIB.GET_ORDER(ORDERNO => ?)`, `SELECT MYLIB.ORDER_TOTAL(ORDERNO => ?) FROM SYSIBM.SYSDUMMY1`, and `SELECT * FROM TABLE(MYLIB.OPEN_ORDERS(CUSTNO => ?)) X`. `execute_query` runs only `SELECT`, so procedures and functions that modify SQL data are never callable through it. While `QUERY_ALLOWED_SCHEMAS` is set, statements are parsed to check their libraries, and the parser reads neither `TABLE(...)` nor named arguments. A scalar function's template then uses positional markers and is callable only when `SYSIBM` is in the list too, because it reads `SYSIBM.SYSDUMMY1`. Table functions are marked not callable.

### Index advice

`index_advice` reads the IBM i index advisor (`QSYS2.SYSIXADV`) for one library, or one table in it. The advisor keeps a row per reason code and variant, so the tool merges rows with the same table, key columns, and index type and sums their counts. `rows_merged` says how many advisor rows each result stands for.

| Field | Meaning |
|-------|---------|
| `key_columns` | Keys in `CREATE INDEX` order. A key can end in `DESC` |
| `index_type` | `RADIX` or `ENCODED VECTOR` |
| `times_advised` | How often the optimizer asked for this index |
| `mti_used`, `mti_created` | How often it used and built a maintained temporary index (MTI) instead |
| `last_advised`, `last_mti_used` | Latest advice and latest MTI use, in the system's local time |
| `reasons` | Reason codes with IBM's description, such as `I1` (row selection) and `I2` (ordering or grouping) |

Results are sorted by `mti_used`, then `times_advised`. Advice the optimizer kept building a temporary index for is the strongest candidate for a permanent one. `since` keeps only advisor rows last given on or after that date or timestamp, also in the system's local time. The tool only reads the advice. Review it before creating an index, because the advisor does not check whether an existing index or keyed logical file already covers the keys.

### Warnings

A successful `execute_query` or business SQL tool result can carry `warnings`, which the agent should pass on to the user. Today the only one is from the `odbc` driver: it names `DECIMAL` and `NUMERIC` columns whose values have more than 15 digits and were rounded. See [Values that differ by driver](configuration.md#values-that-differ-by-driver).

### Query exports

`export_query` is for results the user wants as a file, such as "all open orders for customer 1001 as a spreadsheet". It runs a SELECT with the same checks as `execute_query` and writes every row to a file on the server host, instead of returning the rows to the model. It is registered only when `EXPORT_ENABLED=true` and `EXPORT_DIR` are set. See [Query exports](configuration.md#query-exports) for the settings.

| Argument | Meaning |
|----------|---------|
| `sql`, `params` | The query, checked like `execute_query`: read-only statements, `QUERY_ALLOWED_SCHEMAS`, the parse check, and column masking |
| `format` | `xlsx` (default) or `csv` |
| `filename` | Name for the file, without extension. Letters, digits, `.`, `_` and `-` are kept |
| `max_rows` | Most rows to write, capped by `EXPORT_MAX_ROWS` |

The result tells the model where the file is and what is in it:

| Field | Meaning |
|-------|---------|
| `path` | Over stdio: the file on this machine |
| `url` | Over HTTP: a download link under `MCP_PUBLIC_URL`, also sent as a `resource_link` |
| `downloadsAllowed` | How many downloads the link allows (`EXPORT_MAX_DOWNLOADS`, 3 by default) |
| `expiresAt` | When the file is deleted, after `EXPORT_TTL_MINUTES` |
| `rowCount`, `bytes`, `columns` | What was written |
| `truncated` | `rows` or `bytes` when the file stops at the row or size cap, otherwise `false` |
| `sample` | The first five rows, masked, so the model can check the export looks right |
| `warnings` | Things to pass on to the user: decimals the driver may have rounded, or text with characters lost in decoding |

- **XLSX** has one sheet with a bold, frozen header row and a filter. Numbers, dates, times and timestamps are typed cells. A decimal column with digits after the point gets a number format with its scale, so `72.5` in a `DECIMAL(9,2)` column shows as `72.50` and still adds up. A decimal or `BIGINT` wider than 15 digits is written as text so it keeps every digit. Text is always text, so a value that starts with `=` never becomes a formula. One sheet holds at most 1,048,575 rows.
- **CSV** is UTF-8 with a byte order mark, so Excel opens accented characters correctly, and fields are quoted as in RFC 4180. A text value that starts with `=`, `+`, `-` or `@` gets a leading `'`, so a spreadsheet does not run it as a formula. Numbers are never changed.
- With the `odbc` driver, node-odbc reads `DECIMAL` and `NUMERIC` values as JavaScript numbers, so digits past the 15th are rounded. When a value in the export has 15 or more significant digits, the result has a `warnings` entry naming the column. Use the `jt400` or `mapepire` driver when such values must be exact.
- Text that contains the replacement character `�` means characters were lost when the driver decoded it. The result then has a `warnings` entry naming the columns. With the `odbc` driver, set `CCSID=1208` in `DB2I_ODBC_OPTIONS`.
- CHAR padding is removed. Binary columns are written as hex with `odbc`. With `jt400` and `mapepire`, `FOR BIT DATA` columns arrive as text translated by the driver, the same as in `execute_query`.
- Give every column a unique name. A result with two columns of the same name, such as `a.ORDERNO` and `b.ORDERNO`, is rejected; use `AS`.

### Failed statements

When Db2 rejects a statement in `execute_query`, a business SQL tool, `validate_query` or `profile_table`, the error result also has these fields:

| Field | Example |
|-------|---------|
| `sqlstate` | `42704` |
| `sqlcode` | `-204` |
| `cause` | `&1 in &2 type *&3 was not found. ...` |
| `recovery` | `Change the name and try the request again. ...` |

`cause` and `recovery` also follow the message in the text content, and come from the second-level text of the SQL message (`SYSTOOLS.SQLCODE_INFO`). `&1`, `&2` and so on stand for the values in the first-level message in `error`. With the JDBC option `errors=full`, the `jt400` and `mapepire` drivers return the text with the values filled in. If the text cannot be read, the error comes without `cause` and `recovery`. Rejections by the SQL validator, the schema allowlist or column masking explain themselves and have none of these fields.

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
