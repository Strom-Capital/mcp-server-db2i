/**
 * HTTP transport hardening: session ownership and Origin validation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

vi.mock('node-jt400', () => ({
  pool: vi.fn(() => ({
    query: vi.fn().mockResolvedValue([]),
  })),
}));

import { createHttpApp, startHttpServer } from '../src/transports/http.js';
import { getSessionManager } from '../src/transports/sessionManager.js';
import { getTokenManager } from '../src/auth/tokenManager.js';
import { createServer } from '../src/server.js';
import type { DB2iConfig } from '../src/config.js';

const dbConfig: DB2iConfig = {
  hostname: 'test-host',
  port: 446,
  username: 'test-user',
  password: 'test-pass',
  database: '*LOCAL',
  schema: 'TESTLIB',
  driver: 'jt400',
  jdbcOptions: {},
  odbcOptions: {},
};

async function listen(app: Express): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function rawRequest(
  baseUrl: string,
  headers: Record<string, string>
): Promise<{ status: number; body: string }> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: url.port,
        path: '/health',
        method: 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('HTTP Origin validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      MCP_AUTH_MODE: 'none',
      MCP_SESSION_MODE: 'stateless',
      MCP_CORS_ORIGINS: 'https://allowed.example',
      DB2I_HOSTNAME: 'test-host',
      DB2I_DRIVER: 'jt400',
      DB2I_USERNAME: 'test-user',
      DB2I_PASSWORD: 'test-pass',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('rejects a disallowed Origin with 403', async () => {
    const { server, baseUrl } = await listen(createHttpApp());
    try {
      const res = await fetch(`${baseUrl}/health`, {
        headers: { Origin: 'https://evil.example' },
      });
      expect(res.status).toBe(403);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('forbidden');
    } finally {
      await closeServer(server);
    }
  });

  it('allows a configured Origin', async () => {
    const { server, baseUrl } = await listen(createHttpApp());
    try {
      const res = await fetch(`${baseUrl}/health`, {
        headers: { Origin: 'https://allowed.example' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('https://allowed.example');
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
      expect(res.headers.get('vary')).toMatch(/\bOrigin\b/);
    } finally {
      await closeServer(server);
    }
  });

  it('sends Vary: Origin on same-origin responses when origins are restricted', async () => {
    const { server, baseUrl } = await listen(createHttpApp());
    try {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get('vary')).toMatch(/\bOrigin\b/);
    } finally {
      await closeServer(server);
    }
  });

  it('answers a wildcard configuration with a literal * and no credentials', async () => {
    process.env.MCP_CORS_ORIGINS = '*';
    const { server, baseUrl } = await listen(createHttpApp());
    try {
      const res = await fetch(`${baseUrl}/health`, {
        headers: { Origin: 'https://anywhere.example' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    } finally {
      await closeServer(server);
    }
  });

  it('allows requests with no Origin header', async () => {
    const { server, baseUrl } = await listen(createHttpApp());
    try {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a Host that is not loopback or allowlisted', async () => {
    const { server, baseUrl } = await listen(createHttpApp());
    try {
      const res = await rawRequest(`${baseUrl}/health`, {
        Host: 'evil.example',
        Origin: 'http://evil.example',
      });
      expect(res.status).toBe(403);
      expect(res.body).toContain('Forbidden: Host not allowed');
      expect(res.body).not.toContain('evil.example');
    } finally {
      await closeServer(server);
    }
  });

  it('allows a loopback Host', async () => {
    const { server, baseUrl } = await listen(createHttpApp());
    try {
      const res = await rawRequest(`${baseUrl}/health`, { Host: 'localhost' });
      expect(res.status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  it('allows a Host from MCP_ALLOWED_HOSTS', async () => {
    process.env.MCP_ALLOWED_HOSTS = 'app.example.com';
    const { server, baseUrl } = await listen(createHttpApp());
    try {
      const res = await rawRequest(`${baseUrl}/health`, { Host: 'app.example.com' });
      expect(res.status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });
});

describe('HTTP bind guard', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      MCP_AUTH_MODE: 'none',
      MCP_HTTP_HOST: '0.0.0.0',
      MCP_SESSION_MODE: 'stateless',
    };
    delete process.env.MCP_ALLOW_UNAUTHENTICATED_HTTP;
    delete process.env.MCP_TLS_ENABLED;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('refuses to start off loopback when authentication is disabled', async () => {
    await expect(startHttpServer()).rejects.toThrow(/MCP_ALLOW_UNAUTHENTICATED_HTTP/);
  });
});

describe('HTTP /auth database host allowlist', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      MCP_AUTH_MODE: 'required',
      MCP_SESSION_MODE: 'stateless',
      DB2I_HOSTNAME: 'test-host',
      DB2I_DRIVER: 'jt400',
      DB2I_USERNAME: 'test-user',
      DB2I_PASSWORD: 'test-pass',
    };
    delete process.env.MCP_AUTH_ALLOWED_DB_HOSTS;
  });

  afterEach(async () => {
    await getTokenManager().shutdown();
    process.env = originalEnv;
  });

  it('rejects a database host outside the allowlist before opening a connection', async () => {
    const { pool } = await import('node-jt400');
    vi.mocked(pool).mockClear();

    const { server, baseUrl } = await listen(createHttpApp());
    try {
      const res = await fetch(`${baseUrl}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'user',
          password: 'pass',
          host: 'other.example.com',
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error_description: string };
      expect(body.error_description).toBe('Host is not allowed');
      expect(pool).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a schema that is not a library name before opening a connection', async () => {
    const { pool } = await import('node-jt400');
    vi.mocked(pool).mockClear();

    const { server, baseUrl } = await listen(createHttpApp());
    try {
      const res = await fetch(`${baseUrl}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'user',
          password: 'pass',
          schema: 'MYLIB;access=all;extended metadata=true',
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error_description: string };
      expect(body.error_description).toBe('schema must be an IBM i library name if provided');
      expect(pool).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });
});

describe('HTTP /auth rate limiting', () => {
  const originalEnv = process.env;
  // Each app gets its own limiter. The fake clock moves forward per test so the
  // window tests can set times relative to a known start.
  let clock = Date.now();

  beforeEach(() => {
    clock += 10 * 60_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(clock);
    process.env = {
      ...originalEnv,
      MCP_AUTH_MODE: 'required',
      MCP_SESSION_MODE: 'stateless',
      DB2I_HOSTNAME: 'test-host',
      DB2I_DRIVER: 'jt400',
      DB2I_USERNAME: 'test-user',
      DB2I_PASSWORD: 'test-pass',
    };
    delete process.env.MCP_AUTH_ALLOWED_DB_HOSTS;
  });

  afterEach(async () => {
    const { pool } = await import('node-jt400');
    vi.mocked(pool).mockImplementation(() => ({
      query: vi.fn().mockResolvedValue([]),
    }) as unknown as ReturnType<typeof pool>);
    vi.useRealTimers();
    await getTokenManager().shutdown();
    process.env = originalEnv;
  });

  async function mockDbLogin(succeeds: boolean): Promise<void> {
    const { pool } = await import('node-jt400');
    vi.mocked(pool).mockImplementation(() => ({
      query: vi.fn(() =>
        new Promise((resolve, reject) => {
          setTimeout(() => (succeeds ? resolve([]) : reject(new Error('Password not correct'))), 50);
        })
      ),
      close: vi.fn().mockResolvedValue(undefined),
    }) as unknown as ReturnType<typeof pool>);
  }

  function postAuth(baseUrl: string): Promise<Response> {
    return fetch(`${baseUrl}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'user', password: 'wrong' }),
    });
  }

  it('counts parallel attempts before any of them finishes', async () => {
    await mockDbLogin(false);
    const { server, baseUrl } = await listen(createHttpApp());
    try {
      const responses = await Promise.all(Array.from({ length: 8 }, () => postAuth(baseUrl)));
      const statuses = responses.map((res) => res.status).sort();
      expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429, 429]);
    } finally {
      await closeServer(server);
    }
  });

  it('does not count a successful login, and does not forget earlier failures', async () => {
    const { server, baseUrl } = await listen(createHttpApp());
    try {
      await mockDbLogin(false);
      for (let i = 0; i < 4; i++) {
        expect((await postAuth(baseUrl)).status).toBe(401);
      }

      // A valid profile must not reset the count used to guess another profile's password
      await mockDbLogin(true);
      expect((await postAuth(baseUrl)).status).toBe(201);
      expect((await postAuth(baseUrl)).status).toBe(201);

      await mockDbLogin(false);
      expect((await postAuth(baseUrl)).status).toBe(401);
      expect((await postAuth(baseUrl)).status).toBe(429);
    } finally {
      await closeServer(server);
    }
  });

  it('uses the configured attempt count and window', async () => {
    process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS = '2';
    process.env.AUTH_RATE_LIMIT_WINDOW_MS = '120000';
    await mockDbLogin(false);
    const { server, baseUrl } = await listen(createHttpApp());
    try {
      expect((await postAuth(baseUrl)).status).toBe(401);
      expect((await postAuth(baseUrl)).status).toBe(401);
      const limited = await postAuth(baseUrl);
      expect(limited.status).toBe(429);
      expect(((await limited.json()) as { retry_after: number }).retry_after).toBe(120);

      // Still inside the 2-minute window after the default 60 seconds
      vi.setSystemTime(clock + 90_000);
      expect((await postAuth(baseUrl)).status).toBe(429);

      vi.setSystemTime(clock + 120_000);
      expect((await postAuth(baseUrl)).status).toBe(401);
    } finally {
      await closeServer(server);
    }
  });

  it('keys the limit on the forwarded client address when MCP_TRUST_PROXY is set', async () => {
    process.env.MCP_TRUST_PROXY = '1';
    await mockDbLogin(false);
    const { server, baseUrl } = await listen(createHttpApp());
    const postFrom = (client: string): Promise<Response> =>
      fetch(`${baseUrl}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': client },
        body: JSON.stringify({ username: 'user', password: 'wrong' }),
      });
    try {
      for (let i = 0; i < 5; i++) {
        expect((await postFrom('203.0.113.10')).status).toBe(401);
      }
      expect((await postFrom('203.0.113.10')).status).toBe(429);
      expect((await postFrom('203.0.113.20')).status).toBe(401);
    } finally {
      await closeServer(server);
    }
  });
});

describe('HTTP session ownership', () => {
  const originalEnv = process.env;

  beforeEach(async () => {
    process.env = {
      ...originalEnv,
      MCP_AUTH_MODE: 'required',
      MCP_SESSION_MODE: 'stateful',
      MCP_CORS_ORIGINS: '',
      DB2I_HOSTNAME: 'test-host',
      DB2I_DRIVER: 'jt400',
      DB2I_USERNAME: 'test-user',
      DB2I_PASSWORD: 'test-pass',
    };
    await getSessionManager().shutdown();
    await getTokenManager().shutdown();
  });

  afterEach(async () => {
    await getSessionManager().shutdown();
    await getTokenManager().shutdown();
    process.env = originalEnv;
  });

  it('rejects GET and DELETE when the session belongs to another token', async () => {
    const tokenManager = getTokenManager();
    const owner = tokenManager.createSession(dbConfig);
    const other = tokenManager.createSession(dbConfig);

    const mcpServer = createServer({ sessionId: owner.token, binding: { system: 'default', config: dbConfig } });
    const { sessionId } = await getSessionManager().createSession(mcpServer, owner.token);

    const { server, baseUrl } = await listen(createHttpApp());
    try {
      const getRes = await fetch(`${baseUrl}/mcp`, {
        headers: {
          Authorization: `Bearer ${other.token}`,
          'Mcp-Session-Id': sessionId,
        },
      });
      expect(getRes.status).toBe(404);

      const deleteRes = await fetch(`${baseUrl}/mcp`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${other.token}`,
          'Mcp-Session-Id': sessionId,
        },
      });
      expect(deleteRes.status).toBe(404);

      const postRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${other.token}`,
          'Mcp-Session-Id': sessionId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/list',
          params: {},
          id: 1,
        }),
      });
      expect(postRes.status).toBe(404);

      expect(getSessionManager().hasSession(sessionId)).toBe(true);
    } finally {
      await closeServer(server);
      await mcpServer.close();
    }
  });
});

const MCP_ACCEPT = 'application/json, text/event-stream';

async function readRpc(res: Response): Promise<{
  result?: {
    protocolVersion?: string;
    supportedVersions?: string[];
    serverInfo?: { name?: string };
    _meta?: Record<string, { name?: string }>;
  };
}> {
  const text = await res.text();
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed) as Awaited<ReturnType<typeof readRpc>>;
  }
  const dataLine = trimmed.split('\n').find((line) => line.startsWith('data:'));
  if (!dataLine) {
    throw new Error(`Unexpected MCP body: ${trimmed.slice(0, 300)}`);
  }
  return JSON.parse(dataLine.slice('data:'.length).trim()) as Awaited<ReturnType<typeof readRpc>>;
}

describe('HTTP protocol eras', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      MCP_AUTH_MODE: 'none',
      MCP_SESSION_MODE: 'stateless',
      DB2I_HOSTNAME: 'test-host',
      DB2I_DRIVER: 'jt400',
      DB2I_USERNAME: 'test-user',
      DB2I_PASSWORD: 'test-pass',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('serves a 2025-era initialize without a session id', async () => {
    const { server, baseUrl } = await listen(createHttpApp());
    try {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: MCP_ACCEPT,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'legacy-test', version: '1.0.0' },
          },
        }),
      });
      expect(res.status).toBe(200);
      const body = await readRpc(res);
      expect(body.result?.protocolVersion).toBe('2025-06-18');
      expect(body.result?.serverInfo?.name).toBe('mcp-server-db2i');
      expect(res.headers.get('mcp-session-id')).toBeNull();
    } finally {
      await closeServer(server);
    }
  });

  it('serves a 2026-07-28 server/discover request', async () => {
    const { server, baseUrl } = await listen(createHttpApp());
    try {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: MCP_ACCEPT,
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'server/discover',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'server/discover',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': { name: 'modern-test', version: '1.0.0' },
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      });
      expect(res.status).toBe(200);
      const body = await readRpc(res);
      expect(body.result?.supportedVersions).toContain('2026-07-28');
      expect(body.result?._meta?.['io.modelcontextprotocol/serverInfo']?.name).toBe('mcp-server-db2i');
    } finally {
      await closeServer(server);
    }
  });
});
