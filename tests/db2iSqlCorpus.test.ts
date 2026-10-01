/**
 * Runs the Db2 for i statement corpus through the security validator and the schema allowlist.
 */

import { describe, it, expect } from 'vitest';
import { validateQuery } from '../src/utils/security/sqlSecurityValidator.js';
import { checkQuerySchemas } from '../src/utils/security/schemaAllowlist.js';
import { checkParsedSchemas, type ParsedName } from '../src/db/sqlServices.js';
import { applySqlRowLimit } from '../src/tools/sqlLimit.js';
import { DB2I_SQL_CORPUS } from './fixtures/db2iSqlCorpus.js';
import { RECORDED_PARSE_ROWS } from './fixtures/parseStatementRows.js';

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

  describe('row limit', () => {
    const accepted = DB2I_SQL_CORPUS.filter((entry) => entry.validator === 'accept');

    it.each(accepted.map((entry) => [entry.name, entry] as const))('%s stays valid with the row limit added', (_name, entry) => {
      const limited = applySqlRowLimit(entry.sql, 1001);
      expect(limited).toMatch(/FETCH FIRST \d+ ROWS ONLY|LIMIT \d+/);
      expect(validateQuery(limited).violations).toEqual([]);
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

  describe('schema allowlist (PARSE_STATEMENT names recorded on IBM i)', () => {
    const rowsFor = (sql: string): ParsedName[] =>
      (RECORDED_PARSE_ROWS.get(sql) ?? []).map((row) => ({
        nameType: row.NAME_TYPE,
        schema: row.SCHEMA,
        name: row.NAME,
        columnName: row.COLUMN_NAME,
        statementType: row.SQL_STATEMENT_TYPE,
      }));
    const withAllowlist = DB2I_SQL_CORPUS.filter((entry) => entry.allowlist);
    const parsed = withAllowlist.filter((entry) => rowsFor(entry.sql).length > 0);

    it('has a recording for every statement', () => {
      expect(DB2I_SQL_CORPUS.filter((entry) => !RECORDED_PARSE_ROWS.has(entry.sql)).map((entry) => entry.name)).toEqual([]);
    });

    it('only fails to parse statements that start with VALUES, a known PARSE_STATEMENT gap', () => {
      const unparsed = withAllowlist.filter((entry) => rowsFor(entry.sql).length === 0);
      expect(unparsed.map((entry) => entry.sql).filter((sql) => !/^\s*VALUES\b/i.test(sql))).toEqual([]);
    });

    it.each(parsed.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
      const result = checkParsedSchemas(rowsFor(entry.sql), { allowed: ALLOWED, defaultSchema: 'MYLIB', sql: entry.sql });
      // Valid Db2 for i the JavaScript parser cannot read is decided from IBM i's names instead
      const wanted = entry.parsedAllowlist ?? (entry.allowlist === 'deny' ? 'deny' : 'accept');
      expect({ outcome: result.violations.length === 0 ? 'accept' : 'deny', violations: result.violations }).toMatchObject({
        outcome: wanted,
      });
    });
  });
});
