import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { filterAnnotations, getBusinessContextTool } from '../../src/customTools/context.js';
import type { StoredAnnotation } from '../../src/customTools/loader.js';
import { resetCustomTools, setCustomTools } from '../../src/customTools/registry.js';

function annotation(table: string, entity?: string): StoredAnnotation {
  return { table, ...(entity ? { entity } : {}), columns: {}, relations: [] };
}

const ANNOTATIONS: StoredAnnotation[] = [
  annotation('MYLIB.ORDERHDR', 'sales_order'),
  annotation('MYLIB.ORDERS', 'sales_order_line'),
  annotation('MYLIB.CUSTOMERS', 'customer'),
  annotation('OTHERLIB.JOBS', 'repair_job'),
  annotation('OTHERLIB.NOTES'),
];

function load(annotations: StoredAnnotation[]): void {
  setCustomTools({ tools: [], instructions: [], masking: new Map(), annotations });
}

function entitiesOf(data: StoredAnnotation[] | undefined): Array<string | undefined> {
  return (data ?? []).map((item) => item.entity);
}

describe('get_business_context entity and table matching', () => {
  beforeEach(() => load(ANNOTATIONS));
  afterEach(() => resetCustomTools());

  it('returns every annotation without filters', () => {
    const result = getBusinessContextTool({});
    expect(result.count).toBe(ANNOTATIONS.length);
    expect(result.hint).toBeUndefined();
  });

  it('returns only the exact entity when the name exists', () => {
    const result = getBusinessContextTool({ entity: 'sales_order' });
    expect(entitiesOf(result.data)).toEqual(['sales_order']);
    expect(result.partial_match).toBeUndefined();
    expect(result.hint).toBeUndefined();
    expect(result.available_entities).toBeUndefined();
  });

  it('treats case, spaces and hyphens as the same entity name', () => {
    expect(entitiesOf(getBusinessContextTool({ entity: 'Sales Order' }).data)).toEqual(['sales_order']);
    expect(entitiesOf(getBusinessContextTool({ entity: 'sales-order-line' }).data)).toEqual(['sales_order_line']);
    expect(entitiesOf(filterAnnotations({ entity: 'CUSTOMER' }))).toEqual(['customer']);
  });

  it('falls back to entity names that contain the request', () => {
    const result = getBusinessContextTool({ entity: 'order' });
    expect(entitiesOf(result.data)).toEqual(['sales_order', 'sales_order_line']);
    expect(result.count).toBe(2);
    expect(result.partial_match).toBe(true);
    expect(result.hint).toBe('No entity is named "order". These entities partly match it.');
  });

  it('falls back to entity names contained in the request', () => {
    const result = getBusinessContextTool({ entity: 'customer_master' });
    expect(entitiesOf(result.data)).toEqual(['customer']);
    expect(result.partial_match).toBe(true);
  });

  it('falls back to the names that share the most word parts', () => {
    const lines = getBusinessContextTool({ entity: 'purchase_order_line' });
    expect(entitiesOf(lines.data)).toEqual(['sales_order_line']);
    expect(lines.partial_match).toBe(true);

    const jobs = getBusinessContextTool({ entity: 'repair_agreement' });
    expect(entitiesOf(jobs.data)).toEqual(['repair_job']);
  });

  it('does not match a very short request inside longer names', () => {
    const result = getBusinessContextTool({ entity: 'or' });
    expect(result.data).toEqual([]);
    expect(result.partial_match).toBeUndefined();
  });

  it('lists the loaded entities when no entity matches', () => {
    const result = getBusinessContextTool({ entity: 'warehouse_transfer' });
    expect(result).toEqual({
      success: true,
      data: [],
      count: 0,
      available_entities: ['customer', 'repair_job', 'sales_order', 'sales_order_line'],
      hint: 'Nothing matches entity "warehouse_transfer". Call again with a name from available_entities, or omit entity and table to list every annotation.',
    });
  });

  it('keeps the table filter exact and lists tables when it matches nothing', () => {
    expect(getBusinessContextTool({ table: 'orders' }).data?.map((item) => item.table)).toEqual(['MYLIB.ORDERS']);

    const result = getBusinessContextTool({ table: 'INVOICES' });
    expect(result.data).toEqual([]);
    expect(result.available_entities).toEqual(['customer', 'repair_job', 'sales_order', 'sales_order_line']);
    expect(result.available_tables).toEqual([
      'MYLIB.CUSTOMERS', 'MYLIB.ORDERHDR', 'MYLIB.ORDERS', 'OTHERLIB.JOBS', 'OTHERLIB.NOTES',
    ]);
    expect(result.hint).toBe('Nothing matches table "INVOICES". Call again with a name from available_entities or available_tables, or omit entity and table to list every annotation.');
  });

  it('applies a partial entity match within the table filter', () => {
    const result = getBusinessContextTool({ entity: 'order', table: 'MYLIB.ORDERS' });
    expect(entitiesOf(result.data)).toEqual(['sales_order_line']);
    expect(result.partial_match).toBe(true);

    const none = getBusinessContextTool({ entity: 'customer', table: 'ORDERS' });
    expect(none.data).toEqual([]);
    expect(none.hint).toContain('Nothing matches entity "customer" and table "ORDERS".');
  });

  it('says so when no annotations are loaded', () => {
    load([]);
    expect(getBusinessContextTool({ entity: 'sales_order' })).toEqual({
      success: true,
      data: [],
      count: 0,
      hint: 'No business annotations are loaded on this server.',
    });
  });
});
