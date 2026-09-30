/**
 * Company branding for the OAuth sign-in page, read once at startup.
 *
 * - MCP_OAUTH_BRAND_NAME: name shown in the header and the tab title
 * - MCP_OAUTH_LOGO: SVG or PNG file for the header, inlined as a data: URI
 * - MCP_OAUTH_TITLE: page heading, for every language
 * - MCP_OAUTH_SYSTEM_LABEL: label above the system picker, for every language
 * - MCP_OAUTH_ACCENT, MCP_OAUTH_ACCENT_DARK: button and focus color
 * - MCP_OAUTH_FONT_FAMILY: CSS font stack for the page text
 * - MCP_OAUTH_FONT_FILE: WOFF2 font for the page text, inlined as a data: URI
 *
 * Every value is checked here, so the page can only change in the ways listed:
 * no remote URLs, no markup in text, no CSS beyond a color or a font stack.
 */

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

const MAX_NAME_LENGTH = 60;
const MAX_TITLE_LENGTH = 80;
const MAX_SYSTEM_LABEL_LENGTH = 40;
const MAX_FONT_FAMILY_LENGTH = 200;
const MAX_LOGO_BYTES = 64 * 1024;
const MAX_FONT_BYTES = 200 * 1024;

/** Page backgrounds in light and dark mode, for the contrast warning. Keep in step with PAGE_STYLE in oauth.ts. */
const PAGE_BACKGROUND = { light: '#f3f1eb', dark: '#121312' };
/** Button text on an accent: whichever reads better. Black and white give at least 4.58:1 on any color. */
const ON_ACCENT = { light: '#ffffff', dark: '#000000' };
/** WCAG 2 minimum for large text and UI components. */
const MIN_ACCENT_CONTRAST = 3;

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WOFF2_SIGNATURE = Buffer.from('wOF2', 'latin1');
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** One font name: bare words, or quoted. Letters, digits, spaces, _ and - only. */
const FONT_NAME = String.raw`(?:[\p{L}\p{N} _-]+|"[\p{L}\p{N} _-]+"|'[\p{L}\p{N} _-]+')`;
const FONT_STACK = new RegExp(String.raw`^\s*${FONT_NAME}(?:\s*,\s*${FONT_NAME})*\s*$`, 'u');

