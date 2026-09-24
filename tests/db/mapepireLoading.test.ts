/**
 * mapepire-js is a CommonJS bundle whose exports Node cannot detect, so an
 * ESM import sees them only under `default`. The driver must handle that shape.
 */

import { describe, it, expect, vi } from 'vitest';

const started = vi.hoisted(() => ({ jobs: 0 }));

vi.mock('@ibm/mapepire-js', () => ({
  default: {
    createSSH2Connection: () => ({ exec: vi.fn(), upload: vi.fn() }),
    SQLJob: {
      withConfig: () => ({
        async connect() {
          started.jobs += 1;
        },
        getStatus: () => 'ready',
        getTransport: () => ({ isConnected: () => true }),
        query: () => ({
          execute: async () => ({ data: [{ N: 1 }], is_done: true }),
          fetchMore: async () => ({ data: [], is_done: true }),
          close: async () => ({}),
        }),
        close: async () => undefined,
      }),
    },
  },
}));

vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('node:events');
  class Client extends EventEmitter {
    end() {
      setImmediate(() => this.emit('close'));
    }
    connect() {
      setImmediate(() => this.emit('ready'));
      return this;
    }
  }
  return { default: { Client } };
});

describe('mapepire driver loading', () => {
  it('uses the default export when named exports are missing', async () => {
    const { mapepireDriver } = await import('../../src/db/drivers/mapepire.js');
    const pool = await mapepireDriver.createPool(
      {
        hostname: 'ibmi.example.com',
        port: 446,
        username: 'TESTUSER',
        password: 'secret',
        database: '*LOCAL',
        schema: '',
        driver: 'mapepire',
        jdbcOptions: {},
        odbcOptions: {},
        mapepireOptions: { insecureHostKey: 'true' },
      },
      { readOnly: true }
    );
    await expect(pool.query('SELECT 1 AS N FROM SYSIBM.SYSDUMMY1', [])).resolves.toEqual([{ N: 1 }]);
    expect(started.jobs).toBe(1);
    await pool.close();
  });
});
