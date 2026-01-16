/**
 * Query execution tool for IBM DB2i MCP Server
 */

import { z } from 'zod';
import { executeQuery } from '../db/connection.js';
import { isReadOnlyQuery } from '../db/queries.js';

/**
 * Input schema for execute_query tool
 */
export const executeQueryInputSchema = {
  sql: z.string().describe('SQL SELECT query to execute'),
  params: z.array(z.unknown()).optional().describe('Query parameters for prepared statement'),
  limit: z.number().optional().default(1000).describe('Maximum number of rows to return (default: 1000)'),
};

export type ExecuteQueryInput = z.infer<z.ZodObject<typeof executeQueryInputSchema>>;

/**
 * Execute a read-only SQL query
 */
export async function executeQueryTool(input: ExecuteQueryInput): Promise<{
  success: boolean;
  data?: unknown[];
  rowCount?: number;
  error?: string;
}> {
  const { sql, params = [], limit = 1000 } = input;

  // Validate that query is read-only
  if (!isReadOnlyQuery(sql)) {
    return {
      success: false,
      error: 'Only SELECT queries are allowed. Data modification statements (INSERT, UPDATE, DELETE, etc.) are not permitted.',
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

    return {
      success: true,
      data: result.rows,
      rowCount: result.rows.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    return {
      success: false,
      error: message,
    };
  }
}

/**
 * Tool definition for MCP server
 */
export const queryToolDefinition = {
  name: 'execute_query',
  description: 'Execute a read-only SQL SELECT query against the IBM DB2i database. Only SELECT statements are allowed for security. Results are limited by default to prevent large result sets.',
  inputSchema: executeQueryInputSchema,
  handler: executeQueryTool,
};
