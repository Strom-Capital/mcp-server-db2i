/**
 * Mapepire driver, backed by @ibm/mapepire-js.
 *
 * With transport=ssh (the only transport so far) it opens an SSH session to
 * the IBM i and starts the Mapepire server inside it, one server process per
 * job. mapepire-js uploads its bundled server JAR to the user's
 * $HOME/.mapepire on first use unless serverPath points at an installed one.
 * Nothing needs to be installed or running on the IBM i besides sshd and Java.
 *
 * The pool is transport-agnostic: it asks a JobFactory for jobs. A daemon
 * transport (a running Mapepire server on port 8076) would add a factory and
 * reuse the pool.
 *
 * Both packages are optional dependencies, imported only when a mapepire pool
 * is first needed.
 */

import { readFileSync } from 'node:fs';
import type { SQLJob } from '@ibm/mapepire-js';
import type { Client, ConnectConfig } from 'ssh2';
import type { DB2iConfig, MapepireSettings, MapepireSshSettings } from '../../config.js';
import { buildMapepireJdbcOptions, resolveMapepireSettings } from '../../config.js';
import { kindFromTypeName, rowFromObject } from '../columns.js';
import type {
  CreatePoolOptions,
  DbColumn,
  DbCursorOptions,
  DbDriver,
  DbPool,
  DbQueryOptions,
  QueryParam,
  RowCursor,
} from '../driver.js';
import { CANCEL_GRACE_MS, DbError, QueryTimeoutError, toDb2Timestamp, withQueryTimeout } from '../driver.js';
import { createHostKeyVerifier } from './sshHostKey.js';

type MapepireModule = typeof import('@ibm/mapepire-js');
type Ssh2Module = typeof import('ssh2');

type Row = Record<string, unknown>;

/** Rows fetched per round trip. */
const FETCH_SIZE = 1000;

// Imported once and shared by every pool. A failed import is forgotten.
let mapepireModule: Promise<MapepireModule> | undefined;
let ssh2Module: Promise<Ssh2Module> | undefined;

/**
 * Both packages are CommonJS. mapepire-js is a bundle whose exports Node cannot
 * detect, so an ESM import sees them only under `default`. Use `default` when
 * the named export is missing.
 */
function unwrapCommonJs<T>(mod: unknown, probe: string): T {
  const named = mod as Record<string, unknown>;
  if (!(probe in named) && 'default' in named && named.default && typeof named.default === 'object') {
    return named.default as T;
  }
  return mod as T;
}

function loadOptional<T>(
  specifier: string,
  probe: string,
  get: () => Promise<T> | undefined,
  set: (value: Promise<T> | undefined) => void
): Promise<T> {
  const existing = get();
  if (existing) {
    return existing;
  }
  const pending = import(specifier).then((mod: unknown) => {
    const resolved = unwrapCommonJs<T>(mod, probe);
    if (!(probe in (resolved as Record<string, unknown>))) {
      throw new Error(`${specifier} does not export ${probe}`);
    }
    return resolved;
  }).catch((error: unknown) => {
    if (get() === pending) {
      set(undefined);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `DB2I_DRIVER=mapepire needs the optional @ibm/mapepire-js and ssh2 packages: npm install @ibm/mapepire-js ssh2. ${message}`,
      { cause: error }
    );
  });
  set(pending);
  return pending;
}

function loadMapepire(): Promise<MapepireModule> {
  return loadOptional(
    '@ibm/mapepire-js',
    'SQLJob',
    () => mapepireModule,
    (value) => {
      mapepireModule = value;
    }
  );
}

function loadSsh2(): Promise<Ssh2Module> {
  return loadOptional(
    'ssh2',
    'Client',
    () => ssh2Module,
    (value) => {
      ssh2Module = value;
    }
  );
}

/**
 * Starts Mapepire jobs over one transport. The pool only talks to this.
 */
