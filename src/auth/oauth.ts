/**
 * Built-in OAuth 2.1 authorization server for remote MCP clients.
 *
 * Lets clients such as claude.ai custom connectors reach the HTTP transport
 * without a static header. The user signs in with their own IBM i user profile
 * on a page this server renders, and the access token is the same in-memory
 * token POST /auth issues, so every query runs with that user's authority.
 *
 * Endpoints:
 * - GET  /.well-known/oauth-protected-resource[/mcp]  RFC 9728
 * - GET  /.well-known/oauth-authorization-server       RFC 8414
 * - POST /oauth/register                               RFC 7591, stateless
 * - GET  /oauth/authorize, POST /oauth/authorize       login page, code + PKCE (S256)
 * - POST /oauth/token                                  authorization_code, refresh_token
 * - POST /oauth/revoke                                 RFC 7009
 *
 * Client IDs are the registered metadata signed with MCP_OAUTH_SECRET, so
 * registration keeps no state and survives a restart when the secret is set.
 * Codes live in memory. Refresh grants live in memory too, and with
 * MCP_OAUTH_STATE_FILE also in an encrypted file, so a restart keeps users
 * signed in (see grantStore.ts). Every token from one sign-in shares
 * a grant ID, so revoking one of them, or replaying its code, ends them all.
 */

import crypto from 'node:crypto';
import express, { type Request, type RequestHandler, type Response, type Router } from 'express';

import { FAVICON_SVG, LOGO_SHAPES } from '../branding.js';
import { getHttpConfig, isLoopbackHost, normalizeDbHost, type DB2iConfig, type OAuthConfig } from '../config.js';
import { defaultSystem, getSystems } from '../systems.js';
import { createChildLogger } from '../utils/logger.js';
import type { LoginRateLimitedHandler } from './authMiddleware.js';
import { grantKey, RefreshGrantStore, type RefreshGrant, type StoredGrant } from './grantStore.js';
import { authAllowedDbHosts, authConnection, testCredentials, verifyLogin } from './login.js';
import { getTokenManager } from './tokenManager.js';

const log = createChildLogger({ component: 'oauth' });

/** How long an authorization code may wait for the token request. */
const CODE_TTL_MS = 60_000;
/** How long a rendered login page stays valid. */
const LOGIN_TTL_MS = 10 * 60_000;
/** Codes waiting for exchange, across all clients. */
const MAX_PENDING_CODES = 1000;
const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 2048;
const MAX_CLIENT_NAME_LENGTH = 100;
const MAX_SIGNED_VALUE_LENGTH = 16384;
/** Leaves room in the signed login request for the redirect URI and state. */
const MAX_CLIENT_ID_LENGTH = 4096;
/** Refresh grants one IBM i user profile may hold on one system, across all clients. */
const MAX_REFRESH_GRANTS_PER_USER = 10;
/** How long a redeemed code is remembered, so a replay can revoke what it issued. */
const USED_CODE_TTL_MS = LOGIN_TTL_MS;

const TOKEN_AUTH_METHODS = ['none', 'client_secret_basic', 'client_secret_post'] as const;
type TokenAuthMethod = (typeof TOKEN_AUTH_METHODS)[number];
const GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;

/** S256 challenge: base64url of a SHA-256 digest, no padding. */
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636 code verifier. */
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** Client metadata carried inside the signed client ID. */
interface RegisteredClient {
  v: 1;
  redirectUris: string[];
  name?: string;
  authMethod: TokenAuthMethod;
  grantTypes: string[];
  iat: number;
  /** Makes every registration distinct, so identical metadata never yields the same ID or secret. */
  nonce: string;
}

/** Authorization request carried by the login form. */
interface LoginRequest {
  clientId: string;
  redirectUri: string;
  redirectUriExplicit: boolean;
  codeChallenge: string;
  state?: string;
  exp: number;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  redirectUriExplicit: boolean;
  codeChallenge: string;
  system: string;
  config: DB2iConfig;
  expiresAt: number;
}

interface UsedCode {
  grantId: string;
  expiresAt: number;
}

const pendingCodes = new Map<string, PendingCode>();
/** Keyed by grantKey(refreshToken). Replaced by createOAuthRouter with the configured store. */
let refreshGrants = new RefreshGrantStore();
const usedCodes = new Map<string, UsedCode>();

/**
 * Drop pending codes and refresh tokens from memory. Used at shutdown and by
 * tests. A state file is left as it is, for the next start.
 */
export function resetOAuthState(): void {
  pendingCodes.clear();
  refreshGrants.clear();
  usedCodes.clear();
}

/** The IBM i user a grant belongs to: one user profile on one system. */
function userKey(system: string, config: DB2iConfig): string {
  return `${system}\n${config.username.toUpperCase()}`;
}

