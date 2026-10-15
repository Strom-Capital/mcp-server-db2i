import { getConfig } from '@/lib/server/config';
import { getSession, isSignedIn } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/** Whether this browser is signed in, without contacting the server. Lists which providers have a server key, never the key. */
export async function GET(): Promise<Response> {
  const session = await getSession();
  const config = getConfig();
  return Response.json({
    signedIn: isSignedIn(session),
    server: config.mcpServerUrl.host,
    customModelBaseUrls: config.customModelBaseUrls,
    serverKeys: Object.keys(config.serverModelKeys),
    defaultModel: config.defaultModel,
  });
}
