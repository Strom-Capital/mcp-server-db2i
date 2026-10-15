import { getConfig } from '@/lib/server/config';
import { getSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/** Whether this browser is signed in, without contacting the server. */
export async function GET(): Promise<Response> {
  const session = await getSession();
  const oauth = session.oauth;
  const signedIn = !!oauth?.tokens && (!!oauth.tokens.refresh_token || (oauth.expiresAt ?? Infinity) > Date.now());
  return Response.json({
    signedIn,
    server: getConfig().mcpServerUrl.host,
    customModelBaseUrls: getConfig().customModelBaseUrls,
  });
}
