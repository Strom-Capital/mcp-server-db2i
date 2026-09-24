/**
 * /auth with DB2I_PROFILES: a token is bound to the profile it logged in to.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';

vi.mock('node-jt400', () => ({
  pool: vi.fn(() => ({
    query: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { createHttpApp } from '../src/transports/http.js';
import { getTokenManager } from '../src/auth/tokenManager.js';
import { resetSystems } from '../src/systems.js';

const PROFILES = `
profiles:
  - name: prod
    host: prod.example.com
    username: PRODUSER
    password: \${PROD_PASSWORD}
    schema: SALES
  - name: test
    host: test.example.com
    username: TESTUSER
    password: \${TEST_PASSWORD}
`;

async function listen(app: Express): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('HTTP /auth with DB2I_PROFILES', () => {
  const originalEnv = process.env;
  let dir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'db2i-auth-profiles-'));
    const file = path.join(dir, 'profiles.yaml');
    writeFileSync(file, PROFILES);
    process.env = {
      ...originalEnv,
      MCP_AUTH_MODE: 'required',
      MCP_SESSION_MODE: 'stateless',
      DB2I_PROFILES: file,
      PROD_PASSWORD: 'prodpass',
      TEST_PASSWORD: 'testpass',
    };
    delete process.env.DB2I_HOSTNAME;
    delete process.env.MCP_AUTH_ALLOWED_DB_HOSTS;
    resetSystems();

    const { pool } = await import('node-jt400');
    vi.mocked(pool).mockClear();
    ({ server, baseUrl } = await listen(createHttpApp()));
  });

  afterEach(async () => {
    await closeServer(server);
    await getTokenManager().shutdown();
    resetSystems();
    process.env = originalEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  function postAuth(body: Record<string, unknown>): Promise<Response> {
    return fetch(`${baseUrl}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'CALLER', password: 'callerpass', ...body }),
    });
  }

  async function poolConfigs(): Promise<Array<{ host: string; user: string }>> {
    const { pool } = await import('node-jt400');
    return vi.mocked(pool).mock.calls.map(([config]) => config as unknown as { host: string; user: string });
  }

  it('logs in to the named profile with the caller’s credentials and binds the token', async () => {
    const res = await postAuth({ system: 'test' });
    expect(res.status).toBe(201);
    const { access_token } = await res.json() as { access_token: string };

    const [config] = await poolConfigs();
    expect(config.host).toBe('test.example.com');
    expect(config.user).toBe('CALLER');

    const session = getTokenManager().validateToken(access_token).session;
    expect(session?.system).toBe('test');
    expect(session?.config.hostname).toBe('test.example.com');
    expect(session?.config.username).toBe('CALLER');
  });

  it('uses the first profile when no system is named', async () => {
    const res = await postAuth({});
    expect(res.status).toBe(201);
    const { access_token } = await res.json() as { access_token: string };
    const session = getTokenManager().validateToken(access_token).session;
    expect(session?.system).toBe('prod');
    expect(session?.config.schema).toBe('SALES');
  });

  it('refuses host next to profiles, and an unknown system, before connecting', async () => {
    const withHost = await postAuth({ system: 'test', host: 'other.example.com' });
    expect(withHost.status).toBe(400);
    expect((await withHost.json() as { error_description: string }).error_description).toMatch(
      /come from DB2I_PROFILES/
    );

    const unknown = await postAuth({ system: 'dev' });
    expect(unknown.status).toBe(400);
    expect((await unknown.json() as { error_description: string }).error_description).toBe(
      'Unknown system "dev". Available: prod, test'
    );

    expect(await poolConfigs()).toHaveLength(0);
  });

  it('applies MCP_AUTH_ALLOWED_DB_HOSTS to profile hosts', async () => {
    process.env.MCP_AUTH_ALLOWED_DB_HOSTS = 'prod.example.com';
    // The app reads its HTTP settings when it is created
    await closeServer(server);
    ({ server, baseUrl } = await listen(createHttpApp()));
    const res = await postAuth({ system: 'test' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error_description: string }).error_description).toBe('Host is not allowed');
    expect(await poolConfigs()).toHaveLength(0);
  });
});
