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

import { createHttpApp } from '../src/transports/http.js';
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
  jdbcOptions: {},
};

async function listen(app: Express): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
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

    const mcpServer = createServer(dbConfig, owner.token);
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
