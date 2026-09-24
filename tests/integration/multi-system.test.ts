/**
 * Tools across several IBM i systems configured with DB2I_PROFILES.
 * Database calls go through the mocked JT400 pool, which records the host.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/client';

const mockQuery = vi.fn();
const mockPool = vi.hoisted(() => vi.fn());
vi.mock('node-jt400', () => ({
  pool: mockPool,
}));

vi.mock('../../src/utils/rateLimiter.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/utils/rateLimiter.js')>();
  return {
    ...original,
    getRateLimiter: vi.fn(() => ({
      checkLimit: vi.fn(() => ({ allowed: true, remaining: 99 })),
      formatError: vi.fn(),
    })),
  };
});

import { loadCustomTools, systemLoadOptions, CustomToolsError } from '../../src/customTools/loader.js';
import { resetCustomTools, setCustomTools } from '../../src/customTools/registry.js';
import {
  closeGlobalPool,
  closeSessionPool,
  initializePool,
  initializeSessionPool,
} from '../../src/db/connection.js';
import { createServer, type SessionContext } from '../../src/server.js';
import { defaultSystem, getSystem, resetSystems } from '../../src/systems.js';

const PROFILES = `
profiles:
  - name: prod
    host: prod.example.com
    driver: jt400
    username: PRODUSER
    password: \${PROD_PASSWORD}
    schema: SALES
    allowedSchemas: [SALES]
  - name: test
    host: test.example.com
    driver: jt400
    username: TESTUSER
    password: \${TEST_PASSWORD}
    schema: SCRATCH
`;

const TOOLS = `
version: 1
tools:
  - name: prod_orders
    title: Prod orders
    description: Orders on prod.
    system: prod
    sql: SELECT ORDERNO FROM SALES.ORDERS
  - name: scratch_rows
    title: Scratch rows
    description: Rows on test.
    system: test
    sql: SELECT ID FROM SCRATCH.ROWS
  - name: any_orders
    title: Any orders
    description: Orders on the chosen system.
    sql: SELECT ORDERNO FROM SALES.ORDERS
`;

function textOf(result: CallToolResult): string {
  return (result.content[0] as { type: 'text'; text: string }).text;
}

/** Host of every JT400 pool created so far, in order. */
function poolHosts(): string[] {
  return mockPool.mock.calls.map(([config]) => (config as { host: string }).host);
}

