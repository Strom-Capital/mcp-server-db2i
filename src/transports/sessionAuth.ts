/**
 * Session ownership helpers for HTTP MCP endpoints.
 *
 * Stateful sessions are keyed by the caller identity (auth token in
 * required mode, or the shared "global" key in none/token modes).
 * Request handlers must reject a Mcp-Session-Id that belongs to a
 * different caller.
 */

import type { AuthMode } from '../config.js';

/** Shared pool / session key used when HTTP auth is none or static token. */
export const GLOBAL_SESSION_KEY = 'global';

/**
 * Resolve the session key for the current caller.
 *
 * - none / token: one shared key ("global")
 * - required: the validated Bearer token
 */
export function resolveCallerSessionKey(
  authMode: AuthMode,
  authToken?: string
): string {
  if (authMode === 'none' || authMode === 'token') {
    return GLOBAL_SESSION_KEY;
  }
  return authToken ?? '';
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
