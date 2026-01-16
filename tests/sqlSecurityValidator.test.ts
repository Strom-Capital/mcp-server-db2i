/**
 * Tests for SQL Security Validator
 */

import { describe, it, expect } from 'vitest';
import {
  SqlSecurityValidator,
  isReadOnlyQuery,
  validateQuery,
  DANGEROUS_OPERATIONS,
  DANGEROUS_FUNCTIONS,
  IBM_I_DANGEROUS_OPERATIONS,
} from '../src/utils/security/sqlSecurityValidator.js';

describe('SqlSecurityValidator', () => {
  describe('ALLOW - Valid read-only queries', () => {
    it('should allow simple SELECT statements', () => {
      const result = SqlSecurityValidator.validateQuery('SELECT * FROM users');
      expect(result.isValid).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should allow SELECT with WHERE clause', () => {
      const result = SqlSecurityValidator.validateQuery(
        "SELECT id, name FROM users WHERE status = 'active'"
      );
      expect(result.isValid).toBe(true);
    });

    it('should allow SELECT with JOINs', () => {
      const result = SqlSecurityValidator.validateQuery(`
        SELECT u.name, o.order_id 
        FROM users u 
        INNER JOIN orders o ON u.id = o.user_id
        WHERE u.status = 'active'
      `);
      expect(result.isValid).toBe(true);
    });

    it('should allow SELECT with subqueries', () => {
      const result = SqlSecurityValidator.validateQuery(`
        SELECT * FROM users 
        WHERE id IN (SELECT user_id FROM orders WHERE total > 100)
      `);
      expect(result.isValid).toBe(true);
    });

    it('should allow WITH (CTE) queries', () => {
      const result = SqlSecurityValidator.validateQuery(`
        WITH active_users AS (
          SELECT * FROM users WHERE status = 'active'
        )
        SELECT * FROM active_users
      `);
      expect(result.isValid).toBe(true);
    });

    it('should allow SELECT with aggregations', () => {
      const result = SqlSecurityValidator.validateQuery(`
        SELECT department, COUNT(*) as count, AVG(salary) as avg_salary
        FROM employees
        GROUP BY department
        HAVING COUNT(*) > 5
        ORDER BY avg_salary DESC
      `);
      expect(result.isValid).toBe(true);
    });

    it('should allow SELECT with CASE statements', () => {
      const result = SqlSecurityValidator.validateQuery(`
        SELECT name,
          CASE 
            WHEN age < 18 THEN 'minor'
            WHEN age >= 65 THEN 'senior'
            ELSE 'adult'
          END as age_group
        FROM users
      `);
      expect(result.isValid).toBe(true);
    });

    it('should allow SELECT with FETCH FIRST (DB2 pagination)', () => {
      const result = SqlSecurityValidator.validateQuery(`
        SELECT * FROM users ORDER BY created_at DESC FETCH FIRST 10 ROWS ONLY
      `);
      expect(result.isValid).toBe(true);
    });

    // False positive test - keywords inside string literals
    it('should allow SELECT where "DELETE" appears in string literal', () => {
      const result = SqlSecurityValidator.validateQuery(
        "SELECT * FROM logs WHERE action = 'DELETE'"
      );
      expect(result.isValid).toBe(true);
    });

    it('should allow SELECT where "DROP" appears in string literal', () => {
      const result = SqlSecurityValidator.validateQuery(
        "SELECT * FROM events WHERE type = 'DROP TABLE' AND status = 'pending'"
      );
      expect(result.isValid).toBe(true);
    });

    it('should allow SELECT with UPDATE keyword in column alias', () => {
      const result = SqlSecurityValidator.validateQuery(
        "SELECT last_modified as last_update FROM users"
      );
      expect(result.isValid).toBe(true);
    });

    // False positive test - function names inside string literals
    it('should allow SELECT where "SYSTEM(" appears in string literal', () => {
      const result = SqlSecurityValidator.validateQuery(
        "SELECT * FROM logs WHERE message LIKE '%SYSTEM(command)%'"
      );
      expect(result.isValid).toBe(true);
    });

    it('should allow SELECT where "QCMDEXC(" appears in string literal', () => {
      const result = SqlSecurityValidator.validateQuery(
        "SELECT * FROM audit WHERE details = 'QCMDEXC(CALL PGM)'"
      );
      expect(result.isValid).toBe(true);
    });

    it('should allow SELECT where "LOAD_EXTENSION(" appears in string literal', () => {
      const result = SqlSecurityValidator.validateQuery(
        "SELECT * FROM config WHERE setting = 'LOAD_EXTENSION(test)'"
      );
      expect(result.isValid).toBe(true);
    });
  });

  describe('BLOCK - Dangerous operations', () => {
    it('should block INSERT statements', () => {
      const result = SqlSecurityValidator.validateQuery(
        "INSERT INTO users (name) VALUES ('test')"
      );
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('INSERT'))).toBe(true);
    });

    it('should block UPDATE statements', () => {
      const result = SqlSecurityValidator.validateQuery(
        "UPDATE users SET status = 'inactive' WHERE id = 1"
      );
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('UPDATE'))).toBe(true);
    });

    it('should block DELETE statements', () => {
      const result = SqlSecurityValidator.validateQuery('DELETE FROM users WHERE id = 1');
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('DELETE'))).toBe(true);
    });

    it('should block DROP TABLE', () => {
      const result = SqlSecurityValidator.validateQuery('DROP TABLE users');
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('DROP'))).toBe(true);
    });

    it('should block DROP INDEX', () => {
      const result = SqlSecurityValidator.validateQuery('DROP INDEX idx_users ON users');
      expect(result.isValid).toBe(false);
    });

    it('should block CREATE TABLE', () => {
      const result = SqlSecurityValidator.validateQuery(
        'CREATE TABLE test (id INT PRIMARY KEY)'
      );
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('CREATE'))).toBe(true);
    });

    it('should block ALTER TABLE', () => {
      const result = SqlSecurityValidator.validateQuery(
        'ALTER TABLE users ADD COLUMN email VARCHAR(255)'
      );
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('ALTER'))).toBe(true);
    });

    it('should block TRUNCATE', () => {
      const result = SqlSecurityValidator.validateQuery('TRUNCATE TABLE users');
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('TRUNCATE'))).toBe(true);
    });

    it('should block GRANT', () => {
      const result = SqlSecurityValidator.validateQuery(
        'GRANT SELECT ON users TO public'
      );
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('GRANT'))).toBe(true);
    });

    it('should block REVOKE', () => {
      const result = SqlSecurityValidator.validateQuery(
        'REVOKE SELECT ON users FROM public'
      );
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('REVOKE'))).toBe(true);
    });

    it('should block CALL procedure', () => {
      const result = SqlSecurityValidator.validateQuery('CALL my_procedure()');
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('CALL'))).toBe(true);
    });

    it('should block EXECUTE', () => {
      const result = SqlSecurityValidator.validateQuery("EXECUTE sp_help 'users'");
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('EXEC'))).toBe(true);
    });
  });

  describe('BLOCK - IBM i specific operations', () => {
    it('should block QCMDEXC function calls', () => {
      const result = SqlSecurityValidator.validateQuery(
        "SELECT QCMDEXC('DLTF FILE(MYLIB/MYFILE)') FROM SYSIBM.SYSDUMMY1"
      );
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('QCMDEXC'))).toBe(true);
    });
  });

  describe('BLOCK - Case insensitivity', () => {
    it('should block lowercase delete', () => {
      const result = SqlSecurityValidator.validateQuery('delete from users');
      expect(result.isValid).toBe(false);
    });

    it('should block mixed case DeLeTe', () => {
      const result = SqlSecurityValidator.validateQuery('DeLeTe FrOm users');
      expect(result.isValid).toBe(false);
    });

    it('should block uppercase DROP', () => {
      const result = SqlSecurityValidator.validateQuery('DROP TABLE USERS');
      expect(result.isValid).toBe(false);
    });
  });

  describe('BLOCK - SQL injection patterns', () => {
    it('should block multi-statement with semicolon', () => {
      const result = SqlSecurityValidator.validateQuery(
        'SELECT * FROM users; DROP TABLE users'
      );
      expect(result.isValid).toBe(false);
    });

    it('should block UNION-based injection with DELETE', () => {
      const result = SqlSecurityValidator.validateQuery(
        "SELECT * FROM users WHERE id = 1 UNION DELETE FROM users"
      );
      expect(result.isValid).toBe(false);
    });

    it('should detect comment-based bypass attempts', () => {
      const result = SqlSecurityValidator.validateQuery(
        'SELECT * FROM users /* DROP TABLE users */'
      );
      // This should still be flagged as suspicious
      expect(result.violations.some(v => v.includes('comment') || v.includes('DROP'))).toBe(true);
    });
  });

  describe('Configuration options', () => {
    it('should enforce query length limit', () => {
      const longQuery = 'SELECT ' + 'a'.repeat(10001) + ' FROM users';
      const result = SqlSecurityValidator.validateQuery(longQuery, {
        maxQueryLength: 10000,
      });
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('length'))).toBe(true);
    });

    it('should allow custom forbidden keywords', () => {
      const result = SqlSecurityValidator.validateQuery(
        'SELECT * FROM users WHERE CUSTOM_FORBIDDEN = 1',
        { forbiddenKeywords: ['CUSTOM_FORBIDDEN'] }
      );
      expect(result.isValid).toBe(false);
      expect(result.violations.some(v => v.includes('CUSTOM_FORBIDDEN'))).toBe(true);
    });

    it('should respect maxQueryLength configuration', () => {
      const result = SqlSecurityValidator.validateQuery('SELECT * FROM users', {
        maxQueryLength: 5,
      });
      expect(result.isValid).toBe(false);
    });
  });

  describe('Convenience functions', () => {
    it('isReadOnlyQuery should return true for SELECT', () => {
      expect(isReadOnlyQuery('SELECT * FROM users')).toBe(true);
    });

    it('isReadOnlyQuery should return false for DELETE', () => {
      expect(isReadOnlyQuery('DELETE FROM users')).toBe(false);
    });

    it('validateQuery should return detailed results', () => {
      const result = validateQuery('DELETE FROM users');
      expect(result).toHaveProperty('isValid');
      expect(result).toHaveProperty('violations');
      expect(result).toHaveProperty('validationMethod');
      expect(result.isValid).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
    });
  });

  describe('Constants are properly defined', () => {
    it('should have DANGEROUS_OPERATIONS defined', () => {
      expect(DANGEROUS_OPERATIONS).toBeDefined();
      expect(DANGEROUS_OPERATIONS.length).toBeGreaterThan(0);
      expect(DANGEROUS_OPERATIONS).toContain('INSERT');
      expect(DANGEROUS_OPERATIONS).toContain('DELETE');
      expect(DANGEROUS_OPERATIONS).toContain('UPDATE');
      expect(DANGEROUS_OPERATIONS).toContain('DROP');
    });

    it('should have DANGEROUS_FUNCTIONS defined', () => {
      expect(DANGEROUS_FUNCTIONS).toBeDefined();
      expect(DANGEROUS_FUNCTIONS).toContain('QCMDEXC');
    });

    it('should have IBM_I_DANGEROUS_OPERATIONS defined', () => {
      expect(IBM_I_DANGEROUS_OPERATIONS).toBeDefined();
      expect(IBM_I_DANGEROUS_OPERATIONS).toContain('QCMDEXC');
      expect(IBM_I_DANGEROUS_OPERATIONS).toContain('SQL_EXECUTE_IMMEDIATE');
    });
  });
});