/**
 * Rebuild a stored refresh grant from the current profiles, the way a sign-in
 * would. Undefined when its system is gone or its host is no longer allowed.
 */
function restoreGrant(stored: StoredGrant): RefreshGrant | undefined {
  let connection: { system: string; config: DB2iConfig };
  try {
    connection = authConnection({ username: stored.username, password: stored.password, system: stored.system });
  } catch {
    return undefined;
  }
  const allowedDbHosts = authAllowedDbHosts();
  if (allowedDbHosts && !allowedDbHosts.includes(normalizeDbHost(connection.config.hostname))) {
    return undefined;
  }
  return {
    clientId: stored.clientId,
    grantId: stored.grantId,
    user: userKey(connection.system, connection.config),
    system: connection.system,
    config: connection.config,
    expiresAt: stored.expiresAt,
  };
}

/** End every access and refresh token issued from one sign-in. */
async function revokeGrant(grantId: string): Promise<void> {
  refreshGrants.deleteMany(
    refreshGrants.entries().filter(([, grant]) => grant.grantId === grantId).map(([key]) => key)
  );
  await getTokenManager().revokeGrant(grantId);
}

function sweepExpired(map: Map<string, { expiresAt: number }>, now: number): void {
  for (const [key, entry] of map) {
    if (entry.expiresAt <= now) {
      map.delete(key);
    }
  }
}

function randomToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function sha256(value: string): Buffer {
  return crypto.createHash('sha256').update(value).digest();
}

/** Compare two strings in constant time, whatever their lengths. */
function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function mac(secret: Buffer, purpose: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(`${purpose}.${body}`).digest('base64url');
}

/** Serialize a payload and sign it for one purpose, so a value signed for one use cannot pass as another. */
function sign(secret: Buffer, purpose: string, payload: object): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${mac(secret, purpose, body)}`;
}

/** Check a signed value and return its payload, or undefined when it was altered or signed for another purpose. */
function verifySigned(secret: Buffer, purpose: string, value: unknown): unknown {
  if (typeof value !== 'string' || value.length > MAX_SIGNED_VALUE_LENGTH) {
    return undefined;
  }
  const dot = value.lastIndexOf('.');
  if (dot <= 0) {
    return undefined;
  }
  const body = value.slice(0, dot);
  if (!safeEqual(value.slice(dot + 1), mac(secret, purpose, body))) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

/** The secret of a confidential client, derived from its ID. */
function clientSecretFor(oauth: OAuthConfig, clientId: string): string {
  return mac(oauth.secret, 'client-secret', clientId);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** Decode a client ID, or undefined when it was not issued by this server. */
function readClient(oauth: OAuthConfig, clientId: unknown): RegisteredClient | undefined {
  const payload = verifySigned(oauth.secret, 'client', clientId) as Partial<RegisteredClient> | undefined;
  if (
    !payload ||
    payload.v !== 1 ||
    !isStringArray(payload.redirectUris) ||
    !isStringArray(payload.grantTypes) ||
    !TOKEN_AUTH_METHODS.includes(payload.authMethod as TokenAuthMethod)
  ) {
    return undefined;
  }
  return payload as RegisteredClient;
}

/**
 * Whether a client may use a redirect URI: a loopback URL on any port, for
 * desktop clients, or an entry of MCP_OAUTH_REDIRECT_URIS.
 */
export function isRedirectUriAllowed(uri: string, allowlist: string[]): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) {
    return false;
  }
  if ((url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackHost(url.hostname)) {
    return true;
  }
  // Compare the normalized URL, so `..` segments cannot step outside a prefix
  const href = url.href;
  return allowlist.some((entry) => (entry.endsWith('*') ? href.startsWith(entry.slice(0, -1)) : href === entry));
}

/** RFC 8707: the resource must be this server, as the MCP URL or the bare origin. */
function isOwnResource(oauth: OAuthConfig, resource: string): boolean {
  const normalized = resource.replace(/\/+$/, '');
  return normalized === oauth.resource || normalized === oauth.publicUrl;
}

/** String fields of a query or form body. Repeated or non-string values are dropped. */
function stringParams(source: unknown): Record<string, string | undefined> {
  const params: Record<string, string | undefined> = {};
  if (source && typeof source === 'object') {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'string') {
        params[key] = value;
      }
    }
  }
  return params;
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

function oauthError(res: Response, status: number, error: string, description: string): void {
  noStore(res);
  res.status(status).json({ error, error_description: description });
}

function redirectWith(res: Response, status: 302 | 303, redirectUri: string, params: Record<string, string | undefined>): void {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }
  noStore(res);
  res.redirect(status, url.toString());
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Page logo: the route mark, cropped to the artwork. Ink follows the text color and the end node uses --accent. */
const LOGO_SVG =
  '<svg class="logo" xmlns="http://www.w3.org/2000/svg" viewBox="1.5 4 20.75 15.25" width="30" height="22" aria-hidden="true">' +
  LOGO_SHAPES +
  '</svg>';

/** The same logo as a favicon. */
const FAVICON_HREF = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`;

