// Record QSYS2.PARSE_STATEMENT rows for every statement in tests/fixtures/db2iSqlCorpus.ts
// and write tests/fixtures/parseStatementRows.ts. It only parses: no statement is run.
//
//   npm run build && npm run corpus:record
//
// Uses the connection settings in .env and whichever DB2I_DRIVER they name.
import { readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../dist/config.js';
import { closeGlobalPool, initializePool } from '../dist/db/connection.js';
import { parseStatement } from '../dist/db/sqlServices.js';

const corpusFile = new URL('../tests/fixtures/db2iSqlCorpus.ts', import.meta.url);
const outFile = new URL('../tests/fixtures/parseStatementRows.ts', import.meta.url);

const corpus = readFileSync(corpusFile, 'utf8');
const statements = [];
for (const match of corpus.matchAll(/sql: (['"])((?:\\.|(?!\1).)*)\1/g)) {
  statements.push(match[1] === "'" ? match[2].replace(/\\'/g, "'") : match[2].replace(/\\"/g, '"'));
}

const literal = (value) => (value == null ? 'null' : `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
const out = [
  '/**',
  ' * QSYS2.PARSE_STATEMENT rows recorded on a real IBM i (7.4 or later) for every statement in',
  ' * db2iSqlCorpus.ts, keyed by the exact statement text. Only the parse output is kept.',
  ' * An empty list means PARSE_STATEMENT returned no rows, which the parse check rejects.',
  ' * Regenerate with `npm run corpus:record` after adding statements (see docs/development.md).',
  ' */',
  'export interface RecordedParseRow {',
  '  NAME_TYPE: string;',
  '  SCHEMA: string | null;',
  '  NAME: string | null;',
  '  COLUMN_NAME: string | null;',
  '  SQL_STATEMENT_TYPE: string | null;',
  '}',
  '',
  'export const RECORDED_PARSE_ROWS: ReadonlyMap<string, readonly RecordedParseRow[]> = new Map([',
];

initializePool(loadConfig());
try {
  for (const sql of statements) {
    // parseStatement removes a trailing semicolon, as the server does
    const rows = await parseStatement(sql);
    out.push('  [', `    ${literal(sql)},`, rows.length > 0 ? '    [' : '    [],');
    if (rows.length > 0) {
      for (const row of rows) {
        out.push(
          `      { NAME_TYPE: ${literal(row.nameType)}, SCHEMA: ${literal(row.schema)}, NAME: ${literal(row.name)}, ` +
            `COLUMN_NAME: ${literal(row.columnName)}, SQL_STATEMENT_TYPE: ${literal(row.statementType)} },`
        );
      }
      out.push('    ],');
    }
    out.push('  ],');
  }
} finally {
  await closeGlobalPool();
}
out.push(']);', '');
writeFileSync(outFile, out.join('\n'));
console.log(`Recorded ${statements.length} statements in tests/fixtures/parseStatementRows.ts`);
