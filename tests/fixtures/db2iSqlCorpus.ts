/**
 * Db2 for i statements the way assistants write them, for the security validator and the
 * schema allowlist. Each entry says what the checks must decide, so a change that rejects
 * valid Db2 for i, or lets a write through, fails a test.
 *
 * Generic names only (MYLIB, OUTSIDELIB, ORDERS, ORDERHDR, CUSTOMERS). The allowlist tests
 * use MYLIB, QSYS2 and SYSIBM as allowed schemas and MYLIB as the default schema.
 *
 * When an assistant hits a rejection in a real deployment, add the reduced statement here
 * instead of fixing one construct in isolation.
 */

export interface CorpusEntry {
  name: string;
  sql: string;
  /** Whether the security validator must accept it. */
  validator: 'accept' | 'reject';
  /**
   * What the JavaScript allowlist parser decides with MYLIB, QSYS2 and SYSIBM allowed.
   * `unparseable` marks valid Db2 for i that the parser cannot read yet: a known gap.
   * Omitted for statements the validator rejects.
   */
  allowlist?: 'accept' | 'deny' | 'unparseable';
  /**
   * What the allowlist decides from IBM i's parsed names, when it differs from `allowlist`
   * (an `unparseable` statement is otherwise expected to be accepted).
   */
  parsedAllowlist?: 'accept' | 'deny';
}

