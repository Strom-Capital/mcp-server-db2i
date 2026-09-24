/**
 * File format for business SQL tools and table annotations.
 */

import { z } from 'zod';

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SQL_NAME = /^[A-Za-z_@#$][A-Za-z0-9_@#$]{0,127}$/;
const TABLE_REF = /^[A-Za-z_@#$][A-Za-z0-9_@#$]{0,127}\.[A-Za-z_@#$][A-Za-z0-9_@#$]{0,127}$/;
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;
const SYSTEM_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const parameterSchema = z.strictObject({
  type: z.enum(['string', 'integer', 'number', 'boolean', 'date', 'enum']),
  required: z.boolean().optional(),
  maxLength: z.number().int().positive().optional(),
  description: z.string().min(1).optional(),
  enum: z.array(z.string().min(1)).min(1).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
}).superRefine((param, ctx) => {
  const allowsEnum = param.type === 'string' || param.type === 'enum';
  if (param.type === 'enum' && !param.enum) {
    ctx.addIssue({
      code: 'custom',
      message: 'enum parameters need a list of values',
      path: ['enum'],
    });
  }
  if (param.enum && !allowsEnum) {
    ctx.addIssue({
      code: 'custom',
      message: 'enum is only valid for string and enum parameters',
      path: ['enum'],
    });
  }
  if (param.maxLength !== undefined && param.type !== 'string') {
    ctx.addIssue({
      code: 'custom',
      message: 'maxLength is only valid for string parameters',
      path: ['maxLength'],
    });
  }
  if (param.default === undefined) {
    return;
  }

  if (param.enum && (typeof param.default !== 'string' || !param.enum.includes(param.default))) {
    ctx.addIssue({
      code: 'custom',
      message: 'default must be one of the enum values',
      path: ['default'],
    });
  }

  if ((param.type === 'string' || param.type === 'enum') && typeof param.default !== 'string') {
    ctx.addIssue({
      code: 'custom',
      message: 'default must be a string',
      path: ['default'],
    });
  }
  if (param.type === 'integer' && (typeof param.default !== 'number' || !Number.isInteger(param.default))) {
    ctx.addIssue({
      code: 'custom',
      message: 'default must be an integer',
      path: ['default'],
    });
  }
  if (param.type === 'number' && typeof param.default !== 'number') {
    ctx.addIssue({
      code: 'custom',
      message: 'default must be a number',
      path: ['default'],
    });
  }
  if (param.type === 'boolean' && typeof param.default !== 'boolean') {
    ctx.addIssue({
      code: 'custom',
      message: 'default must be a boolean',
      path: ['default'],
    });
  }
  if (param.type === 'date' && (typeof param.default !== 'string' || !DATE_TEXT.test(param.default))) {
    ctx.addIssue({
      code: 'custom',
      message: 'default must be a date as YYYY-MM-DD',
      path: ['default'],
    });
  }
  if (
    param.type === 'string' &&
    typeof param.default === 'string' &&
    param.maxLength !== undefined &&
    param.default.length > param.maxLength
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'default is longer than maxLength',
      path: ['default'],
    });
  }
});

export type ParameterDef = z.infer<typeof parameterSchema>;

const relationSchema = z.strictObject({
  table: z.string().regex(TABLE_REF, 'Relation table must be SCHEMA.TABLE'),
  join: z.record(z.string().regex(SQL_NAME, 'Join column must be an unquoted SQL name'), z.string().regex(SQL_NAME, 'Join column must be an unquoted SQL name')),
  cardinality: z.enum(['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many']).optional(),
  description: z.string().min(1).optional(),
}).superRefine((relation, ctx) => {
  if (Object.keys(relation.join).length === 0) {
    ctx.addIssue({
      code: 'custom',
      message: 'join needs at least one column pair',
      path: ['join'],
    });
  }
});

export type RelationDef = z.infer<typeof relationSchema>;

