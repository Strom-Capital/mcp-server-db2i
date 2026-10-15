import { checkOrigin } from '@/lib/server/http';
import { revokeTokens } from '@/lib/server/oauth';
import { getSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/** Revoke the tokens at the server and clear the session cookie. */
export async function POST(request: Request): Promise<Response> {
  const refused = checkOrigin(request);
  if (refused) {
    return refused;
  }
  const session = await getSession();
  await revokeTokens(session);
  session.destroy();
  return Response.json({ signedIn: false });
}
