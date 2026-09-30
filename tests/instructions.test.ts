import { describe, expect, it } from 'vitest';

import type { LoadedCustomTools, StoredTool } from '../src/customTools/loader.js';
import { buildServerInstructions } from '../src/instructions.js';

const TOOL = { name: 'search_sales_orders' } as StoredTool;

function loaded(overrides: Partial<LoadedCustomTools> = {}): LoadedCustomTools {
  return { tools: [], annotations: [], masking: new Map(), instructions: [], ...overrides };
}

describe('buildServerInstructions', () => {
  it('returns undefined when nothing is loaded', () => {
    expect(buildServerInstructions(loaded(), new Set(['get_business_context']))).toBeUndefined();
  });

  it('mentions business tools only when one is enabled', () => {
    const withTool = loaded({ tools: [TOOL] });

    expect(buildServerInstructions(withTool, new Set(['search_sales_orders']))).toContain('Business SQL tools');
    expect(buildServerInstructions(withTool, new Set(['execute_query']))).toBeUndefined();
  });

  it('puts the file texts after the built-in part, in order', () => {
    const text = buildServerInstructions(
      loaded({
        annotations: [{ table: 'MYLIB.ORDERHDR', columns: {}, relations: [] }],
        instructions: [
          { text: 'First rule.', source: 'a.yaml' },
          { text: 'Second rule.', source: 'b.yaml' },
        ],
      }),
      new Set(['get_business_context']),
    ) ?? '';

    expect(text.indexOf('get_business_context')).toBeLessThan(text.indexOf('First rule.'));
    expect(text.indexOf('First rule.')).toBeLessThan(text.indexOf('Second rule.'));
  });
});
