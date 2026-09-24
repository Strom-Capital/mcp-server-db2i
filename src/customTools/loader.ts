/**
 * Load business SQL tools and annotations from YAML files.
 *
 * Statements are checked with the same read-only rules and schema allowlist
 * as execute_query. A failing file stops startup.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { parseDocument } from 'yaml';

import { TOOL_NAMES } from '../config.js';
import { getSystems } from '../systems.js';
import { checkQuerySchemas } from '../utils/security/schemaAllowlist.js';
import { validateQuery } from '../utils/security/sqlSecurityValidator.js';
import { PlaceholderError, rewriteNamedPlaceholders } from './params.js';
import { checkMaskedColumns, columnsForTables, maskedTablesInSql, type MaskingMap } from './masking.js';
import {
  customToolsFileSchema,
  formatSchemaIssues,
  type AnnotationDef,
  type MaskRule,
  type ParameterDef,
  type RelationDef,
  type ToolDef,
} from './schema.js';

export class CustomToolsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomToolsError';
  }
}

export interface StoredRelation {
  table: string;
  join: Record<string, string>;
  cardinality?: RelationDef['cardinality'];
  description?: string;
}

export interface StoredAnnotation {
  table: string;
  entity?: string;
  description?: string;
  columns: Record<string, string>;
  relations: StoredRelation[];
}

export interface StoredTool {
  name: string;
  title: string;
  toolset?: string;
  description: string;
  parameters: Record<string, ParameterDef>;
  maxRows?: number;
  /** System the tool always runs on. Unset means the caller's choice, or the default system. */
  system?: string;
  /** SQL with :name placeholders already rewritten to ? markers. */
  sql: string;
  /** Placeholder names in bind order. */
  placeholderNames: string[];
  source: string;
  /** Plainly selected masked columns. Empty when this statement does not return one. */
  maskedColumns: Record<string, MaskRule>;
}

export interface LoadedCustomTools {
  tools: StoredTool[];
  annotations: StoredAnnotation[];
  masking: MaskingMap;
}

export interface FileValidationResult {
  /** Display path of the file, or the input path when that input could not be read. Empty for a cross-file failure. */
  path: string;
  error?: string;
  tools: number;
  annotations: number;
}

export interface CustomToolsValidation {
  results: FileValidationResult[];
  /** Tools and annotations when every file passed, including the cross-file check. */
  loaded: LoadedCustomTools;
}

export interface LoadCustomToolsOptions {
  /** Uppercased library names. Omit to skip the schema allowlist. */
  allowedSchemas?: string[];
  /** Schema unqualified names resolve to while the allowlist is on. */
  defaultSchema?: string;
  /**
   * Configured systems. A tool with `system:` must name one, and is checked
   * against that system's allowlist instead of allowedSchemas. Omit to accept
   * any name.
   */
  systems?: SystemPolicy[];
}

export interface SystemPolicy {
  name: string;
  allowedSchemas?: string[];
  defaultSchema?: string;
}

/**
 * Allowlist options from the configured systems. Tools without `system:` are
 * checked against the default (first) system.
 */
export function systemLoadOptions(): LoadCustomToolsOptions {
  const systems = getSystems().map((system) => ({
    name: system.name,
    allowedSchemas: system.allowedSchemas,
    defaultSchema: system.defaultSchema,
  }));
  return { ...systems[0], systems };
}

const EMPTY: LoadedCustomTools = { tools: [], annotations: [], masking: new Map() };

/**
 * Load the files or directories listed in MCP_CUSTOM_TOOLS.
 * An unset or blank value loads nothing.
 */
export function loadCustomToolsFromEnv(): LoadedCustomTools {
  const raw = process.env.MCP_CUSTOM_TOOLS;
  if (raw === undefined || raw.trim() === '') {
    return EMPTY;
  }

  const paths = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return loadCustomTools(paths, systemLoadOptions());
}

/**
 * Read YAML files and check every statement before the server accepts connections.
 */
