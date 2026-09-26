/**
 * Driver contract test.
 *
 * Runs the connection manager against a fake of each driver package and
 * checks the behaviour every driver must share: positional parameter binding,
 * the read-only default on the query connection, a separate connection
 * without the read-only setting for QSYS2.GENERATE_SQL, retry after a failed
 * pool creation, shutdown, and the statement time limit (QUERY_TIMEOUT).
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { DB2iConfig, DbDriverName } from '../../src/config.js';
import type { DbTarget } from '../../src/systems.js';

interface FakePool {
  query: Mock<(...args: unknown[]) => Promise<unknown>>;
  close: Mock<() => Promise<undefined>>;
}

// One shared registry for both fakes: every pool created, with the settings it
// was created from, in creation order.
const created = vi.hoisted(() => ({
  jt400: [] as Array<{ config: Record<string, string>; pool: FakePool }>,
  odbc: [] as Array<{ connectionString: string; options: Record<string, unknown>; pool: FakePool }>,
  // mapepire: one entry per started job, which is what a query runs on.
  mapepire: [] as Array<{ jdbcOptions: Record<string, string>; pool: FakePool }>,
  sshClients: [] as Array<{ config: Record<string, unknown>; end: Mock<() => void> }>,
  failNext: { jt400: false, odbc: false, mapepire: false },
  rows: [] as Record<string, unknown>[],
  // jt400: a fixed result for execute(), for duplicate column names
  jt400Result: undefined as { columns: string[]; rows: unknown[][] } | undefined,
  jt400MetadataFails: false,
  jt400Closes: 0,
  // jt400: statements run through execute(), in order
  jt400Executed: [] as string[],
  // Column definitions the odbc fake reports with each result
  odbcColumns: [] as Array<Record<string, unknown>>,
  // Statement time limit: the next statement waits until something cancels it
  hangNext: false,
  hanging: [] as Array<(rows: Record<string, unknown>[]) => void>,
  cancelFails: false,
  odbcCancels: 0,
}));

const JOB_NAME = '123456/QUSER/QZDASOINIT';
const CANCEL_REFUSED = '[42501] Not authorized to QSYS2.CANCEL_SQL';

/** End every waiting statement the way a cancelled QCMDEXC wait ends: with -1. */
function finishHanging(): void {
  for (const finish of created.hanging.splice(0)) {
    finish([{ '00001': -1 }]);
  }
}

function makeFakePool(): FakePool {
  return {
    query: vi.fn(async (sql: unknown) => {
      if (sql === 'CALL QSYS2.CANCEL_SQL(?)') {
        if (created.cancelFails) {
          throw new Error(CANCEL_REFUSED);
        }
        finishHanging();
        return [];
      }
      if (sql === 'VALUES QSYS2.JOB_NAME') {
        return [{ '00001': JOB_NAME }];
      }
      if (created.hangNext) {
        created.hangNext = false;
        return new Promise((resolve) => {
          created.hanging.push(resolve);
        });
      }
      return created.rows;
    }),
    close: vi.fn(async () => undefined),
  };
}

vi.mock('node-jt400', () => ({
  pool: vi.fn((config: Record<string, string>) => {
    if (created.failNext.jt400) {
      created.failNext.jt400 = false;
      throw new Error('jt400 pool failed');
    }
    const pool = makeFakePool();
    created.jt400.push({ config, pool });
    // transaction() keeps one connection for its callback
    // update() is executeUpdate, for a CALL without a result set; it logs to query
    const update = vi.fn(async (sql: string, params: unknown[]) => {
      await pool.query(sql, params);
      return 0;
    });
    // Like JT400, reading a CALL without a result set as a query fails after the CALL ran
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      const rows = await pool.query(sql, params);
      if (sql === 'CALL QSYS2.CANCEL_SQL(?)') {
        throw new Error('Cursor state not valid.');
      }
      return rows;
    });
    // execute() prepares the statement; it runs through the pool's query fake
    // so tests see one call log. Columns come from the row keys unless a test
    // sets created.jt400Result.
    const execute = vi.fn(async (sql: string, params: unknown[]) => {
      created.jt400Executed.push(sql);
      const rows = (await pool.query(sql, params)) as Record<string, unknown>[];
      const fixed = created.jt400Result;
      const names = fixed ? fixed.columns : Object.keys(rows[0] ?? {});
      return {
        metadata: vi.fn(async () => {
          if (created.jt400MetadataFails) {
            throw new Error('metadata failed');
          }
          return names.map((name) => ({ name, typeName: 'VARCHAR', precision: 0, scale: 0 }));
        }),
        asArray: vi.fn(async () => fixed?.rows ?? rows.map((row) => names.map((name) => row[name]))),
        close: vi.fn(() => {
          created.jt400Closes += 1;
        }),
      };
    });
    return {
      query,
      update,
      execute,
      close: pool.close,
      transaction: vi.fn(
        async (fn: (t: { query: typeof query; update: typeof update; execute: typeof execute }) => Promise<unknown>) =>
          fn({ query, update, execute })
      ),
    };
  }),
}));

