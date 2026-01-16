/**
 * SQL Security Validator for IBM DB2i MCP Server
 * 
 * Provides comprehensive SQL query validation using both AST parsing
 * and regex-based fallback to detect dangerous operations.
 */

import nodeSqlParser from 'node-sql-parser';
const { Parser } = nodeSqlParser;

/**
 * Security validation result
 */
export interface SecurityValidationResult {
  /** Whether the validation passed */
  isValid: boolean;
  /** List of security violations found */
  violations: string[];
  /** Validation method used */
  validationMethod: 'ast' | 'regex' | 'combined';
}

/**
 * Security configuration options
 */
export interface SecurityConfig {
  /** Whether to enforce read-only mode (default: true) */
  readOnly?: boolean;
  /** Maximum query length in characters (default: 10000) */
  maxQueryLength?: number;
  /** Additional keywords to forbid */
  forbiddenKeywords?: string[];
}

/**
 * Dangerous SQL operations that should be blocked in read-only mode
 */
export const DANGEROUS_OPERATIONS = [
  // Data manipulation
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'MERGE',
  'TRUNCATE',
  // Schema operations
  'DROP',
  'CREATE',
  'ALTER',
  'RENAME',
  // System operations
  'CALL',
  'EXEC',
  'EXECUTE',
  'SET',
  'DECLARE',
  // Security operations
  'GRANT',
  'REVOKE',
  'DENY',
  // Data transfer
  'LOAD',
  'IMPORT',
  'EXPORT',
  'BULK',
  // System control
  'SHUTDOWN',
  'RESTART',
  'KILL',
  'STOP',
  'START',
  // Backup/restore
  'BACKUP',
  'RESTORE',
  'DUMP',
  // Locking
  'LOCK',
  'UNLOCK',
  // Transaction control
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
] as const;

/**
 * IBM i specific dangerous operations
 */
export const IBM_I_DANGEROUS_OPERATIONS = [
  'QCMDEXC',
  'SQL_EXECUTE_IMMEDIATE',
] as const;

/**
 * Dangerous SQL functions that should be blocked
 */
export const DANGEROUS_FUNCTIONS = [
  'SYSTEM',
  'QCMDEXC',
  'SQL_EXECUTE_IMMEDIATE',
  'SQLCMD',
  'LOAD_EXTENSION',
  'EXEC',
  'EXECUTE_IMMEDIATE',
  'EVAL',
] as const;

/**
 * All dangerous operations combined
 */
const ALL_DANGEROUS_OPERATIONS = [
  ...DANGEROUS_OPERATIONS,
  ...IBM_I_DANGEROUS_OPERATIONS,
] as const;

/**
 * SQL Security Validator class
 * 
 * Provides comprehensive SQL security validation using AST parsing
 * with regex fallback for maximum coverage.
 */
export class SqlSecurityValidator {
  private static parser = new Parser();

  /**
   * Validate a SQL query against security rules
   * 
   * @param query - SQL query to validate
   * @param config - Security configuration options
   * @returns Validation result with any violations found
   */
  static validateQuery(
    query: string,
    config: SecurityConfig = {}
  ): SecurityValidationResult {
    const { readOnly = true, maxQueryLength = 10000, forbiddenKeywords = [] } = config;

    const violations: string[] = [];

    // 1. Check query length
    if (query.length > maxQueryLength) {
      violations.push(`Query exceeds maximum length of ${maxQueryLength} characters`);
      return { isValid: false, violations, validationMethod: 'regex' };
    }

    // 2. If read-only mode, validate for write operations
    if (readOnly) {
      // Try AST-based validation first
      const astResult = this.validateQueryAST(query);
      
      // Also run regex validation for additional coverage
      const regexResult = this.validateQueryRegex(query);
      
      // Combine violations from both methods
      violations.push(...astResult.violations);
      
      // Add regex violations that weren't caught by AST
      for (const violation of regexResult.violations) {
        if (!violations.some(v => v.includes(violation.split(' ')[0]))) {
          violations.push(violation);
        }
      }
    }

    // 3. Check for custom forbidden keywords
    if (forbiddenKeywords.length > 0) {
      const keywordViolations = this.checkForbiddenKeywords(query, forbiddenKeywords);
      violations.push(...keywordViolations);
    }

    return {
      isValid: violations.length === 0,
      violations,
      validationMethod: 'combined',
    };
  }

  /**
   * Validate SQL query using AST parsing
   */
  private static validateQueryAST(query: string): SecurityValidationResult {
    const violations: string[] = [];

    try {
      // Try to parse the SQL - use 'mysql' dialect as it's most compatible
      // DB2 SQL is similar enough for security validation purposes
      const ast = this.parser.astify(query, { database: 'mysql' });
      
      const statements = Array.isArray(ast) ? ast : [ast];

      for (const statement of statements) {
        if (!statement || typeof statement !== 'object') continue;

        const stmtObj = statement as unknown as Record<string, unknown>;
        const stmtType = String(stmtObj.type || '').toUpperCase();

        // Check if statement type is dangerous
        if (this.isDangerousOperation(stmtType)) {
          violations.push(`Dangerous statement type: ${stmtType}`);
        }

        // Check for dangerous functions in the AST
        const dangerousFunctions = this.findDangerousFunctionsInAST(statement);
        for (const func of dangerousFunctions) {
          violations.push(`Dangerous function detected: ${func}`);
        }

        // Check for multiple statements (potential injection)
        if (statements.length > 1) {
          violations.push('Multiple statements detected - potential SQL injection');
        }
      }

      return {
        isValid: violations.length === 0,
        violations,
        validationMethod: 'ast',
      };
    } catch {
      // AST parsing failed - this could be due to DB2-specific syntax
      // Fall back to regex validation (handled by caller)
      return {
        isValid: true, // Let regex handle it
        violations: [],
        validationMethod: 'ast',
      };
    }
  }

