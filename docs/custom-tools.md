# Business SQL tools

Administrators can add read-only tools, and notes about tables the catalog does not explain, without changing the server code. The tools are SELECT and WITH statements. Parameter values are bound. They are never pasted into the SQL text.

Set `MCP_CUSTOM_TOOLS` to a YAML file, a directory, or a comma-separated list of either. The server reads them once at startup and refuses to start when a file is invalid or a statement fails the read-only check. When `QUERY_ALLOWED_SCHEMAS` is set, every table reference must stay inside that list too.

An empty or unset `MCP_CUSTOM_TOOLS` loads nothing. The built-in tools keep working.

See [examples/erp-tools](../examples/erp-tools) for a generic pack: sales orders, purchase orders, service orders, manufacturing orders, a bill of materials, the general ledger, and item and customer master data. The statements show patterns that show up on real order files: a numeric date, a derived status, a header with jobs and lines, and a text search. Every library, table, and column name in that pack is a placeholder. Point them at your own files before you load the directory.

## File format

```yaml
version: 1
tools:
  - name: search_sales_orders
    title: Search sales orders
    toolset: sales
    description: Open sales orders for a customer, newest first.
    parameters:
      customer: { type: string, required: true, maxLength: 10, description: Customer number }
      status: { type: string, enum: [O, C], default: O }
    maxRows: 200
    sql: |
      SELECT H.ORDERNO, H.CUSTNO, H.ORDERDATE, H.STATUS
      FROM MYLIB.ORDERHDR H
      WHERE H.CUSTNO = :customer AND H.STATUS = :status
      ORDER BY H.ORDERDATE DESC
annotations:
  MYLIB.ORDERHDR:
    entity: sales_order
    description: Sales order header
    columns:
      STATUS: "O = open, C = closed"
    relations:
      - table: MYLIB.ORDERS
        join: { ORDERNO: ORDERNO }
        cardinality: one-to-many
        description: Order lines
```

`version` must be `1`. A file needs at least one tool, one annotation, or one masking rule.

### Tools

