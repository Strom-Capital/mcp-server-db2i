import { afterEach, describe, expect, it, vi } from 'vitest';

const html = '<!doctype html><html><body><div id="app"></div></body></html>';

const fakeClient = {
  readResource: vi.fn(async ({ uri }: { uri: string }) => ({
    contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: html, _meta: { ui: { prefersBorder: true } } }],
  })),
};

vi.mock('@/lib/server/mcp', () => ({
  withMcp: vi.fn(async (work: (client: typeof fakeClient) => Promise<unknown>) => work(fakeClient)),
}));

const { POST } = await import('@/app/api/mcp-app/resource/route');

function post(body: unknown, origin = 'http://localhost:3001'): Request {
  return new Request('http://localhost:3001/api/mcp-app/resource', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/mcp-app/resource', () => {
  it('returns the result view HTML', async () => {
    const response = await POST(post({ uri: 'ui://db2i/result' }));
    const body = (await response.json()) as { uri: string; html: string; mimeType: string };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ uri: 'ui://db2i/result', html, mimeType: 'text/html;profile=mcp-app' });
    expect(fakeClient.readResource).toHaveBeenCalledWith(expect.objectContaining({ uri: 'ui://db2i/result' }));
  });

  it('refuses a resource that is not one of the server views', async () => {
    for (const uri of ['db2i://business-context', 'ui://other/app', 'https://example.com/']) {
      const response = await POST(post({ uri }));
      expect(response.status, uri).toBe(400);
    }
    expect(fakeClient.readResource).not.toHaveBeenCalled();
  });

  it('refuses a request from another origin', async () => {
    const response = await POST(post({ uri: 'ui://db2i/result' }, 'https://evil.example.com'));

    expect(response.status).toBe(403);
    expect(fakeClient.readResource).not.toHaveBeenCalled();
  });
});
