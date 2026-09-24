/**
 * JT400 (JDBC) driver, backed by node-jt400.
 *
 * node-jt400 loads the native `java` addon when imported, so the import is
 * dynamic and happens only when a jt400 pool is first needed.
 */

import type { DB2iConfig } from '../../config.js';
import { buildConnectionConfig } from '../../config.js';
import type { CreatePoolOptions, DbDriver, DbPool } from '../driver.js';

type Jt400Module = typeof import('node-jt400');

// Imported once and shared by every pool. Concurrent first queries from several
// sessions must not each start their own import. A failed import is forgotten.
let jt400Module: Promise<Jt400Module> | undefined;

function loadJt400(): Promise<Jt400Module> {
  if (!jt400Module) {
    const pending = import('node-jt400').catch((error: unknown) => {
      if (jt400Module === pending) {
        jt400Module = undefined;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `DB2I_DRIVER=jt400 needs the node-jt400 package and a Java runtime (JRE 11 or later): ${message}`,
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
