// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { shikiContrast } from './src/lib/shikiContrast.ts';

// Served from the custom domain in public/CNAME. To serve from
// https://strom-capital.github.io/mcp-server-db2i instead, set `site` to that
// origin, `base` to '/mcp-server-db2i' and delete public/CNAME.
export default defineConfig({
  site: 'https://db2i-mcp.com',
  base: '/',
  integrations: [sitemap()],
  // The stylesheets are small; inlining them saves render-blocking requests on mobile.
  build: { inlineStylesheets: 'always' },
  markdown: {
    // Dual themes: CodeBlock.astro and global.css pick one with the page theme
    shikiConfig: { themes: { light: 'vitesse-light', dark: 'vitesse-dark' }, defaultColor: false, transformers: [shikiContrast] },
  },
});