export interface JobFactory {
  /** Start a new job, connected and ready for queries. */
  start(): Promise<SQLJob>;
  /** Close the transport. Jobs are closed by the pool first. The next start opens it again. */
  close(): Promise<void>;
  /** Called when the transport drops, after which every started job is gone. */
  onDead(listener: () => void): void;
}

const MAPEPIRE_SQL_ERROR = /^([\s\S]*), ([0-9A-Z]{5}), (-?\d+)$/;

/**
 * mapepire-js reports a failed statement as `message, SQLSTATE, SQLCODE`.
 * Rewrite it as `[SQLSTATE] message`, the same shape as the ODBC driver.
 */
export function describeMapepireError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = MAPEPIRE_SQL_ERROR.exec(message);
  if (match) {
    return `[${match[2]}] ${match[1]}`;
  }
  return message;
}

/**
 * The error a failed request throws: a DbError with the SQLSTATE and SQLCODE
 * when mapepire-js reported them, else a plain Error with the same message.
 */
export function toMapepireError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const match = MAPEPIRE_SQL_ERROR.exec(message);
  if (match) {
    const sqlcode = Number(match[3]);
    return new DbError(
      `[${match[2]}] ${match[1]}`,
      { sqlstate: match[2], sqlcode: sqlcode !== 0 ? sqlcode : undefined },
      { cause: error }
    );
  }
  return new Error(message, { cause: error });
}

/** mapepire-js binds strings, numbers and null. */
function bindParams(params: readonly QueryParam[]): Array<string | number | null> {
  return params.map((p) => (p instanceof Date ? toDb2Timestamp(p) : p));
}

/** A request that did not answer within requestTimeout. The pool closes its job. */
class RequestTimeoutError extends Error {}

/**
 * mapepire-js accepts a requestTimeout but never enforces it, so the pool
 * times each request itself.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new RequestTimeoutError(`Mapepire request did not answer within ${ms} ms (requestTimeout)`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Run one statement on a job and read every row.
 */
async function runOnJob(
  job: SQLJob,
  sql: string,
  params: readonly QueryParam[],
  requestTimeout: number
): Promise<Row[]> {
  const query = job.query<Row>(sql, params.length > 0 ? { parameters: bindParams(params) } : {});
  let result = await withTimeout(query.execute(FETCH_SIZE), requestTimeout);
  const rows: Row[] = [...(result.data ?? [])];
  try {
    while (!result.is_done) {
      result = await withTimeout(query.fetchMore(FETCH_SIZE), requestTimeout);
      rows.push(...(result.data ?? []));
    }
  } catch (error) {
    // A timed-out job is closed by the pool, which ends the cursor with it.
    if (!(error instanceof RequestTimeoutError)) {
      await query.close().catch(() => undefined);
    }
    throw error;
  }
  return rows;
}

/** False once the job ended or its server process is gone. */
function jobIsUsable(job: SQLJob): boolean {
  return String(job.getStatus()) !== 'ended' && job.getTransport().isConnected();
}

interface JobSlot {
  /** Resolves when the job is ready. Shared, so parallel queries never start extra jobs. */
  ready: Promise<SQLJob>;
  /** Set once ready. */
  job?: SQLJob;
  /** Queries running or waiting on this job. */
  active: number;
  lastUsed: number;
}

export interface JobPoolOptions {
  maxJobs: number;
  idleTimeout: number;
  requestTimeout: number;
}

/**
 * Up to `maxJobs` Mapepire jobs, started on demand. A query takes an idle job,
 * else starts one below the cap, else shares the least busy job (mapepire-js
 * queues requests on a job). Jobs close after `idleTimeout`, and the transport
 * closes with the last one.
 */
