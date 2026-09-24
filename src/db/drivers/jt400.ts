/**
 * JT400 (JDBC) driver, backed by node-jt400.
 *
 * node-jt400 loads the native `java` addon when imported, so the import is
 * dynamic and happens only when a jt400 pool is first needed. It is an optional
 * dependency that builds only when a JDK is present at install time.
 */

import type { DB2iConfig } from '../../config.js';
import { buildConnectionConfig } from '../../config.js';
import type { CreatePoolOptions, DbDriver, DbPool } from '../driver.js';

// The subset of node-jt400 used here. Typed locally so the project type-checks
// when the optional package is not installed.
interface Jt400Connection {
  query(sql: string, params: unknown[]): Promise<unknown[]>;
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
      async query(sql, params) {
        const rows = await connection.query(sql, [...params]);
        return rows as Record<string, unknown>[];
      },
      async close() {
        await connection.close();
      },
    };
  },
};
