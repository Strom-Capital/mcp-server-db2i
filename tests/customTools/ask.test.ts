import { describe, expect, it } from 'vitest';

import { askForm, missingAskParameters, pickAnswers } from '../../src/customTools/ask.js';
import { customToolsFileSchema, inputSchemaFor, type ParameterDef } from '../../src/customTools/schema.js';

const PARAMETERS: Record<string, ParameterDef> = {
  customer: { type: 'string', required: true, maxLength: 10, description: 'Customer number' },
  status: { type: 'string', enum: ['O', 'C'], default: 'O', ask: true },
  since: { type: 'date', required: false, ask: true },
  limit: { type: 'integer', ask: true },
  open_only: { type: 'boolean', default: true, ask: true },
} as Record<string, ParameterDef>;

function toolFile(parameters: Record<string, unknown>) {
  return {
    version: 1,
    tools: [{
      name: 'search_sales_orders',
      title: 'Search sales orders',
      description: 'Open sales orders for a customer.',
      parameters,
      sql: 'SELECT H.ORDERNO FROM MYLIB.ORDERHDR H WHERE H.CUSTNO = :customer',
    }],
  };
}

describe('missingAskParameters', () => {
  it('lists ask parameters left out or null, in YAML order', () => {
    expect(missingAskParameters(PARAMETERS, { customer: 'C1', since: null, limit: 5 }))
      .toEqual(['status', 'since', 'open_only']);
  });

  it('ignores parameters without ask', () => {
    expect(missingAskParameters(PARAMETERS, { status: 'O', since: '2026-01-01', limit: 5, open_only: false })).toEqual([]);
  });
});

describe('askForm', () => {
  it('builds one typed field per parameter and fills defaults', () => {
    const form = askForm(PARAMETERS, ['customer', 'status', 'since', 'limit', 'open_only']);

    expect(form.properties).toEqual({
      customer: { type: 'string', title: 'customer', description: 'Customer number', maxLength: 10 },
      status: { type: 'string', enum: ['O', 'C'], title: 'status', default: 'O' },
      since: { type: 'string', format: 'date', title: 'since' },
      limit: { type: 'integer', title: 'limit' },
      open_only: { type: 'boolean', title: 'open_only', default: true },
    });
    expect(form.required).toEqual(['customer', 'limit']);
  });

  it('leaves required out when every field is optional', () => {
    expect(askForm(PARAMETERS, ['since'])).not.toHaveProperty('required');
  });
});

describe('pickAnswers', () => {
  it('keeps only asked names with primitive values', () => {
    expect(pickAnswers({ status: 'C', limit: 3, open_only: false, customer: 'C9', since: ['2026-01-01'] }, ['status', 'limit', 'open_only', 'since']))
      .toEqual({ status: 'C', limit: 3, open_only: false });
  });
});

describe('ask in the YAML schema', () => {
  it('accepts ask on an ordinary parameter', () => {
    expect(customToolsFileSchema.safeParse(toolFile({ customer: { type: 'string', ask: true } })).success).toBe(true);
  });

  it('refuses ask on a parameter that looks like a credential', () => {
    for (const name of ['password', 'user_pwd', 'api_key', 'apikey', 'token', 'client_secret']) {
      const parsed = customToolsFileSchema.safeParse(toolFile({ customer: { type: 'string' }, [name]: { type: 'string', ask: true } }));
      expect(parsed.success, name).toBe(false);
      expect(JSON.stringify(parsed.error?.issues), name).toContain('looks like a credential');
    }
  });

  it('advertises ask parameters as optional only when asking is on', () => {
    const params = { limit: { type: 'integer', ask: true } } as Record<string, ParameterDef>;
    expect(inputSchemaFor(params).safeParse({}).success).toBe(false);
    expect(inputSchemaFor(params, { askOptional: true }).safeParse({}).success).toBe(true);
    expect(inputSchemaFor(params, { askOptional: true }).safeParse({ limit: 'many' }).success).toBe(false);
  });
});
