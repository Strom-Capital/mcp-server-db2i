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
 * The db2i/mcp lockup (docs/assets/brand/svg/lockup-primary.svg): the route mark and the
 * outlined wordmark, as SVG content for a viewBox of LOCKUP_VIEWBOX. Ink follows the text
 * color and the end node uses --accent. Regenerate it when the brand files change.
 */
export const LOCKUP_VIEWBOX = '0 0 184.2 30.72';

export const LOCKUP_SHAPES =
  '<g transform="translate(0 26.07)"><g transform="translate(-1.01 -28.60) scale(1.35)"><circle fill="currentColo' +
  'r" cx="3.55" cy="6.6" r="2.8"/><path stroke="currentColor" d="M8.5 6.6 H10.05 C11.43 6.6 12.55 7.72 12.55 9.1 ' +
  'V15.1 C12.55 16.48 13.67 17.6 15.05 17.6 H16" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-lin' +
  'ejoin="round"/><rect style="fill:var(--accent,#3159E8)" x="18.15" y="15.05" width="5.1" height="5.1" rx="0.42"' +
  '/></g><path d="M60.88 0.37Q58.77 0.37 57.22 -0.68Q55.67 -1.74 54.83 -3.67Q54 -5.61 54 -8.25Q54 -10.88 54.83 -1' +
  '2.82Q55.67 -14.76 57.22 -15.81Q58.77 -16.86 60.88 -16.86Q62.58 -16.86 63.92 -16.15Q65.25 -15.44 65.93 -14.17V-' +
  '22.01H69.22V0H66.15L66.06 -2.48Q65.37 -1.12 63.99 -0.37Q62.62 0.37 60.88 0.37ZM61.75 -2.48Q63.76 -2.48 64.85 -' +
  '4Q65.93 -5.52 65.93 -8.25Q65.93 -11.01 64.85 -12.51Q63.76 -14.01 61.75 -14.01Q59.76 -14.01 58.59 -12.48Q57.41 ' +
  '-10.94 57.41 -8.25Q57.41 -5.61 58.59 -4.05Q59.76 -2.48 61.75 -2.48ZM81.31 0.37Q79.57 0.37 78.25 -0.37Q76.94 -1' +
  '.12 76.25 -2.48L76.16 0H73.09V-22.01H76.38V-14.17Q77 -15.25 78.3 -16.06Q79.6 -16.86 81.31 -16.86Q83.45 -16.86 ' +
  '85.03 -15.81Q86.61 -14.76 87.46 -12.82Q88.31 -10.88 88.31 -8.25Q88.31 -5.61 87.46 -3.67Q86.61 -1.74 85.03 -0.6' +
  '8Q83.45 0.37 81.31 0.37ZM80.78 -2.48Q82.67 -2.48 83.79 -4.03Q84.9 -5.58 84.9 -8.25Q84.9 -10.97 83.8 -12.49Q82.' +
  '7 -14.01 80.81 -14.01Q78.73 -14.01 77.56 -12.49Q76.38 -10.97 76.38 -8.25Q76.38 -5.58 77.54 -4.03Q78.7 -2.48 80' +
  '.78 -2.48ZM90.67 0Q90.67 -2.48 91.41 -4.43Q92.16 -6.39 93.96 -8.06Q95.75 -9.73 98.92 -11.41Q100.44 -12.18 101.' +
  '35 -12.83Q102.26 -13.48 102.67 -14.21Q103.07 -14.94 103.07 -15.96Q103.07 -17.52 102.08 -18.48Q101.09 -19.44 99' +
  '.1 -19.44Q96.99 -19.44 95.77 -18.31Q94.55 -17.17 94.24 -15.07L90.76 -15.28Q91.14 -18.63 93.27 -20.57Q95.41 -22' +
  '.51 99.1 -22.51Q102.64 -22.51 104.59 -20.71Q106.54 -18.91 106.54 -16.03Q106.54 -14.35 105.98 -13.14Q105.43 -11' +
  '.94 104.12 -10.9Q102.82 -9.86 100.59 -8.68Q97.74 -7.16 96.28 -5.67Q94.82 -4.18 94.73 -3.07H106.54V0ZM109.92 0V' +
  '-16.49H113.21V0ZM109.86 -18.88V-22.16H113.27V-18.88ZM125.65 0V-16.49H128.65L128.71 -13.67Q129.33 -15.16 130.54' +
  ' -16.01Q131.75 -16.86 133.3 -16.86Q135.13 -16.86 136.39 -15.96Q137.64 -15.07 138.17 -13.45Q138.73 -15.1 139.95' +
  ' -15.98Q141.18 -16.86 142.94 -16.86Q145.55 -16.86 146.97 -15.24Q148.4 -13.61 148.4 -10.6V0H145.11V-9.8Q145.11 ' +
  '-14.11 141.98 -14.11Q140.43 -14.11 139.5 -12.93Q138.57 -11.75 138.57 -9.67V0H135.44V-9.67Q135.44 -11.75 134.74' +
  ' -12.93Q134.05 -14.11 132.37 -14.11Q130.79 -14.11 129.86 -12.93Q128.93 -11.75 128.93 -9.67V0ZM159.09 0.37Q156.' +
  '74 0.37 154.97 -0.7Q153.2 -1.77 152.24 -3.7Q151.28 -5.64 151.28 -8.25Q151.28 -10.85 152.24 -12.79Q153.2 -14.72' +
  ' 154.97 -15.79Q156.74 -16.86 159.09 -16.86Q162.1 -16.86 164.09 -15.3Q166.07 -13.73 166.47 -10.88L163.03 -10.7Q' +
  '162.78 -12.31 161.73 -13.16Q160.68 -14.01 159.09 -14.01Q157.02 -14.01 155.86 -12.48Q154.69 -10.94 154.69 -8.25' +
  'Q154.69 -5.52 155.86 -4Q157.02 -2.48 159.09 -2.48Q160.68 -2.48 161.73 -3.36Q162.78 -4.25 163.03 -6.04L166.47 -' +
  '5.86Q166.07 -3.01 164.1 -1.32Q162.13 0.37 159.09 0.37ZM168.98 4.65V-16.49H172.08L172.15 -13.98Q172.86 -15.41 1' +
  '74.18 -16.14Q175.49 -16.86 177.14 -16.86Q179.55 -16.86 181.12 -15.67Q182.69 -14.48 183.45 -12.52Q184.2 -10.57 ' +
  '184.2 -8.25Q184.2 -5.92 183.45 -3.97Q182.69 -2.02 181.12 -0.82Q179.55 0.37 177.14 0.37Q175.56 0.37 174.25 -0.3' +
  '3Q172.95 -1.02 172.27 -2.23V4.65ZM176.55 -2.48Q178.53 -2.48 179.66 -4Q180.79 -5.52 180.79 -8.25Q180.79 -10.97 ' +
  '179.66 -12.49Q178.53 -14.01 176.55 -14.01Q174.56 -14.01 173.42 -12.55Q172.27 -11.1 172.27 -8.25Q172.27 -5.39 1' +
  '73.42 -3.94Q174.56 -2.48 176.55 -2.48Z" fill="currentColor"/><path d="M115.40 4.23 L125.26 -26.07" stroke="cur' +
  'rentColor" stroke-width="2.54"/></g>';

