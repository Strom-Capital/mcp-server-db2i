/** `_meta` key the server puts on business SQL tools in `tools/list`. */
export const TOOL_META_KEY = 'db2i-mcp/tool';

/** One tool from `tools/list`, as the tools page shows it. */
export interface ToolSummary {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchema;
  /** `business` for YAML business SQL tools, `builtin` for the server's own tools. */
  kind: 'business' | 'builtin';
  /** Group name from the tool file, for business tools that set one. */
  toolset?: string;
  readOnly?: boolean;
}

/** The parts of JSON Schema the forms read. */
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  anyOf?: JsonSchema[];
  enum?: unknown[];
  description?: string;
  pattern?: string;
  format?: string;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  default?: unknown;
  items?: JsonSchema;
}

/** A tool definition as `tools/list` returns it. */
export interface ListedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: object;
  annotations?: { title?: string; readOnlyHint?: boolean };
  _meta?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A tool definition with its kind and toolset read from `_meta`. Servers
 * without the `_meta` mark list every tool as built-in.
 *
 * @param tool - A tool definition from `tools/list`
 * @returns The summary for the tools page
 */
export function summarizeTool(tool: ListedTool): ToolSummary {
  const meta = tool._meta?.[TOOL_META_KEY];
  const business = isRecord(meta) && meta.kind === 'business';
  return {
    name: tool.name,
    title: tool.title ?? tool.annotations?.title,
    description: tool.description,
    inputSchema: tool.inputSchema as JsonSchema,
    kind: business ? 'business' : 'builtin',
    ...(business && typeof meta.toolset === 'string' ? { toolset: meta.toolset } : {}),
    ...(tool.annotations?.readOnlyHint !== undefined ? { readOnly: tool.annotations.readOnlyHint } : {}),
  };
}

/** Tools under one heading on the tools page. */
export interface ToolGroup {
  id: string;
  label: string;
  tools: ToolSummary[];
}

function toolsetLabel(toolset: string): string {
  return toolset.charAt(0).toUpperCase() + toolset.slice(1).replace(/[-_]+/g, ' ');
}

/**
 * Business tools by toolset, in name order, then the built-in tools.
 *
 * @param tools - Tool summaries
 * @returns Groups with at least one tool
 */
export function groupTools(tools: ToolSummary[]): ToolGroup[] {
  const byToolset = new Map<string, ToolSummary[]>();
  const builtin: ToolSummary[] = [];
  for (const tool of tools) {
    if (tool.kind === 'builtin') {
      builtin.push(tool);
      continue;
    }
    const key = tool.toolset ?? '';
    byToolset.set(key, [...(byToolset.get(key) ?? []), tool]);
  }
  const groups: ToolGroup[] = [...byToolset.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
    .map(([toolset, list]) => ({
      id: `business:${toolset}`,
      label: toolset ? toolsetLabel(toolset) : 'Business tools',
      tools: list,
    }));
  if (builtin.length > 0) {
    groups.push({ id: 'builtin', label: 'Built-in tools', tools: builtin });
  }
  return groups;
}