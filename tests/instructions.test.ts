import { describe, expect, it } from 'vitest';

import type { LoadedCustomTools, StoredTool } from '../src/customTools/loader.js';
import { buildServerInstructions, businessContextHint } from '../src/instructions.js';

const TOOL = { name: 'search_sales_orders' } as StoredTool;
const ANNOTATION = { table: 'MYLIB.ORDERHDR', columns: {}, relations: [] };

function loaded(overrides: Partial<LoadedCustomTools> = {}): LoadedCustomTools {
  return { tools: [], annotations: [], masking: new Map(), instructions: [], ...overrides };
}

describe('buildServerInstructions', () => {
  it('returns undefined when nothing is loaded', () => {
    expect(buildServerInstructions(loaded(), new Set(['get_business_context']))).toBeUndefined();
  });

  it('asks for the context argument when MCP_TOOL_INTENT is on', () => {
    process.env.MCP_TOOL_INTENT = 'true';
    try {
      expect(buildServerInstructions(loaded(), new Set())).toContain('optional context argument');
    } finally {
      delete process.env.MCP_TOOL_INTENT;
    }
  });

  it('mentions business tools only when one is registered', () => {
    const withTool = loaded({ tools: [TOOL] });

    expect(buildServerInstructions(withTool, new Set(['search_sales_orders']))).toContain('Business SQL tools');
    expect(buildServerInstructions(withTool, new Set(['execute_query']))).toBeUndefined();
  });

  it('puts the file texts after the built-in part, in order', () => {
    const text = buildServerInstructions(
      loaded({
        annotations: [ANNOTATION],
        instructions: [
          { text: 'First rule.', source: 'a.yaml', tools: [] },
          { text: 'Second rule.', source: 'b.yaml', tools: [] },
        ],
      }),
      new Set(['get_business_context']),
    ) ?? '';

    expect(text.indexOf('get_business_context')).toBeLessThan(text.indexOf('First rule.'));
    expect(text.indexOf('First rule.')).toBeLessThan(text.indexOf('Second rule.'));
  });

  it('sends a file text only when one of its tools is registered', () => {
    const withText = loaded({
      tools: [TOOL],
      instructions: [
        { text: 'Rule for everyone.', source: 'rules.yaml', tools: [] },
        { text: 'Use search_sales_orders.', source: 'sales.yaml', tools: ['search_sales_orders'] },
      ],
    });

    expect(buildServerInstructions(withText, new Set(['search_sales_orders']))).toContain('Use search_sales_orders.');
    const without = buildServerInstructions(withText, new Set(['execute_query'])) ?? '';
    expect(without).toContain('Rule for everyone.');
    expect(without).not.toContain('search_sales_orders');
  });

  it('names only the registered tools that read business context', () => {
    const annotated = loaded({ annotations: [ANNOTATION] });

    expect(buildServerInstructions(annotated, new Set(['get_business_context', 'describe_table'])))
      .toContain('with get_business_context or describe_table,');
    expect(buildServerInstructions(annotated, new Set(['get_business_context'])))
      .toContain('with get_business_context,');
    expect(buildServerInstructions(annotated, new Set(['describe_table'])))
      .toContain('with describe_table,');
    expect(buildServerInstructions(annotated, new Set(['execute_query']))).toBeUndefined();
  });
});

describe('businessContextHint', () => {
  const annotated = loaded({ annotations: [ANNOTATION] });

  it('names get_business_context when annotations are loaded and the tool is registered', () => {
    expect(businessContextHint(annotated, new Set(['get_business_context', 'describe_table'])))
      .toMatch(/^ .*call get_business_context/);
  });

  it('falls back to describe_table', () => {
    expect(businessContextHint(annotated, new Set(['describe_table']))).toContain('call describe_table');
  });

  it('is empty without annotations or without a context tool', () => {
    expect(businessContextHint(loaded(), new Set(['get_business_context']))).toBe('');
    expect(businessContextHint(annotated, new Set(['execute_query']))).toBe('');
  });
});