vi.mock('odbc', () => ({
  pool: vi.fn(async (options: { connectionString: string } & Record<string, unknown>) => {
    if (created.failNext.odbc) {
      created.failNext.odbc = false;
      const error = new Error('odbc pool failed') as Error & { odbcErrors: unknown[] };
      error.odbcErrors = [{ state: '08001', code: -1, message: 'Communication link failure' }];
      throw error;
    }
    const inner = makeFakePool();
    // node-odbc returns an Array with extra properties; the fake mimics that.
    const pool = {
      query: vi.fn(async (...args: unknown[]) => {
        const rows = (await inner.query(...args)) as Record<string, unknown>[];
        const result = Object.assign([...rows], {
          count: rows.length,
          columns: created.odbcColumns,
          statement: args[0],
          parameters: args[1],
          return: undefined,
        });
        return result;
      }),
      close: inner.close,
      // One connection per statement when a time limit is set; its statement
      // runs through the pool's query fake so tests see one call log.
      connect: vi.fn(async () => ({
        async createStatement() {
          let sql = '';
          let params: unknown[] = [];
          return {
            async prepare(text: string) {
              sql = text;
            },
            async bind(values: unknown[]) {
              params = values;
            },
            execute: () => pool.query(sql, params),
            async cancel() {
              created.odbcCancels += 1;
              if (created.cancelFails) {
                throw new Error('[HY008] Operation canceled failed');
              }
              finishHanging();
            },
            async close() {},
          };
        },
        async close() {},
      })),
    };
    created.odbc.push({ connectionString: options.connectionString, options, pool: pool as FakePool });
    return pool;
  }),
}));

vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('node:events');
  class Client extends EventEmitter {
    end = vi.fn(() => {
      setImmediate(() => this.emit('close'));
    });
    connect(config: Record<string, unknown>) {
      created.sshClients.push({ config, end: this.end });
      setImmediate(() => this.emit('ready'));
      return this;
    }
  }
  return { Client };
});

vi.mock('@ibm/mapepire-js', () => ({
  createSSH2Connection: vi.fn(() => ({ exec: vi.fn(), upload: vi.fn() })),
  SQLJob: {
    withConfig: vi.fn((_config: unknown, jdbcOptions: Record<string, string>) => {
      const pool = makeFakePool();
      let status = 'notStarted';
      return {
        id: undefined as string | undefined,
        async connect() {
          if (created.failNext.mapepire) {
            created.failNext.mapepire = false;
            throw new Error('mapepire job failed to start');
          }
          status = 'ready';
          this.id = JOB_NAME;
          created.mapepire.push({ jdbcOptions, pool });
          return { success: true };
        },
        getStatus: () => status,
        getTransport: () => ({ isConnected: () => status === 'ready' }),
        query(sql: string, opts: { parameters?: unknown[] }) {
          return {
            async execute() {
              const rows = await pool.query(sql, opts.parameters ?? []);
              return { data: rows, is_done: true };
            },
            async fetchMore() {
              return { data: [], is_done: true };
            },
            async close() {
              return { success: true };
            },
          };
        },
        async close() {
          status = 'ended';
          await pool.close();
        },
      };
    }),
  },
}));

type Connection = typeof import('../../src/db/connection.js');

function target(poolKey: string, system: string, config: DB2iConfig): DbTarget {
  return { poolKey, system, config };
}

function baseConfig(driver: DbDriverName): DB2iConfig {
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
    // The fake ssh2 client never presents a key; skip reading known_hosts.
    mapepireOptions: driver === 'mapepire' ? { insecureHostKey: 'true' } : {},
  };
}

/** Per-driver view of the fakes so each test reads the same shape. */
interface DriverProbe {
  name: DbDriverName;
  pools(): FakePool[];
  isReadOnly(index: number): boolean;
  failNext(): void;
  /** A failed statement, shaped the way this driver's package reports it. */
  sqlError(sqlstate: string, sqlcode: number, text: string): Error;
}

