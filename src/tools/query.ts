/**
 * Query execution tool for IBM DB2i MCP Server
 */

import { executeQuery } from '../db/connection.js';
import { validateQuery } from '../db/queries.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger({ component: 'query-tool' });

/**
 * Input for execute_query tool
 */
export interface ExecuteQueryInput {
  sql: string;
  params?: unknown[];
  limit?: number;
}

/**
 * Execute a read-only SQL query
 */
export async function executeQueryTool(input: ExecuteQueryInput): Promise<{
  success: boolean;
  data?: unknown[];
  rowCount?: number;
  error?: string;
  violations?: string[];
}> {
  const { sql, params = [], limit = 1000 } = input;

  log.debug({ sqlPreview: sql.substring(0, 100), limit }, 'Received query request');

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

  try {
    // Add FETCH FIRST clause if not already present to limit results
    let limitedSql = sql.trim();
    if (!limitedSql.toUpperCase().includes('FETCH FIRST') && 
        !limitedSql.toUpperCase().includes('LIMIT')) {
      // Remove trailing semicolon if present
      if (limitedSql.endsWith(';')) {
        limitedSql = limitedSql.slice(0, -1);
      }
      limitedSql = `${limitedSql} FETCH FIRST ${limit} ROWS ONLY`;
    }

    const result = await executeQuery(limitedSql, params as unknown[]);

    log.info({ rowCount: result.rows.length }, 'Query executed successfully');
    return {
      success: true,
      data: result.rows,
      rowCount: result.rows.length,
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
