/**
 * OAuth sign-in page settings: languages, strings files and company branding.
 * The rendered page is covered in oauth.test.ts.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  accentFor,
  contrastRatio,
  lowContrastAccents,
  readSignInBranding,
} from '../src/auth/signInBranding.js';
import {
  BUILT_IN_SIGN_IN_STRINGS,
  checkSignInString,
  ENGLISH_SIGN_IN_STRINGS,
  MAX_SIGN_IN_STRING_LENGTH,
  pickSignInLanguage,
  placeholdersOf,
  readSignInText,
  type SignInStringKey,
} from '../src/auth/signInStrings.js';

const PAGE_VARIABLES = [
  'MCP_OAUTH_LANGUAGE',
  'MCP_OAUTH_STRINGS',
  'MCP_OAUTH_BRAND_NAME',
  'MCP_OAUTH_LOGO',
  'MCP_OAUTH_TITLE',
  'MCP_OAUTH_SYSTEM_LABEL',
  'MCP_OAUTH_ACCENT',
  'MCP_OAUTH_ACCENT_DARK',
  'MCP_OAUTH_FONT_FAMILY',
  'MCP_OAUTH_FONT_FILE',
];

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const WOFF2 = Buffer.concat([Buffer.from('wOF2', 'latin1'), Buffer.alloc(40)]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#0f6e4b"/></svg>';

const originalEnv = process.env;
let dir: string;

function file(name: string, contents: string | Buffer): string {
  const target = path.join(dir, name);
  writeFileSync(target, contents);
  return target;
}

function strings(doc: unknown): void {
  process.env.MCP_OAUTH_STRINGS = file('strings.json', JSON.stringify(doc));
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'db2i-sign-in-'));
  process.env = { ...originalEnv };
  for (const name of PAGE_VARIABLES) {
    delete process.env[name];
  }
});

afterEach(() => {
  process.env = originalEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe('built-in languages', () => {
  const keys = Object.keys(ENGLISH_SIGN_IN_STRINGS).sort();

  it.each(Object.entries(BUILT_IN_SIGN_IN_STRINGS))('%s has every string, each valid', (_language, builtIn) => {
    expect(Object.keys(builtIn).sort()).toEqual(keys);
    for (const [key, value] of Object.entries(builtIn)) {
      expect(checkSignInString(key as SignInStringKey, value), key).toBeUndefined();
    }
  });

  it('lists every English string in docs/customization.md', () => {
    const docs = readFileSync(path.join(import.meta.dirname, '..', 'docs', 'customization.md'), 'utf8');
    for (const [key, value] of Object.entries(ENGLISH_SIGN_IN_STRINGS)) {
      expect(docs, key).toContain(`| \`${key}\` | ${value} |`);
    }
  });

  it('ships English and Finnish', () => {
    expect(Object.keys(BUILT_IN_SIGN_IN_STRINGS)).toEqual(expect.arrayContaining(['en', 'fi']));
  });
});

describe('checkSignInString', () => {
  it('requires the same placeholders as English', () => {
    expect(placeholdersOf(ENGLISH_SIGN_IN_STRINGS.intro)).toEqual(['client', 'returnTo']);
    expect(checkSignInString('intro', '{client} wants in; back to {returnTo}.')).toBeUndefined();
    expect(checkSignInString('intro', '{client} wants in.')).toMatch(/placeholders \{client\}, \{returnTo\}/);
    expect(checkSignInString('userLabel', 'User {client}')).toMatch(/placeholders none/);
  });

  it('refuses empty, over-long and control characters', () => {
    expect(checkSignInString('userLabel', ' ')).toMatch(/non-empty/);
    expect(checkSignInString('userLabel', 7)).toMatch(/non-empty/);
    expect(checkSignInString('userLabel', 'x'.repeat(MAX_SIGN_IN_STRING_LENGTH + 1))).toMatch(/longer than/);
    expect(checkSignInString('userLabel', 'User\nname')).toMatch(/control character/);
  });
});

describe('readSignInText', () => {
  it('defaults to English', () => {
    const text = readSignInText();
    expect(text.language).toBe('en');
    expect(text.languages.en).toEqual(ENGLISH_SIGN_IN_STRINGS);
    expect(text.languages.fi.userLabel).toBe('Käyttäjänimi');
  });

  it('accepts a built-in language, auto, and refuses one without strings', () => {
    process.env.MCP_OAUTH_LANGUAGE = 'FI';
    expect(readSignInText().language).toBe('fi');
    process.env.MCP_OAUTH_LANGUAGE = 'auto';
    expect(readSignInText().language).toBe('auto');
    process.env.MCP_OAUTH_LANGUAGE = 'sv';
    expect(() => readSignInText()).toThrow(/MCP_OAUTH_LANGUAGE has no strings for that language. Use auto or one of: en, fi/);
  });

  it('overrides only the keys a strings file sets, and adds its languages', () => {
    strings({ fi: { systemLabel: 'Yritys' }, sv: { heading: 'Logga in', userLabel: 'Användare' } });
    process.env.MCP_OAUTH_LANGUAGE = 'sv';
    const text = readSignInText();
    expect(text.language).toBe('sv');
    expect(text.languages.fi.systemLabel).toBe('Yritys');
    expect(text.languages.fi.passwordLabel).toBe('Salasana');
    expect(text.languages.sv.heading).toBe('Logga in');
    // A language the server does not ship falls back to English for the rest
    expect(text.languages.sv.submit).toBe('Sign in');
    expect(text.languages.en).toEqual(ENGLISH_SIGN_IN_STRINGS);
  });

  it('applies overrides for every language, below the strings file', () => {
    strings({ fi: { heading: 'Kirjaudu Acme ERP:hen' } });
    const text = readSignInText({ heading: 'Sign in to Acme ERP', systemLabel: 'Country' });
    expect(text.languages.en.heading).toBe('Sign in to Acme ERP');
    expect(text.languages.en.systemLabel).toBe('Country');
    expect(text.languages.fi.heading).toBe('Kirjaudu Acme ERP:hen');
    expect(text.languages.fi.systemLabel).toBe('Country');
  });

  it.each([
    ['invalid JSON', '{ "fi": ', /not valid JSON/],
    ['an array', '[]', /must be an object of languages/],
    ['a bad language code', JSON.stringify({ 'not a tag': {} }), /is not a language code/],
    ['a language that is not an object', JSON.stringify({ fi: 'Kirjaudu' }), /fi must be an object of strings/],
    ['an unknown key', JSON.stringify({ fi: { headline: 'x' } }), /fi.headline is not a sign-in page string/],
    ['an over-long value', JSON.stringify({ fi: { note: 'x'.repeat(201) } }), /fi.note is longer than 200/],
    ['a missing placeholder', JSON.stringify({ fi: { errorRateLimited: 'Odota.' } }), /must use the placeholders \{seconds\}/],
  ])('refuses a strings file with %s', (_case, contents, error) => {
    process.env.MCP_OAUTH_STRINGS = file('strings.json', contents);
    expect(() => readSignInText()).toThrow(error);
  });

  it('refuses a missing strings file', () => {
    process.env.MCP_OAUTH_STRINGS = path.join(dir, 'missing.json');
    expect(() => readSignInText()).toThrow('MCP_OAUTH_STRINGS: the file could not be read');
  });

  it('keeps file paths and values out of error messages', () => {
    const secretPath = path.join(dir, 'private-name', 'strings.json');
    process.env.MCP_OAUTH_STRINGS = secretPath;
    expect(() => readSignInText()).toThrow(expect.objectContaining({ message: expect.not.stringContaining('private-name') }));
    delete process.env.MCP_OAUTH_STRINGS;
    process.env.MCP_OAUTH_LANGUAGE = 'private-name';
    expect(() => readSignInText()).toThrow(expect.objectContaining({ message: expect.not.stringContaining('private-name') }));
    delete process.env.MCP_OAUTH_LANGUAGE;
    process.env.MCP_OAUTH_LOGO = path.join(dir, 'private-name.svg');
    expect(() => readSignInBranding()).toThrow(expect.objectContaining({ message: expect.not.stringContaining('private-name') }));
  });
});

describe('pickSignInLanguage', () => {
  const auto = { language: 'auto', languages: { en: ENGLISH_SIGN_IN_STRINGS, fi: ENGLISH_SIGN_IN_STRINGS, 'sv-fi': ENGLISH_SIGN_IN_STRINGS } };

  it('keeps a fixed language whatever the browser asks for', () => {
    expect(pickSignInLanguage({ ...auto, language: 'fi' }, 'en-US,en;q=0.9')).toBe('fi');
  });

  it.each([
    ['fi-FI,fi;q=0.9,en;q=0.8', 'fi'],
    ['de-DE,de;q=0.9', 'en'],
    ['de;q=0.9,fi;q=0.5', 'fi'],
    ['en;q=0.5,fi', 'fi'],
    ['sv-FI', 'sv-fi'],
    ['sv', 'sv-fi'],
    ['fi;q=0', 'en'],
    ['*', 'en'],
    ['', 'en'],
    [undefined, 'en'],
  ])('with auto, %s picks %s', (header, expected) => {
    expect(pickSignInLanguage(auto, header)).toBe(expected);
  });
});

describe('readSignInBranding', () => {
  it('is empty when nothing is set', () => {
    expect(readSignInBranding()).toEqual({});
  });

  it('reads every setting', () => {
    process.env.MCP_OAUTH_BRAND_NAME = ' Acme Oy ';
    process.env.MCP_OAUTH_TITLE = 'Sign in to Acme ERP';
    process.env.MCP_OAUTH_SYSTEM_LABEL = 'Country';
    process.env.MCP_OAUTH_LOGO = file('logo.svg', SVG);
    process.env.MCP_OAUTH_ACCENT = '#0F6E4B';
    process.env.MCP_OAUTH_FONT_FAMILY = '"Inter", system-ui, sans-serif';
    process.env.MCP_OAUTH_FONT_FILE = file('brand.woff2', WOFF2);
    const branding = readSignInBranding();
    expect(branding.name).toBe('Acme Oy');
    expect(branding.title).toBe('Sign in to Acme ERP');
    expect(branding.systemLabel).toBe('Country');
    expect(branding.logo).toBe(`data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`);
    expect(branding.accent).toEqual({ color: '#0f6e4b', onAccent: '#ffffff' });
    // The dark accent defaults to the light one
    expect(branding.accentDark).toEqual(branding.accent);
    expect(branding.fontFamily).toBe('"Inter", system-ui, sans-serif');
    expect(branding.fontFile).toMatch(/^data:font\/woff2;base64,/);
  });

  it('accepts a PNG logo', () => {
    process.env.MCP_OAUTH_LOGO = file('logo.PNG', PNG);
    expect(readSignInBranding().logo).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
  });

  it.each([
    ['a script', '<svg><script>alert(1)</script></svg>', /has a script/],
    ['an event attribute', '<svg onload="alert(1)"></svg>', /has an event attribute/],
    ['foreignObject', '<svg><foreignObject><div/></foreignObject></svg>', /has foreignObject/],
    ['an external href', '<svg><image href="https://evil.example.com/x.png"/></svg>', /has an external reference/],
    ['an external xlink:href', '<svg><use xlink:href="other.svg#a"/></svg>', /has an external reference/],
    ['an external url()', '<svg><rect style="fill: url(https://evil.example.com/p)"/></svg>', /has an external reference/],
    ['@import', '<svg><style>@import "https://evil.example.com/a.css";</style></svg>', /has an external reference/],
    ['an entity', '<!DOCTYPE svg [<!ENTITY x "y">]><svg></svg>', /has a DOCTYPE or entity/],
    ['no svg element', '<html></html>', /not an SVG image/],
  ])('refuses an SVG logo with %s', (_case, svg, error) => {
    process.env.MCP_OAUTH_LOGO = file('logo.svg', svg);
    expect(() => readSignInBranding()).toThrow(error);
  });

  it('keeps an SVG logo with internal references', () => {
    process.env.MCP_OAUTH_LOGO = file(
      'logo.svg',
      '<svg><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use href="#g"/></svg>'
    );
    expect(readSignInBranding().logo).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it('refuses a logo of another type, over the size limit or with the wrong content', () => {
    process.env.MCP_OAUTH_LOGO = file('logo.gif', 'GIF89a');
    expect(() => readSignInBranding()).toThrow(/must be an .svg or .png file/);
    process.env.MCP_OAUTH_LOGO = file('big.svg', `<svg>${' '.repeat(64 * 1024)}</svg>`);
    expect(() => readSignInBranding()).toThrow(/larger than 64 KB/);
    process.env.MCP_OAUTH_LOGO = file('fake.png', SVG);
    expect(() => readSignInBranding()).toThrow(/not a PNG image/);
    process.env.MCP_OAUTH_LOGO = path.join(dir, 'missing.svg');
    expect(() => readSignInBranding()).toThrow(/MCP_OAUTH_LOGO/);
  });

  it('refuses a font file that is not WOFF2 or over the size limit', () => {
    process.env.MCP_OAUTH_FONT_FILE = file('brand.ttf', WOFF2);
    expect(() => readSignInBranding()).toThrow(/must be a .woff2 file/);
    process.env.MCP_OAUTH_FONT_FILE = file('fake.woff2', 'wOFF0000');
    expect(() => readSignInBranding()).toThrow(/not a WOFF2 font/);
    process.env.MCP_OAUTH_FONT_FILE = file('big.woff2', Buffer.concat([WOFF2, Buffer.alloc(200 * 1024)]));
    expect(() => readSignInBranding()).toThrow(/larger than 200 KB/);
  });

  it.each([
    'Inter; } body { display: none',
    'Inter</style><script>',
    'url(https://evil.example.com/font.woff2)',
    '"Inter',
    'Inter,,sans-serif',
  ])('refuses the font stack %s', (stack) => {
    process.env.MCP_OAUTH_FONT_FAMILY = stack;
    expect(() => readSignInBranding()).toThrow(/MCP_OAUTH_FONT_FAMILY must be a font stack/);
  });

  it('accepts font stacks with quoted and unicode names', () => {
    process.env.MCP_OAUTH_FONT_FAMILY = "'Noto Sans JP', Hiragino-Sans, ヒラギノ角ゴ, sans-serif";
    expect(readSignInBranding().fontFamily).toBe("'Noto Sans JP', Hiragino-Sans, ヒラギノ角ゴ, sans-serif");
  });

  it.each(['0f6e4b', '#0f6e4', 'green', '#0f6e4bff', 'rgb(0,0,0)'])('refuses the color %s', (color) => {
    process.env.MCP_OAUTH_ACCENT = color;
    expect(() => readSignInBranding()).toThrow(/MCP_OAUTH_ACCENT must be a color/);
  });

  it('refuses over-long text and control characters', () => {
    process.env.MCP_OAUTH_BRAND_NAME = 'x'.repeat(61);
    expect(() => readSignInBranding()).toThrow(/MCP_OAUTH_BRAND_NAME is longer than 60/);
    delete process.env.MCP_OAUTH_BRAND_NAME;
    process.env.MCP_OAUTH_TITLE = 'x'.repeat(81);
    expect(() => readSignInBranding()).toThrow(/MCP_OAUTH_TITLE is longer than 80/);
    process.env.MCP_OAUTH_TITLE = 'Sign\u0007in';
    expect(() => readSignInBranding()).toThrow(/MCP_OAUTH_TITLE has a control character/);
  });
});

describe('accent colors', () => {
  it('picks the button text with the better contrast', () => {
    expect(accentFor('#FC0')).toEqual({ color: '#ffcc00', onAccent: '#000000' });
    expect(accentFor('#003366').onAccent).toBe('#ffffff');
    for (const color of ['#000', '#fff', '#777', '#f00', '#0f0', '#00f', '#ff0', '#808080']) {
      const { color: hex, onAccent } = accentFor(color);
      expect(contrastRatio(hex, onAccent), color).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('flags accents that fade into the page background', () => {
    expect(lowContrastAccents({ accent: accentFor('#0f6e4b'), accentDark: accentFor('#5fd3a0') })).toEqual([]);
    expect(lowContrastAccents({ accent: accentFor('#fff8dc'), accentDark: accentFor('#1a1a1a') })).toEqual([
      expect.objectContaining({ mode: 'light', color: '#fff8dc' }),
      expect.objectContaining({ mode: 'dark', color: '#1a1a1a' }),
    ]);
  });
});
