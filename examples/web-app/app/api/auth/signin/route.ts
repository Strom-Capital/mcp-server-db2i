import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/server/config';
import { errorMessage } from '@/lib/server/http';
import { startSignIn } from '@/lib/server/oauth';
import { getSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/** Send the browser to the server's sign-in page, registering the app first if needed. */
export async function GET(): Promise<Response> {
  const appUrl = getConfig().appUrl;
  const session = await getSession();
  try {
    const authorizationUrl = await startSignIn(session);
    await session.save();
    return NextResponse.redirect(authorizationUrl ?? new URL('/', appUrl));
  } catch (error) {
    await session.save();
    const target = new URL('/', appUrl);
    target.searchParams.set('signin_error', errorMessage(error));
    return NextResponse.redirect(target);
  }
}
