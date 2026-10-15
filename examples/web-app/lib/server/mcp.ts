import 'server-only';

import { createMCPClient, mcpAppClientCapabilities, type MCPClient } from '@ai-sdk/mcp';
import { getConfig } from './config';
import { ensureAccessToken, SignInRequiredError } from './oauth';
import { getSession, type AppSession } from './session';

const CLIENT_NAME = 'mcp-server-db2i-web-app';
const CLIENT_VERSION = '0.1.0';

export interface McpConnection {
  client: MCPClient;
  session: AppSession;
  close: () => Promise<void>;
}

/**
 * Connect to the MCP server as the signed-in user. The access token is
 * refreshed and the session saved before anything streams, because a cookie
 * cannot be set once a streamed response has started.
 *
 * @returns The connected client and a close function that never throws
 * @throws SignInRequiredError when the browser is not signed in, or the server refuses the token
 */
export async function connectMcp(): Promise<McpConnection> {
  const session = await getSession();
  const { accessToken, changed } = await ensureAccessToken(session).catch(async (error: unknown) => {
    if (error instanceof SignInRequiredError) {
      await session.save();
    }
    throw error;
  });
  if (changed) {
    await session.save();
  }

  let client: MCPClient;
  try {
    client = await createMCPClient({
      transport: {
        type: 'http',
        url: getConfig().mcpEndpoint.toString(),
        headers: { Authorization: `Bearer ${accessToken}` },
      },
      clientName: CLIENT_NAME,
      version: CLIENT_VERSION,
      // The chat renders the server's result view (MCP Apps) under tool calls
      capabilities: mcpAppClientCapabilities,
    });
  } catch (error) {
    if (isUnauthorized(error)) {
      delete session.oauth?.tokens;
      delete session.oauth?.expiresAt;
      await session.save();
      throw new SignInRequiredError('The server no longer accepts this sign-in. Sign in again.');
    }
    throw error;
  }

  let closed = false;
  return {
    client,
    session,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await client.close().catch(() => undefined);
    },
  };
}

function isUnauthorized(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const text = `${error.name} ${error.message} ${String((error as { cause?: unknown }).cause ?? '')}`;
  return /\b401\b|unauthori[sz]ed|invalid_token/i.test(text);
}

/**
 * Run work with a connected client and close it afterwards.
 *
 * @param work - What to do with the client
 * @returns What `work` returns
 */
export async function withMcp<T>(work: (client: MCPClient) => Promise<T>): Promise<T> {
  const connection = await connectMcp();
  try {
    return await work(connection.client);
  } finally {
    await connection.close();
  }
}