export function loadCustomTools(
  inputs: readonly string[],
  options: LoadCustomToolsOptions = {},
): LoadedCustomTools {
  const files = inputs.flatMap((input) => collectFiles(input));
  const tools: StoredTool[] = [];
  const annotations: StoredAnnotation[] = [];
  const masking: MaskingMap = new Map();
  const toolSources = new Map<string, string>();
  const annotationSources = new Map<string, string>();
  const maskingSources = new Map<string, string>();

  for (const file of files) {
    const parsed = readFile(file);
    for (const tool of parsed.tools ?? []) {
      const stored = checkTool(tool, file, options);
      const previous = toolSources.get(stored.name);
      if (previous) {
        throw new CustomToolsError(
          `Tool ${stored.name} is defined in both ${previous} and ${displayPath(file)}.`
        );
      }
      if ((TOOL_NAMES as readonly string[]).includes(stored.name)) {
        throw new CustomToolsError(
          `${displayPath(file)}: tool ${stored.name} is already a built-in tool.`
        );
      }
      toolSources.set(stored.name, displayPath(file));
      tools.push(stored);
    }

    for (const [table, annotation] of Object.entries(parsed.annotations ?? {})) {
      const stored = storeAnnotation(table, annotation);
      const previous = annotationSources.get(stored.table);
      if (previous) {
        throw new CustomToolsError(
          `Annotation ${stored.table} is defined in both ${previous} and ${displayPath(file)}.`
        );
      }
      annotationSources.set(stored.table, displayPath(file));
      annotations.push(stored);
    }

    for (const [table, columns] of Object.entries(parsed.masking ?? {})) {
      const tableKey = table.toUpperCase();
      for (const [column, rule] of Object.entries(columns)) {
        const columnKey = column.toUpperCase();
        const ruleKey = `${tableKey}.${columnKey}`;
        const previous = maskingSources.get(ruleKey);
        if (previous) {
          throw new CustomToolsError(
            `Masking rule ${ruleKey} is defined in both ${previous} and ${displayPath(file)}.`
          );
        }
        maskingSources.set(ruleKey, displayPath(file));
        const tableRules = masking.get(tableKey) ?? new Map();
        tableRules.set(columnKey, rule);
        masking.set(tableKey, tableRules);
      }
    }
  }

  for (const tool of tools) {
    const tables = maskedTablesInSql(tool.sql, masking);
    const rules = columnsForTables(masking, tables);
    const check = checkMaskedColumns(tool.sql, new Set(rules.keys()));
    if (check.violations.length > 0) {
      throw new CustomToolsError(`${tool.source}: tool ${tool.name}: ${check.violations.join('; ')}`);
    }
    const selected: Record<string, MaskRule> = {};
    for (const column of check.selected) {
      const rule = rules.get(column);
      if (rule) {
        selected[column] = rule;
      }
    }
    tool.maskedColumns = selected;
  }

  return { tools, annotations, masking };
}

/**
 * Check every file and keep going after a failure.
 * A second pass over the files that parsed catches duplicate names across files.
 * Throws only for errors that are not a CustomToolsError.
 */
export function validateCustomToolFiles(
  inputs: readonly string[],
  options: LoadCustomToolsOptions = {},
): CustomToolsValidation {
  const results: FileValidationResult[] = [];
  const files: string[] = [];

  for (const input of inputs) {
    try {
      files.push(...collectFiles(input));
    } catch (error) {
      if (!(error instanceof CustomToolsError)) {
        throw error;
      }
      results.push({ path: input, error: error.message, tools: 0, annotations: 0 });
    }
  }

  for (const file of files) {
    try {
      const loaded = loadCustomTools([file], options);
      results.push({
        path: displayPath(file),
        tools: loaded.tools.length,
        annotations: loaded.annotations.length,
      });
    } catch (error) {
      if (!(error instanceof CustomToolsError)) {
        throw error;
      }
      results.push({ path: displayPath(file), error: error.message, tools: 0, annotations: 0 });
    }
  }

  if (results.some((result) => result.error) || files.length === 0) {
    return { results, loaded: EMPTY };
  }

  try {
    return { results, loaded: loadCustomTools(files, options) };
  } catch (error) {
    if (!(error instanceof CustomToolsError)) {
      throw error;
    }
    results.push({ path: '', error: error.message, tools: 0, annotations: 0 });
    return { results, loaded: EMPTY };
  }
}

function readFile(file: string): ReturnType<typeof customToolsFileSchema.parse> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not read file';
    throw new CustomToolsError(`${displayPath(file)}: ${message}`);
  }

  const doc = parseDocument(text, { schema: 'core' });
  if (doc.errors.length > 0) {
    throw new CustomToolsError(
      `${displayPath(file)}: ${doc.errors.map((error) => error.message).join('; ')}`
    );
  }

  const parsed = customToolsFileSchema.safeParse(doc.toJS());
  if (!parsed.success) {
    throw new CustomToolsError(`${displayPath(file)}: ${formatSchemaIssues(parsed.error)}`);
  }
  return parsed.data;
}

