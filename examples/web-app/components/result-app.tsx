'use client';

import {
  experimental_MCPAppRenderer as MCPAppRenderer,
  type MCPAppBridgeHandlers,
  type MCPAppMetadata,
  type MCPAppResource,
  type MCPAppSandboxConfig,
} from '@ai-sdk/react';
import type { DynamicToolUIPart } from 'ai';
import { useTheme } from 'next-themes';
import { useMemo, useState } from 'react';

const HOST_INFO = { name: 'mcp-server-db2i-web-app', version: '0.1.0' };
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 720;

/** One request per view URI; every tool call shows the same page. */
const resources = new Map<string, Promise<MCPAppResource>>();

function loadResource(app: MCPAppMetadata): Promise<MCPAppResource> {
  let cached = resources.get(app.resourceUri);
  if (!cached) {
    cached = fetch('/api/mcp-app/resource', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri: app.resourceUri }),
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`The result view did not load (${response.status}).`);
      }
      return (await response.json()) as MCPAppResource;
    });
    cached.catch(() => resources.delete(app.resourceUri));
    resources.set(app.resourceUri, cached);
  }
  return cached;
}

/**
 * The server's result view (MCP Apps) for a tool call: a chart and grid in a
 * sandboxed frame. Renders nothing for a tool without a view, or when the
 * server has MCP_UI_ENABLED=false.
 */
export function ResultApp({ part }: { part: DynamicToolUIPart }) {
  const { resolvedTheme } = useTheme();
  const [height, setHeight] = useState(360);

  const handlers = useMemo<MCPAppBridgeHandlers>(
    () => ({
      onSizeChange: ({ height: wanted }) => {
        if (wanted) {
          setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(wanted))));
        }
      },
    }),
    [],
  );

  const hostContext = useMemo(
    () => ({
      theme: resolvedTheme === 'dark' ? ('dark' as const) : ('light' as const),
      displayMode: 'inline' as const,
      availableDisplayModes: ['inline' as const],
      locale: typeof navigator === 'undefined' ? 'en-US' : navigator.language,
    }),
    [resolvedTheme],
  );

  const sandbox = useMemo<MCPAppSandboxConfig>(
    () => ({
      url: '/mcp-app-sandbox.html',
      title: `${part.toolName} result`,
      className: 'w-full rounded-sm border border-border bg-card',
      style: { height },
    }),
    [height, part.toolName],
  );

  return (
    <MCPAppRenderer
      part={part}
      loadResource={loadResource}
      handlers={handlers}
      hostInfo={HOST_INFO}
      hostContext={hostContext}
      sandbox={sandbox}
      fallback={null}
    />
  );
}
