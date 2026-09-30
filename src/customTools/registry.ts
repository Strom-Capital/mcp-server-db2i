/**
 * Process-wide custom tools, loaded once at startup.
 */

import type { LoadedCustomTools, StoredAnnotation, StoredTool } from './loader.js';

/** A set with nothing loaded. A new object each call, so no caller shares the masking map. */
export function emptyCustomTools(): LoadedCustomTools {
  return { tools: [], annotations: [], masking: new Map(), instructions: [] };
}

let current: LoadedCustomTools = emptyCustomTools();

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
  setCustomTools(emptyCustomTools());
}

export type { StoredAnnotation, StoredTool };
