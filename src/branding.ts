/**
 * Project logo for the sign-in pages, the favicon and the MCP server icon.
 *
 * The mark is the db2i/mcp route mark from docs/assets/brand (a 24 x 24 grid).
 * The raster icons are the mark on a warm tile, so they stay visible on light
 * and dark backgrounds. They were rendered from docs/assets/brand/svg/icon-tile.svg:
 *
 *   rsvg-convert -w 256 -h 256 icon-tile.svg -o icon.png
 *   rsvg-convert -w 16|32|48 ...        (then packed as PNG frames in favicon.ico)
 */

import type { Icon } from '@modelcontextprotocol/server';

import { isLoopbackHost } from './config.js';

/** Product name as the README heading and the docs site show it. */
export const DISPLAY_NAME = 'Db2 for i MCP Server';

/**
 * Shapes of the route mark (docs/assets/brand/svg/mark-primary.svg), in a 24 x 24 box.
 * The origin and route follow the text color. The end node uses --accent when the
 * page defines it, and the brand blue otherwise.
 */
export const LOGO_SHAPES =
  '<circle cx="3.5" cy="6" r="1.75" fill="currentColor"/>' +
  '<path d="M6 6 H11 C12.657 6 14 7.343 14 9 V14 C14 15.657 15.343 17 17 17 H18" fill="none" ' +
  'stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<rect x="18.5" y="15.5" width="3.5" height="3.5" rx="0.35" style="fill:var(--accent,#3159E8)"/>';

/** Favicon for browser tabs. Its own style switches the colors for dark browser chrome. */
export const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" role="img" aria-label="db2i/mcp route mark"><style>.k{fill:#161716}.s{stroke:#161716}.a{fill:#3159E8}@media (prefers-color-scheme:dark){.k{fill:#ECEBE4}.s{stroke:#ECEBE4}.a{fill:#7D97FF}}</style><circle class="k" cx="3.5" cy="6" r="1.75"/><path class="s" d="M6 6 H11 C12.657 6 14 7.343 14 9 V14 C14 15.657 15.343 17 17 17 H18" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><rect class="a" x="18.5" y="15.5" width="3.5" height="3.5" rx="0.35"/></svg>';

/** The mark on a warm tile with a small radius, for places that show it on any background. */
export const ICON_TILE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256"><rect width="256" height="256" rx="18" fill="#F3F1EB"/><g transform="translate(31.92 33.94) scale(8.0909)"><circle cx="3.5" cy="6" r="1.75" fill="#161716"/><path d="M6 6 H11 C12.657 6 14 7.343 14 9 V14 C14 15.657 15.343 17 17 17 H18" fill="none" stroke="#161716" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><rect x="18.5" y="15.5" width="3.5" height="3.5" rx="0.35" fill="#3159E8"/></g></svg>';

/** ICON_TILE_SVG as a 256 x 256 PNG. */
export const ICON_PNG = Buffer.from(
  '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',
  'base64'
);

/** ICON_TILE_SVG at 16, 32 and 48 px, as PNG frames in an ICO file. */
export const FAVICON_ICO = Buffer.from(
  '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',
  'base64'
);

/**
 * Icons for the MCP server info, which clients such as connector lists show
 * next to the server name. With a public origin (MCP_PUBLIC_URL), they point at
 * the icons the HTTP transport serves; otherwise the SVG goes inline as a data URI.
 *
 * @param publicUrl - External origin of the server, if known
 */
export function serverIcons(publicUrl: string | undefined = process.env.MCP_PUBLIC_URL): Icon[] {
  const origin = publicOrigin(publicUrl);
  if (origin) {
    return [
      { src: `${origin}/icon.png`, mimeType: 'image/png', sizes: ['256x256'] },
      { src: `${origin}/icon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] },
    ];
  }
  return [
    {
      src: `data:image/svg+xml;base64,${Buffer.from(ICON_TILE_SVG, 'utf8').toString('base64')}`,
      mimeType: 'image/svg+xml',
      sizes: ['any'],
    },
  ];
}

/** The origin of a public URL, when it is https (or http on loopback). */
function publicOrigin(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
      return url.origin;
    }
  } catch {
    // Not a URL: fall back to the inline icon
  }
  return undefined;
}
