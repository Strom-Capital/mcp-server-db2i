/**
 * Server instructions sent in the initialize result.
 *
 * Built only from MCP_CUSTOM_TOOLS: a server without custom files sends none.
 */

import type { LoadedCustomTools } from './customTools/loader.js';

/**
 * Instructions for a new session, or undefined when there is nothing to say.
 *
 * A short built-in part points the model at the annotations and business tools,
 * then each file's own `instructions` text follows in file order.
 *
 * @param loaded - Custom tools, annotations and instructions currently loaded
 * @param enabledTools - Tool names registered for this session
 */
export function buildServerInstructions(
  loaded: LoadedCustomTools,
  enabledTools: ReadonlySet<string>,
): string | undefined {
  const parts: string[] = [];

  if (hasBusinessContext(loaded, enabledTools)) {
    parts.push(
      'Some tables have business annotations: what flags and status codes mean, and which rows to leave out. ' +
      'Before writing SQL against a table, read its business context with get_business_context or ' +
      'describe_table, and follow the rules it gives.'
    );
  }

  const businessTools = loaded.tools.filter((tool) => enabledTools.has(tool.name));
  if (businessTools.length > 0) {
    parts.push(
      'Business SQL tools already apply the business rules. Prefer one when it answers the question, ' +
      'over writing the SQL yourself.'
    );
  }

  for (const entry of loaded.instructions) {
    parts.push(entry.text);
  }

  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/**
 * A sentence for the description of a tool that runs ad-hoc SQL, or an empty string.
 *
 * Tool descriptions reach the model even in clients that ignore server instructions.
 *
 * @param loaded - Custom tools, annotations and instructions currently loaded
 * @param enabledTools - Tool names registered for this session
 */
export function businessContextHint(
  loaded: LoadedCustomTools,
  enabledTools: ReadonlySet<string>,
): string {
  if (!hasBusinessContext(loaded, enabledTools)) {
    return '';
  }
  return ' Some tables have business rules, such as which rows are deleted: call get_business_context for a table before querying it.';
}

function hasBusinessContext(loaded: LoadedCustomTools, enabledTools: ReadonlySet<string>): boolean {
  return loaded.annotations.length > 0 && enabledTools.has('get_business_context');
}
