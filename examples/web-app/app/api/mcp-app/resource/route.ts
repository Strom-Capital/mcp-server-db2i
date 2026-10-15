import { readMCPAppResource } from '@ai-sdk/mcp';
import { z } from 'zod';
import { checkOrigin, errorResponse } from '@/lib/server/http';
import { withMcp } from '@/lib/server/mcp';

export const dynamic = 'force-dynamic';

/** Only the server's own views; a tool cannot point the browser at another resource. */
const VIEW_PREFIX = 'ui://db2i/';

const bodySchema = z.object({
  uri: z.string().max(200).refine((uri) => uri.startsWith(VIEW_PREFIX)),
});

/** Read an MCP Apps view (HTML) for the result frame under a tool call. */
export async function POST(request: Request): Promise<Response> {
  const refused = checkOrigin(request);
  if (refused) {
    return refused;
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    return Response.json({ error: 'Invalid view request.' }, { status: 400 });
  }
  try {
    const resource = await withMcp((client) => readMCPAppResource({ client, uri: parsed.data.uri }));
    return Response.json(resource, { headers: { 'Cache-Control': 'private, max-age=300' } });
  } catch (error) {
    return errorResponse(error);
  }
}
