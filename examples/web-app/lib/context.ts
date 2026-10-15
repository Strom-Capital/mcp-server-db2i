/** A join to another table, from a YAML annotation. */
export interface Relation {
  table: string;
  join: Record<string, string>;
  cardinality?: string;
  description?: string;
}

/** A row filter most queries on the table need, such as leaving out deleted rows. */
export interface RowFilter {
  sql: string;
  columns?: string[];
  reason?: string;
}

/** Business notes for one table, as `get_business_context` returns them. */
export interface Annotation {
  table: string;
  entity?: string;
  description?: string;
  filters?: RowFilter[];
  columns: Record<string, string>;
  relations: Relation[];
}

/** What the context page shows. */
export interface BusinessContext {
  /** False when the server does not offer `get_business_context` to this user. */
  available: boolean;
  annotations: Annotation[];
}

/**
 * Whether an annotation mentions the search text in its table, entity,
 * description, column names or column notes.
 *
 * @param annotation - One annotation
 * @param needle - Lowercase search text
 * @returns True when it matches
 */
export function annotationMatches(annotation: Annotation, needle: string): boolean {
  if (!needle) {
    return true;
  }
  const text = [
    annotation.table,
    annotation.entity,
    annotation.description,
    ...Object.entries(annotation.columns ?? {}).flat(),
    ...(annotation.relations ?? []).map((relation) => relation.table),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return text.includes(needle);
}
