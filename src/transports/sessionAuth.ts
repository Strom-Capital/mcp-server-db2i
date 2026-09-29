/**
 * Session ownership helpers for HTTP MCP endpoints.
 *
 * Pools and stateful sessions are keyed by the caller identity: in required
 * mode the auth token, or the OAuth grant every token of one sign-in shares;
 * in none/token modes the shared "global" key. Request handlers must reject
 * a Mcp-Session-Id that belongs to a different caller.
 */

import { sessionPoolKey } from '../auth/tokenManager.js';
import type { TokenSession } from '../auth/types.js';
import type { AuthMode } from '../config.js';

/** Shared pool / session key used when HTTP auth is none or static token. */
export const GLOBAL_SESSION_KEY = 'global';

/**
 * Resolve the session key for the current caller.
 *
 * - none / token: one shared key ("global")
 * - required: the validated Bearer token, or its OAuth grant, so a refreshed
 *   token keeps the pool of the sign-in it came from
 */
export function resolveCallerSessionKey(
  authMode: AuthMode,
  authToken?: string,
  session?: Pick<TokenSession, 'grantId'>
): string {
  if (authMode === 'none' || authMode === 'token') {
    return GLOBAL_SESSION_KEY;
  }
  return authToken ? sessionPoolKey(authToken, session) : '';
}

/**
 * Whether a stored MCP session belongs to the current caller.
 */
export function isSessionOwnedByCaller(
  sessionAuthToken: string,
  callerSessionKey: string
): boolean {
  return sessionAuthToken === callerSessionKey;
}
