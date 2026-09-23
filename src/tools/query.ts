/**
 * Query execution tool for IBM DB2i MCP Server
 */

import { executeQuery } from '../db/connection.js';
import { validateQuery } from '../db/queries.js';
import { isParseStatementMissing, parseStatement } from '../db/sqlServices.js';
import { createChildLogger } from '../utils/logger.js';
import { applyQueryLimit, getAllowedSchemas, getQueryLimitConfig, isQueryParseCheckEnabled } from '../config.js';
import { checkQuerySchemas } from '../utils/security/schemaAllowlist.js';
import { applySqlRowLimit } from './sqlLimit.js';

const log = createChildLogger({ component: 'query-tool' });

/**
 * Input for execute_query tool
 */
export interface ExecuteQueryInput {
  sql: string;
  params?: unknown[];
  limit?: number;
  /** Optional session ID for HTTP transport (uses session-specific pool) */
  sessionId?: string;
  /**
   * Schema unqualified names resolve to. Session schema when set, otherwise
   * DB2I_SCHEMA. Used by the schema allowlist only.
   */
  defaultSchema?: string;
}

/**
 * Execute a read-only SQL query
 * 
 * @param input - Query input including SQL, params, limit, and optional sessionId
 */
export async function executeQueryTool(input: ExecuteQueryInput): Promise<{
  success: boolean;
  data?: unknown[];
  rowCount?: number;
  error?: string;
  violations?: string[];
  limitApplied?: number;
}> {
  const { sql, params = [], sessionId, defaultSchema } = input;
  const queryConfig = getQueryLimitConfig();
  const effectiveLimit = applyQueryLimit(input.limit, queryConfig);

  log.debug(
    { sqlPreview: sql.substring(0, 100), requestedLimit: input.limit, effectiveLimit, sessionId: sessionId?.substring(0, 8) },
    'Received query request'
  );

  // Validate that query is read-only using enhanced security validator
  const validationResult = validateQuery(sql);
  if (!validationResult.isValid) {
    log.warn({ violations: validationResult.violations }, 'Query rejected: security validation failed');
    return {
      success: false,
      error: `Security validation failed: ${validationResult.violations.join('; ')}`,
      violations: validationResult.violations,
    };
  }

  const allowedSchemas = getAllowedSchemas();
  if (allowedSchemas) {
    const schemaResult = checkQuerySchemas(sql, { allowed: allowedSchemas, defaultSchema });
    if (!schemaResult.ok) {
      log.warn({ violations: schemaResult.violations }, 'Query rejected: schema allowlist');
      return {
        success: false,
        error: `Schema allowlist rejected the query: ${schemaResult.violations.join('; ')}`,
        violations: schemaResult.violations,
      };
    }
  }

  if (isQueryParseCheckEnabled()) {
    try {
      const parsed = await parseStatement(sql, sessionId);
      const types = [
        ...new Set(parsed.map((row) => row.statementType).filter((type): type is string => Boolean(type))),
      ];
      if (parsed.length === 0 || types.length === 0 || types.some((type) => type !== 'QUERY')) {
        const found = types.join(', ') || 'unknown';
        const violations = parsed.length === 0
          ? ['The statement could not be parsed.']
          : [`Statement type is ${found}.`];
        log.warn({ violations }, 'Query rejected: PARSE_STATEMENT check');
        return {
          success: false,
          error: parsed.length === 0
            ? 'The statement could not be parsed. Fix the SQL, or set QUERY_PARSE_CHECK=false to skip this check.'
            : `PARSE_STATEMENT rejected the statement (type: ${found}). Only queries are allowed.`,
          violations,
        };
      }
    } catch (error) {
      if (isParseStatementMissing(error)) {
        log.warn('Query rejected: QSYS2.PARSE_STATEMENT is not available');
        return {
          success: false,
          error: 'QSYS2.PARSE_STATEMENT is not available on this system. Set QUERY_PARSE_CHECK=false to run queries without this check.',
        };
      }
      const message = error instanceof Error ? error.message : 'Unknown error occurred';
      log.debug({ err: error }, 'PARSE_STATEMENT check failed');
      return { success: false, error: message };
    }
  }

  try {
    const limitedSql = applySqlRowLimit(sql, effectiveLimit);
    const result = await executeQuery(limitedSql, params as unknown[], sessionId);
    const rows = result.rows.slice(0, effectiveLimit);

    log.info({ rowCount: rows.length, effectiveLimit }, 'Query executed successfully');
    return {
      success: true,
      data: rows,
      rowCount: rows.length,
      limitApplied: effectiveLimit,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    log.debug({ err: error }, 'Query execution failed');
    return {
      success: false,
      error: message,
    };
  }
}
