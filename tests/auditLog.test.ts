import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const writeSync = vi.hoisted(() => vi.fn<(fd: number, data: string) => number>());

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    writeSync: (fd: number, data: string) => writeSync(fd, data),
  };
});

vi.mock('../src/db/connection.js', () => ({
  executeQuery: vi.fn(async () => ({ rows: [{ ORDERNO: 1 }] })),
  executeProcedure: vi.fn(),
}));

import { loadCustomTools } from '../src/customTools/loader.js';
import { resetCustomTools, setCustomTools } from '../src/customTools/registry.js';
import { createServer, liveCustomTool, withToolHandler } from '../src/server.js';
import { closeAuditLog, initAuditLog, writeAudit, writeAuditEvent } from '../src/utils/auditLog.js';
import { logger } from '../src/utils/logger.js';
import { resetRateLimiterInstance } from '../src/utils/rateLimiter.js';
import { getBuildId, type DB2iConfig } from '../src/config.js';
import { SERVER_VERSION } from '../src/version.js';
import { CLIENT_INFO_META_KEY } from '@modelcontextprotocol/server';
import { prepareReadQuery } from '../src/tools/query.js';
import type { DbTarget } from '../src/systems.js';

const dirs: string[] = [];

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  writeSync.mockImplementation((fd, data) => actual.writeSync(fd, data));
});

afterEach(() => {
  closeAuditLog();
  resetCustomTools();
  resetRateLimiterInstance();
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
  delete process.env.MCP_AUDIT_LOG;
  delete process.env.MCP_AUDIT_SQL;
  delete process.env.MCP_AUDIT_PARAMS;
  delete process.env.QUERY_PARSE_CHECK;
  delete process.env.RATE_LIMIT_MAX_REQUESTS;
  delete process.env.MCP_TOOL_INTENT;
  delete process.env.MCP_BUILD_ID;
  vi.restoreAllMocks();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'db2i-audit-'));
  dirs.push(dir);
  return dir;
}

