/**
 * Mapepire job pool, run against a fake JobFactory so it covers any transport.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SQLJob } from '@ibm/mapepire-js';
import { JobPool, describeMapepireError, type JobFactory } from '../../src/db/drivers/mapepire.js';

interface FakeJob {
  id: number;
  status: string;
  /** Pages of rows: execute returns the first, fetchMore the rest. */
  pages: Array<Record<string, unknown>[]>;
  /** Resolve to release a query that is waiting. */
  gate?: Promise<void>;
  /** Thrown by the next execute. */
  error?: Error;
  /** False once the server process is gone. */
  connected: boolean;
  closed: boolean;
  queryClosed: number;
}

function fakeFactory() {
  const jobs: FakeJob[] = [];
  const deadListeners: Array<() => void> = [];
  let startGate: Promise<void> | undefined;
  let failNextStart = false;

  const factory: JobFactory & { closed: boolean; closeCount: number } = {
    closed: false,
    closeCount: 0,
    async start() {
      const job: FakeJob = {
        id: jobs.length + 1,
        status: 'ready',
        pages: [[{ JOB: jobs.length + 1 }]],
        connected: true,
        closed: false,
        queryClosed: 0,
      };
      jobs.push(job);
      if (startGate) {
        await startGate;
      }
      if (failNextStart) {
        failNextStart = false;
        throw new Error('startup failed');
      }
      const handle = {
        getStatus: () => job.status,
        getTransport: () => ({ isConnected: () => job.connected }),
        query: () => {
          let page = 0;
          const result = () => ({ data: job.pages[page], is_done: page === job.pages.length - 1 });
          return {
            async execute() {
              if (job.gate) {
                await job.gate;
              }
              if (job.error) {
                const error = job.error;
                job.error = undefined;
                throw error;
              }
              return result();
            },
            async fetchMore() {
              page += 1;
              return result();
            },
            async close() {
              job.queryClosed += 1;
              return {};
            },
          };
        },
        async close() {
          job.closed = true;
          job.status = 'ended';
          job.connected = false;
        },
      };
      return handle as unknown as SQLJob;
    },
    async close() {
      factory.closed = true;
      factory.closeCount += 1;
    },
    onDead(listener) {
      deadListeners.push(listener);
    },
  };

  return {
    factory,
    jobs,
    holdStarts() {
      let release!: () => void;
      startGate = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        startGate = undefined;
        release();
      };
    },
    failNextStart() {
      failNextStart = true;
    },
    kill() {
      for (const listener of deadListeners) listener();
    },
  };
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe('JobPool', () => {
  let pool: JobPool | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await pool?.close();
    pool = undefined;
  });

  it('starts no job until the first query, then reuses the idle job', async () => {
    const fake = fakeFactory();
    pool = new JobPool(fake.factory, { maxJobs: 2, idleTimeout: 60_000, requestTimeout: 60_000 });
    expect(pool.size).toBe(0);
    await pool.query('SELECT 1 FROM SYSIBM.SYSDUMMY1', []);
    await pool.query('SELECT 2 FROM SYSIBM.SYSDUMMY1', []);
    expect(fake.jobs).toHaveLength(1);
  });

  it('starts one job for parallel queries while it is still starting', async () => {
    const fake = fakeFactory();
    pool = new JobPool(fake.factory, { maxJobs: 1, idleTimeout: 60_000, requestTimeout: 60_000 });
    const release = fake.holdStarts();
    const queries = [1, 2, 3].map((n) => pool!.query(`SELECT ${n} FROM SYSIBM.SYSDUMMY1`, []));
    release();
    await Promise.all(queries);
    expect(fake.jobs).toHaveLength(1);
  });

  it('starts a second job for a query that arrives while the first is busy, up to maxJobs', async () => {
    const fake = fakeFactory();
    pool = new JobPool(fake.factory, { maxJobs: 2, idleTimeout: 60_000, requestTimeout: 60_000 });
    await pool.query('SELECT 1 FROM SYSIBM.SYSDUMMY1', []);
    const busy = gate();
    fake.jobs[0].gate = busy.promise;

    const first = pool.query('SELECT 1 FROM SYSIBM.SYSDUMMY1', []);
    const second = pool.query('SELECT 2 FROM SYSIBM.SYSDUMMY1', []);
    await expect(second).resolves.toEqual([{ JOB: 2 }]);
    expect(fake.jobs).toHaveLength(2);

    // Both jobs busy and at the cap: further queries share the jobs.
    const busy2 = gate();
    fake.jobs[1].gate = busy2.promise;
    const third = pool.query('SELECT 3 FROM SYSIBM.SYSDUMMY1', []);
    const fourth = pool.query('SELECT 4 FROM SYSIBM.SYSDUMMY1', []);
    expect(fake.jobs).toHaveLength(2);
    busy.open();
    busy2.open();
    await expect(first).resolves.toEqual([{ JOB: 1 }]);
    await expect(Promise.all([third, fourth])).resolves.toHaveLength(2);
    expect(fake.jobs).toHaveLength(2);
  });

  it('reads every page of a result', async () => {
    const fake = fakeFactory();
    pool = new JobPool(fake.factory, { maxJobs: 1, idleTimeout: 60_000, requestTimeout: 60_000 });
    await pool.query('SELECT 1 FROM SYSIBM.SYSDUMMY1', []);
    fake.jobs[0].pages = [[{ N: 1 }, { N: 2 }], [{ N: 3 }], [{ N: 4 }]];
    await expect(pool.query('SELECT N FROM T', [])).resolves.toEqual([{ N: 1 }, { N: 2 }, { N: 3 }, { N: 4 }]);
  });

  it('forgets a job that failed to start so the next query tries again', async () => {
    const fake = fakeFactory();
    pool = new JobPool(fake.factory, { maxJobs: 1, idleTimeout: 60_000, requestTimeout: 60_000 });
    fake.failNextStart();
    await expect(pool.query('SELECT 1 FROM SYSIBM.SYSDUMMY1', [])).rejects.toThrow('startup failed');
    expect(pool.size).toBe(0);
    await expect(pool.query('SELECT 1 FROM SYSIBM.SYSDUMMY1', [])).resolves.toEqual([{ JOB: 2 }]);
  });

  it('starts fresh jobs after the transport drops', async () => {
    const fake = fakeFactory();
    pool = new JobPool(fake.factory, { maxJobs: 1, idleTimeout: 60_000, requestTimeout: 60_000 });
    await pool.query('SELECT 1 FROM SYSIBM.SYSDUMMY1', []);
    fake.kill();
    expect(pool.size).toBe(0);
    await expect(pool.query('SELECT 1 FROM SYSIBM.SYSDUMMY1', [])).resolves.toEqual([{ JOB: 2 }]);
  });

  it('closes idle jobs after idleTimeout, and the transport with the last one', async () => {
    vi.useFakeTimers();
    const fake = fakeFactory();
    pool = new JobPool(fake.factory, { maxJobs: 2, idleTimeout: 5_000, requestTimeout: 60_000 });
    await pool.query('SELECT 1 FROM SYSIBM.SYSDUMMY1', []);
    const busy = gate();
    fake.jobs[0].gate = busy.promise;
    const first = pool.query('SELECT 1 FROM SYSIBM.SYSDUMMY1', []);
    await pool.query('SELECT 2 FROM SYSIBM.SYSDUMMY1', []);
    busy.open();
    await first;
    expect(pool.size).toBe(2);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(pool.size).toBe(0);
    expect(fake.jobs[0].closed).toBe(true);
    expect(fake.jobs[1].closed).toBe(true);
    expect(fake.factory.closeCount).toBe(1);

    // The next query starts a job again.
    await expect(pool.query('SELECT 3 FROM SYSIBM.SYSDUMMY1', [])).resolves.toEqual([{ JOB: 3 }]);
  });

  it('keeps a job that is still in use past idleTimeout', async () => {
    vi.useFakeTimers();
    const fake = fakeFactory();
    pool = new JobPool(fake.factory, { maxJobs: 1, idleTimeout: 5_000, requestTimeout: 60_000 });
    await pool.query('SELECT 1 FROM SYSIBM.SYSDUMMY1', []);
    const busy = gate();
    fake.jobs[0].gate = busy.promise;
    const running = pool.query('SELECT 1 FROM SYSIBM.SYSDUMMY1', []);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pool.size).toBe(1);
    expect(fake.factory.closeCount).toBe(0);
    busy.open();
    await running;
  });

  it('closes a job whose request outlives requestTimeout, and starts a new one', async () => {
    vi.useFakeTimers();
    const fake = fakeFactory();
    pool = new JobPool(fake.factory, { maxJobs: 1, idleTimeout: 600_000, requestTimeout: 2_000 });
    await pool.query('SELECT 1 FROM SYSIBM.SYSDUMMY1', []);
    fake.jobs[0].gate = new Promise(() => undefined);

    const hung = pool.query('SELECT 1 FROM SYSIBM.SYSDUMMY1', []);
    const assertion = expect(hung).rejects.toThrow('requestTimeout');
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    expect(pool.size).toBe(0);
    expect(fake.jobs[0].closed).toBe(true);

    await expect(pool.query('SELECT 2 FROM SYSIBM.SYSDUMMY1', [])).resolves.toEqual([{ JOB: 2 }]);
  });

  it('keeps a job after an SQL error', async () => {
    const fake = fakeFactory();
    pool = new JobPool(fake.factory, { maxJobs: 1, idleTimeout: 60_000, requestTimeout: 60_000 });
    await pool.query('SELECT 1 FROM SYSIBM.SYSDUMMY1', []);
    fake.jobs[0].error = new Error('Table not found, 42704, -204');
    await expect(pool.query('SELECT * FROM MYLIB.MISSING', [])).rejects.toThrow('[42704] Table not found');
    expect(pool.size).toBe(1);
    expect(fake.jobs[0].closed).toBe(false);
  });

  it('drops a job whose server process exited, even while mapepire-js still reports it busy', async () => {
    const fake = fakeFactory();
    pool = new JobPool(fake.factory, { maxJobs: 1, idleTimeout: 60_000, requestTimeout: 60_000 });
    await pool.query('SELECT 1 FROM SYSIBM.SYSDUMMY1', []);
    fake.jobs[0].status = 'busy';
    fake.jobs[0].connected = false;
    fake.jobs[0].error = new Error('Connection failed with code 1');
    await expect(pool.query('SELECT 1 FROM SYSIBM.SYSDUMMY1', [])).rejects.toThrow('Connection failed');
    expect(pool.size).toBe(0);
    await expect(pool.query('SELECT 1 FROM SYSIBM.SYSDUMMY1', [])).resolves.toEqual([{ JOB: 2 }]);
  });

  it('closes every job and the transport', async () => {
    const fake = fakeFactory();
    const local = new JobPool(fake.factory, { maxJobs: 1, idleTimeout: 60_000, requestTimeout: 60_000 });
    await local.query('SELECT 1 FROM SYSIBM.SYSDUMMY1', []);
    await local.close();
    expect(fake.jobs[0].closed).toBe(true);
    expect(fake.factory.closed).toBe(true);
    await expect(local.query('SELECT 1 FROM SYSIBM.SYSDUMMY1', [])).rejects.toThrow('closed');
  });
});

describe('describeMapepireError', () => {
  it('moves the SQLSTATE to the front and drops the SQLCODE', () => {
    expect(describeMapepireError(new Error('Table not found, 42704, -204'))).toBe('[42704] Table not found');
  });

  it('keeps commas inside the message', () => {
    expect(describeMapepireError(new Error('A, B, and C, 22001, -302'))).toBe('[22001] A, B, and C');
  });

  it('leaves other errors alone', () => {
    expect(describeMapepireError(new Error('SSH connection failed'))).toBe('SSH connection failed');
    expect(describeMapepireError('plain')).toBe('plain');
  });
});
