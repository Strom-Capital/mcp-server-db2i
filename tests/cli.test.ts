import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const parseStatement = vi.hoisted(() => vi.fn());

vi.mock('../src/db/sqlServices.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db/sqlServices.js')>('../src/db/sqlServices.js');
  return {
    ...actual,
    parseStatement: (...args: unknown[]) => parseStatement(...args),
  };
});

vi.mock('../src/db/connection.js', () => ({
  initializePool: vi.fn(),
  closeGlobalPool: vi.fn(async () => {}),
  executeQuery: vi.fn(),
  executeProcedure: vi.fn(),
}));

import { closeGlobalPool } from '../src/db/connection.js';
import { parseCliArgs, runValidateTools } from '../src/cli.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
  parseStatement.mockReset();
  vi.mocked(closeGlobalPool).mockClear();
});

function writeYaml(contents: string, fileName = 'tools.yaml'): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'db2i-tools-'));
  dirs.push(dir);
  const file = path.join(dir, fileName);
  writeFileSync(file, contents);
  return file;
}

const VALID = `
version: 1
tools:
  - name: search_sales_orders
    title: Search sales orders
    description: Open sales orders for a customer.
    parameters:
      customer: { type: string, required: true, maxLength: 10, description: Customer number }
    sql: SELECT ORDERNO FROM MYLIB.ORDERHDR WHERE CUSTNO = :customer
`;

function capture(): { stream: Writable; text: () => string } {
  let buf = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      buf += String(chunk);
      callback();
    },
  });
  return { stream, text: () => buf };
}

describe('parseCliArgs', () => {
  it('starts the server when there are no arguments', () => {
    expect(parseCliArgs([])).toEqual({ kind: 'serve' });
  });

  it('rejects a missing path, an unknown flag, and a mistyped command', () => {
    expect(parseCliArgs(['validate-tools']).kind).toBe('usage');
    expect(parseCliArgs(['validate-tools', '--bogus']).kind).toBe('usage');
    expect(parseCliArgs(['validate-tool', 'tools.yaml']).kind).toBe('usage');
  });

  it('accepts --connect before or after the paths', () => {
    expect(parseCliArgs(['validate-tools', '--connect', 'a.yaml', 'b.yaml'])).toEqual({
      kind: 'validate-tools',
      paths: ['a.yaml', 'b.yaml'],
      connect: true,
    });
    expect(parseCliArgs(['validate-tools', 'a.yaml', '--connect'])).toEqual({
      kind: 'validate-tools',
      paths: ['a.yaml'],
      connect: true,
    });
  });
});