function checkTool(tool: ToolDef, file: string, options: LoadCustomToolsOptions): StoredTool {
  const where = `${displayPath(file)}: tool ${tool.name}`;
  const parameters = tool.parameters ?? {};

  let rewritten;
  try {
    rewritten = rewriteNamedPlaceholders(tool.sql);
  } catch (error) {
    if (error instanceof PlaceholderError) {
      throw new CustomToolsError(`${where}: ${error.message}`);
    }
    throw error;
  }

  const declared = new Set(Object.keys(parameters));
  const used = new Set(rewritten.names);
  for (const name of used) {
    if (!declared.has(name)) {
      throw new CustomToolsError(`${where}: placeholder :${name} has no parameter definition.`);
    }
  }
  for (const name of declared) {
    if (!used.has(name)) {
      throw new CustomToolsError(`${where}: parameter ${name} is not used in the SQL.`);
    }
  }

  const security = validateQuery(rewritten.sql);
  if (!security.isValid) {
    throw new CustomToolsError(
      `${where}: Security validation failed: ${security.violations.join('; ')}`
    );
  }

  let policy: { allowedSchemas?: string[]; defaultSchema?: string } = options;
  if (tool.system && options.systems) {
    const system = options.systems.find((candidate) => candidate.name === tool.system);
    if (!system) {
      throw new CustomToolsError(
        `${where}: system ${tool.system} is not configured. Available: ${options.systems.map((candidate) => candidate.name).join(', ')}`
      );
    }
    policy = system;
  }

  if (policy.allowedSchemas && policy.allowedSchemas.length > 0) {
    const schemaResult = checkQuerySchemas(rewritten.sql, {
      allowed: policy.allowedSchemas,
      defaultSchema: policy.defaultSchema,
    });
    if (!schemaResult.ok) {
      throw new CustomToolsError(
        `${where}: Schema allowlist rejected the query: ${schemaResult.violations.join('; ')}`
      );
    }
  }

  return {
    name: tool.name,
    title: tool.title,
    ...(tool.toolset ? { toolset: tool.toolset } : {}),
    description: tool.description,
    parameters,
    ...(tool.maxRows !== undefined ? { maxRows: tool.maxRows } : {}),
    ...(tool.system ? { system: tool.system } : {}),
    sql: rewritten.sql,
    placeholderNames: rewritten.names,
    source: displayPath(file),
    maskedColumns: {},
  };
}

function storeAnnotation(table: string, annotation: AnnotationDef): StoredAnnotation {
  const columns: Record<string, string> = {};
  for (const [column, text] of Object.entries(annotation.columns ?? {})) {
    columns[column.toUpperCase()] = text;
  }

  const relations = (annotation.relations ?? []).map((relation) => {
    const join: Record<string, string> = {};
    for (const [from, to] of Object.entries(relation.join)) {
      join[from.toUpperCase()] = to.toUpperCase();
    }
    return {
      table: relation.table.toUpperCase(),
      join,
      ...(relation.cardinality ? { cardinality: relation.cardinality } : {}),
      ...(relation.description ? { description: relation.description } : {}),
    };
  });

  return {
    table: table.toUpperCase(),
    ...(annotation.entity ? { entity: annotation.entity } : {}),
    ...(annotation.description ? { description: annotation.description } : {}),
    columns,
    relations,
  };
}

function collectFiles(input: string): string[] {
  const resolved = path.resolve(input);
  let info;
  try {
    info = statSync(resolved);
  } catch {
    throw new CustomToolsError(`Custom tools path not found: ${input}`);
  }

  if (info.isFile()) {
    if (!isYaml(resolved)) {
      throw new CustomToolsError(`Custom tools file must be .yaml or .yml: ${input}`);
    }
    return [resolved];
  }

  if (!info.isDirectory()) {
    throw new CustomToolsError(`Custom tools path is not a file or directory: ${input}`);
  }

  const found: string[] = [];
  walk(resolved, found);
  found.sort((a, b) => a.localeCompare(b));
  if (found.length === 0) {
    throw new CustomToolsError(`No YAML files found in ${input}`);
  }
  return found;
}

function walk(dir: string, found: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, found);
    } else if (entry.isFile() && isYaml(entry.name)) {
      found.push(full);
    }
  }
}

function isYaml(file: string): boolean {
  return file.toLowerCase().endsWith('.yaml') || file.toLowerCase().endsWith('.yml');
}

function displayPath(file: string): string {
  const relative = path.relative(process.cwd(), file);
  return relative.startsWith('..') ? file : relative;
}
