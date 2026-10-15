import 'server-only';

import { randomBytes } from 'node:crypto';
import {
  auth,
  type OAuthAuthorizationServerInformation,
  type OAuthClientInformation,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
} from '@ai-sdk/mcp';
import { getConfig } from './config';
import type { AppSession, SessionData } from './session';

/** Refresh when the access token has less than this left, so it never expires mid-stream. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

type OAuthState = NonNullable<SessionData['oauth']>;

/** Raised when the browser has no usable sign-in and must go through OAuth again. */
export class SignInRequiredError extends Error {
  constructor(message = 'Sign in to the IBM i first.') {
    super(message);
    this.name = 'SignInRequiredError';
  }
}

/**
 * OAuth client provider for the AI SDK's MCP `auth()`, backed by the
 * encrypted session cookie. One instance per request; the caller saves the
 * session afterwards.
 */
export class SessionOAuthProvider implements OAuthClientProvider {
  /** Set when `auth()` wants the browser sent to the sign-in page. */
  authorizationUrl: URL | undefined;

  constructor(private readonly session: AppSession) {}

  private get oauth(): OAuthState {
    this.session.oauth ??= {};
    return this.session.oauth;
  }

  get redirectUrl(): string {
    return new URL('/oauth/callback', getConfig().appUrl).toString();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: 'mcp-server-db2i web app',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_basic',
    };
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this.oauth.clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformation): void {
    this.oauth.clientInformation = clientInformation;
  }

  isClientInformationDynamicallyRegistered(): boolean {
    return this.oauth.clientInformation !== undefined;
  }

  authorizationServerInformation(): OAuthAuthorizationServerInformation | undefined {
    return this.oauth.serverInformation;
  }

  saveAuthorizationServerInformation(information: OAuthAuthorizationServerInformation): void {
    this.oauth.serverInformation = information;
  }

  tokens(): OAuthTokens | undefined {
    return this.oauth.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.oauth.tokens = tokens;
    this.oauth.expiresAt = typeof tokens.expires_in === 'number' ? Date.now() + tokens.expires_in * 1000 : undefined;
    delete this.oauth.codeVerifier;
    delete this.oauth.state;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.oauth.codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    const verifier = this.oauth.codeVerifier;
    if (!verifier) {
      throw new SignInRequiredError('The sign-in expired. Start it again.');
    }
    return verifier;
  }

  state(): string {
    return randomBytes(24).toString('base64url');
  }

  saveState(state: string): void {
    this.oauth.state = state;
  }

  storedState(): string | undefined {
    return this.oauth.state;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): void {
    if (scope === 'all') {
      delete this.session.oauth;
      return;
    }
    if (scope === 'client') {
      delete this.oauth.clientInformation;
      delete this.oauth.serverInformation;
    }
    if (scope === 'tokens' || scope === 'client') {
      delete this.oauth.tokens;
      delete this.oauth.expiresAt;
    }
    if (scope === 'verifier') {
      delete this.oauth.codeVerifier;
    }
  }
}

/**
 * Start the OAuth sign-in: register the app as a client and build the
 * authorization URL with PKCE and state.
 *
 * @param session - The browser's session; saved by the caller
 * @returns The URL to send the browser to, or undefined when already signed in
 */
export async function startSignIn(session: AppSession): Promise<URL | undefined> {
  // Register again on every sign-in: a client from before a server restart with
  // a new MCP_OAUTH_SECRET is rejected at the authorize step, where the app never sees the error
  delete session.oauth;
  const provider = new SessionOAuthProvider(session);
  const result = await auth(provider, { serverUrl: getConfig().mcpEndpoint });
  return result === 'REDIRECT' ? provider.authorizationUrl : undefined;
}

/**
 * Finish the OAuth sign-in: check state and exchange the code for tokens.
 *
 * @param session - The browser's session; saved by the caller
 * @param params - The callback's query parameters
 */
export async function finishSignIn(
  session: AppSession,
  params: { code: string; state?: string; iss?: string },
): Promise<void> {
  const provider = new SessionOAuthProvider(session);
  const result = await auth(provider, {
    serverUrl: getConfig().mcpEndpoint,
    authorizationCode: params.code,
    callbackState: params.state,
    callbackIssuer: params.iss,
  });
  if (result !== 'AUTHORIZED') {
    throw new SignInRequiredError();
  }
}

/** Refreshes in flight, by refresh token, so parallel requests from one browser share one. */
const refreshing = new Map<string, Promise<OAuthTokens | undefined>>();

/**
 * Make sure the session has an access token that lasts past the margin,
 * refreshing it first if needed. Refresh tokens work once on this server, so
 * parallel requests wait for the same refresh instead of each using the token.
 *
 * @param session - The browser's session; saved by the caller when it changed
 * @returns The access token, and whether the session changed
 * @throws SignInRequiredError when there is no sign-in or the refresh fails
 */
export async function ensureAccessToken(session: AppSession): Promise<{ accessToken: string; changed: boolean }> {
  const oauth = session.oauth;
  const tokens = oauth?.tokens;
  if (!oauth || !tokens) {
    throw new SignInRequiredError();
  }
  const fresh = oauth.expiresAt === undefined || oauth.expiresAt - Date.now() > REFRESH_MARGIN_MS;
  if (fresh) {
    return { accessToken: tokens.access_token, changed: false };
  }
  const refreshToken = tokens.refresh_token;
  if (!refreshToken) {
    if (oauth.expiresAt !== undefined && oauth.expiresAt > Date.now()) {
      return { accessToken: tokens.access_token, changed: false };
    }
    throw new SignInRequiredError('The sign-in expired. Sign in again.');
  }

  let pending = refreshing.get(refreshToken);
  if (!pending) {
    pending = refreshWith(session).finally(() => {
      setTimeout(() => refreshing.delete(refreshToken), 30_000).unref?.();
    });
    refreshing.set(refreshToken, pending);
  }
  const next = await pending;
  if (!next) {
    delete oauth.tokens;
    delete oauth.expiresAt;
    throw new SignInRequiredError('The sign-in expired. Sign in again.');
  }
  new SessionOAuthProvider(session).saveTokens(next);
  return { accessToken: next.access_token, changed: true };
}

async function refreshWith(session: AppSession): Promise<OAuthTokens | undefined> {
  const provider = new SessionOAuthProvider(session);
  try {
    const result = await auth(provider, { serverUrl: getConfig().mcpEndpoint });
    return result === 'AUTHORIZED' ? provider.tokens() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Revoke the session's tokens at the server, best effort. The caller destroys
 * the session either way.
 *
 * @param session - The browser's session
 */
export async function revokeTokens(session: AppSession): Promise<void> {
  const oauth = session.oauth;
  const client = oauth?.clientInformation;
  if (!oauth?.tokens || !client) {
    return;
  }
  const endpoint = new URL('/oauth/revoke', oauth.serverInformation?.authorizationServerUrl ?? getConfig().mcpServerUrl);
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (client.client_secret) {
    const basic = Buffer.from(
      `${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`,
    ).toString('base64');
    headers.Authorization = `Basic ${basic}`;
  }
  const tokens = [oauth.tokens.refresh_token, oauth.tokens.access_token].filter((token): token is string => !!token);
  await Promise.all(
    tokens.map(async (token) => {
      const body = new URLSearchParams({ token });
      if (!client.client_secret) {
        body.set('client_id', client.client_id);
      }
      try {
        await fetch(endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
      } catch {
        // The server may be down; the cookie is cleared anyway
      }
    }),
  );
}
