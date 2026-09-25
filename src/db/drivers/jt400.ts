/**
 * JT400 (JDBC) driver, backed by node-jt400.
 *
 * node-jt400 loads the native `java` addon when imported, so the import is
 * dynamic and happens only when a jt400 pool is first needed. It is an optional
 * dependency that builds only when a JDK is present at install time.
 */

import type { DB2iConfig } from '../../config.js';
import { buildConnectionConfig } from '../../config.js';
import type { CreatePoolOptions, DbDriver, DbPool, DbQueryOptions, QueryParam } from '../driver.js';
import { withQueryTimeout } from '../driver.js';

type Row = Record<string, unknown>;

// The subset of node-jt400 used here. Typed locally so the project type-checks
// when the optional package is not installed.
interface Jt400Queryable {
  query(sql: string, params: unknown[]): Promise<unknown[]>;
  /** executeUpdate: for statements without a result set. */
  update(sql: string, params: unknown[]): Promise<number>;
}

interface Jt400Connection extends Jt400Queryable {
  /** Runs `fn` on one pooled connection, then commits (or rolls back on failure). */
  transaction<T>(fn: (connection: Jt400Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void> | void;
}

interface Jt400Module {
  pool(config: ReturnType<typeof buildConnectionConfig>): Jt400Connection;
}

// Imported once and shared by every pool. Concurrent first queries from several
// sessions must not each start their own import. A failed import is forgotten.
let jt400Module: Promise<Jt400Module> | undefined;

function loadJt400(): Promise<Jt400Module> {
  if (!jt400Module) {
    const specifier = 'node-jt400';
    const pending = (import(specifier) as Promise<Jt400Module>).catch((error: unknown) => {
      if (jt400Module === pending) {
        jt400Module = undefined;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `DB2I_DRIVER=jt400 needs the optional node-jt400 package and a Java runtime (JRE 11 or later). Install it with a JDK present: npm install node-jt400. ${message}`,
        { cause: error }
      );
    });
    jt400Module = pending;
  }
  return jt400Module;
}

export const jt400Driver: DbDriver = {
  name: 'jt400',

  async createPool(config: DB2iConfig, options: CreatePoolOptions): Promise<DbPool> {
    const { pool } = await loadJt400();
    const connection = pool(buildConnectionConfig(config, { readOnly: options.readOnly }));
    return {
      async query(sql, params, options) {
        return runStatement(connection, sql, params, options);
      },
      async close() {
        await connection.close();
      },
    };
  },
};

/**
 * Run a statement, cancelling it with QSYS2.CANCEL_SQL once it runs past the
 * time limit. node-jt400 exposes neither a query timeout nor a cancel, and its
 * pool does not say which connection ran a statement. A transaction keeps one
 * connection for its callback, so the job name read first is the job that runs
 * the statement.
 *
 * Without a limit or a way to cancel, the statement runs as a plain query. With
 * a limit and no cancel, the caller stops waiting while the statement goes on.
 */
async function runStatement(
  connection: Jt400Connection,
  sql: string,
  params: readonly QueryParam[],
  options: DbQueryOptions | undefined
): Promise<Row[]> {
  const timeoutMs = options?.timeoutMs ?? 0;
  const cancelJob = options?.cancelJob;
  const run = async (target: Jt400Queryable): Promise<Row[]> => {
    if (options?.noResultSet) {
      await target.update(sql, [...params]);
      return [];
    }
    return (await target.query(sql, [...params])) as Row[];
  };
  if (timeoutMs <= 0 || !cancelJob) {
    const execution = run(connection);
    return withQueryTimeout(execution, timeoutMs, () =>
      Promise.reject(new Error('No connection is available to cancel the statement'))
    );
  }

  let jobName: string | undefined;
  const execution = connection.transaction(async (pinned) => {
    const [row] = (await pinned.query('VALUES QSYS2.JOB_NAME', [])) as Row[];
    jobName = String(Object.values(row ?? {})[0] ?? '').trim() || undefined;
    return run(pinned);
  });
  return withQueryTimeout(execution, timeoutMs, async () => {
    if (!jobName) {
      throw new Error('The job running the statement is not known yet');
    }
    await cancelJob(jobName);
  });
}