/*
 * Brand palette (docs/assets/brand, site/src/styles/tokens.css). The CSP allows no
 * fonts, so the page uses the system sans and mono stacks.
 */
const PAGE_STYLE = `
  :root { color-scheme: light dark; --bg: #f3f1eb; --surface: #faf9f6; --fg: #161716; --muted: #666962; --line: #d8d6cf; --accent: #3159e8; --on-accent: #fff; --error: #b42318;
    --sans: system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  @media (prefers-color-scheme: dark) { :root { --bg: #121312; --surface: #181918; --fg: #ecebe4; --muted: #9c9e97; --line: #2e302d; --accent: #7d97ff; --on-accent: #0d1330; --error: #f97066; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--fg); font: 15px/1.55 var(--sans); -webkit-font-smoothing: antialiased; }
  .page { min-height: 100vh; display: grid; }
  @media (min-width: 860px) { .page { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }
  .side { display: flex; flex-direction: column; gap: 28px; padding: 24px 20px; border-bottom: 1px solid var(--line); }
  @media (min-width: 860px) { .side { padding: 36px 56px; border-bottom: 0; border-right: 1px solid var(--line); } }
  .brand { display: flex; align-items: center; gap: 12px; }
  .logo { display: block; flex: none; color: var(--fg); }
  .brand-name { font: 500 11px/1.4 var(--mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
  .big { display: none; margin: auto 0 0; color: var(--fg); font-size: clamp(32px, 4.2vw, 52px); font-weight: 400; line-height: 1.02; letter-spacing: -0.04em; max-width: 12ch; }
  @media (min-width: 860px) { .big { display: block; } }
  .spec { margin: 0; font: 12.5px/1.3 var(--mono); }
  .spec div { display: grid; grid-template-columns: 110px 1fr; gap: 8px; padding: 9px 0; border-top: 1px solid var(--line); }
  .spec div:first-child { border-top-color: var(--fg); }
  .spec dt { color: var(--muted); letter-spacing: 0.06em; text-transform: uppercase; }
  .spec dd { margin: 0; overflow-wrap: anywhere; }
  .spec .on { color: var(--accent); }
  main { display: grid; align-content: center; padding: 32px 20px 40px; }
  @media (min-width: 860px) { main { padding: 56px; } }
  .panel { width: 100%; max-width: 400px; }
  h1 { font-size: 30px; font-weight: 400; letter-spacing: -0.03em; line-height: 1.1; margin: 0 0 12px; }
  p { margin: 0 0 20px; color: var(--muted); }
  strong { color: var(--fg); font-weight: 500; }
  label { display: block; font: 500 11px/1.4 var(--mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin: 18px 0 8px; }
  input, select { width: 100%; padding: 11px 12px; font: 15px/1.2 var(--mono); color: inherit; background: var(--surface); border: 1px solid var(--line); border-radius: 2px; }
  #username { text-transform: uppercase; }
  input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  button { width: 100%; margin-top: 26px; padding: 14px 16px; display: flex; justify-content: space-between; font: 500 15px/1 var(--sans); color: var(--on-accent); background: var(--accent); border: 0; border-radius: 3px; cursor: pointer; }
  button:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
  .error { color: var(--error); margin: 0 0 12px; }
  .note { font: 12px/1.5 var(--mono); margin: 20px 0 0; padding-top: 14px; border-top: 1px solid var(--line); }
`;

/** Server name shown next to the logo and in the tab title. The OAuth router sets it on every request. */
function pageBrand(res: Response): string {
  return typeof res.locals.pageBrand === 'string' ? res.locals.pageBrand : '';
}

/** Left column of a page: a large line of text and optional key/value rows. Values are escaped here. */
interface PageSide {
  heading: string;
  rows?: Array<{ key: string; value: string; on?: boolean }>;
}

function renderSide(side: PageSide): string {
  const rows = side.rows?.length
    ? `<dl class="spec">` +
      side.rows
        .map(
          (row) =>
            `<div><dt>${escapeHtml(row.key)}</dt><dd${row.on ? ' class="on"' : ''}>${escapeHtml(row.value)}</dd></div>`
        )
        .join('') +
      `</dl>`
    : '';
  return `<p class="big">${escapeHtml(side.heading)}</p>${rows}`;
}

