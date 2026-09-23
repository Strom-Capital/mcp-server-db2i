/**
 * Process-wide custom tools, loaded once at startup.
 */

import type { LoadedCustomTools, StoredAnnotation, StoredTool } from './loader.js';

const EMPTY: LoadedCustomTools = { tools: [], annotations: [] };

let current: LoadedCustomTools = EMPTY;

type ParseOutcome =
  | { ok: true }
  | { ok: false; error: string; violations?: string[] };

const parseCache = new Map<string, ParseOutcome>();

export function cachedParse(toolName: string): ParseOutcome | undefined {
  return parseCache.get(toolName);
}

export function cacheParse(toolName: string, outcome: ParseOutcome): void {
  parseCache.set(toolName, outcome);
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