const probes: DriverProbe[] = [
  {
    name: 'jt400',
    pools: () => created.jt400.map((c) => c.pool),
    isReadOnly: (i) => created.jt400[i].config['access'] === 'read only',
    failNext: () => {
      created.failNext.jt400 = true;
    },
    // node-jt400: Oops error, then node-java's error, then the Java SQLException
    sqlError: (sqlstate, sqlcode, text) =>
      new Error(`[SQL${String(-sqlcode).padStart(4, '0')}] ${text}`, {
        cause: new Error('Error running instance method', {
          cause: { getSQLStateSync: () => sqlstate, getErrorCodeSync: () => sqlcode },
        }),
      }),
  },
  {
    name: 'odbc',
    pools: () => created.odbc.map((c) => c.pool),
    isReadOnly: (i) => /(^|;)CONNTYPE=2(;|$)/.test(created.odbc[i].connectionString),
    failNext: () => {
      created.failNext.odbc = true;
    },
    sqlError: (sqlstate, sqlcode, text) =>
      Object.assign(new Error('[odbc] Error executing the sql statement'), {
        odbcErrors: [{ state: sqlstate, code: sqlcode, message: text }],
      }),
  },
  {
    name: 'mapepire',
    pools: () => created.mapepire.map((c) => c.pool),
    isReadOnly: (i) => created.mapepire[i].jdbcOptions['access'] === 'read only',
    failNext: () => {
      created.failNext.mapepire = true;
    },
    sqlError: (sqlstate, sqlcode, text) => new Error(`${text}, ${sqlstate}, ${sqlcode}`),
  },
];

