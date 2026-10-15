import { z } from 'zod';
import { checkOrigin, errorResponse } from '@/lib/server/http';
import { withMcp } from '@/lib/server/mcp';
import { callListedTool, ToolNotOfferedError } from '@/lib/server/tools';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const bodySchema = z.object({
  name: z.string().trim().min(1).max(128),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

/** Run one MCP tool directly, without a model: the tool forms and exports run again. */
export async function POST(request: Request): Promise<Response> {
  const refused = checkOrigin(request);
  if (refused) {
    return refused;
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    return Response.json({ error: 'Invalid tool request.' }, { status: 400 });
  }
  const started = Date.now();
  try {
    const result = await withMcp((client) => callListedTool(client, parsed.data.name, parsed.data.arguments));
    return Response.json({ result, durationMs: Date.now() - started });
  } catch (error) {
    if (error instanceof ToolNotOfferedError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    return errorResponse(error);
  }
}
