/**
 * Export download links: GET and HEAD /exports/:id on the HTTP app.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';

vi.mock('../../src/db/connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/connection.js')>()),
  openQueryCursor: vi.fn(),
}));

import { openQueryCursor } from '../../src/db/connection.js';
import { createHttpApp } from '../../src/transports/http.js';
import { closeExportStore, initExportStore } from '../../src/export/store.js';
import { exportQueryTool } from '../../src/tools/exportQuery.js';
import { closeAuditLog, initAuditLog } from '../../src/utils/auditLog.js';

const openCursor = vi.mocked(openQueryCursor);

async function listen(app: Express): Promise<{ server: http.Server; baseUrl: string; port: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}`, port: String(port) };
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function requestWithHost(port: string, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET', headers: { Host: host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

const originalEnv = process.env;
let dir: string;
let server: http.Server;
let baseUrl: string;
let port: string;

beforeEach(async () => {
  vi.clearAllMocks();
  dir = await mkdtemp(join(tmpdir(), 'db2i-download-'));
  process.env = {
    ...originalEnv,
    MCP_AUTH_MODE: 'none',
    MCP_SESSION_MODE: 'stateless',
    DB2I_HOSTNAME: 'ibmi.example.com',
    DB2I_DRIVER: 'jt400',
    DB2I_USERNAME: 'TESTUSER',
    DB2I_PASSWORD: 'secret',
    QUERY_PARSE_CHECK: 'false',
    EXPORT_ENABLED: 'true',
    EXPORT_DIR: join(dir, 'exports'),
    MCP_AUDIT_LOG: join(dir, 'audit.log'),
  };
  delete process.env.EXPORT_MAX_DOWNLOADS;
  delete process.env.MCP_CORS_ORIGINS;
  initAuditLog();
  await initExportStore();
  ({ server, baseUrl, port } = await listen(createHttpApp()));
  process.env.MCP_PUBLIC_URL = baseUrl;
});

afterEach(async () => {
  await closeServer(server);
  await closeExportStore();
  closeAuditLog();
  vi.restoreAllMocks();
  process.env = originalEnv;
  await rm(dir, { recursive: true, force: true });
});

async function makeExport(format: 'csv' | 'xlsx' = 'csv'): Promise<{ url: string; path: string }> {
  openCursor.mockResolvedValueOnce({
    columns: [
      { name: 'ORDERNO', kind: 'int', dbType: 'INTEGER' },
      { name: 'NOTE', kind: 'string', dbType: 'VARCHAR' },
    ],
    next: vi.fn().mockResolvedValueOnce([[1001, 'Rush']]).mockResolvedValueOnce(null),
    close: vi.fn(async () => undefined),
  });
  const result = await exportQueryTool({
    sql: 'SELECT ORDERNO, NOTE FROM MYLIB.ORDERS',
    format,
    filename: 'open-orders',
    delivery: 'link',
    owner: 'TESTUSER',
  });
  expect(result.success).toBe(true);
  const files = await readdir(join(dir, 'exports'));
  return { url: result.url!, path: join(dir, 'exports', files[0]) };
}

async function auditLines(): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(dir, 'audit.log'), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('export download link', () => {
  it('allows EXPORT_MAX_DOWNLOADS downloads with attachment headers, then answers 404 and deletes the file', async () => {
    const { url, path } = await makeExport();
    const expected = await readFile(path);

    const first = await fetch(url);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(first.headers.get('content-disposition')).toBe('attachment; filename="open-orders.csv"');
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(first.headers.get('referrer-policy')).toBe('no-referrer');
    expect(first.headers.get('content-security-policy')).toMatch(/sandbox/);
    // Compare bytes: text() would drop the byte order mark
    expect(Buffer.from(await first.arrayBuffer()).equals(expected)).toBe(true);

    // The default allows three downloads, so a link preview or the agent's own check does not spend the user's
    expect((await fetch(url)).status).toBe(200);
    expect(await readdir(join(dir, 'exports'))).toHaveLength(1);
    expect((await fetch(url)).status).toBe(200);
    const fourth = await fetch(url);
    expect(fourth.status).toBe(404);
    expect(await fourth.text()).toMatch(/expired or has been used as many times as allowed/);

    await vi.waitFor(async () => expect(await readdir(join(dir, 'exports'))).toEqual([]));
    const events = (await auditLines()).filter((line) => line.event === 'export_download');
    expect(events.map((line) => line.outcome)).toEqual(['success', 'success', 'success', 'not_found']);
    expect(events[0]).toMatchObject({ identity: 'TESTUSER', bytes: expected.length, rowCount: 1 });
    expect(String(events[0].exportId)).toHaveLength(8);
    expect(JSON.stringify(events)).not.toContain(url.split('/').pop());
  });

  it('answers HEAD without using up the link', async () => {
    const { url } = await makeExport('xlsx');

    const head = await fetch(url, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    expect(Number(head.headers.get('content-length'))).toBeGreaterThan(0);

    const get = await fetch(url);
    expect(get.status).toBe(200);
    expect(Buffer.from(await get.arrayBuffer()).subarray(0, 2).toString()).toBe('PK');
  });

  it('answers 404 for a malformed or unknown id', async () => {
    expect((await fetch(`${baseUrl}/exports/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/exports/${'A'.repeat(43)}`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/exports/${'A'.repeat(43)}`, { method: 'HEAD' })).status).toBe(404);
  });

  it('answers 404 once the link has expired', async () => {
    const { url } = await makeExport();
    const later = Date.now() + 16 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);

    expect((await fetch(url)).status).toBe(404);
  });

  it('makes a link single use with EXPORT_MAX_DOWNLOADS=1', async () => {
    await closeExportStore();
    process.env.EXPORT_MAX_DOWNLOADS = '1';
    await initExportStore();
    const { url } = await makeExport();

    expect((await fetch(url, { method: 'HEAD' })).status).toBe(200);
    expect((await fetch(url)).status).toBe(200);
    expect((await fetch(url)).status).toBe(404);
  });

  it('rejects a request whose Host is not allowed', async () => {
    const { url } = await makeExport();
    const path = new URL(url).pathname;

    expect(await requestWithHost(port, path, 'evil.example.com')).toBe(403);
    // The link still works for the real host
    expect((await fetch(url)).status).toBe(200);
  });

  it('limits downloads per address', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) {
      statuses.push((await fetch(`${baseUrl}/exports/${'B'.repeat(43)}`, { method: 'HEAD' })).status);
    }
    expect(statuses.slice(0, 30).every((status) => status === 404)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});

describe('export download route', () => {
  it('is not served when exports are off', async () => {
    await closeServer(server);
    delete process.env.EXPORT_ENABLED;
    ({ server, baseUrl, port } = await listen(createHttpApp()));

    const res = await fetch(`${baseUrl}/exports/${'A'.repeat(43)}`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toMatch(/as many times as allowed/);
  });
});
