/**
 * mapepire-js is a CommonJS bundle whose exports Node cannot detect, so an
 * ESM import sees them only under `default`. The driver must handle that shape.
 */

import { describe, it, expect, vi } from 'vitest';

const started = vi.hoisted(() => ({ jobs: 0, connects: [] as Record<string, unknown>[] }));

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
    connect(config: Record<string, unknown>) {
      started.connects.push(config);
      setImmediate(() => this.emit('ready'));
      return this;
    }
  }
  return { default: { Client } };
});

const config = {
  hostname: 'ibmi.example.com',
  port: 446,
  username: 'TESTUSER',
  password: 'secret',
  database: '*LOCAL',
  schema: '',
  driver: 'mapepire' as const,
  jdbcOptions: {},
  odbcOptions: {},
  mapepireOptions: { insecureHostKey: 'true' },
};

describe('mapepire driver loading', () => {
  it('uses the default export when named exports are missing', async () => {
    const { mapepireDriver } = await import('../../src/db/drivers/mapepire.js');
    const pool = await mapepireDriver.createPool(config, { readOnly: true });
    await expect(pool.query('SELECT 1 AS N FROM SYSIBM.SYSDUMMY1', [])).resolves.toEqual([{ N: 1 }]);
    expect(started.jobs).toBe(1);
    expect(started.connects.at(-1)).toMatchObject({ username: 'TESTUSER', password: 'secret' });
    expect(started.connects.at(-1)).not.toHaveProperty('agent');
    await pool.close();
  });

  it('logs in over SSH with the agent instead of the password', async () => {
    const { mapepireDriver } = await import('../../src/db/drivers/mapepire.js');
    const pool = await mapepireDriver.createPool(
      { ...config, mapepireOptions: { ...config.mapepireOptions, agent: '/tmp/agent.sock' } },
      { readOnly: true }
    );
    await expect(pool.query('SELECT 1 AS N FROM SYSIBM.SYSDUMMY1', [])).resolves.toEqual([{ N: 1 }]);
    expect(started.connects.at(-1)).toMatchObject({ username: 'TESTUSER', agent: '/tmp/agent.sock' });
    expect(started.connects.at(-1)).not.toHaveProperty('password');
    expect(started.connects.at(-1)).not.toHaveProperty('privateKey');
    await pool.close();
  });
});
