/**
 * The view's side of the MCP Apps protocol (io.modelcontextprotocol/ui),
 * JSON-RPC 2.0 over postMessage with the host. Only what the result view uses:
 * the handshake, the tool input and result, host context changes, and size
 * changes. The ext-apps App class does the same with the MCP SDK and zod
 * bundled in, which would make the page several times larger.
 */

import type {
  McpUiHostContext,
  McpUiInitializeResult,
  McpUiToolInputNotification,
  McpUiToolResultNotification,
} from '@modelcontextprotocol/ext-apps';

/** The MCP Apps protocol version this view speaks. */
export const PROTOCOL_VERSION = '2026-01-26';

export interface BridgeHandlers {
  onToolInput?: (params: McpUiToolInputNotification['params']) => void;
  onToolResult?: (params: McpUiToolResultNotification['params']) => void;
  onHostContext?: (context: McpUiHostContext) => void;
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface Bridge {
  /** Tell the host how tall the view wants to be. */
  sizeChanged(height: number): void;
  close(): void;
}

/**
 * Connect to the host: send ui/initialize, apply the host context it returns,
 * then send ui/notifications/initialized. Notifications that arrive later go
 * to the handlers.
 *
 * @param target - The host window, usually window.parent
 * @param appInfo - Name and version sent in the handshake
 */
export function connect(
  target: Pick<Window, 'postMessage'>,
  appInfo: { name: string; version: string },
  handlers: BridgeHandlers,
  source: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): Promise<Bridge> {
  let nextId = 1;
  const pending = new Map<number | string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const send = (message: Omit<JsonRpcMessage, 'jsonrpc'>): void => {
    target.postMessage({ jsonrpc: '2.0', ...message }, '*');
  };

  const onMessage = (event: MessageEvent): void => {
    if (event.source !== null && event.source !== (target as unknown)) {
      return;
    }
    const message = event.data as JsonRpcMessage | undefined;
    if (!message || message.jsonrpc !== '2.0') {
      return;
    }
    if (message.id !== undefined && message.method === undefined) {
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
      }
      return;
    }
    switch (message.method) {
      case 'ui/notifications/tool-input':
        handlers.onToolInput?.(message.params as McpUiToolInputNotification['params']);
        break;
      case 'ui/notifications/tool-result':
        handlers.onToolResult?.(message.params as McpUiToolResultNotification['params']);
        break;
      case 'ui/notifications/host-context-changed':
        handlers.onHostContext?.(message.params as McpUiHostContext);
        break;
      case 'ui/resource-teardown':
      case 'ping':
        if (message.id !== undefined) send({ id: message.id, result: {} });
        break;
      default:
        if (message.id !== undefined) {
          send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
        }
    }
  };
  source.addEventListener('message', onMessage as EventListener);

  const request = (method: string, params: unknown): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  };

  return request('ui/initialize', {
    protocolVersion: PROTOCOL_VERSION,
    appInfo,
    appCapabilities: {},
  }).then((value) => {
    const result = value as McpUiInitializeResult;
    if (result.hostContext) {
      handlers.onHostContext?.(result.hostContext);
    }
    send({ method: 'ui/notifications/initialized', params: {} });
    return {
      sizeChanged(height: number) {
        send({ method: 'ui/notifications/size-changed', params: { height: Math.ceil(height) } });
      },
      close() {
        source.removeEventListener('message', onMessage as EventListener);
      },
    };
  });
}
