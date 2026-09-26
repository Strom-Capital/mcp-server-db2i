// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Served from the custom domain in public/CNAME. To serve from
// https://strom-capital.github.io/mcp-server-db2i instead, set `site` to that
// origin, `base` to '/mcp-server-db2i' and delete public/CNAME.
export default defineConfig({
  site: 'https://db2i-mcp.com',
  base: '/',
  integrations: [sitemap()],
});
