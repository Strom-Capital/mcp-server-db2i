/**
 * Server instructions sent in the initialize result.
 *
 * Built only from MCP_CUSTOM_TOOLS: a server without custom files sends none.
 */

import type { LoadedCustomTools } from './customTools/loader.js';

/** Tools that return a table's annotations, in the order the text names them. */
const CONTEXT_TOOLS = ['get_business_context', 'describe_table'] as const;

/**
 * Instructions for a new session, or undefined when there is nothing to say.
 *
 * A short built-in part points the model at the annotations and business tools,
 * then each file's own `instructions` text follows in file order. A file that
 * defines business tools adds its text only when one of them is registered.
 *
 * @param loaded - Custom tools, annotations and instructions currently loaded
 * @param registered - Tool names registered for this session, built-in and business
 */
export function buildServerInstructions(
  loaded: LoadedCustomTools,
  registered: ReadonlySet<string>,
): string | undefined {
  const parts: string[] = [];

  const readers = contextTools(loaded, registered);
  if (readers.length > 0) {
    parts.push(
      'Some tables have business annotations: what flags and status codes mean, and which rows to leave out. ' +
      `Before writing SQL against a table, read its business context with ${readers.join(' or ')}, ` +
      'and follow the rules it gives.'
    );
  }

  if (loaded.tools.some((tool) => registered.has(tool.name))) {
    parts.push(
      'Business SQL tools already apply the business rules. Prefer one when it answers the question, ' +
      'over writing the SQL yourself.'
    );
  }

  for (const entry of loaded.instructions) {
    if (entry.tools.length === 0 || entry.tools.some((name) => registered.has(name))) {
      parts.push(entry.text);
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/**
 * A sentence for the description of a tool that runs ad-hoc SQL, or an empty string.
 *
 * Tool descriptions reach the model even in clients that ignore server instructions.
 *
 * @param loaded - Custom tools, annotations and instructions currently loaded
 * @param registered - Tool names registered for this session, built-in and business
 */
export function businessContextHint(
  loaded: LoadedCustomTools,
  registered: ReadonlySet<string>,
): string {
  const [reader] = contextTools(loaded, registered);
  if (!reader) {
    return '';
  }
  return ` Some tables have business rules, such as which rows are deleted: call ${reader} for a table before querying it.`;
}

function contextTools(loaded: LoadedCustomTools, registered: ReadonlySet<string>): string[] {
  if (loaded.annotations.length === 0) {
    return [];
  }
  return CONTEXT_TOOLS.filter((name) => registered.has(name));
}