| Field | Required | Meaning |
|-------|----------|---------|
| `name` | yes | snake_case. Cannot reuse a built-in tool name. Must be unique across every loaded file. |
| `title` | yes | Short label shown to the client |
| `description` | yes | What the tool returns, and how to choose arguments |
| `toolset` | no | snake_case group. `MCP_TOOLS_ENABLED=toolset:sales` registers only that group. |
| `parameters` | no | Named arguments. Every parameter must appear as `:name` in the SQL, and every `:name` must be declared. |
| `maxRows` | no | Row cap for this tool. The server also applies `QUERY_MAX_LIMIT`, and uses the smaller of the two. When `maxRows` is omitted, `QUERY_DEFAULT_LIMIT` is used. |
| `system` | no | Profile from `DB2I_PROFILES` the tool always runs on. See [Running on one system](#running-on-one-system). |
| `sql` | yes | One read-only statement. It must start with `SELECT` or `WITH`. |

Parameter types are `string` (optional `maxLength`), `integer`, `number`, `boolean`, `date`, and `enum`. A `string` parameter may also set `enum` to a list of allowed values. `date` values are `YYYY-MM-DD`.

A parameter with a `default` may be omitted, and the default is bound. `required: false` with no default may be omitted, and NULL is bound. Anything else must be sent by the client.

Boolean values bind as `1` and `0`.

`:name` is replaced with a `?` marker. The same name may appear more than once, and the same value is bound each time. Placeholders inside string literals, quoted identifiers, and comments are left as text. A hand-written `?` is rejected so the bind order stays unambiguous.

An optional filter has to survive a NULL. Compare a cast marker, then the column:

```sql
WHERE (CAST(:customer AS VARCHAR(10)) IS NULL OR H.CUSTNO = :customer)
```

Use `CAST(:from_date AS DATE)` when the column is a real DATE. A numeric `YYYYMMDD` column needs the conversion in [Common patterns](#common-patterns). The cast gives the marker a type when the argument is NULL.

### Running on one system

With several systems in [`DB2I_PROFILES`](configuration.md#multiple-systems), set `system:` to pin a tool to one of them:

```yaml
tools:
  - name: open_orders_prod
    title: Open orders (production)
    description: Open sales orders on the production system.
    system: prod
    sql: SELECT ORDERNO, CUSTNO FROM SALES.ORDERHDR WHERE STATUS = 'O'
```

- A pinned tool has no `system` argument and always runs on its system. An unknown name stops startup.
- A tool without `system:` gets the same optional `system` argument as the built-in tools, and runs on the default (first) system when the caller names none. A tool that declares its own parameter named `system` gets no extra argument and runs on the default system.
- At startup a pinned tool is checked against its system's allowlist. Other tools are checked against the default system's list. Every call is checked again against the system it runs on.
- An HTTP session that logged in to one system does not list tools pinned to another.

### Annotations

Keys are `SCHEMA.TABLE`. Names are folded to uppercase.

| Field | Meaning |
|-------|---------|
| `entity` | snake_case name such as `sales_order` |
| `description` | What the table is, in business words |
| `columns` | Meaning of a column, including status codes |
| `relations` | A link the catalog does not declare as a foreign key |

A relation names the other `SCHEMA.TABLE`, a `join` map of local column to remote column, an optional `cardinality` (`one-to-one`, `one-to-many`, `many-to-one`, `many-to-many`), and an optional description.

`get_business_context` returns these notes. Filter with `entity`, `table` (`ORDERHDR` or `MYLIB.ORDERHDR`), or omit both to list every annotation. `describe_table` adds `business_description` and `relations` when the table is annotated, and a `business_description` on columns that have one. `list_tables` adds `business_description` on annotated tables.

### Masking

A `masking` section names columns the agent should not see in full. Keys are `SCHEMA.TABLE`. Column names are unquoted SQL names. Both are folded to uppercase. The same table and column in two files is rejected.

| Rule | Result |
|------|--------|
| `redact` | The value is replaced with `****` |
| `last4` | The last four characters are kept and the rest become `*`. A value of four characters or fewer is replaced with `****` |

```yaml
version: 1
masking:
  MYLIB.CUSTOMERS:
    EMAIL: redact
    PHONE: last4
```

`execute_query` and YAML tools may select a masked column only as a plain item in the outer select list: `EMAIL`, `C.EMAIL`, or `MYLIB.CUSTOMERS.EMAIL`. `SELECT *` is allowed, and the matching result keys are masked. An alias, an expression, a predicate, a join, `GROUP BY`, `ORDER BY`, a subquery, and `UNION`, `EXCEPT`, or `INTERSECT` are rejected. An `ORDER BY` position (`ORDER BY 2`) is rejected too, because it can point at the masked column.

An unqualified `EMAIL` counts as the masked column whenever `MYLIB.CUSTOMERS` is in the statement, even when another table also has a column of that name. A view, an alias object, or a table function over a masked table is not masked unless that object is listed itself.

YAML tools are checked when the files load, including a rule that lives in a different file from the tool. `execute_query` uses `QSYS2.PARSE_STATEMENT` to see which tables the statement touches, so it refuses to run when masking is loaded and `QUERY_PARSE_CHECK` is off. `extended metadata=true` in `DB2I_JDBC_OPTIONS` renames result columns, and the server refuses to start with that option while masking is loaded.

`profile_table` applies the same rules: a masked column keeps its distinct and null counts and returns no low, high, minimum, or maximum value.

See [Security](security.md#column-masking) for why this is a backstop and not a database control.

## Common patterns

The example pack uses placeholder names (`MYLIB.ORDERHDR`, `ORDERNO`, `ORDERDAT`). Copy the shape of the statement, then rename every identifier to the files you actually have. The status numbers below are an example ladder, not a standard.

### An optional filter has to accept NULL

An omitted optional argument is bound as NULL. `NULL = NULL` is unknown, so a bare comparison drops every row. Test the cast first:

```sql
AND (CAST(:customer AS VARCHAR(10)) IS NULL OR TRIM(H.CUSTNO) = TRIM(CAST(:customer AS VARCHAR(10))))
```

Use the same `:name` in both places. The same value is bound each time. `TRIM` matters when the column is a fixed-length character field with trailing blanks.

### A date stored as a number

Many order files store the day as an integer `YYYYMMDD`, not as a DATE. A `date` parameter arrives as text `YYYY-MM-DD`. Build the number with `SUBSTR` and compare it to the column:

```sql
AND (
  CAST(:from_date AS VARCHAR(10)) IS NULL
  OR H.ORDERDAT >= INTEGER(
    SUBSTR(CAST(:from_date AS VARCHAR(10)), 1, 4) ||
    SUBSTR(CAST(:from_date AS VARCHAR(10)), 6, 2) ||
    SUBSTR(CAST(:from_date AS VARCHAR(10)), 9, 2)
  )
)
```

Show the same number back as a date with `DIGITS`, which zero-pads it to the width of the column:

```sql
SUBSTR(DIGITS(H.ORDERDAT), 1, 4) || '-' ||
  SUBSTR(DIGITS(H.ORDERDAT), 5, 2) || '-' ||
  SUBSTR(DIGITS(H.ORDERDAT), 7, 2) AS ORDER_DATE
```

Do not use `REPLACE` to strip the dashes. The read-only check treats `REPLACE` as a data-changing statement and the server will not start. `TRANSLATE` is safe if you prefer it, and so is the `SUBSTR` form above.

When the column is a real DATE, compare it directly. The general-ledger example does this with `TRANSDATE`:

```sql
AND (CAST(:from_date AS DATE) IS NULL OR T.TRANSDATE >= :from_date)
```

### Derived status

A single column rarely matches the word a person uses ("open", "closed", "invoiced"). Compute it in the statement and document the codes on the annotation. The sales example treats `STATFLG = 'E'` as an error, status `60` as invoiced, status `40` and above as picked, and anything else as open. Deleted rows (`STATFLG = 'D'`) are filtered out rather than counted.

A service order is often "closed" only when every job under it is closed. That needs the jobs in the same statement:

```sql
CASE
  WHEN TRIM(H.STATFLG) = 'E' THEN 'error'
  WHEN H.STATUS = 60 THEN 'invoiced'
  WHEN COUNT(J.JOBNO) > 0
    AND SUM(CASE WHEN TRIM(J.CLOSEDFLG) <> 'Y' THEN 1 ELSE 0 END) = 0
    THEN 'closed'
  ELSE 'open'
END AS DERIVED_STATUS
```

To filter on that result, wrap the grouped query and test the alias outside. The status number and the flag stay in the `GROUP BY`.

### Header, job, and line

A service order in the example pack is three files:

- `SVCHDR` is the header, and it joins `ORDTYPE` where `SVCFLAG = 'Y'` so ordinary sales types stay out
- `SVCJOB` is one job package and points at an installed unit with `ITEMNO` and `SERIALNO`
- `SVCLINE` is a labor or part line on that job

`get_service_order` returns one row per job. `list_service_order_lines` returns the lines. Put that shape in the annotations too, so `get_business_context` can explain a join the catalog does not declare.

### Text search

Match several columns, and use `EXISTS` when the value lives on a child row. Fold case on both sides:

```sql
UPPER(TRIM(C.CUSTNAME)) LIKE '%' || UPPER(TRIM(CAST(:text AS VARCHAR(30)))) || '%'
OR EXISTS (
  SELECT 1
  FROM MYLIB.SVCJOB J
  WHERE J.SVCNO = H.SVCNO
    AND UPPER(TRIM(J.SERIALNO)) LIKE '%' || UPPER(TRIM(CAST(:text AS VARCHAR(30)))) || '%'
)
```

A leading `%` does not use an index. Keep `maxRows` small, and require the text argument so a client cannot scan the whole file by accident.

### Row caps

Leave `LIMIT` and `FETCH FIRST` out of the YAML. Set `maxRows` on the tool. The server appends `FETCH FIRST n ROWS ONLY` and will not go above `QUERY_MAX_LIMIT`.

## What is still enforced

Custom tools use the read-only connection, the rate limiter, and the read-only tool hints.

At startup the server runs the same read-only check as `execute_query`. When `QUERY_ALLOWED_SCHEMAS` is set, it also checks every table reference, and refuses to start if a statement names another library or cannot be parsed. Qualify tables with a library (`MYLIB.ORDERHDR`) so the check does not depend on the session schema. At call time the allowlist is checked again with that session's default schema, which matters for unqualified names.

When `QUERY_PARSE_CHECK` is on, the first call of each tool asks `QSYS2.PARSE_STATEMENT` whether the statement is a query. That result is cached for the life of the process. A missing function rejects the tool until you set `QUERY_PARSE_CHECK=false`.

`mcp-server-db2i validate-tools <path...>` runs those startup checks and exits, without a database. Add `--connect` to run the `PARSE_STATEMENT` check as well. That needs credentials and a reachable host. See [Validating tool files](development.md#validating-tool-files).

`MCP_CUSTOM_TOOLS_WATCH=true` runs the same checks again when a watched file changes. A valid set replaces the registry and clients are told to refresh `tools/list`. A bad save is logged and does not replace the tools that are already running. The default is off. Watching with an empty `MCP_CUSTOM_TOOLS` stops startup.

`MCP_TOOLS_ENABLED` and `MCP_TOOLS_DISABLED` accept a custom tool name or `toolset:<name>`, as well as the built-in names. A toolset selector does not match built-in tools. An unknown name or toolset stops startup.

```env
MCP_CUSTOM_TOOLS=./examples/erp-tools
MCP_TOOLS_ENABLED=toolset:sales,get_business_context
QUERY_ALLOWED_SCHEMAS=MYLIB
```

That registers the sales tools and `get_business_context`, and leaves `execute_query` unregistered.

IBM i object authority on the user profile is the last line of defense. The profile should be able to read the business files and should not be able to change them. A read-only JDBC connection and the statement checks sit in front of that. They do not replace it.

## Docker

Mount the YAML directory read-only and set `MCP_CUSTOM_TOOLS` to the path inside the container. See the [Docker guide](docker.md).
