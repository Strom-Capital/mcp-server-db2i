/**
 * ODBC driver, backed by the npm `odbc` package (IBM/node-odbc) and the
 * IBM i Access ODBC driver. No Java involved.
 *
 * `odbc` is an optional dependency with a native addon, so the import is
 * dynamic and happens only when an odbc pool is first needed.
 */

import type { DB2iConfig } from '../../config.js';
import { buildOdbcConnectionConfig, serializeOdbcConnectionString } from '../../config.js';
import type { CreatePoolOptions, DbDriver, DbPool, DbRows, QueryParam } from '../driver.js';
import { DbError, QueryTimeoutError, toDb2Timestamp, withQueryTimeout } from '../driver.js';

/** One diagnostic record from the ODBC driver manager. */
interface OdbcDiagnostic {
  state?: string;
  code?: number;
  message?: string;
}

type OdbcModule = typeof import('odbc');
type OdbcPool = Awaited<ReturnType<OdbcModule['pool']>>;
type Row = Record<string, unknown>;
type OdbcResult = Awaited<ReturnType<OdbcPool['query']>>;

// Imported once and shared by every pool. Concurrent first queries from several
// sessions must not each start their own import. A failed import is forgotten.
let odbcModule: Promise<OdbcModule> | undefined;

function loadOdbc(): Promise<OdbcModule> {
  if (!odbcModule) {
    const pending = import('odbc').catch((error: unknown) => {
      if (odbcModule === pending) {
        odbcModule = undefined;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `DB2I_DRIVER=odbc needs the odbc package, unixODBC and the IBM i Access ODBC Driver: ${message}`,
        { cause: error }
      );
    });
    odbcModule = pending;
  }
  return odbcModule;
}

/**
 * node-odbc binds null as SQL_NULL_DATA at runtime, but its declarations only
 * name number and string, hence the cast.
 */
function bindParams(params: readonly QueryParam[]): Array<string | number> {
  return params.map((p) => (p instanceof Date ? toDb2Timestamp(p) : p)) as Array<string | number>;
}

/**
 * node-odbc errors carry the driver's diagnostics in `odbcErrors`. Surface the
 * first one so the message says what Db2 said (SQLSTATE and text), and keep
 * its SQLSTATE and native code (the SQLCODE) on the DbError.
 */
function toOdbcError(error: unknown): Error {
  if (error && typeof error === 'object' && 'odbcErrors' in error) {
    const diagnostics = (error as { odbcErrors?: unknown }).odbcErrors;
    if (Array.isArray(diagnostics) && diagnostics.length > 0) {
      const first = diagnostics[0] as OdbcDiagnostic;
      const parts = [first.state ? `[${first.state}]` : '', first.message ?? ''].filter(Boolean);
      if (parts.length > 0) {
        const sqlcode = typeof first.code === 'number' && first.code !== 0 ? first.code : undefined;
        return new DbError(parts.join(' '), { sqlstate: first.state || undefined, sqlcode }, { cause: error });
      }
    }
  }
  return new Error(error instanceof Error ? error.message : String(error), { cause: error });
}

/** Digits a JavaScript number holds exactly. */
const MAX_EXACT_DIGITS = 15;

/** ODBC SQL_NUMERIC and SQL_DECIMAL. */
const DECIMAL_TYPES = new Set([2, 3]);

/**
 * Copy the rows out of a node-odbc Result, an Array with extra properties
 * (columns, count, ...), so only plain row objects leave the driver.
 *
 * node-odbc reads every DECIMAL and NUMERIC value with atof, so a value with
 * more than 15 digits comes back rounded. Such columns are named in
 * `roundedColumns`. A value of DECIMAL(p,s) uses more than 15 digits exactly
 * when its magnitude reaches 10^(15-s); below that the number is exact.
 */
function toDbRows(result: OdbcResult): DbRows {
  const rows: DbRows = Array.from(result as unknown as Row[]);
  const rounded = (result.columns ?? [])
    .filter((column) => DECIMAL_TYPES.has(column.dataType) && column.columnSize > MAX_EXACT_DIGITS)
    .filter((column) => {
      const limit = 10 ** (MAX_EXACT_DIGITS - column.decimalDigits);
      return rows.some((row) => {
        const value = row[column.name];
        return typeof value === 'number' && Math.abs(value) >= limit;
      });
    })
    .map((column) => column.name);
  if (rounded.length > 0) {
    rows.roundedColumns = rounded;
  }
  return rows;
}

export const odbcDriver: DbDriver = {
  name: 'odbc',

  async createPool(config: DB2iConfig, options: CreatePoolOptions): Promise<DbPool> {
    const odbc = await loadOdbc();
    const connectionString = serializeOdbcConnectionString(
      buildOdbcConnectionConfig(config, { readOnly: options.readOnly })
    );
    let pool: OdbcPool;
    try {
      pool = await odbc.pool({
        connectionString,
        initialSize: 1,
        incrementSize: 1,
        maxSize: 10,
        shrink: true,
      });
    } catch (error) {
      throw toOdbcError(error);
    }
    return {
      async query(sql, params, options) {
        const timeoutMs = options?.timeoutMs ?? 0;
        try {
          if (timeoutMs <= 0) {
            return toDbRows(await pool.query<Row>(sql, bindParams(params)));
          }
          return toDbRows(await queryWithCancel(pool, sql, params, timeoutMs));
        } catch (error) {
          if (error instanceof QueryTimeoutError) {
            throw error;
          }
          throw toOdbcError(error);
        }
      },
      async close() {
        await pool.close();
      },
    };
  },
};

/**
 * Run a statement on a connection of its own, so it can be cancelled with
 * SQLCancel. The IBM i Access ODBC driver ignores SQL_ATTR_QUERY_TIMEOUT for
 * elapsed time, but SQLCancel stops the statement on the host and needs no
 * special authority. The connection goes back to the pool once the statement
 * has ended, whether it finished, failed or was cancelled.
 */
async function queryWithCancel(
  pool: OdbcPool,
  sql: string,
  params: readonly QueryParam[],
  timeoutMs: number
): Promise<OdbcResult> {
  const connection = await pool.connect();
  let statement: Awaited<ReturnType<typeof connection.createStatement>> | undefined;
  const execution = (async () => {
    statement = await connection.createStatement();
    await statement.prepare(sql);
    if (params.length > 0) {
      await statement.bind(bindParams(params));
    }
    return statement.execute<Row>();
  })();
  const release = async (): Promise<void> => {
    await statement?.close().catch(() => undefined);
    await connection.close().catch(() => undefined);
  };
  void execution.then(release, release);
  return withQueryTimeout(execution, timeoutMs, async () => {
    if (!statement) {
      throw new Error('The statement had not started, so there was nothing to cancel');
    }
    await statement.cancel();
  });
}
