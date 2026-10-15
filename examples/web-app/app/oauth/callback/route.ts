import { NextResponse, type NextRequest } from 'next/server';
import { getConfig } from '@/lib/server/config';
import { errorMessage } from '@/lib/server/http';
import { finishSignIn } from '@/lib/server/oauth';
import { getSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/** OAuth redirect target: exchange the code for tokens, then go back to the chat. */
export async function GET(request: NextRequest): Promise<Response> {
  const appUrl = getConfig().appUrl;
  const params = request.nextUrl.searchParams;
  const home = new URL('/', appUrl);

  const denied = params.get('error');
  const code = params.get('code');
  if (denied || !code) {
    home.searchParams.set('signin_error', params.get('error_description') ?? denied ?? 'The sign-in did not return a code.');
    return NextResponse.redirect(home);
  }

  const session = await getSession();
  try {
    await finishSignIn(session, {
      code,
      state: params.get('state') ?? undefined,
      iss: params.get('iss') ?? undefined,
    });
  } catch (error) {
    home.searchParams.set('signin_error', errorMessage(error));
  }
  await session.save();
  return NextResponse.redirect(home);
}
