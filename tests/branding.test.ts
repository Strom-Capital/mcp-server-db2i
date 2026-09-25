/**
 * Project icon: the MCP server info icons and the raster files the HTTP transport serves.
 */

import { describe, expect, it } from 'vitest';

import { FAVICON_ICO, ICON_PNG, ICON_TILE_SVG, serverIcons } from '../src/branding.js';

describe('serverIcons', () => {
  it('points at the served icons under a public https origin', () => {
    expect(serverIcons('https://mcp.example.com/')).toEqual([
      { src: 'https://mcp.example.com/icon.png', mimeType: 'image/png', sizes: ['256x256'] },
      { src: 'https://mcp.example.com/icon.svg', mimeType: 'image/svg+xml', sizes: ['any'] },
    ]);
    expect(serverIcons('http://localhost:3000')[0].src).toBe('http://localhost:3000/icon.png');
  });

  it('inlines the SVG without a usable public URL', () => {
    for (const value of [undefined, '', 'not a url', 'http://mcp.example.com']) {
      const [icon] = serverIcons(value);
      expect(icon.src.startsWith('data:image/svg+xml;base64,')).toBe(true);
      expect(Buffer.from(icon.src.split(',')[1], 'base64').toString('utf8')).toBe(ICON_TILE_SVG);
    }
  });
});

describe('icon files', () => {
  it('are a real PNG and an ICO with PNG frames', () => {
    expect(ICON_PNG.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // ICONDIR: reserved 0, type 1 (icon), 3 images
    expect(FAVICON_ICO.readUInt16LE(0)).toBe(0);
    expect(FAVICON_ICO.readUInt16LE(2)).toBe(1);
    expect(FAVICON_ICO.readUInt16LE(4)).toBe(3);
  });
});
