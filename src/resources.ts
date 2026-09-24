/**
 * MCP resources for table columns, table DDL, and YAML business context.
 *
 * Each resource is registered only when the tool it draws on is enabled, and
 * every read that names a library is held to QUERY_ALLOWED_SCHEMAS. Reads that
 * reach IBM i count against the rate limit and go to the audit log like tool calls.
 */

import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
  type McpServer,
  type Variables,
} from '@modelcontextprotocol/server';

import { getAllowedSchemas } from './config.js';
import { annotationFor, filterAnnotations } from './customTools/context.js';
import { listSchemas, listTables } from './db/queries.js';
import type { SessionContext } from './server.js';
import { describeTableTool } from './tools/metadata.js';
import { getObjectDdlTool, schemaDenied } from './tools/sqlServices.js';
import { writeAudit, type AuditCall } from './utils/auditLog.js';
import { getRateLimiter } from './utils/rateLimiter.js';
import { isSchemaAllowed } from './utils/security/schemaAllowlist.js';

/** The protocol caps a completion response at 100 values. */
const MAX_COMPLETIONS = 100;

export const TABLE_URI_TEMPLATE = 'db2i://{schema}/{table}';
export const TABLE_DDL_URI_TEMPLATE = 'db2i://{schema}/{table}/ddl';
export const BUSINESS_CONTEXT_URI = 'db2i://business-context';

export interface Caller {
  sessionId?: string;
  identity: string;
}

export function callerOf(sessionContext?: SessionContext): Caller {
  return {
    sessionId: sessionContext?.sessionId,
    identity: sessionContext?.config.username || 'stdio',
  };
}

/** Throws the error execute_query reports when a library is outside QUERY_ALLOWED_SCHEMAS. */
export function assertSchemaAllowed(schema: string): void {
  const allowed = getAllowedSchemas();
  if (allowed && !isSchemaAllowed(schema, allowed)) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, schemaDenied(schema, allowed));
  }
}

/**
 * Run a catalog read under the rate limit and record it in the audit log.
 */
export async function guarded<T>(
  caller: Caller,
  name: string,
  args: Record<string, unknown>,
  run: () => Promise<T>,
  rowCount?: (value: T) => number | undefined,
): Promise<T> {
  const audit = (outcome: Pick<AuditCall, 'outcome' | 'error' | 'durationMs' | 'rowCount'>): void => {
    writeAudit({ tool: name, identity: caller.identity, sql: null, args, ...outcome });
  };

  const limiter = getRateLimiter();
  const rate = limiter.checkLimit(caller.sessionId ?? 'stdio');
  if (!rate.allowed) {
    const { error } = limiter.formatError(rate);
    audit({ outcome: 'rate_limited', error });
    throw new ProtocolError(ProtocolErrorCode.InternalError, error);
  }

  const started = Date.now();
  try {
    const value = await run();
    audit({ outcome: 'success', durationMs: Date.now() - started, rowCount: rowCount?.(value) });
    return value;
  } catch (error) {
    audit({
      outcome: 'error',
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    });
    throw error;
  }
}

/**
 * Library names starting with value. Limited to QUERY_ALLOWED_SCHEMAS when that
 * list is set, which also avoids a catalog query.
 */
export async function completeSchemas(value: string, caller: Caller): Promise<string[]> {
  const prefix = value.trim().toUpperCase();
  const allowed = getAllowedSchemas();
  if (allowed) {
    return allowed.filter((name) => name.startsWith(prefix)).slice(0, MAX_COMPLETIONS);
  }
  if (!getRateLimiter().checkLimit(caller.sessionId ?? 'stdio').allowed) {
    return [];
  }
  try {
    const rows = await listSchemas(`${prefix}*`, caller.sessionId);
    return rows.map((row) => row.schema_name).slice(0, MAX_COMPLETIONS);
  } catch {
    return [];
  }
}

/**
 * Table names in schema starting with value. Empty when schema is missing or not allowed.
 */
export async function completeTables(schema: string | undefined, value: string, caller: Caller): Promise<string[]> {
  const library = schema?.trim();
  if (!library) {
    return [];
  }
  const allowed = getAllowedSchemas();
  if (allowed && !isSchemaAllowed(library, allowed)) {
    return [];
  }
  if (!getRateLimiter().checkLimit(caller.sessionId ?? 'stdio').allowed) {
    return [];
  }
  try {
    const rows = await listTables(library, `${value.trim().toUpperCase()}*`, caller.sessionId);
    return rows.map((row) => row.table_name).slice(0, MAX_COMPLETIONS);
  } catch {
    return [];
  }
}

export function tableUri(schema: string, table: string): string {
  return `db2i://${encodeURIComponent(schema)}/${encodeURIComponent(table)}`;
}

/** Template variables arrive percent-encoded, so a # in a name reaches us as %23. */
function nameFrom(variables: Variables, key: string): string {
  const raw = variables[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value ?? '');
  } catch {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Resource URI has a malformed ${key} name.`);
  }
  const name = decoded.trim().toUpperCase();
  if (!name) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Resource URI is missing the ${key} name.`);
  }
  return name;
}

