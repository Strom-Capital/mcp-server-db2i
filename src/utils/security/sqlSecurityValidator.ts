/**
 * SQL Security Validator for IBM Db2i MCP Server
 * 
 * Provides comprehensive SQL query validation using both AST parsing
 * and regex-based fallback to detect dangerous operations.
 */

import nodeSqlParser from 'node-sql-parser';
import { getQueryMaxLength } from '../../config.js';
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
 * All dangerous operations combined. Matched against the statement type the AST reports.
 */
const ALL_DANGEROUS_OPERATIONS = [
  ...DANGEROUS_OPERATIONS,
  ...IBM_I_DANGEROUS_OPERATIONS,
] as const;

/** Words a read-only statement may start with, after any opening parentheses. */
const QUERY_START_WORDS = ['SELECT', 'WITH', 'VALUES'] as const;

/**
 * Data-change statements, matched by their shape rather than by a single word, so a column
 * named UPDATE or a call to REPLACE() is not mistaken for one. A data-change table reference
 * such as FINAL TABLE (INSERT INTO ...) has the same shape and is caught too.
 */
const DATA_CHANGE_SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bINSERT\s+INTO\b/i, 'INSERT'],
  [/\bDELETE\s+FROM\b/i, 'DELETE'],
  [/\bMERGE\s+INTO\b/i, 'MERGE'],
  // UPDATE name [[AS] alias] SET
  [/\bUPDATE\s+[\w$#@]+(?:\s*\.\s*[\w$#@]+)*(?:\s+(?:AS\s+)?[\w$#@]+)?\s+SET\b/i, 'UPDATE'],
  // A data-change table reference in any form, e.g. OLD TABLE (DELETE MYLIB.ORDERS) without FROM
  [/\bTABLE\W*\(\W*(?:INSERT|UPDATE|DELETE|MERGE)\b/i, 'data-change table reference'],
];

/**
 * Name checks built once: [pattern, violation message]. They run on text with delimited
 * identifiers unquoted, so QSYS2."QCMDEXC"(...) is still a QCMDEXC call.
 */
const REGEX_CHECKS: ReadonlyArray<readonly [RegExp, string]> = [
  ...IBM_I_DANGEROUS_OPERATIONS.map((operation) =>
    [new RegExp(`\\b${operation}\\b`, 'i'), `Dangerous operation detected: ${operation}`] as const),
  ...DANGEROUS_FUNCTIONS.map((func) =>
    [new RegExp(`\\b${func}\\s*\\(`, 'i'), `Dangerous function call detected: ${func}`] as const),
  ...SIDE_EFFECT_FUNCTION_PREFIXES.map((prefix) =>
    [new RegExp(`\\b(?:\\w+\\.)?${prefix}\\w*\\s*\\(`, 'i'), `Dangerous function call detected: ${prefix}`] as const),
];

/** First word of a statement, after leading whitespace and opening parentheses. */
function firstWord(text: string): string {
  return /^[\s(]*([A-Za-z_]\w*)?/.exec(text)?.[1]?.toUpperCase() ?? '';
}

/** The operation or function a violation names, for de-duplicating AST and regex findings. */
function violationSubject(violation: string): string {
  if (violation.startsWith('Multiple statements')) return 'MULTIPLE STATEMENTS';
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
    const { readOnly = true, maxQueryLength = getQueryMaxLength(), forbiddenKeywords = [] } = config;

    const violations: string[] = [];

    // 1. Check query length
    if (query.length > maxQueryLength) {
      violations.push(
        `Query exceeds maximum length of ${maxQueryLength} characters (QUERY_MAX_LENGTH). ` +
          'Split the work into smaller queries, or join to a table instead of listing many values inline.'
      );
      return { isValid: false, violations, validationMethod: 'regex' };
    }

    // 2. If read-only mode, validate for write operations.
    // Regex runs on text with literals, comments, and delimited-identifier quotes removed,
    // so a string or a quoted name earlier in the statement cannot hide a later call.
    if (readOnly) {
      const astResult = this.validateQueryAST(query);
      const scanned = normalizeForScan(query);
      if (scanned.unterminated) {
        // The scan cannot tell code from text after an unclosed string or comment
        violations.push(`Query has an unterminated ${scanned.unterminated}`);
        return { isValid: false, violations, validationMethod: 'regex' };
      }
      const regexResult = this.validateQueryRegex(scanned.text, normalizeForScan(query, 'mask').text);
      
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
      const keywordViolations = this.checkForbiddenKeywords(normalizeForScan(query).text, forbiddenKeywords);
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
  private static validateQueryRegex(query: string, masked: string): SecurityValidationResult {
    const violations: string[] = [];

    // query is already normalized: literals and comments are gone, delimited names are unquoted
    for (const [pattern, message] of REGEX_CHECKS) {
      if (pattern.test(query)) {
        violations.push(message);
      }
    }

    // A delimited identifier is never a keyword, so "DELETE" FROM is a column, not a statement.
    // The shapes run on text where each delimited identifier is replaced by a placeholder name.
    for (const [pattern, operation] of DATA_CHANGE_SHAPES) {
      if (pattern.test(masked)) {
        violations.push(`Dangerous operation detected: ${operation}`);
      }
    }

    // Anything after a semicolon other than whitespace is a second statement
    const semicolon = query.indexOf(';');
    if (semicolon >= 0 && query.slice(semicolon + 1).trim() !== '') {
      const next = firstWord(query.slice(semicolon + 1));
      violations.push(`Multiple statements detected${next ? `: a second statement starts with ${next}` : ''}`);
    }

    // Only queries: the statement must start with SELECT, WITH or VALUES, optionally inside parentheses
    const first = firstWord(query);
    if (!(QUERY_START_WORDS as readonly string[]).includes(first)) {
      // "...: WORD" so the AST's report of the same statement type is not repeated
      violations.push(`Query must start with SELECT, WITH or VALUES${first ? `, not: ${first}` : ''}`);
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

/** Characters that separate tokens for Db2 for i but that \s may not match. */
const DB2_SEPARATOR = /[\p{Cc}\p{Z}\u0085]/u;

/**
 * Characters that end a -- comment. Db2 for i ends one at a line feed or NEL (U+0085).
 * The scan also ends it at the other line breaks: reading too much as code is safe,
 * reading code as comment is not.
 */
const COMMENT_LINE_END = /[\n\r\v\f\u0085\u2028\u2029]/;

interface ScanText {
  /** Statement text with literals and comments replaced by spaces. */
  text: string;
  /** Set when a string, delimited identifier or block comment is never closed. */
  unterminated?: 'string' | 'identifier' | 'comment';
}

/**
 * Remove text that must not affect keyword detection:
 * string literals (including '' escapes), -- and block comments, and the quotes
 * around delimited identifiers. "QCMDEXC" becomes QCMDEXC. Replaced regions become
 * a space so adjacent tokens are not glued together.
 *
 * Block comments nest, as they do in Db2 for i: in /* /* *\/ ' *\/ the quote is
 * still inside the comment and does not start a string.
 *
 * With identifiers set to 'mask', each delimited identifier becomes the placeholder
 * QUOTED_NAME instead, for checks where a quoted name must not read as a keyword.
 * Control and Unicode separator characters outside literals become a space.
 */
function normalizeForScan(query: string, identifiers: 'unquote' | 'mask' = 'unquote'): ScanText {
  let out = '';
  let i = 0;

  while (i < query.length) {
    const current = query[i];
    const next = query[i + 1];

    if (current === '-' && next === '-') {
      i += 2;
      while (i < query.length && !COMMENT_LINE_END.test(query[i])) i++;
      out += ' ';
      continue;
    }

    if (current === '/' && next === '*') {
      i += 2;
      let depth = 1;
      while (i < query.length && depth > 0) {
        if (query[i] === '/' && query[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (query[i] === '*' && query[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      if (depth > 0) return { text: out, unterminated: 'comment' };
      out += ' ';
      continue;
    }

    if (current === "'") {
      i++;
      let closed = false;
      while (i < query.length) {
        if (query[i] === "'" && query[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (query[i] === "'") {
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) return { text: out, unterminated: 'string' };
      out += ' ';
      continue;
    }

    if (current === '"') {
      i++;
      let ident = '';
      let closed = false;
      while (i < query.length) {
        if (query[i] === '"' && query[i + 1] === '"') {
          ident += '"';
          i += 2;
          continue;
        }
        if (query[i] === '"') {
          i++;
          closed = true;
          break;
        }
        ident += query[i];
        i++;
      }
      if (!closed) return { text: out, unterminated: 'identifier' };
      // Spaces around the placeholder, so INTO"T" still reads as INTO QUOTED_NAME
      out += identifiers === 'mask' ? ' QUOTED_NAME ' : ident;
      continue;
    }

    // Db2 for i reads NEL (U+0085) and other control and separator characters as
    // whitespace, while \s in the patterns does not match all of them
    out += DB2_SEPARATOR.test(current) ? ' ' : current;
    i++;
  }

  return { text: out };
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
