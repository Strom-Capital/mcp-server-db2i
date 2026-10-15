import { convertToModelMessages, isStepCount, streamText, type UIMessage } from 'ai';
import { z } from 'zod';
import { buildInstructions } from '@/lib/server/chat';
import { checkOrigin, errorMessage, errorResponse, redact } from '@/lib/server/http';
import { connectMcp } from '@/lib/server/mcp';
import { createModel, ModelChoiceError, resolveKey } from '@/lib/server/models';
import { MODEL_KEY_HEADER, modelChoiceSchema } from '@/lib/providers';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MAX_STEPS = 20;

const bodySchema = z.object({
  messages: z.array(z.custom<UIMessage>((value) => typeof value === 'object' && value !== null)).min(1).max(500),
  choice: modelChoiceSchema,
});

/** Stream a chat answer from the chosen model, with the MCP server's tools. */
export async function POST(request: Request): Promise<Response> {
  const refused = checkOrigin(request);
  if (refused) {
    return refused;
  }
  const apiKey = request.headers.get(MODEL_KEY_HEADER) ?? '';
  const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    return Response.json({ error: 'Invalid chat request.' }, { status: 400 });
  }
  const { messages, choice } = parsed.data;

  const secrets = [apiKey];
  let model;
  try {
    const key = await resolveKey(choice.provider, apiKey);
    secrets.push(key);
    model = createModel(choice, key);
  } catch (error) {
    if (error instanceof ModelChoiceError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return errorResponse(error, secrets);
  }

  let connection;
  try {
    connection = await connectMcp();
  } catch (error) {
    return errorResponse(error, secrets);
  }
  const { client, close } = connection;

  try {
    const tools = client.toolsFromDefinitions(await client.listTools());
    const result = streamText({
      model,
      instructions: buildInstructions(client.instructions),
      messages: await convertToModelMessages(messages, { ignoreIncompleteToolCalls: true }),
      tools,
      reasoning: choice.effort,
      stopWhen: isStepCount(MAX_STEPS),
      abortSignal: request.signal,
      onEnd: () => close(),
      onAbort: () => close(),
      onError: () => {
        void close();
      },
    });
    return result.toUIMessageStreamResponse({
      onError: (error) => redact(errorMessage(error), secrets),
    });
  } catch (error) {
    await close();
    return errorResponse(error, secrets);
  }
}
