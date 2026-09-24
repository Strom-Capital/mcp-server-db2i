/**
 * MCP tools backed by IBM i SQL services.
 *
 * validate_query parses a statement and checks catalog names.
 * get_object_ddl returns DDL from QSYS2.GENERATE_SQL.
 * get_related_objects lists dependents from SYSTOOLS.RELATED_OBJECTS.
 * get_journal_info reports journal state from QSYS2.OBJECT_STATISTICS.
 */

import { applyQueryLimit, getAllowedSchemas } from '../config.js';
import {
  generateObjectDdl,
  hasRoutine,
  inspectStatement,
  isJournalColumnMissing,
  isParseStatementMissing,
  JOURNAL_INFO_UNAVAILABLE,
  listJournalInfo,
  listRelatedObjects,
  PARSE_STATEMENT_UNAVAILABLE,
  schemaExists,
  type JournalInfoRow,
  type RelatedObject,
  type StatementInspection,
} from '../db/sqlServices.js';
import { validateQuery } from '../db/queries.js';
import { checkQuerySchemas, isSchemaAllowed } from '../utils/security/schemaAllowlist.js';

const RELATED_OBJECTS_UNAVAILABLE =
  'SYSTOOLS.RELATED_OBJECTS is not available. It requires IBM i 7.3 Technology Refresh 9, IBM i 7.4 Technology Refresh 3, or a later release.';

export type ValidateQueryResult = {
  success: boolean;
  error?: string;
  valid?: boolean;
  statementType?: string | null;
  missingTables?: string[];
  missingColumns?: string[];
  missingRoutines?: string[];
  violations?: string[];
};

export type ObjectDdlResult = {
  success: boolean;
  error?: string;
  schema?: string;
  object?: string;
  type?: string;
  ddl?: string;
};

export type RelatedObjectsResult = {
  success: boolean;
  error?: string;
  data?: RelatedObject[];
  count?: number;
};

export type JournalInfoResult = {
  success: boolean;
  error?: string;
  schema?: string;
  data?: JournalInfoRow[];
  count?: number;
  needsAttention?: number;
  truncated?: boolean;
};

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

export function schemaDenied(schema: string, allowed: string[]): string {
  return `Schema ${schema.trim().toUpperCase()} is not in QUERY_ALLOWED_SCHEMAS (${allowed.join(', ')}).`;
}

export function requireSchema(schema: string | undefined, fallback: string | undefined): string {
  const resolved = schema?.trim() || fallback?.trim();
  if (!resolved) {
    throw new Error('Schema is required. Either provide it as a parameter or set DB2I_SCHEMA environment variable.');
  }
  return resolved;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error occurred';
}

export async function validateQueryTool(input: {
  sql: string;
  sessionId?: string;
  defaultSchema?: string;
}): Promise<ValidateQueryResult> {
  const security = validateQuery(input.sql);
  const violations = security.isValid ? [] : [...security.violations];

  const allowed = getAllowedSchemas();
  if (allowed) {
    const schemaResult = checkQuerySchemas(input.sql, {
      allowed,
      defaultSchema: input.defaultSchema,
    });
    violations.push(...schemaResult.violations);
  }

  let inspection: StatementInspection;
  try {
    inspection = await inspectStatement(input.sql, {
      sessionId: input.sessionId,
      defaultSchema: input.defaultSchema,
      allowedSchemas: allowed,
    });
  } catch (error) {
    if (isParseStatementMissing(error)) {
      return { success: false, error: PARSE_STATEMENT_UNAVAILABLE };
    }
    return { success: false, error: messageOf(error) };
  }

  violations.push(...inspection.violations);
  const findings = unique(violations);
  const valid =
    inspection.parsed &&
    inspection.statementType === 'QUERY' &&
    findings.length === 0 &&
    inspection.missingTables.length === 0 &&
    inspection.missingColumns.length === 0 &&
    inspection.missingRoutines.length === 0;

  return {
    success: true,
    valid,
    statementType: inspection.statementType,
    missingTables: inspection.missingTables,
    missingColumns: inspection.missingColumns,
    missingRoutines: inspection.missingRoutines,
    violations: findings,
  };
}

export async function getObjectDdlTool(input: {
  schema?: string;
  object: string;
  type: string;
  sessionId?: string;
  defaultSchema?: string;
}): Promise<ObjectDdlResult> {
  try {
    const schema = requireSchema(input.schema, input.defaultSchema);
    const allowed = getAllowedSchemas();
    if (allowed && !isSchemaAllowed(schema, allowed)) {
      return { success: false, error: schemaDenied(schema, allowed) };
    }

    const ddl = await generateObjectDdl({
      schema,
      objectName: input.object,
      objectType: input.type,
      sessionId: input.sessionId,
    });

    return {
      success: true,
      schema: schema.trim().toUpperCase(),
      object: input.object.trim().toUpperCase(),
      type: input.type.trim().toUpperCase(),
      ddl,
    };
  } catch (error) {
    return { success: false, error: messageOf(error) };
  }
}

export async function getRelatedObjectsTool(input: {
  schema?: string;
  table: string;
  sessionId?: string;
  defaultSchema?: string;
}): Promise<RelatedObjectsResult> {
  try {
    const schema = requireSchema(input.schema, input.defaultSchema);
    const allowed = getAllowedSchemas();
    if (allowed && !isSchemaAllowed(schema, allowed)) {
      return { success: false, error: schemaDenied(schema, allowed) };
    }

    const available = await hasRoutine('SYSTOOLS', 'RELATED_OBJECTS', input.sessionId);
    if (!available) {
      return { success: false, error: RELATED_OBJECTS_UNAVAILABLE };
    }

    const rows = await listRelatedObjects(schema.trim().toUpperCase(), input.table.trim().toUpperCase(), input.sessionId);
    const data = allowed
      ? rows.filter((row) => {
          const library = row.schema_name ?? row.library_name;
          return library != null && isSchemaAllowed(library, allowed);
        })
      : rows;

    return { success: true, data, count: data.length };
  } catch (error) {
    return { success: false, error: messageOf(error) };
  }
}

export async function getJournalInfoTool(input: {
  schema?: string;
  filter?: string;
  limit?: number;
  sessionId?: string;
  defaultSchema?: string;
}): Promise<JournalInfoResult> {
  try {
    const schema = requireSchema(input.schema, input.defaultSchema);
    const allowed = getAllowedSchemas();
    if (allowed && !isSchemaAllowed(schema, allowed)) {
      return { success: false, error: schemaDenied(schema, allowed) };
    }

    const result = await listJournalInfo(schema, input.filter, applyQueryLimit(input.limit), input.sessionId);
    // OBJECT_STATISTICS returns no rows for a library that does not exist.
    if (result.rows.length === 0 && !(await schemaExists(schema, input.sessionId))) {
      return { success: false, error: `Library ${schema.trim().toUpperCase()} was not found.` };
    }
    return {
      success: true,
      schema: schema.trim().toUpperCase(),
      data: result.rows,
      count: result.rows.length,
      needsAttention: result.rows.filter((row) => row.needs_attention).length,
      truncated: result.truncated,
    };
  } catch (error) {
    if (isJournalColumnMissing(error)) {
      return { success: false, error: JOURNAL_INFO_UNAVAILABLE };
    }
    return { success: false, error: messageOf(error) };
  }
}
