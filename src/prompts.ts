/**
 * MCP prompts for exploring a library, explaining a table, and writing a query.
 *
 * A prompt is registered only when the tools it tells the model to call are
 * enabled. Every prompt is read-only in what it asks for.
 */

import {
  completable,
  ProtocolError,
  ProtocolErrorCode,
  type GetPromptResult,
  type McpServer,
} from '@modelcontextprotocol/server';
import { z } from 'zod';

import { annotationFor } from './customTools/context.js';
import {
  assertSchemaAllowed,
  callerOf,
  completeSchemas,
  completeTables,
  guarded,
  type Caller,
} from './resources.js';
import type { SessionContext } from './server.js';
import { describeTableTool } from './tools/metadata.js';

const READ_ONLY_RULE = 'Only read. Do not write, change, or delete data, and do not run INSERT, UPDATE, DELETE, or DDL.';

function userPrompt(description: string, text: string): GetPromptResult {
  return {
    description,
    messages: [{ role: 'user', content: { type: 'text', text } }],
  };
}

function qualified(schema: string, table: string): string {
  return `${schema}.${table}`;
}

function normalize(name: string): string {
  return name.trim().toUpperCase();
}

type Column = {
  column_name: string;
  data_type: string;
  length: number | null;
  numeric_scale: number | null;
  is_nullable: string;
  column_text: string | null;
  business_description?: string;
};

function columnLine(column: Column): string {
  const size =
    column.length == null
      ? ''
      : column.numeric_scale != null && column.numeric_scale > 0
        ? `(${column.length},${column.numeric_scale})`
        : `(${column.length})`;
  const nullable = column.is_nullable === 'Y' ? ', nullable' : '';
  const notes = [column.column_text, column.business_description].filter(Boolean).join('. ');
  return `- ${column.column_name} ${column.data_type}${size}${nullable}${notes ? `: ${notes}` : ''}`;
}

async function writeQueryPrompt(
  args: { question: string; schema: string; table: string },
  caller: Caller,
  enabledTools: ReadonlySet<string>,
): Promise<GetPromptResult> {
  const schema = normalize(args.schema);
  const table = normalize(args.table);
  assertSchemaAllowed(schema);

  const described = await guarded(
    caller,
    'prompt:write_query',
    { schema, table },
    async () => {
      const result = await describeTableTool({ schema, table, sessionId: caller.sessionId });
      if (!result.success) {
        throw new ProtocolError(ProtocolErrorCode.InternalError, result.error);
      }
      if (result.count === 0) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Table ${qualified(schema, table)} was not found.`);
      }
      return result;
    },
    (value) => value.count,
  );

  const name = qualified(schema, table);
  const annotation = annotationFor(schema, table);
  const sections = [
    `Write one read-only SQL SELECT for Db2 for i that answers this question:\n\n${args.question.trim()}`,
    `Use the table ${name}. Qualify it as ${name}, and use only the column names listed here. They come from the catalog.`,
    described.data.map(columnLine).join('\n'),
  ];

  if (annotation?.description) {
    sections.push(`What the table holds: ${annotation.description}`);
  }
  if (annotation && annotation.relations.length > 0) {
    const relations = annotation.relations.map((relation) => {
      const join = Object.entries(relation.join)
        .map(([from, to]) => `${name}.${from} = ${relation.table}.${to}`)
        .join(' AND ');
      const extra = [relation.cardinality, relation.description].filter(Boolean).join(', ');
      return `- ${relation.table} on ${join}${extra ? ` (${extra})` : ''}`;
    });
    sections.push(`Known relations. Join other tables only through these, or through keys you confirm first:\n${relations.join('\n')}`);
  }

  const steps: string[] = [];
  if (enabledTools.has('validate_query')) {
    steps.push('Check the statement with validate_query and fix what it reports.');
  }
  if (enabledTools.has('execute_query')) {
    steps.push('Run it with execute_query and answer the question from the rows.');
  } else {
    steps.push('Return the SQL. Do not run it.');
  }
  sections.push(steps.join(' '));
  sections.push(READ_ONLY_RULE);

  return userPrompt(`Write a query against ${name}`, sections.join('\n\n'));
}

export function registerPrompts(
  server: McpServer,
  enabledTools: ReadonlySet<string>,
  sessionContext?: SessionContext,
): void {
  const caller = callerOf(sessionContext);
  const has = (tool: string): boolean => enabledTools.has(tool);

  const schemaArg = () =>
    completable(z.string().describe('Schema (library) name'), (value) => completeSchemas(value, caller));
  const tableArg = () =>
    completable(z.string().describe('Table name'), (value, context) =>
      completeTables(context?.arguments?.schema, value, caller),
    );

  if (has('list_tables') && has('describe_table')) {
    server.registerPrompt(
      'explore_library',
      {
        title: 'Explore a library',
        description: 'List the tables in a library, describe the central ones, and summarize how they fit together.',
        argsSchema: z.object({ schema: schemaArg() }),
      },
      ({ schema: input }) => {
        const schema = normalize(input);
        assertSchemaAllowed(schema);
        const steps = [
          `1. Call list_tables with schema "${schema}".`,
          '2. Pick the tables that look central: master data, order or document headers, and the lines that refer to them. Go by table names and table text.',
          '3. Call describe_table for each of those tables.',
        ];
        if (has('get_business_context')) {
          steps.push(`4. Call get_business_context and use the descriptions and relations it returns for tables in ${schema}.`);
        }
        if (has('get_table_constraints')) {
          steps.push(`${steps.length + 1}. Call get_table_constraints on the central tables to find their keys.`);
        }
        const text = [
          `Explore the IBM i library ${schema}.`,
          steps.join('\n'),
          'Then summarize what the library holds, what one row of each central table represents, and how those tables join.',
          READ_ONLY_RULE,
        ].join('\n\n');
        return userPrompt(`Explore ${schema}`, text);
      },
    );
  }

  if (has('describe_table')) {
    server.registerPrompt(
      'explain_table',
      {
        title: 'Explain a table',
        description: 'Explain a table in plain language: what a row is, what the columns mean, its keys, and its relations.',
        argsSchema: z.object({ schema: schemaArg(), table: tableArg() }),
      },
      ({ schema: schemaInput, table: tableInput }) => {
        const schema = normalize(schemaInput);
        const table = normalize(tableInput);
        assertSchemaAllowed(schema);
        const name = qualified(schema, table);
        const calls = [`Call describe_table with schema "${schema}" and table "${table}".`];
        if (has('get_table_constraints')) {
          calls.push('Call get_table_constraints for its primary, unique, and foreign keys.');
        }
        if (has('list_indexes')) {
          calls.push('Call list_indexes to see which columns it is usually looked up by.');
        }
        if (has('get_business_context')) {
          calls.push(`Call get_business_context with table "${name}" for business descriptions and relations the catalog does not declare.`);
        }
        const text = [
          `Explain the IBM i table ${name} in plain language.`,
          calls.join('\n'),
          'Then explain what one row represents, what each column means, which columns form the keys, and which other tables it relates to and on which columns.',
          READ_ONLY_RULE,
        ].join('\n\n');
        return userPrompt(`Explain ${name}`, text);
      },
    );

    server.registerPrompt(
      'write_query',
      {
        title: 'Write a query',
        description: 'Write a read-only SELECT that answers a question, grounded in the real columns of a table and its YAML annotations.',
        argsSchema: z.object({
          question: z.string().describe('What the query should answer'),
          schema: schemaArg(),
          table: tableArg(),
        }),
      },
      (args) => writeQueryPrompt(args, caller, enabledTools),
    );
  }
}
