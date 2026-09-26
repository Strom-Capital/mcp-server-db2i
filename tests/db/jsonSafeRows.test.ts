import { describe, expect, it } from 'vitest';

import { roundedColumnsWarnings, toJsonSafeRows } from '../../src/db/driver.js';

describe('toJsonSafeRows', () => {
  it('turns a bigint within the safe range into a number', () => {
    const rows = toJsonSafeRows([
      { N: 1n, NEG: -42n, MAX: BigInt(Number.MAX_SAFE_INTEGER), MIN: BigInt(Number.MIN_SAFE_INTEGER) },
    ]);
    expect(rows).toEqual([
      { N: 1, NEG: -42, MAX: Number.MAX_SAFE_INTEGER, MIN: Number.MIN_SAFE_INTEGER },
    ]);
  });

  it('turns a bigint outside the safe range into an exact string', () => {
    const rows = toJsonSafeRows([
      {
        ABOVE: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        BELOW: BigInt(Number.MIN_SAFE_INTEGER) - 1n,
        MAX: 9223372036854775807n,
        MIN: -9223372036854775808n,
      },
    ]);
    expect(rows).toEqual([
      {
        ABOVE: '9007199254740992',
        BELOW: '-9007199254740992',
        MAX: '9223372036854775807',
        MIN: '-9223372036854775808',
      },
    ]);
    expect(() => JSON.stringify(rows)).not.toThrow();
  });

  it('turns binary values into upper-case hex', () => {
    const bytes = new Uint8Array([0x00, 0x0a, 0xff, 0x10]);
    const rows = toJsonSafeRows([
      {
        BUFFER: bytes.buffer,
        VIEW: bytes.subarray(1, 3),
        NODE: Buffer.from([0xab, 0xcd]),
        EMPTY: new ArrayBuffer(0),
      },
    ]);
    expect(rows).toEqual([{ BUFFER: '000AFF10', VIEW: '0AFF', NODE: 'ABCD', EMPTY: '' }]);
  });

  it('leaves other values alone', () => {
    const date = new Date('2024-01-15T00:00:00Z');
    const row = { ORDERNO: 1001, ITEMNO: 'A-1', PRICE: '12.50', SHIPPED: null, CREATED: date };
    expect(toJsonSafeRows([{ ...row }])).toEqual([row]);
  });

  it('handles an empty result', () => {
    expect(toJsonSafeRows([])).toEqual([]);
  });
});

describe('roundedColumnsWarnings', () => {
  it('names the rounded columns and how to keep every digit', () => {
    const [warning] = roundedColumnsWarnings(['W', 'TOTAL']) ?? [];
    expect(warning).toMatch(/^The ODBC driver rounds DECIMAL and NUMERIC values past 15 digits, so the values in W, TOTAL are not exact\./);
    expect(warning).toContain('CAST(<column> AS VARCHAR(40))');
    expect(warning).toContain('jt400 or mapepire');
  });

  it('leaves out masked columns', () => {
    expect(roundedColumnsWarnings(['W', 'total'], new Set(['TOTAL']))?.[0]).toContain('values in W are');
    expect(roundedColumnsWarnings(['TOTAL'], new Set(['TOTAL']))).toBeUndefined();
  });

  it('returns nothing when no column was rounded', () => {
    expect(roundedColumnsWarnings(undefined)).toBeUndefined();
    expect(roundedColumnsWarnings([])).toBeUndefined();
  });
});
