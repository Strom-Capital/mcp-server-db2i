/**
 * Project logo for the sign-in pages, the favicon and the MCP server icon.
 *
 * The mark is the db2i/mcp route mark from docs/assets/brand (a 24 x 24 grid).
 * The raster icons are the mark on a warm tile, so they stay visible on light
 * and dark backgrounds. They were rendered from docs/assets/brand/svg/icon-tile.svg:
 *
 *   rsvg-convert -w 256 -h 256 icon-tile.svg -o icon.png
 *   16 and 32 px ICO frames use the pixel drawings (mark-16.svg, mark-32.svg) on a warm square;
 *   48 px uses icon-tile.svg. Rebuild all of them with the brand build script.
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
  '<circle cx="3.25" cy="6.6" r="2.3" fill="currentColor"/>' +
  '<path d="M7.7 6.6 H10.75 C12.13 6.6 13.25 7.72 13.25 9.1 V15.1 C13.25 16.48 14.37 17.6 15.75 17.6 H16.7" fill="none" ' +
  'stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<rect x="18.85" y="15.5" width="4.2" height="4.2" rx="0.35" style="fill:var(--accent,#3159E8)"/>';

/** Favicon for browser tabs: the 16 px pixel drawing (exact at 16 and 32 px). Its own style switches the colors for dark browser chrome. */
export const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" role="img" aria-label="db2i/mcp route mark"><style>.k{fill:#161716}.s{stroke:#161716}.a{fill:#3159E8}@media (prefers-color-scheme:dark){.k{fill:#ECEBE4}.s{stroke:#ECEBE4}.a{fill:#7D97FF}}</style><g shape-rendering="crispEdges"><rect class="k" x="2" y="2" width="2" height="1"/><rect class="k" x="1" y="3" width="4" height="2"/><rect class="k" x="2" y="5" width="2" height="1"/><rect class="k" x="1" y="2" width="1" height="1" fill-opacity="0.4"/><rect class="k" x="4" y="2" width="1" height="1" fill-opacity="0.4"/><rect class="k" x="1" y="5" width="1" height="1" fill-opacity="0.4"/><rect class="k" x="4" y="5" width="1" height="1" fill-opacity="0.4"/></g><path class="s" d="M6 4 H8 V12 H10" fill="none" stroke-width="2" stroke-linecap="butt" stroke-linejoin="round"/><rect class="a" x="11" y="10" width="4" height="4"/></svg>';

/** The mark on a warm tile with a small radius, for places that show it on any background. */
export const ICON_TILE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256"><rect width="256" height="256" rx="18" fill="#F3F1EB"/><g transform="translate(39.04 39.04) scale(7.4136)"><circle fill="#161716" cx="3.25" cy="6.6" r="2.3"/><path stroke="#161716" d="M7.7 6.6 H10.75 C12.13 6.6 13.25 7.72 13.25 9.1 V15.1 C13.25 16.48 14.37 17.6 15.75 17.6 H16.7" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><rect fill="#3159E8" x="18.85" y="15.5" width="4.2" height="4.2" rx="0.35"/></g></svg>';

/** ICON_TILE_SVG as a 256 x 256 PNG. */
export const ICON_PNG = Buffer.from(
  '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',
  'base64'
);

/** The pixel marks at 16 and 32 px and ICON_TILE_SVG at 48 px, as PNG frames in an ICO file. */
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
