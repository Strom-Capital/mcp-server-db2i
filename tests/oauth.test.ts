/**
 * Built-in OAuth 2.1 authorization server: metadata, registration, IBM i
 * login page, code exchange with PKCE, refresh rotation and revocation.
 */

import crypto from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';

// A password of "wrong" fails the test connection; anything else logs in
vi.mock('node-jt400', () => ({
  pool: vi.fn((config: { password: string }) => ({
    query: config.password === 'wrong'
      ? vi.fn().mockRejectedValue(new Error('SQL30082 password incorrect on ibmi.example.com'))
      : vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { createHttpApp } from '../src/transports/http.js';
import { getTokenManager } from '../src/auth/tokenManager.js';
import { resetAuthRateLimits } from '../src/auth/authMiddleware.js';
import { isRedirectUriAllowed, resetOAuthState } from '../src/auth/oauth.js';
import { isTransientConnectionError } from '../src/auth/login.js';
import { getOAuthConfig } from '../src/config.js';
import { resetSystems } from '../src/systems.js';

const PROFILES = `
profiles:
  - name: prod
    host: ibmi.example.com
    driver: jt400
    username: SVCUSER
    password: \${SVC_PASSWORD}
    schema: MYLIB
  - name: test
    host: ibmi.example.com
    driver: jt400
    username: SVCUSER
    password: \${SVC_PASSWORD}
    schema: OTHERLIB
`;

const PUBLIC_URL = 'https://mcp.example.com';
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

async function listen(app: Express): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function hiddenRequest(html: string): string {
  const match = html.match(/name="request" value="([^"]+)"/);
  if (!match) throw new Error('login form has no request field');
  return match[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

describe('OAuth authorization server', () => {
  const originalEnv = process.env;
  let dir: string;
  let server: http.Server;
  let baseUrl: string;

  async function restart(): Promise<void> {
    await closeServer(server);
    ({ server, baseUrl } = await listen(createHttpApp()));
  }

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'db2i-oauth-'));
    const file = path.join(dir, 'profiles.yaml');
    writeFileSync(file, PROFILES);
    process.env = {
      ...originalEnv,
      MCP_AUTH_MODE: 'required',
      MCP_SESSION_MODE: 'stateless',
      MCP_OAUTH_ENABLED: 'true',
      MCP_PUBLIC_URL: PUBLIC_URL,
      MCP_OAUTH_SECRET: 'x'.repeat(40),
      DB2I_PROFILES: file,
      SVC_PASSWORD: 'svcpass',
    };
    delete process.env.DB2I_HOSTNAME;
    delete process.env.MCP_AUTH_ALLOWED_DB_HOSTS;
    delete process.env.MCP_OAUTH_REDIRECT_URIS;
    delete process.env.MCP_OAUTH_REFRESH_EXPIRY;
    resetSystems();
    resetOAuthState();
    await resetAuthRateLimits();
    ({ server, baseUrl } = await listen(createHttpApp()));
  });

  afterEach(async () => {
    await closeServer(server);
    await getTokenManager().shutdown();
    resetOAuthState();
    resetSystems();
    process.env = originalEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  async function register(body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [CLAUDE_CALLBACK],
        client_name: 'Claude',
        token_endpoint_auth_method: 'none',
        ...body,
      }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as Record<string, unknown>;
  }

  function authorizeUrl(clientId: string, challenge: string, extra: Record<string, string> = {}): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: CLAUDE_CALLBACK,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'st-123',
      resource: `${PUBLIC_URL}/mcp`,
      ...extra,
    });
    return `${baseUrl}/oauth/authorize?${params}`;
  }

  function postLogin(request: string, fields: Record<string, string>): Promise<Response> {
    return fetch(`${baseUrl}/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ request, ...fields }),
      redirect: 'manual',
    });
  }

  function postToken(fields: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(fields),
    });
  }

  /** Exchange a code for tokens. */
  async function exchange(clientId: string, code: string, verifier: string): Promise<{ access_token: string; refresh_token: string }> {
    const res = await postToken({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CLAUDE_CALLBACK });
    expect(res.status).toBe(200);
    return (await res.json()) as { access_token: string; refresh_token: string };
  }

  function revoke(clientId: string, token: string): Promise<Response> {
    return fetch(`${baseUrl}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, client_id: clientId }),
    });
  }

  /** Make the next test connection fail with this error. */
  async function failNextConnection(message: string): Promise<void> {
    const { pool } = await import('node-jt400');
    vi.mocked(pool).mockImplementationOnce(() => ({
      query: vi.fn().mockRejectedValue(new Error(message)),
      close: vi.fn().mockResolvedValue(undefined),
    }) as never);
  }

  /** Register, sign in, and return the code plus what the token request needs. */
  async function signIn(
    fields: Record<string, string> = { username: 'CALLER', password: 'callerpass', system: 'test' },
    registration: Record<string, unknown> = {}
  ): Promise<{ clientId: string; clientSecret?: string; code: string; verifier: string }> {
    const client = await register(registration);
    const clientId = client.client_id as string;
    const { verifier, challenge } = pkce();
    const page = await fetch(authorizeUrl(clientId, challenge));
    expect(page.status).toBe(200);
    const res = await postLogin(hiddenRequest(await page.text()), fields);
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get('location') as string);
    expect(`${location.origin}${location.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(location.searchParams.get('state')).toBe('st-123');
    expect(location.searchParams.get('iss')).toBe(PUBLIC_URL);
    return {
      clientId,
      clientSecret: client.client_secret as string | undefined,
      code: location.searchParams.get('code') as string,
      verifier,
    };
  }

  it('publishes protected resource and authorization server metadata', async () => {
    const prm = await (await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm).toMatchObject({ resource: `${PUBLIC_URL}/mcp`, authorization_servers: [PUBLIC_URL] });

    const as = await (await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).json();
    expect(as).toMatchObject({
      issuer: PUBLIC_URL,
      authorization_endpoint: `${PUBLIC_URL}/oauth/authorize`,
      token_endpoint: `${PUBLIC_URL}/oauth/token`,
      registration_endpoint: `${PUBLIC_URL}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
    });
  });

  it('challenges /mcp with the resource metadata URL', async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`
    );

    const bad = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
      body: '{}',
    });
    expect(bad.headers.get('www-authenticate')).toMatch(/error="invalid_token"/);
  });

  it('serves the project icon without authentication', async () => {
    for (const [path, type] of [
      ['/favicon.ico', 'image/x-icon'],
      ['/favicon.svg', 'image/svg+xml'],
      ['/icon.png', 'image/png'],
      ['/icon.svg', 'image/svg+xml'],
    ]) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain(type);
      expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
    }
  });

  it('accepts the public hostname in the Host allowlist', async () => {
    const res = await new Promise<number>((resolve, reject) => {
      const url = new URL(`${baseUrl}/.well-known/oauth-authorization-server`);
      http
        .get({ host: url.hostname, port: url.port, path: url.pathname, headers: { Host: 'mcp.example.com' } }, (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        })
        .on('error', reject);
    });
    expect(res).toBe(200);
  });

  it('refuses redirect URIs outside the allowlist at registration', async () => {
    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://attacker.example.net/callback'] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_redirect_uri');
  });

  it('allows loopback redirects and configured prefixes', () => {
    const allowlist = ['https://app.example.com/oauth/*', CLAUDE_CALLBACK];
    expect(isRedirectUriAllowed('http://localhost:53682/callback', allowlist)).toBe(true);
    expect(isRedirectUriAllowed('http://127.0.0.1:9/cb', allowlist)).toBe(true);
    expect(isRedirectUriAllowed('https://app.example.com/oauth/done', allowlist)).toBe(true);
    expect(isRedirectUriAllowed(CLAUDE_CALLBACK, allowlist)).toBe(true);
    expect(isRedirectUriAllowed(`${CLAUDE_CALLBACK}/extra`, allowlist)).toBe(false);
    expect(isRedirectUriAllowed('https://app.example.com/other', allowlist)).toBe(false);
    expect(isRedirectUriAllowed('https://app.example.com/oauth/../evil', allowlist)).toBe(false);
    expect(isRedirectUriAllowed('https://claude.ai/api/mcp/auth_callback#frag', allowlist)).toBe(false);
    expect(isRedirectUriAllowed('not a url', allowlist)).toBe(false);
  });

  it('issues a distinct client ID and secret for identical metadata', async () => {
    const a = await register({ token_endpoint_auth_method: 'client_secret_post' });
    const b = await register({ token_endpoint_auth_method: 'client_secret_post' });
    expect(a.client_id).not.toBe(b.client_id);
    expect(a.client_secret).not.toBe(b.client_secret);
  });

  it('rejects a tampered client ID', async () => {
    const client = await register();
    const tampered = `${(client.client_id as string).slice(0, -2)}AA`;
    const res = await fetch(authorizeUrl(tampered, pkce().challenge));
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/not registered/);
  });

  it('renders a login page with a strict CSP and the profiles to choose from', async () => {
    const client = await register();
    const res = await fetch(authorizeUrl(client.client_id as string, pkce().challenge));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self' https://claude.ai");
    expect(csp).toContain('img-src data:');
    // no-referrer would make browsers post the form with `Origin: null`, which the Origin check refuses
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    const html = await res.text();
    expect(html).toContain('<svg class="logo"');
    expect(html).toContain('<span class="brand-name">mcp-server-db2i</span>');
    expect(html).toContain('<title>Sign in to IBM i · mcp-server-db2i</title>');
    expect(html).toContain('rel="icon" type="image/svg+xml" href="data:image/svg+xml,');
    expect(html).toContain('<option value="prod" selected>prod</option>');
    expect(html).toContain('<option value="test">test</option>');
    expect(html).toContain('<strong>Claude</strong>');
  });

  it('sends PKCE and response type errors back to the client', async () => {
    const client = await register();
    const noPkce = await fetch(authorizeUrl(client.client_id as string, pkce().challenge, { code_challenge_method: 'plain' }), {
      redirect: 'manual',
    });
    expect(noPkce.status).toBe(302);
    const location = new URL(noPkce.headers.get('location') as string);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('state')).toBe('st-123');

    const wrongResource = await fetch(
      authorizeUrl(client.client_id as string, pkce().challenge, { resource: 'https://other.example.com/mcp' }),
      { redirect: 'manual' }
    );
    expect(new URL(wrongResource.headers.get('location') as string).searchParams.get('error')).toBe('invalid_target');
  });

  it('signs in with the caller’s IBM i credentials and binds the token to the chosen profile', async () => {
    const { clientId, code, verifier } = await signIn();
    const res = await postToken({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: CLAUDE_CALLBACK,
      resource: `${PUBLIC_URL}/mcp`,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { access_token: string; refresh_token: string; token_type: string };
    expect(body.token_type).toBe('Bearer');
    expect(body.refresh_token).toBeTruthy();

    const session = getTokenManager().validateToken(body.access_token).session;
    expect(session?.system).toBe('test');
    expect(session?.config.username).toBe('CALLER');
    expect(session?.config.password).toBe('callerpass');
    expect(session?.config.schema).toBe('OTHERLIB');
    expect(session?.clientId).toBe(clientId);
  });

  it('shows a generic error for a wrong password and keeps the user on the page', async () => {
    const client = await register();
    const page = await fetch(authorizeUrl(client.client_id as string, pkce().challenge));
    const res = await postLogin(hiddenRequest(await page.text()), { username: 'CALLER', password: 'wrong', system: 'prod' });
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain('Sign-in failed. Check the user profile and password.');
    expect(html).not.toContain('SQL30082');
    expect(html).not.toContain('wrong');
    expect(html).toContain('value="CALLER"');
  });

  it('rate limits the login form', async () => {
    const client = await register();
    const page = await fetch(authorizeUrl(client.client_id as string, pkce().challenge));
    const request = hiddenRequest(await page.text());
    let last = 0;
    for (let i = 0; i < 6; i++) {
      last = (await postLogin(request, { username: 'CALLER', password: 'wrong', system: 'prod' })).status;
    }
    expect(last).toBe(429);
  });

  it('accepts a same-origin form post', async () => {
    const client = await register();
    const page = await fetch(authorizeUrl(client.client_id as string, pkce().challenge));
    const res = await fetch(`${baseUrl}/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: baseUrl },
      body: new URLSearchParams({ request: hiddenRequest(await page.text()), username: 'CALLER', password: 'callerpass', system: 'test' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
  });

  it('does not let a successful sign-in reset earlier failures', async () => {
    const client = await register();
    const page = await fetch(authorizeUrl(client.client_id as string, pkce().challenge));
    const request = hiddenRequest(await page.text());
    for (let i = 0; i < 4; i++) {
      expect((await postLogin(request, { username: 'VICTIM', password: 'wrong', system: 'prod' })).status).toBe(401);
    }
    expect((await postLogin(request, { username: 'CALLER', password: 'callerpass', system: 'prod' })).status).toBe(303);
    expect((await postLogin(request, { username: 'VICTIM', password: 'wrong', system: 'prod' })).status).toBe(401);
    expect((await postLogin(request, { username: 'VICTIM', password: 'wrong', system: 'prod' })).status).toBe(429);
  });

  it('shares the configured login limit between the sign-in form and /auth', async () => {
    process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS = '2';
    await restart();
    const client = await register();
    const page = await fetch(authorizeUrl(client.client_id as string, pkce().challenge));
    const request = hiddenRequest(await page.text());
    expect((await postLogin(request, { username: 'CALLER', password: 'wrong', system: 'prod' })).status).toBe(401);
    expect((await postLogin(request, { username: 'CALLER', password: 'wrong', system: 'prod' })).status).toBe(401);

    // The third attempt goes to /auth and finds the budget already spent
    const auth = await fetch(`${baseUrl}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'CALLER', password: 'wrong', system: 'prod' }),
    });
    expect(auth.status).toBe(429);
  });

  it('refuses registrations whose client ID would be too long to use', async () => {
    const uris = Array.from({ length: 10 }, (_, i) => `http://127.0.0.1:${9000 + i}/${'a'.repeat(2000)}`);
    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: uris, token_endpoint_auth_method: 'none' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_client_metadata');
  });

  it('sends an oversized state back to the client instead of rendering a form that cannot work', async () => {
    const client = await register();
    const res = await fetch(authorizeUrl(client.client_id as string, pkce().challenge, { state: 'x'.repeat(13000) }), {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location') as string).searchParams.get('error')).toBe('invalid_request');
  });

  it('challenges only failed requests', async () => {
    const { clientId, code, verifier } = await signIn();
    const tokens = await exchange(clientId, code, verifier);
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.access_token}` },
      body: '{}',
    });
    expect(res.status).not.toBe(401);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it('signs Cursor in through its cursor:// callback', async () => {
    const CURSOR_CALLBACK = 'cursor://anysphere.cursor-mcp/oauth/callback';
    const client = await register({ redirect_uris: [CURSOR_CALLBACK], client_name: 'Cursor' });
    const { verifier, challenge } = pkce();
    const page = await fetch(authorizeUrl(client.client_id as string, challenge, { redirect_uri: CURSOR_CALLBACK }));
    expect(page.status).toBe(200);
    // URL.origin is "null" for an app scheme, which is not a valid CSP source: allow the scheme
    const csp = page.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("form-action 'self' cursor:");
    expect(csp).not.toContain('null');
    const html = await page.text();
    expect(html).toContain('you return to <strong>cursor://anysphere.cursor-mcp</strong>');

    const res = await postLogin(hiddenRequest(html), { username: 'CALLER', password: 'callerpass', system: 'test' });
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get('location') as string);
    expect(`${location.protocol}//${location.host}${location.pathname}`).toBe(CURSOR_CALLBACK);
    const tokens = await postToken({
      grant_type: 'authorization_code',
      code: location.searchParams.get('code') as string,
      code_verifier: verifier,
      client_id: client.client_id as string,
      redirect_uri: CURSOR_CALLBACK,
    });
    expect(tokens.status).toBe(200);
  });

  it('refuses other app schemes unless configured', async () => {
    const res = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['otherapp://callback'] }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses a forged or expired login request', async () => {
    const res = await postLogin('eyJ4IjoxfQ.bad', { username: 'CALLER', password: 'callerpass' });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/expired/);
  });

  it('uses each code once and checks the verifier and client', async () => {
    const { clientId, code, verifier } = await signIn();
    const wrongVerifier = await postToken({
      grant_type: 'authorization_code', code, code_verifier: pkce().verifier, client_id: clientId, redirect_uri: CLAUDE_CALLBACK,
    });
    expect(wrongVerifier.status).toBe(400);
    expect((await wrongVerifier.json()).error).toBe('invalid_grant');

    // The failed attempt used the code up
    const replay = await postToken({
      grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CLAUDE_CALLBACK,
    });
    expect(replay.status).toBe(400);

    const other = await signIn();
    const otherClient = await register();
    const wrongClient = await postToken({
      grant_type: 'authorization_code',
      code: other.code,
      code_verifier: other.verifier,
      client_id: otherClient.client_id as string,
      redirect_uri: CLAUDE_CALLBACK,
    });
    expect(wrongClient.status).toBe(400);
  });

  it('revokes the tokens of a replayed code', async () => {
    const { clientId, code, verifier } = await signIn();
    const tokens = await exchange(clientId, code, verifier);

    const replay = await postToken({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CLAUDE_CALLBACK });
    expect(replay.status).toBe(400);
    expect(getTokenManager().validateToken(tokens.access_token).valid).toBe(false);
    const refresh = await postToken({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
    expect(refresh.status).toBe(400);
  });

  it('requires the secret of a confidential client', async () => {
    const { clientId, clientSecret, code, verifier } = await signIn(undefined, { token_endpoint_auth_method: 'client_secret_basic' });
    expect(clientSecret).toBeTruthy();
    const fields = { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CLAUDE_CALLBACK };

    const noSecret = await postToken({ ...fields, client_id: clientId });
    expect(noSecret.status).toBe(401);
    expect((await noSecret.json()).error).toBe('invalid_client');

    const basic = Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret as string)}`).toString('base64');
    // The failed attempt did not consume the code: client authentication runs first
    const ok = await postToken(fields, { Authorization: `Basic ${basic}` });
    expect(ok.status).toBe(200);
  });

  it('rotates refresh tokens and re-checks the credentials', async () => {
    const { clientId, code, verifier } = await signIn();
    const first = (await (
      await postToken({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CLAUDE_CALLBACK })
    ).json()) as { refresh_token: string };

    const refreshed = await postToken({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId });
    expect(refreshed.status).toBe(200);
    const second = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(getTokenManager().validateToken(second.access_token).session?.system).toBe('test');

    const reused = await postToken({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId });
    expect(reused.status).toBe(400);
    expect((await reused.json()).error).toBe('invalid_grant');
  });

  it('ends a refresh grant when the IBM i password no longer works', async () => {
    const { clientId, code, verifier } = await signIn();
    const tokens = (await (
      await postToken({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CLAUDE_CALLBACK })
    ).json()) as { access_token: string; refresh_token: string };

    // Simulate a password change on the IBM i
    const session = getTokenManager().getSession(tokens.access_token);
    expect(session).toBeDefined();
    const { pool } = await import('node-jt400');
    vi.mocked(pool).mockImplementationOnce(() => ({
      query: vi.fn().mockRejectedValue(new Error('password expired')),
      close: vi.fn().mockResolvedValue(undefined),
    }) as never);

    const res = await postToken({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
    expect(res.status).toBe(400);
    expect((await res.json()).error_description).toMatch(/Sign in again/);
  });

  it('keeps the refresh grant when the IBM i cannot be reached', async () => {
    const { clientId, code, verifier } = await signIn();
    const tokens = await exchange(clientId, code, verifier);

    await failNextConnection('connect ECONNREFUSED 192.0.2.1:8471');
    const down = await postToken({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
    expect(down.status).toBe(503);
    expect((await down.json()).error).toBe('temporarily_unavailable');

    const up = await postToken({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
    expect(up.status).toBe(200);
  });

  it('does not let another client use up a refresh token', async () => {
    const { clientId, code, verifier } = await signIn();
    const tokens = await exchange(clientId, code, verifier);
    const stranger = await register();

    const stolen = await postToken({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: stranger.client_id as string });
    expect(stolen.status).toBe(400);
    const own = await postToken({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
    expect(own.status).toBe(200);
  });

  it('caps refresh grants per user without touching other users', async () => {
    const other = await signIn({ username: 'OTHER', password: 'otherpass', system: 'test' });
    const otherTokens = await exchange(other.clientId, other.code, other.verifier);

    const grants: Array<{ clientId: string; refresh: string }> = [];
    for (let i = 0; i < 11; i++) {
      const { clientId, code, verifier } = await signIn();
      grants.push({ clientId, refresh: (await exchange(clientId, code, verifier)).refresh_token });
    }

    const oldest = await postToken({ grant_type: 'refresh_token', refresh_token: grants[0].refresh, client_id: grants[0].clientId });
    expect(oldest.status).toBe(400);
    const newest = await postToken({ grant_type: 'refresh_token', refresh_token: grants[10].refresh, client_id: grants[10].clientId });
    expect(newest.status).toBe(200);
    const untouched = await postToken({ grant_type: 'refresh_token', refresh_token: otherTokens.refresh_token, client_id: other.clientId });
    expect(untouched.status).toBe(200);
  });

  it('ends the refresh token when its access token is revoked', async () => {
    const { clientId, code, verifier } = await signIn();
    const tokens = await exchange(clientId, code, verifier);
    expect((await revoke(clientId, tokens.access_token)).status).toBe(200);
    const refresh = await postToken({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
    expect(refresh.status).toBe(400);
  });

  it('ends the access tokens when their refresh token is revoked', async () => {
    const { clientId, code, verifier } = await signIn();
    const tokens = await exchange(clientId, code, verifier);
    expect((await revoke(clientId, tokens.refresh_token)).status).toBe(200);
    expect(getTokenManager().validateToken(tokens.access_token).valid).toBe(false);
  });

  it('revokes only tokens of the calling client', async () => {
    const { clientId, code, verifier } = await signIn();
    const tokens = (await (
      await postToken({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CLAUDE_CALLBACK })
    ).json()) as { access_token: string; refresh_token: string };

    const stranger = await register();
    const revokeAs = (id: string, token: string): Promise<Response> =>
      fetch(`${baseUrl}/oauth/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, client_id: id }),
      });

    expect((await revokeAs(stranger.client_id as string, tokens.access_token)).status).toBe(200);
    expect(getTokenManager().validateToken(tokens.access_token).valid).toBe(true);

    expect((await revokeAs(clientId, tokens.access_token)).status).toBe(200);
    expect(getTokenManager().validateToken(tokens.access_token).valid).toBe(false);

    expect((await revokeAs(clientId, tokens.refresh_token)).status).toBe(200);
    const refresh = await postToken({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
    expect(refresh.status).toBe(400);
  });

  it('limits requests per IP across the OAuth endpoints', async () => {
    let last = 0;
    for (let i = 0; i < 121; i++) {
      last = (await fetch(`${baseUrl}/oauth/revoke`, { method: 'POST' })).status;
    }
    expect(last).toBe(429);
    // Metadata stays reachable
    expect((await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).status).toBe(200);
  });

  it('uses the configured OAuth request limit', async () => {
    process.env.OAUTH_RATE_LIMIT_MAX_REQUESTS = '3';
    process.env.OAUTH_RATE_LIMIT_WINDOW_MS = '120000';
    await restart();
    for (let i = 0; i < 3; i++) {
      expect((await fetch(`${baseUrl}/oauth/revoke`, { method: 'POST' })).status).not.toBe(429);
    }
    const limited = await fetch(`${baseUrl}/oauth/revoke`, { method: 'POST' });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(60);
  });

  it('keeps client registrations across a restart when the secret is set', async () => {
    const client = await register();
    await restart();
    const res = await fetch(authorizeUrl(client.client_id as string, pkce().challenge));
    expect(res.status).toBe(200);
  });

  it('is off unless enabled, and leaves the routes unmounted', async () => {
    delete process.env.MCP_OAUTH_ENABLED;
    await restart();
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(404);
    const mcp = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(mcp.headers.get('www-authenticate')).toBeNull();
  });
});

