/**
 * Read business annotations loaded from YAML.
 */

import { getCustomTools } from './registry.js';
import type { StoredAnnotation } from './loader.js';

export interface BusinessContextResult {
  success: boolean;
  error?: string;
  data?: StoredAnnotation[];
  count?: number;
  /** True when no entity had the requested name and `data` holds entities whose names partly match it. */
  partial_match?: boolean;
  /** Every loaded entity name, sorted. Only set when nothing matched the filters. */
  available_entities?: string[];
  /** Every annotated SCHEMA.TABLE, sorted. Only set when a table filter matched nothing. */
  available_tables?: string[];
  /** What to call next, when the filters did not match exactly. */
  hint?: string;
  [key: string]: unknown;
}

/**
 * Annotation for SCHEMA.TABLE, if one was loaded.
 */
export function annotationFor(schema: string, table: string): StoredAnnotation | undefined {
  const key = `${schema.trim().toUpperCase()}.${table.trim().toUpperCase()}`;
  return getCustomTools().annotations.find((annotation) => annotation.table === key);
}

/** Entity name as annotations spell it: lowercase, with spaces and hyphens as underscores. */
function normalizeEntity(name: string): string {
  return name.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/** Word parts of an entity name, such as `sales`, `order` and `line` for `sales_order_line`. */
function entityWords(name: string): string[] {
  return normalizeEntity(name).split('_').filter(Boolean);
}

/** Annotations for a table filter: an exact SCHEMA.TABLE, or a table name in any schema. */
function matchesTable(annotation: StoredAnnotation, table: string): boolean {
  if (table.includes('.')) {
    return annotation.table === table;
  }
  return annotation.table.endsWith(`.${table}`);
}

/**
 * Annotations matching an entity name, a table, or both. Empty filters return every annotation.
 */
export function filterAnnotations(filter: { entity?: string; table?: string }): StoredAnnotation[] {
  const entity = filter.entity?.trim() ? normalizeEntity(filter.entity) : undefined;
  const table = filter.table?.trim().toUpperCase();

  return getCustomTools().annotations.filter((annotation) => {
    if (entity && (annotation.entity === undefined || normalizeEntity(annotation.entity) !== entity)) {
      return false;
    }
    if (table) {
      return matchesTable(annotation, table);
    }
    return true;
  });
}

/** Shortest request that may match inside a longer entity name, so `a` does not match everything. */
const MIN_CONTAINED_LENGTH = 3;

/**
 * Annotations whose entity name partly matches `entity`: one name contains the other,
 * or, failing that, the names that share the most word parts.
 */
function partialEntityMatches(candidates: StoredAnnotation[], entity: string): StoredAnnotation[] {
  const wanted = normalizeEntity(entity);
  const named = candidates.filter((annotation) => annotation.entity);

  const contained = named.filter((annotation) => {
    const name = normalizeEntity(annotation.entity ?? '');
    return (wanted.length >= MIN_CONTAINED_LENGTH && name.includes(wanted)) || wanted.includes(name);
  });
  if (contained.length > 0) {
    return contained;
  }

  const wantedWords = new Set(entityWords(entity));
  let best = 0;
  let matches: StoredAnnotation[] = [];
  for (const annotation of named) {
    const shared = new Set(entityWords(annotation.entity ?? '').filter((word) => wantedWords.has(word))).size;
    if (shared > best) {
      best = shared;
      matches = [annotation];
    } else if (shared > 0 && shared === best) {
      matches.push(annotation);
    }
  }
  return matches;
}

/** Filters as the hint names them, such as `entity "sales_order" and table "ORDERS"`. */
function describeFilters(entity: string | undefined, table: string | undefined): string {
  const parts: string[] = [];
  if (entity) parts.push(`entity "${entity}"`);
  if (table) parts.push(`table "${table}"`);
  return parts.join(' and ');
}

/**
 * Annotations for get_business_context. An entity name that no annotation has exactly
 * falls back to names that partly match it. When nothing matches, the result lists the
 * loaded entities (and annotated tables, for a table filter) so the caller can pick one.
 */
export function getBusinessContextTool(input: { entity?: string; table?: string }): BusinessContextResult {
  const all = getCustomTools().annotations;
  const entity = input.entity?.trim() || undefined;
  const table = input.table?.trim() || undefined;

  if (all.length === 0) {
    return { success: true, data: [], count: 0, hint: 'No business annotations are loaded on this server.' };
  }

  const exact = filterAnnotations({ entity, table });
  if (exact.length > 0 || (!entity && !table)) {
    return { success: true, data: exact, count: exact.length };
  }

  if (entity) {
    const byTable = table ? filterAnnotations({ table }) : all;
    const partial = partialEntityMatches(byTable, entity);
    if (partial.length > 0) {
      return {
        success: true,
        data: partial,
        count: partial.length,
        partial_match: true,
        hint: `No entity is named "${entity}". These entities partly match it.`,
      };
    }
  }

  const entities = [...new Set(all.flatMap((annotation) => (annotation.entity ? [annotation.entity] : [])))].sort();
  const lists = table ? 'available_entities or available_tables' : 'available_entities';
  return {
    success: true,
    data: [],
    count: 0,
    available_entities: entities,
    ...(table ? { available_tables: all.map((annotation) => annotation.table).sort() } : {}),
    hint: `Nothing matches ${describeFilters(entity, table)}. Call again with a name from ${lists}, or omit entity and table to list every annotation.`,
  };
}