describe.each(probes)('driver contract: $name', (probe) => {
  let connection: Connection;

  beforeEach(async () => {
    created.jt400.length = 0;
    created.odbc.length = 0;
    created.mapepire.length = 0;
    created.sshClients.length = 0;
    created.failNext.jt400 = false;
    created.failNext.odbc = false;
    created.failNext.mapepire = false;
    created.rows = [{ SCHEMA_NAME: 'MYLIB', N: 1 }];
    created.hangNext = false;
    created.hanging.length = 0;
    created.cancelFails = false;
    created.odbcCancels = 0;
    // connection.ts keeps module state, so each test gets a fresh copy.
    vi.resetModules();
    connection = await import('../../src/db/connection.js');
  });

  afterEach(async () => {
    finishHanging();
    await connection.closeGlobalPool();
    await connection.closeAllSessionPools();
  });

  it('creates no connection until the first query', async () => {
    connection.initializePool(baseConfig(probe.name));
    expect(probe.pools()).toHaveLength(0);
    await connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
    expect(probe.pools()).toHaveLength(1);
  });

  it('binds positional parameters, dropping undefined and stringifying the rest', async () => {
    connection.initializePool(baseConfig(probe.name));
    const result = await connection.executeQuery(
      'SELECT * FROM T WHERE A = ? AND B = ? AND C IS ? AND D = ?',
      [1, 'a', null, undefined, true]
    );
    const [pool] = probe.pools();
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toBe('SELECT * FROM T WHERE A = ? AND B = ? AND C IS ? AND D = ?');
    expect(params).toEqual([1, 'a', null, 'true']);
    expect(result.rows).toEqual([{ SCHEMA_NAME: 'MYLIB', N: 1 }]);
    expect(Array.isArray(result.rows)).toBe(true);
    expect(Object.keys(result.rows)).toEqual(['0']);
  });

  it('opens the query connection read only and reuses it', async () => {
    connection.initializePool(baseConfig(probe.name));
    await connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
    await connection.executeQuery('SELECT 2 FROM SYSIBM.SYSDUMMY1');
    expect(probe.pools()).toHaveLength(1);
    expect(probe.isReadOnly(0)).toBe(true);
  });

  it('runs procedures on a second connection without the read-only setting', async () => {
    connection.initializePool(baseConfig(probe.name));
    await connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
    await connection.executeProcedure("CALL QSYS2.GENERATE_SQL('T', 'MYLIB', 'TABLE')");
    await connection.executeProcedure("CALL QSYS2.GENERATE_SQL('V', 'MYLIB', 'VIEW')");

    const pools = probe.pools();
    expect(pools).toHaveLength(2);
    expect(probe.isReadOnly(0)).toBe(true);
    expect(probe.isReadOnly(1)).toBe(false);
    expect(pools[0].query).toHaveBeenCalledTimes(1);
    expect(pools[1].query).toHaveBeenCalledTimes(2);
  });

  it('retries pool creation after a failure', async () => {
    connection.initializePool(baseConfig(probe.name));
    probe.failNext();
    await expect(connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1')).rejects.toThrow(
      /^Database query failed: /
    );
    expect(probe.pools()).toHaveLength(0);

    const result = await connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
    expect(result.rows).toHaveLength(1);
    expect(probe.pools()).toHaveLength(1);
  });

  it('wraps driver errors from a query', async () => {
    connection.initializePool(baseConfig(probe.name));
    await connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
    const [pool] = probe.pools();
    pool.query.mockRejectedValueOnce(new Error('SQL0204 not found'));
    await expect(connection.executeQuery('SELECT * FROM NOPE')).rejects.toThrow(
      'Database query failed: SQL0204 not found'
    );
  });

  it('reports the SQLSTATE, SQLCODE, cause and recovery of a failed statement', async () => {
    connection.initializePool(baseConfig(probe.name));
    await connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
    const [pool] = probe.pools();
    pool.query.mockImplementation(async (sql: unknown) => {
      if (typeof sql === 'string' && sql.includes('SQLCODE_INFO')) {
        return [{
          MESSAGE_SECOND_LEVEL_TEXT:
            'Cause . . . . . :   &1 in &2 type *&3 was not found. Recovery  . . . :   Change the name and try the request again.',
        }];
      }
      if (sql === 'VALUES QSYS2.JOB_NAME') {
        return [{ '00001': JOB_NAME }];
      }
      throw probe.sqlError('42704', -204, 'ORDERS in MYLIB type *FILE not found.');
    });

    const error = await connection.executeQuery('SELECT * FROM MYLIB.ORDERS').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^Database query failed: \[42704\] .*ORDERS in MYLIB type \*FILE not found\.$/);
    expect((error as { details?: unknown }).details).toEqual({
      sqlstate: '42704',
      sqlcode: -204,
      cause: '&1 in &2 type *&3 was not found.',
      recovery: 'Change the name and try the request again.',
    });
    const lookup = pool.query.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('SQLCODE_INFO'));
    expect(lookup?.[1]).toEqual([-204]);
  });

  it('keeps the original error when the SQLCODE lookup fails', async () => {
    connection.initializePool(baseConfig(probe.name));
    await connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
    const [pool] = probe.pools();
    pool.query.mockImplementation(async (sql: unknown) => {
      if (typeof sql === 'string' && sql.includes('SQLCODE_INFO')) {
        throw probe.sqlError('42704', -204, 'SQLCODE_INFO in SYSTOOLS type *N not found.');
      }
      if (sql === 'VALUES QSYS2.JOB_NAME') {
        return [{ '00001': JOB_NAME }];
      }
      throw probe.sqlError('42601', -104, 'Token . was not valid.');
    });

    const error = await connection.executeQuery('SELECT FROM MYLIB.ORDERS').catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/^Database query failed: \[42601\] .*Token \. was not valid\.$/);
    expect((error as { details?: unknown }).details).toEqual({ sqlstate: '42601', sqlcode: -104 });
  });

  it('returns BIGINT values as numbers, or exact strings beyond the safe range', async () => {
    connection.initializePool(baseConfig(probe.name));
    created.rows = [{ SMALL: 1n, BIG: 9007199254740993n }];
    const { rows } = await connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
    expect(rows).toEqual([{ SMALL: 1, BIG: '9007199254740993' }]);
  });

  it('closes both global connections on shutdown', async () => {
    connection.initializePool(baseConfig(probe.name));
    await connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
    await connection.executeProcedure("CALL QSYS2.GENERATE_SQL('T', 'MYLIB', 'TABLE')");
    await connection.closeGlobalPool();

    for (const pool of probe.pools()) {
      expect(pool.close).toHaveBeenCalledTimes(1);
    }
    await expect(connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1')).rejects.toThrow(
      'Global connection pool not initialized'
    );
  });

  it('lists a pool whose close is still waiting', async () => {
    connection.initializePool(baseConfig(probe.name));
    await connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
    const [pool] = probe.pools();
    let release: () => void = () => {};
    pool.close.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve(undefined);
    }));

    const closing = connection.closeGlobalPool();
    await vi.waitFor(() => expect(pool.close).toHaveBeenCalled());
    expect(connection.pendingPoolCloses()).toEqual(['Global connection pool (default)']);

    release();
    await closing;
    expect(connection.pendingPoolCloses()).toEqual([]);
  });

  it('keeps session pools separate and closes them by id', async () => {
    connection.initializeSessionPool('session-a');
    connection.initializeSessionPool('session-b');
    expect(connection.getSessionPoolCount()).toBe(2);

    const a = target('session-a', 'default', baseConfig(probe.name));
    const b = target('session-b', 'default', baseConfig(probe.name));
    await connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1', [], a);
    await connection.executeProcedure("CALL QSYS2.GENERATE_SQL('T', 'MYLIB', 'TABLE')", [], a);
    await connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1', [], b);

    const pools = probe.pools();
    expect(pools).toHaveLength(3);
    expect(probe.isReadOnly(0)).toBe(true);
    expect(probe.isReadOnly(1)).toBe(false);
    expect(probe.isReadOnly(2)).toBe(true);

    await connection.closeSessionPool('session-a');
    expect(pools[0].close).toHaveBeenCalledTimes(1);
    expect(pools[1].close).toHaveBeenCalledTimes(1);
    expect(pools[2].close).not.toHaveBeenCalled();
    expect(connection.hasSessionPool('session-a')).toBe(false);
    expect(connection.hasSessionPool('session-b')).toBe(true);
    await expect(
      connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1', [], a)
    ).rejects.toThrow('Session pool not found');
  });

  it('rejects an unknown session without creating a connection', async () => {
    await expect(
      connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1', [], target('missing', 'default', baseConfig(probe.name)))
    ).rejects.toThrow('Session pool not found');
    expect(probe.pools()).toHaveLength(0);
  });

  it('keeps one pool per system for a session and closes them together', async () => {
    connection.initializeSessionPool('session-a');
    const prod = target('session-a', 'prod', { ...baseConfig(probe.name), hostname: 'prod.example.com' });
    const test = target('session-a', 'test', { ...baseConfig(probe.name), hostname: 'test.example.com' });

    await connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1', [], prod);
    await connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1', [], test);
    await connection.executeQuery('SELECT 2 FROM SYSIBM.SYSDUMMY1', [], prod);

    const pools = probe.pools();
    expect(pools).toHaveLength(2);
    expect(connection.getSessionPoolCount()).toBe(1);

    await connection.closeSessionPool('session-a');
    expect(pools[0].close).toHaveBeenCalledTimes(1);
    expect(pools[1].close).toHaveBeenCalledTimes(1);
  });

  it('keeps stdio pools per system next to the default target', async () => {
    connection.initializePool(baseConfig(probe.name), 'prod');
    await connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
    await connection.executeQuery(
      'SELECT 1 FROM SYSIBM.SYSDUMMY1',
      [],
      target('stdio', 'prod', baseConfig(probe.name))
    );
    await connection.executeQuery(
      'SELECT 1 FROM SYSIBM.SYSDUMMY1',
      [],
      target('stdio', 'test', { ...baseConfig(probe.name), hostname: 'test.example.com' })
    );

    const pools = probe.pools();
    expect(pools).toHaveLength(2);
    await connection.closeGlobalPool();
    expect(pools[0].close).toHaveBeenCalledTimes(1);
    expect(pools[1].close).toHaveBeenCalledTimes(1);
  });
  describe('statement time limit', () => {
    // queryTimeout is in whole seconds, so these tests wait about a second each.
    const limited = (): DB2iConfig => ({ ...baseConfig(probe.name), queryTimeout: 1 });
    const canceller = probe.name === 'odbc' ? 'SQLCancel' : 'QSYS2.CANCEL_SQL';

    /** CANCEL_SQL calls, and the pools they ran on. */
    function cancelCalls(): Array<{ pool: number; params: unknown[] }> {
      return probe.pools().flatMap((pool, index) =>
        pool.query.mock.calls
          .filter(([sql]) => sql === 'CALL QSYS2.CANCEL_SQL(?)')
          .map(([, params]) => ({ pool: index, params: params as unknown[] }))
      );
    }

    it('returns the rows of a statement that ends in time', async () => {
      connection.initializePool(limited());
      const result = await connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
      expect(result.rows).toEqual([{ SCHEMA_NAME: 'MYLIB', N: 1 }]);
      expect(cancelCalls()).toEqual([]);
      expect(created.odbcCancels).toBe(0);
    });

    it(`cancels a statement that runs past the limit with ${canceller}, and the pool still works`, async () => {
      connection.initializePool(limited());
      created.hangNext = true;
      await expect(connection.executeQuery('SELECT * FROM MYLIB.ORDERS')).rejects.toThrow(
        'Database query failed: Query cancelled on the IBM i after 1 seconds (QUERY_TIMEOUT)'
      );

      if (probe.name === 'odbc') {
        expect(created.odbcCancels).toBe(1);
        expect(cancelCalls()).toEqual([]);
      } else {
        // On the connection without the read-only setting, which the CALL needs
        const calls = cancelCalls();
        expect(calls).toHaveLength(1);
        expect(calls[0].params).toEqual([JOB_NAME]);
        expect(probe.isReadOnly(calls[0].pool)).toBe(false);
      }

      const again = await connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
      expect(again.rows).toHaveLength(1);
    });

    it('says when the IBM i refused the cancel, and the pool still works', async () => {
      connection.initializePool(limited());
      created.hangNext = true;
      created.cancelFails = true;
      await expect(connection.executeQuery('SELECT * FROM MYLIB.ORDERS')).rejects.toThrow(
        /^Database query failed: Query stopped after 1 seconds \(QUERY_TIMEOUT\), but it could not be cancelled and may still be running on the IBM i\./
      );
      if (probe.name === 'mapepire') {
        // The job may still be running the statement, so it is not reused
        expect(probe.pools()[0].close).toHaveBeenCalledTimes(1);
      }

      created.cancelFails = false;
      const again = await connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
      expect(again.rows).toHaveLength(1);
    });
  });
});

