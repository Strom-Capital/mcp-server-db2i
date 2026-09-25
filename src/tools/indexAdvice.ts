/**
 * index_advice: indexes the query optimizer asked for in one library, grouped
 * and ranked from QSYS2.SYSIXADV. The tool only reads the advice.
 */

import { applyQueryLimit } from '../config.js';
import { allowedSchemasFor, type DbTarget } from '../systems.js';
import { listIndexAdvice, parseSince, type IndexAdviceRow } from '../db/indexAdvice.js';
import { schemaExists } from '../db/sqlServices.js';
import { sqlErrorFields, type SqlErrorDetails } from '../db/sqlErrorInfo.js';
import { isSchemaAllowed } from '../utils/security/schemaAllowlist.js';
import { requireSchema, schemaDenied } from './sqlServices.js';

export type IndexAdviceResult = SqlErrorDetails & {
  success: boolean;
  error?: string;
  schema?: string;
  table?: string;
  since?: string;
  data?: IndexAdviceRow[];
  count?: number;
  truncated?: boolean;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error occurred';
}

/**
 * Read grouped index advice for a library, or for one table in it.
 * The library must be in QUERY_ALLOWED_SCHEMAS when that list is set.
 */
export async function indexAdviceTool(input: {
  schema?: string;
  table?: string;
  since?: string;
  limit?: number;
  target?: DbTarget;
  defaultSchema?: string;
}): Promise<IndexAdviceResult> {
  try {
    const schema = requireSchema(input.schema, input.defaultSchema);
    const since = input.since?.trim() ? parseSince(input.since) : undefined;
    const allowed = allowedSchemasFor(input.target);
    if (allowed && !isSchemaAllowed(schema, allowed)) {
      return { success: false, error: schemaDenied(schema, allowed) };
    }

    const table = input.table?.trim() ? input.table.trim().toUpperCase() : undefined;
    const result = await listIndexAdvice({
      schema,
      table,
      since,
      limit: applyQueryLimit(input.limit),
      target: input.target,
    });
    if (result.rows.length === 0 && !(await schemaExists(schema, input.target))) {
      return { success: false, error: `Library ${schema.trim().toUpperCase()} was not found.` };
    }

    return {
      success: true,
      schema: schema.trim().toUpperCase(),
      ...(table ? { table } : {}),
      ...(since ? { since } : {}),
      data: result.rows,
      count: result.rows.length,
      truncated: result.truncated,
    };
  } catch (error) {
    return { success: false, error: messageOf(error), ...sqlErrorFields(error) };
  }
}
