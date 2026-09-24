/**
 * Run one business SQL tool on the read-only connection.
 */

import { executeQuery } from '../db/connection.js';
import { isParseStatementMissing, parseStatement, type ParsedName } from '../db/sqlServices.js';
import { applyQueryLimit, getAllowedSchemas, getQueryLimitConfig, isQueryParseCheckEnabled } from '../config.js';
import { applySqlRowLimit } from '../tools/sqlLimit.js';
import { createChildLogger } from '../utils/logger.js';
import { checkQuerySchemas } from '../utils/security/schemaAllowlist.js';
import type { StoredTool } from './loader.js';
import { cacheParse, cachedParse } from './registry.js';
import { formatSchemaIssues, inputSchemaFor, type ParameterDef } from './schema.js';

const log = createChildLogger({ component: 'custom-tools' });

export type ParseOutcome =
  | { ok: true }
  | { ok: false; error: string; violations?: string[] };

/**
 * Decide whether PARSE_STATEMENT rows describe a query.
 * Shared by tool execution and `validate-tools --connect`.
 */
export function classifyParsedStatement(parsed: ParsedName[]): ParseOutcome {
  const types = [
    ...new Set(parsed.map((row) => row.statementType).filter((type): type is string => Boolean(type))),
  ];
  if (parsed.length === 0 || types.length === 0 || types.some((type) => type !== 'QUERY')) {
    const found = types.join(', ') || 'unknown';
    return {
      ok: false,
      error: parsed.length === 0
        ? 'The statement could not be parsed. Fix the SQL, or set QUERY_PARSE_CHECK=false to skip this check.'
        : `PARSE_STATEMENT rejected the statement (type: ${found}). Only queries are allowed.`,
      violations: parsed.length === 0
        ? ['The statement could not be parsed.']
        : [`Statement type is ${found}.`],
    };
  }
  return { ok: true };
}

export interface CustomToolQueryResult {
  success: boolean;
  data?: unknown[];
  rowCount?: number;
  error?: string;
  violations?: string[];
  limitApplied?: number;
  [key: string]: unknown;
}

/**
 * Bind the tool's parameters and run its statement.
 * The row cap is the tool's maxRows, or the default query limit, and never above QUERY_MAX_LIMIT.
 */
export async function executeCustomTool(
  tool: StoredTool,
  args: Record<string, unknown>,
  options: { sessionId?: string; defaultSchema?: string } = {},
): Promise<CustomToolQueryResult> {
  const filled = applyDefaults(tool.parameters, args);
  const parsed = inputSchemaFor(tool.parameters).safeParse(filled);
  if (!parsed.success) {
    return { success: false, error: formatSchemaIssues(parsed.error) };
  }

  const values = tool.placeholderNames.map((name) => bindValue(parsed.data[name]));
  const allowedSchemas = getAllowedSchemas();
  if (allowedSchemas) {
    const schemaResult = checkQuerySchemas(tool.sql, {
      allowed: allowedSchemas,
      defaultSchema: options.defaultSchema,
    });
    if (!schemaResult.ok) {
      return {
        success: false,
        error: `Schema allowlist rejected the query: ${schemaResult.violations.join('; ')}`,
        violations: schemaResult.violations,
      };
    }
  }

  const parsedOk = await ensureParsed(tool, options.sessionId);
  if (!parsedOk.ok) {
    return {
      success: false,
      error: parsedOk.error,
      ...(parsedOk.violations ? { violations: parsedOk.violations } : {}),
    };
  }

  const effectiveLimit = applyQueryLimit(tool.maxRows, getQueryLimitConfig());
  const limitedSql = applySqlRowLimit(tool.sql, effectiveLimit);

  try {
    const result = await executeQuery(limitedSql, values, options.sessionId);
    const rows = result.rows.slice(0, effectiveLimit);
    log.info({ tool: tool.name, rowCount: rows.length, effectiveLimit }, 'Custom tool executed');
    return {
      success: true,
      data: rows,
      rowCount: rows.length,
      limitApplied: effectiveLimit,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    log.debug({ err: error, tool: tool.name }, 'Custom tool failed');
    return { success: false, error: message };
  }
}

function applyDefaults(
  parameters: Record<string, ParameterDef>,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const filled: Record<string, unknown> = { ...args };
  for (const [name, param] of Object.entries(parameters)) {
    if (filled[name] === undefined && param.default !== undefined) {
      filled[name] = param.default;
    }
  }
  return filled;
}

/**
 * Boolean values bind as 1 and 0. Omitted optional values bind as NULL.
 */
function bindValue(value: unknown): unknown {
  if (value === undefined || value === null) {
    return null;
  }
  if (value === true) {
    return 1;
  }
  if (value === false) {
    return 0;
  }
  return value;
}

async function ensureParsed(tool: StoredTool, sessionId?: string): Promise<ParseOutcome> {
  if (!isQueryParseCheckEnabled()) {
    return { ok: true };
  }

  const cached = cachedParse(tool.name);
  if (cached) {
    return cached;
  }

  try {
    const parsed = await parseStatement(tool.sql, sessionId);
    const outcome = classifyParsedStatement(parsed);
    cacheParse(tool.name, outcome);
    return outcome;
  } catch (error) {
    if (isParseStatementMissing(error)) {
      const outcome: ParseOutcome = {
        ok: false,
        error: 'QSYS2.PARSE_STATEMENT is not available on this system. Set QUERY_PARSE_CHECK=false to run queries without this check.',
      };
      cacheParse(tool.name, outcome);
      return outcome;
    }
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    return { ok: false, error: message };
  }
}