describe('driver contract: jt400 specifics', () => {
  let connection: Connection;

  beforeEach(async () => {
    created.jt400.length = 0;
    created.failNext.jt400 = false;
    created.rows = [];
    created.jt400Result = undefined;
    created.jt400MetadataFails = false;
    created.jt400Closes = 0;
    created.jt400Executed = [];
    vi.resetModules();
    connection = await import('../../src/db/connection.js');
  });

  afterEach(async () => {
    await connection.closeGlobalPool();
  });

  it('reads rows through a prepared statement, so BLOB values come back as hex', async () => {
    connection.initializePool(baseConfig('jt400'));
    // asArray() returns what getString gives, which is hex for BLOB; query() would give base64
    created.rows = [{ BL: '0102', BNULL: null, C: 'a' }];
    const { rows } = await connection.executeQuery('SELECT BL, BNULL, C FROM SYSIBM.SYSDUMMY1');
    expect(rows).toEqual([{ BL: '0102', BNULL: null, C: 'a' }]);
    expect(created.jt400Executed).toEqual(['SELECT BL, BNULL, C FROM SYSIBM.SYSDUMMY1']);
    expect(created.jt400Closes).toBe(0);
  });

  it('keeps the last value of a duplicate column name, like query()', async () => {
    connection.initializePool(baseConfig('jt400'));
    created.jt400Result = { columns: ['IBMREQD', 'IBMREQD', 'N'], rows: [['Y', 'N', '1']] };
    const { rows } = await connection.executeQuery('SELECT A.IBMREQD, B.IBMREQD, 1 AS N FROM SYSIBM.SYSDUMMY1 A, SYSIBM.SYSDUMMY1 B');
    expect(rows).toEqual([{ IBMREQD: 'N', N: '1' }]);
  });

  it('closes the statement once when its metadata cannot be read', async () => {
    connection.initializePool(baseConfig('jt400'));
    created.jt400MetadataFails = true;
    await expect(connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1')).rejects.toThrow('metadata failed');
    expect(created.jt400Closes).toBe(1);
  });

  it('uses a prepared statement on the pinned connection when a time limit is set', async () => {
    connection.initializePool({ ...baseConfig('jt400'), queryTimeout: 30 });
    created.rows = [{ BL: '0102' }];
    const { rows } = await connection.executeQuery('SELECT BL FROM SYSIBM.SYSDUMMY1');
    expect(rows).toEqual([{ BL: '0102' }]);
    const [pool] = created.jt400.map((c) => c.pool);
    const sqls = pool.query.mock.calls.map(([sql]) => sql);
    expect(sqls).toEqual(['VALUES QSYS2.JOB_NAME', 'SELECT BL FROM SYSIBM.SYSDUMMY1']);
    expect(created.jt400Executed).toEqual(['SELECT BL FROM SYSIBM.SYSDUMMY1']);
  });

  it('reads the SQLCODE from the message ID when the Java exception is not available', async () => {
    connection.initializePool(baseConfig('jt400'));
    await connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
    const [pool] = created.jt400.map((c) => c.pool);
    pool.query.mockImplementation(async (sql: unknown) => {
      if (sql === 'VALUES QSYS2.JOB_NAME') {
        return [{ '00001': JOB_NAME }];
      }
      if (typeof sql === 'string' && sql.includes('SQLCODE_INFO')) {
        return [];
      }
      throw new Error('[SQL0204] ORDERS in MYLIB type *FILE not found.');
    });

    const error = await connection.executeQuery('SELECT * FROM MYLIB.ORDERS').catch((e: unknown) => e);
    expect((error as Error).message).toBe('Database query failed: [SQL0204] ORDERS in MYLIB type *FILE not found.');
    expect((error as { details?: unknown }).details).toEqual({ sqlcode: -204 });
  });
});

describe('driver contract: odbc specifics', () => {
  let connection: Connection;

  beforeEach(async () => {
    created.odbc.length = 0;
    created.failNext.odbc = false;
    created.rows = [{ N: 1 }];
    created.odbcColumns = [];
    vi.resetModules();
    connection = await import('../../src/db/connection.js');
  });

  afterEach(async () => {
    await connection.closeGlobalPool();
  });

  it('builds the connection string from the config and DB2I_ODBC_OPTIONS', async () => {
    connection.initializePool({ ...baseConfig('odbc'), odbcOptions: { SSL: '1', NAM: '0' } });
    await connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
    const { connectionString, options } = created.odbc[0];
    expect(connectionString).toBe(
      'DRIVER=IBM i Access ODBC Driver;SYSTEM=ibmi.example.com;UID=TESTUSER;PWD=secret;DFT=5;TRIMCHAR=1;CCSID=1208;CONNTYPE=2;DBQ=MYLIB;SSL=1;NAM=0'
    );
    expect(options.initialSize).toBe(1);
    expect(options.maxSize).toBeGreaterThan(1);
  });

  it('binds Date parameters as Db2 timestamps and returns plain rows', async () => {
    connection.initializePool(baseConfig('odbc'));
    const when = new Date(Date.UTC(2026, 8, 24, 13, 45, 30, 123));
    const result = await connection.executeQuery('SELECT ? FROM SYSIBM.SYSDUMMY1', [when]);
    const [, params] = created.odbc[0].pool.query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['2026-09-24 13:45:30.123000']);
    expect(Object.keys(result.rows)).toEqual(['0']);
    expect(result.rows).toEqual([{ N: 1 }]);
  });

  it('returns binary columns, which node-odbc reads as an ArrayBuffer, as upper-case hex', async () => {
    connection.initializePool(baseConfig('odbc'));
    created.rows = [{ B2: new Uint8Array([0x0a, 0xff]).buffer, EMPTY: new ArrayBuffer(0), N: null }];
    const { rows } = await connection.executeQuery('SELECT B2 FROM SYSIBM.SYSDUMMY1');
    expect(rows).toEqual([{ B2: '0AFF', EMPTY: '', N: null }]);
    expect(JSON.stringify(rows)).toBe('[{"B2":"0AFF","EMPTY":"","N":null}]');
  });

  describe('decimals node-odbc rounds', () => {
    const decimal = (name: string, columnSize: number, decimalDigits: number, dataType = 3) => ({
      name,
      dataType,
      dataTypeName: dataType === 3 ? 'DECIMAL' : 'NUMERIC',
      columnSize,
      decimalDigits,
      nullable: true,
    });

    it('names a wide DECIMAL or NUMERIC column whose value has more than 15 digits', async () => {
      connection.initializePool(baseConfig('odbc'));
      created.odbcColumns = [decimal('W', 31, 2), decimal('N', 20, 0, 2), decimal('SMALL', 31, 2)];
      created.rows = [
        { W: 12345678901234567000, N: null, SMALL: 12.5 },
        { W: null, N: 1234567890123456, SMALL: 9999999999999.99 },
      ];
      const result = await connection.executeQuery('SELECT W, N, SMALL FROM MYLIB.ORDERS');
      expect(result.roundedColumns).toEqual(['W', 'N']);
      expect(result.rows).toEqual(created.rows);
    });

    it('names nothing when every value fits in 15 digits, or there are no rows', async () => {
      connection.initializePool(baseConfig('odbc'));
      created.odbcColumns = [decimal('AMOUNT', 31, 2), decimal('NARROW', 15, 2), decimal('FRACTION', 31, 20)];
      created.rows = [{ AMOUNT: 1234567890123.45, NARROW: 1234567890123.45, FRACTION: 0.000001 }];
      expect((await connection.executeQuery('SELECT * FROM MYLIB.ORDERS')).roundedColumns).toBeUndefined();

      created.odbcColumns = [decimal('AMOUNT', 31, 2)];
      created.rows = [];
      expect((await connection.executeQuery('SELECT * FROM MYLIB.ORDERS')).roundedColumns).toBeUndefined();
    });

    it('counts the scale: a DECIMAL(31,20) value from 0.00001 up may have more than 15 digits', async () => {
      connection.initializePool(baseConfig('odbc'));
      created.odbcColumns = [decimal('FRACTION', 31, 20)];
      created.rows = [{ FRACTION: 0.00001 }];
      expect((await connection.executeQuery('SELECT * FROM MYLIB.ORDERS')).roundedColumns).toEqual(['FRACTION']);
    });

    it('names rounded columns when the statement runs with a time limit', async () => {
      connection.initializePool({ ...baseConfig('odbc'), queryTimeout: 30 });
      created.odbcColumns = [decimal('W', 31, 2)];
      created.rows = [{ W: 12345678901234567000 }];
      const result = await connection.executeQuery('SELECT W FROM MYLIB.ORDERS');
      expect(result.roundedColumns).toEqual(['W']);
      expect(result.rows).toEqual([{ W: 12345678901234567000 }]);
    });
  });

  it('surfaces the ODBC diagnostic when the pool cannot connect', async () => {
    connection.initializePool(baseConfig('odbc'));
    created.failNext.odbc = true;
    await expect(connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1')).rejects.toThrow(
      'Database query failed: [08001] Communication link failure'
    );
  });
});

