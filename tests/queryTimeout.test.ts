import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getQueryTimeoutSeconds, queryTimeoutMs, type DB2iConfig } from '../src/config.js';
import { CANCEL_GRACE_MS, QueryTimeoutError, withQueryTimeout } from '../src/db/driver.js';

const config = { driver: 'odbc' } as DB2iConfig;

describe('QUERY_TIMEOUT', () => {
  const original = process.env.QUERY_TIMEOUT;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.QUERY_TIMEOUT;
    } else {
      process.env.QUERY_TIMEOUT = original;
    }
  });

  it('defaults to 120 seconds', () => {
    delete process.env.QUERY_TIMEOUT;
    expect(getQueryTimeoutSeconds()).toBe(120);
    expect(queryTimeoutMs(config)).toBe(120_000);
  });

  it('accepts 0, which turns the limit off', () => {
    process.env.QUERY_TIMEOUT = '0';
    expect(queryTimeoutMs(config)).toBe(0);
  });

  it('refuses a negative, fractional or too large value', () => {
    for (const value of ['-1', '1.5', 'ten', '86401']) {
      process.env.QUERY_TIMEOUT = value;
      expect(() => getQueryTimeoutSeconds()).toThrow(/QUERY_TIMEOUT/);
    }
  });

  it('lets a profile queryTimeout win, including 0', () => {
    process.env.QUERY_TIMEOUT = '60';
    expect(queryTimeoutMs({ ...config, queryTimeout: 5 })).toBe(5_000);
    expect(queryTimeoutMs({ ...config, queryTimeout: 0 })).toBe(0);
    expect(queryTimeoutMs(config)).toBe(60_000);
  });
});

describe('QueryTimeoutError', () => {
  it('says the query was cancelled, and how to narrow it', () => {
    const error = new QueryTimeoutError(5_000, true);
    expect(error.message).toBe(
      'Query cancelled on the IBM i after 5 seconds (QUERY_TIMEOUT). Narrow the filter, or add a condition on an indexed column.'
    );
  });

  it('says a statement that could not be cancelled may still be running', () => {
    const cause = new Error('not authorized');
    const error = new QueryTimeoutError(120_000, false, { cause });
    expect(error.message).toMatch(/^Query stopped after 120 seconds \(QUERY_TIMEOUT\), but it could not be cancelled and may still be running on the IBM i\./);
    expect(error.cause).toBe(cause);
  });
});

describe('withQueryTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it('returns the execution itself when there is no limit', () => {
    const execution = Promise.resolve([1]);
    expect(withQueryTimeout(execution, 0, vi.fn())).toBe(execution);
  });

  it('settles with a statement that ends in time and never cancels', async () => {
    const run = deferred<number[]>();
    const cancel = vi.fn(async () => undefined);
    const result = withQueryTimeout(run.promise, 1_000, cancel);
    run.resolve([1]);
    await expect(result).resolves.toEqual([1]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('passes a statement error through unchanged', async () => {
    const run = deferred<number[]>();
    const result = withQueryTimeout(run.promise, 1_000, vi.fn(async () => undefined));
    run.reject(new Error('SQL0204'));
    await expect(result).rejects.toThrow('SQL0204');
  });

  it('cancels at the limit and rejects once the statement has ended, even with rows', async () => {
    const run = deferred<number[]>();
    const cancel = vi.fn(async () => undefined);
    const result = withQueryTimeout(run.promise, 1_000, cancel);
    const outcome = result.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(999);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(cancel).toHaveBeenCalledTimes(1);

    // A cancelled QCMDEXC wait returns -1 rather than an error
    run.resolve([-1]);
    const error = await outcome;
    expect(error).toBeInstanceOf(QueryTimeoutError);
    expect((error as QueryTimeoutError).cancelled).toBe(true);
  });

  it('stops waiting CANCEL_GRACE_MS after a cancel the statement does not answer', async () => {
    const run = deferred<number[]>();
    const outcome = withQueryTimeout(run.promise, 1_000, vi.fn(async () => undefined)).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000 + CANCEL_GRACE_MS);
    const error = await outcome;
    expect(error).toBeInstanceOf(QueryTimeoutError);
    expect((error as QueryTimeoutError).cancelled).toBe(true);
  });

  it('rejects at once when the cancel fails, and ignores a late statement failure', async () => {
    const run = deferred<number[]>();
    const refused = new Error('[42501] not authorized to CANCEL_SQL');
    const outcome = withQueryTimeout(run.promise, 1_000, vi.fn(async () => {
      throw refused;
    })).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(QueryTimeoutError);
    expect((error as QueryTimeoutError).cancelled).toBe(false);
    expect((error as QueryTimeoutError).cause).toBe(refused);

    // Observed by withQueryTimeout, so this is not an unhandled rejection
    run.reject(new Error('connection lost'));
    await vi.advanceTimersByTimeAsync(0);
  });
});
