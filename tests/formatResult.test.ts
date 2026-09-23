/**
 * Tests for tool result text formatting
 */

import { describe, it, expect } from 'vitest';
import { formatToolText, toMarkdownTable } from '../src/utils/formatResult.js';

const queryResult = {
  success: true,
  data: [
    { ID: 1, NAME: 'Alice' },
    { ID: 2, NAME: 'Bob' },
  ],
  rowCount: 2,
  limitApplied: 1000,
};

describe('formatToolText', () => {
  it('should render compact JSON for json format', () => {
    const text = formatToolText(queryResult, 'json');
    expect(text).not.toContain('\n');
    expect(JSON.parse(text)).toEqual(queryResult);
  });

  it('should render indented JSON for pretty format', () => {
    const text = formatToolText(queryResult, 'pretty');
    expect(text).toBe(JSON.stringify(queryResult, null, 2));
  });

  it('should render a summary line and markdown table for markdown format', () => {
    expect(formatToolText(queryResult, 'markdown')).toBe(
      [
        'rowCount: 2, limitApplied: 1000',
        '',
        '| ID | NAME |',
        '| --- | --- |',
        '| 1 | Alice |',
        '| 2 | Bob |',
      ].join('\n')
    );
  });

  it('should omit the summary line when there is no metadata', () => {
    expect(formatToolText({ success: true, data: [{ A: 1 }] }, 'markdown')).toBe(
      '| A |\n| --- |\n| 1 |'
    );
  });

  it('should report empty results in markdown format', () => {
    expect(formatToolText({ success: true, data: [], count: 0 }, 'markdown')).toBe(
      'count: 0\n\n_No rows returned._'
    );
  });

  it('should fall back to compact JSON for non-tabular results in markdown format', () => {
    const error = { error: 'Rate limit exceeded', waitTimeSeconds: 60 };
    expect(formatToolText(error, 'markdown')).toBe(JSON.stringify(error));

    const scalarData = { success: true, data: [1, 2, 3] };
    expect(formatToolText(scalarData, 'markdown')).toBe(JSON.stringify(scalarData));
  });
});

describe('toMarkdownTable', () => {
  it('should render null and undefined as NULL', () => {
    expect(toMarkdownTable([{ A: null, B: undefined }])).toBe('| A | B |\n| --- | --- |\n| NULL | NULL |');
  });

  it('should escape pipes, backslashes, and newlines', () => {
    const table = toMarkdownTable([{ TEXT: 'a|b\\c\nd\r\ne' }]);
    expect(table.split('\n')[2]).toBe('| a\\|b\\\\c<br>d<br>e |');
  });

  it('should use the union of keys across rows', () => {
    expect(toMarkdownTable([{ A: 1 }, { B: 2 }])).toBe(
      '| A | B |\n| --- | --- |\n| 1 | NULL |\n| NULL | 2 |'
    );
  });

  it('should serialize nested values as JSON', () => {
    expect(toMarkdownTable([{ META: { k: 'v' } }]).split('\n')[2]).toBe('| {"k":"v"} |');
  });
});