describe('driver contract: loading', () => {
  it('imports only the selected driver package', async () => {
    vi.resetModules();
    const jt400 = await import('node-jt400');
    const odbc = await import('odbc');
    vi.mocked(jt400.pool).mockClear();
    vi.mocked(odbc.pool).mockClear();
    created.jt400.length = 0;
    created.odbc.length = 0;
    created.rows = [];

    const connection = await import('../../src/db/connection.js');
    connection.initializePool(baseConfig('odbc'));
    await connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
    expect(odbc.pool).toHaveBeenCalledTimes(1);
    expect(jt400.pool).not.toHaveBeenCalled();
    await connection.closeGlobalPool();
  });
});

describe('driver contract: mapepire specifics', () => {
  let connection: Connection;

  beforeEach(async () => {
    created.mapepire.length = 0;
    created.sshClients.length = 0;
    created.failNext.mapepire = false;
    created.rows = [{ N: 1 }];
    vi.resetModules();
    connection = await import('../../src/db/connection.js');
  });

  afterEach(async () => {
    await connection.closeGlobalPool();
  });

  it('opens one SSH session with the configured user, port and host key check', async () => {
    connection.initializePool({
      ...baseConfig('mapepire'),
      mapepireOptions: { insecureHostKey: 'true', sshPort: '2222' },
    });
    await connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
    await connection.executeQuery('SELECT 2 FROM SYSIBM.SYSDUMMY1');
    expect(created.sshClients).toHaveLength(1);
    const { config } = created.sshClients[0];
    expect(config).toMatchObject({
      host: 'ibmi.example.com',
      port: 2222,
      username: 'TESTUSER',
      password: 'secret',
    });
    expect(typeof config.hostVerifier).toBe('function');
  });

  it('passes the JT400 defaults, without host or credentials, to the Mapepire server', async () => {
    connection.initializePool({ ...baseConfig('mapepire'), jdbcOptions: { naming: 'sql' } });
    await connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
    expect(created.mapepire[0].jdbcOptions).toEqual({
      naming: 'sql',
      'date format': 'iso',
      access: 'read only',
      libraries: 'MYLIB',
    });
  });

  it('binds Date parameters as Db2 timestamps', async () => {
    connection.initializePool(baseConfig('mapepire'));
    const when = new Date(Date.UTC(2026, 8, 24, 13, 45, 30, 123));
    await connection.executeQuery('SELECT ? FROM SYSIBM.SYSDUMMY1', [when]);
    const [, params] = created.mapepire[0].pool.query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['2026-09-24 13:45:30.123000']);
  });

  it('rewrites a Mapepire error as [SQLSTATE] message', async () => {
    connection.initializePool(baseConfig('mapepire'));
    await connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
    created.mapepire[0].pool.query.mockRejectedValueOnce(
      new Error('[SQL0204] NOPE in MYLIB type *FILE not found., 42704, -204')
    );
    await expect(connection.executeQuery('SELECT * FROM NOPE')).rejects.toThrow(
      'Database query failed: [42704] [SQL0204] NOPE in MYLIB type *FILE not found.'
    );
  });

  it('ends the SSH session on shutdown', async () => {
    connection.initializePool(baseConfig('mapepire'));
    await connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
    await connection.closeGlobalPool();
    expect(created.sshClients[0].end).toHaveBeenCalledTimes(1);
  });

  it('refuses unknown DB2I_MAPEPIRE_OPTIONS keys', async () => {
    connection.initializePool({ ...baseConfig('mapepire'), mapepireOptions: { hostkey2: 'x' } });
    await expect(connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1')).rejects.toThrow(
      /unknown option "hostkey2"/
    );
  });
});

describe('driver contract: mapepire loading', () => {
  it('does not load the ODBC or JT400 packages', async () => {
    vi.resetModules();
    const jt400 = await import('node-jt400');
    const odbc = await import('odbc');
    vi.mocked(jt400.pool).mockClear();
    vi.mocked(odbc.pool).mockClear();
    created.mapepire.length = 0;
    created.rows = [];

    const connection = await import('../../src/db/connection.js');
    connection.initializePool(baseConfig('mapepire'));
    await connection.executeQuery('SELECT 1 FROM SYSIBM.SYSDUMMY1');
    expect(created.mapepire).toHaveLength(1);
    expect(odbc.pool).not.toHaveBeenCalled();
    expect(jt400.pool).not.toHaveBeenCalled();
    await connection.closeGlobalPool();
  });
});
