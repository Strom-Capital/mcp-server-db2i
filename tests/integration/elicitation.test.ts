/**
 * Elicitation through a real MCP client: a 2026-07-28 client (input_required
 * and a retry), a 2025-era client (the SDK's legacy shim sends
 * elicitation/create), and clients that do not declare elicitation.
 * Database calls go through the mocked JT400 pool.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport, type CallToolResult, type ElicitRequest, type ElicitResult } from '@modelcontextprotocol/client';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';

const mockQuery = vi.fn();
vi.mock('node-jt400', async () => {
  const { withExecute } = await import('../helpers/jt400Fake.js');
  return { pool: vi.fn(() => withExecute({ query: mockQuery })) };
});

const checkLimit = vi.fn(() => ({ allowed: true, remaining: 99 }));
vi.mock('../../src/utils/rateLimiter.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/utils/rateLimiter.js')>();
  return { ...original, getRateLimiter: vi.fn(() => ({ checkLimit, formatError: vi.fn() })) };
});

const writeAudit = vi.fn();
vi.mock('../../src/utils/auditLog.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/utils/auditLog.js')>();
  return { ...original, writeAudit: (entry: unknown) => writeAudit(entry) };
});

import { loadCustomTools } from '../../src/customTools/loader.js';
import { resetCustomTools, setCustomTools } from '../../src/customTools/registry.js';
import { initializePool } from '../../src/db/connection.js';
import { resetElicitationState } from '../../src/elicitation/state.js';
import { closeExportStore, initExportStore } from '../../src/export/store.js';
import { createServer } from '../../src/server.js';

const TOOLS_YAML = `
version: 1
tools:
  - name: orders_by_status
    title: Orders by status
    description: Orders with one status.
    parameters:
      status:
        type: enum
        enum: [OPEN, CLOSED]
        description: Order status
        ask: true
      since:
        type: date
        required: false
        ask: true
    sql: SELECT ORDERNO FROM MYLIB.ORDERS WHERE STATUS = :status AND ORDERDATE >= :since
`;

type Era = 'modern' | 'legacy';

function textOf(result: CallToolResult): string {
  return (result.content[0] as { type: 'text'; text: string }).text;
}

describe('elicitation', () => {
  const originalEnv = process.env;
  let dir: string;
  let client: Client | undefined;
  let stdio: StdioServerHandle | undefined;
  const asked: ElicitRequest['params'][] = [];

  async function connect(era: Era, answer?: (params: ElicitRequest['params']) => ElicitResult): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    // As in stdio mode: one server per connection, speaking 2025 and 2026-07-28
    stdio = serveStdio(() => createServer(), { transport: serverTransport });
    client = new Client(
      { name: 'elicitation-test', version: '1.0.0' },
      {
        ...(answer ? { capabilities: { elicitation: {} } } : {}),
        ...(era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}),
      },
    );
    if (answer) {
      client.setRequestHandler('elicitation/create', async (request) => {
        asked.push(request.params);
        return answer(request.params);
      });
    }
    await client.connect(clientTransport);
    return client;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mockQuery.mockReset();
    asked.length = 0;
    resetElicitationState();
    dir = mkdtempSync(path.join(tmpdir(), 'db2i-elicitation-'));
    const file = path.join(dir, 'tools.yaml');
    writeFileSync(file, TOOLS_YAML);
    process.env = {
      ...originalEnv,
      DB2I_HOSTNAME: 'ibmi.example.com',
      DB2I_DRIVER: 'jt400',
      DB2I_USERNAME: 'test-user',
      DB2I_PASSWORD: 'test-pass',
      DB2I_SCHEMA: 'MYLIB',
      QUERY_PARSE_CHECK: 'false',
      QUERY_ALLOWED_SCHEMAS: 'MYLIB',
      MCP_RESPONSE_FORMAT: 'json',
      EXPORT_ENABLED: 'true',
      EXPORT_DIR: path.join(dir, 'exports'),
      EXPORT_CONFIRM_ROWS: '1000',
    };
    delete process.env.MCP_TOOLS_ENABLED;
    delete process.env.MCP_TOOLS_DISABLED;
    delete process.env.MCP_CUSTOM_TOOLS_ASK;
    setCustomTools(loadCustomTools([file], { allowedSchemas: ['MYLIB'], defaultSchema: 'MYLIB' }));
    initializePool({
      hostname: 'ibmi.example.com',
      port: 446,
      username: 'test-user',
      password: 'test-pass',
      database: '*LOCAL',
      schema: 'MYLIB',
      driver: 'jt400',
      jdbcOptions: {},
      odbcOptions: {},
    });
    await initExportStore();
  });

  afterEach(async () => {
    await client?.close();
    await stdio?.close();
    client = undefined;
    stdio = undefined;
    await closeExportStore();
    process.env = originalEnv;
    resetCustomTools();
    resetElicitationState();
    rmSync(dir, { recursive: true, force: true });
  });

  describe.each<Era>(['modern', 'legacy'])('%s client with elicitation', (era) => {
    it('asks for the ask parameters the model left out, then runs with the answer', async () => {
      mockQuery.mockResolvedValueOnce([{ ORDERNO: 1001 }]);
      const mcp = await connect(era, () => ({ action: 'accept', content: { status: 'OPEN', since: '2026-01-01' } }));

      const result = await mcp.callTool({ name: 'orders_by_status', arguments: {} }) as CallToolResult;

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(textOf(result))).toMatchObject({ success: true, rowCount: 1 });
      expect(asked).toHaveLength(1);
      expect(asked[0].message).toContain('status, since');
      const schema = (asked[0] as { requestedSchema: { properties: Record<string, unknown>; required?: string[] } }).requestedSchema;
      expect(schema.properties.status).toMatchObject({ type: 'string', enum: ['OPEN', 'CLOSED'] });
      expect(schema.properties.since).toMatchObject({ type: 'string', format: 'date' });
      expect(schema.required).toEqual(['status']);
      expect(mockQuery.mock.calls[0][1]).toEqual(['OPEN', '2026-01-01']);
      // The retry is the same call: one rate limit token, and the answer is not in the audit line
      expect(checkLimit).toHaveBeenCalledTimes(1);
      const lines = writeAudit.mock.calls.map(([entry]) => entry as Record<string, unknown>);
      expect(lines.map((line) => line.outcome)).toEqual(['input_required', 'success']);
      expect(lines[1].elicitation).toEqual({ kind: 'tool_params', outcome: 'accept' });
      expect(JSON.stringify(lines)).not.toContain('2026-01-01');
    });

    it('does not ask when the model gave the parameters', async () => {
      mockQuery.mockResolvedValueOnce([]);
      const mcp = await connect(era, () => ({ action: 'accept', content: {} }));

      const result = await mcp.callTool({
        name: 'orders_by_status',
        arguments: { status: 'CLOSED', since: '2026-02-01' },
      }) as CallToolResult;

      expect(result.isError).toBeUndefined();
      expect(asked).toHaveLength(0);
    });

    it('stops the tool when the user declines', async () => {
      const mcp = await connect(era, () => ({ action: 'decline' }));

      const result = await mcp.callTool({ name: 'orders_by_status', arguments: {} }) as CallToolResult;

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('did not give status, since');
      expect(mockQuery).not.toHaveBeenCalled();
      const last = writeAudit.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(last).toMatchObject({ errorKind: 'elicitation_declined', elicitation: { kind: 'tool_params', outcome: 'decline' } });
    });

    it('still validates the answer like any other argument', async () => {
      const mcp = await connect(era, () => ({ action: 'accept', content: { status: 'OPEN', since: 'yesterday' } }));

      const result = await mcp.callTool({ name: 'orders_by_status', arguments: {} }) as CallToolResult;

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('YYYY-MM-DD');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('asks before a large export and stops when the user cancels', async () => {
      const mcp = await connect(era, () => ({ action: 'cancel' }));

      const result = await mcp.callTool({
        name: 'export_query',
        arguments: { sql: 'SELECT ORDERNO FROM MYLIB.ORDERS', format: 'csv' },
      }) as CallToolResult;

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('not started');
      expect(asked[0].message).toBe('Export up to 100,000 rows as CSV?');
      const schema = (asked[0] as { requestedSchema: { properties: Record<string, unknown> } }).requestedSchema;
      expect(schema.properties.max_rows).toMatchObject({ type: 'integer', maximum: 100_000, default: 100_000 });
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('does not ask for an export within EXPORT_CONFIRM_ROWS', async () => {
      const mcp = await connect(era, () => ({ action: 'cancel' }));

      await mcp.callTool({
        name: 'export_query',
        arguments: { sql: 'SELECT ORDERNO FROM MYLIB.ORDERS', format: 'csv', max_rows: 500 },
      });

      expect(asked).toHaveLength(0);
    });
  });

  describe.each<Era>(['modern', 'legacy'])('%s client without elicitation', (era) => {
    it('keeps today\'s behaviour: a missing required parameter is an error', async () => {
      const mcp = await connect(era);

      const result = await mcp.callTool({ name: 'orders_by_status', arguments: {} }) as CallToolResult;

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('status');
      expect(mockQuery).not.toHaveBeenCalled();
      expect(writeAudit.mock.calls.map(([entry]) => (entry as { outcome: string }).outcome)).toEqual(['error']);
    });
  });

  it('turns ask parameters off with MCP_CUSTOM_TOOLS_ASK=false', async () => {
    process.env.MCP_CUSTOM_TOOLS_ASK = 'false';
    const mcp = await connect('modern', () => ({ action: 'accept', content: { status: 'OPEN' } }));

    const { tools } = await mcp.listTools();
    const schema = tools.find((tool) => tool.name === 'orders_by_status')?.inputSchema as { required?: string[] };
    expect(schema.required).toEqual(['status']);
    const result = await mcp.callTool({ name: 'orders_by_status', arguments: { status: 'OPEN' } }) as CallToolResult;
    expect(asked).toHaveLength(0);
    expect(result.isError).toBeUndefined();
  });

  it('advertises ask parameters as optional so the model can leave them out', async () => {
    const mcp = await connect('modern', () => ({ action: 'cancel' }));

    const { tools } = await mcp.listTools();
    const schema = tools.find((tool) => tool.name === 'orders_by_status')?.inputSchema as {
      required?: string[];
      properties: Record<string, { description?: string }>;
    };
    expect(schema.required ?? []).not.toContain('status');
    expect(JSON.stringify(schema.properties.status)).toContain('the user is then asked');
  });
});
