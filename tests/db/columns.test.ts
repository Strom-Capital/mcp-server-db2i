import { describe, expect, it } from 'vitest';
import { kindFromOdbcType, kindFromTypeName, normalizeValue, rowFromObject } from '../../src/db/columns.js';
import type { DbColumn } from '../../src/db/driver.js';

function column(kind: DbColumn['kind'], dbType: string, precision?: number): DbColumn {
  return { name: 'C', kind, dbType, precision };
}

describe('kindFromTypeName', () => {
  it('maps Db2 and JDBC type names', () => {
    expect(kindFromTypeName('INTEGER')).toBe('int');
    expect(kindFromTypeName('smallint')).toBe('int');
    expect(kindFromTypeName('BIGINT')).toBe('bigint');
    expect(kindFromTypeName('DECIMAL')).toBe('decimal');
    expect(kindFromTypeName('NUMERIC(9, 2)')).toBe('decimal');
    expect(kindFromTypeName('DECFLOAT')).toBe('decimal');
    expect(kindFromTypeName('DOUBLE')).toBe('float');
    expect(kindFromTypeName('DATE')).toBe('date');
    expect(kindFromTypeName('TIME')).toBe('time');
    expect(kindFromTypeName('TIMESTAMP(6)')).toBe('timestamp');
    expect(kindFromTypeName('VARCHAR')).toBe('string');
    expect(kindFromTypeName('GRAPHIC')).toBe('string');
    expect(kindFromTypeName('CHAR () FOR BIT DATA')).toBe('binary');
    expect(kindFromTypeName('VARBINARY')).toBe('binary');
    expect(kindFromTypeName('BOOLEAN')).toBe('other');
  });

  it('uses the ODBC type code when the name is unknown', () => {
    expect(kindFromOdbcType(3, 'DECIMAL')).toBe('decimal');
    expect(kindFromOdbcType(-5, '')).toBe('bigint');
    expect(kindFromOdbcType(93, 'SOMETHING')).toBe('timestamp');
    expect(kindFromOdbcType(9999)).toBe('other');
  });
});

describe('normalizeValue', () => {
  it('keeps null and turns undefined into null', () => {
    expect(normalizeValue(null, column('string', 'VARCHAR'))).toBeNull();
    expect(normalizeValue(undefined, column('int', 'INTEGER'))).toBeNull();
  });

  it('turns integers into numbers and wide ones into exact text', () => {
    expect(normalizeValue('42', column('int', 'INTEGER'))).toBe(42);
    expect(normalizeValue(42n, column('bigint', 'BIGINT'))).toBe(42);
    expect(normalizeValue(9007199254740993n, column('bigint', 'BIGINT'))).toBe('9007199254740993');
    expect(normalizeValue('+9007199254740993', column('bigint', 'BIGINT'))).toBe('9007199254740993');
  });

  it('keeps decimals exact: numbers up to 15 digits, text beyond', () => {
    expect(normalizeValue('1234.50', column('decimal', 'DECIMAL', 9))).toBe(1234.5);
    expect(normalizeValue(' -0.25 ', column('decimal', 'DECIMAL', 5))).toBe(-0.25);
    expect(normalizeValue('12345678901234567890.12', column('decimal', 'DECIMAL', 31))).toBe(
      '12345678901234567890.12'
    );
    expect(normalizeValue('1.5', column('decimal', 'DECFLOAT', 16))).toBe('1.5');
  });

  it('reads floats from text', () => {
    expect(normalizeValue('1.5E3', column('float', 'DOUBLE'))).toBe(1500);
    expect(normalizeValue('NaN', column('float', 'DOUBLE'))).toBe('NaN');
  });

  it('removes CHAR padding but keeps VARCHAR as it is', () => {
    expect(normalizeValue('ABC   ', column('string', 'CHAR'))).toBe('ABC');
    expect(normalizeValue('ABC   ', column('string', 'GRAPHIC'))).toBe('ABC');
    expect(normalizeValue('ABC   ', column('string', 'VARCHAR'))).toBe('ABC   ');
  });

  it('writes binary data as upper-case hex', () => {
    expect(normalizeValue(Buffer.from([0x0a, 0xff]), column('binary', 'BINARY'))).toBe('0AFF');
  });

  it('puts dates, times and timestamps in one form', () => {
    expect(normalizeValue('2026-09-26-17.30.05.123456', column('timestamp', 'TIMESTAMP'))).toBe(
      '2026-09-26 17:30:05.123456'
    );
    expect(normalizeValue('2026-09-26T17:30:05', column('timestamp', 'TIMESTAMP'))).toBe('2026-09-26 17:30:05');
    expect(normalizeValue('17.30.05', column('time', 'TIME'))).toBe('17:30:05');
    expect(normalizeValue('2026-09-26', column('date', 'DATE'))).toBe('2026-09-26');
    expect(normalizeValue('09/26/26', column('date', 'DATE'))).toBe('09/26/26');
    expect(normalizeValue(new Date(Date.UTC(2026, 8, 26, 17, 30, 5, 7)), column('timestamp', 'TIMESTAMP'))).toBe(
      '2026-09-26 17:30:05.007'
    );
  });

  it('builds a row array in column order', () => {
    const columns: DbColumn[] = [
      { name: 'ORDERNO', kind: 'int', dbType: 'INTEGER' },
      { name: 'ITEMNO', kind: 'string', dbType: 'CHAR' },
    ];
    expect(rowFromObject({ ITEMNO: 'A1  ', ORDERNO: '1001' }, columns)).toEqual([1001, 'A1']);
  });
});
