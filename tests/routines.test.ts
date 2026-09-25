/**
 * Tests for list_routines and describe_routine. Database calls are mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/connection.js', () => ({
  executeQuery: vi.fn(),
  executeProcedure: vi.fn(),
}));

import { executeQuery } from '../src/db/connection.js';
import { callTemplate, MAX_OVERLOADS, sqlIdentifier } from '../src/db/routines.js';
import { describeRoutineTool, listRoutinesTool } from '../src/tools/routines.js';

const query = vi.mocked(executeQuery);

function routineRow(row: Record<string, unknown> = {}) {
  return {
    SPECIFIC_SCHEMA: 'MYLIB',
    SPECIFIC_NAME: 'GET_ORDER',
    ROUTINE_SCHEMA: 'MYLIB',
    ROUTINE_NAME: 'GET_ORDER',
    ROUTINE_TYPE: 'PROCEDURE',
    FUNCTION_TYPE: ' ',
    ROUTINE_BODY: 'SQL',
    EXTERNAL_LANGUAGE: null,
    EXTERNAL_NAME: null,
    SQL_DATA_ACCESS: 'READS',
    MAX_DYNAMIC_RESULT_SETS: 1,
    IN_PARMS: 1,
    OUT_PARMS: 0,
    INOUT_PARMS: 0,
    ROUTINE_TEXT: 'Read one order',
    LONG_COMMENT: null,
    LAST_ALTERED: '2026-09-01 08:00:00.000000',
    ROUTINE_CREATED: '2026-01-01 08:00:00.000000',
    ...row,
  };
}

function parmRow(row: Record<string, unknown> = {}) {
  return {
    SPECIFIC_SCHEMA: 'MYLIB',
    SPECIFIC_NAME: 'GET_ORDER',
    ORDINAL_POSITION: 1,
    ROW_TYPE: 'P',
    PARAMETER_MODE: 'IN',
    PARAMETER_NAME: 'ORDERNO',
    DATA_TYPE: 'DECIMAL',
    DATA_TYPE_SCHEMA: null,
    DATA_TYPE_NAME: null,
    CHARACTER_MAXIMUM_LENGTH: null,
    NUMERIC_PRECISION: 7,
    NUMERIC_SCALE: 0,
    IS_NULLABLE: 'YES',
    LONG_COMMENT: null,
    DEFAULT_VALUE: null,
    ...row,
  };
}

describe('routines', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.QUERY_ALLOWED_SCHEMAS;
    delete process.env.QUERY_MAX_LIMIT;
    delete process.env.QUERY_DEFAULT_LIMIT;
  });

  describe('sqlIdentifier', () => {
    it('should leave ordinary names and quote the rest', () => {
      expect(sqlIdentifier('ORDERNO')).toBe('ORDERNO');
      expect(sqlIdentifier('#ORD_1')).toBe('#ORD_1');
      expect(sqlIdentifier('orderNo')).toBe('"orderNo"');
      expect(sqlIdentifier('ORDER NO')).toBe('"ORDER NO"');
      expect(sqlIdentifier('A"B')).toBe('"A""B"');
      expect(sqlIdentifier('1ST')).toBe('"1ST"');
    });
  });

  describe('callTemplate', () => {
    const params = [{ name: 'ORDERNO' }, { name: 'LINENO' }];

    it('should build a CALL with named arguments for a procedure', () => {
      expect(callTemplate({ schema: 'MYLIB', name: 'GET_ORDER', type: 'PROCEDURE' }, params))
        .toBe('CALL MYLIB.GET_ORDER(ORDERNO => ?, LINENO => ?)');
    });

    it('should select a scalar function from SYSDUMMY1', () => {
      expect(callTemplate({ schema: 'MYLIB', name: 'ORDER_TOTAL', type: 'SCALAR FUNCTION' }, params))
        .toBe('SELECT MYLIB.ORDER_TOTAL(ORDERNO => ?, LINENO => ?) FROM SYSIBM.SYSDUMMY1');
    });

    it('should select from TABLE(...) for a table function', () => {
      expect(callTemplate({ schema: 'MYLIB', name: 'OPEN_ORDERS', type: 'TABLE FUNCTION' }, [{ name: 'CUSTNO' }]))
        .toBe('SELECT * FROM TABLE(MYLIB.OPEN_ORDERS(CUSTNO => ?)) X');
    });

    it('should leave the argument list empty without parameters', () => {
      expect(callTemplate({ schema: 'MYLIB', name: 'REFRESH', type: 'PROCEDURE' }, [])).toBe('CALL MYLIB.REFRESH()');
      expect(callTemplate({ schema: 'MYLIB', name: 'ALL_ORDERS', type: 'TABLE FUNCTION' }, []))
        .toBe('SELECT * FROM TABLE(MYLIB.ALL_ORDERS()) X');
    });

    it('should use positional markers when a parameter has no name, or when asked', () => {
      expect(callTemplate({ schema: 'MYLIB', name: 'EXTPGM', type: 'PROCEDURE' }, [{ name: 'A' }, { name: null }]))
        .toBe('CALL MYLIB.EXTPGM(?, ?)');
      expect(callTemplate({ schema: 'MYLIB', name: 'ORDER_TOTAL', type: 'SCALAR FUNCTION' }, params, { positional: true }))
        .toBe('SELECT MYLIB.ORDER_TOTAL(?, ?) FROM SYSIBM.SYSDUMMY1');
    });

    it('should quote names that are not ordinary identifiers', () => {
      expect(callTemplate({ schema: 'MYLIB', name: 'getOrder', type: 'PROCEDURE' }, [{ name: 'order no' }]))
        .toBe('CALL MYLIB."getOrder"("order no" => ?)');
    });
  });

  describe('list_routines', () => {
    it('should list routines and normalize each row', async () => {
      query.mockResolvedValueOnce({
        rows: [
          routineRow(),
          routineRow({
            SPECIFIC_NAME: 'OPEN_ORDERS',
            ROUTINE_NAME: 'OPEN_ORDERS',
            ROUTINE_TYPE: 'FUNCTION',
            FUNCTION_TYPE: 'T',
            ROUTINE_BODY: 'EXTERNAL',
            EXTERNAL_LANGUAGE: 'RPGLE',
            EXTERNAL_NAME: 'MYLIB/ORDSRV(OPENORDERS)',
            SQL_DATA_ACCESS: 'NONE',
            MAX_DYNAMIC_RESULT_SETS: '0',
            IN_PARMS: '2',
            ROUTINE_TEXT: null,
            LONG_COMMENT: 'Open orders for a customer',
            LAST_ALTERED: null,
          }),
          routineRow({ SPECIFIC_NAME: 'ORDER_TOTAL', ROUTINE_NAME: 'ORDER_TOTAL', ROUTINE_TYPE: 'FUNCTION', FUNCTION_TYPE: 'S', SQL_DATA_ACCESS: 'MODIFIES' }),
        ],
      });

      const result = await listRoutinesTool({ schema: 'mylib' });

      expect(result.success).toBe(true);
      expect(result.schema).toBe('MYLIB');
      expect(result.count).toBe(3);
      expect(result.truncated).toBe(false);
      expect(result.data?.[0]).toEqual({
        schema: 'MYLIB',
        name: 'GET_ORDER',
        specific_name: 'GET_ORDER',
        type: 'PROCEDURE',
        language: 'SQL',
        external_name: null,
        sql_data_access: 'READS SQL DATA',
        result_sets: 1,
        parameter_count: 1,
        text: 'Read one order',
        last_altered: '2026-09-01 08:00:00.000000',
      });
      expect(result.data?.[1]).toMatchObject({
        type: 'TABLE FUNCTION',
        language: 'RPGLE',
        external_name: 'MYLIB/ORDSRV(OPENORDERS)',
        sql_data_access: 'NO SQL',
        result_sets: null,
        parameter_count: 2,
        text: 'Open orders for a customer',
        last_altered: '2026-01-01 08:00:00.000000',
      });
      expect(result.data?.[2]).toMatchObject({ type: 'SCALAR FUNCTION', sql_data_access: 'MODIFIES SQL DATA' });

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('FROM QSYS2.SYSROUTINES');
      expect(sql).not.toContain('ROUTINE_TYPE = ?');
      expect(params).toEqual(['MYLIB', '%']);
    });

    it('should pass the filter and type to the query', async () => {
      query.mockResolvedValueOnce({ rows: [routineRow()] });

      await listRoutinesTool({ schema: 'MYLIB', filter: 'GET*', type: 'PROCEDURE' });

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('ROUTINE_TYPE = ?');
      expect(params).toEqual(['MYLIB', 'GET%', 'PROCEDURE']);
    });

    it('should cap rows at the limit and report truncation', async () => {
      query.mockResolvedValueOnce({ rows: [routineRow(), routineRow({ SPECIFIC_NAME: 'B' }), routineRow({ SPECIFIC_NAME: 'C' })] });

      const result = await listRoutinesTool({ schema: 'MYLIB', limit: 2 });

      expect(query.mock.calls[0][0]).toContain('FETCH FIRST 3 ROWS ONLY');
      expect(result.count).toBe(2);
      expect(result.truncated).toBe(true);
    });

    it('should use the default schema', async () => {
      query.mockResolvedValueOnce({ rows: [routineRow()] });

      const result = await listRoutinesTool({ defaultSchema: 'mylib' });

      expect(result.schema).toBe('MYLIB');
    });

    it('should reject a library outside the allowlist before querying', async () => {
      process.env.QUERY_ALLOWED_SCHEMAS = 'MYLIB';

      const result = await listRoutinesTool({ schema: 'OUTSIDELIB' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('OUTSIDELIB is not in the allowed schemas');
      expect(query).not.toHaveBeenCalled();
    });

    it('should report a missing library', async () => {
      query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });

      const result = await listRoutinesTool({ schema: 'NOSUCHLIB' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Library NOSUCHLIB was not found.');
    });

    it('should return an empty list for a library without routines', async () => {
      query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ FOUND: 1 }] });

      const result = await listRoutinesTool({ schema: 'MYLIB' });

      expect(result).toMatchObject({ success: true, count: 0, data: [] });
    });

    it('should require a schema', async () => {
      const result = await listRoutinesTool({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Schema is required');
    });
  });

  describe('describe_routine', () => {
    it('should describe a procedure with its parameters and a CALL template', async () => {
      query
        .mockResolvedValueOnce({ rows: [routineRow({ IN_PARMS: 1, OUT_PARMS: 1 })] })
        .mockResolvedValueOnce({
          rows: [
            parmRow({ PARAMETER_MODE: 'IN', DEFAULT_VALUE: null }),
            parmRow({
              ORDINAL_POSITION: 2,
              PARAMETER_MODE: 'OUT',
              PARAMETER_NAME: 'STATUS',
              DATA_TYPE: 'CHARACTER',
              CHARACTER_MAXIMUM_LENGTH: 1,
              NUMERIC_PRECISION: null,
              NUMERIC_SCALE: null,
              IS_NULLABLE: 'NO',
              LONG_COMMENT: 'Order status',
              DEFAULT_VALUE: "'O'",
            }),
          ],
        });

      const result = await describeRoutineTool({ schema: 'mylib', name: 'get_order' });

      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
      const routine = result.data?.[0];
      expect(routine?.parameters).toEqual([
        { position: 1, name: 'ORDERNO', mode: 'IN', data_type: 'DECIMAL', length: null, precision: 7, scale: 0, nullable: true, text: null, default: null },
        { position: 2, name: 'STATUS', mode: 'OUT', data_type: 'CHARACTER', length: 1, precision: null, scale: null, nullable: false, text: 'Order status', default: "'O'" },
      ]);
      expect(routine?.call_template).toBe('CALL MYLIB.GET_ORDER(ORDERNO => ?, STATUS => ?)');
      expect(routine?.callable_with_execute_query).toBe(false);
      expect(routine?.note).toContain('CALL');
      expect(routine?.returns).toBeUndefined();
      expect(routine?.result_columns).toBeUndefined();

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ?');
      expect(params).toEqual(['MYLIB', 'GET_ORDER']);
      const [parmSql, parmParams] = query.mock.calls[1];
      expect(parmSql).toContain('FROM QSYS2.SYSPARMS');
      expect(parmSql).toContain('CAST("DEFAULT" AS VARCHAR(2000))');
      expect(parmParams).toEqual(['MYLIB', 'GET_ORDER']);
    });

    it('should return the value of a scalar function', async () => {
      query
        .mockResolvedValueOnce({ rows: [routineRow({ SPECIFIC_NAME: 'ORDER_TOTAL', ROUTINE_NAME: 'ORDER_TOTAL', ROUTINE_TYPE: 'FUNCTION', FUNCTION_TYPE: 'S' })] })
        .mockResolvedValueOnce({
          rows: [
            parmRow({ SPECIFIC_NAME: 'ORDER_TOTAL' }),
            parmRow({ SPECIFIC_NAME: 'ORDER_TOTAL', ORDINAL_POSITION: 2, ROW_TYPE: 'C', PARAMETER_MODE: 'OUT', PARAMETER_NAME: null, NUMERIC_PRECISION: 11, NUMERIC_SCALE: 2 }),
          ],
        });

      const result = await describeRoutineTool({ schema: 'MYLIB', name: 'ORDER_TOTAL' });

      const routine = result.data?.[0];
      expect(routine?.parameters).toHaveLength(1);
      expect(routine?.returns).toEqual({ position: 1, name: null, data_type: 'DECIMAL', length: null, precision: 11, scale: 2, nullable: true, text: null });
      expect(routine?.call_template).toBe('SELECT MYLIB.ORDER_TOTAL(ORDERNO => ?) FROM SYSIBM.SYSDUMMY1');
      expect(routine?.callable_with_execute_query).toBe(true);
      expect(routine?.note).toBeUndefined();
    });

    it('should use positional markers for a scalar function while the allowlist is set', async () => {
      process.env.QUERY_ALLOWED_SCHEMAS = 'MYLIB';
      query
        .mockResolvedValueOnce({ rows: [routineRow({ SPECIFIC_NAME: 'ORDER_TOTAL', ROUTINE_NAME: 'ORDER_TOTAL', ROUTINE_TYPE: 'FUNCTION', FUNCTION_TYPE: 'S' })] })
        .mockResolvedValueOnce({ rows: [parmRow({ SPECIFIC_NAME: 'ORDER_TOTAL' })] });

      const result = await describeRoutineTool({ schema: 'MYLIB', name: 'ORDER_TOTAL' });

      expect(result.data?.[0].call_template).toBe('SELECT MYLIB.ORDER_TOTAL(?) FROM SYSIBM.SYSDUMMY1');
      expect(result.data?.[0].callable_with_execute_query).toBe(true);
    });

    it('should return the result columns of a table function stored as C or R', async () => {
      query
        .mockResolvedValueOnce({
          rows: [
            routineRow({ SPECIFIC_NAME: 'OPEN_ORD1', ROUTINE_NAME: 'OPEN_ORDERS', ROUTINE_TYPE: 'FUNCTION', FUNCTION_TYPE: 'T' }),
            routineRow({ SPECIFIC_NAME: 'OPEN_ORD2', ROUTINE_NAME: 'OPEN_ORDERS', ROUTINE_TYPE: 'FUNCTION', FUNCTION_TYPE: 'T' }),
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            parmRow({ SPECIFIC_NAME: 'OPEN_ORD1', PARAMETER_NAME: 'CUSTNO' }),
            parmRow({ SPECIFIC_NAME: 'OPEN_ORD1', ORDINAL_POSITION: 2, ROW_TYPE: 'C', PARAMETER_MODE: 'OUT', PARAMETER_NAME: 'ORDERNO' }),
            parmRow({ SPECIFIC_NAME: 'OPEN_ORD2', ROW_TYPE: 'R', PARAMETER_MODE: 'OUT', PARAMETER_NAME: 'ORDERNO' }),
            parmRow({ SPECIFIC_NAME: 'OPEN_ORD2', ORDINAL_POSITION: 2, ROW_TYPE: 'R', PARAMETER_MODE: 'OUT', PARAMETER_NAME: 'LINENO' }),
          ],
        });

      const result = await describeRoutineTool({ schema: 'MYLIB', name: 'OPEN_ORDERS' });

      expect(result.count).toBe(2);
      const [first, second] = result.data ?? [];
      expect(first.call_template).toBe('SELECT * FROM TABLE(MYLIB.OPEN_ORDERS(CUSTNO => ?)) X');
      expect(first.result_columns?.map((column) => [column.position, column.name])).toEqual([[1, 'ORDERNO']]);
      expect(first.returns).toBeUndefined();
      expect(second.parameters).toEqual([]);
      expect(second.call_template).toBe('SELECT * FROM TABLE(MYLIB.OPEN_ORDERS()) X');
      expect(second.result_columns?.map((column) => [column.position, column.name])).toEqual([[1, 'ORDERNO'], [2, 'LINENO']]);
      expect(second.callable_with_execute_query).toBe(true);

      const [, parmParams] = query.mock.calls[1];
      expect(parmParams).toEqual(['MYLIB', 'OPEN_ORD1', 'MYLIB', 'OPEN_ORD2']);
    });

    it('should not offer a table function to execute_query while the allowlist is set', async () => {
      process.env.QUERY_ALLOWED_SCHEMAS = 'MYLIB';
      query
        .mockResolvedValueOnce({ rows: [routineRow({ ROUTINE_TYPE: 'FUNCTION', FUNCTION_TYPE: 'T' })] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await describeRoutineTool({ schema: 'MYLIB', name: 'GET_ORDER' });

      expect(result.data?.[0].callable_with_execute_query).toBe(false);
      expect(result.data?.[0].note).toContain('QUERY_ALLOWED_SCHEMAS');
    });

    it('should flag a function that modifies SQL data', async () => {
      query
        .mockResolvedValueOnce({ rows: [routineRow({ ROUTINE_TYPE: 'FUNCTION', FUNCTION_TYPE: 'S', SQL_DATA_ACCESS: 'MODIFIES' })] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await describeRoutineTool({ schema: 'MYLIB', name: 'GET_ORDER' });

      expect(result.data?.[0].sql_data_access).toBe('MODIFIES SQL DATA');
      expect(result.data?.[0].callable_with_execute_query).toBe(false);
      expect(result.data?.[0].note).toContain('modifies SQL data');
    });

    it('should name a distinct type by its schema', async () => {
      query
        .mockResolvedValueOnce({ rows: [routineRow()] })
        .mockResolvedValueOnce({ rows: [parmRow({ DATA_TYPE: 'DISTINCT', DATA_TYPE_SCHEMA: 'MYLIB', DATA_TYPE_NAME: 'ORDER_ID' })] });

      const result = await describeRoutineTool({ schema: 'MYLIB', name: 'GET_ORDER' });

      expect(result.data?.[0].parameters[0].data_type).toBe('MYLIB.ORDER_ID');
    });

    it('should pick one overload by specific name', async () => {
      query
        .mockResolvedValueOnce({ rows: [routineRow({ SPECIFIC_NAME: 'GET_ORDER2' })] })
        .mockResolvedValueOnce({ rows: [] });

      await describeRoutineTool({ schema: 'MYLIB', name: 'GET_ORDER', specificName: 'get_order2' });

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = ? AND ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ?');
      expect(params).toEqual(['MYLIB', 'GET_ORDER2', 'MYLIB', 'GET_ORDER']);
    });

    it('should cap overloads and report truncation', async () => {
      const rows = Array.from({ length: MAX_OVERLOADS + 1 }, (_, i) => routineRow({ SPECIFIC_NAME: `GET_ORDER${i}` }));
      query.mockResolvedValueOnce({ rows }).mockResolvedValueOnce({ rows: [] });

      const result = await describeRoutineTool({ schema: 'MYLIB', name: 'GET_ORDER' });

      expect(result.count).toBe(MAX_OVERLOADS);
      expect(result.truncated).toBe(true);
    });

    it('should require a name or specific name', async () => {
      const result = await describeRoutineTool({ schema: 'MYLIB' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Provide name, specific_name, or both.');
      expect(query).not.toHaveBeenCalled();
    });

    it('should reject a library outside the allowlist before querying', async () => {
      process.env.QUERY_ALLOWED_SCHEMAS = 'MYLIB';

      const result = await describeRoutineTool({ schema: 'OUTSIDELIB', name: 'GET_ORDER' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('OUTSIDELIB is not in the allowed schemas');
      expect(query).not.toHaveBeenCalled();
    });

    it('should report a missing routine and a missing library', async () => {
      query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ FOUND: 1 }] });
      expect((await describeRoutineTool({ schema: 'MYLIB', name: 'NOPE' })).error)
        .toBe('Routine NOPE was not found in library MYLIB.');

      query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ FOUND: 1 }] });
      expect((await describeRoutineTool({ schema: 'MYLIB', specificName: 'NOPE1' })).error)
        .toBe('Routine with specific name NOPE1 was not found in library MYLIB.');

      query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
      expect((await describeRoutineTool({ schema: 'NOSUCHLIB', name: 'NOPE' })).error)
        .toBe('Library NOSUCHLIB was not found.');
    });

    it('should return SQL error fields when Db2 rejects the query', async () => {
      query.mockRejectedValueOnce(Object.assign(new Error('[42501] Not authorized'), { sqlstate: '42501', sqlcode: -551 }));

      const result = await describeRoutineTool({ schema: 'MYLIB', name: 'GET_ORDER' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Not authorized');
    });
  });
});