export const DB2I_SQL_CORPUS: readonly CorpusEntry[] = [
  // Valid read-only Db2 for i
  { name: 'plain select', sql: 'SELECT ORDERNO, ITEMNO FROM MYLIB.ORDERS WHERE ORDERNO = 1001', validator: 'accept', allowlist: 'accept' },
  { name: 'unqualified table', sql: 'SELECT ORDERNO FROM ORDERS', validator: 'accept', allowlist: 'accept' },
  {
    name: 'window frame',
    sql: 'SELECT ORDERNO, SUM(QTY) OVER (PARTITION BY ITEMNO ORDER BY ORDERNO ROWS UNBOUNDED PRECEDING) AS CUM FROM MYLIB.ORDERS',
    validator: 'accept',
    allowlist: 'accept',
  },
  {
    name: 'window frame in a CTE with an alias the MySQL grammar reserves',
    sql: 'WITH C AS (SELECT ORDERNO, SUM(QTY) OVER (PARTITION BY ITEMNO ORDER BY ORDERNO ROWS UNBOUNDED PRECEDING) AS CUM FROM MYLIB.ORDERS) SELECT COUNT(*) AS LINES FROM C',
    validator: 'accept',
    allowlist: 'unparseable',
  },
  {
    name: 'LISTAGG WITHIN GROUP',
    sql: "SELECT ITEMNO, LISTAGG(CHAR(ORDERNO), ',') WITHIN GROUP (ORDER BY ORDERNO) AS L FROM MYLIB.ORDERS GROUP BY ITEMNO",
    validator: 'accept',
    allowlist: 'unparseable',
  },
  { name: 'REPLACE function', sql: "SELECT REPLACE(ITEMNO, '-', '') AS I FROM MYLIB.ORDERS", validator: 'accept', allowlist: 'accept' },
  { name: 'REGEXP_SUBSTR', sql: "SELECT REGEXP_SUBSTR(ITEMNO, '[0-9]{3,6}') AS N FROM MYLIB.ORDERS", validator: 'accept', allowlist: 'accept' },
  {
    name: 'VALUES list joined to a table',
    sql: "SELECT O.ORDERNO FROM (VALUES ('1001', 'A'), ('1002', 'B')) AS P (ORDERNO, SERIAL) JOIN MYLIB.ORDERS O ON O.ORDERNO = P.ORDERNO",
    validator: 'accept',
    allowlist: 'unparseable',
  },
  { name: 'bare VALUES', sql: 'VALUES 1', validator: 'accept', allowlist: 'unparseable' },
  {
    name: 'parenthesized UNION',
    sql: '(SELECT ORDERNO FROM MYLIB.ORDERS) UNION (SELECT ORDERNO FROM MYLIB.ORDERHDR)',
    validator: 'accept',
    allowlist: 'accept',
  },
  {
    name: 'WITH column list',
    sql: 'WITH C (A, B) AS (SELECT ORDERNO, ITEMNO FROM MYLIB.ORDERS) SELECT A FROM C',
    validator: 'accept',
    allowlist: 'accept',
  },
  {
    name: 'recursive CTE',
    sql: 'WITH R (N) AS (SELECT 1 FROM SYSIBM.SYSDUMMY1 UNION ALL SELECT N + 1 FROM R WHERE N < 5) SELECT N FROM R',
    validator: 'accept',
    allowlist: 'accept',
  },
  {
    name: 'LATERAL',
    sql: 'SELECT C.CUSTNO, L.ORDERNO FROM MYLIB.CUSTOMERS C, LATERAL (SELECT ORDERNO FROM MYLIB.ORDERS O WHERE O.CUSTNO = C.CUSTNO FETCH FIRST 1 ROW ONLY) L',
    validator: 'accept',
    allowlist: 'unparseable',
  },
  {
    name: 'GROUPING SETS',
    sql: 'SELECT ITEMNO, CUSTNO, SUM(QTY) FROM MYLIB.ORDERS GROUP BY GROUPING SETS ((ITEMNO), (CUSTNO), ())',
    validator: 'accept',
    allowlist: 'unparseable',
  },
  {
    name: 'ROLLUP',
    sql: 'SELECT ITEMNO, CUSTNO, SUM(QTY) FROM MYLIB.ORDERS GROUP BY ROLLUP (ITEMNO, CUSTNO)',
    validator: 'accept',
    allowlist: 'accept',
  },
  {
    name: 'labeled duration on a special register',
    sql: 'SELECT ORDERNO FROM MYLIB.ORDERS WHERE ORDERDATE > CURRENT DATE - 30 DAYS',
    validator: 'accept',
    allowlist: 'accept',
  },
  { name: 'labeled duration on a column', sql: 'SELECT ORDERDATE + 30 DAYS AS DUE FROM MYLIB.ORDERS', validator: 'accept', allowlist: 'accept' },
  {
    name: 'qualified table function with a named argument',
    sql: "SELECT JOB_NAME FROM TABLE(QSYS2.ACTIVE_JOB_INFO(DETAILED_INFO => 'NONE')) X",
    validator: 'accept',
    allowlist: 'accept',
  },
  { name: 'columns named like statements', sql: 'SELECT START, STOP, LOCK, LOAD, DUMP, KILL FROM MYLIB.ORDERS', validator: 'accept', allowlist: 'accept' },
  { name: 'quoted column named START', sql: 'SELECT "START" FROM MYLIB.ORDERS', validator: 'accept', allowlist: 'accept' },
  { name: 'quoted column named DELETE', sql: 'SELECT "DELETE" FROM MYLIB.ORDERS', validator: 'accept', allowlist: 'accept' },
  { name: 'column alias LAST_UPDATE', sql: 'SELECT ORDERNO AS LAST_UPDATE FROM MYLIB.ORDERS', validator: 'accept', allowlist: 'accept' },
  {
    name: 'EXISTS in WHERE',
    sql: 'SELECT ORDERNO FROM MYLIB.ORDERHDR H WHERE EXISTS (SELECT 1 FROM MYLIB.ORDERS L WHERE L.ORDERNO = H.ORDERNO)',
    validator: 'accept',
    allowlist: 'accept',
  },
  {
    name: 'scalar subquery',
    sql: 'SELECT H.ORDERNO, (SELECT MIN(ITEMNO) FROM MYLIB.ORDERS L WHERE L.ORDERNO = H.ORDERNO) AS I FROM MYLIB.ORDERHDR H',
    validator: 'accept',
    allowlist: 'accept',
  },
  { name: 'LIKE with concatenation', sql: "SELECT ORDERNO FROM MYLIB.ORDERS WHERE ITEMNO LIKE '%' || 'A' || '%'", validator: 'accept', allowlist: 'accept' },
  { name: 'CAST with CCSID', sql: 'SELECT CAST(ITEMNO AS VARCHAR(20) CCSID 1208) FROM MYLIB.ORDERS', validator: 'accept', allowlist: 'accept' },
  { name: 'special registers', sql: 'SELECT CURRENT TIMESTAMP, CURRENT USER FROM SYSIBM.SYSDUMMY1', validator: 'accept', allowlist: 'accept' },
  {
    name: 'OLAP ranking',
    sql: 'SELECT ORDERNO, RANK() OVER (ORDER BY QTY DESC) R, LAG(QTY) OVER (ORDER BY ORDERNO) P FROM MYLIB.ORDERS',
    validator: 'accept',
    allowlist: 'accept',
  },
  { name: 'trailing semicolon', sql: 'SELECT ORDERNO FROM MYLIB.ORDERS;', validator: 'accept', allowlist: 'accept' },
  { name: 'FOR READ ONLY', sql: 'SELECT ORDERNO FROM MYLIB.ORDERS FOR READ ONLY', validator: 'accept', allowlist: 'unparseable' },

  // Read-only, but outside the allowlist
  { name: 'outside library', sql: 'SELECT * FROM OUTSIDELIB.ORDERS', validator: 'accept', allowlist: 'deny' },
  { name: 'outside library in a CTE', sql: 'WITH C AS (SELECT * FROM OUTSIDELIB.ORDERS) SELECT * FROM C', validator: 'accept', allowlist: 'deny' },
  {
    name: 'outside library in EXISTS',
    sql: 'SELECT 1 FROM MYLIB.ORDERS O WHERE EXISTS (SELECT 1 FROM OUTSIDELIB.ORDERS X WHERE X.ORDERNO = O.ORDERNO)',
    validator: 'accept',
    allowlist: 'deny',
  },
  {
    name: 'outside library in a scalar subquery',
    sql: 'SELECT (SELECT MAX(ORDERNO) FROM OUTSIDELIB.ORDERS) FROM SYSIBM.SYSDUMMY1',
    validator: 'accept',
    allowlist: 'deny',
  },
  { name: 'outside function', sql: 'SELECT OUTSIDELIB.MYFN(ORDERNO) FROM MYLIB.ORDERS', validator: 'accept', allowlist: 'deny' },
  { name: 'outside table function', sql: 'SELECT * FROM TABLE(OUTSIDELIB.MYTF(1)) X', validator: 'accept', allowlist: 'deny' },
  {
    name: 'CTE named like a table it hides',
    sql: 'WITH ORDERS AS (SELECT * FROM OUTSIDELIB.ORDERS) SELECT * FROM ORDERS',
    validator: 'accept',
    allowlist: 'deny',
  },
  {
    name: 'outside library in a UNION',
    sql: 'SELECT ORDERNO FROM MYLIB.ORDERS UNION ALL SELECT ORDERNO FROM OUTSIDELIB.ORDERS',
    validator: 'accept',
    allowlist: 'deny',
  },

  {
    name: 'unqualified table function',
    sql: "SELECT ENTRY_DATA FROM TABLE(DISPLAY_JOURNAL('OUTSIDELIB', 'QSQJRN')) J",
    validator: 'accept',
    allowlist: 'unparseable',
    parsedAllowlist: 'deny',
  },
  {
    name: 'unqualified table function in LATERAL',
    sql: 'SELECT O.ORDERNO FROM MYLIB.ORDERS O, LATERAL (SELECT * FROM TABLE(ACTIVE_JOB_INFO()) Z) Y',
    validator: 'accept',
    allowlist: 'unparseable',
    parsedAllowlist: 'deny',
  },
  {
    name: 'unqualified table function in lowercase',
    sql: "select entry_data from table(display_journal('OUTSIDELIB', 'QSQJRN')) j",
    validator: 'accept',
    allowlist: 'unparseable',
    parsedAllowlist: 'deny',
  },
  { name: 'outside sequence', sql: 'SELECT NEXT VALUE FOR OUTSIDELIB.SEQ FROM MYLIB.ORDERS', validator: 'accept', allowlist: 'unparseable', parsedAllowlist: 'deny' },
  { name: 'outside user-defined type', sql: 'SELECT CAST(ORDERNO AS OUTSIDELIB.UDT) FROM MYLIB.ORDERS', validator: 'accept', allowlist: 'unparseable', parsedAllowlist: 'deny' },

  // Writes and side effects
  { name: 'INSERT', sql: "INSERT INTO MYLIB.ORDERS (ORDERNO) VALUES (1)", validator: 'reject' },
  { name: 'UPDATE', sql: "UPDATE MYLIB.ORDERS SET ITEMNO = 'X' WHERE ORDERNO = 1", validator: 'reject' },
  { name: 'UPDATE with an alias', sql: "UPDATE MYLIB.ORDERS AS O SET O.ITEMNO = 'X'", validator: 'reject' },
  { name: 'DELETE', sql: 'DELETE FROM MYLIB.ORDERS', validator: 'reject' },
  { name: 'MERGE', sql: 'MERGE INTO MYLIB.ORDERS T USING MYLIB.ORDERHDR S ON T.ORDERNO = S.ORDERNO WHEN MATCHED THEN DELETE', validator: 'reject' },
  { name: 'DROP', sql: 'DROP TABLE MYLIB.ORDERS', validator: 'reject' },
  { name: 'CALL', sql: "CALL QSYS2.QCMDEXC('DLTLIB MYLIB')", validator: 'reject' },
  { name: 'SET', sql: 'SET CURRENT SCHEMA = OUTSIDELIB', validator: 'reject' },
  { name: 'LOCK TABLE', sql: 'LOCK TABLE MYLIB.ORDERS IN EXCLUSIVE MODE', validator: 'reject' },
  { name: 'COMMIT', sql: 'COMMIT', validator: 'reject' },
  {
    name: 'data-change table reference',
    sql: 'SELECT * FROM FINAL TABLE (INSERT INTO MYLIB.ORDERS (ORDERNO) VALUES (1))',
    validator: 'reject',
  },
  {
    name: 'data-change table reference with UPDATE',
    sql: "SELECT * FROM OLD TABLE (UPDATE MYLIB.ORDERS SET ITEMNO = 'X')",
    validator: 'reject',
  },
  {
    name: 'data-change table reference in a CTE',
    sql: 'WITH D AS (SELECT * FROM OLD TABLE (DELETE FROM MYLIB.ORDERS)) SELECT COUNT(*) FROM D',
    validator: 'reject',
  },
  { name: 'data-change table reference with DELETE and no FROM', sql: 'SELECT * FROM OLD TABLE (DELETE MYLIB.ORDERS)', validator: 'reject' },
  { name: 'QCMDEXC function', sql: "SELECT QSYS2.QCMDEXC('DLTLIB MYLIB') FROM SYSIBM.SYSDUMMY1", validator: 'reject' },
  { name: 'HTTP service', sql: "SELECT QSYS2.HTTP_GET('https://ibmi.example.com', '') FROM SYSIBM.SYSDUMMY1", validator: 'reject' },
  { name: 'second statement', sql: 'SELECT 1 FROM SYSIBM.SYSDUMMY1; DELETE FROM MYLIB.ORDERS', validator: 'reject' },
  { name: 'second SELECT statement', sql: 'SELECT 1 FROM SYSIBM.SYSDUMMY1; SELECT 2 FROM SYSIBM.SYSDUMMY1', validator: 'reject' },
  { name: 'second statement after a comment', sql: 'SELECT 1 FROM SYSIBM.SYSDUMMY1 /* x */ ; DROP TABLE MYLIB.ORDERS', validator: 'reject' },
  { name: 'write in parentheses', sql: '(DELETE FROM MYLIB.ORDERS)', validator: 'reject' },
];
