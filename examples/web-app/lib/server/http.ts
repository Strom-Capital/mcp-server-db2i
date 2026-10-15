import 'server-only';

import { getConfig } from './config';
import { SignInRequiredError } from './oauth';

/**
 * Refuse a state-changing request that does not come from this app's own
 * pages. The session cookie is SameSite=Lax as well; this covers same-site
 * hosts and older browsers.
 *
 * @param request - The incoming request
 * @returns A 403 response, or undefined when the origin matches
 */
export function checkOrigin(request: Request): Response | undefined {
  const origin = request.headers.get('origin');
  const expected = getConfig().appUrl.origin;
  if (origin !== expected) {
    return Response.json({ error: 'Cross-origin request refused.' }, { status: 403 });
  }
  return undefined;
}

/**
 * Refuse a read that another site started. GET requests carry the
 * SameSite=Lax cookie on top-level navigations, and these reads reach the
 * IBM i, so `Sec-Fetch-Site` must say the request came from this app.
 *
 * @param request - The incoming request
 * @returns A 403 response, or undefined when the request is same-origin or the browser sent no header
 */
export function checkFetchSite(request: Request): Response | undefined {
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return Response.json({ error: 'Cross-site request refused.' }, { status: 403 });
  }
  return undefined;
}

/**
 * Turn an error into a JSON response. Sign-in errors become 401 so the page
 * can show the sign-in button; anything else is a 502 with a short message.
 *
 * @param error - What went wrong
 * @param secrets - Strings to blank out of the message, such as the model API key
 * @returns The response
 */
export function errorResponse(error: unknown, secrets: string[] = []): Response {
  if (error instanceof SignInRequiredError) {
    return Response.json({ error: error.message, signIn: true }, { status: 401 });
  }
  return Response.json({ error: redact(errorMessage(error), secrets) }, { status: 502 });
}

/**
 * The message of an error, or a fallback.
 *
 * @param error - Anything thrown
 * @returns A one-line message
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message.split('\n')[0] ?? 'Request failed';
  }
  return 'Request failed';
}

/**
 * Replace every occurrence of the given secrets in text.
 *
 * @param text - Text that may contain a secret
 * @param secrets - Values to hide; empty strings are ignored
 * @returns The text with each secret replaced by `[redacted]`
 */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 4) {
      out = out.split(secret).join('[redacted]');
    }
  }
  return out;
}
