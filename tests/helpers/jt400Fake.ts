/**
 * Completes a fake node-jt400 pool that only mocks `query`. The jt400 driver
 * reads query results through `execute()` (metadata plus `asArray()`), so the
 * fake's `execute` runs the statement through the test's own `query` mock.
 * Tests keep asserting on `query` calls and setting rows through it.
 */

type Query = (sql: string, params?: unknown[]) => Promise<unknown>;

export function withExecute<T extends { query: Query }>(pool: T) {
  const execute = async (sql: string, params: unknown[] = []) => {
    const rows = ((await pool.query(sql, params)) ?? []) as Record<string, unknown>[];
    const names = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    return {
      metadata: async () => names.map((name) => ({ name, typeName: 'VARCHAR', precision: 0, scale: 0 })),
      asArray: async () => rows.map((row) => names.map((name) => row[name] ?? null)),
      close: () => undefined,
    };
  };
  const connection = {
    query: pool.query,
    execute,
    update: async (sql: string, params: unknown[] = []) => {
      await pool.query(sql, params);
      return 0;
    },
  };
  return {
    ...connection,
    close: async () => undefined,
    transaction: async <R>(fn: (pinned: typeof connection) => Promise<R>) => fn(connection),
    ...pool,
  };
}
