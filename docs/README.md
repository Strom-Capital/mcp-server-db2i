# Documentation

These guides cover configuring, deploying, and developing with mcp-server-db2i, the MCP server for IBM Db2 for i. They are also published as a documentation site at [docs.db2i-mcp.com](https://docs.db2i-mcp.com). This folder is its source: `docs.json` holds the navigation, and `index.mdx` and `quickstart.mdx` are site-only pages.

| Guide | Description |
|-------|-------------|
| [Tools, resources, and prompts](tools.md) | The built-in tools, filter syntax, MCP resources, and prompts |
| [Use cases](use-cases.md) | REST APIs, BI pipelines, journal replication, and ad-hoc ERP analysis |
| [Client Setup](client-setup.md) | Setup for Cursor, Claude Desktop, and Claude Code |
| [Configuration](configuration.md) | Environment variables, driver options, and all settings |
| [Business SQL tools](custom-tools.md) | YAML tools for orders, ledgers, and master data |
| [HTTP Transport](http-transport.md) | HTTP API, auth, and protocol 2026-07-28 |
| [Docker Guide](docker.md) | Container deployment with Docker and docker-compose |
| [Security](security.md) | Credentials management, rate limiting, and query validation |
| [Development](development.md) | Contributing, testing, and local development setup |

For an overview, the architecture, and compatibility, see the [project README](../README.md).

## Previewing the site

Each page starts with a `title` and `description` header, which the site uses in place of a `#` heading. To preview the site locally:

```bash
cd docs
npx mint dev
```

`npx mint broken-links` checks internal links. In the `.md` guides, link to another guide by its file name, such as `[Schema allowlist](security.md#schema-allowlist)`, so the link works on GitHub. `md-links.js` maps those links to site pages. The site-only `.mdx` pages use site paths such as `/security`. Add new pages to `navigation` in `docs.json`.