describe('isTransientConnectionError', () => {
  it('treats network failures as transient', () => {
    expect(isTransientConnectionError(new Error('connect ECONNREFUSED 192.0.2.1:8471'))).toBe(true);
    expect(isTransientConnectionError(Object.assign(new Error('socket failed'), { code: 'ETIMEDOUT' }))).toBe(true);
    expect(isTransientConnectionError(new Error('Connection timed out'))).toBe(true);
  });

  it('recognizes the driver messages for an unreachable IBM i', () => {
    // ODBC: host servers not listening, and a name that does not resolve
    expect(isTransientConnectionError(new Error(
      '[08004] [IBM][System i Access ODBC Driver]Communication link failure. comm rc=10061 - CWBCO1049 - The IBM i server application  is not started, or the connection was blocked by a firewall'
    ))).toBe(true);
    expect(isTransientConnectionError(new Error(
      '[08S01] [IBM][System i Access ODBC Driver]Communication link failure. comm rc=11001 - CWBCO1004 - Remote address could not be resolved'
    ))).toBe(true);
    // JT400: the same two cases
    expect(isTransientConnectionError(new Error('The application requester cannot establish the connection. (Connection refused)'))).toBe(true);
    expect(isTransientConnectionError(new Error('The application requester cannot establish the connection. (ibmi.example.com)'))).toBe(true);
  });

  it('treats the drivers\' wrong-password messages as a refusal', () => {
    expect(isTransientConnectionError(new Error(
      '[28000] [IBM][System i Access ODBC Driver]Communication link failure. comm rc=8002 - CWBSY0002 - Password for user CALLER on system ibmi.example.com is not correct'
    ))).toBe(false);
    expect(isTransientConnectionError(new Error('The application server rejected the connection. (Password length is not valid.)'))).toBe(false);
  });

  it('treats credential errors and anything unknown as a refusal', () => {
    expect(isTransientConnectionError(new Error('SQL30082 password incorrect'))).toBe(false);
    expect(isTransientConnectionError(new Error('Communication link failure. comm rc=8015 - CWBSY0002 - Password for user CALLER is not correct'))).toBe(false);
    expect(isTransientConnectionError(new Error('User profile CALLER is disabled; connection reset'))).toBe(false);
    expect(isTransientConnectionError(new Error('something odd'))).toBe(false);
  });
});