function sendPage(res: Response, status: number, title: string, side: PageSide, body: string, formAction?: string): void {
  const brand = pageBrand(res);
  noStore(res);
  // Not no-referrer: with it, browsers send `Origin: null` on the form post and the
  // Origin check refuses it. same-origin still keeps the URL from the client's origin.
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      // Only the inline favicon
      'img-src data:',
      // A form post that answers with a redirect must be allowed to reach the client's origin
      `form-action 'self'${formAction ? ` ${formAction}` : ''}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join('; ')
  );
  res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<title>${escapeHtml(brand ? `${title} · ${brand}` : title)}</title>` +
        `<link rel="icon" type="image/svg+xml" href="${FAVICON_HREF}">` +
        `<style>${PAGE_STYLE}</style></head>` +
        `<body><div class="page"><aside class="side"><div class="brand">${LOGO_SVG}` +
        (brand ? `<span class="brand-name">${escapeHtml(brand)}</span>` : '') +
        `</div>${renderSide(side)}</aside>` +
        `<main><div class="panel">${body}</div></main></div></body></html>`
    );
}

function renderError(res: Response, status: number, message: string): void {
  sendPage(
    res,
    status,
    'Sign-in error',
    { heading: 'Sign-in could not continue.' },
    `<h1>Sign-in error</h1><p>${escapeHtml(message)}</p>`
  );
}

interface LoginPage {
  client: RegisteredClient;
  redirectUri: string;
  request: string;
  username?: string;
  system?: string;
  error?: string;
}

/** Whether a redirect goes to a web origin rather than an app's own URL scheme, such as cursor://. */
function isWebRedirect(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function renderLogin(res: Response, status: number, page: LoginPage): void {
  const redirect = new URL(page.redirectUri);
  const clientName = page.client.name ?? redirect.host;
  // An app scheme has no web origin (URL.origin is "null"), so name the scheme instead
  const returnTo = isWebRedirect(redirect) ? redirect.host : `${redirect.protocol}//${redirect.host}`;
  const formAction = isWebRedirect(redirect) ? redirect.origin : redirect.protocol;
  const systems = getSystems();
  const selected = page.system ?? defaultSystem().name;
  const systemField =
    systems.length > 1
      ? `<label for="system">System</label><select id="system" name="system">` +
        systems
          .map(
            (system) =>
              `<option value="${escapeHtml(system.name)}"${system.name === selected ? ' selected' : ''}>` +
              `${escapeHtml(system.name)}</option>`
          )
          .join('') +
        `</select>`
      : `<input type="hidden" name="system" value="${escapeHtml(systems[0].name)}">`;

  sendPage(
    res,
    status,
    'Sign in to IBM i',
    {
      heading: 'Sign in with your IBM i user profile.',
      rows: [
        { key: 'Client', value: clientName },
        { key: 'Returns to', value: returnTo },
        { key: 'Access', value: 'Read only', on: true },
      ],
    },
    `<h1>Sign in to IBM i</h1>` +
      `<p><strong>${escapeHtml(clientName)}</strong> wants to query IBM i with your user profile. ` +
      `After you sign in, you return to <strong>${escapeHtml(returnTo)}</strong>.</p>` +
      (page.error ? `<p class="error" role="alert">${escapeHtml(page.error)}</p>` : '') +
      `<form method="post" action="/oauth/authorize">` +
      `<input type="hidden" name="request" value="${escapeHtml(page.request)}">` +
      systemField +
      `<label for="username">User profile</label>` +
      `<input id="username" name="username" autocomplete="username" autocapitalize="characters" required maxlength="128" value="${escapeHtml(page.username ?? '')}">` +
      `<label for="password">Password</label>` +
      `<input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256">` +
      `<button type="submit"><span>Sign in</span><span aria-hidden="true">→</span></button>` +
      `</form>` +
      `<p class="note">Only continue if you started this connection yourself.</p>`,
    formAction
  );
}

/** A sign-in form post whose signed request and client have been checked. */
interface SignInForm {
  body: Record<string, string | undefined>;
  pending: LoginRequest;
  client: RegisteredClient;
  username: string;
  password: string;
  system?: string;
}

/** Render the sign-in page again for a form post, with an error and the entered user profile. */
function renderSignIn(res: Response, form: SignInForm, status: number, error: string): void {
  renderLogin(res, status, {
    client: form.client,
    redirectUri: form.pending.redirectUri,
    request: form.body.request as string,
    username: form.username,
    system: form.system,
    error,
  });
}

type ClientAuth = { ok: true; clientId: string; client: RegisteredClient } | { ok: false; basic: boolean; description: string };

/**
 * Authenticate the client of a token or revocation request:
 * HTTP Basic, client_secret in the body, or client_id alone for public clients.
 */
function authenticateClient(oauth: OAuthConfig, req: Request, body: Record<string, string | undefined>): ClientAuth {
  let clientId = body.client_id;
  let clientSecret = body.client_secret;
  const header = req.headers.authorization;
  const basic = typeof header === 'string' && /^basic /i.test(header);

  if (basic) {
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) {
      return { ok: false, basic, description: 'Malformed Basic credentials' };
    }
    try {
      clientId = decodeURIComponent(decoded.slice(0, colon));
      clientSecret = decodeURIComponent(decoded.slice(colon + 1));
    } catch {
      return { ok: false, basic, description: 'Malformed Basic credentials' };
    }
  }

  const client = clientId ? readClient(oauth, clientId) : undefined;
  if (!clientId || !client) {
    return { ok: false, basic, description: 'Unknown client. Register the client again.' };
  }
  if (client.authMethod !== 'none') {
    if (!clientSecret || !safeEqual(clientSecret, clientSecretFor(oauth, clientId))) {
      return { ok: false, basic, description: 'Client authentication failed' };
    }
  }
  return { ok: true, clientId, client };
}