/** Favicon for browser tabs: the 16 px pixel drawing (exact at 16 and 32 px). Its own style switches the colors for dark browser chrome. */
export const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" role="img" aria-label="db2i/mcp route mark"><style>.k{fill:#161716}.s{stroke:#161716}.a{fill:#3159E8}@media (prefers-color-scheme:dark){.k{fill:#ECEBE4}.s{stroke:#ECEBE4}.a{fill:#7D97FF}}</style><g shape-rendering="crispEdges"><rect class="k" x="1" y="1" width="4" height="1"/><rect class="k" x="1" y="2" width="4" height="1"/><rect class="k" x="0" y="3" width="6" height="1"/><rect class="k" x="0" y="4" width="6" height="1"/><rect class="k" x="1" y="5" width="4" height="1"/><rect class="k" x="1" y="6" width="4" height="1"/><rect class="k" x="0" y="2" width="1" height="1" fill-opacity="0.5"/><rect class="k" x="5" y="2" width="1" height="1" fill-opacity="0.5"/><rect class="k" x="0" y="5" width="1" height="1" fill-opacity="0.5"/><rect class="k" x="5" y="5" width="1" height="1" fill-opacity="0.5"/></g><path class="s" d="M7 4 H9 V12 H11" fill="none" stroke-width="2" stroke-linecap="butt" stroke-linejoin="round"/><rect class="a" x="12" y="10" width="4" height="4"/></svg>';

/** The mark on a warm tile with a small radius, for places that show it on any background. */
export const ICON_TILE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256"><rect width="256" height="256" rx="18" fill="#F3F1EB"/><g transform="translate(40.62 40.80) scale(7.2818)"><circle fill="#161716" cx="3.55" cy="6.6" r="2.8"/><path stroke="#161716" d="M8.5 6.6 H10.05 C11.43 6.6 12.55 7.72 12.55 9.1 V15.1 C12.55 16.48 13.67 17.6 15.05 17.6 H16" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><rect fill="#3159E8" x="18.15" y="15.05" width="5.1" height="5.1" rx="0.42"/></g></svg>';

