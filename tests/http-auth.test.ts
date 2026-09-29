/**
 * /mcp authentication over HTTP: the static token mode, and bearer tokens
 * from /auth binding each tool call to that token's database config.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

vi.mock('node-jt400', async () => {
  const { withExecute } = await import('./helpers/jt400Fake.js');
  return {
    pool: vi.fn(() => withExecute({
      query: vi.fn().mockResolvedValue([]),
      close: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

import { createHttpApp } from '../src/transports/http.js';
import { getTokenManager } from '../src/auth/tokenManager.js';
import { closeAllSessionPools } from '../src/db/connection.js';
import type { DB2iConfig } from '../src/config.js';

const MCP_ACCEPT = 'application/json, text/event-stream';

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

function config(hostname: string, username: string): DB2iConfig {
  return {
    hostname,
    port: 446,
    username,
    password: 'secret',
    database: '*LOCAL',
    schema: 'MYLIB',
    driver: 'jt400',
    jdbcOptions: {},
    odbcOptions: {},
  };
}

/** A stateless 2025-era tools/call, with no session id and no initialize */
function callTool(baseUrl: string, name: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: MCP_ACCEPT,
      'MCP-Protocol-Version': '2025-06-18',
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: {} },
    }),
  });
}

async function readRpc(res: Response): Promise<{ result?: { isError?: boolean }; error?: unknown }> {
  const text = (await res.text()).trim();
  if (text.startsWith('{')) {
    return JSON.parse(text);
  }
  const dataLine = text.split('\n').find((line) => line.startsWith('data:'));
  if (!dataLine) {
    throw new Error(`Unexpected MCP body: ${text.slice(0, 300)}`);
  }
  return JSON.parse(dataLine.slice('data:'.length).trim());
}

async function poolHosts(): Promise<Array<{ host: string; user: string }>> {
  const { pool } = await import('node-jt400');
  return vi.mocked(pool).mock.calls.map(([options]) => options as unknown as { host: string; user: string });
}

describe('HTTP static token mode', () => {
  const originalEnv = process.env;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    process.env = {
      ...originalEnv,
      MCP_AUTH_MODE: 'token',
      MCP_AUTH_TOKEN: 'the-static-token',
      MCP_SESSION_MODE: 'stateless',
      DB2I_HOSTNAME: 'ibmi.example.com',
      DB2I_DRIVER: 'jt400',
      DB2I_USERNAME: 'test-user',
      DB2I_PASSWORD: 'test-pass',
    };
    ({ server, baseUrl } = await listen(createHttpApp()));
  });

  afterEach(async () => {
    await closeServer(server);
    await closeAllSessionPools();
    process.env = originalEnv;
  });

  it('rejects a request with no Authorization header', async () => {
    const res = await callTool(baseUrl, 'list_schemas');
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('unauthorized');
  });

  it('rejects an Authorization header that is not a bearer token', async () => {
    const res = await callTool(baseUrl, 'list_schemas', { Authorization: 'Basic the-static-token' });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('unauthorized');
  });

  it('rejects a wrong token, including a prefix of the right one', async () => {
    for (const token of ['wrong-token', 'the-static', 'the-static-token-and-more']) {
      const res = await callTool(baseUrl, 'list_schemas', { Authorization: `Bearer ${token}` });
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe('invalid_token');
    }
  });

  it('serves a tool call with the configured token', async () => {
    const res = await callTool(baseUrl, 'list_schemas', { Authorization: 'Bearer the-static-token' });
    expect(res.status).toBe(200);
    const body = await readRpc(res);
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).not.toBe(true);
  });
});

describe('HTTP required mode binds tool calls to the token', () => {
  const originalEnv = process.env;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    process.env = {
      ...originalEnv,
      MCP_AUTH_MODE: 'required',
      MCP_SESSION_MODE: 'stateless',
      MCP_CORS_ORIGINS: '',
      DB2I_DRIVER: 'jt400',
    };
    delete process.env.DB2I_HOSTNAME;
    delete process.env.DB2I_USERNAME;
    delete process.env.DB2I_PASSWORD;
    const { pool } = await import('node-jt400');
    vi.mocked(pool).mockClear();
    ({ server, baseUrl } = await listen(createHttpApp()));
  });

  afterEach(async () => {
    await closeServer(server);
    await getTokenManager().shutdown();
    await closeAllSessionPools();
    process.env = originalEnv;
  });

  it("runs each caller's tool call on that token's system and user", async () => {
    const tokenManager = getTokenManager();
    const first = tokenManager.createSession(config('first.example.com', 'FIRSTUSER'));
    const second = tokenManager.createSession(config('second.example.com', 'SECONDUSER'));

    const firstRes = await callTool(baseUrl, 'list_schemas', { Authorization: `Bearer ${first.token}` });
    expect(firstRes.status).toBe(200);
    expect((await readRpc(firstRes)).result?.isError).not.toBe(true);
    expect(await poolHosts()).toEqual([expect.objectContaining({ host: 'first.example.com', user: 'FIRSTUSER' })]);

    const secondRes = await callTool(baseUrl, 'list_schemas', { Authorization: `Bearer ${second.token}` });
    expect(secondRes.status).toBe(200);
    expect((await readRpc(secondRes)).result?.isError).not.toBe(true);
    expect((await poolHosts()).map((options) => options.host)).toEqual([
      'first.example.com',
      'second.example.com',
    ]);
  });

  it('rejects a bearer token that /auth did not issue', async () => {
    const res = await callTool(baseUrl, 'list_schemas', { Authorization: 'Bearer not-a-real-token' });
    expect(res.status).toBe(401);
    expect(await poolHosts()).toEqual([]);
  });

  it('rejects a token after it is revoked', async () => {
    const tokenManager = getTokenManager();
    const session = tokenManager.createSession(config('first.example.com', 'FIRSTUSER'));
    await tokenManager.revokeToken(session.token);

    const res = await callTool(baseUrl, 'list_schemas', { Authorization: `Bearer ${session.token}` });
    expect(res.status).toBe(401);
    expect(await poolHosts()).toEqual([]);
  });
});
