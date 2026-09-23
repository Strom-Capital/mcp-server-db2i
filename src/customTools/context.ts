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
  [key: string]: unknown;
}

/**
 * Annotation for SCHEMA.TABLE, if one was loaded.
 */
export function annotationFor(schema: string, table: string): StoredAnnotation | undefined {
  const key = `${schema.trim().toUpperCase()}.${table.trim().toUpperCase()}`;
  return getCustomTools().annotations.find((annotation) => annotation.table === key);
}

/**
 * Annotations matching an entity name, a table, or both. Empty filters return every annotation.
 */
export function filterAnnotations(filter: { entity?: string; table?: string }): StoredAnnotation[] {
  const entity = filter.entity?.trim().toLowerCase();
  const table = filter.table?.trim().toUpperCase();

  return getCustomTools().annotations.filter((annotation) => {
    if (entity && annotation.entity?.toLowerCase() !== entity) {
      return false;
    }
    if (table) {
      if (table.includes('.')) {
        return annotation.table === table;
      }
      return annotation.table.endsWith(`.${table}`);
    }
    return true;
  });
}

export function getBusinessContextTool(input: { entity?: string; table?: string }): BusinessContextResult {
  const data = filterAnnotations(input);
  return { success: true, data, count: data.length };
}