function jsonContents(uri: URL, body: unknown) {
  return {
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body) }],
  };
}

/** Annotated tables in allowed libraries. These are the tables resources/list offers. */
function annotatedTables() {
  const allowed = getAllowedSchemas();
  return filterAnnotations({}).filter((annotation) => {
    const schema = annotation.table.split('.')[0];
    return !allowed || isSchemaAllowed(schema, allowed);
  });
}

async function readTable(uri: URL, schema: string, table: string, caller: Caller) {
  assertSchemaAllowed(schema);
  const result = await describeTableTool({ schema, table, sessionId: caller.sessionId });
  if (!result.success) {
    throw new ProtocolError(ProtocolErrorCode.InternalError, result.error);
  }
  if (result.count === 0) {
    throw new ResourceNotFoundError(uri.href, `Table ${schema}.${table} was not found.`);
  }
  const annotation = annotationFor(schema, table);
  return {
    schema,
    table,
    ...(annotation?.entity ? { entity: annotation.entity } : {}),
    ...(result.business_description ? { business_description: result.business_description } : {}),
    columns: result.data,
    ...(result.relations ? { relations: result.relations } : {}),
  };
}

/** GENERATE_SQL needs the object type, and a view or alias is not a TABLE. */
const DDL_TYPE_BY_TABLE_TYPE: Record<string, string> = {
  V: 'VIEW',
  A: 'ALIAS',
};

async function readTableDdl(uri: URL, schema: string, table: string, caller: Caller) {
  assertSchemaAllowed(schema);
  const rows = await listTables(schema, table, caller.sessionId);
  const match = rows.find((row) => row.table_name.toUpperCase() === table);
  if (!match) {
    throw new ResourceNotFoundError(uri.href, `Table ${schema}.${table} was not found.`);
  }
  const type = DDL_TYPE_BY_TABLE_TYPE[match.table_type] ?? 'TABLE';
  const result = await getObjectDdlTool({ schema, object: table, type, sessionId: caller.sessionId });
  if (!result.success || result.ddl === undefined) {
    throw new ProtocolError(ProtocolErrorCode.InternalError, result.error ?? 'Failed to generate DDL');
  }
  return { contents: [{ uri: uri.href, mimeType: 'application/sql', text: result.ddl }] };
}

export function registerResources(
  server: McpServer,
  enabledTools: ReadonlySet<string>,
  sessionContext?: SessionContext,
): void {
  const caller = callerOf(sessionContext);
  const complete = {
    schema: (value: string) => completeSchemas(value, caller),
    table: (value: string, context?: { arguments?: Record<string, string> }) =>
      completeTables(context?.arguments?.schema, value, caller),
  };

  if (enabledTools.has('describe_table')) {
    server.registerResource(
      'table',
      new ResourceTemplate(TABLE_URI_TEMPLATE, {
        list: () => ({
          resources: annotatedTables().map((annotation) => {
            const [schema, table] = annotation.table.split('.');
            return {
              uri: tableUri(schema, table),
              name: annotation.table,
              ...(annotation.description ? { description: annotation.description } : {}),
              mimeType: 'application/json',
            };
          }),
        }),
        complete,
      }),
      {
        title: 'Table columns and business context',
        description: 'Columns of a table from the catalog, with the business description, column notes, and relations loaded from YAML. Encode # and other reserved characters in names, for example %23.',
        mimeType: 'application/json',
      },
      async (uri, variables) => {
        const schema = nameFrom(variables, 'schema');
        const table = nameFrom(variables, 'table');
        const body = await guarded(
          caller,
          'resource:table',
          { schema, table },
          () => readTable(uri, schema, table, caller),
          (value) => value.columns.length,
        );
        return jsonContents(uri, body);
      },
    );
  }

  if (enabledTools.has('get_object_ddl')) {
    server.registerResource(
      'table_ddl',
      new ResourceTemplate(TABLE_DDL_URI_TEMPLATE, { list: undefined, complete }),
      {
        title: 'Table DDL',
        description: 'SQL that recreates a table, view, or alias, from QSYS2.GENERATE_SQL. The statements are not run.',
        mimeType: 'application/sql',
      },
      async (uri, variables) => {
        const schema = nameFrom(variables, 'schema');
        const table = nameFrom(variables, 'table');
        return guarded(caller, 'resource:table_ddl', { schema, table }, () => readTableDdl(uri, schema, table, caller));
      },
    );
  }

  if (enabledTools.has('get_business_context')) {
    server.registerResource(
      'business_context',
      BUSINESS_CONTEXT_URI,
      {
        title: 'Business context',
        description: 'Business entities, table and column descriptions, and relations loaded from MCP_CUSTOM_TOOLS.',
        mimeType: 'application/json',
      },
      (uri) => {
        const data = filterAnnotations({});
        return jsonContents(uri, { data, count: data.length });
      },
    );
  }
}
