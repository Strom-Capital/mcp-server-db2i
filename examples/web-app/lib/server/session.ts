import 'server-only';

import type { OAuthAuthorizationServerInformation, OAuthClientInformation, OAuthTokens } from '@ai-sdk/mcp';
import { getIronSession, type IronSession, type SessionOptions } from 'iron-session';
import { cookies } from 'next/headers';
import { getConfig } from './config';

/** What the encrypted session cookie holds. The model API key is never stored here. */
export interface SessionData {
  oauth?: {
    clientInformation?: OAuthClientInformation;
    serverInformation?: OAuthAuthorizationServerInformation;
    codeVerifier?: string;
    state?: string;
    tokens?: OAuthTokens;
    /** Epoch milliseconds the access token expires at. */
    expiresAt?: number;
  };
}

export type AppSession = IronSession<SessionData>;

export const SESSION_COOKIE = 'db2i_web_session';

/**
 * Session cookie options. httpOnly so scripts cannot read the tokens, and
 * SameSite=Lax so the cookie comes back on the OAuth redirect but not on
 * cross-site POSTs.
 */
export function sessionOptions(): SessionOptions {
  const config = getConfig();
  return {
    password: config.sessionSecret,
    cookieName: SESSION_COOKIE,
    ttl: 60 * 60 * 24 * 30,
    cookieOptions: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.appUrl.protocol === 'https:',
      path: '/',
    },
  };
}

/**
 * The current browser's session, read from its cookie.
 *
 * @returns The session; call `save()` after changing it
 */
export async function getSession(): Promise<AppSession> {
  return getIronSession<SessionData>(await cookies(), sessionOptions());
}