  /**
   * Validate SQL query using regex patterns (fallback)
   */
  private static validateQueryRegex(query: string): SecurityValidationResult {
    const violations: string[] = [];

    // Check for dangerous operations
    for (const operation of ALL_DANGEROUS_OPERATIONS) {
      const pattern = new RegExp(`\\b${operation}\\b`, 'i');
      if (pattern.test(query)) {
        // Make sure it's not inside a string literal
        if (!this.isInsideStringLiteral(query, operation)) {
          violations.push(`Dangerous operation detected: ${operation}`);
        }
      }
    }

    // Check for dangerous function calls
    for (const func of DANGEROUS_FUNCTIONS) {
      const pattern = new RegExp(`\\b${func}\\s*\\(`, 'i');
      if (pattern.test(query)) {
        // Make sure it's not inside a string literal (same check as operations)
        if (!this.isInsideStringLiteral(query, func)) {
          violations.push(`Dangerous function call detected: ${func}`);
        }
      }
    }

    // Check for comment-based bypass attempts
    if (/\/\*.*?(DROP|DELETE|INSERT|UPDATE|TRUNCATE).*?\*\//i.test(query)) {
      violations.push('Suspicious comment pattern detected');
    }

    // Check for semicolon followed by dangerous operation (multi-statement)
    if (/;\s*(DROP|DELETE|INSERT|UPDATE|CREATE|ALTER|TRUNCATE)/i.test(query)) {
      violations.push('Multiple statements with dangerous operation detected');
    }

    // Verify query starts with SELECT or WITH (for CTEs)
    const trimmedUpper = query.trim().toUpperCase();
    if (!trimmedUpper.startsWith('SELECT') && !trimmedUpper.startsWith('WITH')) {
      violations.push('Query must start with SELECT or WITH');
    }

    return {
      isValid: violations.length === 0,
      violations,
      validationMethod: 'regex',
    };
  }

  /**
   * Check if a keyword is inside a string literal
   */
  private static isInsideStringLiteral(query: string, keyword: string): boolean {
    // Simple heuristic: check if the keyword appears after an odd number of quotes
    const keywordIndex = query.toUpperCase().indexOf(keyword.toUpperCase());
    if (keywordIndex === -1) return false;

    const beforeKeyword = query.substring(0, keywordIndex);
    const singleQuotes = (beforeKeyword.match(/'/g) || []).length;
    const doubleQuotes = (beforeKeyword.match(/"/g) || []).length;

    // If odd number of quotes, we're inside a string
    return singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0;
  }

  /**
   * Check if an operation is dangerous
   */
  private static isDangerousOperation(operation: string): boolean {
    return ALL_DANGEROUS_OPERATIONS.some(
      (op) => op.toUpperCase() === operation.toUpperCase()
    );
  }

  /**
   * Find dangerous functions anywhere in the AST
   */
  private static findDangerousFunctionsInAST(node: unknown): string[] {
    const found: string[] = [];

    if (!node || typeof node !== 'object') return found;

    const nodeObj = node as Record<string, unknown>;

    // Check if this node is a function call
    if (nodeObj.type === 'function' && nodeObj.name) {
      const funcName = String(nodeObj.name).toUpperCase();
      if (DANGEROUS_FUNCTIONS.some((f) => f.toUpperCase() === funcName)) {
        found.push(funcName);
      }
    }

    // Recursively check all properties
    for (const key in nodeObj) {
      const value = nodeObj[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          found.push(...this.findDangerousFunctionsInAST(item));
        }
      } else if (typeof value === 'object' && value !== null) {
        found.push(...this.findDangerousFunctionsInAST(value));
      }
    }

    return found;
  }

  /**
   * Check for custom forbidden keywords
   */
  private static checkForbiddenKeywords(query: string, keywords: string[]): string[] {
    const violations: string[] = [];

    for (const keyword of keywords) {
      const pattern = new RegExp(`\\b${this.escapeRegex(keyword)}\\b`, 'i');
      if (pattern.test(query) && !this.isInsideStringLiteral(query, keyword)) {
        violations.push(`Forbidden keyword detected: ${keyword}`);
      }
    }

    return violations;
  }

  /**
   * Escape special regex characters
   */
  private static escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

/**
 * Convenience function for simple validation
 * 
 * @param sql - SQL query to validate
 * @returns true if the query is safe, false otherwise
 */
export function isReadOnlyQuery(sql: string): boolean {
  const result = SqlSecurityValidator.validateQuery(sql);
  return result.isValid;
}

/**
 * Validate a query and return detailed results
 * 
 * @param sql - SQL query to validate
 * @param config - Optional security configuration
 * @returns Detailed validation result
 */
export function validateQuery(
  sql: string,
  config?: SecurityConfig
): SecurityValidationResult {
  return SqlSecurityValidator.validateQuery(sql, config);
}
