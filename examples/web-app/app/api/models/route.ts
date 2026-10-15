import { z } from 'zod';
import { checkOrigin, errorResponse, redact } from '@/lib/server/http';
import { listModels, ModelChoiceError } from '@/lib/server/models';
import { MODEL_KEY_HEADER, providerIdSchema } from '@/lib/providers';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  provider: providerIdSchema,
  baseUrl: z.string().trim().max(500).optional(),
});

/** List the models the user's key can use, for the settings dropdown. */
export async function POST(request: Request): Promise<Response> {
  const refused = checkOrigin(request);
  if (refused) {
    return refused;
  }
  const apiKey = request.headers.get(MODEL_KEY_HEADER) ?? '';
  const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    return Response.json({ error: 'Invalid request.' }, { status: 400 });
  }
  try {
    const models = await listModels(parsed.data.provider, apiKey, parsed.data.baseUrl);
    return Response.json({ models });
  } catch (error) {
    if (error instanceof ModelChoiceError) {
      return Response.json({ error: redact(error.message, [apiKey]) }, { status: 400 });
    }
    return errorResponse(error, [apiKey]);
  }
}
