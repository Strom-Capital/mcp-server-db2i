/**
 * Driver contract test.
 *
 * Runs the connection manager against a fake of each driver package and
 * checks the behaviour every driver must share: positional parameter binding,
 * the read-only default on the query connection, a separate connection
 * without the read-only setting for QSYS2.GENERATE_SQL, retry after a failed
 * pool creation, and shutdown.
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
}));

function makeFakePool(): FakePool {
  return {
    query: vi.fn(async () => created.rows),
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
    return pool;
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
          columns: [],
          statement: args[0],
          parameters: args[1],
          return: undefined,
        });
        return result;
      }),
      close: inner.close,
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
        async connect() {
          if (created.failNext.mapepire) {
            created.failNext.mapepire = false;
            throw new Error('mapepire job failed to start');
          }
          status = 'ready';
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
}

const probes: DriverProbe[] = [
  {
    name: 'jt400',
    pools: () => created.jt400.map((c) => c.pool),
    isReadOnly: (i) => created.jt400[i].config['access'] === 'read only',
    failNext: () => {
      created.failNext.jt400 = true;
    },
  },
  {
    name: 'odbc',
    pools: () => created.odbc.map((c) => c.pool),
    isReadOnly: (i) => /(^|;)CONNTYPE=2(;|$)/.test(created.odbc[i].connectionString),
    failNext: () => {
      created.failNext.odbc = true;
    },
  },
  {
    name: 'mapepire',
    pools: () => created.mapepire.map((c) => c.pool),
    isReadOnly: (i) => created.mapepire[i].jdbcOptions['access'] === 'read only',
    failNext: () => {
      created.failNext.mapepire = true;
    },
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
    // connection.ts keeps module state, so each test gets a fresh copy.
    vi.resetModules();
    connection = await import('../../src/db/connection.js');
  });

  afterEach(async () => {
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
});

describe('driver contract: odbc specifics', () => {
  let connection: Connection;

  beforeEach(async () => {
    created.odbc.length = 0;
    created.failNext.odbc = false;
    created.rows = [{ N: 1 }];
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
      'DRIVER=IBM i Access ODBC Driver;SYSTEM=ibmi.example.com;UID=TESTUSER;PWD=secret;DFT=5;TRIMCHAR=1;CONNTYPE=2;DBQ=MYLIB;SSL=1;NAM=0'
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
