/**
 * MCP tools backed by IBM i SQL services.
 *
 * validate_query parses a statement and checks catalog names.
 * get_object_ddl returns DDL from QSYS2.GENERATE_SQL.
 * get_related_objects lists dependents from SYSTOOLS.RELATED_OBJECTS.
 * get_journal_info reports journal state from QSYS2.OBJECT_STATISTICS.
 * search_ibmi_services searches the service catalog in QSYS2.SERVICES_INFO.
 */

import { applyQueryLimit } from '../config.js';
import { allowedSchemasFor, type DbTarget } from '../systems.js';
import {
  generateObjectDdl,
  hasRoutine,
  inspectStatement,
  isJournalColumnMissing,
  isParseStatementMissing,
  isServicesInfoMissing,
  JOURNAL_INFO_UNAVAILABLE,
  listJournalInfo,
  listRelatedObjects,
  listServices,
  PARSE_STATEMENT_UNAVAILABLE,
  schemaExists,
  SERVICES_INFO_UNAVAILABLE,
  type IbmiService,
  type JournalInfoRow,
  type RelatedObject,
  type StatementInspection,
} from '../db/sqlServices.js';
import { sqlErrorFields, type SqlErrorDetails } from '../db/sqlErrorInfo.js';
import { validateQuery } from '../utils/security/sqlSecurityValidator.js';
import { checkQuerySchemas, isSchemaAllowed } from '../utils/security/schemaAllowlist.js';

const RELATED_OBJECTS_UNAVAILABLE =
  'SYSTOOLS.RELATED_OBJECTS is not available. It requires IBM i 7.3 Technology Refresh 9, IBM i 7.4 Technology Refresh 3, or a later release.';

export type ValidateQueryResult = SqlErrorDetails & {
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

export type ServiceCategory = {
  category: string;
  count: number;
};

export type SearchServicesResult = {
  success: boolean;
  error?: string;
  categories?: ServiceCategory[];
  data?: Array<Omit<IbmiService, 'example'> & { example?: string | null }>;
  count?: number;
  truncated?: boolean;
};

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

export function schemaDenied(schema: string, allowed: string[]): string {
  return `Schema ${schema.trim().toUpperCase()} is not in the allowed schemas (${allowed.join(', ')}).`;
}

export function requireSchema(schema: string | undefined, fallback: string | undefined): string {
  const resolved = schema?.trim() || fallback?.trim();
  if (!resolved) {
    throw new Error('Schema is required. Provide it as a parameter, or set a default schema (DB2I_SCHEMA, or schema in the profile).');
  }
  return resolved;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error occurred';
}

export async function validateQueryTool(input: {
  sql: string;
  target?: DbTarget;
  defaultSchema?: string;
}): Promise<ValidateQueryResult> {
  const security = validateQuery(input.sql);
  const violations = security.isValid ? [] : [...security.violations];

  const allowed = allowedSchemasFor(input.target);
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
      target: input.target,
      defaultSchema: input.defaultSchema,
      allowedSchemas: allowed,
    });
  } catch (error) {
    if (isParseStatementMissing(error)) {
      return { success: false, error: PARSE_STATEMENT_UNAVAILABLE };
    }
    return { success: false, error: messageOf(error), ...sqlErrorFields(error) };
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
  target?: DbTarget;
  defaultSchema?: string;
}): Promise<ObjectDdlResult> {
  try {
    const schema = requireSchema(input.schema, input.defaultSchema);
    const allowed = allowedSchemasFor(input.target);
    if (allowed && !isSchemaAllowed(schema, allowed)) {
      return { success: false, error: schemaDenied(schema, allowed) };
    }

    const ddl = await generateObjectDdl({
      schema,
      objectName: input.object,
      objectType: input.type,
      target: input.target,
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
  target?: DbTarget;
  defaultSchema?: string;
}): Promise<RelatedObjectsResult> {
  try {
    const schema = requireSchema(input.schema, input.defaultSchema);
    const allowed = allowedSchemasFor(input.target);
    if (allowed && !isSchemaAllowed(schema, allowed)) {
      return { success: false, error: schemaDenied(schema, allowed) };
    }

    const available = await hasRoutine('SYSTOOLS', 'RELATED_OBJECTS', input.target);
    if (!available) {
      return { success: false, error: RELATED_OBJECTS_UNAVAILABLE };
    }

    const rows = await listRelatedObjects(schema.trim().toUpperCase(), input.table.trim().toUpperCase(), input.target);
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
  target?: DbTarget;
  defaultSchema?: string;
}): Promise<JournalInfoResult> {
  try {
    const schema = requireSchema(input.schema, input.defaultSchema);
    const allowed = allowedSchemasFor(input.target);
    if (allowed && !isSchemaAllowed(schema, allowed)) {
      return { success: false, error: schemaDenied(schema, allowed) };
    }

    const result = await listJournalInfo(schema, input.filter, applyQueryLimit(input.limit), input.target);
    // OBJECT_STATISTICS returns no rows for a library that does not exist.
    if (result.rows.length === 0 && !(await schemaExists(schema, input.target))) {
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

function byCategoryThenName(a: IbmiService, b: IbmiService): number {
  return a.category.localeCompare(b.category) || a.service_name.localeCompare(b.service_name);
}

/**
 * Search the IBM i service catalog. With no query and no category, list the
 * categories with a count each, so an agent can browse before it searches.
 */
export async function searchIbmiServicesTool(input: {
  query?: string;
  category?: string;
  includeExample?: boolean;
  searchExamples?: boolean;
  limit?: number;
  target?: DbTarget;
}): Promise<SearchServicesResult> {
  try {
    const terms = (input.query ?? '').toUpperCase().split(/\s+/).filter((term) => term.length > 0);
    const category = input.category?.trim().toUpperCase();
    const services = await listServices(input.target);

    if (terms.length === 0 && !category) {
      const counts = new Map<string, number>();
      for (const service of services) {
        counts.set(service.category, (counts.get(service.category) ?? 0) + 1);
      }
      const categories = [...counts]
        .map(([name, count]) => ({ category: name, count }))
        .sort((a, b) => a.category.localeCompare(b.category));
      return { success: true, categories, count: categories.length };
    }

    const matches = services
      .filter((service) => {
        if (category && service.category.toUpperCase() !== category) {
          return false;
        }
        const haystack = [
          service.service_name,
          service.category,
          input.searchExamples ? (service.example ?? '') : '',
        ].join('\n').toUpperCase();
        return terms.every((term) => haystack.includes(term));
      })
      .sort(byCategoryThenName);

    const limit = applyQueryLimit(input.limit);
    const includeExample = input.includeExample ?? true;
    const data = matches.slice(0, limit).map((service) => {
      if (includeExample) {
        return service;
      }
      const { example: _example, ...rest } = service;
      return rest;
    });

    return { success: true, data, count: data.length, truncated: matches.length > limit };
  } catch (error) {
    if (isServicesInfoMissing(error)) {
      return { success: false, error: SERVICES_INFO_UNAVAILABLE };
    }
    return { success: false, error: messageOf(error) };
  }
}
