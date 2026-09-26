/**
 * Row cursors on each driver, run against small fakes of the driver packages.
 * Every cursor must hand out batches in column order, end with null, release
 * its connection or job exactly once, and cancel the statement on abort.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQLJob } from '@ibm/mapepire-js';
import type { DB2iConfig, DbDriverName } from '../../src/config.js';

const state = vi.hoisted(() => ({
  odbc: {
    batches: [] as Array<Record<string, unknown>[]>,
    columns: [] as Array<{ name: string; dataType: number; dataTypeName: string; columnSize: number; decimalDigits: number }>,
    queryError: undefined as Error | undefined,
    hang: false,
    release: undefined as (() => void) | undefined,
    cancels: 0,
    cursorCloses: 0,
    connectionCloses: 0,
    lastOptions: undefined as Record<string, unknown> | undefined,
  },
  jt400: {
    rows: [] as unknown[][],
    metadata: [] as Array<{ name: string; typeName: string; precision: number; scale: number }>,
    executeError: undefined as Error | undefined,
    statementCloses: 0,
    transactionsSettled: 0,
    queries: [] as string[],
  },
}));

vi.mock('odbc', () => ({
  pool: vi.fn(async () => ({
    async query() {
      return [];
    },
    async close() {},
    async connect() {
      return {
        async query(_sql: string, _params: unknown[], options: Record<string, unknown>) {
          state.odbc.lastOptions = options;
          if (state.odbc.hang) {
            await new Promise<void>((resolve) => {
              state.odbc.release = resolve;
            });
            throw Object.assign(new Error('cancelled'), {
              odbcErrors: [{ state: 'HY008', code: 0, message: 'Operation canceled' }],
            });
          }
          if (state.odbc.queryError) {
            throw state.odbc.queryError;
          }
          let index = 0;
          const cursor = {
            get noData() {
              return index >= state.odbc.batches.length;
            },
            async fetch() {
              const rows = state.odbc.batches[index] ?? [];
              index += 1;
              return Object.assign([...rows], { columns: state.odbc.columns, count: rows.length });
            },
            async close() {
              state.odbc.cursorCloses += 1;
            },
          };
          return cursor;
        },
        async cancel() {
          state.odbc.cancels += 1;
          state.odbc.release?.();
        },
        async close() {
          state.odbc.connectionCloses += 1;
        },
      };
    },
  })),
}));

vi.mock('node-jt400', () => ({
  pool: vi.fn(() => {
    const connection = {
      async query(sql: string) {
        state.jt400.queries.push(sql);
        if (sql === 'VALUES QSYS2.JOB_NAME') {
          return [{ '00001': '123456/QUSER/QZDASOINIT' }];
        }
        return [];
      },
      async update() {
        return 0;
      },
      async execute() {
        if (state.jt400.executeError) {
          throw state.jt400.executeError;
        }
        let index = 0;
        return {
          async metadata() {
            return state.jt400.metadata;
          },
          asIterable() {
            return {
              [Symbol.asyncIterator]() {
                return {
                  async next() {
                    const value = state.jt400.rows[index];
                    index += 1;
                    return value ? { done: false, value } : { done: true, value: undefined };
                  },
                };
              },
            };
          },
          close() {
            state.jt400.statementCloses += 1;
          },
        };
      },
    };
    return {
      ...connection,
      async transaction<T>(fn: (c: typeof connection) => Promise<T>) {
        try {
          return await fn(connection);
        } finally {
          state.jt400.transactionsSettled += 1;
        }
      },
      async close() {},
    };
  }),
}));

function config(driver: DbDriverName): DB2iConfig {
  return {
    hostname: 'ibmi.example.com',
    port: 446,
    username: 'TESTUSER',
    password: 'secret',
    database: '*LOCAL',
    schema: 'MYLIB',
    driver,
    jdbcOptions: {},
    odbcOptions: {},
    mapepireOptions: {},
  };
}

async function drain(cursor: { next(): Promise<unknown[][] | null> }): Promise<unknown[][]> {
  const rows: unknown[][] = [];
  for (let batch = await cursor.next(); batch; batch = await cursor.next()) {
    rows.push(...batch);
  }
  return rows;
}

describe('odbc cursor', () => {
  beforeEach(() => {
    Object.assign(state.odbc, {
      batches: [
        [{ ORDERNO: 1001, ITEMNO: 'A1  ' }],
        [{ ORDERNO: 1002, ITEMNO: 'B2  ' }],
      ],
      columns: [
        { name: 'ORDERNO', dataType: 4, dataTypeName: 'INTEGER', columnSize: 10, decimalDigits: 0 },
        { name: 'ITEMNO', dataType: 1, dataTypeName: 'CHAR', columnSize: 4, decimalDigits: 0 },
      ],
      queryError: undefined,
      hang: false,
      release: undefined,
      cancels: 0,
      cursorCloses: 0,
      connectionCloses: 0,
    });
  });

  async function pool() {
    const { odbcDriver } = await import('../../src/db/drivers/odbc.js');
    return odbcDriver.createPool(config('odbc'), { readOnly: true });
  }

  it('reads every batch in column order and closes once', async () => {
    const db = await pool();
    const cursor = await db.openCursor!('SELECT ORDERNO, ITEMNO FROM MYLIB.ORDERS', [], { fetchSize: 1 });

    expect(cursor.columns.map((c) => [c.name, c.kind])).toEqual([
      ['ORDERNO', 'int'],
      ['ITEMNO', 'string'],
    ]);
    expect(state.odbc.lastOptions).toEqual({ cursor: true, fetchSize: 1 });
    expect(await drain(cursor)).toEqual([
      [1001, 'A1'],
      [1002, 'B2'],
    ]);
    await cursor.close();
    await cursor.close();
    expect(state.odbc.cursorCloses).toBe(1);
    expect(state.odbc.connectionCloses).toBe(1);
  });

  it('closes the connection when the query fails', async () => {
    state.odbc.queryError = Object.assign(new Error('failed'), {
      odbcErrors: [{ state: '42704', code: -204, message: 'ORDERS in MYLIB type *FILE not found.' }],
    });
    const db = await pool();

    await expect(db.openCursor!('SELECT * FROM MYLIB.ORDERS', [], { fetchSize: 10 })).rejects.toThrow(/42704/);
    expect(state.odbc.connectionCloses).toBe(1);
  });

  it('cancels the running statement on abort', async () => {
    state.odbc.hang = true;
    const db = await pool();
    const controller = new AbortController();

    const opening = db.openCursor!('SELECT * FROM MYLIB.ORDERS', [], { fetchSize: 10, signal: controller.signal });
    await vi.waitFor(() => expect(state.odbc.release).toBeDefined());
    controller.abort();

    await expect(opening).rejects.toThrow(/HY008/);
    expect(state.odbc.cancels).toBe(1);
    expect(state.odbc.connectionCloses).toBe(1);
  });
});

describe('openQueryCursor', () => {
  beforeEach(() => {
    Object.assign(state.odbc, {
      batches: [[{ ORDERNO: 1001 }]],
      columns: [{ name: 'ORDERNO', dataType: 4, dataTypeName: 'INTEGER', columnSize: 10, decimalDigits: 0 }],
      queryError: undefined,
      hang: false,
      connectionCloses: 0,
    });
  });

  it('reads through the connection manager and reports Db2 errors like executeQuery', async () => {
    const connection = await import('../../src/db/connection.js');
    connection.initializePool(config('odbc'));

    const cursor = await connection.openQueryCursor('SELECT ORDERNO FROM MYLIB.ORDERS', [], undefined, {
      fetchSize: 100,
      timeoutMs: 0,
    });
    expect(await drain(cursor)).toEqual([[1001]]);
    await cursor.close();

    state.odbc.queryError = Object.assign(new Error('failed'), {
      odbcErrors: [{ state: '42S02', code: -204, message: 'ORDERS in MYLIB type *FILE not found.' }],
    });
    await expect(
      connection.openQueryCursor('SELECT * FROM MYLIB.ORDERS', [], undefined, { fetchSize: 100, timeoutMs: 0 })
    ).rejects.toThrow(/^Database query failed: \[42S02\]/);
    await connection.closeGlobalPool();
  });
});

describe('jt400 cursor', () => {
  beforeEach(() => {
    Object.assign(state.jt400, {
      rows: [
        ['1001', '12.50', '2026-09-26-17.30.05.000000'],
        ['1002', null, '2026-09-27-08.00.00.000000'],
        ['1003', '0.10', '2026-09-28-09.15.00.000000'],
      ],
      metadata: [
        { name: 'ORDERNO', typeName: 'INTEGER', precision: 10, scale: 0 },
        { name: 'AMOUNT', typeName: 'DECIMAL', precision: 9, scale: 2 },
        { name: 'CREATED', typeName: 'TIMESTAMP', precision: 26, scale: 6 },
      ],
      executeError: undefined,
      statementCloses: 0,
      transactionsSettled: 0,
      queries: [],
    });
  });

  async function pool() {
    const { jt400Driver } = await import('../../src/db/drivers/jt400.js');
    return jt400Driver.createPool(config('jt400'), { readOnly: true });
  }

  it('converts text values by column type, batches rows, and settles the transaction on close', async () => {
    const db = await pool();
    const cancelJob = vi.fn(async () => undefined);
    const cursor = await db.openCursor!('SELECT * FROM MYLIB.ORDERS', [], { fetchSize: 2, cancelJob });

    expect(state.jt400.queries).toContain('VALUES QSYS2.JOB_NAME');
    expect(await cursor.next()).toEqual([
      [1001, 12.5, '2026-09-26 17:30:05.000000'],
      [1002, null, '2026-09-27 08:00:00.000000'],
    ]);
    expect(await cursor.next()).toEqual([[1003, 0.1, '2026-09-28 09:15:00.000000']]);
    expect(await cursor.next()).toBeNull();
    expect(state.jt400.transactionsSettled).toBe(0);

    await cursor.close();
    expect(state.jt400.statementCloses).toBe(1);
    expect(state.jt400.transactionsSettled).toBe(1);
    expect(cancelJob).not.toHaveBeenCalled();
  });

  it('rejects the open, and does not hang, when execute fails', async () => {
    state.jt400.executeError = new Error('[SQL0204] ORDERS in MYLIB type *FILE not found.');
    const db = await pool();

    await expect(db.openCursor!('SELECT * FROM MYLIB.ORDERS', [], { fetchSize: 10 })).rejects.toThrow(/SQL0204/);
    expect(state.jt400.transactionsSettled).toBe(1);
  });

  it('cancels with the job name on abort', async () => {
    const db = await pool();
    const controller = new AbortController();
    const cancelJob = vi.fn(async () => undefined);
    const cursor = await db.openCursor!('SELECT * FROM MYLIB.ORDERS', [], {
      fetchSize: 10,
      cancelJob,
      signal: controller.signal,
    });

    controller.abort();
    expect(cancelJob).toHaveBeenCalledWith('123456/QUSER/QZDASOINIT');
    await cursor.close();
  });
});

describe('mapepire cursor', () => {
  interface FakeJob {
    id: string;
    connected: boolean;
    closed: boolean;
    queryCloses: number;
    pages: Array<Record<string, unknown>[]>;
    error?: Error;
  }

  async function pool(maxJobs = 2) {
    const { JobPool } = await import('../../src/db/drivers/mapepire.js');
    const jobs: FakeJob[] = [];
    const factory = {
      async start() {
        const job: FakeJob = {
          id: `00000${jobs.length + 1}/QUSER/QZDASOINIT`,
          connected: true,
          closed: false,
          queryCloses: 0,
          pages: [[{ ORDERNO: '1001' }], [{ ORDERNO: '1002' }]],
        };
        jobs.push(job);
        return {
          get id() {
            return job.id;
          },
          getStatus: () => (job.closed ? 'ended' : 'ready'),
          getTransport: () => ({ isConnected: () => job.connected }),
          query() {
            let page = 0;
            const result = () => ({
              data: job.pages[page],
              is_done: page === job.pages.length - 1,
              metadata: { column_count: 1, columns: [{ name: 'ORDERNO', label: 'ORDERNO', type: 'INTEGER', precision: 10, scale: 0 }] },
            });
            return {
              async execute() {
                if (job.error) {
                  throw job.error;
                }
                return result();
              },
              async fetchMore() {
                page += 1;
                return result();
              },
              async close() {
                job.queryCloses += 1;
              },
            };
          },
          async close() {
            job.closed = true;
          },
        } as unknown as SQLJob;
      },
      async close() {},
      onDead() {},
    };
    const jobPool = new JobPool(factory, { maxJobs, idleTimeout: 60_000, requestTimeout: 5_000 });
    return { jobPool, jobs };
  }

  it('reads every page and keeps the job busy until close', async () => {
    const { jobPool } = await pool();
    const cursor = await jobPool.openCursor('SELECT ORDERNO FROM MYLIB.ORDERS', [], { fetchSize: 1 });

    expect(await drain(cursor)).toEqual([[1001], [1002]]);
    // The job is still taken, so a second cursor starts another job
    const second = await jobPool.openCursor('SELECT ORDERNO FROM MYLIB.ORDERS', [], { fetchSize: 1 });
    expect(jobPool.size).toBe(2);
    await second.close();
    await cursor.close();
    await cursor.close();
    await jobPool.close();
  });

  it('never shares a busy job', async () => {
    const { jobPool } = await pool(1);
    const cursor = await jobPool.openCursor('SELECT ORDERNO FROM MYLIB.ORDERS', [], { fetchSize: 1 });

    await expect(jobPool.openCursor('SELECT ORDERNO FROM MYLIB.ORDERS', [], { fetchSize: 1 })).rejects.toThrow(
      /jobs are busy/
    );
    await cursor.close();
    const again = await jobPool.openCursor('SELECT ORDERNO FROM MYLIB.ORDERS', [], { fetchSize: 1 });
    await again.close();
    await jobPool.close();
  });

  it('closes an unfinished query, and drops the job when the cancel failed', async () => {
    const { jobPool, jobs } = await pool();
    const controller = new AbortController();
    const cancelJob = vi.fn(async () => {
      throw new Error('[42501] Not authorized to QSYS2.CANCEL_SQL');
    });
    const cursor = await jobPool.openCursor('SELECT ORDERNO FROM MYLIB.ORDERS', [], {
      fetchSize: 1,
      cancelJob,
      signal: controller.signal,
    });

    controller.abort();
    await vi.waitFor(() => expect(cancelJob).toHaveBeenCalledWith(jobs[0].id));
    await cursor.close();

    expect(jobs[0].closed).toBe(true);
    expect(jobPool.size).toBe(0);
    await jobPool.close();
  });

  it('releases the job when execute fails', async () => {
    const { jobPool, jobs } = await pool(1);
    const first = await jobPool.openCursor('SELECT ORDERNO FROM MYLIB.ORDERS', [], { fetchSize: 1 });
    await first.close();
    jobs[0].error = new Error('ORDERS in MYLIB type *FILE not found., 42704, -204');

    await expect(jobPool.openCursor('SELECT * FROM MYLIB.ORDERS', [], { fetchSize: 1 })).rejects.toThrow(/42704/);
    jobs[0].error = undefined;
    const again = await jobPool.openCursor('SELECT ORDERNO FROM MYLIB.ORDERS', [], { fetchSize: 1 });
    await again.close();
    await jobPool.close();
  });
});
