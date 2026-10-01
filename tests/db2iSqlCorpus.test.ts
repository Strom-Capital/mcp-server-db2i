/**
 * Runs the Db2 for i statement corpus through the security validator and the schema allowlist.
 */

import { describe, it, expect } from 'vitest';
import { validateQuery } from '../src/utils/security/sqlSecurityValidator.js';
import { checkQuerySchemas } from '../src/utils/security/schemaAllowlist.js';
import { DB2I_SQL_CORPUS } from './fixtures/db2iSqlCorpus.js';

const ALLOWED = ['MYLIB', 'QSYS2', 'SYSIBM'];

describe('Db2 for i statement corpus', () => {
  describe('security validator', () => {
    it.each(DB2I_SQL_CORPUS.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
      const result = validateQuery(entry.sql);
      expect({ valid: result.isValid, violations: result.violations }).toMatchObject({
        valid: entry.validator === 'accept',
      });
    });
  });

  describe('schema allowlist (JavaScript parser)', () => {
    const withAllowlist = DB2I_SQL_CORPUS.filter((entry) => entry.allowlist);

    it.each(withAllowlist.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
      const result = checkQuerySchemas(entry.sql, { allowed: ALLOWED, defaultSchema: 'MYLIB' });
      const outcome = result.ok ? 'accept' : result.unparseable ? 'unparseable' : 'deny';
      expect({ outcome, violations: result.violations }).toMatchObject({ outcome: entry.allowlist });
    });
  });
});