describe('runValidateTools', () => {
  it('passes valid files without a database hostname', async () => {
    const previousHost = process.env.DB2I_HOSTNAME;
    const previousSchemas = process.env.QUERY_ALLOWED_SCHEMAS;
    delete process.env.DB2I_HOSTNAME;
    delete process.env.QUERY_ALLOWED_SCHEMAS;
    const stdout = capture();
    const stderr = capture();
    try {
      const code = await runValidateTools({
        paths: [writeYaml(VALID)],
        connect: false,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });
      expect(code).toBe(0);
      expect(stdout.text()).toMatch(/ok {2}.*\(1 tools, 0 annotations\)/);
      expect(stdout.text()).toMatch(/1 files checked, all passed/);
      expect(stderr.text()).toBe('');
      expect(parseStatement).not.toHaveBeenCalled();
    } finally {
      if (previousHost === undefined) delete process.env.DB2I_HOSTNAME;
      else process.env.DB2I_HOSTNAME = previousHost;
      if (previousSchemas === undefined) delete process.env.QUERY_ALLOWED_SCHEMAS;
      else process.env.QUERY_ALLOWED_SCHEMAS = previousSchemas;
    }
  });

  it('reports one bad file and still checks the others', async () => {
    const good = writeYaml(VALID, 'good.yaml');
    const bad = writeYaml(
      VALID.replace('SELECT ORDERNO FROM MYLIB.ORDERHDR', 'DELETE FROM MYLIB.ORDERHDR'),
      'bad.yaml'
    );
    const stdout = capture();
    const stderr = capture();

    const code = await runValidateTools({
      paths: [good, bad],
      connect: false,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(1);
    expect(stdout.text()).toMatch(/ok {2}/);
    expect(stderr.text()).toMatch(/FAIL .*Security validation failed/);
    expect(stdout.text()).toMatch(/2 files checked, 1 failed/);
  });

  it('applies QUERY_ALLOWED_SCHEMAS only when it is set', async () => {
    const previous = process.env.QUERY_ALLOWED_SCHEMAS;
    const file = writeYaml(VALID);
    const stdout = capture();
    const stderr = capture();
    try {
      delete process.env.QUERY_ALLOWED_SCHEMAS;
      expect(await runValidateTools({
        paths: [file],
        connect: false,
        stdout: stdout.stream,
        stderr: stderr.stream,
      })).toBe(0);

      process.env.QUERY_ALLOWED_SCHEMAS = 'OTHERLIB';
      const deniedOut = capture();
      const deniedErr = capture();
      expect(await runValidateTools({
        paths: [file],
        connect: false,
        stdout: deniedOut.stream,
        stderr: deniedErr.stream,
      })).toBe(1);
      expect(deniedErr.text()).toMatch(/Schema allowlist/);
    } finally {
      if (previous === undefined) delete process.env.QUERY_ALLOWED_SCHEMAS;
      else process.env.QUERY_ALLOWED_SCHEMAS = previous;
    }
  });

  it('parses each statement when --connect is set', async () => {
    const previous = {
      host: process.env.DB2I_HOSTNAME,
      user: process.env.DB2I_USERNAME,
      password: process.env.DB2I_PASSWORD,
    };
    process.env.DB2I_HOSTNAME = 'ibmi.example.com';
    process.env.DB2I_USERNAME = 'user';
    process.env.DB2I_PASSWORD = 'secret';
    parseStatement.mockResolvedValue([
      { nameType: 'TABLE', schema: 'MYLIB', name: 'ORDERHDR', columnName: null, statementType: 'QUERY' },
    ]);
    const stdout = capture();
    const stderr = capture();
    try {
      const code = await runValidateTools({
        paths: [writeYaml(VALID)],
        connect: true,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });
      expect(code).toBe(0);
      expect(parseStatement).toHaveBeenCalledTimes(1);
      expect(closeGlobalPool).toHaveBeenCalled();
      expect(stdout.text()).toMatch(/all passed/);
    } finally {
      restoreDbEnv(previous);
    }
  });

  it('fails --connect when the statement is not a query', async () => {
    const previous = {
      host: process.env.DB2I_HOSTNAME,
      user: process.env.DB2I_USERNAME,
      password: process.env.DB2I_PASSWORD,
    };
    process.env.DB2I_HOSTNAME = 'ibmi.example.com';
    process.env.DB2I_USERNAME = 'user';
    process.env.DB2I_PASSWORD = 'secret';
    parseStatement.mockResolvedValue([
      { nameType: '', schema: null, name: null, columnName: null, statementType: 'DELETE' },
    ]);
    const stdout = capture();
    const stderr = capture();
    try {
      const code = await runValidateTools({
        paths: [writeYaml(VALID)],
        connect: true,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });
      expect(code).toBe(1);
      expect(stderr.text()).toMatch(/tool search_sales_orders: PARSE_STATEMENT rejected the statement \(type: DELETE\)/);
      expect(stdout.text()).toMatch(/PARSE_STATEMENT check failed/);
      expect(closeGlobalPool).toHaveBeenCalled();
    } finally {
      restoreDbEnv(previous);
    }
  });

  it('names the host when PARSE_STATEMENT is missing', async () => {
    const previous = {
      host: process.env.DB2I_HOSTNAME,
      user: process.env.DB2I_USERNAME,
      password: process.env.DB2I_PASSWORD,
    };
    process.env.DB2I_HOSTNAME = 'ibmi.example.com';
    process.env.DB2I_USERNAME = 'user';
    process.env.DB2I_PASSWORD = 'secret';
    parseStatement.mockRejectedValue(new Error('PARSE_STATEMENT in QSYS2 type *N not found. SQL0204'));
    const stdout = capture();
    const stderr = capture();
    try {
      const code = await runValidateTools({
        paths: [writeYaml(VALID)],
        connect: true,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });
      expect(code).toBe(1);
      expect(stderr.text()).toMatch(
        /QSYS2\.PARSE_STATEMENT is not available on ibmi\.example\.com\. It requires IBM i 7\.3/
      );
      expect(closeGlobalPool).toHaveBeenCalled();
    } finally {
      restoreDbEnv(previous);
    }
  });
});

function restoreDbEnv(previous: { host?: string; user?: string; password?: string }): void {
  if (previous.host === undefined) delete process.env.DB2I_HOSTNAME;
  else process.env.DB2I_HOSTNAME = previous.host;
  if (previous.user === undefined) delete process.env.DB2I_USERNAME;
  else process.env.DB2I_USERNAME = previous.user;
  if (previous.password === undefined) delete process.env.DB2I_PASSWORD;
  else process.env.DB2I_PASSWORD = previous.password;
}
