import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'sk-test-0123456789abcdef-secret';

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

const { POST } = await import('@/app/api/chat/route');

function chatRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3001/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3001', 'x-model-api-key': KEY, ...headers },
    body: JSON.stringify({
      id: 'main',
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Show the orders' }] }],
      choice: { provider: 'anthropic', model: 'test-model' },
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
});
