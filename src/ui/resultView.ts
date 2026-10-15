/**
 * The result view: an MCP Apps resource (the io.modelcontextprotocol/ui
 * extension) that shows a tool's rows as a grid and a chart. Hosts that support
 * MCP Apps render it next to the tool result; others ignore the tool metadata
 * and show the text result as before.
 *
 * The page is built from ui/result by scripts/build-ui.mjs into one HTML file
 * with no external scripts. It reads only the tool result the host hands it
 * and makes no network calls.
 */

import type { McpServer } from '@modelcontextprotocol/server';

import { isUiEnabled } from '../config.js';
import { RESULT_VIEW_HTML } from './resultHtml.generated.js';

export const RESULT_VIEW_URI = 'ui://db2i/result';

/** MIME type of an MCP Apps HTML resource. */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

/** Older hosts read the resource URI from this flat `_meta` key. */
const LEGACY_RESOURCE_URI_KEY = 'ui/resourceUri';

/**
 * Tool `_meta` that points hosts at the result view, or nothing when
 * MCP_UI_ENABLED is off.
 */
export function resultViewMeta(): Record<string, unknown> {
  if (!isUiEnabled()) {
    return {};
  }
  return { ui: { resourceUri: RESULT_VIEW_URI }, [LEGACY_RESOURCE_URI_KEY]: RESULT_VIEW_URI };
}

/**
 * Register the result view resource when MCP_UI_ENABLED is on.
 *
 * @param server - Server to register on
 */
export function registerResultView(server: McpServer): void {
  if (!isUiEnabled()) {
    return;
  }
  server.registerResource(
    'result_view',
    RESULT_VIEW_URI,
    {
      title: 'Result view',
      description: 'Grid and chart for query results, shown by hosts that support MCP Apps.',
      mimeType: MCP_APP_MIME_TYPE,
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: MCP_APP_MIME_TYPE,
          text: RESULT_VIEW_HTML,
          _meta: { ui: { prefersBorder: true } },
        },
      ],
    }),
  );
}
