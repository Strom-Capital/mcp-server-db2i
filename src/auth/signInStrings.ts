/**
 * Text of the OAuth sign-in page, in the languages the server ships and any a
 * strings file adds.
 *
 * - MCP_OAUTH_LANGUAGE: a language code, or `auto` to follow the browser's
 *   Accept-Language. `en` by default.
 * - MCP_OAUTH_STRINGS: a JSON file of `{ "<language>": { "<key>": "<text>" } }`
 *   that overrides built-in strings or adds a language.
 *
 * Strings are plain text. The page escapes them, and fills `{placeholders}`
 * with escaped values from the request, such as the client name.
 */

import { readFileSync } from 'node:fs';

import en from './locales/en.json' with { type: 'json' };
import fi from './locales/fi.json' with { type: 'json' };

export type SignInStringKey = keyof typeof en;
export type SignInStrings = Record<SignInStringKey, string>;

/** Languages the server ships. English is complete by definition; the others are checked by a test. */
export const BUILT_IN_SIGN_IN_STRINGS: Readonly<Record<string, Partial<SignInStrings>>> = { en, fi };

/** English, complete: the base every other language falls back to. */
export const ENGLISH_SIGN_IN_STRINGS: Readonly<SignInStrings> = en;
export const DEFAULT_SIGN_IN_LANGUAGE = 'en';
export const MAX_SIGN_IN_STRING_LENGTH = 200;
const MAX_STRINGS_FILE_BYTES = 64 * 1024;
/** Accept-Language entries looked at, so a long header costs nothing. */
const MAX_ACCEPT_LANGUAGE_ENTRIES = 20;

/** BCP 47 style: a primary language and optional subtags, such as `fi`, `sv-FI` or `pt-BR`. */
const LANGUAGE_TAG = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;
const PLACEHOLDER = /\{([A-Za-z]+)\}/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const KEYS = Object.keys(en) as SignInStringKey[];

/** Sign-in page text for every available language. */
export interface SignInText {
  /** A language code, or `auto` to pick from Accept-Language per request. */
  language: string;
  /** Complete strings per lowercase language code. Always has `en`. */
  languages: Record<string, SignInStrings>;
}

/** Values set for every language, below a strings file (MCP_OAUTH_TITLE, MCP_OAUTH_SYSTEM_LABEL). */
export type SignInStringOverrides = Partial<Pick<SignInStrings, 'heading' | 'systemLabel'>>;

/** The placeholders a string uses, sorted. */
export function placeholdersOf(value: string): string[] {
  return [...new Set([...value.matchAll(PLACEHOLDER)].map((match) => match[1]))].sort();
}

/**
 * Check one string: text of a sane length, with the same placeholders as the
 * English one, so a translation cannot drop the client name or add a value
 * the page does not have.
 *
 * @returns Why the value is refused, or undefined when it is fine
 */
export function checkSignInString(key: SignInStringKey, value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return 'must be a non-empty string';
  }
  if (value.length > MAX_SIGN_IN_STRING_LENGTH) {
    return `is longer than ${MAX_SIGN_IN_STRING_LENGTH} characters`;
  }
  if (CONTROL_CHARS.test(value)) {
    return 'has a control character';
  }
  const expected = placeholdersOf(en[key]);
  const actual = placeholdersOf(value);
  if (expected.join(',') !== actual.join(',')) {
    const names = expected.length > 0 ? expected.map((name) => `{${name}}`).join(', ') : 'none';
    return `must use the placeholders ${names}`;
  }
  return undefined;
}

