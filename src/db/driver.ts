/**
 * Database driver interface.
 *
 * connection.ts manages pools; a driver knows how to create one. Each driver
 * module is loaded with a dynamic import on first use, so an ODBC install never
 * resolves node-jt400 or starts a JVM, and a JT400 install never loads libodbc.
 */

import type { DB2iConfig, DbDriverName } from '../config.js';

export type QueryParam = string | number | Date | null;

export interface DbPool {
  /** Run a statement with positional `?` parameters and return its rows. */
  query(sql: string, params: readonly QueryParam[]): Promise<Record<string, unknown>[]>;
  /** Close every connection in the pool. */
  close(): Promise<void>;
}

export interface CreatePoolOptions {
  /**
   * When false, omit the driver's read-only setting so QSYS2.GENERATE_SQL can
   * return its result set. The default connection stays read only.
   */
  readOnly: boolean;
}

export interface DbDriver {
  readonly name: DbDriverName;
  createPool(config: DB2iConfig, options: CreatePoolOptions): Promise<DbPool>;
}

async function importDriver(name: DbDriverName): Promise<DbDriver> {
  switch (name) {
    case 'jt400': {
      const mod = await import('./drivers/jt400.js');
      return mod.jt400Driver;
    }
    case 'odbc': {
      const mod = await import('./drivers/odbc.js');
      return mod.odbcDriver;
    }
    default: {
      const unknown: never = name;
      throw new Error(`Unknown database driver: ${String(unknown)}`);
    }
  }
}

// One import per driver, shared by every pool that asks for it concurrently
// (several HTTP sessions can open their first connection at the same time).
// A failed import is forgotten so the next pool tries again.
const loading = new Map<DbDriverName, Promise<DbDriver>>();

/**
 * Load the driver module for the configured name.
 */
export function loadDriver(name: DbDriverName): Promise<DbDriver> {
  const existing = loading.get(name);
  if (existing) {
    return existing;
  }
  const pending = importDriver(name);
  loading.set(name, pending);
  pending.catch(() => {
    if (loading.get(name) === pending) {
      loading.delete(name);
    }
  });
  return pending;
}

/**
 * Narrow caller parameters to what the drivers bind. `undefined` entries are
 * dropped; anything that is not a string, number, Date or null becomes a string.
 */
export function toParams(params: readonly unknown[]): QueryParam[] {
  return params
    .filter((p) => p !== undefined)
    .map((p) => {
      if (p === null) return null;
      if (typeof p === 'string') return p;
      if (typeof p === 'number') return p;
      if (p instanceof Date) return p;
      return String(p);
    });
}
