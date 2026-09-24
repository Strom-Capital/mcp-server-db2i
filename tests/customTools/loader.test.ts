import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { CustomToolsError, loadCustomTools, loadCustomToolsFromEnv, validateCustomToolFiles } from '../../src/customTools/loader.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
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
    toolset: sales
    description: Open sales orders for a customer.
    parameters:
      customer: { type: string, required: true, maxLength: 10, description: Customer number }
      status: { type: string, enum: [O, C], default: O }
    maxRows: 200
    sql: |
      SELECT H.ORDERNO FROM MYLIB.ORDERHDR H
      WHERE H.CUSTNO = :customer AND H.STATUS = :status
annotations:
  MYLIB.ORDERHDR:
    entity: sales_order
    description: Sales order header
    columns:
      STATUS: "O = open, C = closed"
    relations:
      - table: MYLIB.ORDERS
        join: { ORDERNO: ORDERNO }
        cardinality: one-to-many
        description: Order lines
`;

describe('loadCustomTools', () => {
  it('rewrites placeholders and keeps annotations', () => {
    const loaded = loadCustomTools([writeYaml(VALID)], { allowedSchemas: ['MYLIB'] });

    expect(loaded.tools).toHaveLength(1);
    expect(loaded.tools[0].sql).toContain('H.CUSTNO = ?');
    expect(loaded.tools[0].placeholderNames).toEqual(['customer', 'status']);
    expect(loaded.tools[0].toolset).toBe('sales');
    expect(loaded.annotations[0].table).toBe('MYLIB.ORDERHDR');
    expect(loaded.annotations[0].columns.STATUS).toContain('open');
    expect(loaded.annotations[0].relations[0].table).toBe('MYLIB.ORDERS');
  });

  it('rejects a statement that is not a query', () => {
    const file = writeYaml(VALID.replace(
      'SELECT H.ORDERNO FROM MYLIB.ORDERHDR H',
      'DELETE FROM MYLIB.ORDERHDR H'
    ));
    expect(() => loadCustomTools([file])).toThrow(CustomToolsError);
    expect(() => loadCustomTools([file])).toThrow(/Security validation failed/);
  });

  it('rejects a library outside the allowlist', () => {
    const file = writeYaml(VALID.replaceAll('MYLIB.ORDERHDR', 'OTHERLIB.ORDERHDR'));
    expect(() => loadCustomTools([file], { allowedSchemas: ['MYLIB'] }))
      .toThrow(/OTHERLIB\.ORDERHDR/);
  });

  it('rejects a built-in name, a duplicate, an unknown placeholder, and an unused parameter', () => {
    expect(() => loadCustomTools([writeYaml(VALID.replace('search_sales_orders', 'execute_query'))]))
      .toThrow(/already a built-in tool/);

    const dir = mkdtempSync(path.join(tmpdir(), 'db2i-tools-'));
    dirs.push(dir);
    writeFileSync(path.join(dir, 'a.yaml'), VALID);
    writeFileSync(path.join(dir, 'b.yaml'), VALID);
    expect(() => loadCustomTools([dir])).toThrow(/defined in both/);

    expect(() => loadCustomTools([writeYaml(VALID.replace(':status', ':missing'))]))
      .toThrow(/placeholder :missing/);

    const unused = VALID.replace(
      'status: { type: string, enum: [O, C], default: O }',
      'status: { type: string, enum: [O, C], default: O }\n      extra: { type: integer, required: false }'
    );
    expect(() => loadCustomTools([writeYaml(unused)])).toThrow(/parameter extra is not used/);
  });

  it('rejects a bad file shape and a missing path', () => {
    expect(() => loadCustomTools([writeYaml('version: 2\ntools: []\n')])).toThrow(CustomToolsError);
    expect(() => loadCustomTools([writeYaml(VALID.replace('search_sales_orders', 'SearchOrders'))]))
      .toThrow(/snake_case/);
    expect(() => loadCustomTools(['/tmp/db2i-tools-missing-path'])).toThrow(/not found/);
  });

  it('loads the example ERP pack', () => {
    const loaded = loadCustomTools(['examples/erp-tools'], {
      allowedSchemas: ['MYLIB'],
      defaultSchema: 'MYLIB',
    });

    const names = loaded.tools.map((tool) => tool.name);
    expect(names).toContain('search_sales_orders');
    expect(names).toContain('list_purchase_order_lines');
    expect(names).toContain('get_service_order');
    expect(names).toContain('list_manufacturing_order_lines');
    expect(names).toContain('explode_bill_of_materials');
    expect(names).toContain('get_gl_balance');
    expect(names).toContain('get_customer');
    expect(loaded.annotations.some((annotation) => annotation.table === 'MYLIB.ORDERHDR')).toBe(true);
    expect(loaded.annotations.some((annotation) => annotation.entity === 'gl_account')).toBe(true);
  });

  it('loads a masking-only file and rejects a duplicate rule', () => {
    const loaded = loadCustomTools([writeYaml(`
