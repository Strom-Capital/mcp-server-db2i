import { describe, expect, it } from 'vitest';
import { groupTools, summarizeTool, TOOL_META_KEY, type ListedTool } from '@/lib/catalog';
import { annotationMatches } from '@/lib/context';
import { buildArguments, formFields } from '@/lib/schema-form';

const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };

/** The shape mcp-server-db2i lists for a business tool with optional parameters. */
const listOrders: ListedTool = {
  name: 'list_sales_orders',
  title: 'List sales orders',
  description: 'Sales order headers from MYLIB.ORDERHDR.',
  inputSchema: {
    type: 'object',
    properties: {
      customer: { anyOf: [{ type: 'string', maxLength: 10, description: 'Customer number' }, { type: 'null' }] },
      from_date: { anyOf: [{ ...DATE, description: 'Orders dated on or after this day' }, { type: 'null' }] },
      status: { anyOf: [{ type: 'string', enum: ['open', 'invoiced'], description: 'Derived status' }, { type: 'null' }] },
      limit: { type: 'integer', exclusiveMinimum: 0 },
      rush: { type: 'boolean' },
      system: { type: 'string', enum: ['prod', 'test'] },
      context: { type: 'string' },
    },
    required: ['limit'],
  },
  annotations: { readOnlyHint: true },
  _meta: { [TOOL_META_KEY]: { kind: 'business', toolset: 'sales' } },
};

const executeQuery: ListedTool = {
  name: 'execute_query',
  title: 'Execute SQL Query',
  inputSchema: {
    type: 'object',
    properties: { sql: { type: 'string' }, params: { type: 'array', items: {} }, system: { type: 'string', enum: ['prod', 'test'] } },
    required: ['sql'],
  },
};

describe('summarizeTool and groupTools', () => {
  it('reads the business mark and toolset from tools/list', () => {
    expect(summarizeTool(listOrders)).toMatchObject({ kind: 'business', toolset: 'sales', readOnly: true });
    expect(summarizeTool(executeQuery)).toMatchObject({ kind: 'builtin' });
    expect(summarizeTool(executeQuery)).not.toHaveProperty('toolset');
  });

  it('lists every tool as built-in when the server sends no _meta', () => {
    expect(summarizeTool({ ...listOrders, _meta: undefined }).kind).toBe('builtin');
  });

  it('groups business tools by toolset before the built-in tools', () => {
    const service = summarizeTool({ ...listOrders, name: 'list_service_orders', _meta: { [TOOL_META_KEY]: { kind: 'business', toolset: 'service' } } });
    const loose = summarizeTool({ ...listOrders, name: 'count_orders', _meta: { [TOOL_META_KEY]: { kind: 'business' } } });
    const groups = groupTools([summarizeTool(executeQuery), service, loose, summarizeTool(listOrders)]);

    expect(groups.map((group) => [group.label, group.tools.map((tool) => tool.name)])).toEqual([
      ['Sales', ['list_sales_orders']],
      ['Service', ['list_service_orders']],
      ['Business tools', ['count_orders']],
      ['Built-in tools', ['execute_query']],
    ]);
  });
});

describe('formFields', () => {
  it('turns nullable, date, enum, integer and boolean parameters into inputs, and hides context', () => {
    const fields = formFields(summarizeTool(listOrders).inputSchema);

    expect(fields.map((field) => [field.name, field.kind, field.required])).toEqual([
      ['customer', 'text', false],
      ['from_date', 'date', false],
      ['status', 'enum', false],
      ['limit', 'integer', true],
      ['rush', 'boolean', false],
      ['system', 'enum', false],
    ]);
    expect(fields[0]).toMatchObject({ maxLength: 10, description: 'Customer number' });
    expect(fields[2]?.options).toEqual(['open', 'invoiced']);
  });

  it('shows array parameters as JSON', () => {
    expect(formFields(summarizeTool(executeQuery).inputSchema).map((field) => field.kind)).toEqual(['text', 'json', 'enum']);
  });
});

describe('buildArguments', () => {
  const fields = formFields(summarizeTool(listOrders).inputSchema);

  it('leaves empty optional fields out and converts numbers', () => {
    expect(buildArguments(fields, { customer: ' 1001 ', limit: '25', status: '', rush: '' })).toEqual({
      args: { customer: '1001', limit: 25 },
      errors: {},
    });
  });

  it('reports missing, malformed and too long values', () => {
    const { errors } = buildArguments(fields, { customer: 'X'.repeat(11), from_date: '15.10.2026', limit: '2.5' });

    expect(errors).toEqual({
      customer: 'At most 10 characters',
      from_date: 'Enter a date as YYYY-MM-DD',
      limit: 'Enter a whole number',
    });
    expect(buildArguments(fields, {}).errors).toEqual({ limit: 'Required' });
  });

  it('parses JSON fields', () => {
    const queryFields = formFields(summarizeTool(executeQuery).inputSchema);

    expect(buildArguments(queryFields, { sql: 'SELECT 1 FROM SYSIBM.SYSDUMMY1', params: '["A", 1]' }).args).toEqual({
      sql: 'SELECT 1 FROM SYSIBM.SYSDUMMY1',
      params: ['A', 1],
    });
    expect(buildArguments(queryFields, { sql: 'x', params: '[A' }).errors.params).toMatch(/JSON/);
  });
});

describe('annotationMatches', () => {
  it('finds a table by a column note or a related table', () => {
    const annotation = {
      table: 'MYLIB.ORDERHDR',
      entity: 'sales_order',
      columns: { ORDERNO: 'Order number' },
      relations: [{ table: 'MYLIB.CUSTOMERS', join: { CUSTNO: 'CUSTNO' } }],
    };

    expect(annotationMatches(annotation, 'order number')).toBe(true);
    expect(annotationMatches(annotation, 'customers')).toBe(true);
    expect(annotationMatches(annotation, 'invoice')).toBe(false);
  });
});
