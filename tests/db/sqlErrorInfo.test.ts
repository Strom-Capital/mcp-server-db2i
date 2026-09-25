import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DbError, type DbPool } from '../../src/db/driver.js';
import {
  clearSqlErrorCache,
  DatabaseQueryError,
  explainSqlError,
  LOOKUP_TIMEOUT_MS,
  MAX_PART_LENGTH,
  splitSecondLevelText,
  sqlErrorFields,
} from '../../src/db/sqlErrorInfo.js';

// The shape SYSTOOLS.SQLCODE_INFO returns for SQL0204, shortened
const SQL0204_TEXT =
  'Cause . . . . . :   &1 in &2 type *&3 was not found.  The function will not be found ' +
  'unless the external name and usage name match exactly. Recovery  . . . :   Change the name ' +
  'and try the request again.';

function fakePool(query: DbPool['query']): DbPool & { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn(query), close: vi.fn(async () => undefined) };
}

function sql0204(): DbError {
  return new DbError('[42704] [SQL0204] ORDERS in MYLIB type *FILE not found.', { sqlstate: '42704', sqlcode: -204 });
}

describe('splitSecondLevelText', () => {
  it('splits on Cause and Recovery and removes the dot leaders', () => {
    expect(splitSecondLevelText(SQL0204_TEXT)).toEqual({
      lead: '',
      cause:
        '&1 in &2 type *&3 was not found. The function will not be found unless the external name and usage name match exactly.',
      recovery: 'Change the name and try the request again.',
    });
  });

  it('returns the text before the first heading as the lead', () => {
    const text = `[SQL0204] ORDERS in MYLIB type *FILE not found. ${SQL0204_TEXT}`;
    expect(splitSecondLevelText(text).lead).toBe('[SQL0204] ORDERS in MYLIB type *FILE not found.');
  });

  it('ends the recovery at a Technical description heading', () => {
    const text = 'Cause . . . . . :   A. Recovery  . . . :   B. Technical description . . . . . . . . :   C.';
    expect(splitSecondLevelText(text)).toEqual({ lead: '', cause: 'A.', recovery: 'B.' });
  });

  it('returns no parts for text without headings', () => {
    expect(splitSecondLevelText('Token . was not valid.')).toEqual({ lead: 'Token . was not valid.' });
  });

  it('cuts a long part at a word boundary', () => {
    const long = `Cause . . . . . :   ${'word '.repeat(MAX_PART_LENGTH)}`;
    const { cause } = splitSecondLevelText(long);
    expect(cause!.length).toBeLessThanOrEqual(MAX_PART_LENGTH);
    expect(cause!.endsWith('word…')).toBe(true);
  });
});

describe('explainSqlError', () => {
  beforeEach(() => {
    clearSqlErrorCache();
  });

  it('adds cause and recovery from SQLCODE_INFO', async () => {
    const pool = fakePool(async () => [{ MESSAGE_SECOND_LEVEL_TEXT: SQL0204_TEXT }]);
    const { message, details } = await explainSqlError(sql0204(), pool, 'PROD');

    expect(message).toBe('[42704] [SQL0204] ORDERS in MYLIB type *FILE not found.');
    expect(details).toMatchObject({
      sqlstate: '42704',
      sqlcode: -204,
      recovery: 'Change the name and try the request again.',
    });
    expect(details.cause).toMatch(/^&1 in &2 type \*&3 was not found\./);
    const [sql, params, options] = pool.query.mock.calls[0] as [string, unknown[], { timeoutMs: number }];
    expect(sql).toContain('SYSTOOLS.SQLCODE_INFO(?)');
    expect(params).toEqual([-204]);
    expect(options.timeoutMs).toBe(LOOKUP_TIMEOUT_MS);
  });

  it('looks each SQLCODE up once per system', async () => {
    const pool = fakePool(async () => [{ MESSAGE_SECOND_LEVEL_TEXT: SQL0204_TEXT }]);
    await Promise.all([explainSqlError(sql0204(), pool, 'PROD'), explainSqlError(sql0204(), pool, 'PROD')]);
    await explainSqlError(sql0204(), pool, 'PROD');
    expect(pool.query).toHaveBeenCalledTimes(1);

    await explainSqlError(sql0204(), pool, 'TEST');
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('returns the original error when the lookup fails, and tries again next time', async () => {
    const pool = fakePool(async () => {
      throw new Error('[08S01] Communication link failure');
    });
    const { message, details } = await explainSqlError(sql0204(), pool, 'PROD');
    expect(message).toBe('[42704] [SQL0204] ORDERS in MYLIB type *FILE not found.');
    expect(details).toEqual({ sqlstate: '42704', sqlcode: -204 });

    await explainSqlError(sql0204(), pool, 'PROD');
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('stops asking a system that has no SQLCODE_INFO', async () => {
    const pool = fakePool(async () => {
      throw new Error('[42704] [SQL0204] SQLCODE_INFO in SYSTOOLS type *N not found.');
    });
    const first = await explainSqlError(sql0204(), pool, 'OLD');
    const other = new DbError('[42601] [SQL0104] Token . was not valid.', { sqlstate: '42601', sqlcode: -104 });
    const second = await explainSqlError(other, pool, 'OLD');

    expect(first.details).toEqual({ sqlstate: '42704', sqlcode: -204 });
    expect(second.details).toEqual({ sqlstate: '42601', sqlcode: -104 });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('adds nothing when SQLCODE_INFO returns no text', async () => {
    const pool = fakePool(async () => []);
    const { details } = await explainSqlError(sql0204(), pool, 'PROD');
    expect(details).toEqual({ sqlstate: '42704', sqlcode: -204 });
  });

  it('splits text the message already carries (errors=full) without a lookup', async () => {
    const pool = fakePool(async () => []);
    const error = new DbError(
      '[42704] [SQL0204] ORDERS in MYLIB type *FILE not found. Cause . . . . . :   ORDERS in MYLIB type *FILE was not found. Recovery  . . . :   Change the name.',
      { sqlstate: '42704', sqlcode: -204 }
    );
    const { message, details } = await explainSqlError(error, pool, 'PROD');

    expect(message).toBe('[42704] [SQL0204] ORDERS in MYLIB type *FILE not found.');
    expect(details).toEqual({
      sqlstate: '42704',
      sqlcode: -204,
      cause: 'ORDERS in MYLIB type *FILE was not found.',
      recovery: 'Change the name.',
    });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('passes other errors through without a lookup', async () => {
    const pool = fakePool(async () => []);
    expect(await explainSqlError(new Error('Mapepire pool is closed'), pool, 'PROD')).toEqual({
      message: 'Mapepire pool is closed',
      details: {},
    });
    const noCode = new DbError('[08001] Communication link failure', { sqlstate: '08001' });
    expect((await explainSqlError(noCode, pool, 'PROD')).details).toEqual({ sqlstate: '08001' });
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('sqlErrorFields', () => {
  it('reads the details from the error or its cause', () => {
    const error = new DatabaseQueryError('Database query failed: x', { sqlstate: '42704', sqlcode: -204, recovery: 'R' });
    expect(sqlErrorFields(error)).toEqual({ sqlstate: '42704', sqlcode: -204, recovery: 'R' });
    expect(sqlErrorFields(new Error('wrapped', { cause: error }))).toEqual({
      sqlstate: '42704',
      sqlcode: -204,
      recovery: 'R',
    });
  });

  it('returns nothing for errors that did not come from Db2', () => {
    expect(sqlErrorFields(new Error('Query rejected'))).toEqual({});
    expect(sqlErrorFields('plain')).toEqual({});
  });
});