/** The sign-in a token request continues: who signed in, where, and its grant ID. */
interface GrantContext {
  grantId: string;
  system: string;
  config: DB2iConfig;
}

/** Issue an access token, plus a refresh token when the client and settings allow it. */
function issueTokens(
  res: Response,
  oauth: OAuthConfig,
  maxRefreshGrants: number,
  auth: { clientId: string; client: RegisteredClient },
  grant: GrantContext
): void {
  let access: { token: string; expiresIn: number };
  try {
    access = getTokenManager().createSession(grant.config, undefined, grant.system, auth.clientId, grant.grantId);
  } catch (err) {
    if (err instanceof Error && err.message.includes('Maximum concurrent sessions')) {
      oauthError(res, 503, 'temporarily_unavailable', err.message);
      return;
    }
    throw err;
  }

  const body: Record<string, string | number> = {
    access_token: access.token,
    token_type: 'Bearer',
    expires_in: access.expiresIn,
  };

  if (oauth.refreshExpiry > 0 && auth.client.grantTypes.includes('refresh_token')) {
    const now = Date.now();
    refreshGrants.sweepExpired(now);
    // A user past their own cap loses their oldest grant. Other users' grants are never evicted.
    const user = userKey(grant.system, grant.config);
    const own = refreshGrants.entries().filter(([, entry]) => entry.user === user).map(([key]) => key);
    refreshGrants.deleteMany(own.slice(0, Math.max(0, own.length - MAX_REFRESH_GRANTS_PER_USER + 1)));
    if (refreshGrants.size >= maxRefreshGrants) {
      // The client keeps working until the access token expires, then signs in again
      log.warn({ grants: refreshGrants.size }, 'OAuth refresh grant store is full; issuing no refresh token');
    } else {
      const refreshToken = randomToken();
      refreshGrants.set(grantKey(refreshToken), {
        clientId: auth.clientId,
        grantId: grant.grantId,
        user,
        system: grant.system,
        config: grant.config,
        expiresAt: now + oauth.refreshExpiry * 1000,
      });
      body.refresh_token = refreshToken;
    }
  }

  noStore(res);
  res.json(body);
}

/** Rate limiters the OAuth router applies. */
export interface OAuthRouterLimits {
  /** Per-IP limit across all /oauth/* endpoints */
  requests: RequestHandler;
  /** Login limiter, the same instance POST /auth uses, so both share one budget */
  login: RequestHandler;
}

/**
 * Build the router for the OAuth metadata, registration, login and token endpoints.
 * Mount it only when MCP_OAUTH_ENABLED is on.
 *
 * @param oauth - OAuth settings from getHttpConfig()
 * @param resourceName - Server name for the protected resource metadata and the sign-in pages
 * @param limits - Rate limiters for the OAuth endpoints and the sign-in form
 */