export class JobPool implements DbPool {
  private slots: JobSlot[] = [];
  private closed = false;
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly factory: JobFactory,
    private readonly options: JobPoolOptions
  ) {
    factory.onDead(() => {
      // The transport is gone, and every job with it. The next query reconnects.
      this.slots = [];
    });
    this.sweeper = setInterval(() => {
      void this.closeIdleJobs().catch(() => undefined);
    }, Math.min(options.idleTimeout, 60_000));
    this.sweeper.unref();
  }

  async query(sql: string, params: readonly QueryParam[], options?: DbQueryOptions): Promise<Row[]> {
    if (this.closed) {
      throw new Error('Mapepire pool is closed');
    }
    const timeoutMs = options?.timeoutMs ?? 0;
    const slot = this.pick();
    slot.active += 1;
    try {
      let job: SQLJob;
      try {
        job = await slot.ready;
      } catch (error) {
        throw new Error(describeMapepireError(error), { cause: error });
      }
      // With a statement time limit, a request may take that long plus the
      // time the cancel needs, so the cancel runs before requestTimeout fires.
      const requestTimeout =
        timeoutMs > 0
          ? Math.max(this.options.requestTimeout, timeoutMs + CANCEL_GRACE_MS)
          : this.options.requestTimeout;
      try {
        return await withQueryTimeout(runOnJob(job, sql, params, requestTimeout), timeoutMs, async () => {
          const cancelJob = options?.cancelJob;
          if (!cancelJob || !job.id) {
            throw new Error('No connection is available to cancel the statement');
          }
          await cancelJob(job.id);
        });
      } catch (error) {
        // A timed-out job may still be running the statement, and a job whose
        // server process exited stays "busy" in mapepire-js. Neither may be
        // reused. A job whose statement was cancelled is idle again.
        const cancelled = error instanceof QueryTimeoutError && error.cancelled;
        if (!cancelled && (error instanceof RequestTimeoutError || error instanceof QueryTimeoutError || !jobIsUsable(job))) {
          this.drop(slot);
          void job.close().catch(() => undefined);
        }
        if (error instanceof QueryTimeoutError) {
          throw error;
        }
        throw toMapepireError(error);
      }
    } finally {
      slot.active -= 1;
      slot.lastUsed = Date.now();
    }
  }

  /**
   * Open a cursor on a job of its own: an idle job, or a new one below
   * maxJobs. A cursor never shares a job, because CANCEL_SQL ends whatever
   * the job is running and another caller's query must not be hit. The job
   * counts as busy until the cursor closes, so the idle sweeper leaves it.
   */
  async openCursor(sql: string, params: readonly QueryParam[], options: DbCursorOptions): Promise<RowCursor> {
    if (this.closed) {
      throw new Error('Mapepire pool is closed');
    }
    const slot = this.slots.find((candidate) => candidate.active === 0)
      ?? (this.slots.length < this.options.maxJobs ? this.startSlot() : undefined);
    if (!slot) {
      throw new Error(
        `All ${this.options.maxJobs} Mapepire jobs are busy. Try again when a query has finished, or raise maxJobs.`
      );
    }
    slot.active += 1;

    let released = false;
    const release = (drop: boolean): void => {
      if (released) {
        return;
      }
      released = true;
      slot.active -= 1;
      slot.lastUsed = Date.now();
      if (drop) {
        this.drop(slot);
        void slot.job?.close().catch(() => undefined);
      }
    };

    let job: SQLJob;
    try {
      job = await slot.ready;
    } catch (error) {
      release(false);
      throw new Error(describeMapepireError(error), { cause: error });
    }

    const timeoutMs = options.timeoutMs ?? 0;
    const requestTimeout =
      timeoutMs > 0 ? Math.max(this.options.requestTimeout, timeoutMs + CANCEL_GRACE_MS) : this.options.requestTimeout;
    let cancelFailed = false;
    let failed = false;
    const onAbort = (): void => {
      if (!options.cancelJob || !job.id) {
        cancelFailed = true;
        return;
      }
      options.cancelJob(job.id).catch(() => {
        cancelFailed = true;
      });
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const query = job.query<Row>(sql, params.length > 0 ? { parameters: bindParams(params) } : {});
    let done = false;
    let closed = false;

    // A job that timed out, whose cancel failed, or whose server process is
    // gone may still be running the statement. It is not reused.
    const close = async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      options.signal?.removeEventListener('abort', onAbort);
      const drop = failed || cancelFailed || !jobIsUsable(job);
      if (!done && !drop) {
        await query.close().catch(() => undefined);
      }
      release(drop);
    };

    const fail = (error: unknown): Error => {
      if (error instanceof RequestTimeoutError || !jobIsUsable(job)) {
        failed = true;
      }
      return toMapepireError(error);
    };

    let first;
    try {
      options.signal?.throwIfAborted();
      first = await withTimeout(query.execute(options.fetchSize), requestTimeout);
    } catch (error) {
      const wrapped = fail(error);
      done = true;
      await close();
      throw wrapped;
    }
    done = first.is_done;
    const columns: DbColumn[] = (first.metadata?.columns ?? []).map((column) => ({
      name: column.label || column.name,
      kind: kindFromTypeName(column.type),
      dbType: column.type,
      precision: column.precision,
      scale: column.scale,
    }));
    let pending: Row[] | undefined = first.data ?? [];

    return {
      columns,
      async next() {
        if (closed) {
          return null;
        }
        if (pending) {
          const rows = pending;
          pending = undefined;
          if (rows.length > 0) {
            return rows.map((row) => rowFromObject(row, columns));
          }
        }
        while (!done) {
          let result;
          try {
            result = await withTimeout(query.fetchMore(options.fetchSize), requestTimeout);
          } catch (error) {
            throw fail(error);
          }
          done = result.is_done;
          const rows = result.data ?? [];
          if (rows.length > 0) {
            return rows.map((row) => rowFromObject(row, columns));
          }
        }
        return null;
      },
      close,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweeper);
    const slots = this.slots;
    this.slots = [];
    await Promise.all(slots.map((slot) => closeSlot(slot)));
    await this.factory.close();
  }

  /** Number of jobs started or starting. For tests and diagnostics. */
  get size(): number {
    return this.slots.length;
  }

  private pick(): JobSlot {
    const idle = this.slots.find((slot) => slot.active === 0);
    if (idle) {
      return idle;
    }
    if (this.slots.length < this.options.maxJobs) {
      return this.startSlot();
    }
    return this.slots.reduce((least, slot) => (slot.active < least.active ? slot : least));
  }

  private startSlot(): JobSlot {
    const slot: JobSlot = {
      ready: this.factory.start(),
      active: 0,
      lastUsed: Date.now(),
    };
    slot.ready.then(
      (job) => {
        slot.job = job;
        // Closed while starting: end the job that just came up.
        if (this.closed || !this.slots.includes(slot)) {
          job.close().catch(() => undefined);
        }
      },
      () => {
        // A failed start is forgotten so the next query tries again.
        this.drop(slot);
      }
    );
    this.slots.push(slot);
    return slot;
  }

  private drop(slot: JobSlot): void {
    this.slots = this.slots.filter((candidate) => candidate !== slot);
  }

  private async closeIdleJobs(): Promise<void> {
    const now = Date.now();
    const expired = this.slots.filter(
      (slot) => slot.job && slot.active === 0 && now - slot.lastUsed >= this.options.idleTimeout
    );
    if (expired.length === 0) {
      return;
    }
    for (const slot of expired) {
      this.drop(slot);
    }
    await Promise.all(expired.map((slot) => closeSlot(slot)));
    // No job left, so no JVM and no SSH session stays up. The next query reconnects.
    if (!this.closed && this.slots.length === 0) {
      await this.factory.close();
    }
  }
}