/** ICON_TILE_SVG as a 256 x 256 PNG. */
export const ICON_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAAABmJLR0QA/wD/AP+gvaeTAAAQsklEQVR4nO3deXRU9d3H8c9vFiAk' +
  'k0UwIawJi1gPovTRKluirUhAZFXcK8giVFHKJu6IuPQc9BFkKSD66ONTpVBFZXVBCqLiUgERsIWALCGBgMkkYQaSzO/5I9ICxmTm' +
  'Zub+ZvL9vM7hHEjm3t/3D+47M3fuzSiEqLj4SHsHHL0B3R3AhQDaAPAAcIe6LyKyrBzQXkDtB7ALUJ9U6sq1yclpe0LZiQrmQVpr' +
  'V5m38CYNfQ+guloal4hsoD5V0HPjE5suUUpV1vro2h5QWnwkR0PNBtAhLPMRkR2+V9pxX0Jyk/dretAvBkDn5TUua+yerRVGhH82' +
  'IrKFwqIEj/9+pVr5qv92NUpK8lMRcK4G8OuIDkdEEaeBr5Sjoq/Hk3703O/9LAA/HfwbAHS0ZToissP3cFT0PDcCjjP/ofPyGv/0' +
  'k58HP1H90lEHXKu03tvozC+eFYCyxu7Z4NN+onpJAZeVliS8cM7XqpQWHbtWq8Ba+8ciIjs5oPvGJ6Wurvo7qt7n1yowx+xYRGSH' +
  'ANTzWmsn8FMAyrzHbgbf5yeS4sJSb+GNwOlnAAjcY3YeIrLZvQCgqq7tV/8yPQ0R2UpX6sp2jqobe4hIGOWE81rHT3f1EZE0Cj0d' +
  'AH5leg4iMuJCB6BbmZ6CiIxo7QCUx/QURGREogNAA9NTEJERDR21P4aI6isGgEgwBoBIMAaASDAGgEgwBoBIMAaASDAGgEgwBoBI' +
  'MAaASDAGgEgwBoBIMAaASDAGgEgwBoBIMAaASDAGgEgwBoBIMAaASDAGgEgwBoBIMAaASDAGgEgwBoBIMAaASDAGgEgwBoBIMAaA' +
  'SDAGgEgwBoBIMAaASDAGgEgwBoBIMAaASDAGgEgwBoBIMAaASDAGgEgwBoBIMAaASDAGgEgwBoBIMAaASDAGgEgwBoBIMAaASDAG' +
  'gEgwBoBIMAaASDCX6QFMOXDgIHbn5uKHH/bD5zuBEm8ZkpI9iIuLQ0abDLRv3xbN09NNj0kUUWICUFlZiY2bPsWqlWvwyaefoqDg' +
  'SK3btGjeHN17dMWA6/vhN5dfBoeDT5ioflElxUe16SEiyef3Y8mSZXhp8Ss4nJ9veT+tW7fCmNEjMXjQALjd7jBOSGROvQ7A++9/' +
  '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' +
  'LroInS66yPQoZBFfAhAJxgAQCcYAEAnGABAJxgAQCcYAEAnGABAJxgBQTHG5o+924QZu0xNYxwBQTGmTBsQ1ND3F2S7MiL4oBYsB' +
  'oJjSwA2Mv1khWn5twHlJwJiBsXsY8YNBKCblHtLY/J1Gcam5n74tUoHsLkBifOw+A2AAiASL3ecuRFRnDACRYAwAkWAMAJFgDACR' +
  'YAwAkWAMAJFgDACRYAwAkWAMAJFgDACRYAwAkWAMAJFgDACRYAwAkWAMAJFgDACRYAwAkWAMAJFgDACRYAwAkWAMAJFgDACRYAwA' +
  'kWAMAJFgDACRYAwAkWAMAJFgDACRYAwAkWAMAJFgDACRYAwAkWAMAJFgDACRYAwAkWAMAJFgDACRYAwAkWAMAJFgDACRYAwAkWAM' +
  'AJFgDACRYAwAkWAMAJFgDACRYAwAkWAMAJFgDgCnTA9BREacdAC6xPQURGSE1wGoA6anICIj9jsA7DA9BRHZTwM7HYDaZHoQIrKf' +
  '0vjEUakr1wLQpochIlvpCl2x1pGcnLYH0J+bnoaIbLUpJSV9nwMAFNQc09MQkY20fhEAVNXftbPUW/gdgI5GhyIiO+xISGzaWSlV' +
  'WfUMQKlKpR3jTE9FRDbQapxSqhI441LghOQmH0BhkbmpiMgG8z3JTded/oc68ztaH4gr8TbaoIDL7J+LiCJJAZvjE0uvUirTf/pr' +
  'Z90MpFQrn3JU9AXwve3TEVEk7Qqo8n5nHvxANXcDejzpR+Go6KmBL+2bjYgiRQGb4ajISkxsXnju96q9HdjjST/qSfRnQ2FB5Mcj' +
  'ogiaH59YepXHk360um+q6r54ptKiwmu00i8CuDDsoxFRpOyAVuPOPOFXnVoDAFRdJ1DmLRyqgXsAdAt2OyKylQawCVrPSUg6f6lS' +
  'KlDbBiEfyEVF+ZlOOK+FQk8AvwJ0G0B5ADSwMDARWXMKgBfADwB2QWNjha5Ym5KSvi+Unfw/rE9IBUUaCxUAAAAASUVORK5CYII=',
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