describe('several IBM i systems', () => {
  const originalEnv = process.env;
  const dirs: string[] = [];
  const open: Array<() => Promise<void>> = [];

  function tempFile(name: string, contents: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'db2i-multi-'));
    dirs.push(dir);
    const file = path.join(dir, name);
    writeFileSync(file, contents);
    return file;
  }

  async function connect(sessionContext?: SessionContext): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer(sessionContext);
    await server.connect(serverTransport);
    const client = new Client({ name: 'multi-system-test', version: '1.0.0' });
    await client.connect(clientTransport);
    open.push(async () => {
      await client.close();
      await server.close();
    });
    return client;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockReset();
    mockQuery.mockResolvedValue([{ ORDERNO: 1 }]);
    mockPool.mockImplementation(() => ({ query: mockQuery, close: vi.fn() }));

    process.env = {
      ...originalEnv,
      PROD_PASSWORD: 'prodpass',
      TEST_PASSWORD: 'testpass',
      QUERY_PARSE_CHECK: 'false',
      MCP_RESPONSE_FORMAT: 'json',
    };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('DB2I_') || key.startsWith('MCP_TOOLS_') || key === 'QUERY_ALLOWED_SCHEMAS') {
        delete process.env[key];
      }
    }
    process.env.DB2I_PROFILES = tempFile('profiles.yaml', PROFILES);
    resetSystems();

    setCustomTools(loadCustomTools([tempFile('tools.yaml', TOOLS)], systemLoadOptions()));
    const fallback = defaultSystem();
    initializePool(fallback.config, fallback.name);
  });

  afterEach(async () => {
    for (const close of open.splice(0)) {
      await close();
    }
    await closeGlobalPool();
    resetCustomTools();
    resetSystems();
    process.env = originalEnv;
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('offers a system argument listing every profile', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const query = tools.find((tool) => tool.name === 'execute_query');
    const system = (query?.inputSchema.properties as Record<string, { enum?: string[] }>).system;
    expect(system?.enum).toEqual(['prod', 'test']);
    expect(query?.inputSchema.required ?? []).not.toContain('system');

    const context = tools.find((tool) => tool.name === 'get_business_context');
    expect(context?.inputSchema.properties).not.toHaveProperty('system');
  });

  it('runs on the first profile by default and on the named one when asked', async () => {
    const client = await connect();

    const onProd = await client.callTool({
      name: 'execute_query',
      arguments: { sql: 'SELECT ORDERNO FROM SALES.ORDERS' },
    }) as CallToolResult;
    expect(onProd.isError).toBeUndefined();

    const onTest = await client.callTool({
      name: 'execute_query',
      arguments: { sql: 'SELECT ID FROM SCRATCH.ROWS', system: 'test' },
    }) as CallToolResult;
    expect(onTest.isError).toBeUndefined();

    expect(poolHosts()).toEqual(['prod.example.com', 'test.example.com']);
  });

  it('applies each system’s own allowlist and default schema', async () => {
    const client = await connect();

    const denied = await client.callTool({
      name: 'execute_query',
      arguments: { sql: 'SELECT ID FROM SCRATCH.ROWS' },
    }) as CallToolResult;
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toMatch(/SCRATCH/);

    mockQuery.mockResolvedValueOnce([{ TABLE_NAME: 'ROWS', TABLE_TYPE: 'T', TABLE_TEXT: null }]);
    const listed = await client.callTool({
      name: 'list_tables',
      arguments: { system: 'test' },
    }) as CallToolResult;
    expect(listed.isError).toBeUndefined();
    expect(mockQuery.mock.calls.at(-1)?.[1]).toContain('SCRATCH');
  });

  it('reports an unknown system as a tool error', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'execute_query',
      arguments: { sql: 'SELECT 1 FROM SYSIBM.SYSDUMMY1', system: 'dev' },
    }) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/"prod"\|"test"/);
    expect(mockPool).not.toHaveBeenCalled();
  });

  it('runs a YAML tool on its fixed system and offers no system argument', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const fixed = tools.find((tool) => tool.name === 'scratch_rows');
    expect(fixed?.inputSchema.properties ?? {}).not.toHaveProperty('system');
    const chosen = tools.find((tool) => tool.name === 'any_orders');
    expect(chosen?.inputSchema.properties).toHaveProperty('system');

    const result = await client.callTool({ name: 'scratch_rows', arguments: {} }) as CallToolResult;
    expect(result.isError).toBeUndefined();
    expect(poolHosts()).toEqual(['test.example.com']);

    const chosenResult = await client.callTool({
      name: 'any_orders',
      arguments: { system: 'test' },
    }) as CallToolResult;
    expect(chosenResult.isError).toBeUndefined();
  });

  describe('a session bound at /auth', () => {
    const sessionId = 'token-bound-to-test';

    beforeEach(() => {
      initializeSessionPool(sessionId);
    });

    afterEach(async () => {
      await closeSessionPool(sessionId);
    });

    function boundToTest(): SessionContext {
      const test = getSystem('test');
      if (!test) {
        throw new Error('test profile missing');
      }
      return {
        sessionId,
        binding: { system: 'test', config: { ...test.config, username: 'CALLER', password: 'callerpass' } },
      };
    }

    it('offers no system argument and hides tools fixed to other systems', async () => {
      const client = await connect(boundToTest());
      const { tools } = await client.listTools();
      const query = tools.find((tool) => tool.name === 'execute_query');
      expect(query?.inputSchema.properties).not.toHaveProperty('system');
      expect(tools.map((tool) => tool.name)).toContain('scratch_rows');
      expect(tools.map((tool) => tool.name)).not.toContain('prod_orders');
    });

    it('connects to its system with the caller’s credentials', async () => {
      const client = await connect(boundToTest());
      const result = await client.callTool({
        name: 'execute_query',
        arguments: { sql: 'SELECT ID FROM SCRATCH.ROWS' },
      }) as CallToolResult;
      expect(result.isError).toBeUndefined();
      const [config] = mockPool.mock.calls[0] as [{ host: string; user: string }];
      expect(config.host).toBe('test.example.com');
      expect(config.user).toBe('CALLER');
    });
  });
});

describe('YAML tools naming a system', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it('refuses a system that is not configured', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'db2i-multi-'));
    try {
      const file = path.join(dir, 'tools.yaml');
      writeFileSync(file, `
version: 1
tools:
  - name: dev_rows
    title: Dev rows
    description: Rows on dev.
    system: dev
    sql: SELECT ID FROM SCRATCH.ROWS
`);
      expect(() => loadCustomTools([file], { systems: [{ name: 'prod' }, { name: 'test' }] })).toThrow(
        CustomToolsError
      );
      expect(() => loadCustomTools([file], { systems: [{ name: 'prod' }, { name: 'test' }] })).toThrow(
        /system dev is not configured. Available: prod, test/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checks a fixed tool against its system’s allowlist', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'db2i-multi-'));
    try {
      const file = path.join(dir, 'tools.yaml');
      writeFileSync(file, `
version: 1
tools:
  - name: scratch_rows
    title: Scratch rows
    description: Rows on test.
    system: test
    sql: SELECT ID FROM SCRATCH.ROWS
`);
      const systems = [
        { name: 'prod', allowedSchemas: ['SALES'] },
        { name: 'test', allowedSchemas: ['SCRATCH'] },
      ];
      expect(() => loadCustomTools([file], { allowedSchemas: ['SALES'], systems })).not.toThrow();
      expect(() =>
        loadCustomTools([file], { allowedSchemas: ['SALES'], systems: [systems[0], { name: 'test', allowedSchemas: ['SALES'] }] })
      ).toThrow(/Schema allowlist rejected the query/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