version: 1
masking:
  MYLIB.CUSTOMERS:
    EMAIL: redact
    PHONE: last4
`)]);
    expect(loaded.tools).toEqual([]);
    expect(loaded.masking.get('MYLIB.CUSTOMERS')?.get('EMAIL')).toBe('redact');
    expect(loaded.masking.get('MYLIB.CUSTOMERS')?.get('PHONE')).toBe('last4');

    const dir = mkdtempSync(path.join(tmpdir(), 'db2i-tools-'));
    dirs.push(dir);
    const rule = 'version: 1\nmasking:\n  MYLIB.CUSTOMERS:\n    EMAIL: redact\n';
    writeFileSync(path.join(dir, 'a.yaml'), rule);
    writeFileSync(path.join(dir, 'b.yaml'), rule);
    expect(() => loadCustomTools([dir])).toThrow(/Masking rule MYLIB\.CUSTOMERS\.EMAIL is defined in both/);
  });

  it('rejects a YAML tool that filters on a masked column, including a rule from another file', () => {
    const tool = `
version: 1
tools:
  - name: find_customer
    title: Find customer
    description: Customer by email.
    parameters:
      email: { type: string, required: true }
    sql: |
      SELECT CUSTNO FROM MYLIB.CUSTOMERS WHERE EMAIL = :email
`;
    const rules = `
version: 1
masking:
  MYLIB.CUSTOMERS:
    EMAIL: redact
`;
    expect(() => loadCustomTools([writeYaml(`${tool}masking:\n  MYLIB.CUSTOMERS:\n    EMAIL: redact\n`)]))
      .toThrow(/Masked column EMAIL must be a plain selected column/);

    const dir = mkdtempSync(path.join(tmpdir(), 'db2i-tools-'));
    dirs.push(dir);
    writeFileSync(path.join(dir, 'a.yaml'), tool);
    writeFileSync(path.join(dir, 'b.yaml'), rules);
    expect(() => loadCustomTools([dir])).toThrow(/Masked column EMAIL must be a plain selected column/);
  });

  it('reads MCP_CUSTOM_TOOLS', () => {
    const previousTools = process.env.MCP_CUSTOM_TOOLS;
    const previousSchemas = process.env.QUERY_ALLOWED_SCHEMAS;
    process.env.MCP_CUSTOM_TOOLS = writeYaml(VALID);
    process.env.QUERY_ALLOWED_SCHEMAS = 'MYLIB';
    try {
      const loaded = loadCustomToolsFromEnv();
      expect(loaded.tools.map((tool) => tool.name)).toEqual(['search_sales_orders']);
    } finally {
      if (previousTools === undefined) delete process.env.MCP_CUSTOM_TOOLS;
      else process.env.MCP_CUSTOM_TOOLS = previousTools;
      if (previousSchemas === undefined) delete process.env.QUERY_ALLOWED_SCHEMAS;
      else process.env.QUERY_ALLOWED_SCHEMAS = previousSchemas;
    }
  });
});

describe('validateCustomToolFiles', () => {
  it('reports every failing file in one run', () => {
    const deleted = VALID.replace(
      'SELECT H.ORDERNO FROM MYLIB.ORDERHDR H',
      'DELETE FROM MYLIB.ORDERHDR H'
    );
    const first = writeYaml(deleted, 'first.yaml');
    const second = writeYaml(VALID.replace('search_sales_orders', 'SearchOrders'), 'second.yaml');

    const validation = validateCustomToolFiles([first, second, '/tmp/db2i-tools-missing-path']);
    const errors = validation.results.map((result) => result.error ?? '');

    expect(errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/Security validation failed/),
      expect.stringMatching(/snake_case/),
      expect.stringMatching(/not found/),
    ]));
    expect(errors).toHaveLength(3);
    expect(validation.loaded.tools).toEqual([]);
  });

  it('reports a duplicate tool name across files', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'db2i-tools-'));
    dirs.push(dir);
    writeFileSync(path.join(dir, 'a.yaml'), VALID);
    writeFileSync(path.join(dir, 'b.yaml'), VALID);

    const validation = validateCustomToolFiles([dir]);
    const duplicate = validation.results.find((result) => result.error);

    expect(validation.results.filter((result) => !result.error)).toHaveLength(2);
    expect(duplicate?.error).toMatch(/defined in both/);
    expect(validation.loaded.tools).toEqual([]);
  });

  it('accepts the example ERP pack', () => {
    const validation = validateCustomToolFiles(['examples/erp-tools'], {
      allowedSchemas: ['MYLIB'],
      defaultSchema: 'MYLIB',
    });

    expect(validation.results.every((result) => result.error === undefined)).toBe(true);
    expect(validation.loaded.tools.length).toBeGreaterThan(0);
  });
});
