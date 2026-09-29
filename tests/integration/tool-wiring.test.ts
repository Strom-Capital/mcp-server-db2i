/**
 * Tool registration wiring: each MCP tool passes its snake_case arguments to
 * the tool function under the right names. The tool functions are mocked, so
 * these tests only cover what server.ts does between the client and them.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/client';

const ok = vi.hoisted(() => () => vi.fn(async () => ({ success: true })));

vi.mock('../../src/tools/routines.js', () => ({
  listRoutinesTool: ok(),
  describeRoutineTool: ok(),
}));
vi.mock('../../src/tools/profile.js', () => ({ profileTableTool: ok() }));
vi.mock('../../src/tools/indexAdvice.js', () => ({ indexAdviceTool: ok() }));
vi.mock('../../src/tools/exportQuery.js', () => ({ exportQueryTool: ok() }));
vi.mock('../../src/tools/sqlServices.js', () => ({
  getJournalInfoTool: ok(),
  getObjectDdlTool: ok(),
  getRelatedObjectsTool: ok(),
  searchIbmiServicesTool: ok(),
  validateQueryTool: ok(),
}));

import { createServer } from '../../src/server.js';
import type { SessionContext } from '../../src/server.js';
import { listRoutinesTool, describeRoutineTool } from '../../src/tools/routines.js';
import { profileTableTool } from '../../src/tools/profile.js';
import { indexAdviceTool } from '../../src/tools/indexAdvice.js';
import { exportQueryTool } from '../../src/tools/exportQuery.js';
import {
  getJournalInfoTool,
  getObjectDdlTool,
  getRelatedObjectsTool,
  searchIbmiServicesTool,
  validateQueryTool,
} from '../../src/tools/sqlServices.js';
import { resetRateLimiterInstance } from '../../src/utils/rateLimiter.js';
import type { DB2iConfig } from '../../src/config.js';

const dbConfig: DB2iConfig = {
  hostname: 'ibmi.example.com',
  port: 446,
  username: 'MYUSER',
  password: 'secret',
  database: '*LOCAL',
  schema: 'MYLIB',
  driver: 'jt400',
  jdbcOptions: {},
  odbcOptions: {},
};

describe('tool argument wiring', () => {
  const originalEnv = process.env;
  let exportDir: string;
  let client: Client | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    exportDir = mkdtempSync(path.join(tmpdir(), 'db2i-wiring-'));
    process.env = {
      ...originalEnv,
      DB2I_HOSTNAME: 'ibmi.example.com',
      DB2I_DRIVER: 'jt400',
      DB2I_USERNAME: 'MYUSER',
      DB2I_PASSWORD: 'secret',
      DB2I_SCHEMA: 'MYLIB',
      EXPORT_ENABLED: 'true',
      EXPORT_DIR: exportDir,
    };
    delete process.env.MCP_TOOLS_ENABLED;
    delete process.env.MCP_TOOLS_DISABLED;
    resetRateLimiterInstance();
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    process.env = originalEnv;
    rmSync(exportDir, { recursive: true, force: true });
  });

  async function connect(sessionContext?: SessionContext): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer(sessionContext).connect(serverTransport);
    client = new Client({ name: 'wiring-test', version: '1.0.0' });
    await client.connect(clientTransport);
    return client;
  }

  async function call(name: string, args: Record<string, unknown>, sessionContext?: SessionContext) {
    const mcp = client ?? (await connect(sessionContext));
    const result = (await mcp.callTool({ name, arguments: args })) as CallToolResult;
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result;
  }

  function inputOf(fn: unknown): Record<string, unknown> {
    const mock = vi.mocked(fn as (input: Record<string, unknown>) => Promise<unknown>);
    expect(mock).toHaveBeenCalledTimes(1);
    return mock.mock.calls[0]![0];
  }

  it('list_routines', async () => {
    await call('list_routines', { schema: 'OTHERLIB', filter: 'GET*', type: 'FUNCTION', limit: 5 });
    expect(inputOf(listRoutinesTool)).toMatchObject({
      schema: 'OTHERLIB', filter: 'GET*', type: 'FUNCTION', limit: 5, defaultSchema: 'MYLIB',
    });
  });

  it('describe_routine passes specific_name as specificName', async () => {
    await call('describe_routine', { schema: 'OTHERLIB', name: 'GET_ORDER', specific_name: 'GET_ORDER_2' });
    expect(inputOf(describeRoutineTool)).toMatchObject({
      schema: 'OTHERLIB', name: 'GET_ORDER', specificName: 'GET_ORDER_2', defaultSchema: 'MYLIB',
    });
  });

  it('validate_query', async () => {
    await call('validate_query', { sql: 'SELECT ORDERNO FROM ORDERS' });
    expect(inputOf(validateQueryTool)).toMatchObject({ sql: 'SELECT ORDERNO FROM ORDERS', defaultSchema: 'MYLIB' });
  });

  it('get_object_ddl', async () => {
    await call('get_object_ddl', { schema: 'OTHERLIB', object: 'ORDERS', type: 'TABLE' });
    expect(inputOf(getObjectDdlTool)).toMatchObject({
      schema: 'OTHERLIB', object: 'ORDERS', type: 'TABLE', defaultSchema: 'MYLIB',
    });
  });

  it('get_related_objects', async () => {
    await call('get_related_objects', { schema: 'OTHERLIB', table: 'ORDERS' });
    expect(inputOf(getRelatedObjectsTool)).toMatchObject({ schema: 'OTHERLIB', table: 'ORDERS', defaultSchema: 'MYLIB' });
  });

  it('get_journal_info', async () => {
    await call('get_journal_info', { schema: 'OTHERLIB', filter: 'ORD*', limit: 7 });
    expect(inputOf(getJournalInfoTool)).toMatchObject({
      schema: 'OTHERLIB', filter: 'ORD*', limit: 7, defaultSchema: 'MYLIB',
    });
  });

  it('search_ibmi_services passes include_example and search_examples', async () => {
    await call('search_ibmi_services', {
      query: 'job', category: 'WORK MANAGEMENT', include_example: true, search_examples: true, limit: 3,
    });
    expect(inputOf(searchIbmiServicesTool)).toMatchObject({
      query: 'job', category: 'WORK MANAGEMENT', includeExample: true, searchExamples: true, limit: 3,
    });
  });

  it('index_advice', async () => {
    await call('index_advice', { schema: 'OTHERLIB', table: 'ORDERS', since: '2026-01-01', limit: 4 });
    expect(inputOf(indexAdviceTool)).toMatchObject({
      schema: 'OTHERLIB', table: 'ORDERS', since: '2026-01-01', limit: 4, defaultSchema: 'MYLIB',
    });
  });

  it('profile_table', async () => {
    await call('profile_table', { schema: 'OTHERLIB', table: 'ORDERS', compute: true, columns: ['ORDERNO'] });
    expect(inputOf(profileTableTool)).toMatchObject({
      schema: 'OTHERLIB', table: 'ORDERS', compute: true, columns: ['ORDERNO'], defaultSchema: 'MYLIB',
    });
  });

  it('export_query over stdio writes a file path owned by stdio', async () => {
    await call('export_query', {
      sql: 'SELECT ORDERNO FROM ORDERS', params: [1001], format: 'csv', filename: 'open-orders', max_rows: 50,
    });
    expect(inputOf(exportQueryTool)).toMatchObject({
      sql: 'SELECT ORDERNO FROM ORDERS',
      params: [1001],
      format: 'csv',
      filename: 'open-orders',
      maxRows: 50,
      delivery: 'path',
      owner: 'stdio',
      defaultSchema: 'MYLIB',
    });
  });

  it('export_query over HTTP returns a link owned by the caller, with a resource_link', async () => {
    vi.mocked(exportQueryTool).mockResolvedValueOnce({
      success: true,
      filename: 'open-orders.csv',
      url: 'https://mcp.example.com/exports/abc',
    } as never);
    const session: SessionContext = { sessionId: 'wiring-token', binding: { system: 'default', config: dbConfig } };

    const result = await call('export_query', { sql: 'SELECT ORDERNO FROM ORDERS', format: 'csv' }, session);

    expect(inputOf(exportQueryTool)).toMatchObject({ delivery: 'link', owner: 'MYUSER' });
    expect(result.content).toContainEqual(expect.objectContaining({
      type: 'resource_link',
      uri: 'https://mcp.example.com/exports/abc',
      name: 'open-orders.csv',
      mimeType: 'text/csv; charset=utf-8',
    }));
  });

  it('export_query adds no resource_link when the export has no url', async () => {
    const result = await call('export_query', { sql: 'SELECT ORDERNO FROM ORDERS' });
    expect(result.content.some((item) => item.type === 'resource_link')).toBe(false);
  });
});
