/**
 * list_routines and describe_routine: SQL procedures and functions in one
 * library, their parameters, and a statement that calls each one.
 */

import { applyQueryLimit } from '../config.js';
import { allowedSchemasFor, type DbTarget } from '../systems.js';
import {
  callTemplate,
  describeRoutine,
  listRoutines,
  type RoutineDetail,
  type RoutineRow,
} from '../db/routines.js';
import { schemaExists } from '../db/sqlServices.js';
import { sqlErrorFields, type SqlErrorDetails } from '../db/sqlErrorInfo.js';
import { isSchemaAllowed } from '../utils/security/schemaAllowlist.js';
import { requireSchema, schemaDenied } from './sqlServices.js';

export type ListRoutinesResult = SqlErrorDetails & {
  success: boolean;
  error?: string;
  schema?: string;
  data?: RoutineRow[];
  count?: number;
  truncated?: boolean;
};

export type DescribedRoutine = RoutineDetail & {
  call_template: string;
  callable_with_execute_query: boolean;
  /** Why the routine cannot be called with execute_query. */
  note?: string;
};

export type DescribeRoutineResult = SqlErrorDetails & {
  success: boolean;
  error?: string;
  schema?: string;
  data?: DescribedRoutine[];
  count?: number;
  truncated?: boolean;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error occurred';
}

/**
 * Whether execute_query can run the routine, and the template to use.
 * execute_query runs SELECT only. With a schema allowlist set, statements
 * are parsed, and the parser reads neither TABLE(...) nor named arguments,
 * so a scalar function gets positional markers.
 */
function describeCall(routine: RoutineDetail, allowlistSet: boolean): DescribedRoutine {
  const positional = allowlistSet && routine.type === 'SCALAR FUNCTION';
  const described: DescribedRoutine = {
    ...routine,
    call_template: callTemplate(routine, routine.parameters, { positional }),
    callable_with_execute_query: false,
  };
  if (routine.type === 'PROCEDURE') {
    described.note = 'Procedures are run with CALL, which execute_query does not accept.';
  } else if (routine.sql_data_access === 'MODIFIES SQL DATA') {
    described.note = 'The function modifies SQL data. execute_query is read-only and does not run it.';
  } else if (routine.type === 'TABLE FUNCTION' && allowlistSet) {
    described.note = 'TABLE(...) is not accepted by execute_query while QUERY_ALLOWED_SCHEMAS is set.';
  } else {
    described.callable_with_execute_query = true;
  }
  return described;
}

/**
 * List SQL procedures and functions in a library.
 * The library must be in QUERY_ALLOWED_SCHEMAS when that list is set.
 */
export async function listRoutinesTool(input: {
  schema?: string;
  filter?: string;
  type?: 'PROCEDURE' | 'FUNCTION';
  limit?: number;
  target?: DbTarget;
  defaultSchema?: string;
}): Promise<ListRoutinesResult> {
  try {
    const schema = requireSchema(input.schema, input.defaultSchema).trim().toUpperCase();
    const allowed = allowedSchemasFor(input.target);
    if (allowed && !isSchemaAllowed(schema, allowed)) {
      return { success: false, error: schemaDenied(schema, allowed) };
    }

    const result = await listRoutines({
      schema,
      filter: input.filter,
      type: input.type,
      limit: applyQueryLimit(input.limit),
      target: input.target,
    });
    if (result.rows.length === 0 && !(await schemaExists(schema, input.target))) {
      return { success: false, error: `Library ${schema} was not found.` };
    }

    return { success: true, schema, data: result.rows, count: result.rows.length, truncated: result.truncated };
  } catch (error) {
    return { success: false, error: messageOf(error), ...sqlErrorFields(error) };
  }
}

/**
 * Describe a procedure or function: parameters, return value or result
 * columns, and a statement that calls it. An overloaded name returns every
 * overload unless specificName picks one.
 */
export async function describeRoutineTool(input: {
  schema?: string;
  name?: string;
  specificName?: string;
  target?: DbTarget;
  defaultSchema?: string;
}): Promise<DescribeRoutineResult> {
  try {
    const schema = requireSchema(input.schema, input.defaultSchema).trim().toUpperCase();
    if (!input.name?.trim() && !input.specificName?.trim()) {
      return { success: false, error: 'Provide name, specific_name, or both.' };
    }
    const allowed = allowedSchemasFor(input.target);
    if (allowed && !isSchemaAllowed(schema, allowed)) {
      return { success: false, error: schemaDenied(schema, allowed) };
    }

    const result = await describeRoutine({
      schema,
      name: input.name,
      specificName: input.specificName,
      target: input.target,
    });
    if (result.rows.length === 0) {
      if (!(await schemaExists(schema, input.target))) {
        return { success: false, error: `Library ${schema} was not found.` };
      }
      const name = input.name?.trim().toUpperCase();
      const specific = input.specificName?.trim().toUpperCase();
      const wanted = name && specific ? `${name} with specific name ${specific}` : (name ?? `with specific name ${specific}`);
      return { success: false, error: `Routine ${wanted} was not found in library ${schema}.` };
    }

    const data = result.rows.map((routine) => describeCall(routine, allowed !== undefined));
    return { success: true, schema, data, count: data.length, truncated: result.truncated };
  } catch (error) {
    return { success: false, error: messageOf(error), ...sqlErrorFields(error) };
  }
}
