/**
 * Project logo for the sign-in pages, the favicon and the MCP server icon.
 *
 * The raster icons are the logo on a light tile, so they stay visible on
 * light and dark backgrounds. They were rendered from ICON_TILE_SVG:
 *
 *   rsvg-convert -w 256 -h 256 icon.svg -o icon.png
 *   rsvg-convert -w 16|32|48 ...        (then packed as PNG frames in favicon.ico)
 */

import type { Icon } from '@modelcontextprotocol/server';

import { isLoopbackHost } from './config.js';

/** Product name as the README heading and the docs site show it. */
export const DISPLAY_NAME = 'Db2 for i MCP Server';

/** Shapes of the project logo (docs/assets/logo.svg). The stroke color is set by each use. */
export const LOGO_SHAPES =
  '<g stroke-width="12" stroke-linecap="round" stroke-linejoin="round">' +
  '<ellipse cx="116" cy="96" rx="54" ry="20"/>' +
  '<path d="M62 96v30c0 11 24 20 54 20s54-9 54-20V96"/>' +
  '<path d="M62 126c0 11 24 20 54 20s54-9 54-20"/>' +
  '<path d="M62 126v30c0 11 24 20 54 20s54-9 54-20v-30"/>' +
  '<path d="M62 156c0 11 24 20 54 20s54-9 54-20"/>' +
  '</g>' +
  '<path d="M184 48C184 62 192 70 206 70C192 70 184 78 184 92C184 78 176 70 162 70C176 70 184 62 184 48Z" fill="#22C55E"/>';

/** Favicon for browser tabs. Its own style switches the stroke for dark browser chrome. */
export const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="none">' +
  '<style>g{stroke:#0F172A}@media (prefers-color-scheme:dark){g{stroke:#E6EDF3}}</style>' +
  LOGO_SHAPES +
  '</svg>';

/** The logo on a light rounded tile, for places that show it on any background. */
export const ICON_TILE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" fill="none">' +
  // Only the logo's own group gets the stroke, not the star next to it
  '<style>g g{stroke:#0F172A}</style>' +
  '<rect width="256" height="256" rx="56" fill="#F8FAFC"/>' +
  '<g transform="translate(6 12)">' +
  LOGO_SHAPES +
  '</g></svg>';

/** ICON_TILE_SVG as a 256 x 256 PNG. */
export const ICON_PNG = Buffer.from(
  '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',
  'base64'
);