function readLines(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('audit log writer', () => {
  it('appends JSON lines to a file and hashes SQL by default', () => {
    const file = path.join(tempDir(), 'audit.log');
    process.env.MCP_AUDIT_LOG = file;
    initAuditLog();
    writeAudit({
      tool: 'execute_query',
      identity: 'stdio',
      sql: 'SELECT ORDERNO FROM MYLIB.ORDERS',
      params: [1001],
      rowCount: 1,
      durationMs: 4,
      outcome: 'success',
    });
    const [line] = readLines(file);
    expect(line?.tool).toBe('execute_query');
    expect(line?.sql).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(line)).not.toContain('MYLIB.ORDERS');
    expect(line?.paramCount).toBe(1);
    expect(line?.params).toBeUndefined();
    expect(line?.rowCount).toBe(1);
    expect(line?.outcome).toBe('success');
  });

  it('keeps the SQL and the parameters when asked', () => {
    const file = path.join(tempDir(), 'audit.log');
    process.env.MCP_AUDIT_LOG = file;
    process.env.MCP_AUDIT_SQL = 'full';
    process.env.MCP_AUDIT_PARAMS = 'true';
    initAuditLog();
    writeAudit({
      tool: 'execute_query',
      identity: 'stdio',
      sql: 'SELECT ORDERNO FROM MYLIB.ORDERS WHERE ORDERNO = ?',
      params: [1001],
      outcome: 'success',
    });
    const [line] = readLines(file);
    expect(line?.sql).toBe('SELECT ORDERNO FROM MYLIB.ORDERS WHERE ORDERNO = ?');
    expect(line?.params).toEqual([1001]);
  });

  it('writes a shutdown event line', () => {
    const file = path.join(tempDir(), 'audit.log');
    process.env.MCP_AUDIT_LOG = file;
    initAuditLog();
    writeAuditEvent({ event: 'shutdown', reason: 'stdin closed' });
    const [line] = readLines(file);
    expect(line).toEqual({ time: expect.any(String), serverVersion: SERVER_VERSION, event: 'shutdown', reason: 'stdin closed' });
  });

  it('writes the server version on every line, and the build when MCP_BUILD_ID is set', () => {
    const file = path.join(tempDir(), 'audit.log');
    process.env.MCP_AUDIT_LOG = file;
    initAuditLog();
    writeAudit({ tool: 'list_schemas', identity: 'stdio', outcome: 'success' });

    process.env.MCP_BUILD_ID = 'a1b2c3d-dirty';
    initAuditLog();
    writeAudit({ tool: 'list_schemas', identity: 'stdio', outcome: 'success' });
    writeAuditEvent({ event: 'sign_in', method: 'password', identity: 'TESTUSER', outcome: 'success' });

    const lines = readLines(file);
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(lines.map((line) => [line.serverVersion, line.build])).toEqual([
      [SERVER_VERSION, undefined],
      [SERVER_VERSION, 'a1b2c3d-dirty'],
      [SERVER_VERSION, 'a1b2c3d-dirty'],
    ]);
  });

  it('refuses an MCP_BUILD_ID that is not a short token', () => {
    for (const value of ['has space', 'x'.repeat(65), 'semi;colon', '{"json":1}']) {
      process.env.MCP_BUILD_ID = value;
      expect(() => getBuildId()).toThrow('MCP_BUILD_ID must be 1 to 64 letters, digits and . _ + -');
    }
    process.env.MCP_BUILD_ID = '  ';
    expect(getBuildId()).toBeUndefined();
    process.env.MCP_BUILD_ID = 'v3.5.0+abc1234';
    expect(getBuildId()).toBe('v3.5.0+abc1234');
  });

  it('writes no event when the audit log is off', () => {
    initAuditLog();
    writeAuditEvent({ event: 'shutdown', reason: 'SIGTERM' });
    expect(writeSync).not.toHaveBeenCalled();
  });

  it('refuses a path that cannot be opened', () => {
    process.env.MCP_AUDIT_LOG = path.join(tempDir(), 'missing', 'audit.log');
    expect(() => initAuditLog()).toThrow(/MCP_AUDIT_LOG is not writable/);
  });

  it('reports a write failure once and does not throw', () => {
    const file = path.join(tempDir(), 'audit.log');
    process.env.MCP_AUDIT_LOG = file;
    initAuditLog();
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    writeSync.mockImplementation(() => {
      throw new Error('disk full');
    });
    writeAudit({ tool: 'list_schemas', identity: 'stdio', sql: null, outcome: 'success' });
    writeAudit({ tool: 'list_schemas', identity: 'stdio', sql: null, outcome: 'success' });
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe('tool call audit', () => {
  it('records success, error, and rate limit with the caller identity', async () => {
    const file = path.join(tempDir(), 'audit.log');
    process.env.MCP_AUDIT_LOG = file;
    process.env.MCP_AUDIT_SQL = 'full';
    initAuditLog();

    const session = {
      sessionId: 'token',
      binding: { system: 'default', config: { username: 'MYUSER' } as DB2iConfig },
    };
    const audit = {
      tool: 'execute_query',
      audit: () => ({ sql: 'SELECT ORDERNO FROM MYLIB.ORDERS', params: [1001] }),
    };

    await withToolHandler(async () => ({ success: true, rowCount: 2 }), 'Query failed', session, audit)({});
    await withToolHandler(
      async () => ({ success: false, error: 'not a query' }),
      'Query failed',
      undefined,
      audit,
    )({});

    resetRateLimiterInstance();
    process.env.RATE_LIMIT_MAX_REQUESTS = '0';
    resetRateLimiterInstance();
    await withToolHandler(async () => ({ success: true }), 'Query failed', undefined, audit)({});

    const lines = readLines(file);
    expect(lines.map((line) => line.outcome)).toEqual(['success', 'error', 'rate_limited']);
    expect(lines[0]?.identity).toBe('MYUSER');
    expect(lines[0]?.system).toBe('default');
    expect(lines[0]?.rowCount).toBe(2);
    expect(lines[0]?.durationMs).toEqual(expect.any(Number));
    expect(lines[1]?.identity).toBe('stdio');
    expect(lines[1]?.error).toBe('not a query');
    expect(lines[2]?.durationMs).toBeUndefined();
    expect(lines[2]?.rowCount).toBeUndefined();
  });

  it('marks a result cut at a limit', async () => {
    const file = path.join(tempDir(), 'audit.log');
    process.env.MCP_AUDIT_LOG = file;
    initAuditLog();
    const audit = { tool: 'execute_query', audit: () => ({ sql: 'SELECT ORDERNO FROM MYLIB.ORDERS', params: [] }) };

    await withToolHandler(async () => ({ success: true, rowCount: 2, truncated: true }), 'Query failed', undefined, audit)({});
    await withToolHandler(async () => ({ success: true, rowCount: 2, truncated: false }), 'Query failed', undefined, audit)({});
    await withToolHandler(async () => ({ success: true, rowCount: 5, truncated: 'rows' }), 'Query failed', undefined, audit)({});

    const lines = readLines(file);
    expect(lines.map((line) => line.truncated)).toEqual([true, undefined, true]);
  });

  it('records the row filters a query left out', async () => {
    const file = path.join(tempDir(), 'audit.log');
    process.env.MCP_AUDIT_LOG = file;
    initAuditLog();
    const audit = { tool: 'execute_query', audit: () => ({ sql: 'SELECT ORDERNO FROM MYLIB.ORDERS', params: [] }) };

    await withToolHandler(
      async () => ({ success: true, rowCount: 1, skippedFilters: ['MYLIB.ORDERS'] }),
      'Query failed',
      undefined,
      audit,
    )({});
    await withToolHandler(async () => ({ success: true, rowCount: 1 }), 'Query failed', undefined, audit)({});

    const lines = readLines(file);
    expect(lines.map((line) => line.skippedFilters)).toEqual([['MYLIB.ORDERS'], undefined]);
  });

  it('records a handler that throws, and still throws', async () => {
    const file = path.join(tempDir(), 'audit.log');
    process.env.MCP_AUDIT_LOG = file;
    initAuditLog();

    const handler = withToolHandler(
      async () => {
        throw new Error('connection reset');
      },
      'Query failed',
      undefined,
      { tool: 'execute_query', audit: () => ({ sql: 'SELECT ORDERNO FROM MYLIB.ORDERS' }) },
    );

    await expect(handler({})).rejects.toThrow('connection reset');
    const [line] = readLines(file);
    expect(line?.tool).toBe('execute_query');
    expect(line?.outcome).toBe('error');
    expect(line?.error).toBe('connection reset');
    expect(line?.durationMs).toEqual(expect.any(Number));
  });

  it('records a call to a system that does not exist without running the handler', async () => {
    const file = path.join(tempDir(), 'audit.log');
    process.env.MCP_AUDIT_LOG = file;
    initAuditLog();

    const run = vi.fn(async () => ({ success: true }));
    const response = await withToolHandler(run, 'Query failed', undefined, { tool: 'list_schemas' })({
      system: 'nosuchsystem',
    });

    expect(run).not.toHaveBeenCalled();
    expect(response.isError).toBe(true);
    const [line] = readLines(file);
    expect(line?.outcome).toBe('error');
    expect(line?.system).toBe('nosuchsystem');
  });

  it('records a YAML tool statement and its bound values', async () => {
    const file = path.join(tempDir(), 'audit.log');
    process.env.MCP_AUDIT_LOG = file;
    process.env.MCP_AUDIT_SQL = 'full';
    process.env.MCP_AUDIT_PARAMS = 'true';
    process.env.QUERY_PARSE_CHECK = 'false';
    initAuditLog();

    const dir = tempDir();
    const yaml = path.join(dir, 'tools.yaml');
    writeFileSync(yaml, `
version: 1
tools:
  - name: search_sales_orders
    title: Search sales orders
    description: Open sales orders for a customer.
    parameters:
      customer: { type: string, required: true, description: Customer number }
    sql: SELECT ORDERNO FROM MYLIB.ORDERS WHERE CUSTNO = :customer
`);
    setCustomTools(loadCustomTools([dir]));
    const server = createServer();
    const tool = liveCustomTool(server, 'search_sales_orders');
    await tool?.handler({ customer: '1001' } as never, {} as never);

    const [line] = readLines(file);
    expect(line?.tool).toBe('search_sales_orders');
    expect(line?.sql).toBe('SELECT ORDERNO FROM MYLIB.ORDERS WHERE CUSTNO = ?');
    expect(line?.params).toEqual(['1001']);
    expect(line?.outcome).toBe('success');
    expect(line?.rowCount).toBe(1);
  });
});

describe('call details in the audit log', () => {
  const session = {
    sessionId: 'grant:secret-session-key',
    binding: { system: 'default', config: { username: 'MYUSER' } as DB2iConfig },
  };

  function auditTo(): string {
    const file = path.join(tempDir(), 'audit.log');
    process.env.MCP_AUDIT_LOG = file;
    process.env.MCP_AUDIT_SQL = 'full';
    initAuditLog();
    return file;
  }

  it('takes the context argument out of the arguments and records it as intent', async () => {
    const file = auditTo();
    process.env.MCP_TOOL_INTENT = 'true';
    const run = vi.fn(async (_args: Record<string, unknown>) => ({ success: true }));
    await withToolHandler(run, 'Failed', session, {
      tool: 'describe_table',
      audit: (args) => ({ sql: null, args }),
    })({ table: 'ORDERS', context: '  Find the order number column for a report  ' });

    expect(run.mock.calls[0]?.[0]).toEqual({ table: 'ORDERS' });
    const [line] = readLines(file);
    expect(line?.intent).toBe('Find the order number column for a report');
    expect(line?.args).toEqual({ table: 'ORDERS' });
  });

  it('cuts a long intent instead of failing the call', async () => {
    const file = auditTo();
    process.env.MCP_TOOL_INTENT = 'true';
    const run = vi.fn(async (_args: Record<string, unknown>) => ({ success: true }));
    const response = await withToolHandler(run, 'Failed', session, { tool: 'list_schemas' })({ context: 'x'.repeat(800) });

    expect(response.isError).toBeUndefined();
    expect(run).toHaveBeenCalledOnce();
    expect(readLines(file)[0]?.intent).toBe('x'.repeat(500));
  });

  it('leaves the arguments alone while MCP_TOOL_INTENT is off', async () => {
    const file = auditTo();
    const run = vi.fn(async (_args: Record<string, unknown>) => ({ success: true }));
    await withToolHandler(run, 'Failed', session, { tool: 'describe_table' })({ table: 'ORDERS', context: 'why' });

    expect(run.mock.calls[0]?.[0]).toEqual({ table: 'ORDERS', context: 'why' });
    expect(readLines(file)[0]?.intent).toBeUndefined();
  });

  it('keeps a tool’s own context parameter', async () => {
    const file = auditTo();
    process.env.MCP_TOOL_INTENT = 'true';
    const run = vi.fn(async (_args: Record<string, unknown>) => ({ success: true }));
    await withToolHandler(run, 'Failed', session, { tool: 'lookup', ownsContext: true })({ context: 'ORDERS' });

    expect(run.mock.calls[0]?.[0]).toEqual({ context: 'ORDERS' });
    expect(readLines(file)[0]?.intent).toBeUndefined();
  });

  it('records the client from request metadata and a hash of the session key', async () => {
    const file = auditTo();
    const ctx = { mcpReq: { envelope: { [CLIENT_INFO_META_KEY]: { name: 'example-client', version: '1.2.0' } } } };
    await withToolHandler(async () => ({ success: true }), 'Failed', session, { tool: 'list_schemas' })({}, ctx as never);
    await withToolHandler(async () => ({ success: true }), 'Failed', { ...session, userAgent: 'example-agent/2.0' }, {
      tool: 'list_schemas',
    })({});
    await withToolHandler(async () => ({ success: true }), 'Failed', undefined, { tool: 'list_schemas' })({});

    const lines = readLines(file);
    expect(lines[0]?.client).toEqual({ name: 'example-client', version: '1.2.0' });
    expect(lines[1]?.client).toEqual({ userAgent: 'example-agent/2.0' });
    expect(lines[2]?.client).toBeUndefined();
    expect(lines[0]?.session).toMatch(/^[0-9a-f]{12}$/);
    expect(lines[0]?.session).toBe(lines[1]?.session);
    expect(lines[2]?.session).toBeUndefined();
    expect(readFileSync(file, 'utf8')).not.toContain('secret-session-key');
  });

  it('records why a call failed', async () => {
    const file = auditTo();
    const fail = (result: Record<string, unknown>) =>
      withToolHandler(async () => ({ success: false, ...result }), 'Failed', undefined, { tool: 'execute_query' })({});

    await fail({ error: 'Schema allowlist rejected the query: x', errorKind: 'allowlist_parse', violations: ['x'] });
    await fail({ error: 'Column ORDERNOX not found', sqlstate: '42703', sqlcode: -206 });
    await fail({ error: 'Schema OUTSIDELIB is not in the allowed schemas (MYLIB).' });
    await fail({ error: 'Table ORDERS not found in MYLIB' });
    await fail({ error: 'something else' });
    await expect(withToolHandler(async () => {
      throw new Error('connection reset');
    }, 'Failed', undefined, { tool: 'execute_query' })({})).rejects.toThrow();
    await withToolHandler(async () => ({ success: true }), 'Failed', undefined, { tool: 'list_schemas' })({
      system: 'nosuchsystem',
    });
    process.env.RATE_LIMIT_MAX_REQUESTS = '0';
    resetRateLimiterInstance();
    await withToolHandler(async () => ({ success: true }), 'Failed', undefined, { tool: 'execute_query' })({});

    const lines = readLines(file);
    expect(lines.map((line) => line.errorKind)).toEqual([
      'allowlist_parse',
      'sql_error',
      'allowlist_denied',
      'not_found',
      'other',
      'exception',
      'unknown_system',
      'rate_limited',
    ]);
    expect(lines[0]?.violations).toEqual(['x']);
    expect(lines[1]).toMatchObject({ sqlstate: '42703', sqlcode: -206 });
    expect(lines.map((line) => line.rejectedBy)).toEqual([
      'allowlist', 'db2', 'allowlist', undefined, undefined, undefined, undefined, undefined,
    ]);
  });

  it('records which check refused a statement', async () => {
    const file = auditTo();
    const fail = (result: Record<string, unknown>) =>
      withToolHandler(async () => ({ success: false, ...result }), 'Failed', undefined, { tool: 'execute_query' })({});

    await fail({ error: 'Security validation failed: x', errorKind: 'security_validation' });
    await fail({ error: 'Schema allowlist rejected the query: x', errorKind: 'allowlist_denied' });
    await fail({ error: 'The statement could not be parsed.', errorKind: 'parse_check' });
    await fail({ error: 'The statement could not be parsed: SQL0104', errorKind: 'parse_check', sqlstate: '42000', sqlcode: -104 });
    await fail({ error: 'Column masking rejected the query: x', errorKind: 'masking' });
    await fail({ error: 'Bad parameter', errorKind: 'bad_params' });

    expect(readLines(file).map((line) => [line.errorKind, line.rejectedBy])).toEqual([
      ['security_validation', 'validator'],
      ['allowlist_denied', 'allowlist'],
      ['parse_check', 'parse_check'],
      ['parse_check', 'db2'],
      ['masking', 'masking'],
      ['bad_params', undefined],
    ]);
  });

  it("records validate_query's verdict and findings", async () => {
    const file = auditTo();
    const validate = (result: Record<string, unknown>) =>
      withToolHandler(async () => ({ success: true, ...result }), 'Failed', undefined, { tool: 'validate_query' })({});

    await validate({ valid: true, violations: [] });
    await validate({
      valid: false,
      violations: ['The statement could not be parsed: SQL0104'],
      sqlstate: '42000',
      sqlcode: -104,
    });
    await withToolHandler(async () => ({ success: true, data: [] }), 'Failed', undefined, { tool: 'list_schemas' })({});

    const lines = readLines(file);
    expect(lines[0]).toMatchObject({ outcome: 'success', valid: true });
    expect(lines[0]?.violations).toBeUndefined();
    expect(lines[1]).toMatchObject({
      outcome: 'success',
      valid: false,
      violations: ['The statement could not be parsed: SQL0104'],
      sqlstate: '42000',
      sqlcode: -104,
    });
    expect(lines[2]?.valid).toBeUndefined();
  });

  it('tells an unparseable query from a library outside the allowlist', async () => {
    const target = {
      poolKey: 'stdio',
      system: 'default',
      config: {} as DB2iConfig,
      allowedSchemas: ['MYLIB'],
    } as DbTarget;
    process.env.QUERY_PARSE_CHECK = 'false';

    const denied = await prepareReadQuery({ sql: 'SELECT ORDERNO FROM OUTSIDELIB.ORDERS', target });
    const unparseable = await prepareReadQuery({ sql: 'SELECT ORDERNO FROM MYLIB/ORDERS', target });
    const unsafe = await prepareReadQuery({ sql: 'DELETE FROM MYLIB.ORDERS', target });

    expect(denied).toMatchObject({ ok: false, errorKind: 'allowlist_denied' });
    expect(unparseable).toMatchObject({ ok: false, errorKind: 'allowlist_parse' });
    expect(unsafe).toMatchObject({ ok: false, errorKind: 'security_validation' });
  });

  it('records the intent and the tool’s own parameters for a YAML tool', async () => {
    const file = auditTo();
    process.env.MCP_TOOL_INTENT = 'true';
    process.env.MCP_AUDIT_PARAMS = 'true';
    process.env.QUERY_PARSE_CHECK = 'false';
    initAuditLog();

    const dir = tempDir();
    writeFileSync(path.join(dir, 'tools.yaml'), `
version: 1
tools:
  - name: search_sales_orders
    title: Search sales orders
    description: Open sales orders for a customer.
    parameters:
      customer: { type: string, required: true, description: Customer number }
    sql: SELECT ORDERNO FROM MYLIB.ORDERS WHERE CUSTNO = :customer
  - name: orders_by_context
    title: Orders by context
    description: Orders whose context code matches.
    parameters:
      context: { type: string, required: true, description: Context code }
    sql: SELECT ORDERNO FROM MYLIB.ORDERS WHERE CTXCODE = :context
`);
    setCustomTools(loadCustomTools([dir]));
    const server = createServer();
    await liveCustomTool(server, 'search_sales_orders')?.handler(
      { customer: '1001', context: 'Check open orders for a customer' } as never,
      {} as never,
    );
    await liveCustomTool(server, 'orders_by_context')?.handler({ context: 'A1' } as never, {} as never);

    const [first, second] = readLines(file);
    expect(first).toMatchObject({ tool: 'search_sales_orders', intent: 'Check open orders for a customer', params: ['1001'] });
    expect(second).toMatchObject({ tool: 'orders_by_context', params: ['A1'] });
    expect(second?.intent).toBeUndefined();
  });
});
