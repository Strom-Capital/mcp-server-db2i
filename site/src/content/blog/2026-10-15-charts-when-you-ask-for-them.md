---
title: Charts when you ask for them
description: Version 3.8 shows query results as a sortable grid under the tool call, and as a chart when the user asks for one, in Claude and the example web app.
date: 2026-10-15T22:30:00Z
audience: ibmi
tags: [release, charts, web-app]
---

Until now, a query result reached the user as text. The model read the rows and wrote a summary, often with a Markdown table. That works for ten rows. It works less well for a year of monthly totals, where a line says more than a paragraph. Version 3.8 adds a result view: a small page the server ships with `execute_query`, `profile_table` and your business SQL tools. Clients that support MCP Apps, an extension of the Model Context Protocol (MCP), show it under the tool call. Claude does, and so does the [example web app](/blog/a-chat-app-without-a-subscription-for-everyone).

<figure class="shot wide">
  <img class="light" src="/images/blog/chart-types.png" width="2400" height="1649" alt="Twelve result views in a grid: a line of order value by month for three statuses, stacked bars of order lines by warehouse, horizontal bars of top customers, a pie of orders by status, a doughnut of stock value by warehouse, an area of open order lines by week, a pareto of stock value by item, a margin waterfall, a scatter of price and quantity, a histogram of order values, KPI tiles for this month, and the sortable table" />
  <img class="dark" src="/images/blog/chart-types-dark.png" width="2400" height="1649" alt="Twelve result views in a grid: a line of order value by month for three statuses, stacked bars of order lines by warehouse, horizontal bars of top customers, a pie of orders by status, a doughnut of stock value by warehouse, an area of open order lines by week, a pareto of stock value by item, a margin waterfall, a scatter of price and quantity, a histogram of order values, KPI tiles for this month, and the sortable table" />
  <figcaption>Every chart type, plus horizontal bars and the table. Sample data.</figcaption>
</figure>

## A grid first, a chart on request

The view opens on a grid you can sort and filter. A chart is one click away on the Chart tab. It opens on the chart only when someone asked for one: the user wrote "as a chart" or "show me a graph", or a business SQL tool has a chart of its own. The tool description tells the model to send a chart only when the user asks for one, so the lookups it runs on the way to an answer stay tables.

<figure class="shot wide" data-video="web-app">
  <video class="light" data-theme-version="light" controls playsinline preload="none" width="1920" height="1080" poster="/video/web-app-light.jpg" aria-label="A walkthrough of the example web app: signing in with an IBM i user profile, asking a question, sorting and filtering the result table, and charts drawn by the server's result view">
    <source src="/video/web-app-light.mp4" type="video/mp4" />
    <track kind="captions" srclang="en" label="English" src="/video/web-app.vtt" />
  </video>
  <video class="dark" data-theme-version="dark" controls playsinline preload="none" width="1920" height="1080" poster="/video/web-app-dark.jpg" aria-label="A walkthrough of the example web app: signing in with an IBM i user profile, asking a question, sorting and filtering the result table, and charts drawn by the server's result view">
    <source src="/video/web-app-dark.mp4" type="video/mp4" />
    <track kind="captions" srclang="en" label="English" src="/video/web-app.vtt" />
  </video>
  <figcaption>Charts in the example web app, from a line to a waterfall, with sound and captions. Sample data.</figcaption>
</figure>

## How a chart is chosen

`execute_query` takes an optional `chart` argument:

```json
{
  "sql": "SELECT MONTH(ORDDATE) AS MONTH, SUM(AMOUNT) AS TOTAL FROM MYLIB.ORDERS WHERE YEAR(ORDDATE) = 2026 GROUP BY MONTH(ORDDATE) ORDER BY 1",
  "chart": { "type": "line", "x": "MONTH", "y": ["TOTAL"] }
}
```

The types are bar, line, area, pie, doughnut, scatter, pareto, waterfall, histogram, KPI tiles, and table for no chart. Every field but `type` is optional. Column names are checked against the result after the query runs. If a name is wrong, the rows still come back, the hint is dropped and `chartError` says why.

A business SQL tool can set the same object in a `chart:` block, so a tool like "orders by status" always opens as the chart you designed:

```yaml
chart: { type: bar, x: STATUS, y: [TOTAL] }
```

Without a hint, rules pick the chart that sits behind the Chart tab. A date column with numbers becomes a line. One category becomes bars, two become stacked bars, a single row of numbers becomes KPI tiles. A chart draws one measure unless the hint names more, up to three. A split shows the four largest series and adds the rest up as "Other". More than that is hard to read in a chat.

## IBM i details

To tell a measure from a label, the view needs column types, not just JSON values. Results now carry `columns`, each with a `name` and a `kind` such as `decimal`, `date` or `string`, from the driver's metadata. I checked that ODBC, JT400 and Mapepire report the same kinds.

A few rules come from how IBM i data tends to look:

- Numeric codes such as `ORDERNO` and `ITEMNO` are labels. They are never added up.
- Dates stored as numbers, `YYYYMMDD`, or `CYYMMDD` in a column with a date-like name, are read as dates.
- JT400 returns decimals as strings, and the view parses them.

## What it can see

The view is one HTML file built into the server, about 220 KB with Chart.js inside. It reads only the tool result the client hands it, makes no network requests and cannot call tools. Masked columns stay masked, and the result goes through the same read-only connection, SQL validator and library allowlist as before. Set `MCP_UI_ENABLED=false` and the server no longer offers the view at all.

The example web app runs the view in a sandboxed frame with its own Content Security Policy. Since the tool card already shows the rows, the app shows the view only for results with a chart. The lookups the model runs before its answer stay folded away.

## Upgrading

```bash
npx mcp-server-db2i@latest
```

The change is additive. Results gain `columns` (and `chart` when there is a hint), and clients without MCP Apps support ignore the view. [The result view docs](https://docs.db2i-mcp.com/tools#result-view) list the chart types, the rules and the settings.

## What this means for business users

Ask for the answer as a chart, such as "sales per month this year as a chart", and it appears under the answer. You can switch between the chart and the table, and sort or filter the table.
