import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'sk-test-0123456789abcdef-secret';
const SERVER_KEY = 'sk-ant-server-fedcba9876543210-secret';

const close = vi.fn(async () => undefined);
const fakeClient = {
  instructions: 'Use get_business_context first.',
  listTools: vi.fn(async () => ({ tools: [] })),
  toolsFromDefinitions: vi.fn(() => ({})),
};

vi.mock('@/lib/server/mcp', () => ({
  connectMcp: vi.fn(async () => ({ client: fakeClient, session: {}, close })),
}));

const createModel = vi.fn();
vi.mock('@/lib/server/models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/models')>()),
  createModel: (...args: unknown[]) => createModel(...args),
}));

let session: { oauth?: { tokens: { access_token: string; token_type: string; refresh_token?: string } } } = {};
vi.mock('@/lib/server/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/session')>()),
  getSession: vi.fn(async () => session),
}));

const { POST } = await import('@/app/api/chat/route');
const { resetConfig } = await import('@/lib/server/config');

function chatRequest(headers: Record<string, string> = {}, choice: Record<string, unknown> = {}): Request {
  return new Request('http://localhost:3001/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3001', 'x-model-api-key': KEY, ...headers },
    body: JSON.stringify({
      id: 'main',
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Show the orders' }] }],
      choice: { provider: 'anthropic', model: 'test-model', ...choice },
    }),
  });
}

describe('POST /api/chat', () => {
  const logged: unknown[][] = [];

  beforeEach(() => {
    logged.length = 0;
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    createModel.mockReset();
    close.mockClear();
    delete process.env.ANTHROPIC_API_KEY;
    resetConfig();
    session = {};
  });

  it('passes the key to the model factory, and keeps it out of the response and the logs when the provider fails', async () => {
    createModel.mockImplementation(
      () =>
        new MockLanguageModelV4({
          doStream: async () => {
            throw new Error(`Provider refused the key ${KEY}`);
          },
        }),
    );

    const response = await POST(chatRequest());
    const body = await response.text();

    expect(createModel).toHaveBeenCalledWith({ provider: 'anthropic', model: 'test-model' }, KEY);
    expect(body).not.toContain(KEY);
    expect(body).toContain('[redacted]');
    expect(JSON.stringify(logged)).not.toContain(KEY);
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
  });

  it('passes the chosen effort to the model as the reasoning option', async () => {
    const reasoning: unknown[] = [];
    createModel.mockImplementation(
      () =>
        new MockLanguageModelV4({
          doStream: async (options) => {
            reasoning.push(options.reasoning);
            throw new Error('stop');
          },
        }),
    );

    const response = await POST(chatRequest({}, { effort: 'high' }));
    await response.text();

    expect(reasoning).toEqual(['high']);
  });

  it('refuses an unknown effort', async () => {
    const response = await POST(chatRequest({}, { effort: 'extreme' }));

    expect(response.status).toBe(400);
    expect(createModel).not.toHaveBeenCalled();
  });

  it('refuses a request from another origin before reading the key', async () => {
    const response = await POST(chatRequest({ origin: 'https://evil.example.com' }));

    expect(response.status).toBe(403);
    expect(createModel).not.toHaveBeenCalled();
  });

  it('refuses a malformed body', async () => {
    const response = await POST(
      new Request('http://localhost:3001/api/chat', {
        method: 'POST',
        headers: { origin: 'http://localhost:3001' },
        body: '{"messages":[]}',
      }),
    );

    expect(response.status).toBe(400);
  });

  describe('with a key set on the server', () => {
    beforeEach(() => {
      process.env.ANTHROPIC_API_KEY = SERVER_KEY;
      resetConfig();
    });

    it('uses it for a signed-in user who sent no key, and keeps it out of the response and the logs', async () => {
      session = { oauth: { tokens: { access_token: 'access', token_type: 'Bearer', refresh_token: 'refresh' } } };
      createModel.mockImplementation(
        () =>
          new MockLanguageModelV4({
            doStream: async () => {
              throw new Error(`Provider refused the key ${SERVER_KEY}`);
            },
          }),
      );

      const response = await POST(chatRequest({ 'x-model-api-key': '' }));
      const body = await response.text();

      expect(createModel).toHaveBeenCalledWith({ provider: 'anthropic', model: 'test-model' }, SERVER_KEY);
      expect(body).not.toContain(SERVER_KEY);
      expect(JSON.stringify(logged)).not.toContain(SERVER_KEY);
    });

    it('refuses to use it without a sign-in', async () => {
      const response = await POST(chatRequest({ 'x-model-api-key': '' }));

      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(SERVER_KEY);
      expect(createModel).not.toHaveBeenCalled();
    });

    it("uses the user's own key instead when one is sent", async () => {
      createModel.mockImplementation(() => new MockLanguageModelV4({ doStream: async () => Promise.reject(new Error('stop')) }));

      const response = await POST(chatRequest());
      await response.text();

      expect(createModel).toHaveBeenCalledWith({ provider: 'anthropic', model: 'test-model' }, KEY);
    });

    it('is not used for another provider', async () => {
      session = { oauth: { tokens: { access_token: 'access', token_type: 'Bearer', refresh_token: 'refresh' } } };
      createModel.mockImplementation(() => new MockLanguageModelV4({ doStream: async () => Promise.reject(new Error('stop')) }));

      const response = await POST(chatRequest({ 'x-model-api-key': '' }, { provider: 'openai' }));
      await response.text();

      expect(createModel).toHaveBeenCalledWith({ provider: 'openai', model: 'test-model' }, '');
    });
  });
});