async function closeSlot(slot: JobSlot): Promise<void> {
  if (slot.job) {
    await slot.job.close().catch(() => undefined);
  }
  // A job still starting is closed by startSlot once it comes up.
}

/**
 * Jobs over SSH: one SSH connection, one channel and one Mapepire server
 * process per job. The connection opens on the first job and reopens after
 * it drops.
 */
export function createSshJobFactory(
  config: DB2iConfig,
  settings: MapepireSshSettings,
  jdbcOptions: Record<string, string>
): JobFactory {
  const listeners: Array<() => void> = [];
  const verifier = createHostKeyVerifier(settings, config.hostname, settings.sshPort);
  let client: Promise<Client> | undefined;
  let current: Client | undefined;

  const connect = async (): Promise<Client> => {
    const { Client: SshClient } = await loadSsh2();
    const connectConfig: ConnectConfig = {
      host: config.hostname,
      port: settings.sshPort,
      username: config.username,
      readyTimeout: 20_000,
      keepaliveInterval: 30_000,
      hostVerifier: (key: Buffer) => verifier.verify(key),
    };
    const algorithms = verifier.algorithms();
    if (algorithms) {
      connectConfig.algorithms = { serverHostKey: algorithms as never };
    }
    if (settings.privateKeyFile) {
      connectConfig.privateKey = readFileSync(settings.privateKeyFile);
    } else {
      connectConfig.password = config.password;
    }

    return new Promise<Client>((resolve, reject) => {
      const ssh = new SshClient();
      let ready = false;
      ssh.on('ready', () => {
        ready = true;
        current = ssh;
        resolve(ssh);
      });
      ssh.on('error', (error: Error) => {
        if (!ready) {
          const reason = verifier.rejection();
          reject(new Error(reason ?? `SSH connection to ${config.hostname} failed: ${error.message}`, { cause: error }));
        }
      });
      ssh.on('close', () => {
        // Only the connection in use counts. An old one closing is expected.
        if (ready && current === ssh) {
          current = undefined;
          client = undefined;
          for (const listener of listeners) {
            listener();
          }
        }
      });
      ssh.connect(connectConfig);
    });
  };

  const getClient = (): Promise<Client> => {
    if (!client) {
      const pending = connect();
      client = pending;
      pending.catch(() => {
        if (client === pending) {
          client = undefined;
        }
      });
    }
    return client;
  };

  return {
    async start() {
      const [{ SQLJob: Job, createSSH2Connection }, ssh] = await Promise.all([loadMapepire(), getClient()]);
      const job = Job.withConfig(
        {
          transport: 'ssh-single',
          sshSingle: {
            ...createSSH2Connection(ssh),
            startupTimeout: settings.startupTimeout,
            ...(settings.javaPath ? { javaPath: settings.javaPath } : {}),
            ...(settings.serverPath ? { serverPath: settings.serverPath } : {}),
          },
        },
        jdbcOptions
      );
      await job.connect();
      return job;
    },
    async close() {
      const pending = client;
      client = undefined;
      if (pending) {
        const ssh = await pending.catch(() => undefined);
        // A deliberate close is not a drop: its close event must not clear the pool.
        if (ssh && current === ssh) {
          current = undefined;
        }
        ssh?.end();
      }
    },
    onDead(listener) {
      listeners.push(listener);
    },
  };
}

function createJobFactory(
  config: DB2iConfig,
  settings: MapepireSettings,
  jdbcOptions: Record<string, string>
): JobFactory {
  switch (settings.transport) {
    case 'ssh':
      return createSshJobFactory(config, settings, jdbcOptions);
    default: {
      const unknown: never = settings.transport;
      throw new Error(`Unsupported Mapepire transport: ${String(unknown)}`);
    }
  }
}

export const mapepireDriver: DbDriver = {
  name: 'mapepire',

  async createPool(config: DB2iConfig, options: CreatePoolOptions): Promise<DbPool> {
    // Fail on a missing package now, like the other drivers, not on the first job.
    await Promise.all([loadMapepire(), loadSsh2()]);
    const settings = resolveMapepireSettings(config.mapepireOptions ?? {});
    const jdbcOptions = buildMapepireJdbcOptions(config, { readOnly: options.readOnly });
    return new JobPool(createJobFactory(config, settings, jdbcOptions), settings);
  },
};
