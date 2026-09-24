/**
 * ODBC driver, backed by the npm `odbc` package (IBM/node-odbc) and the
 * IBM i Access ODBC driver. No Java involved.
 *
 * `odbc` is an optional dependency with a native addon, so the import is
 * dynamic and happens only when an odbc pool is first needed.
 */

import type { DB2iConfig } from '../../config.js';
import { buildOdbcConnectionConfig, serializeOdbcConnectionString } from '../../config.js';
import type { CreatePoolOptions, DbDriver, DbPool, QueryParam } from '../driver.js';
import { toDb2Timestamp } from '../driver.js';

/** One diagnostic record from the ODBC driver manager. */
interface OdbcDiagnostic {
  state?: string;
  code?: number;
  message?: string;
}

type OdbcModule = typeof import('odbc');

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
 * first one so the message says what Db2 said (SQLSTATE and text).
 */
function describeOdbcError(error: unknown): string {
  if (error && typeof error === 'object' && 'odbcErrors' in error) {
    const diagnostics = (error as { odbcErrors?: unknown }).odbcErrors;
    if (Array.isArray(diagnostics) && diagnostics.length > 0) {
      const first = diagnostics[0] as OdbcDiagnostic;
      const parts = [first.state ? `[${first.state}]` : '', first.message ?? ''].filter(Boolean);
      if (parts.length > 0) {
        return parts.join(' ');
      }
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export const odbcDriver: DbDriver = {
  name: 'odbc',

  async createPool(config: DB2iConfig, options: CreatePoolOptions): Promise<DbPool> {
    const odbc = await loadOdbc();
    const connectionString = serializeOdbcConnectionString(
      buildOdbcConnectionConfig(config, { readOnly: options.readOnly })
    );
    let pool: Awaited<ReturnType<typeof odbc.pool>>;
    try {
      pool = await odbc.pool({
        connectionString,
        initialSize: 1,
        incrementSize: 1,
        maxSize: 10,
        shrink: true,
      });
    } catch (error) {
      throw new Error(describeOdbcError(error), { cause: error });
    }
    return {
      async query(sql, params) {
        try {
          const result = await pool.query<Record<string, unknown>>(sql, bindParams(params));
          // Result is an Array with extra properties (columns, count, ...).
          // Copy the rows so only plain row objects leave the driver.
          return Array.from(result);
        } catch (error) {
          throw new Error(describeOdbcError(error), { cause: error });
        }
      },
      async close() {
        await pool.close();
      },
    };
  },
};
