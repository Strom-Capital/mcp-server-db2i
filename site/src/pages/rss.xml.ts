import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getPosts } from '../lib/posts';
import { url } from '../lib/links';

export async function GET(context: APIContext) {
  const posts = await getPosts();
  return rss({
    title: 'Db2 for i MCP Server',
    description: 'Releases and write-ups for mcp-server-db2i, the open-source MCP server for IBM Db2 for i.',
    site: context.site!,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.date,
      link: url(`/blog/${post.id}/`),
      categories: post.data.tags,
    })),
  });
}
