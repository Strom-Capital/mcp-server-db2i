import { checkFetchSite, errorResponse } from '@/lib/server/http';
import { withMcp } from '@/lib/server/mcp';
import { readBusinessContext } from '@/lib/server/tools';

export const dynamic = 'force-dynamic';

/** The business context the server loaded from its YAML files. */
export async function GET(request: Request): Promise<Response> {
  const refused = checkFetchSite(request);
  if (refused) {
    return refused;
  }
  try {
    return Response.json(await withMcp(readBusinessContext));
  } catch (error) {
    return errorResponse(error);
  }
}
