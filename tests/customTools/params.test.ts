import { describe, expect, it } from 'vitest';

import { PlaceholderError, rewriteNamedPlaceholders } from '../../src/customTools/params.js';

describe('rewriteNamedPlaceholders', () => {
  it('replaces :name markers in bind order and keeps repeats', () => {
    const rewritten = rewriteNamedPlaceholders(
      'SELECT H.ORDERNO FROM MYLIB.ORDERHDR H WHERE H.CUSTNO = :customer AND H.STATUS = :status'
    );

    expect(rewritten.sql).toBe(
      'SELECT H.ORDERNO FROM MYLIB.ORDERHDR H WHERE H.CUSTNO = ? AND H.STATUS = ?'
    );
    expect(rewritten.names).toEqual(['customer', 'status']);
  });

  it('leaves placeholders inside strings, comments, and quoted identifiers', () => {
    const rewritten = rewriteNamedPlaceholders(`SELECT ':customer' AS NOTE, H.ORDERNO -- :skip
FROM MYLIB.ORDERHDR H
WHERE H.CUSTNO = :customer /* :also */
  AND H."COL:NAME" = :customer`);

    expect(rewritten.names).toEqual(['customer', 'customer']);
    expect(rewritten.sql).toContain("':customer'");
    expect(rewritten.sql).toContain('-- :skip');
    expect(rewritten.sql).toContain('/* :also */');
    expect(rewritten.sql).toContain('"COL:NAME"');
    expect(rewritten.sql).toContain('H.CUSTNO = ?');
  });

  it('rejects a question mark, a double colon, and an unclosed string', () => {
    expect(() => rewriteNamedPlaceholders('SELECT * FROM MYLIB.ORDERS WHERE ORDERNO = ?'))
      .toThrow(PlaceholderError);
    expect(() => rewriteNamedPlaceholders('SELECT CAST(:customer AS VARCHAR(10))::TEXT FROM MYLIB.ORDERS'))
      .toThrow(/Invalid placeholder/);
    expect(() => rewriteNamedPlaceholders("SELECT ':customer FROM MYLIB.ORDERS"))
      .toThrow(/Unclosed string/);
  });
});
