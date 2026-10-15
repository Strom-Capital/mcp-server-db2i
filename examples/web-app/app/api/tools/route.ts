import { checkFetchSite, errorResponse } from '@/lib/server/http';
import { withMcp } from '@/lib/server/mcp';
import { listToolSummaries } from '@/lib/server/tools';

export const dynamic = 'force-dynamic';

/** The tools the server offers the signed-in user. */
export async function GET(request: Request): Promise<Response> {
  const refused = checkFetchSite(request);
  if (refused) {
    return refused;
  }
  try {
    return Response.json({ tools: await withMcp(listToolSummaries) });
  } catch (error) {
    return errorResponse(error);
  }
}
