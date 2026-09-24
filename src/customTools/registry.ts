/**
 * Process-wide custom tools, loaded once at startup.
 */

import type { LoadedCustomTools, StoredAnnotation, StoredTool } from './loader.js';

const EMPTY: LoadedCustomTools = { tools: [], annotations: [], masking: new Map() };

let current: LoadedCustomTools = EMPTY;

export type ParseOutcome =
  | { ok: true }
  | { ok: false; error: string; violations?: string[] };

/** PARSE_STATEMENT outcomes by system and tool. A tool without `system:` can run on several. */
const parseCache = new Map<string, ParseOutcome>();

function parseKey(toolName: string, system: string | undefined): string {
  return `${system ?? ''}|${toolName}`;
}

export function cachedParse(toolName: string, system: string | undefined): ParseOutcome | undefined {
  return parseCache.get(parseKey(toolName, system));
}

export function cacheParse(toolName: string, system: string | undefined, outcome: ParseOutcome): void {
  parseCache.set(parseKey(toolName, system), outcome);
}

export function setCustomTools(loaded: LoadedCustomTools): void {
  current = loaded;
  parseCache.clear();
}

export function getCustomTools(): LoadedCustomTools {
  return current;
}

export function resetCustomTools(): void {
  setCustomTools(EMPTY);
}

export type { StoredAnnotation, StoredTool };
