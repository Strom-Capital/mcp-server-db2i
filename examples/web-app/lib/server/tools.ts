import 'server-only';

import type { ListToolsResult, MCPClient } from '@ai-sdk/mcp';
import type { ToolSet } from 'ai';

type ToolDefinition = ListToolsResult['tools'][number];

/** The server does not list the tool for this user, or it does not exist. */
export class ToolNotOfferedError extends Error {
  constructor(name: string) {
    super(`The server does not offer the tool ${name}.`);
    this.name = 'ToolNotOfferedError';
  }
}

/**
 * Names of the systems a tool can run on, from its `system` argument. The
 * server only adds that argument when the user can reach more than one system.
 *
 * @param tool - A tool definition from `tools/list`
 * @returns The system names, or an empty list
 */
export function toolSystems(tool: ToolDefinition): string[] {
  const properties = (tool.inputSchema as { properties?: Record<string, { enum?: unknown[] }> }).properties;
  const values = properties?.system?.enum;
  return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string') : [];
}

/**
 * The server's tools as AI SDK tools. When the user picked a system, tools
 * that take a `system` argument run there unless the model names another.
 *
 * @param client - Connected MCP client
 * @param system - Picked system, if any
 * @returns Tools for `streamText`
 */
export async function systemAwareTools(client: MCPClient, system: string | undefined): Promise<ToolSet> {
  const definitions = await client.listTools();
  const tools = client.toolsFromDefinitions(definitions) as ToolSet;
  if (!system) {
    return tools;
  }
  const wrapped: ToolSet = {};
  for (const definition of definitions.tools) {
    const tool = tools[definition.name];
    if (!tool) {
      continue;
    }
    const execute = tool.execute;
    if (!execute || !toolSystems(definition).includes(system)) {
      wrapped[definition.name] = tool;
      continue;
    }
    wrapped[definition.name] = {
      ...tool,
      execute: (input: unknown, options) =>
        execute({ ...(input as Record<string, unknown>), system: (input as { system?: string }).system ?? system }, options),
    } as typeof tool;
  }
  return wrapped;
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
