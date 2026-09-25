import { describe, expect, it } from 'vitest';

import { toJsonSafeRows } from '../../src/db/driver.js';

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

  it('leaves other values alone', () => {
    const date = new Date('2024-01-15T00:00:00Z');
    const row = { ORDERNO: 1001, ITEMNO: 'A-1', PRICE: '12.50', SHIPPED: null, CREATED: date };
    expect(toJsonSafeRows([{ ...row }])).toEqual([row]);
  });

  it('handles an empty result', () => {
    expect(toJsonSafeRows([])).toEqual([]);
  });
});