function readStringsFile(file: string): Record<string, Partial<SignInStrings>> {
  // Errors name the variable, not the path, so the configured value never reaches a log line
  const where = 'MCP_OAUTH_STRINGS';
  let raw: Buffer;
  try {
    raw = readFileSync(file);
  } catch {
    throw new Error(`${where}: the file could not be read. Check the path and its permissions.`);
  }
  if (raw.length > MAX_STRINGS_FILE_BYTES) {
    throw new Error(`${where}: the file is larger than ${MAX_STRINGS_FILE_BYTES / 1024} KB`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error(`${where}: not valid JSON`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`${where}: must be an object of languages, such as { "fi": { "heading": "..." } }`);
  }

  const languages: Record<string, Partial<SignInStrings>> = {};
  for (const [tag, strings] of Object.entries(doc)) {
    if (!LANGUAGE_TAG.test(tag)) {
      throw new Error(`${where}: "${tag}" is not a language code, such as fi or sv-FI`);
    }
    if (!strings || typeof strings !== 'object' || Array.isArray(strings)) {
      throw new Error(`${where}: ${tag} must be an object of strings`);
    }
    const checked: Partial<SignInStrings> = {};
    for (const [key, value] of Object.entries(strings)) {
      if (!(KEYS as string[]).includes(key)) {
        throw new Error(`${where}: ${tag}.${key} is not a sign-in page string. Keys: ${KEYS.join(', ')}`);
      }
      const problem = checkSignInString(key as SignInStringKey, value);
      if (problem) {
        throw new Error(`${where}: ${tag}.${key} ${problem}`);
      }
      checked[key as SignInStringKey] = value as string;
    }
    languages[tag.toLowerCase()] = checked;
  }
  return languages;
}

/**
 * Read the sign-in page languages from MCP_OAUTH_LANGUAGE and MCP_OAUTH_STRINGS.
 *
 * Each language starts from English, then its built-in strings, then the
 * overrides for every language, then its entries in the strings file.
 *
 * @param overrides - Values for every language, such as MCP_OAUTH_TITLE
 * @throws Error when the strings file or the language is invalid
 */
export function readSignInText(overrides: SignInStringOverrides = {}): SignInText {
  const file = process.env.MCP_OAUTH_STRINGS?.trim();
  const fromFile = file ? readStringsFile(file) : {};

  const languages: Record<string, SignInStrings> = {};
  for (const tag of new Set([...Object.keys(BUILT_IN_SIGN_IN_STRINGS), ...Object.keys(fromFile)])) {
    languages[tag] = { ...en, ...BUILT_IN_SIGN_IN_STRINGS[tag], ...overrides, ...fromFile[tag] };
  }

  const language = (process.env.MCP_OAUTH_LANGUAGE?.trim() || DEFAULT_SIGN_IN_LANGUAGE).toLowerCase();
  if (language !== 'auto' && !languages[language]) {
    throw new Error(
      `MCP_OAUTH_LANGUAGE has no strings for that language. Use auto or one of: ${Object.keys(languages).join(', ')}. ` +
        'Add a language with MCP_OAUTH_STRINGS.'
    );
  }
  return { language, languages };
}

/**
 * The page language for a request: the configured one, or with `auto` the
 * best match for Accept-Language among the available languages. A tag matches
 * exactly first (`sv-fi`), then by its primary language (`sv`). Falls back to
 * English.
 *
 * @param text - Languages from readSignInText()
 * @param acceptLanguage - The request's Accept-Language header
 */
export function pickSignInLanguage(text: SignInText, acceptLanguage: string | undefined): string {
  if (text.language !== 'auto') {
    return text.language;
  }
  const available = Object.keys(text.languages);
  const wanted = (acceptLanguage ?? '')
    .split(',')
    .slice(0, MAX_ACCEPT_LANGUAGE_ENTRIES)
    .map((entry, index) => {
      const [tag, ...params] = entry.trim().toLowerCase().split(';');
      const q = params.map((param) => param.trim()).find((param) => param.startsWith('q='));
      return { tag: tag.trim(), q: q ? Number(q.slice(2)) : 1, index };
    })
    .filter((entry) => LANGUAGE_TAG.test(entry.tag) && Number.isFinite(entry.q) && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);

  for (const { tag } of wanted) {
    const primary = tag.split('-')[0];
    const match =
      available.find((language) => language === tag) ??
      available.find((language) => language === primary) ??
      available.find((language) => language.split('-')[0] === primary);
    if (match) {
      return match;
    }
  }
  return DEFAULT_SIGN_IN_LANGUAGE;
}