/** What an SVG logo may not contain. It is shown as an image, but it is refused rather than trusted. */
const SVG_REFUSALS: [RegExp, string][] = [
  [/<script\b/i, 'a script'],
  [/<foreignObject\b/i, 'foreignObject'],
  [/\son[a-z]+\s*=/i, 'an event attribute'],
  [/<!(?:DOCTYPE|ENTITY)\b/i, 'a DOCTYPE or entity'],
  [/\bhref\s*=\s*(?!["']?#)/i, 'an external reference'],
  [/url\(\s*(?!["']?#)/i, 'an external reference'],
  [/@import\b/i, 'an external reference'],
  [/javascript:/i, 'a javascript: URL'],
];

/** An accent color with the button text color that reads on it. */
export interface Accent {
  color: string;
  onAccent: string;
}

/** Sign-in page branding. Every field is optional; unset keeps the default look. */
export interface SignInBranding {
  name?: string;
  /** data: URI of the logo */
  logo?: string;
  title?: string;
  systemLabel?: string;
  accent?: Accent;
  accentDark?: Accent;
  fontFamily?: string;
  /** data: URI of a WOFF2 font */
  fontFile?: string;
}

function readText(variable: string, maxLength: number): string | undefined {
  const value = process.env[variable]?.trim();
  if (!value) {
    return undefined;
  }
  if (value.length > maxLength) {
    throw new Error(`${variable} is longer than ${maxLength} characters`);
  }
  if (CONTROL_CHARS.test(value)) {
    throw new Error(`${variable} has a control character`);
  }
  return value;
}

function readFile(variable: string, file: string, maxBytes: number): Buffer {
  let data: Buffer;
  try {
    data = readFileSync(file);
  } catch (error) {
    throw new Error(`${variable} (${file}): ${error instanceof Error ? error.message : 'Could not read file'}`, { cause: error });
  }
  if (data.length > maxBytes) {
    throw new Error(`${variable} (${file}): the file is larger than ${maxBytes / 1024} KB`);
  }
  return data;
}

function readLogo(): string | undefined {
  const file = process.env.MCP_OAUTH_LOGO?.trim();
  if (!file) {
    return undefined;
  }
  const type = extname(file).toLowerCase();
  if (type !== '.svg' && type !== '.png') {
    throw new Error(`MCP_OAUTH_LOGO (${file}): the logo must be an .svg or .png file`);
  }
  const data = readFile('MCP_OAUTH_LOGO', file, MAX_LOGO_BYTES);
  if (type === '.png') {
    if (!data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new Error(`MCP_OAUTH_LOGO (${file}): not a PNG image`);
    }
    return `data:image/png;base64,${data.toString('base64')}`;
  }
  const svg = data.toString('utf8');
  if (!/<svg\b/i.test(svg)) {
    throw new Error(`MCP_OAUTH_LOGO (${file}): not an SVG image`);
  }
  for (const [pattern, what] of SVG_REFUSALS) {
    if (pattern.test(svg)) {
      throw new Error(`MCP_OAUTH_LOGO (${file}): the SVG has ${what}. Remove it, or use a PNG.`);
    }
  }
  return `data:image/svg+xml;base64,${data.toString('base64')}`;
}

function readFontFile(): string | undefined {
  const file = process.env.MCP_OAUTH_FONT_FILE?.trim();
  if (!file) {
    return undefined;
  }
  if (extname(file).toLowerCase() !== '.woff2') {
    throw new Error(`MCP_OAUTH_FONT_FILE (${file}): the font must be a .woff2 file`);
  }
  const data = readFile('MCP_OAUTH_FONT_FILE', file, MAX_FONT_BYTES);
  if (!data.subarray(0, WOFF2_SIGNATURE.length).equals(WOFF2_SIGNATURE)) {
    throw new Error(`MCP_OAUTH_FONT_FILE (${file}): not a WOFF2 font`);
  }
  return `data:font/woff2;base64,${data.toString('base64')}`;
}

function readFontFamily(): string | undefined {
  const value = process.env.MCP_OAUTH_FONT_FAMILY?.trim();
  if (!value) {
    return undefined;
  }
  if (value.length > MAX_FONT_FAMILY_LENGTH || !FONT_STACK.test(value)) {
    throw new Error(
      'MCP_OAUTH_FONT_FAMILY must be a font stack of names, quotes and commas, such as "Inter", system-ui, sans-serif'
    );
  }
  return value;
}

/** #RGB or #RRGGBB to lowercase #rrggbb. */
function expandHex(color: string): string {
  const hex = color.slice(1).toLowerCase();
  return `#${hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex}`;
}

/** WCAG 2 relative luminance of a #rrggbb color. */
function luminance(color: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = parseInt(color.slice(start, start + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio of two #rrggbb colors, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** An accent color and the button text that reads best on it. */
export function accentFor(color: string): Accent {
  const hex = expandHex(color);
  const onAccent =
    contrastRatio(hex, ON_ACCENT.light) >= contrastRatio(hex, ON_ACCENT.dark) ? ON_ACCENT.light : ON_ACCENT.dark;
  return { color: hex, onAccent };
}

/**
 * Accents with too little contrast against the page background, where focus
 * outlines and the button edge are hard to see. Logged as a warning, not refused.
 */
export function lowContrastAccents(branding: SignInBranding): { mode: 'light' | 'dark'; color: string; contrast: number }[] {
  const accents = [
    ['light', branding.accent],
    ['dark', branding.accentDark],
  ] as const;
  return accents.flatMap(([mode, accent]) => {
    if (!accent) {
      return [];
    }
    const contrast = contrastRatio(accent.color, PAGE_BACKGROUND[mode]);
    return contrast < MIN_ACCENT_CONTRAST ? [{ mode, color: accent.color, contrast: Number(contrast.toFixed(2)) }] : [];
  });
}

function readColor(variable: string): string | undefined {
  const value = process.env[variable]?.trim();
  if (!value) {
    return undefined;
  }
  if (!HEX_COLOR.test(value)) {
    throw new Error(`${variable} must be a color as #RGB or #RRGGBB`);
  }
  return value;
}

/**
 * Read the sign-in page branding.
 *
 * @throws Error when a value is invalid, a file is missing, too large or of the wrong type
 */
export function readSignInBranding(): SignInBranding {
  const accent = readColor('MCP_OAUTH_ACCENT');
  const accentDark = readColor('MCP_OAUTH_ACCENT_DARK') ?? accent;
  const branding: SignInBranding = {
    name: readText('MCP_OAUTH_BRAND_NAME', MAX_NAME_LENGTH),
    logo: readLogo(),
    title: readText('MCP_OAUTH_TITLE', MAX_TITLE_LENGTH),
    systemLabel: readText('MCP_OAUTH_SYSTEM_LABEL', MAX_SYSTEM_LABEL_LENGTH),
    accent: accent ? accentFor(accent) : undefined,
    accentDark: accentDark ? accentFor(accentDark) : undefined,
    fontFamily: readFontFamily(),
    fontFile: readFontFile(),
  };
  return Object.fromEntries(Object.entries(branding).filter(([, value]) => value !== undefined)) as SignInBranding;
}
