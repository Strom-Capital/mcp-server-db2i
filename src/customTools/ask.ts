/**
 * The elicitation form for a business tool's `ask: true` parameters.
 */

import type { ElicitRequestFormParams } from '@modelcontextprotocol/server';

import { parameterIsOptional, type ParameterDef } from './schema.js';

type FormSchema = ElicitRequestFormParams['requestedSchema'];
type FormProperty = FormSchema['properties'][string];

/** `ask` parameters the model left out, in the order the YAML lists them. */
export function missingAskParameters(
  parameters: Record<string, ParameterDef>,
  args: Record<string, unknown>,
): string[] {
  return Object.entries(parameters)
    .filter(([name, param]) => param.ask && (args[name] === undefined || args[name] === null))
    .map(([name]) => name);
}

function formProperty(name: string, param: ParameterDef): FormProperty {
  const common = { title: name, ...(param.description ? { description: param.description } : {}) };
  if (param.enum && param.enum.length > 0) {
    return {
      type: 'string',
      enum: param.enum,
      ...common,
      ...(typeof param.default === 'string' ? { default: param.default } : {}),
    };
  }
  switch (param.type) {
    case 'integer':
    case 'number':
      return { type: param.type, ...common, ...(typeof param.default === 'number' ? { default: param.default } : {}) };
    case 'boolean':
      return { type: 'boolean', ...common, ...(typeof param.default === 'boolean' ? { default: param.default } : {}) };
    case 'date':
      return { type: 'string', format: 'date', ...common, ...(typeof param.default === 'string' ? { default: param.default } : {}) };
    default:
      return {
        type: 'string',
        ...common,
        ...(param.maxLength !== undefined ? { maxLength: param.maxLength } : {}),
        ...(typeof param.default === 'string' ? { default: param.default } : {}),
      };
  }
}

/**
 * A flat form with one field per missing parameter. A field is required when
 * the parameter is required and has no default; the default fills the field.
 */
export function askForm(parameters: Record<string, ParameterDef>, names: readonly string[]): FormSchema {
  const properties: FormSchema['properties'] = {};
  const required: string[] = [];
  for (const name of names) {
    const param = parameters[name];
    properties[name] = formProperty(name, param);
    if (!parameterIsOptional(param)) {
      required.push(name);
    }
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}

/** Only the asked names, and only values a form can carry. */
export function pickAnswers(content: Record<string, unknown>, names: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const name of names) {
    const value = content[name];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      picked[name] = value;
    }
  }
  return picked;
}
