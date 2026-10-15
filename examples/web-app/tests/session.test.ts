import { sealData, unsealData } from 'iron-session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSession, SessionData } from '@/lib/server/session';

const auth = vi.fn();
vi.mock('@ai-sdk/mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ai-sdk/mcp')>()),
  auth: (...args: unknown[]) => auth(...args),
}));

vi.mock('next/headers', () => ({ cookies: vi.fn() }));

const { sessionOptions } = await import('@/lib/server/session');
const { ensureAccessToken, SessionOAuthProvider, SignInRequiredError } = await import('@/lib/server/oauth');

function fakeSession(data: SessionData): AppSession {
  return Object.assign(data, { save: vi.fn(), destroy: vi.fn(), updateConfig: vi.fn() }) as unknown as AppSession;
}

describe('session cookie', () => {
  it('round-trips OAuth state and rejects a tampered cookie', async () => {
    const { password } = sessionOptions();
    const data: SessionData = {
      oauth: { tokens: { access_token: 'access', token_type: 'Bearer', refresh_token: 'refresh' }, expiresAt: 1 },
    };
    const sealed = await sealData(data, { password: password as string });

    expect(await unsealData<SessionData>(sealed, { password: password as string })).toEqual(data);

    const tampered = `${sealed.slice(0, -4)}${sealed.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`;
    expect(await unsealData<SessionData>(tampered, { password: password as string })).toEqual({});
  });

  it('is httpOnly and SameSite=Lax', () => {
    expect(sessionOptions().cookieOptions).toMatchObject({ httpOnly: true, sameSite: 'lax' });
  });
});

describe('SessionOAuthProvider', () => {
  it('stores tokens with their expiry and drops the finished flow', () => {
    const session = fakeSession({ oauth: { codeVerifier: 'verifier', state: 'state' } });
    const provider = new SessionOAuthProvider(session);

    provider.saveTokens({ access_token: 'a', token_type: 'Bearer', expires_in: 3600 });

    expect(session.oauth?.tokens?.access_token).toBe('a');
    expect(session.oauth?.expiresAt).toBeGreaterThan(Date.now() + 3500_000);
    expect(session.oauth?.codeVerifier).toBeUndefined();
    expect(session.oauth?.state).toBeUndefined();
  });

  it('registers with the app callback and client_secret_basic', () => {
    const provider = new SessionOAuthProvider(fakeSession({}));

    expect(provider.redirectUrl).toBe('http://localhost:3001/oauth/callback');
    expect(provider.clientMetadata).toMatchObject({
      redirect_uris: ['http://localhost:3001/oauth/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'client_secret_basic',
    });
  });
});

describe('ensureAccessToken', () => {
  afterEach(() => {
    auth.mockReset();
  });

  it('uses a token that is not near its expiry without refreshing', async () => {
    const session = fakeSession({
      oauth: { tokens: { access_token: 'current', token_type: 'Bearer' }, expiresAt: Date.now() + 3600_000 },
    });

    await expect(ensureAccessToken(session)).resolves.toEqual({ accessToken: 'current', changed: false });
    expect(auth).not.toHaveBeenCalled();
  });

  it('shares one refresh between parallel requests, because each refresh token works once', async () => {
    auth.mockImplementation(async (provider: InstanceType<typeof SessionOAuthProvider>) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      provider.saveTokens({ access_token: 'next', token_type: 'Bearer', refresh_token: 'refresh-2', expires_in: 3600 });
      return 'AUTHORIZED';
    });
    const expiring = () =>
      fakeSession({
        oauth: {
          tokens: { access_token: 'old', token_type: 'Bearer', refresh_token: 'refresh-1' },
          expiresAt: Date.now() + 1000,
        },
      });
    const first = expiring();
    const second = expiring();

    const results = await Promise.all([ensureAccessToken(first), ensureAccessToken(second)]);

    expect(auth).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.accessToken)).toEqual(['next', 'next']);
    expect(second.oauth?.tokens?.refresh_token).toBe('refresh-2');
  });

  it('asks for a new sign-in when the refresh fails', async () => {
    auth.mockResolvedValue('REDIRECT');
    const session = fakeSession({
      oauth: { tokens: { access_token: 'old', token_type: 'Bearer', refresh_token: 'refresh-x' }, expiresAt: Date.now() - 1 },
    });

    await expect(ensureAccessToken(session)).rejects.toBeInstanceOf(SignInRequiredError);
    expect(session.oauth?.tokens).toBeUndefined();
  });

  it('asks for a sign-in when there are no tokens', async () => {
    await expect(ensureAccessToken(fakeSession({}))).rejects.toBeInstanceOf(SignInRequiredError);
  });
});