const annotationSchema = z.strictObject({
  entity: z.string().regex(TOOL_NAME, 'Entity name must be snake_case').optional(),
  description: z.string().min(1).optional(),
  columns: z.record(
    z.string().regex(SQL_NAME, 'Column name must be an unquoted SQL name'),
    z.string().min(1),
  ).optional(),
  relations: z.array(relationSchema).optional(),
});

export type AnnotationDef = z.infer<typeof annotationSchema>;

const toolSchema = z.strictObject({
  name: z.string().regex(TOOL_NAME, 'Tool name must be snake_case'),
  title: z.string().min(1),
  toolset: z.string().regex(TOOL_NAME, 'Toolset must be snake_case').optional(),
  description: z.string().min(1),
  parameters: z.record(
    z.string().regex(PARAM_NAME, 'Parameter name must use letters, digits, and underscores'),
    parameterSchema,
  ).optional(),
  maxRows: z.number().int().positive().optional(),
  system: z.string().regex(SYSTEM_NAME, 'System must be a profile name from DB2I_PROFILES').optional(),
  sql: z.string().min(1),
});

export type ToolDef = z.infer<typeof toolSchema>;

const MASK_RULES = ['redact', 'last4'] as const;

export type MaskRule = (typeof MASK_RULES)[number];

const maskingSchema = z.record(
  z.string().regex(TABLE_REF, 'Masking key must be SCHEMA.TABLE'),
  z.record(
    z.string().regex(SQL_NAME, 'Column name must be an unquoted SQL name'),
    z.enum(MASK_RULES),
  ),
);

export const customToolsFileSchema = z.strictObject({
  version: z.literal(1),
  tools: z.array(toolSchema).optional(),
  annotations: z.record(
    z.string().regex(TABLE_REF, 'Annotation key must be SCHEMA.TABLE'),
    annotationSchema,
  ).optional(),
  masking: maskingSchema.optional(),
}).superRefine((file, ctx) => {
  const toolCount = file.tools?.length ?? 0;
  const annotationCount = file.annotations ? Object.keys(file.annotations).length : 0;
  const maskingCount = file.masking ? Object.keys(file.masking).length : 0;
  if (toolCount === 0 && annotationCount === 0 && maskingCount === 0) {
    ctx.addIssue({
      code: 'custom',
      message: 'Add at least one tool, annotation, or masking rule',
    });
  }
});

/**
 * A default makes the argument optional. Otherwise it is required unless required is false.
 * An omitted optional argument is bound as NULL.
 */
function parameterIsOptional(param: ParameterDef): boolean {
  if (param.default !== undefined) {
    return true;
  }
  return param.required === false;
}

const DATE_PARAM = z.string().regex(DATE_TEXT, 'Expected a date as YYYY-MM-DD');

/**
 * MCP input schema for one tool. Optional arguments accept null, which binds as NULL.
 */
export function inputSchemaFor(parameters: Record<string, ParameterDef>): z.ZodObject {
  const shape: Record<string, z.ZodType> = {};

  for (const [name, param] of Object.entries(parameters)) {
    let field: z.ZodType;
    if ((param.type === 'string' || param.type === 'enum') && param.enum && param.enum.length > 0) {
      field = z.enum(param.enum as [string, ...string[]]);
    } else if (param.type === 'string' || param.type === 'enum') {
      field = param.maxLength ? z.string().max(param.maxLength) : z.string();
    } else if (param.type === 'integer') {
      field = z.number().int();
    } else if (param.type === 'number') {
      field = z.number();
    } else if (param.type === 'boolean') {
      field = z.boolean();
    } else {
      field = DATE_PARAM;
    }

    if (param.description) {
      field = field.describe(param.description);
    }
    if (parameterIsOptional(param)) {
      field = field.nullish();
    }
    shape[name] = field;
  }

  return z.object(shape);
}

export function formatSchemaIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${path}${issue.message}`;
    })
    .join('; ');
}