describe('getOAuthConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, MCP_OAUTH_ENABLED: 'true', MCP_PUBLIC_URL: 'https://mcp.example.com' };
    delete process.env.MCP_OAUTH_SECRET;
    delete process.env.MCP_OAUTH_REDIRECT_URIS;
    delete process.env.MCP_OAUTH_REFRESH_EXPIRY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns null when disabled', () => {
    delete process.env.MCP_OAUTH_ENABLED;
    expect(getOAuthConfig('required')).toBeNull();
  });

  it('needs required auth mode and a public URL', () => {
    expect(() => getOAuthConfig('token')).toThrow(/MCP_AUTH_MODE=required/);
    delete process.env.MCP_PUBLIC_URL;
    expect(() => getOAuthConfig('required')).toThrow(/MCP_PUBLIC_URL is required/);
  });

  it('needs https except on loopback, and an origin only', () => {
    process.env.MCP_PUBLIC_URL = 'http://mcp.example.com';
    expect(() => getOAuthConfig('required')).toThrow(/https/);
    process.env.MCP_PUBLIC_URL = 'http://localhost:3000';
    expect(getOAuthConfig('required')?.resource).toBe('http://localhost:3000/mcp');
    process.env.MCP_PUBLIC_URL = 'https://mcp.example.com/db2i';
    expect(() => getOAuthConfig('required')).toThrow(/origin only/);
  });

  it('defaults to the Claude callbacks, a random key and a 7 day refresh lifetime', () => {
    const config = getOAuthConfig('required');
    expect(config?.redirectUris).toEqual([
      'https://claude.ai/api/mcp/auth_callback',
      'https://claude.com/api/mcp/auth_callback',
      'cursor://anysphere.cursor-mcp/oauth/callback',
    ]);
    expect(config?.ephemeralSecret).toBe(true);
    expect(config?.secret).toEqual(getOAuthConfig('required')?.secret);
    expect(config?.refreshExpiry).toBe(604800);
  });

  it('refuses a redirect prefix that does not end at a path boundary', () => {
    process.env.MCP_OAUTH_REDIRECT_URIS = 'https://app.example.com*';
    expect(() => getOAuthConfig('required')).toThrow(/must end with/);
    process.env.MCP_OAUTH_REDIRECT_URIS = 'https://app.example.com/oauth/*';
    expect(getOAuthConfig('required')?.redirectUris).toEqual(['https://app.example.com/oauth/*']);
  });

  it('refuses a short secret', () => {
    process.env.MCP_OAUTH_SECRET = 'short';
    expect(() => getOAuthConfig('required')).toThrow(/at least 32/);
  });
});
