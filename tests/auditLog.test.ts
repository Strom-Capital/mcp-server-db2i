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
import { closeAuditLog, initAuditLog, writeAudit } from '../src/utils/auditLog.js';
import { logger } from '../src/utils/logger.js';
import { resetRateLimiterInstance } from '../src/utils/rateLimiter.js';
import type { DB2iConfig } from '../src/config.js';

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
      config: { username: 'MYUSER' } as DB2iConfig,
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
    expect(lines[0]?.rowCount).toBe(2);
    expect(lines[0]?.durationMs).toEqual(expect.any(Number));
    expect(lines[1]?.identity).toBe('stdio');
    expect(lines[1]?.error).toBe('not a query');
    expect(lines[2]?.durationMs).toBeUndefined();
    expect(lines[2]?.rowCount).toBeUndefined();
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
    await tool?.handler({ customer: '1001' }, {} as never);

    const [line] = readLines(file);
    expect(line?.tool).toBe('search_sales_orders');
    expect(line?.sql).toBe('SELECT ORDERNO FROM MYLIB.ORDERS WHERE CUSTNO = ?');
    expect(line?.params).toEqual(['1001']);
    expect(line?.outcome).toBe('success');
    expect(line?.rowCount).toBe(1);
  });
});