export function createOAuthRouter(oauth: OAuthConfig, resourceName: string, limits: OAuthRouterLimits): Router {
  const router = express.Router();
  const form = express.urlencoded({ extended: false, limit: '32kb' });
  const issuer = oauth.publicUrl;
  // Refresh grants are bounded like access tokens
  const maxRefreshGrants = getHttpConfig().maxSessions;
  if (oauth.stateFile || refreshGrants.persistent) {
    // An in-memory store is kept, so building the router again does not sign anyone out
    refreshGrants = new RefreshGrantStore(oauth.stateFile, oauth.secret);
    refreshGrants.load(restoreGrant);
  }
  router.use('/oauth', limits.requests);
  router.use('/oauth', (_req: Request, res: Response, next: express.NextFunction) => {
    res.locals.pageBrand = resourceName;
    next();
  });

  router.get(
    ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'],
    (_req: Request, res: Response) => {
      res.json({
        resource: oauth.resource,
        authorization_servers: [issuer],
        bearer_methods_supported: ['header'],
        resource_name: resourceName,
      });
    }
  );

  router.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: oauth.refreshExpiry > 0 ? [...GRANT_TYPES] : ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: [...TOKEN_AUTH_METHODS],
      revocation_endpoint_auth_methods_supported: [...TOKEN_AUTH_METHODS],
      authorization_response_iss_parameter_supported: true,
    });
  });

  router.post('/oauth/register', (req: Request, res: Response) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

    const redirectUris = body.redirect_uris;
    if (!isStringArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS) {
      oauthError(res, 400, 'invalid_redirect_uri', `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URLs`);
      return;
    }
    const refused = redirectUris.find(
      (uri) => uri.length > MAX_REDIRECT_URI_LENGTH || !isRedirectUriAllowed(uri, oauth.redirectUris)
    );
    if (refused !== undefined) {
      log.warn({ redirectUriCount: redirectUris.length }, 'OAuth registration refused a redirect URI');
      oauthError(res, 400, 'invalid_redirect_uri', 'A redirect URI is not allowed by MCP_OAUTH_REDIRECT_URIS');
      return;
    }

    const authMethod = body.token_endpoint_auth_method ?? 'client_secret_basic';
    if (!TOKEN_AUTH_METHODS.includes(authMethod as TokenAuthMethod)) {
      oauthError(res, 400, 'invalid_client_metadata', `token_endpoint_auth_method must be one of: ${TOKEN_AUTH_METHODS.join(', ')}`);
      return;
    }

    const grantTypes = body.grant_types ?? [...GRANT_TYPES];
    if (!isStringArray(grantTypes) || !grantTypes.every((grant) => (GRANT_TYPES as readonly string[]).includes(grant))) {
      oauthError(res, 400, 'invalid_client_metadata', `grant_types may contain: ${GRANT_TYPES.join(', ')}`);
      return;
    }

    const responseTypes = body.response_types ?? ['code'];
    if (!isStringArray(responseTypes) || !responseTypes.every((type) => type === 'code')) {
      oauthError(res, 400, 'invalid_client_metadata', 'response_types may contain only code');
      return;
    }

    if (body.client_name !== undefined && typeof body.client_name !== 'string') {
      oauthError(res, 400, 'invalid_client_metadata', 'client_name must be a string');
      return;
    }
    const name = body.client_name?.trim().slice(0, MAX_CLIENT_NAME_LENGTH) || undefined;

    const client: RegisteredClient = {
      v: 1,
      redirectUris,
      name,
      authMethod: authMethod as TokenAuthMethod,
      grantTypes: [...new Set(grantTypes)],
      iat: Math.floor(Date.now() / 1000),
      nonce: crypto.randomBytes(12).toString('base64url'),
    };
    const clientId = sign(oauth.secret, 'client', client);
    if (clientId.length > MAX_CLIENT_ID_LENGTH) {
      oauthError(res, 400, 'invalid_client_metadata', 'The client metadata is too large. Register fewer or shorter redirect URIs.');
      return;
    }

    log.info({ client: name, redirectHosts: redirectUris.map((uri) => new URL(uri).host) }, 'OAuth client registered');
    noStore(res);
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: client.iat,
      ...(client.authMethod === 'none'
        ? {}
        : { client_secret: clientSecretFor(oauth, clientId), client_secret_expires_at: 0 }),
      redirect_uris: client.redirectUris,
      ...(name ? { client_name: name } : {}),
      token_endpoint_auth_method: client.authMethod,
      grant_types: client.grantTypes,
      response_types: ['code'],
    });
  });

  router.get('/oauth/authorize', (req: Request, res: Response) => {
    const params = stringParams(req.query);
    const clientId = params.client_id;
    const client = readClient(oauth, clientId);
    if (!clientId || !client) {
      renderError(res, 400, 'This client is not registered with this server. Remove the connector and add it again.');
      return;
    }

    const redirectUriExplicit = params.redirect_uri !== undefined;
    const redirectUri = params.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
    if (!redirectUri || !client.redirectUris.includes(redirectUri) || !isRedirectUriAllowed(redirectUri, oauth.redirectUris)) {
      renderError(res, 400, 'The redirect URI is not registered for this client.');
      return;
    }

    // From here on, errors go back to the client (RFC 6749 section 4.1.2.1)
    const fail = (error: string, description: string): void =>
      redirectWith(res, 302, redirectUri, { error, error_description: description, state: params.state, iss: issuer });

    if (params.response_type !== 'code') {
      fail('unsupported_response_type', 'response_type must be code');
      return;
    }
    if (params.code_challenge_method !== 'S256' || !params.code_challenge || !CODE_CHALLENGE.test(params.code_challenge)) {
      fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
      return;
    }
    if (params.resource !== undefined && !isOwnResource(oauth, params.resource)) {
      fail('invalid_target', `resource must be ${oauth.resource}`);
      return;
    }

    const loginRequest: LoginRequest = {
      clientId,
      redirectUri,
      redirectUriExplicit,
      codeChallenge: params.code_challenge,
      state: params.state,
      exp: Date.now() + LOGIN_TTL_MS,
    };
    const request = sign(oauth.secret, 'login', loginRequest);
    // The form post must carry the request back, and the check refuses longer values
    if (request.length > MAX_SIGNED_VALUE_LENGTH) {
      fail('invalid_request', 'The authorization request is too large. Use a shorter state.');
      return;
    }
    renderLogin(res, 200, { client, redirectUri, request });
  });

  // Sign-in: check the signed request first, so a rate-limited attempt can
  // still render the page; then count the attempt; then test the credentials.
  router.post(
    '/oauth/authorize',
    form,
    (req: Request, res: Response, next: express.NextFunction) => {
      const body = stringParams(req.body);
      const pending = verifySigned(oauth.secret, 'login', body.request) as LoginRequest | undefined;
      if (!pending || typeof pending.exp !== 'number' || pending.exp < Date.now()) {
        renderError(res, 400, 'This sign-in page has expired. Start the connection again from your client.');
        return;
      }
      const client = readClient(oauth, pending.clientId);
      if (!client || !client.redirectUris.includes(pending.redirectUri) || !isRedirectUriAllowed(pending.redirectUri, oauth.redirectUris)) {
        renderError(res, 400, 'This client is no longer allowed. Remove the connector and add it again.');
        return;
      }

      const form: SignInForm = {
        body,
        pending,
        client,
        username: (body.username ?? '').trim(),
        password: body.password ?? '',
        system: body.system?.trim() || undefined,
      };
      res.locals.signIn = form;
      const onRateLimited: LoginRateLimitedHandler = (retryAfter) =>
        renderSignIn(res, form, 429, `Too many sign-in attempts. Try again in ${retryAfter} seconds.`);
      res.locals.onLoginRateLimited = onRateLimited;

      if (!form.username || !form.password || form.username.length > 128 || form.password.length > 256) {
        renderSignIn(res, form, 400, 'Enter your user profile and password.');
        return;
      }
      next();
    },
    limits.login,
    async (_req: Request, res: Response) => {
      const { pending, client, username, password, system } = res.locals.signIn as SignInForm;
      const retry = (status: number, error: string): void => renderSignIn(res, res.locals.signIn as SignInForm, status, error);

      let login: Awaited<ReturnType<typeof verifyLogin>>;
      try {
        login = await verifyLogin({ username, password, system });
      } catch (err) {
        log.error({ err, user: username, system }, 'Unexpected error in OAuth sign-in');
        retry(500, 'Sign-in failed unexpectedly. Try again.');
        return;
      }
      if (!login.ok) {
        log.warn({ user: username, system, client: client.name, reason: login.description }, 'OAuth sign-in failed');
        // Driver errors can describe the host; the page only says what the user can fix
        retry(login.status, login.status === 400 ? login.description : 'Sign-in failed. Check the user profile and password.');
        return;
      }

      const now = Date.now();
      sweepExpired(pendingCodes, now);
      if (pendingCodes.size >= MAX_PENDING_CODES) {
        retry(503, 'Too many sign-ins are in progress. Try again shortly.');
        return;
      }
      const code = randomToken();
      pendingCodes.set(code, {
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        redirectUriExplicit: pending.redirectUriExplicit,
        codeChallenge: pending.codeChallenge,
        system: login.system,
        config: login.config,
        expiresAt: now + CODE_TTL_MS,
      });

      log.info({ user: login.config.username, system: login.system, client: client.name }, 'OAuth sign-in succeeded');
      redirectWith(res, 303, pending.redirectUri, { code, state: pending.state, iss: issuer });
    }
  );

  router.post('/oauth/token', form, async (req: Request, res: Response) => {
    try {
      const body = stringParams(req.body);
      const auth = authenticateClient(oauth, req, body);
      if (!auth.ok) {
        if (auth.basic) {
          res.setHeader('WWW-Authenticate', 'Basic realm="oauth"');
        }
        oauthError(res, 401, 'invalid_client', auth.description);
        return;
      }
      if (body.resource !== undefined && !isOwnResource(oauth, body.resource)) {
        oauthError(res, 400, 'invalid_target', `resource must be ${oauth.resource}`);
        return;
      }

      if (body.grant_type === 'authorization_code') {
        const code = body.code;
        const pending = code ? pendingCodes.get(code) : undefined;
        if (code) {
          // Single use: a replayed code finds nothing
          pendingCodes.delete(code);
          const used = usedCodes.get(code);
          if (used) {
            // RFC 6749 section 4.1.2: a code used twice may be stolen, so end what it issued
            usedCodes.delete(code);
            if (used.expiresAt > Date.now()) {
              log.warn({ client: auth.client.name }, 'OAuth authorization code replayed; revoking its tokens');
              await revokeGrant(used.grantId);
            }
          }
        }
        if (!pending || pending.expiresAt <= Date.now() || pending.clientId !== auth.clientId) {
          oauthError(res, 400, 'invalid_grant', 'The authorization code is invalid or expired');
          return;
        }
        const redirectMatches =
          body.redirect_uri === undefined ? !pending.redirectUriExplicit : body.redirect_uri === pending.redirectUri;
        if (!redirectMatches) {
          oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match the authorization request');
          return;
        }
        const verifier = body.code_verifier;
        if (
          !verifier ||
          !CODE_VERIFIER.test(verifier) ||
          !safeEqual(sha256(verifier).toString('base64url'), pending.codeChallenge)
        ) {
          oauthError(res, 400, 'invalid_grant', 'code_verifier does not match the code challenge');
          return;
        }
        const grantId = randomToken();
        const now = Date.now();
        sweepExpired(usedCodes, now);
        for (const key of usedCodes.keys()) {
          if (usedCodes.size < MAX_PENDING_CODES) break;
          usedCodes.delete(key);
        }
        usedCodes.set(code as string, { grantId, expiresAt: now + USED_CODE_TTL_MS });
        issueTokens(res, oauth, maxRefreshGrants, auth, { grantId, system: pending.system, config: pending.config });
        return;
      }

      if (body.grant_type === 'refresh_token' && oauth.refreshExpiry > 0) {
        const refreshToken = body.refresh_token;
        const key = refreshToken ? grantKey(refreshToken) : undefined;
        const grant = key ? refreshGrants.get(key) : undefined;
        // Another client presenting the token does not use it up
        if (!key || !grant || grant.clientId !== auth.clientId) {
          oauthError(res, 400, 'invalid_grant', 'The refresh token is invalid or expired');
          return;
        }
        // Rotation: every refresh token works once, and a parallel request finds nothing
        refreshGrants.delete(key);
        if (grant.expiresAt <= Date.now()) {
          oauthError(res, 400, 'invalid_grant', 'The refresh token is invalid or expired');
          return;
        }
        const failure = await testCredentials(grant.system, grant.config);
        if (failure !== null) {
          if (failure.transient) {
            // The IBM i was not reached, so the credentials were never judged: keep the grant
            refreshGrants.set(key, grant);
            log.warn({ user: grant.config.username, system: grant.system, reason: failure.reason }, 'OAuth refresh deferred');
            res.setHeader('Retry-After', '30');
            oauthError(res, 503, 'temporarily_unavailable', 'The IBM i could not be reached. Try again shortly.');
            return;
          }
          // A disabled profile or a changed password ends the grant and its access tokens
          log.warn({ user: grant.config.username, system: grant.system, reason: failure.reason }, 'OAuth refresh refused');
          await revokeGrant(grant.grantId);
          oauthError(res, 400, 'invalid_grant', 'The IBM i credentials are no longer accepted. Sign in again.');
          return;
        }
        issueTokens(res, oauth, maxRefreshGrants, auth, grant);
        return;
      }

      oauthError(res, 400, 'unsupported_grant_type', 'grant_type is not supported');
    } catch (err) {
      log.error({ err }, 'Unexpected error in OAuth token handler');
      oauthError(res, 500, 'server_error', 'An unexpected error occurred');
    }
  });

  router.post('/oauth/revoke', form, async (req: Request, res: Response) => {
    try {
      const body = stringParams(req.body);
      const auth = authenticateClient(oauth, req, body);
      if (!auth.ok) {
        oauthError(res, 401, 'invalid_client', auth.description);
        return;
      }
      const token = body.token;
      if (token) {
        // Either kind of token ends the whole sign-in: its refresh token and every access token
        const grant = refreshGrants.get(grantKey(token));
        const session = grant ? undefined : getTokenManager().getSession(token);
        const owner = grant ?? session;
        if (owner?.clientId === auth.clientId) {
          if (owner.grantId) {
            await revokeGrant(owner.grantId);
          } else {
            await getTokenManager().revokeToken(token);
          }
        }
      }
      // RFC 7009: the answer is the same whether or not the token was known
      noStore(res);
      res.status(200).end();
    } catch (err) {
      log.error({ err }, 'Unexpected error in OAuth revocation handler');
      oauthError(res, 500, 'server_error', 'An unexpected error occurred');
    }
  });

  return router;
}