/** ICON_TILE_SVG at 16, 32 and 48 px, as PNG frames in an ICO file. */
export const FAVICON_ICO = Buffer.from(
  'AAABAAMAEBAAAAEAIADMAQAANgAAACAgAAABACAAkwMAAAICAAAwMAAAAQAgAEcFAACVBQAAiVBORw0KGgoAAAANSUhEUgAAABAA' +
  'AAAQCAMAAAAoLQ9TAAAA3lBMVEUAAAD4/Pz3+vz4+vz4/Pz5+fz3+vz3+vz4+vz4/Pz4+vz1+fqs6MTa8+XR1NlvdYFKUV9IT15H' +
  'Tl1iZ3SvuryA3KT2+vvl6OswN0fJzdL2+Prc3+JJUF6dqKvb3uEyOkpVW2iJjpibn6iRlZ9ka3g1PUyYnKXN0NUlLT7k5uq2ucGm' +
  'q7OxtbzW2d1UWmdscn0mLj8bIzQ0PEtCSFc7QVEgKDohKTqXnKTf4eQqMkLm6uyyuL6anqisr7jl5+tQV2WLkJptcn4cIzYsM0Mk' +
  'LD0cJDXy9Pbn6ezJzNHf4eU63RkIAAAACnRSTlMATMr5S1DLyfhKeVT+GQAAAJNJREFUGNNjYGBkYuaCAmYmFgYGRi4UwMrAhirA' +
  'zsCM4HADMQcDkiwPL5AAC/DxCwgKCYuI8ohBBMQlJKW4uKRlZLmgKuTkFRSVlFVU1WAC6hqaWto6unr6cBUGhkbGJqZm5jABC0sr' +
  'axtbO3sHmACXo5OZs4ursRtYAOIwdw9PiFs4MJ3OgirAycDAwo7wPjsnAwBjHhGnnw2lTQAAAABJRU5ErkJggolQTkcNChoKAAAA' +
  'DUlIRFIAAAAgAAAAIAgDAAAARKSKxgAAAcVQTFRFAAAA8///9/n7+Pr9+Pr8+Pr99/n7+fn8+Pr8+fn8+Pr8+Pr88///9/n7+Pr9' +
  '+Pr89/n7+Pr88v//+fn8+Pr9+Pr87/j2rejF9fn51fHhOMpvhN6n6+3wsra+fYKNZmx5VlxqTlVjX2RycHWClZqj0dTZ9/n71vLj' +
  'cdmZIsVe5ujrcneDFBwuDxcqFh0wKzJEPENSRUxaNTtMISk7NjxNs7e+8fT2LTRGc3iEwMPJ3eDjoaWtOD9Pl5qjpamy8/X4Fx4x' +
  'JCs9ub3DFBsuv8LI8PP1297hoKSsNj1NNDtLvsHIW2FvFRwvKTBCO0JRREtZNDpLICc5SVBesre+7O7xgIWQZ216YGVzcXaCl5yk' +
  '0dXZMTlHiI2XPkRT9Pb4xcnNEBgrFR0wvMDGFx8xSU9fj5SevsLI3+Hl7vD0ztHWr7O6bHF9LjZHEBcrMjlJGiI0DxcrERkrNz5O' +
  'P0VVr7K7iIyYbXF9WF1sUVhmYWZzeH6JsbS79vj6MDhIJy8/zM7Tdn2HMjlKW2JvHSU3SlBeaW97gIWPiY6ZcXeEXGNwLzdIExou' +
  'GiEzyczRQUdYGSEzKTBBdHqF6ersp6qzmJyntLnA09bavISv1wAAABV0Uk5TABaEz/TOg1XyVP7xFYLQ84HwFFLNV2v85QAAAWhJ' +
  'REFUOMtjYGBgYGRiZhHFACysbIwMYMDOIYoDcHCC5blEcQIuoApGDlE8gJuHgUkUL+Bl4MOvgJWBH78CDgYcEmIwBi4F4hL4FUhK' +
  'SUtgKJCRlZNXUFRSVlFVU9fQlBIXQ1Wgpa2jq6dvYGhkrKtrYiqqIYlmhZm5noWlGZhpZW2ja6uO7kg7XTmEZfYOjqLoCpx0nbVd' +
  'XMFMN3cPXU8MBV663jq6Pr5+/gGBQDfYBGEoCNYNDjENDVNQDI+IjBKNjsZQEKMbGwcXjE9IxFCQpKubnJKalp6RmZWdk6ubh8UN' +
  'SvkFuhBQWFSM6YYS3RLR9NKy8orKquoa0dpaDAXxunX1MLGahoRGDAWiTbq5zS2tbe0dnV3duj31mApEe/v6IY4onDCxRlQUa3qY' +
  'FD95ytRpNSgRz8CBP8lxMzATSrRs+BUIEMg4gkIMDJz4sp4wKHNycuPULwzJ3jy8IliyD7+IANB8BgDCAnpNwHG2BAAAAABJRU5E' +
  'rkJggolQTkcNChoKAAAADUlIRFIAAAAwAAAAMAgDAAAAYNwJtQAAAoJQTFRFAAAA+vr69/n79/r8+Pn8+Pr89/n7+vr6+Pj/+Pv8' +
  '+Pv8+Pj/+Pv7+Pr8+Pr8+Pj8+Pz8+Pz8+Pr8+Pj/+Pv8+Pv8+vr6+Pr89/n7+fr8+Pr8+Pv8+Pv89/n79/n7+fn5+Pv8+Pr8+Pj/' +
  '+Pz8+Pv7+Pj8+Pv8+Pr87vf1turM8fj3P8x01fLi6fbwZdWQIsVeRM131fHh5+nsubzDmJylgYaRcHWCbHJ+dHmFg4iToaWtxcjO' +
  '8PL08vj4zvDdW9OIQMx1uOrN3+Llg4iSOD9PDxcqExstS1Jg7vDzlOGyZtWQ8fT2e4CMFBwuMThJXWJwYmh1X2RyW2FuRUxaKC9B' +
  'ICc5o6ev6fbx9/n7Ji5AfYKNwsTLsra9aG57GCAymZ2mzO/cuLvD8vX35efqVFpnFR0w8/X39Pn5d3yHEBgs4ePmnaKq0tXaIys8' +
  'k5ih6uzv297hd32IERksSVBewMPJzdDW2dzgyc3St7rCm5+oOkFQKTBCGSEzfIKMKi9B7/H0r7O6dXuHR05dEBgrFRwvLDNFU1ln' +
  'hImT9ff5Ymd1ERgr6Ovu3eDjxcjNyMvPaW98Z2x46OzuLzdH1NfcnaGpGCAzYWZzxcnN9Pb4qay1SlBgERotEhotHyc4LzZHQEZX' +
  'QkhXPERTLTNEGyM0DxgroaavExsuQUdYsLS6JCs+8vT2qq63REpZLjVGJCw9Jy8/MjlKSU9fdXuGwMPIeH2I7vD0rLG51djcyczR' +
  'DxcrHiY4rbG49vj6gYeSExouWV5rGiI0iIyY6u7wu77Fdn2HOkJSmp6ohYuVIio7t7vBkpehFx8xDxgqHCM2TFJhsba8tLnAj5Se' +
  'bnWBdHqFen+MmJulj/nAeQAAACd0Uk5TADCFyeb8hC8msK4lSPDyTktJ8SOxrTH+gsfo5eSDgC6q7yJKR02rm8T4PwAAAk1JREFU' +
  'SMdjYAADRiZmFlZ1nICVhZmNnQEBODjViQBc3DD1PLzqRAE+foh6AVZ1IgGrINg9QupEA15hoAYRdRKAKAODGCnq1cXZGZhI0qAu' +
  'wcBMmgZJBinSNEgzsJKmgZWBCEUayBxiNGiSqEFLW4ckDbp6+gaG+DQYGZuYmpmbW1haWduoq9va2evr6zs4auDQ4OTs4ooAbu4m' +
  'Hurqnvpetjhs8PbxBSnzc/cPCAwKDgHpCQ1TV7cPx+GHiEBX18ioaBu442Ji41xd49UTcIVSoqurcxKqE5NTXFPT0nFpyHDNzEIP' +
  'gmxX1xx1XBpMXF1z8/KRZQsK3VxdC3BqsHItcnX1LY4KKyktKyuvqDSrAocVPg3VZjWuKCCyFr+GOvX6hsamyGaQ2pbWtvbojgJ8' +
  'GjpduyCMpO6erO4IMLPX1bUPp4Z+V9cJaIE0cZKr62ScGqYAHTJ12nQ4f8bMWbMJeHoOyPFFc+fNX7Bg4aLFS1wJhlLr0nnNyIG0' +
  'bPkKfBoqXVeqq69aPWHN2nWhoes3bNy0GRh1+DRscS3aip40trm6bsepYcdO1127UWT37N3n2qKOU4P6fqCzD8w6uGMViHPo8JGj' +
  'wJTkegyPBvXjqRDPNs+ZDfX8iZPq+DSo7zl19DQ8jM6cPXceI8tjKTUOXbh45NLlK1enr8JWiJBeVLKQpkGG9OJeljQNcgyMpFVZ' +
  '8gwMXKRoUADWoty8xKtXVAJV1MrEV+w8kKaAiiKRTQdVWGNDWFScCP+qKSG1Z9hlJaXxNX+kJSXkISoBuWOqzNTEvCwAAAAASUVO' +
  'RK5CYII=',
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
