import 'server-only';

import type { MCPClient } from '@ai-sdk/mcp';
import { summarizeTool, type ToolSummary } from '../catalog';
import type { BusinessContext } from '../context';

/** The server does not list the tool for this user, or it does not exist. */
export class ToolNotOfferedError extends Error {
  constructor(name: string) {
    super(`The server does not offer the tool ${name}.`);
    this.name = 'ToolNotOfferedError';
  }
}

/**
 * Call one tool directly, without a model. The arguments are checked against
 * the tool's list of names first, so only tools the server offers this user
 * can run.
 *
 * @param client - Connected MCP client
 * @param name - Tool name
 * @param args - Tool arguments
 * @returns The tool result
 * @throws Error when the server does not offer the tool
 */
export async function callListedTool(client: MCPClient, name: string, args: Record<string, unknown>) {
  const { tools } = await client.listTools();
  if (!tools.some((tool) => tool.name === name)) {
    throw new ToolNotOfferedError(name);
  }
  return client.callTool({ name, arguments: args });
}

/**
 * Every tool the server offers this user, for the tools page.
 *
 * @param client - Connected MCP client
 * @returns Summaries in the server's order
 */
export async function listToolSummaries(client: MCPClient): Promise<ToolSummary[]> {
  const { tools } = await client.listTools();
  return tools.map(summarizeTool);
}

const BUSINESS_CONTEXT_URI = 'db2i://business-context';

function parseContext(text: string | undefined): BusinessContext | undefined {
  if (!text) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as { data?: unknown };
    return Array.isArray(parsed.data) ? { available: true, annotations: parsed.data as BusinessContext['annotations'] } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The business context loaded from the server's YAML files: entities, table
 * and column notes, row filters and relations. Reads the
 * `db2i://business-context` resource, or calls `get_business_context` when
 * the server offers the tool but not the resource.
 *
 * @param client - Connected MCP client
 * @returns The annotations, or `available: false` when the server has none
 */
export async function readBusinessContext(client: MCPClient): Promise<BusinessContext> {
  const { tools } = await client.listTools();
  if (!tools.some((tool) => tool.name === 'get_business_context')) {
    return { available: false, annotations: [] };
  }
  try {
    const resource = await client.readResource({ uri: BUSINESS_CONTEXT_URI });
    const first = resource.contents[0];
    const fromResource = parseContext(first && 'text' in first && typeof first.text === 'string' ? first.text : undefined);
    if (fromResource) {
      return fromResource;
    }
  } catch {
    // Older servers have the tool but not the resource
  }
  const result = (await client.callTool({ name: 'get_business_context', arguments: {} })) as {
    structuredContent?: { data?: unknown };
    content?: { type: string; text?: string }[];
  };
  if (Array.isArray(result.structuredContent?.data)) {
    return { available: true, annotations: result.structuredContent.data as BusinessContext['annotations'] };
  }
  return parseContext(result.content?.find((part) => part.type === 'text')?.text) ?? { available: true, annotations: [] };
}
