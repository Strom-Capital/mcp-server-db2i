/**
 * Query execution tool for IBM DB2i MCP Server
 */

import { executeQuery } from '../db/connection.js';
import { validateQuery } from '../db/queries.js';
import { createChildLogger } from '../utils/logger.js';
import { applyQueryLimit, getAllowedSchemas, getQueryLimitConfig } from '../config.js';
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
