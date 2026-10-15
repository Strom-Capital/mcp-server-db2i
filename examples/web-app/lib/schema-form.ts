import type { JsonSchema } from './catalog';

export type FieldKind = 'text' | 'integer' | 'number' | 'boolean' | 'date' | 'enum' | 'json';

/** One input on a tool form, read from the tool's JSON Schema. */
export interface FormField {
  name: string;
  kind: FieldKind;
  required: boolean;
  description?: string;
  options?: string[];
  maxLength?: number;
  pattern?: string;
  /** Initial text in the input. */
  initial: string;
}

/** Arguments the form never shows: `context` only feeds the server's audit log. */
const HIDDEN = new Set(['context']);
const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

/** The schema without its `null` branch: optional business tool parameters are `anyOf: [T, null]`. */
function unwrapNullable(schema: JsonSchema): JsonSchema {
  const branches = schema.anyOf?.filter((branch) => branch.type !== 'null');
  if (branches?.length === 1 && branches[0]) {
    return { ...branches[0], description: branches[0].description ?? schema.description };
  }
  return schema;
}

function kindOf(schema: JsonSchema): FieldKind {
  const type = Array.isArray(schema.type) ? schema.type.find((each) => each !== 'null') : schema.type;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return 'enum';
  }
  if (type === 'string') {
    return schema.format === 'date' || schema.pattern === DATE_PATTERN ? 'date' : 'text';
  }
  if (type === 'integer' || type === 'number' || type === 'boolean') {
    return type;
  }
  return 'json';
}

function initialText(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/**
 * Inputs for a tool's arguments, in schema order.
 *
 * @param schema - The tool's input schema
 * @returns One field per argument the user fills in
 */
export function formFields(schema: JsonSchema): FormField[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {})
    .filter(([name]) => !HIDDEN.has(name))
    .map(([name, raw]) => {
      const field = unwrapNullable(raw);
      const kind = kindOf(field);
      return {
        name,
        kind,
        required: required.has(name),
        ...(field.description ? { description: field.description } : {}),
        ...(kind === 'enum' ? { options: (field.enum ?? []).map(String) } : {}),
        ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
        ...(field.pattern && kind !== 'date' ? { pattern: field.pattern } : {}),
        initial: kind === 'boolean' ? (field.default === true ? 'true' : '') : initialText(field.default),
      };
    });
}

/**
 * Tool arguments from the form's text values. Empty optional fields are left
 * out, so the server applies its own defaults.
 *
 * @param fields - The form fields
 * @param values - Text per field name; booleans are `true` or empty
 * @returns The arguments, or an error per field that does not parse
 */
export function buildArguments(
  fields: FormField[],
  values: Record<string, string>,
): { args: Record<string, unknown>; errors: Record<string, string> } {
  const args: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const text = (values[field.name] ?? '').trim();
    if (field.kind === 'boolean') {
      if (text === 'true' || field.required) {
        args[field.name] = text === 'true';
      }
      continue;
    }
    if (text === '') {
      if (field.required) {
        errors[field.name] = 'Required';
      }
      continue;
    }
    switch (field.kind) {
      case 'integer':
      case 'number': {
        const value = Number(text);
        if (!Number.isFinite(value) || (field.kind === 'integer' && !Number.isInteger(value))) {
          errors[field.name] = field.kind === 'integer' ? 'Enter a whole number' : 'Enter a number';
        } else {
          args[field.name] = value;
        }
        break;
      }
      case 'date':
        if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
          errors[field.name] = 'Enter a date as YYYY-MM-DD';
        } else {
          args[field.name] = text;
        }
        break;
      case 'json':
        try {
          args[field.name] = JSON.parse(text) as unknown;
        } catch {
          errors[field.name] = 'Enter JSON, for example ["A", 1]';
        }
        break;
      default:
        if (field.maxLength !== undefined && text.length > field.maxLength) {
          errors[field.name] = `At most ${field.maxLength} characters`;
        } else {
          args[field.name] = text;
        }
    }
  }
  return { args, errors };
}
