import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOOL_META_KEY } from '@/lib/catalog';

const annotation = { table: 'MYLIB.ORDERHDR', entity: 'sales_order', columns: { ORDERNO: 'Order number' }, relations: [] };

const fakeClient = {
  listTools: vi.fn(async () => ({
    tools: [
      { name: 'execute_query', inputSchema: { type: 'object', properties: { sql: { type: 'string' } } } },
      { name: 'get_business_context', inputSchema: { type: 'object', properties: {} } },
      {
        name: 'search_sales_orders',
        title: 'Search sales orders',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        _meta: { [TOOL_META_KEY]: { kind: 'business', toolset: 'sales' } },
      },
    ],
  })),
  readResource: vi.fn(async () => ({ contents: [{ uri: 'db2i://business-context', text: JSON.stringify({ data: [annotation], count: 1 }) }] })),
  callTool: vi.fn(async () => ({ structuredContent: { success: true, data: [annotation] } })),
};

vi.mock('@/lib/server/mcp', () => ({
  withMcp: vi.fn(async (work: (client: typeof fakeClient) => Promise<unknown>) => work(fakeClient)),
}));

const tools = await import('@/app/api/tools/route');
const context = await import('@/app/api/context/route');

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:3001${path}`, { headers });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/tools', () => {
  it('lists the tools with their kind and toolset', async () => {
    const response = await tools.GET(get('/api/tools', { 'sec-fetch-site': 'same-origin' }));
    const body = (await response.json()) as { tools: { name: string; kind: string; toolset?: string }[] };

    expect(response.status).toBe(200);
    expect(body.tools.map((tool) => [tool.name, tool.kind, tool.toolset])).toEqual([
      ['execute_query', 'builtin', undefined],
      ['get_business_context', 'builtin', undefined],
      ['search_sales_orders', 'business', 'sales'],
    ]);
  });

  it('refuses a request another site started', async () => {
    const response = await tools.GET(get('/api/tools', { 'sec-fetch-site': 'cross-site' }));

    expect(response.status).toBe(403);
    expect(fakeClient.listTools).not.toHaveBeenCalled();
  });
});

describe('GET /api/context', () => {
  it('reads the business context resource', async () => {
    const body = (await (await context.GET(get('/api/context'))).json()) as { available: boolean; annotations: unknown[] };

    expect(body).toEqual({ available: true, annotations: [annotation] });
    expect(fakeClient.callTool).not.toHaveBeenCalled();
  });

  it('falls back to get_business_context when the resource cannot be read', async () => {
    fakeClient.readResource.mockRejectedValueOnce(new Error('Resource not found'));

    const body = (await (await context.GET(get('/api/context'))).json()) as { annotations: unknown[] };

    expect(body.annotations).toEqual([annotation]);
    expect(fakeClient.callTool).toHaveBeenCalledWith({ name: 'get_business_context', arguments: {} });
  });

  it('says so when the server does not offer business context', async () => {
    fakeClient.listTools.mockResolvedValueOnce({ tools: [] });

    const body = (await (await context.GET(get('/api/context'))).json()) as { available: boolean };

    expect(body.available).toBe(false);
    expect(fakeClient.readResource).not.toHaveBeenCalled();
  });
});
