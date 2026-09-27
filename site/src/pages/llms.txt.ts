import type { APIContext } from 'astro';
import { getPosts } from '../lib/posts';
import { links, url } from '../lib/links';

/** Summary for AI assistants and crawlers, per https://llmstxt.org. Tone and rules: local/brand.md. */
export async function GET(context: APIContext) {
  const site = context.site!;
  const abs = (path: string) => new URL(url(path), site).href;
  const posts = await getPosts();

  const body = `# Db2 for i MCP Server

> An open-source Model Context Protocol (MCP) server that lets Claude, Cursor and other AI assistants read IBM Db2 for i. It is read-only by design: a read-only connection, a SQL validator and a library (schema) allowlist, with column masking, OAuth sign-in with an IBM i user profile and an audit log. It connects through the host servers the IBM i already runs, or over SSH, so nothing is installed on the IBM i.

- Package, CLI and repository name: \`mcp-server-db2i\` (npm, MIT license). Run it with \`npx mcp-server-db2i\`.
- MCP Registry name: \`io.github.Strom-Capital/mcp-server-db2i\`.
- Drivers: IBM i Access ODBC (the default, no Java), JT400 JDBC, or Mapepire over SSH.
- Transports: stdio for local clients (Claude Desktop, Claude Code, Cursor) and Streamable HTTP for remote clients such as claude.ai connectors.
- One server can reach several IBM i systems through connection profiles.
- Teams can add their own business SQL tools and table notes in YAML.
- It does not write to the database and does not replace governed financial reporting.

## Docs

- [Documentation](${links.docs}): full docs, with their own index at ${links.docs}/llms.txt
- [Quickstart](${links.quickstart}): install and connect a first client
- [Client setup](${links.clientSetup}): Claude Desktop, Claude Code, Cursor, claude.ai and Claude for Excel
- [Tools](${links.tools}): the built-in MCP tools
- [Configuration](${links.configuration}): environment variables, drivers and several systems
- [Security](${links.security}): read-only enforcement, allowlist, masking and audit log
- [HTTP transport and OAuth](${links.httpTransport}): remote clients and sign-in
- [Custom tools](${links.customTools}): business SQL tools in YAML
- [Use cases](${links.useCases}): example questions for ERP data on IBM i

## Site

- [Home](${abs('/')}): what the server does and how it compares with other MCP servers for IBM i
- [For business teams](${abs('/business')}): example questions for sales, purchasing, service, manufacturing and finance
- [Blog](${abs('/blog')}): release write-ups (RSS: ${abs('/rss.xml')})

## Blog posts

${posts.map((post) => `- [${post.data.title}](${abs(`/blog/${post.id}/`)}): ${post.data.description}`).join('\n')}

## Optional

- [GitHub repository](${links.github}): source and issues
- [Changelog](${links.changelog})
- [npm package](${links.npm})
`;

  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
