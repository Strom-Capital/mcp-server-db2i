/**
 * SQL Security Validator for IBM Db2i MCP Server
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
 * Prefixes of IBM i services that send data off the system or write outside the database.
 * Matched against the unqualified function name, so QSYS2.HTTP_GET and SYSTOOLS.HTTPGETCLOB both hit.
 */
const SIDE_EFFECT_FUNCTION_PREFIXES = [
  'HTTP_',
  'HTTPGET',
  'HTTPPOST',
  'HTTPPUT',
  'HTTPDELETE',
  'HTTPHEAD',
  'HTTPBLOB',
  'HTTPCLOB',
  'IFS_WRITE',
  'GENERATE_SPREADSHEET',
  'SEND_EMAIL',
] as const;

/**
 * All dangerous operations combined
 */
const ALL_DANGEROUS_OPERATIONS = [
  ...DANGEROUS_OPERATIONS,
  ...IBM_I_DANGEROUS_OPERATIONS,
] as const;

/** Regex checks built once: [pattern, violation message]. */
const REGEX_CHECKS: ReadonlyArray<readonly [RegExp, string]> = [
  ...ALL_DANGEROUS_OPERATIONS.map((operation) =>
    [new RegExp(`\\b${operation}\\b`, 'i'), `Dangerous operation detected: ${operation}`] as const),
  ...DANGEROUS_FUNCTIONS.map((func) =>
    [new RegExp(`\\b${func}\\s*\\(`, 'i'), `Dangerous function call detected: ${func}`] as const),
  ...SIDE_EFFECT_FUNCTION_PREFIXES.map((prefix) =>
    [new RegExp(`\\b(?:\\w+\\.)?${prefix}\\w*\\s*\\(`, 'i'), `Dangerous function call detected: ${prefix}`] as const),
];

/** The operation or function a violation names, for de-duplicating AST and regex findings. */
function violationSubject(violation: string): string {
  const colon = violation.lastIndexOf(': ');
  return (colon >= 0 ? violation.slice(colon + 2) : violation).toUpperCase();
}

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

    // 2. If read-only mode, validate for write operations.
    // Regex runs on text with literals, comments, and delimited-identifier quotes removed,
    // so a string or a quoted name earlier in the statement cannot hide a later call.
    if (readOnly) {
      const astResult = this.validateQueryAST(query);
      const regexResult = this.validateQueryRegex(normalizeForScan(query));
      
      // Combine violations from both methods
      violations.push(...astResult.violations);
      
      // Add regex violations about an operation or function the AST did not already report
      const reported = new Set(violations.map(violationSubject));
      for (const violation of regexResult.violations) {
        if (!reported.has(violationSubject(violation))) {
          reported.add(violationSubject(violation));
          violations.push(violation);
        }
      }
    }

    // 3. Check for custom forbidden keywords on the same normalized text
    if (forbiddenKeywords.length > 0) {
      const keywordViolations = this.checkForbiddenKeywords(normalizeForScan(query), forbiddenKeywords);
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
      // Db2 SQL is similar enough for security validation purposes
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

      }

      // Check for multiple statements (potential injection)
      if (statements.length > 1) {
        violations.push('Multiple statements detected - potential SQL injection');
      }

      return {
        isValid: violations.length === 0,
        violations,
        validationMethod: 'ast',
      };
    } catch {
      // AST parsing failed - this could be due to Db2-specific syntax
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

    // query is already normalized: literals and comments are gone, delimited names are unquoted
    for (const [pattern, message] of REGEX_CHECKS) {
      if (pattern.test(query)) {
        violations.push(message);
      }
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

    // Check if this node is a function call. Match the unqualified name so
    // QSYS2.QCMDEXC is compared as QCMDEXC, not as the whole schema-qualified form.
    if (nodeObj.type === 'function' && nodeObj.name) {
      const funcName = unqualifiedFunctionName(nodeObj.name);
      if (funcName && isBlockedFunction(funcName)) {
        found.push(funcName.toUpperCase());
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
      if (pattern.test(query)) {
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
 * Remove text that must not affect keyword detection:
 * string literals (including '' escapes), -- and block comments, and the quotes
 * around delimited identifiers. "QCMDEXC" becomes QCMDEXC. Replaced regions become
 * a space so adjacent tokens are not glued together.
 */
function normalizeForScan(query: string): string {
  let out = '';
  let i = 0;

  while (i < query.length) {
    const current = query[i];
    const next = query[i + 1];

    if (current === '-' && next === '-') {
      i += 2;
      while (i < query.length && query[i] !== '\n') i++;
      out += ' ';
      continue;
    }

    if (current === '/' && next === '*') {
      i += 2;
      while (i < query.length && !(query[i] === '*' && query[i + 1] === '/')) i++;
      if (i < query.length) i += 2;
      out += ' ';
      continue;
    }

    if (current === "'") {
      i++;
      while (i < query.length) {
        if (query[i] === "'" && query[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (query[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      out += ' ';
      continue;
    }

    if (current === '"') {
      i++;
      let ident = '';
      while (i < query.length) {
        if (query[i] === '"' && query[i + 1] === '"') {
          ident += '"';
          i += 2;
          continue;
        }
        if (query[i] === '"') {
          i++;
          break;
        }
        ident += query[i];
        i++;
      }
      out += ident;
      continue;
    }

    out += current;
    i++;
  }

  return out;
}

/**
 * Unqualified function name from a node-sql-parser name node.
 * The name may be a string, "schema.name", or { name: [{ value }] }.
 */
function unqualifiedFunctionName(name: unknown): string | undefined {
  if (typeof name === 'string') {
    const parts = name.split('.');
    return parts[parts.length - 1];
  }
  if (!name || typeof name !== 'object') return undefined;

  const obj = name as Record<string, unknown>;
  if (Array.isArray(obj.name) && obj.name.length > 0) {
    const last = obj.name[obj.name.length - 1] as { value?: unknown };
    if (last && typeof last.value === 'string') return last.value;
  }
  if (typeof obj.name === 'string') return obj.name;
  if (typeof obj.value === 'string') return obj.value;
  return undefined;
}

function isBlockedFunction(name: string): boolean {
  const upper = name.toUpperCase();
  if (DANGEROUS_FUNCTIONS.some((func) => func.toUpperCase() === upper)) return true;
  return SIDE_EFFECT_FUNCTION_PREFIXES.some((prefix) => upper.startsWith(prefix));
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
